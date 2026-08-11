import { SpeakerLinks } from "contracts/types";
import { Schema } from "effect";

const EntityId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255));
const NonEmptyText = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500));
const NullableText = Schema.NullOr(Schema.String);
const Timestamp = Schema.Int.pipe(Schema.nonNegative());
const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const IdempotencyKey = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255));
const VersionFromZero = Schema.Int.pipe(Schema.nonNegative());
export const PortalProfileSyncField = Schema.Literal("displayName", "title", "company", "bio");
export type PortalProfileSyncField = typeof PortalProfileSyncField.Type;

export const PortalEventInput = Schema.Struct({ eventId: EntityId });
export type PortalEventInput = typeof PortalEventInput.Type;

export const ClaimSpeakerInput = Schema.Struct({
  eventId: EntityId,
  idempotencyKey: IdempotencyKey,
});
export type ClaimSpeakerInput = typeof ClaimSpeakerInput.Type;

export const ClaimSpeakerOutput = Schema.Struct({
  eventId: EntityId,
  speakerId: EntityId,
  acceptanceEventId: Schema.NullOr(EntityId),
  provisioningId: Schema.NullOr(EntityId),
  speakerVersion: Schema.Int.pipe(Schema.positive()),
  provisioningVersion: VersionFromZero,
  provisioningStatus: Schema.Literal("claimed", "provisioned"),
});
export type ClaimSpeakerOutput = typeof ClaimSpeakerOutput.Type;

export const PublicSpeakersInput = Schema.Struct({ eventSlug: EntityId });
export type PublicSpeakersInput = typeof PublicSpeakersInput.Type;

export const PortalEvent = Schema.Struct({
  id: EntityId,
  slug: EntityId,
  name: Schema.String,
  description: NullableText,
  location: NullableText,
  timezone: Schema.String,
  startsAt: Schema.NullOr(Timestamp),
  endsAt: Schema.NullOr(Timestamp),
  bannerAssetId: Schema.NullOr(EntityId),
  accentColor: NullableText,
});
export type PortalEvent = typeof PortalEvent.Type;

export const PortalTaskKind = Schema.Literal("profile", "upload", "form", "link", "confirm");
export type PortalTaskKind = typeof PortalTaskKind.Type;

export const PortalTaskDefinition = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  name: Schema.String,
  description: NullableText,
  kind: PortalTaskKind,
  formId: Schema.NullOr(EntityId),
  dueAt: Schema.NullOr(Timestamp),
  order: Schema.Int,
  targetMode: Schema.Literal("all", "selected"),
  speakerIds: Schema.Array(EntityId),
  version: Schema.Int.pipe(Schema.positive()),
});
export type PortalTaskDefinition = typeof PortalTaskDefinition.Type;

export const PortalTask = Schema.extend(
  PortalTaskDefinition,
  Schema.Struct({
    completed: Schema.Boolean,
    completedAt: Schema.NullOr(Timestamp),
    completionData: Schema.NullOr(JsonObject),
    completionVersion: VersionFromZero,
    prerequisite: Schema.Struct({
      satisfied: Schema.Boolean,
      message: Schema.NullOr(Schema.String),
    }),
  }),
);
export type PortalTask = typeof PortalTask.Type;

export const PortalTaskDefinitions = Schema.Array(PortalTaskDefinition);
export type PortalTaskDefinitions = typeof PortalTaskDefinitions.Type;

export const PortalResource = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  slug: EntityId,
  title: Schema.String,
  body: NullableText,
  embedUrl: NullableText,
  audience: Schema.Literal("speakers", "public"),
  order: Schema.Int,
  version: Schema.Int.pipe(Schema.positive()),
});
export type PortalResource = typeof PortalResource.Type;

export const PortalResources = Schema.Array(PortalResource);
export type PortalResources = typeof PortalResources.Type;

export const PortalAsset = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  filename: Schema.String,
  contentType: Schema.String,
  size: Schema.Int.pipe(Schema.nonNegative()),
  purpose: Schema.Literal("headshot", "slides", "document"),
  version: Schema.Int.pipe(Schema.positive()),
});
export type PortalAsset = typeof PortalAsset.Type;

