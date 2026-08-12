/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * effect/Schema definitions for every JSON column in schema.ts plus shared
 * DTO shapes. Slices validate ALL external input (REST body/query, MCP args,
 * WS messages) with these via Schema.decodeUnknown.
 */
import { Schema as S } from "effect";
export { ApiScope, ApiScopes, InstallRole } from "./principal";

// ---------- common persisted values ----------

export const Sha256Hex = S.String.pipe(S.pattern(/^[a-f0-9]{64}$/));
export type Sha256Hex = typeof Sha256Hex.Type;

export const ExternalSecretRef = S.String.pipe(S.minLength(1), S.maxLength(255));
export type ExternalSecretRef = typeof ExternalSecretRef.Type;

export const EventRole = S.Literal("owner", "admin", "reviewer");
export type EventRole = typeof EventRole.Type;

export const JsonObject = S.Record({ key: S.String, value: S.Unknown });
export type JsonObject = typeof JsonObject.Type;

// ---------- form conditional logic (form_fields.logic) ----------

export const LogicCondition = S.Struct({
  fieldId: S.String,
  op: S.Literal("eq", "neq", "in", "not_empty"),
  /** Comparison value; array for `in`. Omitted for `not_empty`. */
  value: S.optional(S.Union(S.String, S.Array(S.String))),
});
export type LogicCondition = typeof LogicCondition.Type;

/** Show this field only when conditions pass. */
export const FieldLogic = S.Struct({
  mode: S.Literal("all", "any"),
  conditions: S.NonEmptyArray(LogicCondition),
});
export type FieldLogic = typeof FieldLogic.Type;

/** form_fields.routing: select/radio option value -> submission category. */
export const FieldRouting = S.Record({ key: S.String, value: S.String });
export type FieldRouting = typeof FieldRouting.Type;

// ---------- submission answers ----------

const AnswerText = S.String.pipe(S.maxLength(20_000));
export const AnswerValue = S.Union(
  AnswerText,
  S.Array(AnswerText).pipe(S.maxItems(100)),
  S.Struct({ assetId: S.String.pipe(S.maxLength(128)) }),
);
export type AnswerValue = typeof AnswerValue.Type;

// ---------- review rubric (review_rounds.rubric) ----------

export const Rubric = S.Struct({
  criteria: S.NonEmptyArray(
    S.Struct({ key: S.String, label: S.String, max: S.Int.pipe(S.between(1, 10)) }),
  ),
});
export type Rubric = typeof Rubric.Type;

// ---------- speaker links ----------

