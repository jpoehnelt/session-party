import { Schema } from "effect";
import { ApiError, apiFetch, decodeApiPayload } from "@/client/api";
import { FormList } from "@/features/forms/schema";
import {
  CreatePublicSubmissionOutput,
  PublicSubmissionForm,
  type CreateTaskSubmissionInput,
} from "@/features/submit/schema";
import {
  ClaimSpeakerOutput,
  ContentAsset,
  ContentComment,
  ContentLibrary,
  PortalDashboard,
  PortalSnapshot,
  PortalTaskDefinitions,
  PublicSpeakerGallery,
  SpeakerDirectory,
  PortalResources,
  DownloadContentOutput,
  ImportSpeakersCsvOutput,
  SendSpeakerMessagesOutput,
  SpeakerProfile,
  type AddContentCommentInput,
  type CreateManagedSpeakerInput,
  type CreateResourceInput,
  type CreateTaskInput,
  type ClaimSpeakerInput,
  type DeleteResourceInput,
  type DeleteTaskInput,
  type DownloadContentInput,
  type ImportSpeakersCsvInput,
  type ImportReusableProfileInput,
  type LogSpeakerContactInput,
  type PortalEvent,
  type SetTaskCompletionInput,
  type UpdateProfileInput,
  type UpdateResourceInput,
  type UpdateSpeakerPublicationInput,
  type UpdateTaskInput,
  type UploadPortalAssetInput,
  type ProvisionSpeakerInput,
  type RestoreContentVersionInput,
  type ReviewSpeakerProfileInput,
  type SendSpeakerMessagesInput,
  type SubmitProfileReviewInput,
  type UpdateManagedSpeakerInput,
  type UploadManagedSpeakerHeadshotInput,
} from "../schema";

const api = "/api/v1";
const segment = encodeURIComponent;

function requestBody<T extends object, K extends keyof T>(input: T, ...pathFields: readonly K[]): Omit<T, K> {
  const body = { ...input };
  for (const field of pathFields) Reflect.deleteProperty(body, field);
  return body as Omit<T, K>;
}

export async function resolveOrganizerEventId(eventSlug: string): Promise<string> {
  const event = await apiFetch<Pick<PortalEvent, "id">>(`${api}/events/${segment(eventSlug)}`);
  return event.id;
}

export async function loadOrganizerRoute<T>(
  eventSlug: string,
  suffix: string,
  schema: Schema.Schema<T, any, never>,
): Promise<T> {
  const eventId = await resolveOrganizerEventId(eventSlug);
  return apiFetch(`${api}/events/${segment(eventId)}/portal${suffix}`, { schema });
}

export async function getSpeakerPortal(eventSlug: string) {
  // Keep an existing portal account aligned with its newest accepted proposal.
  // This is best-effort so legacy submissions without speakerEmail semantics do
  // not prevent an already-provisioned speaker from opening their workspace.
  try {
    await claimSpeakerAccount(eventSlug, {
      eventId: eventSlug,
      idempotencyKey: crypto.randomUUID(),
    });
  } catch {
    // The portal read below remains authoritative and surfaces access failures.
  }
  return apiFetch(`${api}/events/${segment(eventSlug)}/portal`, { schema: PortalSnapshot });
}

export function claimSpeakerAccount(eventSlug: string, input: ClaimSpeakerInput) {
  const body = requestBody(input, "eventId");
  return apiFetch(`${api}/events/${segment(eventSlug)}/portal/claim`, {
    method: "POST",
    body,
    schema: ClaimSpeakerOutput,
  });
}

export const getSpeakerDirectory = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/speakers", SpeakerDirectory);

export const getPortalDashboard = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/dashboard", PortalDashboard);

export const getTaskDefinitions = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/tasks", PortalTaskDefinitions);

export async function getOrganizerFormSummaries(eventSlug: string) {
  const eventId = await resolveOrganizerEventId(eventSlug);
  return apiFetch(`${api}/events/${segment(eventId)}/forms`, { schema: FormList });
}

export const getPortalResources = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/resources", PortalResources);

export const getContentLibrary = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/content", ContentLibrary);

export const getPublicSpeakerGallery = (eventSlug: string) =>
  apiFetch(`${api}/public/events/${segment(eventSlug)}/speakers`, { schema: PublicSpeakerGallery });

export const getSpeakerTaskForm = (eventId: string, formId: string) =>
  apiFetch(`${api}/events/${segment(eventId)}/portal/forms/${segment(formId)}`, {
    schema: PublicSubmissionForm,
  });

