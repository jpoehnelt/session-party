/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * effect/Schema definitions for every JSON column in schema.ts plus shared
 * DTO shapes. Slices validate ALL external input (REST body/query, MCP args,
 * WS messages) with these via Schema.decodeUnknown.
 */
import { Schema as S } from "effect";
export { ApiScope, ApiScopes } from "./principal";

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

export const AnswerValue = S.Union(S.String, S.Array(S.String), S.Struct({ assetId: S.String }));
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
  accelEventId: S.String,
});
export type AccelConfig = typeof AccelConfig.Type;

export const IntegrationConfig = S.Union(AirtableConfig, AccelConfig);
export type IntegrationConfig = typeof IntegrationConfig.Type;

export const AirtableMappedValues = JsonObject;
export type AirtableMappedValues = typeof AirtableMappedValues.Type;

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