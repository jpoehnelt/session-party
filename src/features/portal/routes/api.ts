import type { Schema } from "effect";
import { apiFetch } from "@/client/api";
import {
  PortalDashboard,
  PortalSnapshot,
  PortalTaskDefinitions,
  PublicSpeakerGallery,
  SpeakerDirectory,
  PortalResources,
  type CreateResourceInput,
  type CreateTaskInput,
  type DeleteResourceInput,
  type DeleteTaskInput,
  type PortalEvent,
  type SetTaskCompletionInput,
  type UpdateProfileInput,
  type UpdateResourceInput,
  type UpdateSpeakerPublicationInput,
  type UpdateTaskInput,
  type UploadPortalAssetInput,
  type ProvisionSpeakerInput,
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

export const getSpeakerPortal = (eventSlug: string) =>
  apiFetch(`${api}/events/${segment(eventSlug)}/portal`, { schema: PortalSnapshot });

export const getSpeakerDirectory = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/speakers", SpeakerDirectory);

export const getPortalDashboard = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/dashboard", PortalDashboard);

export const getTaskDefinitions = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/tasks", PortalTaskDefinitions);

export const getPortalResources = (eventSlug: string) =>
  loadOrganizerRoute(eventSlug, "/resources", PortalResources);

export const getPublicSpeakerGallery = (eventSlug: string) =>
  apiFetch(`${api}/public/events/${segment(eventSlug)}/speakers`, { schema: PublicSpeakerGallery });

export function updateSpeakerProfile(eventSlug: string, input: UpdateProfileInput) {
  const body = requestBody(input, "eventId");
  return apiFetch<unknown>(`${api}/events/${segment(eventSlug)}/portal/profile`, { method: "PUT", body });
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
