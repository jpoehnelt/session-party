import { SpeakerLinks } from "contracts/types";
import { Schema } from "effect";

const EntityId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255));
const NullableText = Schema.NullOr(Schema.String);
const Timestamp = Schema.Int.pipe(Schema.nonNegative());
const Slug = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(80),
  Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

export const ReusableSpeakerProfile = Schema.Struct({
  id: EntityId,
  slug: Slug,
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  headshotUrl: NullableText,
  links: SpeakerLinks,
  visible: Schema.Boolean,
  version: Schema.Int.pipe(Schema.positive()),
  updatedAt: Timestamp,
});
export type ReusableSpeakerProfile = typeof ReusableSpeakerProfile.Type;

export const GetMyProfileInput = Schema.Struct({});
export const MyProfile = Schema.NullOr(ReusableSpeakerProfile);
export type MyProfile = typeof MyProfile.Type;

export const SaveMyProfileInput = Schema.Struct({
  expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  slug: Slug,
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
  title: NullableText,
  company: NullableText,
  bio: Schema.NullOr(Schema.String.pipe(Schema.maxLength(20_000))),
  headshotUrl: NullableText,
  links: SpeakerLinks,
  visible: Schema.Boolean,
});
export type SaveMyProfileInput = typeof SaveMyProfileInput.Type;

export const GetPublicProfileInput = Schema.Struct({ slug: Slug });
export type GetPublicProfileInput = typeof GetPublicProfileInput.Type;

export const PublicProfileTalk = Schema.Struct({
  id: EntityId,
  title: Schema.String,
  description: NullableText,
  track: NullableText,
  room: NullableText,
  startsAt: Timestamp,
  durationMin: Schema.Int.pipe(Schema.positive()),
});
export type PublicProfileTalk = typeof PublicProfileTalk.Type;

export const PublicProfileAppearance = Schema.Struct({
  eventId: EntityId,
  eventSlug: Schema.String,
  eventName: Schema.String,
  timezone: Schema.String,
  location: NullableText,
  startsAt: Schema.NullOr(Timestamp),
  endsAt: Schema.NullOr(Timestamp),
  talks: Schema.Array(PublicProfileTalk),
});
export type PublicProfileAppearance = typeof PublicProfileAppearance.Type;

export const PublicReusableSpeakerProfile = Schema.Struct({
  profile: ReusableSpeakerProfile,
  appearances: Schema.Array(PublicProfileAppearance),
});
export type PublicReusableSpeakerProfile = typeof PublicReusableSpeakerProfile.Type;
