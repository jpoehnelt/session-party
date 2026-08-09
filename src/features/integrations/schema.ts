import { AccelConfig } from "contracts/types";
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
