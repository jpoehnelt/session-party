import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { PublishedAgenda } from "@/features/agenda/schema";
import type { PublicSpeakerGallery } from "@/features/portal/schema";
import {
  PublicProgram,
  publicDetailFromSplat,
  publicSurfaceFromSplat,
  sessionMatches,
  sortPublicSpeakers,
} from "./PublicProgram";
import {
  configuredScheduleFeedPath,
  EmbedManager,
  stableEmbedCode,
  stableEmbedPath,
} from "./EmbedManager";

const START = Date.UTC(2027, 4, 12, 16);
const agenda: PublishedAgenda = {
  eventId: "public-event",
  eventName: "DevFlow Conf 2027",
  eventSlug: "devflow-conf-2027",
  timezone: "America/Los_Angeles",
  location: "Moscone West",
  revision: 4,
  publishedAt: Date.UTC(2027, 4, 1),
  talks: [
    {
      id: "talk-ci",
      title: "Taming 40-Minute CI",
      description: "A detailed account of incremental builds, remote caching, and evidence from a large monorepo. Attendees leave with an adoption plan and practical benchmarks.",
      track: "Platform & Infra",
      room: "Main Stage",
      startsAt: START,
      durationMin: 30,
      speakerNames: ["Priya Raman"],
      speakers: [{ id: "speaker-priya", name: "Priya Raman", profileSlug: "priya-raman" }],
      speakerProfiles: [{ name: "Priya Raman", slug: "priya-raman" }],
    },
    {
      id: "talk-docs",
      title: "Docs That Answer Back",
      description: "Retrieval-grounded documentation patterns.",
      track: "Developer Experience",
      room: "Room 2A",
      startsAt: START + 86_400_000,
      durationMin: 45,
      speakerNames: ["Marcus Okafor"],
      speakers: [{ id: "speaker-marcus", name: "Marcus Okafor" }],
    },
  ],
};

const gallery: PublicSpeakerGallery = {
  event: {
    id: agenda.eventId,
    slug: agenda.eventSlug,
    name: agenda.eventName,
    description: "The developer workflow conference",
    location: agenda.location,
    timezone: agenda.timezone,
    startsAt: START,
    endsAt: START + 2 * 86_400_000,
    bannerAssetId: null,
    accentColor: "#635BFF",
  },
  speakers: [
    {
      id: "speaker-priya",
      displayName: "Priya Raman",
      title: "Principal Engineer",
      company: "Latticework Systems",
      bio: "Priya builds high-scale developer infrastructure.",
      headshotUrl: null,
      publicProfileSlug: "priya-raman",
      links: [],
    },
    {
      id: "speaker-marcus",
      displayName: "Marcus Okafor",
      title: "Staff Engineer",
      company: "Northstar",
      bio: null,
      headshotUrl: null,
      links: [],
    },
  ],
};

const render = (surface: Parameters<typeof PublicProgram>[0]["surface"], detail?: Parameters<typeof PublicProgram>[0]["detail"]) =>
  renderToStaticMarkup(createElement(MemoryRouter, {
    children: createElement(PublicProgram, { agenda, gallery, surface, detail }),
  }));

