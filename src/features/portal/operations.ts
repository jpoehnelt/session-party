import type { AnyOperationDef } from "contracts/operation";
import { browserSessionAuthorization, eventAuthorization, publicAuthorization } from "contracts/principal";
import {
  AddContentCommentInput,
  ClaimSpeakerInput,
  ClaimSpeakerOutput,
  ContentAsset,
  ContentComment,
  ContentLibrary,
  CreateManagedSpeakerInput,
  CreateResourceInput,
  CreateTaskInput,
  DeletePortalEntityOutput,
  DeleteResourceInput,
  DeleteTaskInput,
  DownloadContentInput,
  DownloadContentOutput,
  ImportSpeakersCsvInput,
  ImportSpeakersCsvOutput,
  ImportReusableProfileInput,
  LogSpeakerContactInput,
  ManageSpeakerOnboardingInput,
  ManageSpeakerOnboardingOutput,
  PortalDashboard,
  PortalEventInput,
  PortalResource,
  PortalResources,
  PortalSnapshot,
  PortalTask,
  PortalTaskDefinition,
  PortalTaskDefinitions,
  ProvisionSpeakerInput,
  PublicSpeakerGallery,
  PublicSpeakersInput,
  RestoreContentVersionInput,
  RespondToAcceptedSessionInput,
  RespondToAcceptedSessionOutput,
  RespondToPublishedScheduleInput,
  RespondToPublishedScheduleOutput,
  ReviewSpeakerProfileInput,
  SendSpeakerMessagesInput,
  SendSpeakerMessagesOutput,
  SetTaskCompletionInput,
  SpeakerContact,
  SpeakerDirectory,
  SpeakerDirectoryItem,
  SpeakerProfile,
  SubmitProfileReviewInput,
  UpdateManagedSpeakerInput,
  UpdateProfileInput,
  UpdateResourceInput,
  UpdateSpeakerPublicationInput,
  UpdateTaskInput,
  UploadManagedSpeakerHeadshotInput,
  UploadPortalAssetInput,
  UploadPortalAssetOutput,
} from "./schema";
import { Effect } from "effect";
import {
  addContentComment,
  claimSpeaker,
  createManagedSpeaker,
  createPortalResource,
  createPortalTask,
  deletePortalResource,
  deletePortalTask,
  downloadContent,
  getContentLibrary,
  getPortalDashboard,
  getPortalSnapshot,
  getPublicSpeakers,
  getSpeakerDirectory,
  importSpeakersCsv,
  importReusableProfile,
  listPortalResources,
  listPortalTasks,
  logSpeakerContact,
  provisionSpeaker,
  respondToAcceptedSession,
  respondToPublishedSchedule,
  restoreContentVersion,
  reviewSpeakerProfile,
  sendSpeakerMessages,
  setTaskCompletion,
  submitProfileReview,
  updatePortalResource,
  updatePortalTask,
  updateManagedSpeaker,
  updateSpeakerProfile,
  updateSpeakerPublication,
  uploadManagedSpeakerHeadshot,
  uploadPortalAsset,
} from "./service";

const claimSpeakerOperation = {
  id: "portal.claimSpeaker",
  kind: "command",
  input: ClaimSpeakerInput,
  output: ClaimSpeakerOutput,
  authorize: browserSessionAuthorization,
  invoke: claimSpeaker,
  rest: { method: "post", path: "/events/:eventId/portal/claim", input: { path: ["eventId"], body: ["idempotencyKey"] }, summary: "Claim an accepted or directly managed speaker account by verified email", successStatus: 200 },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.speaker.claimed"],
} as const satisfies AnyOperationDef;

const organizerSpeakerRead = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["speakers:read"] },
);
const organizerSpeakerWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["speakers:write"] },
);
const organizerHumanSpeakerWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
);
const organizerContentRead = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["content:read"] },
);
const organizerContentWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["content:write"] },
);

const addContentCommentOperation = {
  id: "portal.addContentComment",
  kind: "command",
  input: AddContentCommentInput,
  output: ContentComment,
  authorize: browserSessionAuthorization,
  invoke: addContentComment,
  rest: { method: "post", path: "/events/:eventId/portal/content/:assetId/comments", input: { path: ["eventId", "assetId"], body: ["body", "idempotencyKey"] }, summary: "Add an organizer or owning-speaker content comment", successStatus: 201 },
  idempotency: "required",
  concurrency: "none",
  emits: ["portal.asset.comment.added"],
} as const satisfies AnyOperationDef;