export const SpeakerProfile = Schema.Struct({
  id: EntityId,
  eventId: EntityId,
  displayName: Schema.String,
  contactEmail: NullableText,
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  workflowStatus: NonEmptyText,
  headshotAssetId: Schema.NullOr(EntityId),
  headshotUrl: Schema.optionalWith(NullableText, { default: () => null }),
  links: SpeakerLinks,
  visible: Schema.Boolean,
  profileSourceId: Schema.NullOr(EntityId),
  profileSourceVersion: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  profileReviewStatus: Schema.Literal("draft", "in_review", "changes_requested", "approved"),
  profileReviewNote: NullableText,
  profileSubmittedAt: Schema.NullOr(Timestamp),
  profileReviewedAt: Schema.NullOr(Timestamp),
  version: Schema.Int.pipe(Schema.positive()),
  pendingSyncFields: Schema.Array(PortalProfileSyncField),
});
export type SpeakerProfile = typeof SpeakerProfile.Type;

export const SpeakerContactMedium = Schema.Literal("toolEmail", "personalEmail", "text", "phone");
export type SpeakerContactMedium = typeof SpeakerContactMedium.Type;

export const SpeakerContact = Schema.Struct({
  id: EntityId,
  medium: SpeakerContactMedium,
  note: NullableText,
  contactedAt: Timestamp,
});
export type SpeakerContact = typeof SpeakerContact.Type;

export const AcceptedSubmission = Schema.Struct({
  id: EntityId,
  title: Schema.String,
  category: NullableText,
  version: Schema.Int.pipe(Schema.positive()),
});
export type AcceptedSubmission = typeof AcceptedSubmission.Type;

export const SpeakerSession = Schema.Struct({
  id: EntityId,
  title: NonEmptyText,
  startsAt: Schema.NullOr(Timestamp),
  durationMin: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("draft", "confirmed", "cancelled"),
});
export type SpeakerSession = typeof SpeakerSession.Type;

export const ReadinessSummary = Schema.Struct({
  tasksTotal: Schema.Int.pipe(Schema.nonNegative()),
  tasksDone: Schema.Int.pipe(Schema.nonNegative()),
  outstandingTaskIds: Schema.Array(EntityId),
  nextTaskId: Schema.NullOr(EntityId),
  state: Schema.Literal("not_started", "in_progress", "ready"),
  missingItems: Schema.Array(Schema.Struct({
    id: EntityId,
    name: Schema.String,
    kind: PortalTaskKind,
    dueAt: Schema.NullOr(Timestamp),
    overdue: Schema.Boolean,
    blocker: Schema.String,
    recommendedAction: Schema.String,
  })),
  overdueCount: Schema.Int.pipe(Schema.nonNegative()),
  clearestBlocker: Schema.NullOr(Schema.String),
  recommendedNextAction: Schema.NullOr(Schema.String),
});
export type ReadinessSummary = typeof ReadinessSummary.Type;

export const PortalSnapshot = Schema.Struct({
  event: PortalEvent,
  speaker: SpeakerProfile,
  submission: Schema.NullOr(AcceptedSubmission),
  provisioningStatus: Schema.Literal("provisioned"),
  tasks: Schema.Array(PortalTask),
  resources: Schema.Array(PortalResource),
  assets: Schema.Array(PortalAsset),
  readiness: ReadinessSummary,
});
export type PortalSnapshot = typeof PortalSnapshot.Type;

export const SpeakerDirectoryItem = Schema.Struct({
  speaker: SpeakerProfile,
  submission: Schema.NullOr(AcceptedSubmission),
  source: Schema.Literal("accepted", "manual"),
  acceptanceEventId: Schema.NullOr(EntityId),
  provisioningId: Schema.NullOr(EntityId),
  provisioningVersion: VersionFromZero,
  provisioningStatus: Schema.Literal("manual", "pending", "claimed", "provisioned", "retry", "failed", "revoked"),
  provisionedAt: Schema.NullOr(Timestamp),
  sessions: Schema.Array(SpeakerSession),
  readiness: ReadinessSummary,
  latestContact: Schema.NullOr(SpeakerContact),
});
export type SpeakerDirectoryItem = typeof SpeakerDirectoryItem.Type;

export const SpeakerDirectory = Schema.Struct({
  event: PortalEvent,
  speakers: Schema.Array(SpeakerDirectoryItem),
});
export type SpeakerDirectory = typeof SpeakerDirectory.Type;

export const PortalDashboard = Schema.Struct({
  event: PortalEvent,
  speakers: Schema.Array(SpeakerDirectoryItem),
  totals: Schema.Struct({
    speakers: Schema.Int.pipe(Schema.nonNegative()),
    ready: Schema.Int.pipe(Schema.nonNegative()),
    needsAttention: Schema.Int.pipe(Schema.nonNegative()),
    overdue: Schema.Int.pipe(Schema.nonNegative()),
    tasksDone: Schema.Int.pipe(Schema.nonNegative()),
    tasksTotal: Schema.Int.pipe(Schema.nonNegative()),
  }),
});
export type PortalDashboard = typeof PortalDashboard.Type;

