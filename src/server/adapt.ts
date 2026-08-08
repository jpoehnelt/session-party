import type { AppError } from "contracts/errors";
import { Unauthenticated, Validation } from "contracts/errors";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import type { Context } from "hono";
import { sessionUser } from "./auth";
import {
  AiService,
  AppLayer,
  CurrentUser,
  Db,
  Files,
  Mail,
  Rooms,
  type CurrentUserValue,
} from "./services";

type AppHono = { Bindings: Env };
export type RuntimeServices = Db | Mail | Files | Rooms | AiService | CurrentUser;

export const decode = <A, I>(schema: Schema.Schema<A, I, never>, input: unknown) =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((error) => new Validation({ message: String(error) })),
  );

const layerFor = (env: Env, user: CurrentUserValue) =>
  Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, user));

export const runEffect = async <A>(
  env: Env,
  user: CurrentUserValue,
  effect: Effect.Effect<A, AppError, RuntimeServices>,
): Promise<Exit.Exit<A, AppError>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(layerFor(env, user))));

const statusFor = (error: AppError): 400 | 401 | 403 | 404 | 409 | 502 => {
  switch (error._tag) {
    case "Validation":
      return 400;
    case "Unauthenticated":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
    case "Conflict":
      return 409;
    case "External":
      return 502;
  }
};

const appErrorBody = (error: AppError) => {
  switch (error._tag) {
    case "Validation":
    case "Conflict":
      return { error: error._tag, message: error.message };
    case "Unauthenticated":
    case "Forbidden":
      return { error: error._tag, message: error.reason ?? error._tag };
    case "NotFound":
      return { error: error._tag, message: `${error.entity} ${error.id} was not found` };
    case "External":
      return {
        error: error._tag,
        message: `${error.service} request failed${error.detail ? `: ${error.detail}` : ""}`,
      };
  }
};

export const runApi = async <A>(
  c: Context<AppHono>,
  effect: Effect.Effect<A, AppError, RuntimeServices>,
): Promise<Response> => {
  try {
    const user = await sessionUser(c);
    if (!user) {
      const error = new Unauthenticated({ reason: "A valid session or API key is required" });
      return c.json(appErrorBody(error), 401);
    }

    const exit = await runEffect(c.env, user, effect);
    if (Exit.isSuccess(exit)) return c.json(exit.value);
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") {
      return c.json(appErrorBody(failure.value), statusFor(failure.value));
    }
    console.error(JSON.stringify({ message: "API effect defect", cause: Cause.pretty(exit.cause) }));
    return c.json({ error: "Internal", message: "Internal server error" }, 500);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "API adapter failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return c.json({ error: "Internal", message: "Internal server error" }, 500);
  }
};

export const runMcp = async <A>(
  env: Env,
  user: CurrentUserValue,
  effect: Effect.Effect<A, AppError, RuntimeServices>,
): Promise<A> => {
  const exit = await runEffect(env, user, effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw new Error(JSON.stringify(appErrorBody(failure.value)));
  throw new Error(Cause.pretty(exit.cause));
};

export const runParty = runMcp;

