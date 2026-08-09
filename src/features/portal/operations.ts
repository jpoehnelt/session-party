import type { AnyOperationDef } from "contracts/operation";
import { browserSessionAuthorization, eventAuthorization, publicAuthorization } from "contracts/principal";
import {
  CreateResourceInput,
  CreateTaskInput,
  ClaimSpeakerInput,
  ClaimSpeakerOutput,
  DeletePortalEntityOutput,
  DeleteResourceInput,
  DeleteTaskInput,
  PortalDashboard,
  PortalEventInput,
  PortalResource,
  PortalResources,
  PortalSnapshot,
  PortalTask,
  PortalTaskDefinition,
  PortalTaskDefinitions,
  ManageSpeakerOnboardingInput,
  ManageSpeakerOnboardingOutput,
  ProvisionSpeakerInput,
  PublicSpeakerGallery,
  PublicSpeakersInput,
  SetTaskCompletionInput,
  SpeakerDirectory,
  SpeakerDirectoryItem,
  SpeakerProfile,
  UpdateProfileInput,
  UpdateResourceInput,
  UpdateSpeakerPublicationInput,
  UpdateTaskInput,
  UploadPortalAssetInput,
  UploadPortalAssetOutput,
} from "./schema";
import { Effect } from "effect";
import {
  createPortalResource,
  createPortalTask,
  claimSpeaker,
  deletePortalResource,
  deletePortalTask,
  getPortalDashboard,
  getPortalSnapshot,
  getPublicSpeakers,
  getSpeakerDirectory,
  provisionSpeaker,
  setTaskCompletion,
  updatePortalResource,
  updatePortalTask,
  listPortalResources,
  listPortalTasks,
  updateSpeakerProfile,
  updateSpeakerPublication,
  uploadPortalAsset,
} from "./service";

const claimSpeakerOperation = {
  id: "portal.claimSpeaker",
  kind: "command",
  input: ClaimSpeakerInput,
  output: ClaimSpeakerOutput,
  authorize: browserSessionAuthorization,
  invoke: claimSpeaker,
  rest: { method: "post", path: "/events/:eventId/portal/claim", input: { path: ["eventId"], body: ["idempotencyKey"] }, summary: "Claim an accepted primary speaker account by immutable submission email", successStatus: 200 },
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
const organizerContentRead = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["content:read"] },
);
const organizerContentWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["content:write"] },
);

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
  rest: { method: "post", path: "/events/:eventId/portal/tasks", input: { path: ["eventId"], body: ["name", "description", "kind", "formId", "dueAt", "order"] }, summary: "Create an onboarding task", successStatus: 201 },
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
  rest: { method: "put", path: "/events/:eventId/portal/tasks/:taskId", input: { path: ["eventId", "taskId"], body: ["expectedVersion", "name", "description", "kind", "formId", "dueAt", "order"] }, summary: "Update an onboarding task", successStatus: 200 },
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

/** Bytewise operation-id order; registry generation must preserve this sequence. */
export const operations = [
  claimSpeakerOperation,
  createResourceOperation,
  createTaskOperation,
  deleteResourceOperation,
  deleteTaskOperation,
  getDashboardOperation,
  getDirectoryOperation,
  getPublicSpeakersOperation,
  getSnapshotOperation,
  listResourcesOperation,
  listTasksOperation,
  manageOnboardingOperation,
  provisionSpeakerOperation,
  setTaskCompletionOperation,
  updateProfileOperation,
  updateResourceOperation,
  updateSpeakerPublicationOperation,
  updateTaskOperation,
  uploadAssetOperation,
] as const satisfies readonly AnyOperationDef[];
