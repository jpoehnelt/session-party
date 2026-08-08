import { appErrorStatus, External, toPublicAppError, Unauthenticated, Validation, type AppError } from "contracts/errors";
import type { AnyOperationDef } from "contracts/operation";
import type { Principal } from "contracts/principal";
import type { RestInputLocations } from "contracts/routes";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import type { Context } from "hono";
import { sessionUser } from "./auth";
import {
  AiService,
  AppLayer,
  Authorizer,
  CurrentUser,
  Db,
  Files,
  Mail,
  Rooms,
} from "./services";

export type AppHono = { Bindings: Env };
export type RuntimeServices =
  | Db
  | Mail
  | Files
  | Rooms
  | AiService
  | CurrentUser
  | Authorizer;

export const decode = <A, I>(schema: Schema.Schema<A, I, never>, input: unknown) =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((error) => new Validation({ message: String(error) })),
  );

const layerFor = (env: Env, principal: Principal) =>
  Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal));

export const runEffect = async <A>(
  env: Env,
  user: Principal,
  effect: Effect.Effect<A, AppError, RuntimeServices>,
): Promise<Exit.Exit<A, AppError>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(layerFor(env, user))));

const runOperationEffect = async (
  env: Env,
  principal: Principal | null,
  effect: Effect.Effect<unknown, AppError, RuntimeServices>,
): Promise<Exit.Exit<unknown, AppError>> => {
  const layer = principal ? layerFor(env, principal) : AppLayer(env);
  const provided = effect.pipe(Effect.provide(layer)) as Effect.Effect<unknown, AppError, never>;
  return Effect.runPromiseExit(provided);
};

const logAppError = (
  error: AppError,
  requestId: string,
  operation?: string,
): void => {
  console.error(JSON.stringify({
    message: "Application request failed",
    requestId,
    error: error._tag,
    operation: error._tag === "External" ? error.operation ?? operation : operation,
    service: error._tag === "External" ? error.service : undefined,
    detail: error._tag === "External" ? error.detail : undefined,
    migration: error._tag === "External" ? error.migration : undefined,
  }));
};

const requestIdFor = (request: Request): string =>
  request.headers.get("x-request-id") ?? crypto.randomUUID();

const failureFrom = <A>(exit: Exit.Exit<A, AppError>): AppError | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const eventIdFrom = (operation: AnyOperationDef, input: unknown): string | null => {
  if (operation.authorize.kind !== "event") return null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const eventId = Reflect.get(input, "eventId");
  return typeof eventId === "string" && eventId.length > 0 ? eventId : null;
};

/** Decode, authorize, invoke, and encode one registry operation. */
export const operationEffect = (
  operation: AnyOperationDef,
  rawInput: unknown,
  principal: Principal | null,
): Effect.Effect<unknown, AppError, RuntimeServices> =>
  decode(operation.input, rawInput).pipe(
    Effect.flatMap((input) =>
      Effect.gen(function* () {
        const authorizer = yield* Authorizer;
        yield* authorizer.authorize({
          principal,
          policy: operation.authorize,
          eventId: eventIdFrom(operation, input),
        });
        const output = yield* operation.invoke(input).pipe(
          Effect.mapError((error) =>
            error._tag === "External" && !error.operation
              ? new External({ ...error, operation: operation.id })
              : error
          ),
        );
        return yield* Schema.encode(operation.output)(output).pipe(Effect.orDie);
      }),
    ),
  );

const valuesFor = (input: Record<string, string[]>, name: string): string | readonly string[] | undefined => {
  const values = input[name];
  return !values || values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
};

export const restInput = async (
  c: Context<AppHono>,
  locations: RestInputLocations,
): Promise<Record<string, unknown>> => {
  const input: Record<string, unknown> = {};
  for (const field of locations.path ?? []) input[field] = c.req.param(field);
  const queries = c.req.queries();
  for (const field of locations.query ?? []) input[field] = valuesFor(queries, field);
  for (const [field, header] of Object.entries(locations.headers ?? {})) {
    const value = c.req.header(header);
    input[field] = field === "expectedVersion" && value !== undefined
      ? Number(value)
      : value;
  }
  if (locations.body) {
    const body = await c.req.json<unknown>().catch(() => null);
    if (locations.body === "all") return body && typeof body === "object" && !Array.isArray(body)
      ? { ...body as Record<string, unknown> }
      : { body };
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const field of locations.body) input[field] = Reflect.get(body, field);
    }
  }
  return input;
};

