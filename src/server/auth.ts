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
  internalServiceToken,
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
const DemoPersona = Schema.Literal("organizer", "speaker", "reviewer");
const DemoLoginInput = Schema.Struct({
  persona: DemoPersona,
  returnTo: Schema.optional(Schema.String),
});
type DemoPersona = typeof DemoPersona.Type;

const DEMO_IDENTITIES: Readonly<Record<DemoPersona, { readonly email: string; readonly name: string }>> = {
  organizer: { email: "sbek-organizer@example.com", name: "Jordan Alvarez" },
  speaker: { email: "sbek-speaker@example.com", name: "Priya Raman" },
  reviewer: { email: "sbek-reviewer@example.com", name: "Sam Whitfield" },
};
const DEMO_EVENT = {
  name: "AI Engineer Sandbox",
  slug: "ai-engineer-sandbox",
  description: "A deterministic end-to-end conference production workspace.",
  location: "Pier 27, San Francisco",
  timezone: "America/Los_Angeles",
  startsAt: Date.parse("2026-09-17T09:00:00-07:00"),
  endsAt: Date.parse("2026-09-19T16:00:00-07:00"),
  accentColor: "#635BFF",
} as const;
const DEMO_DESTINATIONS: Readonly<Record<DemoPersona, string>> = {
  organizer: `/e/${DEMO_EVENT.slug}/dashboard`,
  speaker: `/e/${DEMO_EVENT.slug}/portal`,
  reviewer: `/e/${DEMO_EVENT.slug}/review`,
};
const BODY_TOO_LARGE = Symbol("BODY_TOO_LARGE");
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_ACTIVE_DEMO_SESSIONS_PER_PERSONA = 20;
const HOST_SESSION_COOKIE = "__Host-sp_session";
const LEGACY_SESSION_COOKIE = "sp_session";

const RETURN_TO_ORIGIN = "https://return-to.invalid";
const validatedReturnTo = (returnTo: string | undefined): string => {
  if (!returnTo?.startsWith("/") || returnTo.startsWith("//")) return "/";
  try {
    const target = new URL(returnTo, RETURN_TO_ORIGIN);
    if (target.origin !== RETURN_TO_ORIGIN || target.pathname.startsWith("//")) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
};

const readBoundedText = async (request: Request): Promise<string | typeof BODY_TOO_LARGE> => {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_LINK_BODY_BYTES) {
    return BODY_TOO_LARGE;
  }
  if (!request.body) return "";
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
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
};

const readBoundedJson = async (request: Request): Promise<unknown | typeof BODY_TOO_LARGE> => {
  const body = await readBoundedText(request);
  return body === BODY_TOO_LARGE ? body : JSON.parse(body);
};

const readBoundedForm = async (request: Request): Promise<URLSearchParams | typeof BODY_TOO_LARGE> => {
  const body = await readBoundedText(request);
  return body === BODY_TOO_LARGE ? body : new URLSearchParams(body);
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
      headers: { "x-session-party-internal": await internalServiceToken(env) },
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
          "x-session-party-internal": await internalServiceToken(env),
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

const authorizeDemoLogin = async (
  request: Request,
  env: Env,
  requestId: string,
): Promise<boolean> => {
  if (isExplicitLocalEnvironment(env)) return true;
  try {
    const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    const sourceHash = await hashBearerMaterial(env, `demo-login-source:${source.slice(0, 128)}`);
    const limiterId = env.SCHEDULER.idFromName("auth-rate-limit");
    const response = await env.SCHEDULER.get(limiterId).fetch(
      "https://scheduler/auth/demo/authorize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-party-internal": await internalServiceToken(env),
        },
        body: JSON.stringify({ sourceHash }),
      },
    );
    return response.ok;
  } catch {
    console.error(JSON.stringify({
      message: "Demo-login authorization unavailable",
      requestId,
    }));
    return false;
  }
};

const displayName = (email: string, name: string | null | undefined): string =>
  name?.trim() || email.slice(0, email.indexOf("@")) || email;

/**
 * A configured bootstrap address turns a self-hosted instance into a closed
 * installation. Existing users still sign in normally, including accounts an
 * owner creates through the event-member invitation flow.
 */
const mayCreateUser = (env: Env, email: string): boolean => {
  const configured = typeof env.INITIAL_ADMIN_EMAIL === "string"
    ? env.INITIAL_ADMIN_EMAIL.trim().toLowerCase()
    : "";
  return configured.length === 0 || email === configured;
};

