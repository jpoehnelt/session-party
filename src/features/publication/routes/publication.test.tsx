import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduledAgendaFixture } from "@/features/agenda/fixtures";
import {
  path,
  PUBLICATION_ACTIONS_CLASS,
  PUBLICATION_HEADER_CLASS,
  publishAgendaRevision,
  RELOAD_PUBLICATION_LABEL,
  reloadPublicationStatus,
} from "./publication";

afterEach(() => vi.unstubAllGlobals());

describe("publication organizer route", () => {
  it("exposes a distinct read-only publication reload action", () => {
    expect(path).toBe("/e/:eventSlug/publication");
    expect(RELOAD_PUBLICATION_LABEL).toBe("Reload publication status");
  });

  it("keeps the title full width and wraps four publication actions without horizontal overflow", () => {
    expect(PUBLICATION_HEADER_CLASS.split(" ")).toEqual(expect.arrayContaining([
      "sm:flex-col",
      "sm:items-stretch",
    ]));
    expect(PUBLICATION_ACTIONS_CLASS.split(" ")).toEqual(expect.arrayContaining([
      "w-full",
      "min-w-0",
      "grid-cols-1",
      "sm:grid-cols-2",
      "2xl:grid-cols-4",
    ]));
  });

  it("publishes through the immutable agenda publication channel", async () => {
    const status = scheduledAgendaFixture.snapshot;
    const projection = {
      eventId: status.eventId,
      eventName: status.eventName,
      eventSlug: "systems-summit",
      timezone: status.timezone,
      location: "Harbor Hall",
      revision: status.publication.revision + 1,
      publishedAt: Date.UTC(2026, 7, 12, 12),
      talks: [],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(projection), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "refresh-live-widgets-test" });

    await expect(publishAgendaRevision(status)).resolves.toEqual(projection);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestPath, request] = fetchMock.mock.calls[0]!;
    expect(String(requestPath)).toBe(`/api/v1/events/${status.eventId}/agenda/publications`);
    expect(request).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(request?.body))).toEqual({
      expectedRevision: status.publication.revision,
      expectedWorkspaceVersion: status.workspaceVersion,
      expectedEventVersion: status.eventVersion,
      idempotencyKey: "agenda-publication-refresh-live-widgets-test",
    });
  });

  it("reloads the current public revision using GET requests only", async () => {
    const status = {
      ...scheduledAgendaFixture.snapshot,
      publication: { revision: 3, publishedAt: Date.UTC(2026, 7, 12, 12), talkCount: 0 },
    };
    const event = {
      id: status.eventId,
      slug: "effect-days-2026",
      name: status.eventName,
      description: null,
      location: "Harbor Hall",
      timezone: status.timezone,
      startsAt: "2026-08-12T16:00:00.000Z",
      endsAt: "2026-08-13T00:00:00.000Z",
      bannerAssetId: null,
      accentColor: null,
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const projection = {
      eventId: status.eventId,
      eventName: status.eventName,
      eventSlug: event.slug,
      timezone: status.timezone,
      location: event.location,
      revision: status.publication.revision,
      publishedAt: status.publication.publishedAt,
      talks: [],
    };
    const responses = [event, status, projection];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reloadPublicationStatus(event.slug)).resolves.toEqual({ status, published: projection });
    expect(fetchMock.mock.calls.map(([request, init]) => [String(request), init?.method])).toEqual([
      [`/api/v1/events/${event.slug}`, "GET"],
      [`/api/v1/events/${event.id}/agenda?view=day`, "GET"],
      [`/api/v1/public/events/${event.slug}/agenda/published`, "GET"],
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.body === undefined)).toBe(true);
  });
});