export const UpdateProfileInput = Schema.Struct({
  eventId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
  displayName: NonEmptyText,
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  links: SpeakerLinks,
});
export type UpdateProfileInput = typeof UpdateProfileInput.Type;

export const ImportReusableProfileInput = Schema.Struct({
  eventId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
});
export type ImportReusableProfileInput = typeof ImportReusableProfileInput.Type;

export const SubmitProfileReviewInput = Schema.Struct({
  eventId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
});
export type SubmitProfileReviewInput = typeof SubmitProfileReviewInput.Type;

export const ReviewSpeakerProfileInput = Schema.Struct({
  eventId: EntityId,
  speakerId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  decision: Schema.Literal("approved", "changes_requested"),
  note: NullableText,
});
export type ReviewSpeakerProfileInput = typeof ReviewSpeakerProfileInput.Type;

export const SetTaskCompletionInput = Schema.Struct({
  eventId: EntityId,
  taskId: EntityId,
  completed: Schema.Boolean,
  data: Schema.optional(JsonObject),
  idempotencyKey: IdempotencyKey,
});
export type SetTaskCompletionInput = typeof SetTaskCompletionInput.Type;

export const UploadPortalAssetInput = Schema.Struct({
  eventId: EntityId,
  taskId: Schema.optional(EntityId),
  purpose: Schema.Literal("headshot", "slides", "document"),
  filename: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  contentType: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  contentBase64: Schema.String.pipe(Schema.minLength(1), Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/)),
  expectedVersion: VersionFromZero,
  idempotencyKey: IdempotencyKey,
});
export type UploadPortalAssetInput = typeof UploadPortalAssetInput.Type;

export const UploadPortalAssetOutput = Schema.Struct({
  asset: PortalAsset,
  task: Schema.NullOr(PortalTask),
  speaker: SpeakerProfile,
  readiness: ReadinessSummary,
});
export type UploadPortalAssetOutput = typeof UploadPortalAssetOutput.Type;

export const CreateTaskInput = Schema.Struct({
  eventId: EntityId,
  name: NonEmptyText,
  description: NullableText,
  kind: PortalTaskKind,
  formId: Schema.NullOr(EntityId),
  dueAt: Schema.NullOr(Timestamp),
  order: Schema.Int,
  speakerIds: Schema.optional(Schema.Array(EntityId)),
});
export type CreateTaskInput = typeof CreateTaskInput.Type;

export const UpdateTaskInput = Schema.Struct({
  eventId: EntityId,
  taskId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  name: NonEmptyText,
  description: NullableText,
  kind: PortalTaskKind,
  formId: Schema.NullOr(EntityId),
  dueAt: Schema.NullOr(Timestamp),
  order: Schema.Int,
  speakerIds: Schema.optional(Schema.Array(EntityId)),
});
export type UpdateTaskInput = typeof UpdateTaskInput.Type;

export const DeleteTaskInput = Schema.Struct({
  eventId: EntityId,
  taskId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
});
export type DeleteTaskInput = typeof DeleteTaskInput.Type;

export const CreateResourceInput = Schema.Struct({
  eventId: EntityId,
  slug: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100), Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  title: NonEmptyText,
  body: NullableText,
  embedUrl: NullableText,
  audience: Schema.Literal("speakers", "public"),
  order: Schema.Int,
});
export type CreateResourceInput = typeof CreateResourceInput.Type;

export const UpdateResourceInput = Schema.Struct({
  eventId: EntityId,
  resourceId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  slug: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100), Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  title: NonEmptyText,
  body: NullableText,
  embedUrl: NullableText,
  audience: Schema.Literal("speakers", "public"),
  order: Schema.Int,
});
export type UpdateResourceInput = typeof UpdateResourceInput.Type;

export const DeleteResourceInput = Schema.Struct({
  eventId: EntityId,
  resourceId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
});
export type DeleteResourceInput = typeof DeleteResourceInput.Type;

export const ProvisionSpeakerInput = Schema.Struct({
  eventId: EntityId,
  speakerId: EntityId,
  provisioningId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
});
export type ProvisionSpeakerInput = typeof ProvisionSpeakerInput.Type;

export const UpdateSpeakerPublicationInput = Schema.Struct({
  eventId: EntityId,
  speakerId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  visible: Schema.Boolean,
});
export type UpdateSpeakerPublicationInput = typeof UpdateSpeakerPublicationInput.Type;

