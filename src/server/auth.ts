import { appErrorStatus, External, toPublicAppError, Unauthenticated, Validation, type AppError } from "contracts/errors";
import type { Principal } from "contracts/principal";
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
  mailFrom,
  sessionSecret,
} from "./services";

type AppHono = { Bindings: Env };

const MAX_REQUEST_LINK_BODY_BYTES = 1_024;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 120;
const RequestLinkInput = Schema.Struct({
  email: Schema.String.pipe(
    Schema.maxLength(MAX_EMAIL_LENGTH),
    Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  ),
  name: Schema.optional(Schema.String.pipe(Schema.maxLength(MAX_NAME_LENGTH))),
  returnTo: Schema.optional(Schema.String),
});
const BODY_TOO_LARGE = Symbol("BODY_TOO_LARGE");

const RETURN_TO_ORIGIN = "https://return-to.invalid";
const validatedReturnTo = (returnTo: string | undefined): string => {
  if (!returnTo?.startsWith("/") || returnTo.startsWith("//")) return "/";
  const target = new URL(returnTo, RETURN_TO_ORIGIN);
  return target.origin === RETURN_TO_ORIGIN
    ? `${target.pathname}${target.search}${target.hash}`
    : "/";
};

const readBoundedJson = async (request: Request): Promise<unknown | typeof BODY_TOO_LARGE> => {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_LINK_BODY_BYTES) {
    return BODY_TOO_LARGE;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_LINK_BODY_BYTES) {
      await reader.cancel();
      return BODY_TOO_LARGE;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
};

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
const notifyScheduler = async (env: Env, requestId: string): Promise<void> => {
  if (isExplicitLocalEnvironment(env)) return;
  try {
    const schedulerId = env.SCHEDULER.idFromName("mail");
    const response = await env.SCHEDULER.get(schedulerId).fetch("https://scheduler/poke", {
      method: "POST",
      headers: { "x-session-party-internal": sessionSecret(env) },
    });
    if (!response.ok) throw new Error("Scheduler rejected enqueue notification");
  } catch {
    console.error(JSON.stringify({
      message: "Scheduler notification failed after magic-link enqueue",
      requestId,
    }));
  }
};

