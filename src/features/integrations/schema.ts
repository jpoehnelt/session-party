import { AccelConfig, AirtableConfig, AirtableEntityType } from "contracts/types";
import { Schema } from "effect";

const EntityId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255));
const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200));

/**
 * Configuration deliberately distinguishes the deterministic demonstration
 * fixture from a live Accelevents event.  No credential is accepted through
 * this transport: live credentials remain Worker-secret references.
 */
export const AcceleventsConfigurationSource = Schema.Literal("fixture", "live");
export type AcceleventsConfigurationSource = typeof AcceleventsConfigurationSource.Type;

export const AcceleventsConfiguration = Schema.Struct({
  config: AccelConfig,
  source: AcceleventsConfigurationSource,
  version: Schema.Int.pipe(Schema.positive()),
});
export type AcceleventsConfiguration = typeof AcceleventsConfiguration.Type;

export const ConfigureAcceleventsInput = Schema.Struct({
  idOrSlug: EntityId,
  source: AcceleventsConfigurationSource,
  accelEventId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  eventUrl: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(255),
    Schema.pattern(/^[A-Za-z0-9_-]+$/),
  ),
  /** 0 creates a configuration; a positive value replaces that exact version. */
  expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  idempotencyKey: IdempotencyKey,
});
export type ConfigureAcceleventsInput = typeof ConfigureAcceleventsInput.Type;

export const ConfigureAcceleventsResult = Schema.Struct({
  configuration: AcceleventsConfiguration,
  changeId: EntityId,
  auditId: EntityId,
  replayed: Schema.Boolean,
});
export type ConfigureAcceleventsResult = typeof ConfigureAcceleventsResult.Type;

export const AirtableConfiguration = Schema.Struct({
  config: AirtableConfig,
  version: Schema.Int.pipe(Schema.positive()),
});
export type AirtableConfiguration = typeof AirtableConfiguration.Type;

export const ConfigureAirtableInput = Schema.Struct({
  idOrSlug: EntityId,
  config: AirtableConfig,
  /** 0 creates a configuration; a positive value replaces that exact version. */
  expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  idempotencyKey: IdempotencyKey,
});
export type ConfigureAirtableInput = typeof ConfigureAirtableInput.Type;

export const ConfigureAirtableResult = Schema.Struct({
  configuration: AirtableConfiguration,
  changeId: EntityId,
  auditId: EntityId,
  replayed: Schema.Boolean,
});
export type ConfigureAirtableResult = typeof ConfigureAirtableResult.Type;

export const AirtableSyncCounts = Schema.Struct({
  pending: Schema.Int.pipe(Schema.nonNegative()),
  retrying: Schema.Int.pipe(Schema.nonNegative()),
  blocked: Schema.Int.pipe(Schema.nonNegative()),
  deadLetters: Schema.Int.pipe(Schema.nonNegative()),
  pendingEdits: Schema.Int.pipe(Schema.nonNegative()),
  conflicts: Schema.Int.pipe(Schema.nonNegative()),
});

export const AirtableRefreshStatus = Schema.Struct({
  entityType: AirtableEntityType,
  state: Schema.Literal("idle", "requested", "claimed", "retry", "dead_letter"),
  requestedAt: Schema.NullOr(Schema.Number),
  lastSuccessAt: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
});

export const AirtableSyncStatus = Schema.Struct({
  configured: Schema.Boolean,
  configuration: Schema.NullOr(AirtableConfiguration),
  capability: Schema.Struct({
    mode: Schema.Literal("fake", "live"),
    state: Schema.Literal("ready", "unavailable"),
    reason: Schema.NullOr(Schema.String),
  }),
  lastSyncedAt: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
  counts: AirtableSyncCounts,
  refresh: Schema.Array(AirtableRefreshStatus),
});
export type AirtableSyncStatus = typeof AirtableSyncStatus.Type;

export const RequestAirtableRefreshInput = Schema.Struct({
  idOrSlug: EntityId,
  entityTypes: Schema.optionalWith(Schema.Array(AirtableEntityType), {
    default: () => ["speaker", "submission", "talk"] as const,
  }),
});
export type RequestAirtableRefreshInput = typeof RequestAirtableRefreshInput.Type;

export const RequestAirtableRefreshResult = Schema.Struct({
  requestedAt: Schema.Number,
  entityTypes: Schema.Array(AirtableEntityType),
});
export type RequestAirtableRefreshResult = typeof RequestAirtableRefreshResult.Type;
