import { EntityId, UnixTimestampMs } from "contracts/domain";
import { Schema } from "effect";
import { EMBED_AESTHETICS } from "./embed-design";
import { SCHEDULE_EMBED_FIELDS } from "./embed-content";

export const EmbedWidget = Schema.Literal("schedule", "speakerGallery");
export type EmbedWidget = typeof EmbedWidget.Type;

export const EmbedPreset = Schema.Literal(
  "sessions",
  "agenda",
  "itinerary",
  "speakerList",
  "speakerGallery",
);
export type EmbedPreset = typeof EmbedPreset.Type;

export const EmbedAestheticSchema = Schema.Literal(...EMBED_AESTHETICS);
export const EmbedAccent = Schema.String.pipe(Schema.pattern(/^#[0-9A-Fa-f]{6}$/));
export const EmbedFields = Schema.Array(Schema.Literal(...SCHEDULE_EMBED_FIELDS));

export const EmbedDefinition = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  eventSlug: Schema.String,
  name: Schema.String,
  widget: EmbedWidget,
  preset: EmbedPreset,
  aesthetic: EmbedAestheticSchema,
  accent: EmbedAccent,
  trackId: Schema.NullOr(EntityId),
  track: Schema.NullOr(Schema.String),
  fields: EmbedFields,
  enabled: Schema.Boolean,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  updatedAt: UnixTimestampMs,
});
export type EmbedDefinition = typeof EmbedDefinition.Type;

export const EmbedDefinitions = Schema.Array(EmbedDefinition);

const EmbedConfiguration = {
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  widget: EmbedWidget,
  preset: EmbedPreset,
  aesthetic: EmbedAestheticSchema,
  accent: EmbedAccent,
  trackId: Schema.optional(Schema.NullOr(EntityId)),
  track: Schema.NullOr(Schema.String.pipe(Schema.maxLength(100))),
  fields: EmbedFields,
  enabled: Schema.Boolean,
} as const;

export const ListEmbedsInput = Schema.Struct({ eventId: EntityId });
export type ListEmbedsInput = typeof ListEmbedsInput.Type;

export const CreateEmbedInput = Schema.Struct({
  eventId: EntityId,
  ...EmbedConfiguration,
});
export type CreateEmbedInput = typeof CreateEmbedInput.Type;

export const UpdateEmbedInput = Schema.Struct({
  eventId: EntityId,
  embedId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  ...EmbedConfiguration,
});
export type UpdateEmbedInput = typeof UpdateEmbedInput.Type;

export const PublicEmbedInput = Schema.Struct({
  eventSlug: Schema.String,
  embedId: EntityId,
});
export type PublicEmbedInput = typeof PublicEmbedInput.Type;
