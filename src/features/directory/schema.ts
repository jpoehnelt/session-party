import { EntityId } from "contracts/domain";
import { Schema } from "effect";

const OptionalQuery = Schema.optional(Schema.String.pipe(Schema.maxLength(120)));
const IdempotencyKey = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255));

export const DirectoryParticipationStatus = Schema.Literal("submitted", "accepted", "spoke");
export type DirectoryParticipationStatus = typeof DirectoryParticipationStatus.Type;

export const ListSpeakerDirectoryInput = Schema.Struct({
  query: OptionalQuery,
  eventId: Schema.optional(EntityId),
  status: Schema.optional(DirectoryParticipationStatus),
  page: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.positive())),
  pageSize: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100))),
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
  version: Schema.Int.pipe(Schema.positive()),
  updatedAt: Schema.DateFromString,
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

export const ReturningSpeakerProfileCopy = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("reusable-profile"),
    sourceId: EntityId,
    sourceVersion: Schema.Int.pipe(Schema.positive()),
    displayName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("event-profile"),
    sourceId: EntityId,
    sourceVersion: Schema.Int.pipe(Schema.positive()),
    displayName: Schema.String,
  }),
);
export type ReturningSpeakerProfileCopy = typeof ReturningSpeakerProfileCopy.Type;

export const ReturningSpeakerInvitePlan = Schema.Struct({
  eventId: EntityId,
  eventName: Schema.String,
  groupKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(320)),
  normalizedEmail: Schema.NullOr(Schema.String),
  action: Schema.Literal("create-managed-speaker", "link-existing-user", "conflict"),
  linkedUserId: Schema.NullOr(EntityId),
  profileCopy: Schema.NullOr(ReturningSpeakerProfileCopy),
  conflictReason: Schema.NullOr(Schema.Literal(
    "missing-email",
    "already-in-event",
    "profile-fields-owned-by-airtable",
  )),
});
export type ReturningSpeakerInvitePlan = typeof ReturningSpeakerInvitePlan.Type;

export const PreviewReturningSpeakerInviteInput = Schema.Struct({
  eventId: EntityId,
  groupKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(320)),
});
export type PreviewReturningSpeakerInviteInput = typeof PreviewReturningSpeakerInviteInput.Type;

export const ApplyReturningSpeakerInviteInput = Schema.Struct({
  eventId: EntityId,
  groupKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(320)),
  expectedAction: Schema.Literal("create-managed-speaker", "link-existing-user"),
  expectedSourceId: EntityId,
  expectedSourceVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type ApplyReturningSpeakerInviteInput = typeof ApplyReturningSpeakerInviteInput.Type;

export const ApplyReturningSpeakerInviteOutput = Schema.Struct({
  eventId: EntityId,
  speakerId: EntityId,
  action: Schema.Literal("create-managed-speaker", "link-existing-user"),
  linkedUserId: Schema.NullOr(EntityId),
  profileCopy: ReturningSpeakerProfileCopy,
  reviewStatus: Schema.Literal("in_review"),
  emailQueued: Schema.Literal(false),
  idempotent: Schema.Boolean,
});
export type ApplyReturningSpeakerInviteOutput = typeof ApplyReturningSpeakerInviteOutput.Type;
