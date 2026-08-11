import type { PublishedAgenda } from "@/features/agenda/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it } from "vitest";
import { PublishedSchedule } from "./PublishedSchedule";

const FIXED_NOW = Date.UTC(2026, 7, 8, 18, 0, 0);
const STARTS_AT = Date.UTC(2026, 7, 10, 16, 0, 0);

const agenda: PublishedAgenda = {
  eventId: "render-event",
  eventName: "Render Summit",
  eventSlug: "render-summit",
  timezone: "America/Los_Angeles",
  location: "Harbor Hall",
  revision: 2,
  publishedAt: FIXED_NOW,
  talks: [
    {
      id: "render-talk-1",
      title: "Immutable systems",
      description: "How to publish without leaking drafts.",
      track: "Systems",
      room: "Harbor",
      startsAt: STARTS_AT,
      durationMin: 45,
      speakerNames: ["Ada Rivera"],
      speakers: [{ id: "speaker/ada", name: "Ada Rivera", profileSlug: "ada-rivera" }],
    },
    {
      id: "render-talk-2",
      title: "Practical program design",
      description: null,
      track: "Product",
      room: "Gallery",
      startsAt: STARTS_AT + 86_400_000,
      durationMin: 30,
      speakerNames: ["Grace Lee"],
      speakerProfiles: [{ name: "Grace Lee", slug: "grace-lee" }],
    },
    {
      id: "render-talk-3",
      title: "Closing session",
      description: null,
      track: null,
      room: null,
      startsAt: STARTS_AT + 8 * 86_400_000,
      durationMin: 20,
      speakerNames: [],
    },
  ],
};

describe("published schedule rendering", () => {
  it.each(["list", "day", "week", "track", "room"] as const)(
    "renders the public %s view from the canonical published DTO",
    (initialView) => {
      const markup = renderToStaticMarkup(createElement(PublishedSchedule, {
        agenda,
        initialView,
      }));
      expect(markup).toContain("Immutable systems");
      expect(markup).toContain("Ada Rivera");
      expect(markup).toContain("America/Los_Angeles");
      expect(markup).toContain("Systems");
      expect(markup).toContain("Harbor");
      expect(markup).toContain("<ol");
      expect(markup).toContain('href="/event/render-summit/sessions/render-talk-1"');
      expect(markup).toContain('href="/event/render-summit/speakers/speaker%2Fada"');
      expect(markup).toContain('href="/speakers/grace-lee"');
      expect(markup).not.toContain('href="/speakers/ada-rivera"');
      expect(markup).not.toContain("<table");
      expect(markup).not.toContain("submissionId");
      expect(markup).not.toContain("version");
      if (initialView === "track") expect(markup).toContain("Unassigned track");
      if (initialView === "room") expect(markup).toContain("Unassigned room");
    },
  );

  it("renders a truthful empty published revision", () => {
    const markup = renderToStaticMarkup(createElement(PublishedSchedule, {
      agenda: { ...agenda, talks: [] },
    }));
    expect(markup).toContain("Schedule coming soon");
    expect(markup).toContain("no sessions have been added");
  });

  it("uses an ungrouped schedule when time is excluded", () => {
    const markup = renderToStaticMarkup(createElement(PublishedSchedule, {
      agenda,
      initialView: "day",
      includedFields: ["title", "track", "room"],
    }));
    expect(markup).toContain("Immutable systems");
    expect(markup).not.toContain("Audience clock");
    expect(markup).not.toContain("America/Los_Angeles");
    expect(markup).not.toContain(">Day<");
    expect(markup).not.toContain(">Week<");
    expect(markup).not.toContain("schedule-group-");
    expect(markup).toContain('aria-label="All sessions"');
  });

  it("links duplicate display names by stable event-speaker identity", () => {
    const markup = renderToStaticMarkup(createElement(PublishedSchedule, {
      agenda: {
        ...agenda,
        talks: [{
          ...agenda.talks[0]!,
          speakerNames: ["Alex Kim", "Alex Kim"],
          speakers: [
            { id: "speaker-alex-one", name: "Alex Kim" },
            { id: "speaker-alex-two", name: "Alex Kim" },
          ],
        }],
      },
    }));

    expect(markup).toContain('href="/event/render-summit/speakers/speaker-alex-one"');
    expect(markup).toContain('href="/event/render-summit/speakers/speaker-alex-two"');
  });
});
