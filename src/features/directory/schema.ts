import { EntityId } from "contracts/domain";
import { Schema } from "effect";

const OptionalQuery = Schema.optional(Schema.String.pipe(Schema.maxLength(120)));

export const DirectoryParticipationStatus = Schema.Literal("submitted", "accepted", "spoke");
export type DirectoryParticipationStatus = typeof DirectoryParticipationStatus.Type;

export const ListSpeakerDirectoryInput = Schema.Struct({
  query: OptionalQuery,
  eventId: Schema.optional(EntityId),
  status: Schema.optional(DirectoryParticipationStatus),
  page: Schema.optional(Schema.Int.pipe(Schema.positive())),
  pageSize: Schema.optional(Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(100))),
});
export type ListSpeakerDirectoryInput = typeof ListSpeakerDirectoryInput.Type;

export const DirectoryEvent = Schema.Struct({
  id: EntityId,
  name: Schema.String,
});
export type DirectoryEvent = typeof DirectoryEvent.Type;

export const DirectoryReusableProfile = Schema.Struct({
  id: EntityId,
  userId: EntityId,
  displayName: Schema.String,
  title: Schema.NullOr(Schema.String),
  company: Schema.NullOr(Schema.String),
  bio: Schema.NullOr(Schema.String),
  headshotUrl: Schema.NullOr(Schema.String),
  links: Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
  visible: Schema.Boolean,
  version: Schema.Int.pipe(Schema.positive()),
});
export type DirectoryReusableProfile = typeof DirectoryReusableProfile.Type;

export const DirectoryIdentityMember = Schema.Struct({
  speakerId: EntityId,
  eventId: EntityId,
  eventName: Schema.String,
  kind: Schema.Literal("claimed", "managed", "event-record"),
  userId: Schema.NullOr(EntityId),
  email: Schema.NullOr(Schema.String),
  displayName: Schema.String,
  title: Schema.NullOr(Schema.String),
  company: Schema.NullOr(Schema.String),
  bio: Schema.NullOr(Schema.String),
  headshotUrl: Schema.NullOr(Schema.String),
  links: Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
  profileReviewStatus: Schema.Literal("draft", "in_review", "changes_requested", "approved"),
  profileSourceId: Schema.NullOr(EntityId),
  profileSourceVersion: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
});
export type DirectoryIdentityMember = typeof DirectoryIdentityMember.Type;

export const DirectoryParticipation = Schema.Struct({
  eventId: EntityId,
  eventName: Schema.String,
  submitted: Schema.Boolean,
  accepted: Schema.Boolean,
  spoke: Schema.Boolean,
  submissionTitles: Schema.Array(Schema.String),
  talkTitles: Schema.Array(Schema.String),
  lastActivityAt: Schema.DateFromString,
});
export type DirectoryParticipation = typeof DirectoryParticipation.Type;

export const DirectoryContact = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  eventName: Schema.String,
  speakerId: EntityId,
  actorUserId: EntityId,
  actorName: Schema.NullOr(Schema.String),
  medium: Schema.Literal("toolEmail", "personalEmail", "text", "phone"),
  note: Schema.NullOr(Schema.String),
  contactedAt: Schema.DateFromString,
});
export type DirectoryContact = typeof DirectoryContact.Type;

export const SameNameSuggestion = Schema.Struct({
  groupKey: Schema.String,
  normalizedEmail: Schema.NullOr(Schema.String),
  displayName: Schema.String,
});
export type SameNameSuggestion = typeof SameNameSuggestion.Type;

export const SpeakerDirectoryEntry = Schema.Struct({
  groupKey: Schema.String,
  normalizedEmail: Schema.NullOr(Schema.String),
  displayName: Schema.String,
  reusableProfile: Schema.NullOr(DirectoryReusableProfile),
  members: Schema.NonEmptyArray(DirectoryIdentityMember),
  participation: Schema.NonEmptyArray(DirectoryParticipation),
  contacts: Schema.Array(DirectoryContact),
  sameNameSuggestions: Schema.Array(SameNameSuggestion),
});
export type SpeakerDirectoryEntry = typeof SpeakerDirectoryEntry.Type;

export const SpeakerDirectoryPage = Schema.Struct({
  entries: Schema.Array(SpeakerDirectoryEntry),
  events: Schema.Array(DirectoryEvent),
  page: Schema.Int.pipe(Schema.positive()),
  pageSize: Schema.Int.pipe(Schema.positive()),
  total: Schema.Int.pipe(Schema.nonNegative()),
  hasMore: Schema.Boolean,
});
export type SpeakerDirectoryPage = typeof SpeakerDirectoryPage.Type;
