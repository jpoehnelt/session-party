import { Conflict, External, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization, type AuthorizationPolicy, type Principal } from "contracts/principal";
import {
  airtableDeadLetters,
  airtableOutbox,
  airtablePendingEdits,
  airtableRefreshState,
  auditLog,
  domainChanges,
  events,
  idempotencyRecords,
  integrations,
} from "contracts/schema";
import type { JsonValue } from "contracts/domain";
import {
  IntegrationConfig,
  type AcceleventsImportRun,
  type AcceleventsImportStatus,
  type IntegrationConfig as IntegrationConfigType,
} from "contracts/types";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { AcceleventsImports, AirtableSync, Authorizer, CurrentUser, Db } from "@/server/services";
import type {
  AcceleventsConfiguration,
  AirtableSyncStatus,
  ConfigureAcceleventsInput,
  ConfigureAcceleventsResult,
  ConfigureAirtableInput,
  ConfigureAirtableResult,
  RequestAirtableRefreshInput,
  RequestAirtableRefreshResult,
} from "./schema";

export const integrationsReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["integrations:read"] },
);

export const integrationsWriteAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["integrations:write"] },
);

export const authorizeCurrent = (policy: AuthorizationPolicy, eventId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    yield* authorize({ principal, policy, eventId });
    return principal;
  });

export const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

export const resolveEventId = (idOrSlug: string) =>
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

export const actorColumns = (principal: Principal) => principal.kind === "api-key"
  ? { actorUserId: null, actorApiKeyId: principal.apiKeyId }
  : { actorUserId: principal.userId, actorApiKeyId: null };

