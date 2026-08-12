import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduledAgendaFixture } from "@/features/agenda/fixtures";
import {
  path,
  REFRESH_LIVE_WIDGETS_LABEL,
  refreshLiveWidgets,
} from "./publication";

afterEach(() => vi.unstubAllGlobals());

describe("publication organizer route", () => {
  it("exposes the distinct live-widget refresh action", () => {
    expect(path).toBe("/e/:eventSlug/publication");
    expect(REFRESH_LIVE_WIDGETS_LABEL).toBe("Refresh live widgets");
  });

  it("refreshes through the existing immutable agenda publication channel", async () => {
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

    await expect(refreshLiveWidgets(status)).resolves.toEqual(projection);
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
});
