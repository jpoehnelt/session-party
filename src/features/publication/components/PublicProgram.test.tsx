import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { PublishedAgenda } from "@/features/agenda/schema";
import type { PublicSpeakerGallery } from "@/features/portal/schema";
import {
  PublicProgram,
  publicSurfaceFromSplat,
  sessionMatches,
  sortPublicSpeakers,
} from "./PublicProgram";
import { EmbedManager, stableEmbedCode, stableEmbedPath } from "./EmbedManager";

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

const render = (surface: Parameters<typeof PublicProgram>[0]["surface"]) =>
  renderToStaticMarkup(createElement(MemoryRouter, {
    children: createElement(PublicProgram, { agenda, gallery, surface }),
  }));

describe("public program", () => {
  it("maps conventional public routes to discoverable surfaces", () => {
    expect(publicSurfaceFromSplat(undefined)).toBe("sessions");
    expect(publicSurfaceFromSplat("agenda")).toBe("agenda");
    expect(publicSurfaceFromSplat("schedule/details")).toBe("schedule");
    expect(publicSurfaceFromSplat("unknown")).toBe("sessions");
  });

  it("searches sessions by title or speaker and applies facets", () => {
    expect(sessionMatches(agenda.talks[0]!, "40-minute", "", "")).toBe(true);
    expect(sessionMatches(agenda.talks[0]!, "priya", "", "")).toBe(true);
    expect(sessionMatches(agenda.talks[0]!, "priya", "Platform & Infra", "Main Stage")).toBe(true);
    expect(sessionMatches(agenda.talks[0]!, "priya", "Developer Experience", "")).toBe(false);
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

  it("presents two widgets with presets and separates feeds from embed code", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, {
      children: createElement(EmbedManager, { agenda }),
    }));
    expect(markup).toContain("Schedule widget");
    expect(markup).toContain("Speaker gallery widget");
    expect(markup).toContain("Preset");
    expect(markup).toContain("Public links");
    expect(markup).toContain("Feeds &amp; integrations");
    expect(markup).toContain("These are feeds, not widgets");
    expect(markup).not.toContain("Output format");
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
});