export const CreateManagedSpeakerInput = Schema.Struct({
  eventId: EntityId,
  displayName: NonEmptyText,
  contactEmail: Schema.String.pipe(Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  workflowStatus: NonEmptyText,
  visible: Schema.Boolean,
  idempotencyKey: IdempotencyKey,
});
export type CreateManagedSpeakerInput = typeof CreateManagedSpeakerInput.Type;

export const UpdateManagedSpeakerInput = Schema.Struct({
  eventId: EntityId,
  displayName: NonEmptyText,
  contactEmail: Schema.String.pipe(Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  workflowStatus: NonEmptyText,
  visible: Schema.Boolean,
  speakerId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
});
export type UpdateManagedSpeakerInput = typeof UpdateManagedSpeakerInput.Type;

export const UploadManagedSpeakerHeadshotInput = Schema.Struct({
  eventId: EntityId,
  speakerId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  filename: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  contentType: Schema.Literal("image/jpeg", "image/png", "image/webp"),
  contentBase64: Schema.String.pipe(Schema.minLength(1), Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/)),
  idempotencyKey: IdempotencyKey,
});
export type UploadManagedSpeakerHeadshotInput = typeof UploadManagedSpeakerHeadshotInput.Type;

export const ImportSpeakersCsvInput = Schema.Struct({
  eventId: EntityId,
  csv: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000_000)),
  idempotencyKey: IdempotencyKey,
});
export type ImportSpeakersCsvInput = typeof ImportSpeakersCsvInput.Type;

export const ImportSpeakersCsvOutput = Schema.Struct({
  createdCount: Schema.Int.pipe(Schema.nonNegative()),
  updatedCount: Schema.Int.pipe(Schema.nonNegative()),
  skippedCount: Schema.Int.pipe(Schema.nonNegative()),
  speakers: Schema.Array(SpeakerProfile),
  idempotent: Schema.Boolean,
});
export type ImportSpeakersCsvOutput = typeof ImportSpeakersCsvOutput.Type;

export const SendSpeakerMessagesInput = Schema.Struct({
  eventId: EntityId,
  speakerIds: Schema.NonEmptyArray(EntityId).pipe(Schema.maxItems(200)),
  kind: Schema.Literal("invite", "reminder"),
  idempotencyKey: IdempotencyKey,
});
export type SendSpeakerMessagesInput = typeof SendSpeakerMessagesInput.Type;

export const SendSpeakerMessagesOutput = Schema.Struct({
  queuedCount: Schema.Int.pipe(Schema.nonNegative()),
  skippedCount: Schema.Int.pipe(Schema.nonNegative()),
  idempotent: Schema.Boolean,
});
export type SendSpeakerMessagesOutput = typeof SendSpeakerMessagesOutput.Type;

export const ContentComment = Schema.Struct({
  id: EntityId,
  authorName: NonEmptyText,
  body: NonEmptyText,
  createdAt: Timestamp,
});
export type ContentComment = typeof ContentComment.Type;

export const ContentAsset = Schema.Struct({
  ...PortalAsset.fields,
  speakerId: EntityId,
  speakerName: NonEmptyText,
  speakerVersion: Schema.Int.pipe(Schema.positive()),
  sessionTitles: Schema.Array(NonEmptyText),
  sessionLinks: Schema.optional(Schema.Array(Schema.Struct({
    id: EntityId,
    title: NonEmptyText,
  }))),
  versionCount: Schema.Int.pipe(Schema.positive()),
  current: Schema.Boolean,
  supersedesAssetId: Schema.NullOr(EntityId),
  restoredFromAssetId: Schema.NullOr(EntityId),
  uploadedAt: Timestamp,
  comments: Schema.Array(ContentComment),
});
export type ContentAsset = typeof ContentAsset.Type;

export const ContentLibrary = Schema.Struct({
  event: PortalEvent,
  assets: Schema.Array(ContentAsset),
});
export type ContentLibrary = typeof ContentLibrary.Type;

export const AddContentCommentInput = Schema.Struct({
  eventId: EntityId,
  assetId: EntityId,
  body: NonEmptyText,
  idempotencyKey: IdempotencyKey,
});
export type AddContentCommentInput = typeof AddContentCommentInput.Type;

export const RestoreContentVersionInput = Schema.Struct({
  eventId: EntityId,
  assetId: EntityId,
  expectedCurrentAssetId: EntityId,
  expectedCurrentVersion: Schema.Int.pipe(Schema.positive()),
  expectedSpeakerVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
});
export type RestoreContentVersionInput = typeof RestoreContentVersionInput.Type;

export const DownloadContentInput = Schema.Struct({ eventId: EntityId, assetId: EntityId });
export type DownloadContentInput = typeof DownloadContentInput.Type;