export const SpeakerLink = S.Struct({
  label: S.String,
  url: S.String.pipe(S.pattern(/^https?:\/\//)),
});
export type SpeakerLink = typeof SpeakerLink.Type;
export const SpeakerLinks = S.Array(SpeakerLink);
export type SpeakerLinks = typeof SpeakerLinks.Type;

// ---------- integrations.config ----------

export const AirtableEntityType = S.Literal("speaker", "submission", "talk");
export type AirtableEntityType = typeof AirtableEntityType.Type;

export const AirtableFieldAuthority = S.Literal("airtable", "d1");
export type AirtableFieldAuthority = typeof AirtableFieldAuthority.Type;

const airtableConnectorFields = {
  sessionPartyId: S.String,
  spRevision: S.String,
  spHash: S.String,
  spOrigin: S.String,
};

/**
 * Physical tbl/fld IDs are deployment configuration. Logical keys and their
 * field authority are locked by PLAN.md and are never inferred from names.
 */
export const AirtableConfig = S.Struct({
  kind: S.Literal("airtable"),
  baseId: S.String,
  origin: S.String,
  tables: S.Struct({
    speakers: S.Struct({
      tableId: S.String,
      fields: S.Struct({
        ...airtableConnectorFields,
        displayName: S.String,
        jobTitle: S.String,
        company: S.String,
        bio: S.String,
        visibility: S.String,
      }),
    }),
    submissions: S.Struct({
      tableId: S.String,
      fields: S.Struct({
        ...airtableConnectorFields,
        title: S.String,
        abstract: S.String,
        category: S.String,
        status: S.String,
        submittedAt: S.String,
        speakerLinks: S.String,
      }),
    }),
    talks: S.Struct({
      tableId: S.String,
      fields: S.Struct({
        ...airtableConnectorFields,
        title: S.String,
        description: S.String,
        track: S.String,
        room: S.String,
        startsAt: S.String,
        durationMin: S.String,
        status: S.String,
        speakerLinks: S.String,
        submissionLink: S.String,
      }),
    }),
  }),
});
export type AirtableConfig = typeof AirtableConfig.Type;

export const AccelConfig = S.Struct({
  kind: S.Literal("accelevents"),
  accelEventId: S.String.pipe(S.minLength(1), S.maxLength(255)),
  eventUrl: S.String.pipe(
    S.minLength(1),
    S.maxLength(255),
    S.pattern(/^[A-Za-z0-9_-]+$/),
  ),
});
export type AccelConfig = typeof AccelConfig.Type;

export const IntegrationConfig = S.Union(AirtableConfig, AccelConfig);
export type IntegrationConfig = typeof IntegrationConfig.Type;

export const AirtableMappedValues = JsonObject;
export type AirtableMappedValues = typeof AirtableMappedValues.Type;

// ---------- Accelevents import ----------

export const AcceleventsImportMode = S.Literal("fixture", "live");
export type AcceleventsImportMode = typeof AcceleventsImportMode.Type;

export const AcceleventsEntityType = S.Literal("speaker", "talk");
export type AcceleventsEntityType = typeof AcceleventsEntityType.Type;

export const AcceleventsSourceSpeaker = S.Struct({
  externalId: S.String.pipe(S.minLength(1)),
  displayName: S.String.pipe(S.minLength(1)),
  title: S.NullOr(S.String),
  company: S.NullOr(S.String),
  bio: S.NullOr(S.String),
});
export type AcceleventsSourceSpeaker = typeof AcceleventsSourceSpeaker.Type;

export const AcceleventsSourceTalk = S.Struct({
  externalId: S.String.pipe(S.minLength(1)),
  title: S.String.pipe(S.minLength(1)),
  description: S.NullOr(S.String),
  startsAt: S.NullOr(S.Number),
  durationMin: S.Int.pipe(S.positive()),
  status: S.Literal("draft", "confirmed", "cancelled"),
  speakerExternalIds: S.Array(S.String.pipe(S.minLength(1))),
});
export type AcceleventsSourceTalk = typeof AcceleventsSourceTalk.Type;

export const AcceleventsSnapshot = S.Struct({
  providerEventId: S.String.pipe(S.minLength(1)),
  speakers: S.Array(AcceleventsSourceSpeaker),
  talks: S.Array(AcceleventsSourceTalk),
});
export type AcceleventsSnapshot = typeof AcceleventsSnapshot.Type;

export const AcceleventsImportAction = S.Literal(
  "created",
  "updated",
  "unchanged",
  "failed",
);
export type AcceleventsImportAction = typeof AcceleventsImportAction.Type;

export const AcceleventsImportItem = S.Struct({
  order: S.Int.pipe(S.nonNegative()),
  entityType: AcceleventsEntityType,
  externalId: S.String,
  action: AcceleventsImportAction,
  localId: S.NullOr(S.String),
  errorCode: S.NullOr(S.String),
  errorDetail: S.NullOr(S.String),
});
export type AcceleventsImportItem = typeof AcceleventsImportItem.Type;

export const AcceleventsImportCounts = S.Struct({
  total: S.Int.pipe(S.nonNegative()),
  created: S.Int.pipe(S.nonNegative()),
  updated: S.Int.pipe(S.nonNegative()),
  unchanged: S.Int.pipe(S.nonNegative()),
  failed: S.Int.pipe(S.nonNegative()),
});
export type AcceleventsImportCounts = typeof AcceleventsImportCounts.Type;

export const AcceleventsImportRun = S.Struct({
  runId: S.String,
  mode: AcceleventsImportMode,
  eventId: S.String,
  integrationId: S.String,
  providerEventId: S.String,
  eventUrl: S.String,
  startedAt: S.Number,
  completedAt: S.Number,
  status: S.Literal("succeeded", "partial", "failed"),
  counts: AcceleventsImportCounts,
  errorCode: S.NullOr(S.String),
  errorDetail: S.NullOr(S.String),
  items: S.Array(AcceleventsImportItem),
});
export type AcceleventsImportRun = typeof AcceleventsImportRun.Type;

export const AcceleventsCapability = S.Struct({
  mode: S.NullOr(AcceleventsImportMode),
  state: S.Literal("ready", "unavailable"),
  reason: S.NullOr(S.String),
});
export type AcceleventsCapability = typeof AcceleventsCapability.Type;

export const AcceleventsImportStatus = S.Struct({
  configured: S.Boolean,
  config: S.NullOr(AccelConfig),
  capability: AcceleventsCapability,
  latestRun: S.NullOr(AcceleventsImportRun),
});
export type AcceleventsImportStatus = typeof AcceleventsImportStatus.Type;

export const AcceleventsIdempotencyKey = S.String.pipe(S.minLength(8), S.maxLength(200));
export type AcceleventsIdempotencyKey = typeof AcceleventsIdempotencyKey.Type;

// ---------- durable operation metadata ----------

export const ChangeAudience = S.Union(
  S.Struct({ kind: S.Literal("admins") }),
  S.Struct({ kind: S.Literal("reviewers"), reviewerUserIds: S.Array(S.String) }),
  S.Struct({ kind: S.Literal("speaker"), speakerIds: S.Array(S.String) }),
  S.Struct({ kind: S.Literal("public") }),
);
export type ChangeAudience = typeof ChangeAudience.Type;

export const ChangeAudiences = S.NonEmptyArray(ChangeAudience);
export type ChangeAudiences = typeof ChangeAudiences.Type;

export const AuditSnapshot = S.NullOr(JsonObject);
export type AuditSnapshot = typeof AuditSnapshot.Type;

export const ProviderResult = JsonObject;
export type ProviderResult = typeof ProviderResult.Type;

// ---------- email merge context ----------

/** Variables available in email templates as {{path}}. */
export interface MergeContext {
  "speaker.name": string;
  "speaker.email": string;
  "event.name": string;
  "event.location": string;
  "event.dates": string;
  "talk.title": string;
  "talk.time": string;
  "talk.room": string;
  "portal.url": string;
}

// ---------- shared DTO helpers ----------

/** Query-string pagination: decodes from strings, defaults applied. */
export const Pagination = S.Struct({
  limit: S.optionalWith(S.NumberFromString.pipe(S.int(), S.between(1, 200)), {
    default: () => 50,
  }),
  offset: S.optionalWith(S.NumberFromString.pipe(S.int(), S.nonNegative()), {
    default: () => 0,
  }),
});
export type Pagination = typeof Pagination.Type;

/** Agenda conflict computed server-side (agenda slice owns the algorithm). */
export interface Conflict {
  kind: "room_overlap" | "speaker_overlap";
  talkIds: [string, string];
  roomId?: string;
  speakerId?: string;
}

/** Per-speaker onboarding progress row (drives dashboard + portal). */
export interface SpeakerProgress {
  speakerId: string;
  displayName: string;
  headshotAssetId: string | null;
  tasksTotal: number;
  tasksDone: number;
  outstandingTaskIds: string[];
}
