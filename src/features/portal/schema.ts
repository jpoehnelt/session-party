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
  acceptanceEventId: EntityId,
  provisioningId: EntityId,
  speakerVersion: Schema.Int.pipe(Schema.positive()),
  provisioningVersion: Schema.Int.pipe(Schema.positive()),
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
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  headshotAssetId: Schema.NullOr(EntityId),
  links: SpeakerLinks,
  visible: Schema.Boolean,
  version: Schema.Int.pipe(Schema.positive()),
  pendingSyncFields: Schema.Array(PortalProfileSyncField),
});
export type SpeakerProfile = typeof SpeakerProfile.Type;

export const AcceptedSubmission = Schema.Struct({
  id: EntityId,
  title: Schema.String,
  category: NullableText,
  version: Schema.Int.pipe(Schema.positive()),
});
export type AcceptedSubmission = typeof AcceptedSubmission.Type;

export const ReadinessSummary = Schema.Struct({
  tasksTotal: Schema.Int.pipe(Schema.nonNegative()),
  tasksDone: Schema.Int.pipe(Schema.nonNegative()),
  outstandingTaskIds: Schema.Array(EntityId),
  nextTaskId: Schema.NullOr(EntityId),
  state: Schema.Literal("not_started", "in_progress", "ready"),
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
  acceptanceEventId: EntityId,
  provisioningId: EntityId,
  provisioningVersion: Schema.Int.pipe(Schema.positive()),
  provisioningStatus: Schema.Literal("pending", "claimed", "provisioned", "retry", "failed", "revoked"),
  provisionedAt: Schema.NullOr(Timestamp),
  readiness: ReadinessSummary,
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

export const PublicPortalEvent = PortalEvent;
export type PublicPortalEvent = typeof PublicPortalEvent.Type;

export const PublicSpeaker = Schema.Struct({
  id: EntityId,
  displayName: Schema.String,
  title: NullableText,
  company: NullableText,
  bio: NullableText,
  headshotUrl: NullableText,
  links: SpeakerLinks,
});
export type PublicSpeaker = typeof PublicSpeaker.Type;

export const PublicSpeakerGallery = Schema.Struct({
  event: PublicPortalEvent,
  speakers: Schema.Array(PublicSpeaker),
});
export type PublicSpeakerGallery = typeof PublicSpeakerGallery.Type;
