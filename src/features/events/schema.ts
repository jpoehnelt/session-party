import { EntityId } from "contracts/domain";
import { EventRole } from "contracts/types";
import { ApiScope, ApiScopes } from "contracts/principal";
import { Schema } from "effect";

const OptionalText = Schema.optional(Schema.Union(Schema.String, Schema.Null));
const OptionalTimestamp = Schema.optional(Schema.Union(Schema.Number, Schema.Null));

export const UpdateEventInput = Schema.Struct({
  expectedVersion: Schema.Int.pipe(Schema.positive()),
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

/** Event-scoped browser access. Authentication remains identity-only; these relationships are resolved per event. */
export const EventAccess = Schema.Struct({
  event: EventOutput,
  memberRole: Schema.NullOr(EventRole),
  staff: Schema.Boolean,
  speakerPortal: Schema.Boolean,
});
export type EventAccess = typeof EventAccess.Type;

const Email = Schema.String.pipe(Schema.minLength(3), Schema.maxLength(320));
const IdempotencyKey = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200));

/** An existing authenticated account assigned to this event. This is not an email invitation. */
export const EventMember = Schema.Struct({
  id: EntityId,
  userId: EntityId,
  email: Email,
  name: Schema.NullOr(Schema.String),
  role: EventRole,
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});
export type EventMember = typeof EventMember.Type;

export const ListEventMembersInput = Schema.Struct({
  eventId: EntityId,
});
export type ListEventMembersInput = typeof ListEventMembersInput.Type;

export const AddEventMemberInput = Schema.Struct({
  eventId: EntityId,
  /** Normalized server-side before looking up an already authenticated account. */
  email: Email,
  role: EventRole,
  idempotencyKey: IdempotencyKey,
});
export type AddEventMemberInput = typeof AddEventMemberInput.Type;

export const AddEventMemberOutput = Schema.Struct({
  member: EventMember,
  created: Schema.Boolean,
  idempotent: Schema.Boolean,
});
export type AddEventMemberOutput = typeof AddEventMemberOutput.Type;