const createManagedSpeakerOperation = {
  id: "portal.createManagedSpeaker",
  kind: "command",
  input: CreateManagedSpeakerInput,
  output: SpeakerProfile,
  authorize: organizerSpeakerWrite,
  invoke: createManagedSpeaker,
  rest: { method: "post", path: "/events/:eventId/portal/speakers", input: { path: ["eventId"], body: ["displayName", "contactEmail", "title", "company", "bio", "workflowStatus", "visible", "idempotencyKey"] }, summary: "Add a speaker directly to the event", successStatus: 201 },
  mcp: { name: "portal_create_managed_speaker", description: "Add a directly managed event speaker without requiring a CFP acceptance." },
  idempotency: "required",
  concurrency: "none",
  emits: ["portal.speaker.managed.created"],
} as const satisfies AnyOperationDef;

const downloadContentOperation = {
  id: "portal.downloadContent",
  kind: "query",
  input: DownloadContentInput,
  output: DownloadContentOutput,
  authorize: browserSessionAuthorization,
  invoke: downloadContent,
  rest: { method: "get", path: "/events/:eventId/portal/content/:assetId/download", input: { path: ["eventId", "assetId"] }, summary: "Download an organizer-visible or speaker-owned content version", successStatus: 200 },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const getContentLibraryOperation = {
  id: "portal.getContentLibrary",
  kind: "query",
  input: PortalEventInput,
  output: ContentLibrary,
  authorize: organizerContentRead,
  invoke: getContentLibrary,
  rest: { method: "get", path: "/events/:eventId/portal/content", input: { path: ["eventId"] }, summary: "List current and historical speaker content with comments", successStatus: 200 },
  mcp: { name: "portal_get_content_library", description: "List speaker content versions, ownership, metadata, and comments." },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const importSpeakersCsvOperation = {
  id: "portal.importSpeakersCsv",
  kind: "command",
  input: ImportSpeakersCsvInput,
  output: ImportSpeakersCsvOutput,
  authorize: organizerSpeakerWrite,
  invoke: importSpeakersCsv,
  rest: { method: "post", path: "/events/:eventId/portal/speakers/import", input: { path: ["eventId"], body: ["csv", "idempotencyKey"] }, summary: "Create or update speakers from CSV", successStatus: 200 },
  mcp: { name: "portal_import_speakers_csv", description: "Create or update directly managed event speakers from CSV." },
  idempotency: "required",
  concurrency: "none",
  emits: ["portal.speaker.csv.imported"],
} as const satisfies AnyOperationDef;

const restoreContentVersionOperation = {
  id: "portal.restoreContentVersion",
  kind: "command",
  input: RestoreContentVersionInput,
  output: ContentAsset,
  authorize: organizerContentWrite,
  invoke: restoreContentVersion,
  rest: { method: "post", path: "/events/:eventId/portal/content/:assetId/restore", input: { path: ["eventId", "assetId"], body: ["expectedCurrentAssetId", "expectedCurrentVersion", "expectedSpeakerVersion", "idempotencyKey"] }, summary: "Restore a historical content version as the new current version", successStatus: 201 },
  mcp: { name: "portal_restore_content_version", description: "Restore a retained speaker content version without deleting history." },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.asset.version.restored"],
} as const satisfies AnyOperationDef;

const sendSpeakerMessagesOperation = {
  id: "portal.sendSpeakerMessages",
  kind: "command",
  input: SendSpeakerMessagesInput,
  output: SendSpeakerMessagesOutput,
  authorize: organizerHumanSpeakerWrite,
  invoke: sendSpeakerMessages,
  rest: { method: "post", path: "/events/:eventId/portal/speakers/messages", input: { path: ["eventId"], body: ["speakerIds", "kind", "idempotencyKey"] }, summary: "Queue invitations or outstanding-task reminders for selected speakers", successStatus: 202 },
  idempotency: "required",
  concurrency: "none",
  emits: ["portal.speaker.messages.enqueued"],
} as const satisfies AnyOperationDef;

const updateManagedSpeakerOperation = {
  id: "portal.updateManagedSpeaker",
  kind: "command",
  input: UpdateManagedSpeakerInput,
  output: SpeakerProfile,
  authorize: organizerSpeakerWrite,
  invoke: updateManagedSpeaker,
  rest: { method: "put", path: "/events/:eventId/portal/speakers/:speakerId", input: { path: ["eventId", "speakerId"], body: ["expectedVersion", "displayName", "contactEmail", "title", "company", "bio", "workflowStatus", "visible"] }, summary: "Edit a managed speaker profile and workflow status", successStatus: 200 },
  mcp: { name: "portal_update_managed_speaker", description: "Edit a versioned event speaker profile and workflow status." },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.speaker.managed.updated"],
} as const satisfies AnyOperationDef;

const manageSpeakerOnboarding = (
  input: typeof ManageSpeakerOnboardingInput.Type,
) => {
  const { eventId, action } = input;
  switch (action.type) {
    case "createTask":
      return createPortalTask({ eventId, ...action }).pipe(
        Effect.map((result) => ({ action: "createTask" as const, result })),
      );
    case "updateTask":
      return updatePortalTask({ eventId, ...action }).pipe(
        Effect.map((result) => ({ action: "updateTask" as const, result })),
      );
    case "deleteTask":
      return deletePortalTask({ eventId, ...action }).pipe(
        Effect.map((result) => ({ action: "deleteTask" as const, result })),
      );
    case "provisionSpeaker":
      return provisionSpeaker({ eventId, ...action }).pipe(
        Effect.map((result) => ({ action: "provisionSpeaker" as const, result })),
      );
    case "setSpeakerPublication":
      return updateSpeakerPublication({ eventId, ...action }).pipe(
        Effect.map((result) => ({ action: "setSpeakerPublication" as const, result })),
      );
  }
};

const createResourceOperation = {
  id: "portal.createResource",
  kind: "command",
  input: CreateResourceInput,
  output: PortalResource,
  authorize: organizerContentWrite,
  invoke: createPortalResource,
  rest: { method: "post", path: "/events/:eventId/portal/resources", input: { path: ["eventId"], body: ["slug", "title", "body", "embedUrl", "audience", "order"] }, summary: "Create a speaker portal resource", successStatus: 201 },
  mcp: { name: "portal_create_resource", description: "Create a speaker or public resource with an allowlisted iframe provider." },
  idempotency: "none",
  concurrency: "none",
  emits: ["portal.resource.created"],
} as const satisfies AnyOperationDef;

const createTaskOperation = {
  id: "portal.createTask",
  kind: "command",
  input: CreateTaskInput,
  output: PortalTaskDefinition,
  authorize: organizerSpeakerWrite,
  invoke: createPortalTask,
  rest: { method: "post", path: "/events/:eventId/portal/tasks", input: { path: ["eventId"], body: ["name", "description", "kind", "formId", "dueAt", "order", "speakerIds"] }, summary: "Create an onboarding task", successStatus: 201 },
  idempotency: "none",
  concurrency: "none",
  emits: ["portal.task.created"],
} as const satisfies AnyOperationDef;

const deleteResourceOperation = {
  id: "portal.deleteResource",
  kind: "command",
  input: DeleteResourceInput,
  output: DeletePortalEntityOutput,
  authorize: organizerContentWrite,
  invoke: deletePortalResource,
  rest: { method: "delete", path: "/events/:eventId/portal/resources/:resourceId", input: { path: ["eventId", "resourceId"], body: ["expectedVersion"] }, summary: "Delete a portal resource", successStatus: 200 },
  mcp: { name: "portal_delete_resource", description: "Delete one versioned speaker portal resource." },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.resource.deleted"],
} as const satisfies AnyOperationDef;

const deleteTaskOperation = {
  id: "portal.deleteTask",
  kind: "command",
  input: DeleteTaskInput,
  output: DeletePortalEntityOutput,
  authorize: organizerSpeakerWrite,
  invoke: deletePortalTask,
  rest: { method: "delete", path: "/events/:eventId/portal/tasks/:taskId", input: { path: ["eventId", "taskId"], body: ["expectedVersion"] }, summary: "Delete an onboarding task", successStatus: 200 },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.task.deleted"],
} as const satisfies AnyOperationDef;

const getDashboardOperation = {
  id: "portal.getDashboard",
  kind: "query",
  input: PortalEventInput,
  output: PortalDashboard,
  authorize: organizerSpeakerRead,
  invoke: getPortalDashboard,
  rest: { method: "get", path: "/events/:eventId/portal/dashboard", input: { path: ["eventId"] }, summary: "Load organizer portal readiness dashboard", successStatus: 200 },
  mcp: { name: "portal_get_dashboard", description: "Load accepted speakers and aggregate onboarding readiness for organizers." },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const getDirectoryOperation = {
  id: "portal.getDirectory",
  kind: "query",
  input: PortalEventInput,
  output: SpeakerDirectory,
  authorize: organizerSpeakerRead,
  invoke: getSpeakerDirectory,
  rest: { method: "get", path: "/events/:eventId/portal/speakers", input: { path: ["eventId"] }, summary: "Load the organizer speaker directory", successStatus: 200 },
  mcp: { name: "portal_get_directory", description: "Load acceptance, provisioning, and readiness detail for event speakers." },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const getPublicSpeakersOperation = {
  id: "portal.getPublicSpeakers",
  kind: "query",
  input: PublicSpeakersInput,
  output: PublicSpeakerGallery,
  authorize: publicAuthorization,
  invoke: getPublicSpeakers,
  rest: { method: "get", path: "/public/events/:eventSlug/speakers", input: { path: ["eventSlug"] }, summary: "Load privacy-filtered public speakers", successStatus: 200 },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const getSnapshotOperation = {
  id: "portal.getSnapshot",
  kind: "query",
  input: PortalEventInput,
  output: PortalSnapshot,
  authorize: browserSessionAuthorization,
  invoke: getPortalSnapshot,
  rest: { method: "get", path: "/events/:eventId/portal", input: { path: ["eventId"] }, summary: "Load the exact provisioned speaker portal", successStatus: 200 },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const respondToAcceptedSessionOperation = {
  id: "portal.respondToAcceptedSession",
  kind: "command",
  input: RespondToAcceptedSessionInput,
  output: RespondToAcceptedSessionOutput,
  authorize: browserSessionAuthorization,
  invoke: respondToAcceptedSession,
  rest: { method: "post", path: "/events/:eventId/portal/sessions/:submissionId/respond", input: { path: ["eventId", "submissionId"], body: ["expectedVersion", "action", "idempotencyKey"] }, summary: "Confirm or withdraw the signed-in speaker's accepted session", successStatus: 200 },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.session.confirmed", "portal.session.withdrawn"],
} as const satisfies AnyOperationDef;

const respondToPublishedScheduleOperation = {
  id: "portal.respondToPublishedSchedule",
  kind: "command",
  input: RespondToPublishedScheduleInput,
  output: RespondToPublishedScheduleOutput,
  authorize: browserSessionAuthorization,
  invoke: respondToPublishedSchedule,
  rest: {
    method: "post",
    path: "/events/:eventId/portal/schedule/:talkId/respond",
    input: {
      path: ["eventId", "talkId"],
      body: ["expectedTalkVersion", "expectedPublicationRevision", "response", "note", "idempotencyKey"],
    },
    summary: "Acknowledge or report a conflict with the signed-in speaker's published session time",
    successStatus: 200,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.schedule.acknowledged", "portal.schedule.conflict-reported"],
} as const satisfies AnyOperationDef;

const listResourcesOperation = {
  id: "portal.listResources",
  kind: "query",
  input: PortalEventInput,
  output: PortalResources,
  authorize: organizerContentRead,
  invoke: listPortalResources,
  rest: { method: "get", path: "/events/:eventId/portal/resources", input: { path: ["eventId"] }, summary: "List portal resources for organizers", successStatus: 200 },
  mcp: { name: "portal_list_resources", description: "List versioned speaker and public portal resources for an event." },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const manageOnboardingOperation = {
  id: "portal.manageOnboarding",
  kind: "command",
  input: ManageSpeakerOnboardingInput,
  output: ManageSpeakerOnboardingOutput,
  authorize: organizerSpeakerWrite,
  invoke: manageSpeakerOnboarding,
  mcp: {
    name: "manage_speaker_onboarding",
    description: "Create, update, or delete onboarding tasks; provision an accepted speaker; or control speaker publication.",
  },
  idempotency: "none",
  concurrency: "required",
  emits: [
    "portal.task.created",
    "portal.task.updated",
    "portal.task.deleted",
    "portal.speaker.provisioned",
    "portal.speaker.publication.updated",
  ],
} as const satisfies AnyOperationDef;

const listTasksOperation = {
  id: "portal.listTasks",
  kind: "query",
  input: PortalEventInput,
  output: PortalTaskDefinitions,
  authorize: organizerSpeakerRead,
  invoke: listPortalTasks,
  rest: { method: "get", path: "/events/:eventId/portal/tasks", input: { path: ["eventId"] }, summary: "List portal onboarding tasks for organizers", successStatus: 200 },
  mcp: { name: "portal_list_tasks", description: "List versioned onboarding tasks for an event." },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const logSpeakerContactOperation = {
  id: "portal.logSpeakerContact",
  kind: "command",
  input: LogSpeakerContactInput,
  output: SpeakerContact,
  authorize: browserSessionAuthorization,
  invoke: logSpeakerContact,
  rest: { method: "post", path: "/events/:eventId/portal/speakers/:speakerId/contacts", input: { path: ["eventId", "speakerId"], body: ["medium", "note", "idempotencyKey"] }, summary: "Append an organizer-recorded completed speaker contact", successStatus: 201 },
  idempotency: "required",
  concurrency: "none",
  emits: ["portal.speaker.contact.logged"],
} as const satisfies AnyOperationDef;

const provisionSpeakerOperation = {
  id: "portal.provisionSpeaker",
  kind: "command",
  input: ProvisionSpeakerInput,
  output: SpeakerDirectoryItem,
  authorize: organizerSpeakerWrite,
  invoke: provisionSpeaker,
  rest: { method: "post", path: "/events/:eventId/portal/speakers/:speakerId/provision", input: { path: ["eventId", "speakerId"], body: ["provisioningId", "expectedVersion"] }, summary: "Provision an accepted user-linked speaker", successStatus: 200 },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.speaker.provisioned"],
} as const satisfies AnyOperationDef;

const setTaskCompletionOperation = {
  id: "portal.setTaskCompletion",
  kind: "command",
  input: SetTaskCompletionInput,
  output: PortalTask,
  authorize: browserSessionAuthorization,
  invoke: setTaskCompletion,
  rest: { method: "put", path: "/events/:eventId/portal/tasks/:taskId/completion", input: { path: ["eventId", "taskId"], body: ["completed", "data", "idempotencyKey"] }, summary: "Set the exact speaker's task completion", successStatus: 200 },
  idempotency: "required",
  concurrency: "none",
  emits: ["portal.task.completion.changed"],
} as const satisfies AnyOperationDef;

const updateProfileOperation = {
  id: "portal.updateProfile",
  kind: "command",
  input: UpdateProfileInput,
  output: SpeakerProfile,
  authorize: browserSessionAuthorization,
  invoke: updateSpeakerProfile,
  rest: { method: "put", path: "/events/:eventId/portal/profile", input: { path: ["eventId"], body: ["expectedVersion", "idempotencyKey", "displayName", "title", "company", "bio", "links"] }, summary: "Update the exact speaker profile", successStatus: 200 },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.profile.updated"],
} as const satisfies AnyOperationDef;

const importReusableProfileOperation = {
  id: "portal.importReusableProfile",
  kind: "command",
  input: ImportReusableProfileInput,
  output: SpeakerProfile,
  authorize: browserSessionAuthorization,
  invoke: importReusableProfile,
  rest: { method: "post", path: "/events/:eventId/portal/profile/import", input: { path: ["eventId"], body: ["expectedVersion"] }, summary: "Copy the signed-in speaker's reusable profile into this event draft", successStatus: 200 },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.profile.reusable-imported"],
} as const satisfies AnyOperationDef;

const submitProfileReviewOperation = {
  id: "portal.submitProfileReview",
  kind: "command",
  input: SubmitProfileReviewInput,
  output: SpeakerProfile,
  authorize: browserSessionAuthorization,
  invoke: submitProfileReview,
  rest: { method: "post", path: "/events/:eventId/portal/profile/review", input: { path: ["eventId"], body: ["expectedVersion"] }, summary: "Submit and lock the event speaker profile for organizer review", successStatus: 200 },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.profile.submitted"],
} as const satisfies AnyOperationDef;

const reviewSpeakerProfileOperation = {
  id: "portal.reviewSpeakerProfile",
  kind: "command",
  input: ReviewSpeakerProfileInput,
  output: SpeakerProfile,
  authorize: organizerHumanSpeakerWrite,
  invoke: reviewSpeakerProfile,
  rest: { method: "post", path: "/events/:eventId/portal/speakers/:speakerId/profile-review", input: { path: ["eventId", "speakerId"], body: ["expectedVersion", "decision", "note"] }, summary: "Approve an event speaker profile or request changes", successStatus: 200 },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.profile.approved", "portal.profile.changes-requested"],
} as const satisfies AnyOperationDef;

const updateResourceOperation = {
  id: "portal.updateResource",
  kind: "command",
  input: UpdateResourceInput,
  output: PortalResource,
  authorize: organizerContentWrite,
  invoke: updatePortalResource,
  rest: { method: "put", path: "/events/:eventId/portal/resources/:resourceId", input: { path: ["eventId", "resourceId"], body: ["expectedVersion", "slug", "title", "body", "embedUrl", "audience", "order"] }, summary: "Update a portal resource", successStatus: 200 },
  mcp: { name: "portal_update_resource", description: "Update a versioned portal resource and validate its iframe provider." },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.resource.updated"],
} as const satisfies AnyOperationDef;

const updateSpeakerPublicationOperation = {
  id: "portal.updateSpeakerPublication",
  kind: "command",
  input: UpdateSpeakerPublicationInput,
  output: SpeakerProfile,
  authorize: organizerSpeakerWrite,
  invoke: updateSpeakerPublication,
  rest: { method: "put", path: "/events/:eventId/portal/speakers/:speakerId/publication", input: { path: ["eventId", "speakerId"], body: ["expectedVersion", "visible"] }, summary: "Toggle speaker public publication", successStatus: 200 },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.speaker.publication.updated"],
} as const satisfies AnyOperationDef;

const updateTaskOperation = {
  id: "portal.updateTask",
  kind: "command",
  input: UpdateTaskInput,
  output: PortalTaskDefinition,
  authorize: organizerSpeakerWrite,
  invoke: updatePortalTask,
  rest: { method: "put", path: "/events/:eventId/portal/tasks/:taskId", input: { path: ["eventId", "taskId"], body: ["expectedVersion", "name", "description", "kind", "formId", "dueAt", "order", "speakerIds"] }, summary: "Update an onboarding task", successStatus: 200 },
  idempotency: "none",
  concurrency: "required",
  emits: ["portal.task.updated"],
} as const satisfies AnyOperationDef;

const uploadAssetOperation = {
  id: "portal.uploadAsset",
  kind: "command",
  input: UploadPortalAssetInput,
  output: UploadPortalAssetOutput,
  authorize: browserSessionAuthorization,
  invoke: uploadPortalAsset,
  rest: { method: "post", path: "/events/:eventId/portal/assets", input: { path: ["eventId"], body: ["taskId", "purpose", "filename", "contentType", "contentBase64", "expectedVersion", "idempotencyKey"] }, summary: "Upload a validated R2-backed portal asset", successStatus: 201 },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.asset.uploaded", "portal.task.completion.changed"],
} as const satisfies AnyOperationDef;

const uploadManagedSpeakerHeadshotOperation = {
  id: "portal.uploadManagedSpeakerHeadshot",
  kind: "command",
  input: UploadManagedSpeakerHeadshotInput,
  output: ContentAsset,
  authorize: organizerContentWrite,
  invoke: uploadManagedSpeakerHeadshot,
  rest: { method: "post", path: "/events/:eventId/portal/speakers/:speakerId/headshot", input: { path: ["eventId", "speakerId"], body: ["expectedVersion", "filename", "contentType", "contentBase64", "idempotencyKey"] }, summary: "Upload a managed speaker headshot with retained version history", successStatus: 201 },
  idempotency: "required",
  concurrency: "required",
  emits: ["portal.speaker.headshot.managed.updated"],
} as const satisfies AnyOperationDef;

/** Bytewise operation-id order; registry generation must preserve this sequence. */
export const operations = [
  addContentCommentOperation,
  claimSpeakerOperation,
  createManagedSpeakerOperation,
  createResourceOperation,
  createTaskOperation,
  deleteResourceOperation,
  deleteTaskOperation,
  downloadContentOperation,
  getContentLibraryOperation,
  getDashboardOperation,
  getDirectoryOperation,
  getPublicSpeakersOperation,
  getSnapshotOperation,
  importReusableProfileOperation,
  importSpeakersCsvOperation,
  listResourcesOperation,
  listTasksOperation,
  logSpeakerContactOperation,
  manageOnboardingOperation,
  provisionSpeakerOperation,
  respondToAcceptedSessionOperation,
  respondToPublishedScheduleOperation,
  restoreContentVersionOperation,
  reviewSpeakerProfileOperation,
  sendSpeakerMessagesOperation,
  setTaskCompletionOperation,
  submitProfileReviewOperation,
  updateManagedSpeakerOperation,
  updateProfileOperation,
  updateResourceOperation,
  updateSpeakerPublicationOperation,
  updateTaskOperation,
  uploadAssetOperation,
  uploadManagedSpeakerHeadshotOperation,
] as const satisfies readonly AnyOperationDef[];
