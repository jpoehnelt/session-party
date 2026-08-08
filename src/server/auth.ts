import { appErrorStatus, External, toPublicAppError, Unauthenticated, Validation, type AppError } from "contracts/errors";
import { ApiScopes } from "contracts/principal";
import { apiKeys, authTokens, users } from "contracts/schema";
import { Schema } from "effect";
import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import {
  isExplicitLocalEnvironment,
  sendMail,
  sessionSecret,
  type CurrentUserValue,
} from "./services";

type AppHono = { Bindings: Env };

const RequestLinkInput = Schema.Struct({
  email: Schema.String.pipe(Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  name: Schema.optional(Schema.String),
});

const requestIdFor = (c: Context<AppHono>): string => {
  const supplied = c.req.header("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : nanoid();
};

const errorResponse = (c: Context<AppHono>, error: AppError, requestId: string) =>
  c.json(toPublicAppError(error, requestId), appErrorStatus(error));

const unexpectedResponse = (
  c: Context<AppHono>,
  service: string,
  error: unknown,
  requestId: string,
) => {
  const detail = error instanceof Error ? error.message : "Non-Error failure";
  console.error(JSON.stringify({ message: "Authentication request failed", requestId, service, detail }));
  return errorResponse(c, new External({ service, detail }), requestId);
};

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * HMAC keeps every persisted bearer lookup value one-way and deployment-bound.
 * Rotating SESSION_SECRET intentionally invalidates all outstanding credentials.
 */
export const hashBearerMaterial = async (env: Env, value: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
};

const displayName = (email: string, name: string | null | undefined): string =>
  name?.trim() || email.slice(0, email.indexOf("@")) || email;

const bearerFromRequest = (request: Request): string | null => {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(authorization);
  const bearer = match?.[1];
  return bearer && bearer.length <= 512 ? bearer : null;
};

const sessionFromRequest = (request: Request): string | null => {
  const encoded = /(?:^|;\s*)sp_session=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1];
  if (!encoded || encoded.length > 512) return null;
  try {
    const token = decodeURIComponent(encoded);
    return token.length > 0 && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
};

export const apiKeyUserFromRequest = async (
  request: Request,
  env: Env,
): Promise<CurrentUserValue | null> => {
  const key = bearerFromRequest(request);
  if (!key) return null;

  const now = new Date();
  const hash = await hashBearerMaterial(env, key);
  const db = drizzle(env.DB);
  const [match] = await db
    .select({
      id: apiKeys.id,
      eventId: apiKeys.eventId,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, hash),
        gt(apiKeys.expiresAt, now),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!match) return null;

  const scopes = await Schema.decodeUnknownPromise(ApiScopes)(match.scopes).catch(() => null);
  if (!scopes || scopes.length === 0) return null;
  const userId: `api-key:${string}` = `api-key:${match.id}`;
  return {
    kind: "api-key",
    userId,
    apiKeyId: match.id,
    eventId: match.eventId,
    name: match.name,
    scopes,
    expiresAt: match.expiresAt.getTime(),
  };
};

export const userFromRequest = async (
  request: Request,
  env: Env,
): Promise<CurrentUserValue | null> => {
  if (request.headers.has("Authorization")) {
    return apiKeyUserFromRequest(request, env);
  }

  const token = sessionFromRequest(request);
  if (!token) return null;

  const hash = await hashBearerMaterial(env, token);
  const db = drizzle(env.DB);
  const [row] = await db
    .select({
      sessionId: authTokens.id,
      expiresAt: authTokens.expiresAt,
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(authTokens)
    .innerJoin(users, eq(users.id, authTokens.userId))
    .where(
      and(
        eq(authTokens.tokenHash, hash),
        eq(authTokens.kind, "session"),
        gt(authTokens.expiresAt, new Date()),
        isNull(authTokens.consumedAt),
      ),
    )
    .limit(1);

  return row
    ? {
        kind: "browser-session",
        userId: row.userId,
        email: row.email,
        name: displayName(row.email, row.name),
        sessionId: row.sessionId,
        expiresAt: row.expiresAt.getTime(),
      }
    : null;
};

export const sessionUser = (c: Context<AppHono>): Promise<CurrentUserValue | null> =>
  userFromRequest(c.req.raw, c.env);

const auth = new Hono<AppHono>();

auth.post("/request-link", async (c) => {
  const requestId = requestIdFor(c);
  try {
    const parsed = await Schema.decodeUnknownPromise(RequestLinkInput)(
      await c.req.json().catch(() => null),
    ).catch(() => null);
    if (!parsed) {
      return errorResponse(c, new Validation({ message: "A valid email is required" }), requestId);
    }

    const email = parsed.email.trim().toLowerCase();
    const now = new Date();
    const db = drizzle(c.env.DB);
    const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user =
      existingUser ??
      (
        await db
          .insert(users)
          .values({
            id: nanoid(),
            email,
            name: parsed.name?.trim() || null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];
    if (!user) {
      return errorResponse(
        c,
        new External({ service: "database", detail: "User insert returned no row" }),
        requestId,
      );
    }

    const token = nanoid(48);
    const tokenHash = await hashBearerMaterial(c.env, token);
    await db.insert(authTokens).values({
      id: nanoid(),
      tokenHash,
      userId: user.id,
      kind: "magic_link",
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      createdAt: now,
    });

    const link = new URL("/api/v1/auth/verify", c.env.APP_URL);
    link.searchParams.set("token", token);
    await sendMail(c.env, {
      to: email,
      subject: "Sign in to Session Party",
      html: `<p>Use this link to sign in. It expires in 15 minutes.</p><p><a href="${link.toString()}">Sign in to Session Party</a></p>`,
    });

    return c.json({ ok: true });
  } catch (error) {
    return unexpectedResponse(c, "authentication", error, requestId);
  }
});

auth.get("/verify", async (c) => {
  const requestId = requestIdFor(c);
  try {
    const token = c.req.query("token");
    if (!token || token.length > 512) {
      return errorResponse(c, new Validation({ message: "Missing token" }), requestId);
    }

    const now = new Date();
    const tokenHash = await hashBearerMaterial(c.env, token);
    const db = drizzle(c.env.DB);
    const [consumed] = await db
      .update(authTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.kind, "magic_link"),
          gt(authTokens.expiresAt, now),
          isNull(authTokens.consumedAt),
        ),
      )
      .returning({ userId: authTokens.userId });

    if (!consumed) {
      return errorResponse(
        c,
        new Unauthenticated({ reason: "Magic link is invalid, expired, or consumed" }),
        requestId,
      );
    }

    const session = nanoid(48);
    const sessionHash = await hashBearerMaterial(c.env, session);
    await db.insert(authTokens).values({
      id: nanoid(),
      tokenHash: sessionHash,
      userId: consumed.userId,
      kind: "session",
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      createdAt: now,
    });

    setCookie(c, "sp_session", session, {
      httpOnly: true,
      sameSite: "Lax",
      secure: !isExplicitLocalEnvironment(c.env),
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect("/");
  } catch (error) {
    return unexpectedResponse(c, "authentication", error, requestId);
  }
});

auth.post("/logout", async (c) => {
  const requestId = requestIdFor(c);
  try {
    const token = getCookie(c, "sp_session");
    if (token && token.length <= 512) {
      const tokenHash = await hashBearerMaterial(c.env, token);
      await drizzle(c.env.DB)
        .update(authTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(authTokens.tokenHash, tokenHash),
            eq(authTokens.kind, "session"),
            isNull(authTokens.consumedAt),
          ),
        );
    }
    deleteCookie(c, "sp_session", { path: "/" });
    return c.json({ ok: true });
  } catch (error) {
    return unexpectedResponse(c, "authentication", error, requestId);
  }
});

auth.get("/me", async (c) => {
  const requestId = requestIdFor(c);
  try {
    const user = await sessionUser(c);
    return user
      ? c.json({ user })
      : errorResponse(
          c,
          new Unauthenticated({ reason: "A valid session or API key is required" }),
          requestId,
        );
  } catch (error) {
    return unexpectedResponse(c, "authentication", error, requestId);
  }
});

export default auth;

