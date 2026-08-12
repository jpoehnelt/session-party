import { describe, expect, it } from "vitest";
import type { PublishedAgenda } from "@/features/agenda/schema";
import type { PublicSpeakerGallery } from "@/features/portal/schema";
import {
  canonicalPublicUrl,
  jsonLdScript,
  publicProgramMetadata,
  unavailablePublicMetadata,
} from "./public-metadata";

const agenda: PublishedAgenda = {
  eventId: "event-ai-engineer-sandbox",
  eventName: "AI Engineer Sandbox",
  eventSlug: "ai-engineer-sandbox",
  timezone: "America/Denver",
  location: "Denver Union Station",
  revision: 3,
  publishedAt: Date.UTC(2026, 7, 12, 16),
  talks: [
    {
      id: "talk-effects",
      title: "Effects <at scale>",
      description: "Failure-aware systems without folklore.",
      trackId: "track-systems",
      track: "Systems",
      room: "Main hall",
      startsAt: Date.UTC(2026, 7, 13, 16),
      durationMin: 45,
      speakerNames: ["Ada Rivera"],
      speakers: [{ id: "speaker-ada", name: "Ada Rivera", profileSlug: "ada-rivera" }],
    },
  ],
};

const gallery: PublicSpeakerGallery = {
  event: {
    id: agenda.eventId,
    slug: agenda.eventSlug,
    name: agenda.eventName,
    description: "A gathering for people who build reliable AI systems.",
    location: agenda.location,
    timezone: agenda.timezone,
    startsAt: Date.UTC(2026, 7, 13, 16),
    endsAt: Date.UTC(2026, 7, 13, 23),
    bannerAssetId: null,
    accentColor: "#6c3bf4",
  },
  speakers: [
    {
      id: "speaker-ada",
      displayName: "Ada Rivera",
      title: "Staff Engineer",
      company: "Reliable Systems",
      bio: "Ada builds failure-aware platforms.",
      headshotUrl: "https://assets.example.test/ada.jpg",
      publicProfileSlug: "ada-rivera",
      links: [{ label: "Website", url: "https://ada.example.test" }],
    },
  ],
};

describe("publicProgramMetadata", () => {
  it("uses the event and public surface in share metadata", () => {
    expect(publicProgramMetadata(
      "/event/ai-engineer-sandbox/gallery",
      { gallery },
      "https://sessionparty.com/event/ai-engineer-sandbox/gallery",
    )).toMatchObject({
      title: "Speaker gallery — AI Engineer Sandbox — Session Party",
      description: gallery.event.description,
      canonicalUrl: "https://sessionparty.com/event/ai-engineer-sandbox/gallery",
      robots: "index, follow",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        mainEntity: { "@type": "ItemList", numberOfItems: 1 },
      },
    });
  });

  it("emits schema.org Event sessions from only the published agenda DTO", () => {
    const metadata = publicProgramMetadata(
      "/event/ai-engineer-sandbox/agenda",
      { agenda },
      "https://sessionparty.com/event/ai-engineer-sandbox/agenda",
    );
    const jsonLd = metadata.jsonLd as Record<string, unknown>;
    const sessions = jsonLd.subEvent as Array<Record<string, unknown>>;

    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Event",
      name: agenda.eventName,
      startDate: new Date(agenda.talks[0]!.startsAt).toISOString(),
      location: { "@type": "Place", name: agenda.location },
    });
    expect(sessions).toEqual([
      expect.objectContaining({
        "@type": "Event",
        name: "Effects <at scale>",
        duration: "PT45M",
        performer: [{ "@type": "Person", name: "Ada Rivera" }],
      }),
    ]);
    expect(JSON.stringify(jsonLd)).not.toMatch(/email|review|submissionId|headshot|image/i);
  });

  it("uses detail-specific metadata and JSON-LD for sessions and speakers", () => {
    const session = publicProgramMetadata(
      "/event/ai-engineer-sandbox/sessions/talk-effects",
      { agenda },
      "https://sessionparty.com/event/ai-engineer-sandbox/sessions/talk-effects",
    );
    const speaker = publicProgramMetadata(
      "/event/ai-engineer-sandbox/speakers/speaker-ada",
      { gallery },
      "https://sessionparty.com/event/ai-engineer-sandbox/speakers/speaker-ada",
    );

    expect(session).toMatchObject({
      title: "Effects <at scale> — AI Engineer Sandbox — Session Party",
      jsonLd: { "@context": "https://schema.org", "@type": "Event" },
    });
    expect(speaker).toMatchObject({
      title: "Ada Rivera — AI Engineer Sandbox — Session Party",
      description: "Ada builds failure-aware platforms.",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        mainEntity: {
          "@type": "Person",
          name: "Ada Rivera",
          jobTitle: "Staff Engineer",
          worksFor: { "@type": "Organization", name: "Reliable Systems" },
        },
      },
    });
    expect(JSON.stringify(speaker.jsonLd)).not.toContain("headshotUrl");
    expect(JSON.stringify(speaker.jsonLd)).not.toContain("image");
  });

  it("canonicalizes embeds to full public pages and keeps them out of search indexes", () => {
    const embedUrl = new URL("https://sessionparty.com/embed/ai-engineer-sandbox/schedule?aesthetic=minimal");
    const canonicalUrl = canonicalPublicUrl(embedUrl);
    const metadata = publicProgramMetadata(embedUrl.pathname, { agenda }, canonicalUrl);

    expect(canonicalUrl).toBe("https://sessionparty.com/event/ai-engineer-sandbox/agenda");
    expect(metadata).toMatchObject({
      title: "Schedule itinerary — AI Engineer Sandbox — Session Party",
      robots: "noindex, follow",
    });
    expect(canonicalPublicUrl(new URL("https://sessionparty.com/embed/ai-engineer-sandbox/speakers")))
      .toBe("https://sessionparty.com/event/ai-engineer-sandbox/gallery");
  });

  it("marks unavailable public pages noindex and safely serializes JSON-LD", () => {
    expect(unavailablePublicMetadata(
      "/event/missing/agenda",
      "https://sessionparty.com/event/missing/agenda",
    )).toMatchObject({
      title: "Agenda unavailable — Session Party",
      robots: "noindex, nofollow",
      jsonLd: null,
    });

    const script = jsonLdScript(publicProgramMetadata(
      "/event/ai-engineer-sandbox/agenda",
      { agenda },
      "https://sessionparty.com/event/ai-engineer-sandbox/agenda",
    ));
    expect(script).toContain('type="application/ld+json"');
    expect(script).toContain("Effects \\u003cat scale>");
    expect(script).not.toContain("<at scale>");
  });
});
