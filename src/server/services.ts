import { External, Forbidden, Unauthenticated } from "contracts/errors";
import {
  allowsApiScopes,
  allowsEventRole,
  type AuthorizationPolicy,
  type Principal,
} from "contracts/principal";
import * as schema from "contracts/schema";
import type { ServerMessage } from "contracts/protocol";
import { Context, Effect, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

export type AppDatabase = DrizzleD1Database<typeof schema>;

export interface MailPayload {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly ics?: string;
}

/** Compatibility name for the per-invocation principal capability. */
export type CurrentUserValue = Principal;

export class Db extends Context.Tag("session-party/Db")<Db, { readonly db: AppDatabase }>() {}

export class Mail extends Context.Tag("session-party/Mail")<
  Mail,
  {
    readonly send: (payload: MailPayload) => Effect.Effect<void, External>;
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
  CurrentUserValue
>() {}

type SecretBindings = {
  readonly RESEND_API_KEY?: string;
  readonly SESSION_SECRET?: string;
};

const LOCAL_SESSION_SECRET = "explicit-local-only-session-secret-v1";

const optionalSecret = (
  env: Env & SecretBindings,
  key: keyof SecretBindings,
): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const isExplicitLocalEnvironment = (env: Pick<Env, "APP_URL">): boolean => {
  const url = new URL(env.APP_URL);
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]")
  );
};

export const sessionSecret = (env: Env): string => {
  const configured = optionalSecret(env, "SESSION_SECRET");
  if (configured) return configured;
  if (isExplicitLocalEnvironment(env)) return LOCAL_SESSION_SECRET;
  throw new Error("Missing required production secret: SESSION_SECRET");
};

const toBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Shared by the Effect Mail service and Scheduler DO. */
export const sendMail = async (env: Env, payload: MailPayload): Promise<void> => {
  const apiKey = optionalSecret(env, "RESEND_API_KEY");
  if (!apiKey) {
    if (!isExplicitLocalEnvironment(env)) {
      throw new Error("Missing required production secret: RESEND_API_KEY");
    }
    console.log(JSON.stringify({ deliveryMode: "local-fake", message: "dev email", ...payload }));
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Session Party <onboarding@resend.dev>",
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      attachments: payload.ics
        ? [{ filename: "invite.ics", content: toBase64(payload.ics) }]
        : undefined,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000);
    throw new Error(`Resend returned ${response.status}: ${detail}`);
  }
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

  return Layer.mergeAll(
    Layer.succeed(Db, { db }),
    Layer.succeed(Authorizer, { authorize: authorizePrincipal }),
    Layer.succeed(Mail, {
      send: (payload) => externalEffect("resend", () => sendMail(env, payload)),
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
            body: JSON.stringify(message),
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

export type AppServices = Db | Mail | Files | Rooms | AiService | Authorizer;

