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
  activeTalkCount: 2,
  scheduledTalkCount: 1,
  backlogCount: 1,
  unplacedTalkCount: 1,
  conflictCount: 1,
  publishedTalkCount: 1,
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
    expect(markup).toContain('href="/e/production-summit/review?status=submitted"');
    expect(markup).toContain('href="/e/production-summit/review?status=accepted"');
    expect(markup).toContain('href="/e/production-summit/agenda"');
    expect(markup).toContain('href="/e/production-summit/agenda?view=list&amp;filter=needs-placement"');
    expect(markup).toContain('href="/e/production-summit/agenda?view=list&amp;filter=conflicts"');
    expect(markup).toContain('href="/e/production-summit/agenda?view=list&amp;filter=published"');
    expect(markup).toContain("Production brief");
    expect(markup).toContain("Pier 27, San Francisco");
    expect(markup).toContain("Planning");
  });

  it("loads all overview metrics in one request", async () => {
    const totals = { submitted: 5, in_review: 4, accepted: 3, waitlist: 2, rejected: 1, withdrawn: 0 };
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === `/api/v1/events/${event.id}/overview`) return json({
        submissionCounts: { ...totals, inReview: totals.in_review, in_review: undefined },
        agenda,
      });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadEventOverview(event);

    expect(loaded.event).toEqual(event);
    expect(loaded.submissionCounts).toEqual(totals);
    expect(loaded.agenda).toEqual(agenda);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