const authorizeRequestLink = async (
  request: Request,
  env: Env,
  email: string,
  requestId: string,
): Promise<boolean> => {
  if (isExplicitLocalEnvironment(env)) return true;
  try {
    const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    const [sourceHash, recipientHash] = await Promise.all([
      hashBearerMaterial(env, `request-link-source:${source.slice(0, 128)}`),
      hashBearerMaterial(env, `request-link-recipient:${email}`),
    ]);
    const limiterId = env.SCHEDULER.idFromName("auth-rate-limit");
    const response = await env.SCHEDULER.get(limiterId).fetch(
      "https://scheduler/auth/request-link/authorize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-party-internal": sessionSecret(env),
        },
        body: JSON.stringify({ sourceHash, recipientHash }),
      },
    );
    return response.ok;
  } catch {
    console.error(JSON.stringify({
      message: "Magic-link authorization unavailable",
      requestId,
    }));
    return false;
  }
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
): Promise<Principal | null> => {
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
): Promise<Principal | null> => {
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

export const sessionUser = (c: Context<AppHono>): Promise<Principal | null> =>
  userFromRequest(c.req.raw, c.env);

const auth = new Hono<AppHono>();

auth.post("/request-link", async (c) => {
  const requestId = requestIdFor(c);
  const body = await readBoundedJson(c.req.raw).catch(() => null);
  const parsed = body === BODY_TOO_LARGE
    ? null
    : await Schema.decodeUnknownPromise(RequestLinkInput)(body).catch(() => null);
  if (!parsed) {
    return errorResponse(c, new Validation({ message: "A valid email is required" }), requestId);
  }

  const email = parsed.email.trim().toLowerCase();
  const name = parsed.name?.trim() || null;
  const returnTo = validatedReturnTo(parsed.returnTo);
  if (!(await authorizeRequestLink(c.req.raw, c.env, email, requestId))) {
    return c.json({ ok: true }, 202);
  }
  let committed = false;
  try {
    const nowMs = Date.now();
    const db = drizzle(c.env.DB);
    const [existingUser] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const userId = existingUser?.id ?? nanoid();
    const [outstanding] = existingUser
      ? await db
        .select({ id: authTokens.id, expiresAt: authTokens.expiresAt })
        .from(authTokens)
        .where(and(
          eq(authTokens.userId, userId),
          eq(authTokens.kind, "magic_link"),
          isNull(authTokens.consumedAt),
        ))
        .limit(1)
      : [];
    if (outstanding && outstanding.expiresAt.getTime() > nowMs) {
      await notifyScheduler(c.env, requestId);
      return c.json({ ok: true }, 202);
    }
    const token = nanoid(48);
    const tokenHash = await hashBearerMaterial(c.env, token);
    const tokenId = nanoid();
    const snapshotId = nanoid();
    const deliveryId = nanoid();
    const deliveryIdempotencyKey = `auth-magic-link:${tokenId}`;
    const link = new URL("/api/v1/auth/verify", c.env.APP_URL);
    link.searchParams.set("token", token);
    link.searchParams.set("returnTo", returnTo);
    const renderedHtml =
      `<p>Use this link to sign in. It expires in 15 minutes.</p><p><a href="${link.toString()}">Sign in to Session Party</a></p>`;
    const renderedText = `Sign in to Session Party: ${link.toString()}\n\nThis link expires in 15 minutes.`;
    const statements: D1PreparedStatement[] = [];

    if (!existingUser) {
      statements.push(c.env.DB.prepare(
        "INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?)",
      ).bind(userId, email, nowMs, nowMs));
    }
    if (outstanding) {
      statements.push(
        c.env.DB.prepare(
          "UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at <= ?",
        ).bind(nowMs, outstanding.id, nowMs),
        c.env.DB.prepare(
          "UPDATE mail_deliveries SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL WHERE idempotency_key = ? AND status IN ('pending', 'retry')",
        ).bind(`auth-magic-link:${outstanding.id}`),
        c.env.DB.prepare(
          "UPDATE mail_delivery_snapshots SET rendered_html = NULL, rendered_text = NULL, ics_filename = NULL, ics_content = NULL, redacted_at = ? WHERE id IN (SELECT snapshot_id FROM mail_deliveries WHERE idempotency_key = ? AND status = 'cancelled')",
        ).bind(nowMs, `auth-magic-link:${outstanding.id}`),
      );
    }
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES (?, ?, ?, 'magic_link', ?, NULL, ?)",
      ).bind(tokenId, tokenHash, userId, nowMs + 15 * 60_000, nowMs),
      c.env.DB.prepare(
        "INSERT INTO mail_delivery_snapshots (id, event_id, template_id, recipient_user_id, recipient_email, recipient_name, from_email, reply_to_email, subject, rendered_html, rendered_text, ics_filename, ics_content, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?)",
      ).bind(
        snapshotId,
        userId,
        email,
        existingUser?.name ?? name,
        mailFrom(c.env),
        "Sign in to Session Party",
        renderedHtml,
        renderedText,
        nowMs,
      ),
      c.env.DB.prepare(
        "INSERT INTO mail_deliveries (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, lease_owner, lease_expires_at, attempt_count, max_attempts, provider, provider_message_id, provider_result, last_error, sent_at, dead_lettered_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL, 0, 8, 'resend', NULL, NULL, NULL, NULL, NULL, ?)",
      ).bind(deliveryId, snapshotId, deliveryIdempotencyKey, nowMs, nowMs, nowMs),
    );

    await c.env.DB.batch(statements);
    committed = true;
  } catch {
    console.error(JSON.stringify({
      message: "Magic-link enqueue failed",
      requestId,
    }));
  }

  if (committed) await notifyScheduler(c.env, requestId);

  return c.json({ ok: true }, 202);
});

auth.get("/verify", async (c) => {
  const requestId = requestIdFor(c);
  try {
    const token = c.req.query("token");
    const returnTo = validatedReturnTo(c.req.query("returnTo"));
    if (!token || token.length > 512) {
      return errorResponse(c, new Validation({ message: "Missing token" }), requestId);
    }

    const nowMs = Date.now();
    const tokenHash = await hashBearerMaterial(c.env, token);
    const session = nanoid(48);
    const sessionHash = await hashBearerMaterial(c.env, session);
    const sessionId = nanoid();
    const expiresAtMs = nowMs + 30 * 24 * 60 * 60_000;
    const eligibleMagicLink =
      "token_hash = ? AND kind = 'magic_link' AND expires_at > ? AND consumed_at IS NULL";
    const [insertResult, consumeResult] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at)
         SELECT ?, ?, user_id, 'session', ?, NULL, ?
         FROM auth_tokens
         WHERE ${eligibleMagicLink}`,
      ).bind(sessionId, sessionHash, expiresAtMs, nowMs, tokenHash, nowMs),
      c.env.DB.prepare(
        `UPDATE auth_tokens SET consumed_at = ? WHERE ${eligibleMagicLink}`,
      ).bind(nowMs, tokenHash, nowMs),
    ]);

    if (
      !insertResult ||
      !consumeResult ||
      insertResult.meta.changes !== 1 ||
      consumeResult.meta.changes !== 1
    ) {
      return errorResponse(
        c,
        new Unauthenticated({ reason: "Magic link is invalid, expired, or consumed" }),
        requestId,
      );
    }

    setCookie(c, "sp_session", session, {
      httpOnly: true,
      sameSite: "Lax",
      secure: !isExplicitLocalEnvironment(c.env),
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect(returnTo);
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

