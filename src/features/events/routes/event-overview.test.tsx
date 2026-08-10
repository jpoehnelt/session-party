import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventOverviewContent,
  eventPhase,
  formatEventDates,
  loadEventOverview,
  type EventOverviewData,
} from "./event-overview";

const event: EventOverviewData["event"] = {
  id: "event-production",
  slug: "production-summit",
  name: "Production Summit",
  description: "A working conference for production teams.",
  location: "Pier 27, San Francisco",
  timezone: "America/Los_Angeles",
  startsAt: new Date("2026-09-14T16:00:00.000Z"),
  endsAt: new Date("2026-09-15T23:00:00.000Z"),
  bannerAssetId: null,
  accentColor: "#7857ff",
  version: 4,
  createdAt: new Date("2026-07-01T12:00:00.000Z"),
  updatedAt: new Date("2026-08-08T12:00:00.000Z"),
};

const agenda: NonNullable<EventOverviewData["agenda"]> = {
  eventId: event.id,
  eventName: event.name,
  eventSlug: event.slug,
  timezone: event.timezone,
  view: "day",
  workspaceVersion: 7,
  eventVersion: event.version,
  tracks: [{ id: "track-main", name: "Main", color: "#7857ff", order: 1, version: 1 }],
  rooms: [{ id: "room-main", name: "Main stage", capacity: 300, order: 1, version: 1 }],
  backlog: [{
    submissionId: "submission-backlog",
    title: "Still to place",
    category: "Operations",
    submissionVersion: 2,
    acceptanceEventId: "acceptance-backlog",
    primarySpeakerId: "speaker-backlog",
    primarySpeakerName: "Ari Lee",
    provisionedAt: Date.UTC(2026, 7, 1),
  }],
  talks: [
    {
      id: "talk-scheduled",
      eventId: event.id,
      submissionId: "submission-scheduled",
      title: "Opening production",
      description: null,
      trackId: "track-main",
      roomId: "room-main",
      startsAt: Date.UTC(2026, 8, 14, 16),
      durationMin: 45,
      status: "confirmed",
      version: 2,
      speakerIds: ["speaker-one"],
      speakerNames: ["Sam Rivera"],
    },
    {
      id: "talk-unplaced",
      eventId: event.id,
      submissionId: "submission-unplaced",
      title: "Unplaced session",
      description: null,
      trackId: null,
      roomId: null,
      startsAt: null,
      durationMin: 30,
      status: "draft",
      version: 1,
      speakerIds: ["speaker-two"],
      speakerNames: ["Jordan Kim"],
    },
  ],
  conflicts: [{
    kind: "room_overlap",
    talkIds: ["talk-scheduled", "talk-unplaced"],
    roomId: "room-main",
    roomName: "Main stage",
    explanation: "The sessions overlap in Main stage.",
  }],
  warnings: {
    unplacedTalkCount: 1,
    conflictCount: 1,
    roomConflictCount: 1,
    speakerConflictCount: 0,
  },
  publication: { revision: 2, publishedAt: Date.UTC(2026, 7, 10), talkCount: 1 },
};

const counts: NonNullable<EventOverviewData["submissionCounts"]> = {
  submitted: 12,
  in_review: 8,
  accepted: 6,
  waitlist: 2,
  rejected: 3,
  withdrawn: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("event overview dashboard", () => {
  it("renders event-level statistics, pipeline chart, and schedule health", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [`/e/${event.slug}`] },
        createElement(EventOverviewContent, {
          overview: { event, submissionCounts: counts, agenda },
          now: new Date("2026-08-10T12:00:00.000Z"),
        }),
      ),
    );

    expect(markup).toContain("Event statistics");
    expect(markup).toContain("Proposals");
    expect(markup).toContain(">32<");
    expect(markup).toContain("Submission pipeline");
    expect(markup).toContain("Submitted 12, In review 8, Accepted 6, Waitlisted 2, Rejected 3, Withdrawn 1");
    expect(markup).toContain("Schedule health");
    expect(markup).toContain("1 / 3");
    expect(markup).toContain("Needs placement");
    expect(markup).toContain('href="/e/production-summit/review"');
    expect(markup).toContain('href="/e/production-summit/agenda"');
    expect(markup).toContain("Production brief");
    expect(markup).toContain("Pier 27, San Francisco");
    expect(markup).toContain("Planning");
  });

  it("loads exact submission stage totals and the agenda snapshot", async () => {
    const totals = { submitted: 5, in_review: 4, accepted: 3, waitlist: 2, rejected: 1, withdrawn: 0 };
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === `/api/v1/events/${event.slug}`) {
        return json({
          ...event,
          startsAt: event.startsAt?.toISOString(),
          endsAt: event.endsAt?.toISOString(),
          createdAt: event.createdAt.toISOString(),
          updatedAt: event.updatedAt.toISOString(),
        });
      }
      if (url === `/api/v1/events/${event.id}/agenda?view=day`) return json(agenda);
      const status = new URL(url, "https://sessionparty.test").searchParams.get("status") as keyof typeof totals | null;
      if (status && status in totals) {
        return json({
          results: [],
          categories: [],
          pagination: { page: 1, pageSize: 1, total: totals[status], pageCount: totals[status] > 0 ? totals[status] : 0 },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadEventOverview(event.slug);

    expect(loaded.event).toEqual(event);
    expect(loaded.submissionCounts).toEqual(totals);
    expect(loaded.agenda).toEqual(agenda);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("formats event timing for the event timezone", () => {
    expect(formatEventDates(event)).toBe("Sep 14, 2026 — Sep 15, 2026");
    expect(eventPhase(event, new Date("2026-09-14T18:00:00.000Z"))).toEqual({ label: "Live", tone: "success" });
  });
});

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
