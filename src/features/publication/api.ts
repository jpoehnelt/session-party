import { Schema } from "effect";
import { PublishedAgenda } from "@/features/agenda/schema";
import { EmbedDefinition, EmbedDefinitions, type CreateEmbedInput, type UpdateEmbedInput } from "./schema";

const api = "/api/v1";

export class PublicationApiError extends Error {
  readonly name = "PublicationApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PublishedScheduleExpectation {
  readonly eventId?: string;
  readonly revision?: number;
}

interface PublicationFetchOptions<T> {
  readonly method?: string;
  readonly body?: unknown;
  readonly schema: Schema.Schema<T, any, never>;
}

async function publicationFetch<T>(
  path: string,
  { method = "GET", body, schema }: PublicationFetchOptions<T>,
): Promise<T> {
  const request = {
    method,
    credentials: "include" as const,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const response = await fetch(path, request);
  if (!response.ok) {
    throw new PublicationApiError(response.status, await responseMessage(response));
  }

  let payload: unknown;
  try {
    payload = await response.json();
    return Schema.decodeUnknownSync(schema)(payload);
  } catch {
    throw new PublicationApiError(502, "The server returned an invalid response. Try again.");
  }
}

export async function getPublicSchedule(
  eventSlug: string,
  expected: PublishedScheduleExpectation = {},
) {
  const published = await publicationFetch(
    `${api}/public/events/${encodeURIComponent(eventSlug)}/agenda/published`,
    { schema: PublishedAgenda },
  );
  if (published.eventSlug !== eventSlug) {
    throw new Error("Published schedule event slug does not match the requested event");
  }
  if (expected.eventId !== undefined && published.eventId !== expected.eventId) {
    throw new Error("Published schedule event does not match the organizer event");
  }
  if (expected.revision !== undefined && published.revision !== expected.revision) {
    throw new Error("Published schedule revision does not match the current public revision");
  }
  return published;
}

export async function listEmbedDefinitions(eventId: string) {
  return publicationFetch(`${api}/events/${encodeURIComponent(eventId)}/embeds`, {
    schema: EmbedDefinitions,
  });
}

export async function createEmbedDefinition(input: CreateEmbedInput) {
  return publicationFetch(`${api}/events/${encodeURIComponent(input.eventId)}/embeds`, {
    method: "POST",
    body: input,
    schema: EmbedDefinition,
  });
}

export async function updateEmbedDefinition(input: UpdateEmbedInput) {
  return publicationFetch(`${api}/events/${encodeURIComponent(input.eventId)}/embeds/${encodeURIComponent(input.embedId)}`, {
    method: "PUT",
    body: input,
    schema: EmbedDefinition,
  });
}

export async function getPublicEmbedDefinition(eventSlug: string, embedId: string) {
  return publicationFetch(`${api}/public/events/${encodeURIComponent(eventSlug)}/embeds/${encodeURIComponent(embedId)}`, {
    schema: EmbedDefinition,
  });
}

function responseMessage(response: Response): Promise<string> {
  return response.json().catch(() => undefined).then((payload: unknown) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      return payload.message;
    }
    return response.statusText || `Request failed with status ${response.status}`;
  });
}
