import { Schema } from "effect";

const OptionalText = Schema.optional(Schema.Union(Schema.String, Schema.Null));
const OptionalTimestamp = Schema.optional(Schema.Union(Schema.Number, Schema.Null));

export const UpdateEventInput = Schema.Struct({
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))),
  slug: Schema.optional(
    Schema.String.pipe(
      Schema.minLength(2),
      Schema.maxLength(80),
      Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    ),
  ),
  description: OptionalText,
  location: OptionalText,
  timezone: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  startsAt: OptionalTimestamp,
  endsAt: OptionalTimestamp,
  accentColor: OptionalText,
});
export type UpdateEventInput = typeof UpdateEventInput.Type;

export const EventOutput = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  timezone: Schema.String,
  startsAt: Schema.NullOr(Schema.DateFromString),
  endsAt: Schema.NullOr(Schema.DateFromString),
  bannerAssetId: Schema.NullOr(Schema.String),
  accentColor: Schema.NullOr(Schema.String),
  version: Schema.Number,
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});
export type EventOutput = typeof EventOutput.Type;