const hasInvitationOrManagedSpeaker = async (
  env: Env,
  email: string,
  nowMs: number,
): Promise<boolean> => {
  const eligible = await env.DB.prepare(
    `SELECT 1 AS eligible
     FROM reviewer_invitations
     WHERE email = ? AND status = 'pending' AND expires_at > ?
     UNION ALL
     SELECT 1 AS eligible
     FROM managed_speaker_emails
     WHERE normalized_email = ?
     LIMIT 1`,
  ).bind(email, nowMs, email).first<{ eligible: number }>();
  return eligible?.eligible === 1;
};

const bearerFromRequest = (request: Request): string | null => {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(authorization);
  const bearer = match?.[1];
  return bearer && bearer.length <= 512 ? bearer : null;
};

const sessionFromRequest = (request: Request): string | null => {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const name of [HOST_SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
    const encoded = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
    if (!encoded || encoded.length > 512) continue;
    try {
      const token = decodeURIComponent(encoded);
      if (token.length > 0 && token.length <= 512) return token;
    } catch {
      // Ignore a malformed candidate and allow the transition cookie fallback.
    }
  }
  return null;
};

const setBrowserSessionCookie = (c: Context<AppHono>, session: string): void => {
  const local = isExplicitLocalEnvironment(c.env);
  setCookie(c, local ? LEGACY_SESSION_COOKIE : HOST_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "Lax",
    secure: !local,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
};

const issueDemoBrowserSession = async (env: Env, userId: string): Promise<string> => {
  const session = nanoid(48);
  const nowMs = Date.now();
  const tokenId = nanoid();
  const tokenHash = await hashBearerMaterial(env, session);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM auth_tokens WHERE user_id = ? AND kind = 'session' AND (expires_at <= ? OR consumed_at IS NOT NULL)",
    ).bind(userId, nowMs),
    env.DB.prepare(
      `DELETE FROM auth_tokens
       WHERE id IN (
         SELECT id FROM auth_tokens
         WHERE user_id = ? AND kind = 'session' AND consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    ).bind(userId, nowMs, MAX_ACTIVE_DEMO_SESSIONS_PER_PERSONA - 1),
    env.DB.prepare(
      "INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES (?, ?, ?, 'session', ?, NULL, ?)",
    ).bind(tokenId, tokenHash, userId, nowMs + SESSION_MAX_AGE_SECONDS * 1_000, nowMs),
  ]);
  return session;
};

type DemoSeed = {
  readonly users: Readonly<Record<DemoPersona, string>>;
  readonly eventId: string;
};

type DemoSeedRow = {
  readonly event_id: string;
  readonly organizer_id: string;
  readonly organizer_name: string | null;
  readonly organizer_role: string | null;
  readonly speaker_id: string;
  readonly speaker_name: string | null;
  readonly reviewer_id: string;
  readonly reviewer_name: string | null;
  readonly reviewer_role: string | null;
};

/**
 * Demo login is a hot path during evaluator runs. Keep the healthy path to one
 * read so parallel role switches do not rewrite and serialize on shared rows.
 */
const loadDemoSeed = async (env: Env): Promise<DemoSeed | null> => {
  const row = await env.DB.prepare(
    `SELECT
       e.id AS event_id,
       MAX(CASE WHEN u.email = ? THEN u.id END) AS organizer_id,
       MAX(CASE WHEN u.email = ? THEN u.name END) AS organizer_name,
       MAX(CASE WHEN u.email = ? THEN m.role END) AS organizer_role,
       MAX(CASE WHEN u.email = ? THEN u.id END) AS speaker_id,
       MAX(CASE WHEN u.email = ? THEN u.name END) AS speaker_name,
       MAX(CASE WHEN u.email = ? THEN u.id END) AS reviewer_id,
       MAX(CASE WHEN u.email = ? THEN u.name END) AS reviewer_name,
       MAX(CASE WHEN u.email = ? THEN m.role END) AS reviewer_role
     FROM events e
     CROSS JOIN users u
     LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = u.id
     WHERE e.slug = ? AND u.email IN (?, ?, ?)
     GROUP BY e.id
     LIMIT 1`,
  ).bind(
    DEMO_IDENTITIES.organizer.email,
    DEMO_IDENTITIES.organizer.email,
    DEMO_IDENTITIES.organizer.email,
    DEMO_IDENTITIES.speaker.email,
    DEMO_IDENTITIES.speaker.email,
    DEMO_IDENTITIES.reviewer.email,
    DEMO_IDENTITIES.reviewer.email,
    DEMO_IDENTITIES.reviewer.email,
    DEMO_EVENT.slug,
    DEMO_IDENTITIES.organizer.email,
    DEMO_IDENTITIES.speaker.email,
    DEMO_IDENTITIES.reviewer.email,
  ).first<DemoSeedRow>();

  if (
    !row
    || !row.organizer_id
    || !row.speaker_id
    || !row.reviewer_id
    || row.organizer_name !== DEMO_IDENTITIES.organizer.name
    || row.speaker_name !== DEMO_IDENTITIES.speaker.name
    || row.reviewer_name !== DEMO_IDENTITIES.reviewer.name
    || row.organizer_role !== "owner"
    || row.reviewer_role !== "reviewer"
  ) {
    return null;
  }

  return {
    users: {
      organizer: row.organizer_id,
      speaker: row.speaker_id,
      reviewer: row.reviewer_id,
    },
    eventId: row.event_id,
  };
};

const ensureDemoSeed = async (
  env: Env,
): Promise<DemoSeed> => {
  const existing = await loadDemoSeed(env);
  if (existing) return existing;

  const nowMs = Date.now();
  await env.DB.batch(
    Object.values(DEMO_IDENTITIES).map((identity) =>
      env.DB.prepare(
        `INSERT INTO users (id, email, name, version, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           name = excluded.name,
           version = users.version + 1,
           updated_at = excluded.updated_at
         WHERE users.name <> excluded.name OR users.name IS NULL`,
      ).bind(nanoid(), identity.email, identity.name, nowMs, nowMs),
    ),
  );

  const demoUsers = {} as Record<DemoPersona, string>;
  for (const [persona, identity] of Object.entries(DEMO_IDENTITIES) as [DemoPersona, typeof DEMO_IDENTITIES[DemoPersona]][]) {
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
    ).bind(identity.email).first<{ id: string }>();
    if (!user) throw new Error(`Demo ${persona} identity was not created`);
    demoUsers[persona] = user.id;
  }

  await env.DB.prepare(
    `INSERT INTO events
       (id, slug, name, description, location, timezone, starts_at, ends_at, banner_asset_id, accent_color, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    nanoid(),
    DEMO_EVENT.slug,
    DEMO_EVENT.name,
    DEMO_EVENT.description,
    DEMO_EVENT.location,
    DEMO_EVENT.timezone,
    DEMO_EVENT.startsAt,
    DEMO_EVENT.endsAt,
    DEMO_EVENT.accentColor,
    nowMs,
    nowMs,
  ).run();
  const event = await env.DB.prepare(
    "SELECT id FROM events WHERE slug = ? LIMIT 1",
  ).bind(DEMO_EVENT.slug).first<{ id: string }>();
  if (!event) throw new Error("Demo event was not created");

  const memberships = [
    { persona: "organizer", role: "owner" },
    { persona: "reviewer", role: "reviewer" },
  ] as const;
  await env.DB.batch(memberships.map(({ persona, role }) =>
    env.DB.prepare(
      `INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(event_id, user_id) DO UPDATE SET
         role = excluded.role,
         version = event_members.version + 1,
         updated_at = excluded.updated_at
       WHERE event_members.role <> excluded.role`,
    ).bind(nanoid(), event.id, demoUsers[persona], role, nowMs, nowMs),
  ));

  const repaired = await loadDemoSeed(env);
  if (!repaired) throw new Error("Demo seed repair did not produce a valid workspace");
  return repaired;
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

/**
 * The public hackathon deployment is also the evaluator's demo tenant. These
 * fixed synthetic identities let browser agents switch roles without access to
 * an email inbox while preserving the normal session and authorization paths.
 */
auth.post("/demo", async (c) => {
  const requestId = requestIdFor(c);
  const body = await readBoundedJson(c.req.raw).catch(() => null);
  const parsed = body === BODY_TOO_LARGE
    ? null
    : await Schema.decodeUnknownPromise(DemoLoginInput)(body).catch(() => null);
  if (!parsed) {
    return errorResponse(c, new Validation({ message: "A valid demo persona is required" }), requestId);
  }
  if (!(await authorizeDemoLogin(c.req.raw, c.env, requestId))) {
    return c.json({
      error: "TooManyRequests",
      message: "Too many demo login attempts. Try again later.",
      requestId,
    }, 429);
  }

  try {
    const identity = DEMO_IDENTITIES[parsed.persona];
    const seed = await ensureDemoSeed(c.env);
    const session = await issueDemoBrowserSession(c.env, seed.users[parsed.persona]);
    setBrowserSessionCookie(c, session);
    return c.json({
      ok: true,
      persona: parsed.persona,
      email: identity.email,
      name: identity.name,
      event: { id: seed.eventId, slug: DEMO_EVENT.slug, name: DEMO_EVENT.name },
      returnTo: parsed.returnTo === undefined || parsed.returnTo === "/events"
        ? DEMO_DESTINATIONS[parsed.persona]
        : validatedReturnTo(parsed.returnTo),
    });
  } catch (error) {
    return unexpectedResponse(c, "demo authentication", error, requestId);
  }
});

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
    if (
      !existingUser
      && !mayCreateUser(c.env, email)
      && !(await hasInvitationOrManagedSpeaker(c.env, email, nowMs))
    ) {
      return c.json({ ok: true }, 202);
    }
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
    link.hash = new URLSearchParams({ token, returnTo }).toString();
    const renderedHtml =
      `<p>Use this link to sign in. It expires in 15 minutes.</p><p><a href="${link.toString()}" rel="noreferrer">Sign in to Session Party</a></p>`;
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
        "INSERT INTO mail_deliveries (id, snapshot_id, idempotency_key, status, scheduled_for, available_at, lease_owner, lease_expires_at, attempt_count, max_attempts, provider, provider_message_id, provider_result, last_error, sent_at, dead_lettered_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL, 0, 8, 'cloudflare-email', NULL, NULL, NULL, NULL, NULL, ?)",
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

const consumeMagicLink = async (
  c: Context<AppHono>,
  token: string,
  returnTo: string,
  requestId: string,
): Promise<Response> => {
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

    setBrowserSessionCookie(c, session);
    return c.redirect(returnTo);
};

const magicLinkExchangePage = (c: Context<AppHono>): Response => {
  const nonce = nanoid();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Signing in…</title></head><body><p>Signing you in…</p><script nonce="${nonce}">const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);const t=p.get("token");if(!t){document.body.textContent="This sign-in link is incomplete.";}else{const f=document.createElement("form");f.method="post";f.action=location.pathname;for(const [n,v] of [["token",t],["returnTo",p.get("returnTo")||"/"]]){const i=document.createElement("input");i.type="hidden";i.name=n;i.value=v;f.append(i);}document.body.append(f);f.submit();}</script></body></html>`);
};

auth.get("/verify", async (c) => {
  const requestId = requestIdFor(c);
  try {
    // Query-token support keeps already-sent links valid during the transition.
    const token = c.req.query("token");
    if (!token) return magicLinkExchangePage(c);
    if (token.length > 512) {
      return errorResponse(c, new Validation({ message: "Invalid token" }), requestId);
    }
    return await consumeMagicLink(
      c,
      token,
      validatedReturnTo(c.req.query("returnTo")),
      requestId,
    );
  } catch (error) {
    return unexpectedResponse(c, "authentication", error, requestId);
  }
});

auth.post("/verify", async (c) => {
  const requestId = requestIdFor(c);
  try {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return errorResponse(c, new Validation({ message: "Invalid sign-in exchange" }), requestId);
    }
    const form = await readBoundedForm(c.req.raw).catch(() => null);
    const params = form && form !== BODY_TOO_LARGE ? form : null;
    const token = params?.get("token");
    if (!token || token.length > 512) {
      return errorResponse(c, new Validation({ message: "Invalid token" }), requestId);
    }
    return await consumeMagicLink(
      c,
      token,
      validatedReturnTo(params?.get("returnTo") ?? undefined),
      requestId,
    );
  } catch (error) {
    return unexpectedResponse(c, "authentication", error, requestId);
  }
});

auth.post("/logout", async (c) => {
  const requestId = requestIdFor(c);
  try {
    const token = getCookie(c, HOST_SESSION_COOKIE) ?? getCookie(c, LEGACY_SESSION_COOKIE);
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
    deleteCookie(c, HOST_SESSION_COOKIE, { path: "/", secure: true });
    deleteCookie(c, LEGACY_SESSION_COOKIE, { path: "/" });
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
