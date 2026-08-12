import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedAgenda } from "@/features/agenda/schema";
import { getPublicSchedule, PublicationApiError } from "../api";
import { embedContentFromSearch, filterPublishedAgenda } from "../embed-content";
import {
  default as ScheduleEmbedPage,
  layout,
  path,
  ScheduleEmbedContent,
  scheduleLoadError,
} from "./schedule-embed";

const agenda: PublishedAgenda = {
  eventId: "event-public-schedule",
  eventName: "Systems Summit",
  eventSlug: "systems-summit",
  timezone: "America/Los_Angeles",
  location: "Harbor Hall",
  revision: 3,
  publishedAt: Date.UTC(2026, 7, 9, 18),
  talks: [
    {
      id: "talk-effects",
      title: "Effects at scale",
      description: "Ship reliable systems without leaking drafts.",
      track: "Systems",
      room: "Harbor",
      startsAt: Date.UTC(2026, 7, 10, 16),
      durationMin: 45,
      speakerNames: ["Ada Rivera"],
      speakers: [{ id: "speaker-ada", name: "Ada Rivera" }],
    },
  ],
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const render = (props: Parameters<typeof ScheduleEmbedContent>[0]) =>
  renderToStaticMarkup(createElement(ScheduleEmbedContent, props));

const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public schedule route", () => {
  it("owns the bare schedule embed route and loads the canonical agenda slug endpoint", async () => {
    const fetchMock = vi.fn(async () => response(agenda));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicSchedule(agenda.eventSlug)).resolves.toEqual(agenda);
    expect(path).toBe("/embed/:eventSlug/schedule");
    expect(layout).toBe("bare");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/public/events/${agenda.eventSlug}/agenda/published`,
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it.each([
    ["an unpublished event", "published agenda not found"],
    ["a missing event", "event not found"],
  ])("fails closed for %s", async (_case, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ message }, 404)));

    const failure = await getPublicSchedule(agenda.eventSlug).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(PublicationApiError);
    expect(failure).toMatchObject({ status: 404 });
    expect(scheduleLoadError(failure)).toEqual({ kind: "unavailable" });

    const markup = render({ agenda: null, error: scheduleLoadError(failure), onRetry: noop });
    expect(markup).toContain("<h1");
    expect(markup).toContain("Schedule not published");
    expect(markup).not.toContain(message);
  });

  it("renders an empty published revision truthfully", () => {
    const markup = render({ agenda: { ...agenda, talks: [] }, error: null, onRetry: noop });

    expect(markup).toContain("<h1");
    expect(markup).toContain("Systems Summit");
    expect(markup).toContain("Schedule coming soon");
    expect(markup).toContain("no sessions have been added");
    expect(markup).toContain("Updated ");
    expect(markup).not.toContain("Live revision");
    expect(markup).not.toContain("Schedule revision");
  });

  it("renders the selected aesthetic and brand color inside the embed", () => {
    const markup = render({
      agenda,
      error: null,
      onRetry: noop,
      design: { aesthetic: "editorial", accent: "#0A6B58" },
    });

    expect(markup).toContain('data-embed-aesthetic="editorial"');
    expect(markup).toContain("--color-accent:#0A6B58");
    expect(markup).toContain("font-serif");
    expect(markup).toContain('href="/event/systems-summit/speakers/speaker-ada"');
  });

  it("enforces track and included-field parameters in the rendered embed", () => {
    const second = {
      ...agenda.talks[0]!,
      id: "talk-product",
      title: "Product systems",
      description: "This description must stay filtered.",
      track: "Product",
      room: "Cove",
      speakerNames: ["Lin Chen"],
    };
    const selection = embedContentFromSearch("?track=Systems&fields=title,time,unknown");
    const filtered = filterPublishedAgenda({ ...agenda, talks: [...agenda.talks, second] }, selection.track);
    const markup = render({ agenda: filtered, error: null, onRetry: noop, includedFields: selection.fields });

    expect(markup).toContain("Effects at scale");
    expect(markup).not.toContain("Product systems");
    expect(markup).not.toContain("Ship reliable systems");
    expect(markup).not.toContain("Ada Rivera");
  });

  it("wires aesthetic query parameters from the public route into the embed", () => {
    const markup = renderToStaticMarkup(createElement(
      MemoryRouter,
      { initialEntries: ["/embed/systems-summit/schedule?aesthetic=minimal&accent=%23005A9C"] },
      createElement(
        Routes,
        null,
        createElement(Route, { path, element: createElement(ScheduleEmbedPage) }),
      ),
    ));

    expect(markup).toContain('data-embed-aesthetic="minimal"');
    expect(markup).toContain("--color-accent:#005A9C");
  });

  it("rejects a projection whose revision does not match organizer publication state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(agenda)));

    await expect(getPublicSchedule(agenda.eventSlug, {
      eventId: agenda.eventId,
      revision: agenda.revision + 1,
    })).rejects.toThrow("Published schedule revision does not match the current public revision");
  });

  it("rejects a projection returned for a different slug", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...agenda, eventSlug: "other-event" })));

    await expect(getPublicSchedule(agenda.eventSlug)).rejects.toThrow(
      "Published schedule event slug does not match the requested event",
    );
  });
});
