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

// ---------- outbound webhooks ----------

/**
 * A kind is either the wildcard or a dotted event-type prefix such as
 * "review" or "review.decision". Matching is prefix-per-segment, so
 * "review" subscribes to every review.* change without also matching a
 * hypothetical "reviewers.*" family.
 */
export const WebhookKind = Schema.String.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^(\*|[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)*)$/),
);
export const WebhookKinds = Schema.NonEmptyArray(WebhookKind).pipe(Schema.maxItems(20));
export const WebhookEndpointStatus = Schema.Literal("active", "paused");
export type WebhookEndpointStatus = typeof WebhookEndpointStatus.Type;

export const WebhookEndpointView = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  kinds: WebhookKinds,
  status: WebhookEndpointStatus,
  cursorSequence: Schema.Number,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type WebhookEndpointView = typeof WebhookEndpointView.Type;

export const CreateWebhookInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
  url: Schema.String.pipe(Schema.minLength(12), Schema.maxLength(2_048)),
  description: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(500)))),
  kinds: WebhookKinds,
  idempotencyKey: IdempotencyKey,
});
export type CreateWebhookInput = typeof CreateWebhookInput.Type;

export const CreateWebhookResult = Schema.Struct({
  webhook: WebhookEndpointView,
  /** Returned once at creation and on rotation; blank in replayed responses. */
  signingSecret: Schema.String,
  replayed: Schema.Boolean,
});
export type CreateWebhookResult = typeof CreateWebhookResult.Type;

export const ListWebhooksInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
});
export type ListWebhooksInput = typeof ListWebhooksInput.Type;

export const ListWebhooksResult = Schema.Struct({
  eventId: EntityId,
  webhooks: Schema.Array(Schema.Struct({
    ...WebhookEndpointView.fields,
    deadLetterCount: Schema.Number,
    pendingCount: Schema.Number,
    lastDeliveredAt: Schema.NullOr(Schema.Number),
  })),
});
export type ListWebhooksResult = typeof ListWebhooksResult.Type;

export const UpdateWebhookInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
  webhookId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  url: Schema.optional(Schema.String.pipe(Schema.minLength(12), Schema.maxLength(2_048))),
  description: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(500)))),
  kinds: Schema.optional(WebhookKinds),
  status: Schema.optional(WebhookEndpointStatus),
  rotateSecret: Schema.optional(Schema.Boolean),
  idempotencyKey: IdempotencyKey,
});
export type UpdateWebhookInput = typeof UpdateWebhookInput.Type;

export const UpdateWebhookResult = Schema.Struct({
  webhook: WebhookEndpointView,
  /** Present only when the secret was rotated in this call. */
  signingSecret: Schema.NullOr(Schema.String),
  replayed: Schema.Boolean,
});
export type UpdateWebhookResult = typeof UpdateWebhookResult.Type;

export const DeleteWebhookInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
  webhookId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type DeleteWebhookInput = typeof DeleteWebhookInput.Type;

export const DeleteWebhookResult = Schema.Struct({
  webhookId: EntityId,
  deleted: Schema.Literal(true),
  replayed: Schema.Boolean,
});
export type DeleteWebhookResult = typeof DeleteWebhookResult.Type;

export const WebhookDeliveryStatus = Schema.Literal("pending", "retry", "delivered", "dead_letter");
export type WebhookDeliveryStatus = typeof WebhookDeliveryStatus.Type;

export const ListWebhookDeliveriesInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
  webhookId: EntityId,
  page: Schema.optional(Schema.Int.pipe(Schema.positive())),
  pageSize: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))),
});
export type ListWebhookDeliveriesInput = typeof ListWebhookDeliveriesInput.Type;

export const ListWebhookDeliveriesResult = Schema.Struct({
  eventId: EntityId,
  webhookId: EntityId,
  page: Schema.Int.pipe(Schema.positive()),
  pageSize: Schema.Int.pipe(Schema.positive()),
  hasMore: Schema.Boolean,
  deliveries: Schema.Array(Schema.Struct({
    id: EntityId,
    changeSequence: Schema.Number,
    eventType: Schema.String,
    status: WebhookDeliveryStatus,
    attemptCount: Schema.Number,
    maxAttempts: Schema.Number,
    availableAt: Schema.Number,
    responseStatus: Schema.NullOr(Schema.Number),
    lastError: Schema.NullOr(Schema.String),
    deliveredAt: Schema.NullOr(Schema.Number),
    deadLetteredAt: Schema.NullOr(Schema.Number),
    createdAt: Schema.Number,
    canRedeliver: Schema.Boolean,
  })),
});
export type ListWebhookDeliveriesResult = typeof ListWebhookDeliveriesResult.Type;

export const RedeliverWebhookInput = Schema.Struct({
  idOrSlug: Schema.String.pipe(Schema.minLength(1)),
  deliveryId: EntityId,
  idempotencyKey: IdempotencyKey,
});
export type RedeliverWebhookInput = typeof RedeliverWebhookInput.Type;

export const RedeliverWebhookResult = Schema.Struct({
  deliveryId: EntityId,
  status: Schema.Literal("pending"),
  replayed: Schema.Boolean,
});
export type RedeliverWebhookResult = typeof RedeliverWebhookResult.Type;