export async function submitSpeakerTaskForm(input: CreateTaskSubmissionInput) {
  const response = await fetch(
    `${api}/events/${segment(input.eventId)}/portal/forms/${segment(input.formId)}/submissions`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({ answers: input.answers }),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : response.statusText || `Request failed with status ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return decodeApiPayload(CreatePublicSubmissionOutput, payload);
}

export function updateSpeakerProfile(eventSlug: string, input: UpdateProfileInput) {
  const body = requestBody(input, "eventId");
  return apiFetch<unknown>(`${api}/events/${segment(eventSlug)}/portal/profile`, { method: "PUT", body });
}

export function importReusableProfile(eventSlug: string, input: ImportReusableProfileInput) {
  return apiFetch(`${api}/events/${segment(eventSlug)}/portal/profile/import`, {
    method: "POST",
    body: requestBody(input, "eventId"),
    schema: SpeakerProfile,
  });
}

export function submitProfileReview(eventSlug: string, input: SubmitProfileReviewInput) {
  return apiFetch(`${api}/events/${segment(eventSlug)}/portal/profile/review`, {
    method: "POST",
    body: requestBody(input, "eventId"),
    schema: SpeakerProfile,
  });
}

export function reviewSpeakerProfile(input: ReviewSpeakerProfileInput) {
  return apiFetch(`${api}/events/${segment(input.eventId)}/portal/speakers/${segment(input.speakerId)}/profile-review`, {
    method: "POST",
    body: requestBody(input, "eventId", "speakerId"),
    schema: SpeakerProfile,
  });
}

export function setSpeakerTaskCompletion(eventSlug: string, input: SetTaskCompletionInput) {
  const body = requestBody(input, "eventId", "taskId");
  return apiFetch<unknown>(`${api}/events/${segment(eventSlug)}/portal/tasks/${segment(input.taskId)}/completion`, {
    method: "PUT",
    body,
  });
}

export function uploadSpeakerAsset(eventSlug: string, input: UploadPortalAssetInput) {
  const body = requestBody(input, "eventId");
  return apiFetch<unknown>(`${api}/events/${segment(eventSlug)}/portal/assets`, { method: "POST", body });
}

export function createTask(eventId: string, input: CreateTaskInput) {
  const body = requestBody(input, "eventId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/tasks`, { method: "POST", body });
}

export function createManagedSpeaker(eventId: string, input: CreateManagedSpeakerInput) {
  const body = requestBody(input, "eventId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/speakers`, { method: "POST", body, schema: SpeakerProfile });
}

export function updateManagedSpeaker(eventId: string, input: UpdateManagedSpeakerInput) {
  const body = requestBody(input, "eventId", "speakerId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/speakers/${segment(input.speakerId)}`, { method: "PUT", body, schema: SpeakerProfile });
}

export function importSpeakersCsv(eventId: string, input: ImportSpeakersCsvInput) {
  const body = requestBody(input, "eventId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/speakers/import`, { method: "POST", body, schema: ImportSpeakersCsvOutput });
}

export function sendSpeakerMessages(eventId: string, input: SendSpeakerMessagesInput) {
  const body = requestBody(input, "eventId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/speakers/messages`, { method: "POST", body, schema: SendSpeakerMessagesOutput });
}

export function addContentComment(eventId: string, input: AddContentCommentInput) {
  const body = requestBody(input, "eventId", "assetId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/content/${segment(input.assetId)}/comments`, { method: "POST", body, schema: ContentComment });
}

export function restoreContentVersion(eventId: string, input: RestoreContentVersionInput) {
  const body = requestBody(input, "eventId", "assetId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/content/${segment(input.assetId)}/restore`, { method: "POST", body, schema: ContentAsset });
}

export function downloadContent(eventId: string, input: DownloadContentInput) {
  return apiFetch(`${api}/events/${segment(eventId)}/portal/content/${segment(input.assetId)}/download`, { schema: DownloadContentOutput });
}

export function uploadManagedSpeakerHeadshot(eventId: string, input: UploadManagedSpeakerHeadshotInput) {
  const body = requestBody(input, "eventId", "speakerId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/speakers/${segment(input.speakerId)}/headshot`, { method: "POST", body, schema: ContentAsset });
}

export function updateTask(eventId: string, input: UpdateTaskInput) {
  const body = requestBody(input, "eventId", "taskId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/tasks/${segment(input.taskId)}`, {
    method: "PUT",
    body,
  });
}

export function deleteTask(eventId: string, input: DeleteTaskInput) {
  const body = requestBody(input, "eventId", "taskId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/tasks/${segment(input.taskId)}`, {
    method: "DELETE",
    body,
  });
}

export function createResource(eventId: string, input: CreateResourceInput) {
  const body = requestBody(input, "eventId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/resources`, { method: "POST", body });
}

export function updateResource(eventId: string, input: UpdateResourceInput) {
  const body = requestBody(input, "eventId", "resourceId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/resources/${segment(input.resourceId)}`, {
    method: "PUT",
    body,
  });
}

export function deleteResource(eventId: string, input: DeleteResourceInput) {
  const body = requestBody(input, "eventId", "resourceId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/resources/${segment(input.resourceId)}`, {
    method: "DELETE",
    body,
  });
}

export function provisionSpeaker(eventId: string, input: ProvisionSpeakerInput) {
  const body = requestBody(input, "eventId", "speakerId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/speakers/${segment(input.speakerId)}/provision`, {
    method: "POST",
    body,
  });
}

export function updateSpeakerPublication(eventId: string, input: UpdateSpeakerPublicationInput) {
  const body = requestBody(input, "eventId", "speakerId");
  return apiFetch<unknown>(`${api}/events/${segment(eventId)}/portal/speakers/${segment(input.speakerId)}/publication`, {
    method: "PUT",
    body,
  });
}

export function logSpeakerContact(eventId: string, input: LogSpeakerContactInput) {
  const body = requestBody(input, "eventId", "speakerId");
  return apiFetch(`${api}/events/${segment(eventId)}/portal/speakers/${segment(input.speakerId)}/contacts`, {
    method: "POST",
    body,
  });
}