describe("public program", () => {
  it("maps conventional public routes to discoverable surfaces", () => {
    expect(publicSurfaceFromSplat(undefined)).toBe("sessions");
    expect(publicSurfaceFromSplat("agenda")).toBe("agenda");
    expect(publicSurfaceFromSplat("schedule/details")).toBe("schedule");
    expect(publicSurfaceFromSplat("unknown")).toBe("sessions");
    expect(publicDetailFromSplat("sessions/talk-ci")).toEqual({ sessionId: "talk-ci" });
    expect(publicDetailFromSplat("speakers/speaker-marcus")).toEqual({ speakerId: "speaker-marcus" });
  });

  it("searches sessions by title or speaker and applies facets", () => {
    expect(sessionMatches(agenda.talks[0]!, "40-minute", "", "", "")).toBe(true);
    expect(sessionMatches(agenda.talks[0]!, "priya", "", "", "")).toBe(true);
    expect(sessionMatches(agenda.talks[0]!, "priya", "Platform & Infra", "30", "Main Stage")).toBe(true);
    expect(sessionMatches(agenda.talks[0]!, "priya", "Platform & Infra", "45", "Main Stage")).toBe(false);
    expect(sessionMatches(agenda.talks[0]!, "priya", "Developer Experience", "", "")).toBe(false);
  });

  it("orders the directory by surname", () => {
    expect(sortPublicSpeakers(gallery.speakers).map(({ displayName }) => displayName)).toEqual([
      "Marcus Okafor",
      "Priya Raman",
    ]);
  });

  it("renders a populated, navigable sessions list from canonical public DTOs", () => {
    const markup = render("sessions");
    expect(markup).toContain("Public event navigation");
    expect(markup).toContain("Schedule itinerary");
    expect(markup).toContain("Speaker gallery");
    expect(markup).toContain("Taming 40-Minute CI");
    expect(markup).toContain("Priya Raman");
    expect(markup).toContain("Principal Engineer at Latticework Systems");
    expect(markup).toContain("Format · 30 minutes");
    expect(markup).toContain("Show more");
    expect(markup).toContain("2 sessions");
    expect(markup).toContain('href="/event/devflow-conf-2027/sessions/talk-ci?from=sessions"');
    expect(markup).toContain('href="/event/devflow-conf-2027/speakers/speaker-marcus"');
  });

  it("renders bookmarkable session and event-speaker detail pages", () => {
    const sessionMarkup = render("sessions", { sessionId: "talk-ci" });
    expect(sessionMarkup).toContain("Session detail");
    expect(sessionMarkup).toContain("Back to sessions");
    expect(sessionMarkup).not.toContain("Retrieval-grounded");

    const speakerMarkup = render("speakers", { speakerId: "speaker-marcus" });
    expect(speakerMarkup).toContain("Speaker detail");
    expect(speakerMarkup).toContain("Docs That Answer Back");
    expect(speakerMarkup).toContain('href="/event/devflow-conf-2027/sessions/talk-docs"');
  });

  it("renders itinerary controls and a calendar export affordance", () => {
    const markup = render("schedule");
    expect(markup).toContain("My schedule (0)");
    expect(markup).toContain("Add to my schedule");
    expect(markup).toContain("Subscribe / download (.ics)");
    expect(markup).toContain(`/events/${agenda.eventSlug}/schedule.ics`);
    expect(markup).toContain(`/events/${agenda.eventSlug}/schedule.json`);
    expect(markup).toContain("Principal Engineer at Latticework Systems");
  });

  it("keeps embed management off public program routes", () => {
    expect(publicSurfaceFromSplat("widgets")).toBe("sessions");
    expect(render(publicSurfaceFromSplat("widgets"))).not.toContain("Create an embed");
  });

  it("presents configurable widget presets and every supported handoff format", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, {
      children: createElement(EmbedManager, { agenda }),
    }));
    expect(markup).toContain("Schedule widget");
    expect(markup).toContain("Speaker gallery widget");
    expect(markup).toContain("Preset");
    expect(markup).toContain("Public links");
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Agenda");
    expect(markup).toContain("Schedule itinerary");
    expect(markup).toContain("Speaker gallery widget");
    expect(markup).toContain("Output formats");
    expect(markup).toContain("Copy basic HTML");
    expect(markup).toContain("Copy JSON feed");
    expect(markup).toContain("Copy XML feed");
    expect(markup).toContain("Copy iCalendar feed");
  });

  it("generates stable, lazy iframe code from persisted definitions", () => {
    const definition = {
      id: "embed-main",
      name: "Main schedule",
      eventSlug: agenda.eventSlug,
    };
    expect(stableEmbedPath(definition)).toBe("/embed/devflow-conf-2027/embed-main");
    expect(stableEmbedCode(definition, "https://sessionparty.com")).toContain('loading="lazy"');
    expect(stableEmbedCode(definition, "https://sessionparty.com")).toContain("min-height:720px");
  });

  it("projects the selected track and fields into every schedule feed URL", () => {
    expect(configuredScheduleFeedPath(
      "/events/devflow-conf-2027/schedule.xml",
      "Platform & Infra",
      new Set(["title", "room"]),
    )).toBe(
      "/events/devflow-conf-2027/schedule.xml?track=Platform+%26+Infra&fields=title%2Croom",
    );
  });

  it("keeps session and speaker identity consistent across public surfaces and organizer source", () => {
    const sourceTalk = agenda.talks[0]!;
    for (const surface of ["sessions", "agenda", "schedule"] as const) {
      const markup = render(surface);
      expect(markup).toContain(sourceTalk.title);
      expect(markup).toContain(sourceTalk.room);
      expect(markup).toContain(sourceTalk.track?.replaceAll("&", "&amp;"));
      expect(markup).toContain(sourceTalk.speakerNames[0]);
    }
    for (const surface of ["speakers", "gallery"] as const) {
      const markup = render(surface);
      expect(markup).toContain("Priya Raman");
      expect(markup).toContain("Principal Engineer");
      expect(markup).toContain("Latticework Systems");
    }
  });

  it("prefers event-speaker details across every public program surface", () => {
    for (const surface of ["sessions", "agenda", "schedule", "speakers", "gallery"] as const) {
      expect(render(surface)).toContain('href="/event/devflow-conf-2027/speakers/speaker-priya');
    }
  });

  it("keeps duplicate display names attached to the correct speaker detail", () => {
    const duplicateAgenda: PublishedAgenda = {
      ...agenda,
      talks: [
        { ...agenda.talks[0]!, id: "talk-alex-one", title: "First Alex session", speakerNames: ["Alex Kim"], speakers: [{ id: "speaker-alex-one", name: "Alex Kim" }] },
        { ...agenda.talks[1]!, id: "talk-alex-two", title: "Second Alex session", speakerNames: ["Alex Kim"], speakers: [{ id: "speaker-alex-two", name: "Alex Kim" }] },
      ],
    };
    const duplicateGallery: PublicSpeakerGallery = {
      ...gallery,
      speakers: [
        { ...gallery.speakers[0]!, id: "speaker-alex-one", displayName: "Alex Kim" },
        { ...gallery.speakers[1]!, id: "speaker-alex-two", displayName: "Alex Kim" },
      ],
    };
    const markup = renderToStaticMarkup(createElement(MemoryRouter, {
      children: createElement(PublicProgram, {
        agenda: duplicateAgenda,
        gallery: duplicateGallery,
        surface: "speakers",
        detail: { speakerId: "speaker-alex-one" },
      }),
    }));

    expect(markup).toContain("First Alex session");
    expect(markup).not.toContain("Second Alex session");
  });
});
