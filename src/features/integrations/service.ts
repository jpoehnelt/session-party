import { External, NotFound, type AppError } from "contracts/errors";
import { eventAuthorization, type AuthorizationPolicy, type Principal } from "contracts/principal";
import { events, integrations } from "contracts/schema";
import {
  IntegrationConfig,
  type AcceleventsImportRun,
  type AcceleventsImportStatus,
  type IntegrationConfig as IntegrationConfigType,
} from "contracts/types";
import { eq, or } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { AcceleventsImports, Authorizer, CurrentUser, Db } from "@/server/services";

export const integrationsReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["integrations:read"] },
);

export const integrationsWriteAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["integrations:write"] },
);

const authorizeCurrent = (policy: AuthorizationPolicy, eventId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    yield* authorize({ principal, policy, eventId });
    return principal;
  });

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const resolveEventId = (idOrSlug: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db
        .select({ id: events.id })
        .from(events)
        .where(or(eq(events.id, idOrSlug), eq(events.slug, idOrSlug)))
        .limit(1),
    );
    if (!event) {
      return yield* Effect.fail(new NotFound({ entity: "event", id: idOrSlug }));
    }
    return event.id;
  });

const importActor = (principal: Principal) => principal.kind === "api-key"
  ? { kind: "api-key" as const, id: principal.apiKeyId }
  : { kind: "user" as const, id: principal.userId };

const decodeConfiguration = (
  kind: "airtable" | "accelevents",
  value: unknown,
): Effect.Effect<IntegrationConfigType, External> =>
  Schema.decodeUnknown(IntegrationConfig)(value).pipe(
    Effect.filterOrFail(
      (configuration) => configuration.kind === kind,
      () =>
        new External({
          service: "integrations-configuration",
          detail: `Stored ${kind} configuration has a mismatched discriminator`,
        }),
    ),
    Effect.mapError((error) =>
      error instanceof External
        ? error
        : new External({
            service: "integrations-configuration",
            detail: `Stored ${kind} configuration is invalid: ${String(error)}`,
          }),
    ),
  );

/**
 * Returns only validated, non-secret provider configuration. The secretRef,
 * cursor, provider errors, and raw JSON column never cross this boundary.
 */
export const listIntegrationConfigurations = (
  idOrSlug: string,
): Effect.Effect<
  readonly IntegrationConfigType[],
  AppError,
  Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const eventId = yield* resolveEventId(idOrSlug);
    yield* authorizeCurrent(integrationsReadAuthorization, eventId);
    const rows = yield* database(() =>
      db
        .select({ kind: integrations.kind, config: integrations.config })
        .from(integrations)
        .where(eq(integrations.eventId, eventId)),
    );
    return yield* Effect.forEach(rows, (row) =>
      decodeConfiguration(row.kind, row.config),
    );
  });

export const getAcceleventsImportStatus = (
  idOrSlug: string,
): Effect.Effect<
  AcceleventsImportStatus,
  AppError,
  AcceleventsImports | Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    const eventId = yield* resolveEventId(idOrSlug);
    yield* authorizeCurrent(integrationsReadAuthorization, eventId);
    const imports = yield* AcceleventsImports;
    return yield* imports.status(eventId);
  });

export const runAcceleventsImport = (
  idOrSlug: string,
  idempotencyKey: string,
): Effect.Effect<
  AcceleventsImportRun,
  AppError,
  AcceleventsImports | Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    const eventId = yield* resolveEventId(idOrSlug);
    const principal = yield* authorizeCurrent(integrationsWriteAuthorization, eventId);
    const imports = yield* AcceleventsImports;
    return yield* imports.run({
      eventId,
      idempotencyKey,
      actor: importActor(principal),
    });
  });