export const UpdateEventMemberInput = Schema.Struct({
  eventId: EntityId,
  memberId: EntityId,
  role: EventRole,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type UpdateEventMemberInput = typeof UpdateEventMemberInput.Type;

export const UpdateEventMemberOutput = Schema.Struct({
  member: EventMember,
  idempotent: Schema.Boolean,
});
export type UpdateEventMemberOutput = typeof UpdateEventMemberOutput.Type;

export const RemoveEventMemberInput = Schema.Struct({
  eventId: EntityId,
  memberId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type RemoveEventMemberInput = typeof RemoveEventMemberInput.Type;

/** Repeating a completed delete reports deleted=false instead of leaking another event's member. */
export const RemoveEventMemberOutput = Schema.Struct({
  memberId: EntityId,
  deleted: Schema.Boolean,
  idempotent: Schema.Boolean,
});
export type RemoveEventMemberOutput = typeof RemoveEventMemberOutput.Type;

export const TeamCopyMembership = Schema.Struct({
  sourceMemberId: EntityId,
  userId: EntityId,
  email: Email,
  name: Schema.NullOr(Schema.String),
  role: EventRole,
  existingRole: Schema.NullOr(EventRole),
});
export type TeamCopyMembership = typeof TeamCopyMembership.Type;

export const PreviewTeamCopyInput = Schema.Struct({
  eventId: EntityId,
  sourceEventId: EntityId,
});
export type PreviewTeamCopyInput = typeof PreviewTeamCopyInput.Type;

export const TeamCopyPreview = Schema.Struct({
  sourceEventId: EntityId,
  sourceEventName: Schema.String,
  targetEventId: EntityId,
  targetEventName: Schema.String,
  create: Schema.Array(TeamCopyMembership),
  skip: Schema.Array(TeamCopyMembership),
});
export type TeamCopyPreview = typeof TeamCopyPreview.Type;

export const ApplyTeamCopyInput = Schema.extend(PreviewTeamCopyInput, Schema.Struct({
  idempotencyKey: IdempotencyKey,
}));
export type ApplyTeamCopyInput = typeof ApplyTeamCopyInput.Type;

export const ApplyTeamCopyOutput = Schema.Struct({
  sourceEventId: EntityId,
  targetEventId: EntityId,
  created: Schema.Array(EventMember),
  skipped: Schema.Array(TeamCopyMembership),
  createdCount: Schema.Int.pipe(Schema.nonNegative()),
  skippedCount: Schema.Int.pipe(Schema.nonNegative()),
  idempotent: Schema.Boolean,
});
export type ApplyTeamCopyOutput = typeof ApplyTeamCopyOutput.Type;

export const ReviewerInvitation = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  email: Email,
  status: Schema.Literal("pending", "accepted", "expired"),
  deliveryStatus: Schema.Literal("pending", "claimed", "dispatching", "retry", "sent", "dead_letter", "cancelled"),
  expiresAt: Schema.DateFromString,
  acceptedAt: Schema.NullOr(Schema.DateFromString),
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: Schema.DateFromString,
});
export type ReviewerInvitation = typeof ReviewerInvitation.Type;

export const ListReviewerInvitationsInput = Schema.Struct({ eventId: EntityId });
export type ListReviewerInvitationsInput = typeof ListReviewerInvitationsInput.Type;

export const CreateReviewerInvitationInput = Schema.Struct({
  eventId: EntityId,
  email: Email,
  idempotencyKey: IdempotencyKey,
  requestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
export type CreateReviewerInvitationInput = typeof CreateReviewerInvitationInput.Type;

export const CreateReviewerInvitationOutput = Schema.Struct({
  invitation: ReviewerInvitation,
  idempotent: Schema.Boolean,
});
export type CreateReviewerInvitationOutput = typeof CreateReviewerInvitationOutput.Type;

export const AcceptReviewerInvitationInput = Schema.Struct({
  token: Schema.String.pipe(Schema.minLength(32), Schema.maxLength(256)),
  idempotencyKey: IdempotencyKey,
  requestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
export type AcceptReviewerInvitationInput = typeof AcceptReviewerInvitationInput.Type;

export const AcceptReviewerInvitationOutput = Schema.Struct({
  invitationId: EntityId,
  eventId: EntityId,
  eventSlug: Schema.String.pipe(Schema.minLength(1)),
  eventName: Schema.String.pipe(Schema.minLength(1)),
  member: EventMember,
  idempotent: Schema.Boolean,
});
export type AcceptReviewerInvitationOutput = typeof AcceptReviewerInvitationOutput.Type;

export const EventApiKey = Schema.Struct({
  id: EntityId,
  name: Schema.String,
  scopes: ApiScopes,
  expiresAt: Schema.DateFromString,
  revokedAt: Schema.NullOr(Schema.DateFromString),
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: Schema.DateFromString,
});
export type EventApiKey = typeof EventApiKey.Type;

export const ListEventApiKeysInput = Schema.Struct({ eventId: EntityId });
export type ListEventApiKeysInput = typeof ListEventApiKeysInput.Type;

export const CreateEventApiKeyInput = Schema.Struct({
  eventId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  scopes: Schema.NonEmptyArray(ApiScope),
  expiresAt: Schema.Number,
});
export type CreateEventApiKeyInput = typeof CreateEventApiKeyInput.Type;

export const CreateEventApiKeyOutput = Schema.Struct({
  apiKey: EventApiKey,
  /** Returned exactly once. Subsequent reads expose metadata only. */
  secret: Schema.String,
});
export type CreateEventApiKeyOutput = typeof CreateEventApiKeyOutput.Type;

export const RevokeEventApiKeyInput = Schema.Struct({
  eventId: EntityId,
  apiKeyId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
});
export type RevokeEventApiKeyInput = typeof RevokeEventApiKeyInput.Type;
