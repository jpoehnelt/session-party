import { Schema } from "effect";
import { Hono } from "hono";
import { PublishedAgenda } from "@/features/agenda/schema";

declare global {
  interface Env {}
}

const api = "/api/v1";
const app = new Hono<{ Bindings: Env }>();

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

export async function getPublicSchedule(
  eventSlug: string,
  expected: PublishedScheduleExpectation = {},
) {
  const request = { method: "GET", credentials: "include" as const };
  const response = await fetch(
    `${api}/public/events/${encodeURIComponent(eventSlug)}/agenda/published`,
    request,
  );
  if (!response.ok) {
    throw new PublicationApiError(response.status, await responseMessage(response));
  }
  const published = Schema.decodeUnknownSync(PublishedAgenda)(await response.json());
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

export default app;
