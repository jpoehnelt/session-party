import { apiKeys, authTokens, users } from "contracts/schema";
import { Schema } from "effect";
import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { sendMail, type CurrentUserValue } from "./services";

type AppHono = { Bindings: Env };

const RequestLinkInput = Schema.Struct({
  email: Schema.String.pipe(Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  name: Schema.optional(Schema.String),
});

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const displayName = (email: string, name: string | null | undefined): string =>
  name?.trim() || email.slice(0, email.indexOf("@")) || email;

export const apiKeyUserFromRequest = async (
  request: Request,
  env: Env,
): Promise<CurrentUserValue | null> => {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const key = authorization.slice("Bearer ".length).trim();
  if (!key) return null;

  const hash = await sha256(key);
  const db = drizzle(env.DB);
  const [match] = await db
    .select({ id: apiKeys.id, eventId: apiKeys.eventId, name: apiKeys.name })
    .from(apiKeys)
    .where(eq(apiKeys.hash, hash))
    .limit(1);

  return match
    ? {
        userId: `api-key:${match.id}`,
        email: "",
        name: match.name,
        eventId: match.eventId,
        role: "admin",
      }
    : null;
};

export const userFromRequest = async (
  request: Request,
  env: Env,
): Promise<CurrentUserValue | null> => {
  const apiUser = await apiKeyUserFromRequest(request, env);
  if (apiUser) return apiUser;

  const cookie = request.headers.get("Cookie") ?? "";
  const token = /(?:^|;\s*)sp_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) return null;

  const db = drizzle(env.DB);
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(authTokens)
    .innerJoin(users, eq(users.id, authTokens.userId))
    .where(
      and(
        eq(authTokens.id, decodeURIComponent(token)),
        eq(authTokens.kind, "session"),
        gt(authTokens.expiresAt, new Date()),
        isNull(authTokens.consumedAt),
      ),
    )
    .limit(1);

  return row
    ? { userId: row.id, email: row.email, name: displayName(row.email, row.name) }
    : null;
};

export const sessionUser = (c: Context<AppHono>): Promise<CurrentUserValue | null> =>
  userFromRequest(c.req.raw, c.env);

const auth = new Hono<AppHono>();

auth.post("/request-link", async (c) => {
  const parsed = await Schema.decodeUnknownPromise(RequestLinkInput)(await c.req.json().catch(() => null)).catch(
    () => null,
  );
  if (!parsed) return c.json({ error: "A valid email is required" }, 400);

  const email = parsed.email.trim().toLowerCase();
  const now = new Date();
  const db = drizzle(c.env.DB);
  const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = existingUser ?? (await db
    .insert(users)
    .values({
      id: nanoid(),
      email,
      name: parsed.name?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .returning())[0];
  if (!user) return c.json({ error: "Unable to create user" }, 500);

  const token = nanoid(48);
  await db.insert(authTokens).values({
    id: token,
    userId: user.id,
    kind: "magic_link",
    expiresAt: new Date(now.getTime() + 15 * 60_000),
    createdAt: now,
  });

  const link = `${c.env.APP_URL}/api/v1/auth/verify?token=${encodeURIComponent(token)}`;
  await sendMail(c.env, {
    to: email,
    subject: "Sign in to Session Party",
    html: `<p>Use this link to sign in. It expires in 15 minutes.</p><p><a href="${link}">Sign in to Session Party</a></p>`,
  });

  return c.json({ ok: true });
});

auth.get("/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "Missing token" }, 400);

  const now = new Date();
  const db = drizzle(c.env.DB);
  const [consumed] = await db
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.id, token),
        eq(authTokens.kind, "magic_link"),
        gt(authTokens.expiresAt, now),
        isNull(authTokens.consumedAt),
      ),
    )
    .returning({ userId: authTokens.userId });

  if (!consumed) return c.json({ error: "Link is invalid or expired" }, 401);

  const session = nanoid(48);
  await db.insert(authTokens).values({
    id: session,
    userId: consumed.userId,
    kind: "session",
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    createdAt: now,
  });

  setCookie(c, "sp_session", session, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.env.APP_URL.startsWith("https://"),
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return c.redirect("/");
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, "sp_session");
  if (token) {
    await drizzle(c.env.DB)
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(authTokens.id, token), eq(authTokens.kind, "session")));
  }
  deleteCookie(c, "sp_session", { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const user = await sessionUser(c);
  return user ? c.json({ user }) : c.json({ error: "Unauthenticated" }, 401);
});

export default auth;

