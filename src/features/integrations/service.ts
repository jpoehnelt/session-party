import { External, type AppError } from "contracts/errors";
import { eventAuthorization, type AuthorizationPolicy } from "contracts/principal";
import { integrations } from "contracts/schema";
import { IntegrationConfig, type IntegrationConfig as IntegrationConfigType } from "contracts/types";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Authorizer, CurrentUser, Db } from "@/server/services";

export const integrationsReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["integrations:read"] },
);

const authorizeCurrent = (policy: AuthorizationPolicy, eventId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    return yield* authorize({ principal, policy, eventId });
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
  eventId: string,
): Effect.Effect<
  readonly IntegrationConfigType[],
  AppError,
  Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    yield* authorizeCurrent(integrationsReadAuthorization, eventId);
    const { db } = yield* Db;
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
