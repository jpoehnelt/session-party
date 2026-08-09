import { External, Forbidden, Unauthenticated, Validation } from "contracts/errors";
import {
  allowsApiScopes,
  allowsEventRole,
  type AuthorizationPolicy,
  type Principal,
} from "contracts/principal";
import * as schema from "contracts/schema";
import type { EventRoomBroadcast, ServerMessage } from "contracts/protocol";
import { Context, Effect, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  createAcceleventsImports,
  createFixtureAcceleventsAdapter,
  createLiveAcceleventsAdapter,
  createSecretResolver,
  type AcceleventsAdapterService,
  type AcceleventsImportsService,
  type SecretResolverService,
} from "./accelevents";
import {
  localTestPublicSubmissionAbuse,
  PublicSubmissionAbuse,
  PublicSubmissionRequest,
  TURNSTILE_TOKEN_MAX_LENGTH,
  type PublicSubmissionAbuseAttempt,
} from "@/features/submit/abuse";

export type AppDatabase = DrizzleD1Database<typeof schema>;

export interface MailPayload {
  readonly fromEmail: string;
  readonly replyToEmail?: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly icsFilename?: string;
  readonly ics?: string;
  readonly idempotencyKey?: string;
}

export interface MailReceipt {
  readonly provider: "cloudflare-email" | "local-fake";
  readonly providerMessageId: string;
  readonly providerResult: Readonly<Record<string, unknown>>;
}

export class Db extends Context.Tag("session-party/Db")<Db, { readonly db: AppDatabase }>() {}

export class SecretResolver extends Context.Tag("session-party/SecretResolver")<
  SecretResolver,
  SecretResolverService
>() {}

export class AcceleventsAdapter extends Context.Tag("session-party/AcceleventsAdapter")<
  AcceleventsAdapter,
  AcceleventsAdapterService
>() {}

export class AcceleventsImports extends Context.Tag("session-party/AcceleventsImports")<
  AcceleventsImports,
  AcceleventsImportsService
>() {}

export class Mail extends Context.Tag("session-party/Mail")<
  Mail,
  {
    readonly send: (payload: MailPayload) => Effect.Effect<MailReceipt, External>;
  }
>() {}

export class MailQueue extends Context.Tag("session-party/MailQueue")<
  MailQueue,
  {
    readonly fromEmail: string;
    readonly appOrigin: string;
    readonly wake: () => Effect.Effect<void>;
  }
>() {}

export class Files extends Context.Tag("session-party/Files")<
  Files,
  {
    readonly put: (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
      options?: R2PutOptions,
    ) => Effect.Effect<R2Object | null, External>;
    readonly get: (key: string) => Effect.Effect<R2ObjectBody | null, External>;
    readonly delete: (key: string) => Effect.Effect<void, External>;
    readonly head: (key: string) => Effect.Effect<R2Object | null, External>;
  }
>() {}

export class Rooms extends Context.Tag("session-party/Rooms")<
  Rooms,
  {
    readonly broadcast: (eventId: string, message: ServerMessage) => Effect.Effect<void, External>;
  }
>() {}

export class AiService extends Context.Tag("session-party/AiService")<
  AiService,
  {
    readonly reviewText: (prompt: string) => Effect.Effect<string, External>;
  }
>() {}

export class CurrentUser extends Context.Tag("session-party/CurrentUser")<
  CurrentUser,
  Principal
>() {}

type SecretBindings = {
  readonly LOCAL_MODE?: string;
  readonly SESSION_SECRET?: string;
  readonly ACCELEVENTS_API_TOKEN?: string;
  readonly TURNSTILE_SECRET?: string;
};

type TurnstileBindings = SecretBindings & {
  readonly TURNSTILE_SITE_KEY?: string;
  readonly TURNSTILE_HOSTNAMES?: string;
};

const LOCAL_SESSION_SECRET = "explicit-local-only-session-secret-v1";

const optionalSecret = (
  env: Env & SecretBindings,
  key: keyof SecretBindings,
): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const isExplicitLocalEnvironment = (env: object): boolean =>
  "LOCAL_MODE" in env && env.LOCAL_MODE === "1";

export const sessionSecret = (env: Env & SecretBindings): string => {
  if (isExplicitLocalEnvironment(env)) return LOCAL_SESSION_SECRET;
  const configured = optionalSecret(env, "SESSION_SECRET");
  if (configured) return configured;
  throw new Error("Missing required production secret: SESSION_SECRET");
};

const configuredValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const hmacBearerMaterial = async (env: Env & SecretBindings, value: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};

const publicSubmissionAbuse = (env: Env & TurnstileBindings) => {
  if (isExplicitLocalEnvironment(env)) return localTestPublicSubmissionAbuse;

  const siteKey = configuredValue(env.TURNSTILE_SITE_KEY) ?? null;
  const expectedHostnames = new Set(
    (configuredValue(env.TURNSTILE_HOSTNAMES) ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    turnstileSiteKey: siteKey,
    authorize: (attempt: PublicSubmissionAbuseAttempt) =>
      Effect.gen(function* () {
        const secret = optionalSecret(env, "TURNSTILE_SECRET");
        if (!siteKey || !secret || expectedHostnames.size === 0) {
          return yield* Effect.fail(new External({
            service: "turnstile",
            detail: "Human verification is not configured",
          }));
        }
        if (
          !attempt.turnstileToken
          || attempt.turnstileToken.length > TURNSTILE_TOKEN_MAX_LENGTH
          || !attempt.normalizedEmail
          || !attempt.remoteIp
        ) {
          return yield* Effect.fail(new Validation({
            message: "Human verification could not be completed. Please try again.",
          }));
        }

        const verification = yield* Effect.tryPromise({
          try: async () => {
            const body = new URLSearchParams({
              secret,
              response: attempt.turnstileToken as string,
              remoteip: attempt.remoteIp as string,
              idempotency_key: crypto.randomUUID(),
            });
            const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body,
              signal: AbortSignal.timeout(5_000),
            });
            if (!response.ok) throw new Error(`Siteverify returned ${response.status}`);
            const text = await response.text();
            if (text.length > 16_384) throw new Error("Siteverify returned an oversized response");
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null) {
              throw new Error("Siteverify returned invalid JSON");
            }
            return parsed as Record<string, unknown>;
          },
          catch: (error) => new External({
            service: "turnstile",
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
        const hostname = typeof verification.hostname === "string"
          ? verification.hostname.toLowerCase()
          : "";
        if (
          verification.success !== true
          || verification.action !== "cfp-submit"
          || !expectedHostnames.has(hostname)
        ) {
          return yield* Effect.fail(new Validation({
            message: "Human verification could not be completed. Please try again.",
          }));
        }

        const [sourceHash, recipientHash] = yield* Effect.tryPromise({
          try: () => Promise.all([
            hmacBearerMaterial(env, `cfp-source:${attempt.remoteIp!.slice(0, 128)}`),
            hmacBearerMaterial(
              env,
              `cfp-recipient:${attempt.eventId}:${attempt.formId}:${attempt.normalizedEmail}`,
            ),
          ]),
          catch: (error) => new External({
            service: "cfp-rate-limit",
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
        const limiterId = env.SCHEDULER.idFromName("cfp-rate-limit");
        const response = yield* Effect.tryPromise({
          try: () => env.SCHEDULER.get(limiterId).fetch(
            "https://scheduler/cfp/authorize",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-session-party-internal": sessionSecret(env),
              },
              body: JSON.stringify({
                sourceHash,
                recipientHash,
                eventId: attempt.eventId,
                formId: attempt.formId,
              }),
            },
          ),
          catch: (error) => new External({
            service: "cfp-rate-limit",
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
        if (response.status === 429) {
          return yield* Effect.fail(new Validation({
            message: "Submission limit reached. Please try again later.",
          }));
        }
        if (!response.ok) {
          return yield* Effect.fail(new External({
            service: "cfp-rate-limit",
            detail: `Scheduler returned ${response.status}`,
          }));
        }
      }),
  } as const;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

const toBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const LOCAL_MAIL_FROM = "Session Party <welcome@sessionparty.com>";

export const mailFrom = (env: Env & SecretBindings): string => {
  if (isExplicitLocalEnvironment(env)) return LOCAL_MAIL_FROM;
  const configured = typeof env.MAIL_FROM === "string" ? env.MAIL_FROM.trim() : "";
  if (configured) return configured;
  throw new Error("Missing required production binding: MAIL_FROM");
};

const appOrigin = (env: Env): string => {
  const configured = typeof env.APP_URL === "string" ? env.APP_URL.trim() : "";
  if (!configured) {
    throw new Error("Missing required binding: APP_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("Invalid required binding APP_URL: expected an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid required binding APP_URL: expected HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Invalid required binding APP_URL: credentials are not allowed");
  }
  if (parsed.pathname !== "/") {
    throw new Error("Invalid required binding APP_URL: pathname must be empty or /");
  }
  if (parsed.search || parsed.href.includes("?")) {
    throw new Error("Invalid required binding APP_URL: query is not allowed");
  }
  if (parsed.hash || parsed.href.includes("#")) {
    throw new Error("Invalid required binding APP_URL: hash is not allowed");
  }
  return parsed.origin;
};

export const requireMailConfiguration = (env: Env & SecretBindings): void => {
  mailFrom(env);
  if (!isExplicitLocalEnvironment(env) && !env.EMAIL) {
    throw new Error("Missing required production binding: EMAIL");
  }
};

/** Stable non-secret correlation metadata; it does not suppress duplicate delivery. */
export const outboundCorrelationId = async (idempotencyKey?: string): Promise<string> => {
  const identity = idempotencyKey ?? crypto.randomUUID();
  return `sp-${await sha256Hex(identity)}`;
};

/** Shared by the Effect Mail service and Scheduler DO. */
export const sendMail = async (
  env: Env & SecretBindings,
  payload: MailPayload,
): Promise<MailReceipt> => {
  requireMailConfiguration(env);
  const correlationId = await outboundCorrelationId(payload.idempotencyKey);
  if (isExplicitLocalEnvironment(env)) {
    const providerMessageId = payload.idempotencyKey
      ? `local-fake:${await sha256Hex(payload.idempotencyKey)}`
      : `local-fake:${crypto.randomUUID()}`;
    console.log(JSON.stringify({ deliveryMode: "local-fake", providerMessageId, correlationId }));
    return {
      provider: "local-fake",
      providerMessageId,
      providerResult: { deliveryMode: "local-fake", outboundCorrelationId: correlationId },
    };
  }

  const result = await env.EMAIL.send({
    from: payload.fromEmail,
    replyTo: payload.replyToEmail,
    to: payload.to,
    subject: payload.subject,
    headers: { "X-Session-Party-Delivery-ID": correlationId },
    html: payload.html,
    text: payload.text,
    attachments: payload.ics
      ? [{
        disposition: "attachment",
        filename: payload.icsFilename ?? "invite.ics",
        type: "text/calendar; charset=utf-8; method=REQUEST",
        content: toBase64(payload.ics),
      }]
      : undefined,
  });
  if (!result || typeof result.messageId !== "string" || result.messageId.length === 0) {
    throw new Error("Cloudflare Email returned an invalid delivery receipt");
  }
  return {
    provider: "cloudflare-email",
    providerMessageId: result.messageId,
    providerResult: {
      providerMessageId: result.messageId,
      outboundCorrelationId: correlationId,
    },
  };
};

const externalEffect = <A>(service: string, run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service,
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

export interface AuthorizationRequest {
  readonly principal: Principal | null;
  readonly policy: AuthorizationPolicy;
  /** Resolved top-level input.eventId for event policies; null for every other policy. */
  readonly eventId: string | null;
}

export type AuthorizePrincipal = (
  request: AuthorizationRequest,
) => Effect.Effect<Principal | null, Unauthenticated | Forbidden | External, Db>;

export const authorizePrincipal: AuthorizePrincipal = ({ principal, policy, eventId }) =>
  Effect.gen(function* () {
    if (policy.kind === "public") return principal;
    if (!principal) {
      return yield* Effect.fail(
        new Unauthenticated({ reason: "A valid session or API key is required" }),
      );
    }
    if (policy.kind === "authenticated") return principal;
    if (policy.kind === "browser-session") {
      if (principal.kind !== "browser-session") {
        return yield* Effect.fail(
          new Forbidden({ reason: "This operation requires a browser session" }),
        );
      }
      return principal;
    }
    if (!eventId) {
      return yield* Effect.fail(
        new Forbidden({ reason: "Event authorization requires a resolved event ID" }),
      );
    }
    if (principal.kind === "api-key") {
      if (principal.eventId !== eventId || !allowsApiScopes(policy.apiKey, principal.scopes)) {
        return yield* Effect.fail(
          new Forbidden({ reason: "API key is not authorized for this event operation" }),
        );
      }
      return principal;
    }

    const { db } = yield* Db;
    const [membership] = yield* externalEffect("database", () =>
      db
        .select({ role: schema.eventMembers.role })
        .from(schema.eventMembers)
        .where(
          and(
            eq(schema.eventMembers.eventId, eventId),
            eq(schema.eventMembers.userId, principal.userId),
          ),
        )
        .limit(1),
    );
    if (!membership || !allowsEventRole(policy.browser, membership.role)) {
      return yield* Effect.fail(
        new Forbidden({ reason: "Event membership does not satisfy the authorization policy" }),
      );
    }
    return principal;
  });

export class Authorizer extends Context.Tag("session-party/Authorizer")<
  Authorizer,
  { readonly authorize: AuthorizePrincipal }
>() {}

export const AppLayer = (env: Env) => {
  const db = drizzle(env.DB, { schema });
  const secrets = createSecretResolver(optionalSecret(env, "ACCELEVENTS_API_TOKEN"));
  const fixtureAcceleventsAdapter = createFixtureAcceleventsAdapter();
  const acceleventsAdapter = isExplicitLocalEnvironment(env)
    ? fixtureAcceleventsAdapter
    : createLiveAcceleventsAdapter();
  const acceleventsImports = createAcceleventsImports({
    db,
    adapter: acceleventsAdapter,
    fixtureAdapter: fixtureAcceleventsAdapter,
    secrets,
  });

  return Layer.mergeAll(
    Layer.succeed(Db, { db }),
    Layer.succeed(SecretResolver, secrets),
    Layer.succeed(AcceleventsAdapter, acceleventsAdapter),
    Layer.succeed(AcceleventsImports, acceleventsImports),
    Layer.succeed(PublicSubmissionAbuse, publicSubmissionAbuse(env)),
    Layer.succeed(PublicSubmissionRequest, { remoteIp: null }),
    Layer.succeed(Authorizer, { authorize: authorizePrincipal }),
    Layer.succeed(Mail, {
      send: (payload) => externalEffect("cloudflare-email", () => sendMail(env, payload)),
    }),
    Layer.succeed(MailQueue, {
      appOrigin: appOrigin(env),
      fromEmail: mailFrom(env),
      wake: () =>
        externalEffect("mail-scheduler", async () => {
          const id = env.SCHEDULER.idFromName("mail");
          const response = await env.SCHEDULER.get(id).fetch("https://scheduler/poke", {
            method: "POST",
            headers: { "x-session-party-internal": sessionSecret(env) },
          });
          if (!response.ok) throw new Error(`Mail scheduler returned ${response.status}`);
        }).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Mail outbox persisted but scheduler wake failed", { error })),
        ),
    }),
    Layer.succeed(Files, {
      put: (key, value, options) =>
        externalEffect("r2", async () => env.FILES.put(key, value, options)),
      get: (key) => externalEffect("r2", async () => env.FILES.get(key)),
      delete: (key) => externalEffect("r2", async () => env.FILES.delete(key)),
      head: (key) => externalEffect("r2", async () => env.FILES.head(key)),
    }),
    Layer.succeed(Rooms, {
      broadcast: (eventId, message) =>
        externalEffect("event-room", async () => {
          const id = env.EVENT_ROOM.idFromName(eventId);
          const headers = new Headers({
            "Content-Type": "application/json",
            "x-session-party-internal": sessionSecret(env),
          });
          const response = await env.EVENT_ROOM.get(id).fetch("https://event-room/broadcast", {
            method: "POST",
            headers,
            body: JSON.stringify({ message } satisfies EventRoomBroadcast),
          });
          if (!response.ok) throw new Error(`Event room returned ${response.status}`);
        }),
    }),
    Layer.succeed(AiService, {
      reviewText: (prompt) =>
        externalEffect("workers-ai", async () => {
          const result: unknown = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
            prompt,
          });
          if (
            typeof result === "object" &&
            result !== null &&
            "response" in result &&
            typeof result.response === "string"
          ) {
            return result.response;
          }
          throw new Error("Workers AI returned an unexpected response");
        }),
    }),
  );
};

export type AppServices =
  | Db
  | SecretResolver
  | AcceleventsAdapter
  | AcceleventsImports
  | PublicSubmissionAbuse
  | PublicSubmissionRequest
  | Mail
  | MailQueue
  | Files
  | Rooms
  | AiService
  | Authorizer;
