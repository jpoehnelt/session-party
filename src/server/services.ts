import * as schema from "contracts/schema";
import { External } from "contracts/errors";
import type { ServerMessage } from "contracts/protocol";
import { Context, Effect, Layer } from "effect";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

export type AppDatabase = DrizzleD1Database<typeof schema>;

export interface MailPayload {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly ics?: string;
}

export interface CurrentUserValue {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  /** Present only for an API-key principal, which is admin within this event. */
  readonly eventId?: string;
  readonly role?: "admin";
}

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

const optionalSecret = (
  env: Env & SecretBindings,
  key: keyof SecretBindings,
): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const sessionSecret = (env: Env): string | undefined => optionalSecret(env, "SESSION_SECRET");

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
    console.log(JSON.stringify({ message: "dev email", ...payload }));
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

export const AppLayer = (env: Env) => {
  const db = drizzle(env.DB, { schema });

  return Layer.mergeAll(
    Layer.succeed(Db, { db }),
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
          const headers = new Headers({ "Content-Type": "application/json" });
          const secret = sessionSecret(env);
          if (secret) headers.set("x-session-party-internal", secret);
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

export type AppServices = Db | Mail | Files | Rooms | AiService;

