/**
 * FROZEN CONTRACT — integrator-only after spine-v1.
 * effect/Schema definitions for every JSON column in schema.ts plus shared
 * DTO shapes. Slices validate ALL external input (REST body/query, MCP args,
 * WS messages) with these via Schema.decodeUnknown.
 */
import { Schema as S } from "effect";

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

// ---------- integrations.config ----------

export const AirtableConfig = S.Struct({
  kind: S.Literal("airtable"),
  apiKey: S.String,
  baseId: S.String,
  /** local entity -> Airtable table name; only mapped entities are mirrored. */
  tables: S.Struct({
    speakers: S.optional(S.String),
    submissions: S.optional(S.String),
    talks: S.optional(S.String),
  }),
});
export type AirtableConfig = typeof AirtableConfig.Type;

export const AccelConfig = S.Struct({
  kind: S.Literal("accelevents"),
  apiKey: S.String,
  accelEventId: S.String,
});
export type AccelConfig = typeof AccelConfig.Type;

// ---------- email merge context ----------

/**
 * Variables available in email templates as {{path}}.
 * comms slice builds this; keep flat and stable.
 */
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