export const DownloadContentOutput = Schema.Struct({
  asset: ContentAsset,
  contentBase64: Schema.String,
});
export type DownloadContentOutput = typeof DownloadContentOutput.Type;

export const DeletePortalEntityOutput = Schema.Struct({ id: EntityId });
export type DeletePortalEntityOutput = typeof DeletePortalEntityOutput.Type;

export const ManageSpeakerOnboardingInput = Schema.Struct({
  eventId: EntityId,
  action: Schema.Union(
    Schema.Struct({
      type: Schema.Literal("createTask"),
      name: NonEmptyText,
      description: NullableText,
      kind: PortalTaskKind,
      formId: Schema.NullOr(EntityId),
      dueAt: Schema.NullOr(Timestamp),
      order: Schema.Int,
      speakerIds: Schema.optional(Schema.Array(EntityId)),
    }),
    Schema.Struct({
      type: Schema.Literal("updateTask"),
      taskId: EntityId,
      expectedVersion: Schema.Int.pipe(Schema.positive()),
      name: NonEmptyText,
      description: NullableText,
      kind: PortalTaskKind,
      formId: Schema.NullOr(EntityId),
      dueAt: Schema.NullOr(Timestamp),
      order: Schema.Int,
      speakerIds: Schema.optional(Schema.Array(EntityId)),
    }),
    Schema.Struct({
      type: Schema.Literal("deleteTask"),
      taskId: EntityId,
      expectedVersion: Schema.Int.pipe(Schema.positive()),
    }),
    Schema.Struct({
      type: Schema.Literal("provisionSpeaker"),
      speakerId: EntityId,
      provisioningId: EntityId,
      expectedVersion: Schema.Int.pipe(Schema.positive()),
    }),
    Schema.Struct({
      type: Schema.Literal("setSpeakerPublication"),
      speakerId: EntityId,
      expectedVersion: Schema.Int.pipe(Schema.positive()),
      visible: Schema.Boolean,
    }),
  ),
});
export type ManageSpeakerOnboardingInput = typeof ManageSpeakerOnboardingInput.Type;

export const ManageSpeakerOnboardingOutput = Schema.Union(
  Schema.Struct({ action: Schema.Literal("createTask"), result: PortalTaskDefinition }),
  Schema.Struct({ action: Schema.Literal("updateTask"), result: PortalTaskDefinition }),
  Schema.Struct({ action: Schema.Literal("deleteTask"), result: DeletePortalEntityOutput }),
  Schema.Struct({ action: Schema.Literal("provisionSpeaker"), result: SpeakerDirectoryItem }),
  Schema.Struct({ action: Schema.Literal("setSpeakerPublication"), result: SpeakerProfile }),
);
export type ManageSpeakerOnboardingOutput = typeof ManageSpeakerOnboardingOutput.Type;

export const LogSpeakerContactInput = Schema.Struct({
  eventId: EntityId,
  speakerId: EntityId,
  medium: SpeakerContactMedium,
  note: Schema.NullOr(Schema.String.pipe(Schema.maxLength(2_000))),
  idempotencyKey: IdempotencyKey,
});
export type LogSpeakerContactInput = typeof LogSpeakerContactInput.Type;

export const PublicPortalEvent = PortalEvent;
export type PublicPortalEvent = typeof PublicPortalEvent.Type;

export const PublicSpeaker = Schema.Struct({
  id: EntityId,
  displayName: Schema.String,
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  headshotUrl: NullableText,
  publicProfileSlug: Schema.optional(NullableText),
  links: SpeakerLinks,
});
export type PublicSpeaker = typeof PublicSpeaker.Type;

export const PublicSpeakerGallery = Schema.Struct({
  event: PublicPortalEvent,
  speakers: Schema.Array(PublicSpeaker),
});
export type PublicSpeakerGallery = typeof PublicSpeakerGallery.Type;

export const PublishedSpeakerSnapshot = Schema.Struct({
  id: EntityId,
  displayName: Schema.String,
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  headshotAssetId: Schema.NullOr(EntityId),
  headshotUrl: Schema.optionalWith(NullableText, { default: () => null }),
  publicProfileSlug: Schema.optional(NullableText),
  links: SpeakerLinks,
});
export type PublishedSpeakerSnapshot = typeof PublishedSpeakerSnapshot.Type;

export const PublishedSpeakerGallerySnapshot = Schema.Struct({
  event: PublicPortalEvent,
  revision: Schema.Int.pipe(Schema.positive()),
  publishedAt: Timestamp,
  speakers: Schema.Array(PublishedSpeakerSnapshot),
});
export type PublishedSpeakerGallerySnapshot = typeof PublishedSpeakerGallerySnapshot.Type;
