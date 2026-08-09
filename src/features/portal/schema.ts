import { EntityId, UnixTimestampMs } from "contracts/domain";
import { SpeakerLink } from "contracts/types";
import { Schema } from "effect";

const NullableText = Schema.Union(Schema.String, Schema.Null);
const PositiveVersion = Schema.Int.pipe(Schema.positive());
const ExpectedVersion = Schema.Int.pipe(Schema.nonNegative());
const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(200));
const EventSlug = Schema.String.pipe(
  Schema.minLength(2),
  Schema.maxLength(80),
  Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

export const PortalAssetPurpose = Schema.Literal("headshot", "slides", "supportingDocument");
export type PortalAssetPurpose = typeof PortalAssetPurpose.Type;

export const PortalAsset = Schema.Struct({
  id: EntityId,
  filename: Schema.String,
  contentType: Schema.String,
  size: Schema.Int.pipe(Schema.nonNegative()),
  version: PositiveVersion,
  href: Schema.String,
});
export type PortalAsset = typeof PortalAsset.Type;

export const PortalProfile = Schema.Struct({
  id: EntityId,
  displayName: Schema.String,
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  links: Schema.Array(SpeakerLink),
  headshot: Schema.NullOr(PortalAsset),
  version: PositiveVersion,
  pendingSyncFields: Schema.Array(Schema.Literal("displayName", "title", "company", "bio")),
});
export type PortalProfile = typeof PortalProfile.Type;

export const PortalCoSpeaker = Schema.Struct({
  id: EntityId,
  displayName: Schema.String,
  isPrimary: Schema.Boolean,
});

export const PortalTalk = Schema.Struct({
  id: EntityId,
  title: Schema.String,
  description: NullableText,
  trackName: NullableText,
  roomName: NullableText,
  startsAt: Schema.NullOr(UnixTimestampMs),
  durationMin: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("draft", "confirmed", "cancelled"),
  version: PositiveVersion,
});

export const PortalSubmission = Schema.Struct({
  id: EntityId,
  title: Schema.String,
  category: NullableText,
  acceptedAt: UnixTimestampMs,
  version: PositiveVersion,
  coSpeakers: Schema.Array(PortalCoSpeaker),
  talks: Schema.Array(PortalTalk),
});
export type PortalSubmission = typeof PortalSubmission.Type;

export const PortalTaskCompletion = Schema.Struct({
  id: EntityId,
  completedAt: UnixTimestampMs,
  version: PositiveVersion,
  asset: Schema.NullOr(PortalAsset),
  assetPurpose: Schema.NullOr(PortalAssetPurpose),
});

export const PortalTask = Schema.Struct({
  id: EntityId,
  name: Schema.String,
  description: NullableText,
  kind: Schema.Literal("profile", "upload", "form", "link", "confirm"),
  formId: NullableText,
  formPath: NullableText,
  dueAt: Schema.NullOr(UnixTimestampMs),
  order: Schema.Int,
  version: PositiveVersion,
  completion: Schema.NullOr(PortalTaskCompletion),
  prerequisite: Schema.Struct({
    satisfied: Schema.Boolean,
    message: NullableText,
  }),
});
export type PortalTask = typeof PortalTask.Type;

export const PortalEmbed = Schema.Struct({
  src: Schema.String,
  title: Schema.String,
});

export const PortalPage = Schema.Struct({
  id: EntityId,
  slug: Schema.String,
  title: Schema.String,
  body: NullableText,
  embed: Schema.NullOr(PortalEmbed),
  order: Schema.Int,
  version: PositiveVersion,
});
export type PortalPage = typeof PortalPage.Type;

export const PortalSnapshot = Schema.Struct({
  event: Schema.Struct({
    id: EntityId,
    slug: Schema.String,
    name: Schema.String,
    timezone: Schema.String,
    startsAt: Schema.NullOr(UnixTimestampMs),
    endsAt: Schema.NullOr(UnixTimestampMs),
    location: NullableText,
  }),
  profile: PortalProfile,
  submissions: Schema.Array(PortalSubmission),
  tasks: Schema.Array(PortalTask),
  pages: Schema.Array(PortalPage),
  progress: Schema.Struct({
    completed: Schema.Int.pipe(Schema.nonNegative()),
    total: Schema.Int.pipe(Schema.nonNegative()),
  }),
});
export type PortalSnapshot = typeof PortalSnapshot.Type;

export const PortalMutationResult = Schema.Struct({
  eventSlug: Schema.String,
  speakerId: EntityId,
  profileVersion: PositiveVersion,
  taskId: Schema.NullOr(EntityId),
  taskCompletionVersion: Schema.NullOr(PositiveVersion),
  assetId: Schema.NullOr(EntityId),
  idempotent: Schema.Boolean,
});
export type PortalMutationResult = typeof PortalMutationResult.Type;

export const GetPortalInput = Schema.Struct({ eventSlug: EventSlug });
export type GetPortalInput = typeof GetPortalInput.Type;

export const UpdatePortalProfileInput = Schema.Struct({
  eventSlug: EventSlug,
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(160), Schema.pattern(/\S/)),
  title: Schema.optional(NullableText),
  company: Schema.optional(NullableText),
  bio: Schema.optional(NullableText),
  links: Schema.optional(Schema.Array(SpeakerLink).pipe(Schema.maxItems(12))),
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type UpdatePortalProfileInput = typeof UpdatePortalProfileInput.Type;

export const CompletePortalTaskInput = Schema.Struct({
  eventSlug: EventSlug,
  taskId: EntityId,
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type CompletePortalTaskInput = typeof CompletePortalTaskInput.Type;

export const UploadPortalAssetInput = Schema.Struct({
  eventSlug: EventSlug,
  taskId: Schema.optional(EntityId),
  purpose: PortalAssetPurpose,
  filename: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(240), Schema.pattern(/\S/)),
  contentType: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  contentBase64: Schema.String.pipe(Schema.minLength(4), Schema.pattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
  expectedVersion: ExpectedVersion,
  idempotencyKey: IdempotencyKey,
});
export type UploadPortalAssetInput = typeof UploadPortalAssetInput.Type;

export const GetPortalAssetInput = Schema.Struct({
  eventSlug: EventSlug,
  assetId: EntityId,
});
export type GetPortalAssetInput = typeof GetPortalAssetInput.Type;

export const PortalAssetContent = Schema.Struct({
  filename: Schema.String,
  contentType: Schema.String,
  contentBase64: Schema.String,
});
export type PortalAssetContent = typeof PortalAssetContent.Type;