export const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (error) => new External({
      service: "integrations-configuration",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const fixtureConfig = (accelEventId: string, eventUrl: string) =>
  accelEventId === "fixture-event" && eventUrl === "fixture-event";

const validateAcceleventsSource = (input: ConfigureAcceleventsInput) => {
  const isFixture = fixtureConfig(input.accelEventId, input.eventUrl);
  if (input.source === "fixture" && !isFixture) {
    return Effect.fail(new Validation({
      message: "Fixture configuration must use the deterministic fixture-event mapping",
    }));
  }
  if (input.source === "live" && isFixture) {
    return Effect.fail(new Validation({
      message: "Live configuration cannot use the reserved fixture-event mapping",
    }));
  }
  return Effect.void;
};

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

/** Version is safe organizer metadata needed for an optimistic configuration edit. */
export const getAcceleventsConfiguration = (
  idOrSlug: string,
): Effect.Effect<
  AcceleventsConfiguration | null,
  AppError,
  Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const eventId = yield* resolveEventId(idOrSlug);
    yield* authorizeCurrent(integrationsReadAuthorization, eventId);
    const [stored] = yield* database(() => db.select().from(integrations).where(and(
      eq(integrations.eventId, eventId),
      eq(integrations.kind, "accelevents"),
    )).limit(1));
    if (!stored) return null;
    const config = yield* decodeConfiguration("accelevents", stored.config);
    if (config.kind !== "accelevents") {
      return yield* Effect.fail(new External({
        service: "integrations-configuration",
        detail: "Stored Accelevents configuration has a mismatched discriminator",
      }));
    }
    return {
      config,
      source: fixtureConfig(config.accelEventId, config.eventUrl) ? "fixture" : "live",
      version: stored.version,
    };
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

/**
 * Creates/replaces a non-secret Accelevents mapping. Secret material is never
 * accepted or returned: live execution resolves the Worker-held reference.
 */
export const configureAccelevents = (
  input: ConfigureAcceleventsInput,
): Effect.Effect<
  ConfigureAcceleventsResult,
  AppError,
  Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    yield* validateAcceleventsSource(input);
    const { db } = yield* Db;
    const eventId = yield* resolveEventId(input.idOrSlug);
    const principal = yield* authorizeCurrent(integrationsWriteAuthorization, eventId);
    const [keyHash, requestHash] = yield* Effect.all([
      sha256(input.idempotencyKey),
      sha256(JSON.stringify({
        eventId,
        source: input.source,
        accelEventId: input.accelEventId,
        eventUrl: input.eventUrl,
        expectedVersion: input.expectedVersion,
      })),
    ]);
    const principalId = principal.kind === "api-key" ? `api-key:${principal.apiKeyId}` : `user:${principal.userId}`;
    const existingReplay = yield* database(() => db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, eventId),
      eq(idempotencyRecords.operationId, "integrations.configureAccelevents"),
      eq(idempotencyRecords.principalId, principalId),
      eq(idempotencyRecords.keyHash, keyHash),
    )).limit(1));
    if (existingReplay[0]) {
      const record = existingReplay[0];
      if (record.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different request" }));
      }
      if (record.status !== "completed" || record.responseBody === null) {
        return yield* Effect.fail(new Conflict({ message: "An equivalent configuration change is in progress" }));
      }
      return { ...(record.responseBody as ConfigureAcceleventsResult), replayed: true };
    }
    const [stored] = yield* database(() => db.select().from(integrations).where(and(
      eq(integrations.eventId, eventId),
      eq(integrations.kind, "accelevents"),
    )).limit(1));
    const actualVersion = stored?.version ?? 0;
    if (actualVersion !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Accelevents configuration version is ${actualVersion}; expected ${input.expectedVersion}`,
      }));
    }
    const now = new Date();
    const nextVersion = actualVersion + 1;
    const config = { kind: "accelevents" as const, accelEventId: input.accelEventId, eventUrl: input.eventUrl };
    const configuration = { config, source: input.source, version: nextVersion };
    const integrationId = stored?.id ?? `integration_${nanoid()}`;
    const idempotencyId = `idempotency_${nanoid()}`;
    const changeId = `change_${nanoid()}`;
    const auditId = `audit_${nanoid()}`;
    const result: ConfigureAcceleventsResult = { configuration, changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    const before = stored ? { config: yield* decodeConfiguration("accelevents", stored.config), version: stored.version } : null;
    const operations = [
      stored
        ? db.update(integrations).set({
          config,
          version: nextVersion,
          lastError: null,
          updatedAt: now,
        }).where(and(eq(integrations.eventId, eventId), eq(integrations.id, stored.id), eq(integrations.version, input.expectedVersion)))
        : db.insert(integrations).values({
          id: integrationId,
          eventId,
          kind: "accelevents",
          // Live import code resolves this named Worker secret. The fixture mapping
          // is recognized by the central adapter seam and never resolves it.
          secretRef: "ACCELEVENTS_API_TOKEN",
          config,
          version: nextVersion,
          createdAt: now,
          updatedAt: now,
        }),
      db.insert(idempotencyRecords).values({
        id: idempotencyId,
        eventId,
        operationId: "integrations.configureAccelevents",
        principalId,
        keyHash,
        requestHash,
        status: "completed",
        responseStatus: stored ? 200 : 201,
        responseBody: result as unknown as JsonValue,
        expiresAt: new Date(now.getTime() + 86_400_000),
        completedAt: now,
        createdAt: now,
      }),
      db.insert(domainChanges).values({
        id: changeId,
        eventId,
        aggregateType: "integration",
        aggregateId: integrationId,
        aggregateVersion: nextVersion,
        eventType: "integrations.accelevents_configured",
        audiences: [{ kind: "admins" }],
        payload: configuration,
        ...actor,
        requestId: `integrations-${idempotencyId}`,
        idempotencyRecordId: idempotencyId,
        occurredAt: now,
      }),
      db.insert(auditLog).values({
        id: auditId,
        eventId,
        requestId: `integrations-${idempotencyId}`,
        ...actor,
        action: "integrations.configureAccelevents",
        resourceType: "integration",
        resourceId: integrationId,
        before,
        after: configuration,
        metadata: { source: input.source, idempotencyKeyHash: keyHash },
        occurredAt: now,
      }),
    ] as const;
    yield* database(() => db.batch(operations));
    return result;
  }).pipe(
    Effect.catchIf(
      (error): error is External => error._tag === "External" && (error.detail?.includes("UNIQUE constraint failed") ?? false),
      () => Effect.fail(new Conflict({ message: "Accelevents configuration changed; reload and try again" })),
    ),
  );

const validateAirtableMapping = (input: ConfigureAirtableInput) => {
  const identifier = /^[A-Za-z0-9_-]+$/;
  if (!identifier.test(input.config.baseId) || input.config.baseId.length > 255) {
    return Effect.fail(new Validation({ message: "Airtable base ID must be a non-empty physical identifier" }));
  }
  if (input.config.origin.trim().length === 0 || input.config.origin.length > 255) {
    return Effect.fail(new Validation({ message: "Airtable origin must be a non-empty deployment identifier" }));
  }
  const tables = [
    input.config.tables.speakers,
    input.config.tables.submissions,
    input.config.tables.talks,
  ];
  if (tables.some((table) => !identifier.test(table.tableId) || table.tableId.length > 255)) {
    return Effect.fail(new Validation({ message: "Every Airtable table must use a non-empty physical table ID" }));
  }
  if (new Set(tables.map((table) => table.tableId)).size !== tables.length) {
    return Effect.fail(new Validation({ message: "Each Airtable entity must use a different table" }));
  }
  for (const table of tables) {
    const fieldIds = Object.values(table.fields);
    if (fieldIds.some((fieldId) => !identifier.test(fieldId) || fieldId.length > 255)) {
      return Effect.fail(new Validation({
        message: `Airtable table ${table.tableId} must map every logical field to a physical field ID`,
      }));
    }
    if (new Set(fieldIds).size !== fieldIds.length) {
      return Effect.fail(new Validation({
        message: `Airtable table ${table.tableId} maps more than one logical field to the same field ID`,
      }));
    }
  }
  return Effect.void;
};

export const configureAirtable = (
  input: ConfigureAirtableInput,
): Effect.Effect<
  ConfigureAirtableResult,
  AppError,
  AirtableSync | Authorizer | CurrentUser | Db
> => Effect.gen(function* () {
  yield* validateAirtableMapping(input);
  const { db } = yield* Db;
  const sync = yield* AirtableSync;
  const eventId = yield* resolveEventId(input.idOrSlug);
  const principal = yield* authorizeCurrent(integrationsWriteAuthorization, eventId);
  const [keyHash, requestHash] = yield* Effect.all([
    sha256(input.idempotencyKey),
    sha256(JSON.stringify({ eventId, config: input.config, expectedVersion: input.expectedVersion })),
  ]);
  const principalId = principal.kind === "api-key" ? `api-key:${principal.apiKeyId}` : `user:${principal.userId}`;
  const [existingReplay] = yield* database(() => db.select().from(idempotencyRecords).where(and(
    eq(idempotencyRecords.eventId, eventId),
    eq(idempotencyRecords.operationId, "integrations.configureAirtable"),
    eq(idempotencyRecords.principalId, principalId),
    eq(idempotencyRecords.keyHash, keyHash),
  )).limit(1));
  if (existingReplay) {
    if (existingReplay.requestHash !== requestHash) {
      return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different request" }));
    }
    if (existingReplay.status !== "completed" || existingReplay.responseBody === null) {
      return yield* Effect.fail(new Conflict({ message: "An equivalent Airtable configuration change is in progress" }));
    }
    const replayed = { ...(existingReplay.responseBody as ConfigureAirtableResult), replayed: true };
    yield* sync.wake(replayed.configuration.config.baseId);
    return replayed;
  }
  const [stored] = yield* database(() => db.select().from(integrations).where(and(
    eq(integrations.eventId, eventId),
    eq(integrations.kind, "airtable"),
  )).limit(1));
  const actualVersion = stored?.version ?? 0;
  if (actualVersion !== input.expectedVersion) {
    return yield* Effect.fail(new Conflict({
      message: `Airtable configuration version is ${actualVersion}; expected ${input.expectedVersion}`,
    }));
  }
  const now = new Date();
  const nextVersion = actualVersion + 1;
  const integrationId = stored?.id ?? `integration_${nanoid()}`;
  const idempotencyId = `idempotency_${nanoid()}`;
  const changeId = `change_${nanoid()}`;
  const auditId = `audit_${nanoid()}`;
  const configuration = { config: input.config, version: nextVersion };
  const result: ConfigureAirtableResult = { configuration, changeId, auditId, replayed: false };
  const actor = actorColumns(principal);
  const before = stored
    ? { config: yield* decodeConfiguration("airtable", stored.config), version: stored.version }
    : null;
  const statements = [
    stored
      ? db.update(integrations).set({
        config: input.config,
        secretRef: "AIRTABLE_PAT",
        version: nextVersion,
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(integrations.eventId, eventId),
        eq(integrations.id, stored.id),
        eq(integrations.version, input.expectedVersion),
      ))
      : db.insert(integrations).values({
        id: integrationId,
        eventId,
        kind: "airtable",
        secretRef: "AIRTABLE_PAT",
        config: input.config,
        version: nextVersion,
        createdAt: now,
        updatedAt: now,
      }),
    db.insert(idempotencyRecords).values({
      id: idempotencyId,
      eventId,
      operationId: "integrations.configureAirtable",
      principalId,
      keyHash,
      requestHash,
      status: "completed",
      responseStatus: stored ? 200 : 201,
      responseBody: result as unknown as JsonValue,
      expiresAt: new Date(now.getTime() + 86_400_000),
      completedAt: now,
      createdAt: now,
    }),
    db.insert(domainChanges).values({
      id: changeId,
      eventId,
      aggregateType: "integration",
      aggregateId: integrationId,
      aggregateVersion: nextVersion,
      eventType: "integrations.airtable_configured",
      audiences: [{ kind: "admins" }],
      payload: configuration,
      ...actor,
      requestId: `integrations-${idempotencyId}`,
      idempotencyRecordId: idempotencyId,
      occurredAt: now,
    }),
    db.insert(auditLog).values({
      id: auditId,
      eventId,
      requestId: `integrations-${idempotencyId}`,
      ...actor,
      action: "integrations.configureAirtable",
      resourceType: "integration",
      resourceId: integrationId,
      before,
      after: configuration,
      metadata: { adapterMode: sync.mode, idempotencyKeyHash: keyHash },
      occurredAt: now,
    }),
  ] as const;
  yield* database(() => db.batch(statements));
  yield* sync.wake(input.config.baseId);
  return result;
}).pipe(
  Effect.catchIf(
    (error): error is External => error._tag === "External" && (error.detail?.includes("UNIQUE constraint failed") ?? false),
    () => Effect.fail(new Conflict({ message: "Airtable configuration changed; reload and try again" })),
  ),
);

export const getAirtableSyncStatus = (
  idOrSlug: string,
): Effect.Effect<
  AirtableSyncStatus,
  AppError,
  AirtableSync | Authorizer | CurrentUser | Db
> => Effect.gen(function* () {
  const { db } = yield* Db;
  const sync = yield* AirtableSync;
  const eventId = yield* resolveEventId(idOrSlug);
  yield* authorizeCurrent(integrationsReadAuthorization, eventId);
  const [stored] = yield* database(() => db.select().from(integrations).where(and(
    eq(integrations.eventId, eventId),
    eq(integrations.kind, "airtable"),
  )).limit(1));
  if (!stored) {
    return {
      configured: false,
      configuration: null,
      capability: {
        mode: sync.mode,
        state: sync.available ? "ready" : "unavailable",
        reason: sync.available ? null : "AIRTABLE_PAT is not configured",
      },
      lastSyncedAt: null,
      lastError: null,
      counts: { pending: 0, retrying: 0, blocked: 0, deadLetters: 0, pendingEdits: 0, conflicts: 0 },
      refresh: [],
    };
  }
  const config = yield* decodeConfiguration("airtable", stored.config);
  if (config.kind !== "airtable") {
    return yield* Effect.fail(new External({
      service: "integrations-configuration",
      detail: "Stored Airtable configuration has a mismatched discriminator",
    }));
  }
  const [outboxRows, pendingRows, conflictRows, deadRows, refreshRows] = yield* Effect.all([
    database(() => db.select({ status: airtableOutbox.status }).from(airtableOutbox).where(
      eq(airtableOutbox.integrationId, stored.id),
    )),
    database(() => db.select({ id: airtablePendingEdits.id }).from(airtablePendingEdits).where(and(
      eq(airtablePendingEdits.integrationId, stored.id),
      eq(airtablePendingEdits.status, "pending"),
    ))),
    database(() => db.select({ id: airtablePendingEdits.id }).from(airtablePendingEdits).where(and(
      eq(airtablePendingEdits.integrationId, stored.id),
      eq(airtablePendingEdits.status, "conflict"),
    ))),
    database(() => db.select({ id: airtableDeadLetters.id }).from(airtableDeadLetters).where(and(
      eq(airtableDeadLetters.integrationId, stored.id),
      isNull(airtableDeadLetters.resolvedAt),
    ))),
    database(() => db.select().from(airtableRefreshState).where(
      eq(airtableRefreshState.integrationId, stored.id),
    )),
  ], { concurrency: 1 });
  return {
    configured: true,
    configuration: { config, version: stored.version },
    capability: {
      mode: sync.mode,
      state: sync.available ? "ready" : "unavailable",
      reason: sync.available ? null : "AIRTABLE_PAT is not configured",
    },
    lastSyncedAt: stored.lastSyncAt?.getTime() ?? null,
    lastError: stored.lastError,
    counts: {
      pending: outboxRows.filter((row) => row.status === "pending" || row.status === "claimed").length,
      retrying: outboxRows.filter((row) => row.status === "retry").length,
      blocked: outboxRows.filter((row) => row.status === "blocked").length,
      deadLetters: deadRows.length,
      pendingEdits: pendingRows.length,
      conflicts: conflictRows.length,
    },
    refresh: refreshRows.map((row) => ({
      entityType: row.entityType,
      state: row.status,
      requestedAt: row.requestedAt?.getTime() ?? null,
      lastSuccessAt: row.lastSuccessAt?.getTime() ?? null,
      lastError: row.lastError,
    })),
  };
});

export const requestAirtableRefresh = (
  input: RequestAirtableRefreshInput,
): Effect.Effect<
  RequestAirtableRefreshResult,
  AppError,
  AirtableSync | Authorizer | CurrentUser | Db
> => Effect.gen(function* () {
  const { db } = yield* Db;
  const sync = yield* AirtableSync;
  const eventId = yield* resolveEventId(input.idOrSlug);
  yield* authorizeCurrent(integrationsWriteAuthorization, eventId);
  const [stored] = yield* database(() => db.select().from(integrations).where(and(
    eq(integrations.eventId, eventId),
    eq(integrations.kind, "airtable"),
  )).limit(1));
  if (!stored) return yield* Effect.fail(new NotFound({ entity: "airtable integration", id: eventId }));
  const config = yield* decodeConfiguration("airtable", stored.config);
  if (config.kind !== "airtable") {
    return yield* Effect.fail(new External({ service: "integrations-configuration", detail: "Stored Airtable configuration is invalid" }));
  }
  const entityTypes = [...new Set(input.entityTypes)];
  const requestedAt = new Date();
  const statements = entityTypes.map((entityType) => db.insert(airtableRefreshState).values({
    id: `airtable_refresh_${nanoid()}`,
    eventId,
    integrationId: stored.id,
    entityType,
    status: "requested" as const,
    requestedAt,
    dueAt: requestedAt,
    attemptCount: 0,
    version: 1,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  }).onConflictDoUpdate({
    target: [
      airtableRefreshState.eventId,
      airtableRefreshState.integrationId,
      airtableRefreshState.entityType,
    ],
    set: {
      status: sql`case when ${airtableRefreshState.status} = 'claimed' then ${airtableRefreshState.status} else 'requested' end`,
      requestedAt,
      dueAt: sql`case when ${airtableRefreshState.status} = 'claimed' then ${airtableRefreshState.dueAt} else ${requestedAt.getTime()} end`,
      lastError: null,
      deadLetteredAt: null,
      version: sql`${airtableRefreshState.version} + 1`,
      updatedAt: requestedAt,
    },
  }));
  if (statements.length > 0) {
    yield* database(() => db.batch(statements as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]));
  }
  yield* sync.wake(config.baseId);
  return { requestedAt: requestedAt.getTime(), entityTypes };
});
