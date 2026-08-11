import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventsWorkspace,
  RoleAwareHome,
  accessModes,
  automaticHomeDestination,
  eventAccessDestinations,
  eventPhase,
  fetchEventAccess,
  fetchEvents,
  formatEventDates,
  prioritizeEvents,
  slugifyEventName,
  type EventSummary,
  type EventAccessSummary,
} from "./events-home";

const now = new Date("2026-08-09T18:00:00.000Z");

function event(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: "event-1",
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
    ...overrides,
  };
}

function access(
  eventValue = event(),
  overrides: Partial<Omit<EventAccessSummary, "event">> = {},
): EventAccessSummary {
  return {
    event: eventValue,
    memberRole: "owner",
    speakerPortal: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("events home", () => {
  it("renders one event as an active workspace with useful metadata and workflow shortcuts", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/events"] },
        createElement(EventsWorkspace, { access: [access()], now }),
      ),
    );

    expect(markup).toContain("Active workspace");
    expect(markup).toContain("Production Summit");
    expect(markup).toContain("Sep 14, 2026 — Sep 15, 2026");
    expect(markup).toContain("Pier 27, San Francisco");
    expect(markup).toContain("5/5");
    expect(markup).toContain("Shape the program");
    expect(markup).toContain('href="/e/production-summit/dashboard"');
    expect(markup).toContain('href="/e/production-summit/forms"');
    expect(markup).toContain('href="/e/production-summit/review"');
    expect(markup).toContain('href="/e/production-summit/speakers"');
    expect(markup).toContain('href="/e/production-summit/agenda"');
    expect(markup).not.toContain("Other events");
  });

  it("presents organizer and speaker destinations independently for a dual-role event", () => {
    const dualRole = access(event(), { speakerPortal: true });
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/events"] },
        createElement(EventsWorkspace, { access: [dualRole], now }),
      ),
    );

    expect(eventAccessDestinations(dualRole)).toEqual([
      { label: "Organizer dashboard", role: "Organizer", to: "/e/production-summit/dashboard" },
      { label: "Speaker portal", role: "Speaker", to: "/e/production-summit/portal" },
    ]);
    expect(markup).toContain("Organizer dashboard");
    expect(markup).toContain("Speaker portal");
    expect(markup).toContain('href="/e/production-summit/dashboard"');
    expect(markup).toContain('href="/e/production-summit/portal"');
  });

  it("routes single-role accounts to the appropriate signed-in home", () => {
    const speakerOnly = access(event(), { memberRole: null, speakerPortal: true });
    const organizerOnly = access();
    const reviewerOnly = access(event(), { memberRole: "reviewer" });

    expect(automaticHomeDestination([speakerOnly], now)).toBe("/speaker/profile");
    expect(automaticHomeDestination([organizerOnly], now)).toBe("/e/production-summit/dashboard");
    expect(automaticHomeDestination([reviewerOnly], now)).toBe("/e/production-summit/review");
    expect(accessModes([], true)).toEqual(["speaker"]);
    expect(automaticHomeDestination([], now, true)).toBe("/speaker/profile");
  });

  it("chooses the highest-priority organizer event for an organizer-only account", () => {
    const live = access(event({ id: "live", slug: "live-event", startsAt: new Date("2026-08-09T17:00:00.000Z"), endsAt: new Date("2026-08-09T20:00:00.000Z") }));
    const upcoming = access(event({ id: "upcoming", slug: "upcoming-event", startsAt: new Date("2026-08-20T17:00:00.000Z"), endsAt: new Date("2026-08-21T20:00:00.000Z") }));

    expect(automaticHomeDestination([upcoming, live], now)).toBe("/e/live-event/dashboard");
  });

  it("keeps dual-role users on a neutral chooser with explicit role destinations", () => {
    const dualRole = access(event(), { speakerPortal: true });
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/events"] },
        createElement(RoleAwareHome, { access: [dualRole], onCreateEvent: () => undefined }),
      ),
    );

    expect(accessModes([dualRole])).toEqual(["organizer", "speaker"]);
    expect(automaticHomeDestination([dualRole], now)).toBeNull();
    expect(markup).toContain("Manage speaker profile");
    expect(markup).toContain("Production Summit portal");
    expect(markup).toContain("Production Summit dashboard");
    expect(markup).toContain("Start an event");
    expect(markup).toContain("Create event");
  });

  it("gives a new account neutral speaker and event-creation choices", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/events"] },
        createElement(RoleAwareHome, { access: [], onCreateEvent: () => undefined }),
      ),
    );

    expect(automaticHomeDestination([], now)).toBeNull();
    expect(markup).toContain("Manage speaker profile");
    expect(markup).toContain("Creating an event makes you its owner");
    expect(markup).not.toContain("Event setup");
  });

  it("prioritizes live and upcoming work ahead of undated and completed events", () => {
    const live = event({ id: "live", name: "Live", startsAt: new Date("2026-08-09T17:00:00.000Z"), endsAt: new Date("2026-08-09T20:00:00.000Z") });
    const upcoming = event({ id: "upcoming", name: "Upcoming", startsAt: new Date("2026-08-20T17:00:00.000Z"), endsAt: new Date("2026-08-21T20:00:00.000Z") });
    const undated = event({ id: "undated", name: "Undated", startsAt: null, endsAt: null });
    const complete = event({ id: "complete", name: "Complete", startsAt: new Date("2026-07-01T17:00:00.000Z"), endsAt: new Date("2026-07-02T20:00:00.000Z") });

    expect(prioritizeEvents([complete, undated, upcoming, live], now).map(({ id }) => id))
      .toEqual(["live", "upcoming", "undated", "complete"]);
    expect(eventPhase(live, now)).toBe("live");
    expect(eventPhase(undated, now)).toBe("needs-dates");
  });

  it("formats missing and single-day dates without leaking the browser timezone", () => {
    expect(formatEventDates(event({ startsAt: null, endsAt: null }))).toBe("Dates not set");
    expect(formatEventDates(event({
      startsAt: new Date("2026-09-14T16:00:00.000Z"),
      endsAt: new Date("2026-09-15T02:00:00.000Z"),
    }))).toBe("Sep 14, 2026");
  });

  it("generates editable URL slugs from event names", () => {
    expect(slugifyEventName("  Café & Cloud Summit 2026!  ")).toBe("cafe-cloud-summit-2026");
  });

  it("decodes canonical event dates from the list endpoint", async () => {
    const payload = {
      ...event(),
      startsAt: "2026-09-14T16:00:00.000Z",
      endsAt: "2026-09-15T23:00:00.000Z",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([payload]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const [loaded] = await fetchEvents();

    expect(loaded?.startsAt).toEqual(new Date(payload.startsAt));
    expect(loaded?.updatedAt).toEqual(new Date(payload.updatedAt));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/events",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("decodes independent event access relationships for the signed-in home", async () => {
    const eventPayload = {
      ...event(),
      startsAt: "2026-09-14T16:00:00.000Z",
      endsAt: "2026-09-15T23:00:00.000Z",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      event: eventPayload,
      memberRole: "owner",
      speakerPortal: true,
    }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const [loaded] = await fetchEventAccess();

    expect(loaded).toMatchObject({ memberRole: "owner", speakerPortal: true });
    expect(loaded?.event.startsAt).toEqual(new Date(eventPayload.startsAt));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/me/events",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });
});