export const runRestOperation = async (
  c: Context<AppHono>,
  principal: Principal | null,
  operation: AnyOperationDef,
  locations: RestInputLocations,
): Promise<Response> => {
  const requestId = requestIdFor(c.req.raw);
  try {
    const rawInput = await restInput(c, locations);
    const exit = await runOperationEffect(
      c.env,
      principal,
      operationEffect(operation, rawInput, principal),
    );
    if (Exit.isSuccess(exit)) {
      const status = operation.rest?.successStatus ?? 200;
      return status === 204 ? c.body(null, 204) : c.json(exit.value, status);
    }
    const failure = failureFrom(exit);
    if (failure) {
      logAppError(failure, requestId, operation.id);
      return c.json(toPublicAppError(failure, requestId), appErrorStatus(failure));
    }
    console.error(JSON.stringify({ message: "REST operation defect", requestId, cause: Cause.pretty(exit.cause) }));
  } catch (error) {
    console.error(JSON.stringify({
      message: "REST operation adapter failed",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return c.json({ error: "Internal", message: "Internal server error", requestId }, 500);
};

export const runTransportOperation = async (
  env: Env,
  principal: Principal,
  operation: AnyOperationDef,
  rawInput: unknown,
): Promise<unknown> => {
  const requestId = crypto.randomUUID();
  const exit = await runEffect(
    env,
    principal,
    operationEffect(operation, rawInput, principal),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = failureFrom(exit);
  if (failure) {
    logAppError(failure, requestId, operation.id);
    throw new Error(JSON.stringify(toPublicAppError(failure, requestId)));
  }
  console.error(JSON.stringify({ message: "Operation transport defect", requestId, cause: Cause.pretty(exit.cause) }));
  throw new Error(JSON.stringify({ error: "Internal", message: "Internal server error", requestId }));
};

/** Compatibility boundary for the pre-registry events REST routes. */
export const runApi = async <A>(
  c: Context<AppHono>,
  effect: Effect.Effect<A, AppError, RuntimeServices>,
): Promise<Response> => {
  const requestId = requestIdFor(c.req.raw);
  try {
    const user = await sessionUser(c);
    if (!user) {
      const error = new Unauthenticated({ reason: "A valid session or API key is required" });
      return c.json(toPublicAppError(error, requestId), 401);
    }
    const exit = await runEffect(c.env, user, effect);
    if (Exit.isSuccess(exit)) return c.json(exit.value);
    const failure = failureFrom(exit);
    if (failure) {
      logAppError(failure, requestId);
      return c.json(toPublicAppError(failure, requestId), appErrorStatus(failure));
    }
    console.error(JSON.stringify({ message: "API effect defect", requestId, cause: Cause.pretty(exit.cause) }));
  } catch (error) {
    console.error(JSON.stringify({
      message: "API adapter failed",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return c.json({ error: "Internal", message: "Internal server error", requestId }, 500);
};

/** Compatibility boundary for pre-registry MCP and Party handlers. */
export const runMcp = async <A>(
  env: Env,
  user: Principal,
  effect: Effect.Effect<A, AppError, RuntimeServices>,
): Promise<A> => {
  const requestId = crypto.randomUUID();
  const exit = await runEffect(env, user, effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = failureFrom(exit);
  if (failure) {
    logAppError(failure, requestId);
    throw new Error(JSON.stringify(toPublicAppError(failure, requestId)));
  }
  console.error(JSON.stringify({ message: "MCP effect defect", requestId, cause: Cause.pretty(exit.cause) }));
  throw new Error(JSON.stringify({ error: "Internal", message: "Internal server error", requestId }));
};

export const runParty = runMcp;
