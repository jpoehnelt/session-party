import type { PublishedAgenda, PublicAgendaTalk } from "@/features/agenda/schema";
import type { PublicSpeaker, PublicSpeakerGallery } from "@/features/portal/schema";

export interface PublicPageData {
  readonly agenda?: PublishedAgenda;
  readonly gallery?: PublicSpeakerGallery;
}

export interface PublicPageMetadata {
  readonly title: string;
  readonly description: string;
  readonly canonicalUrl: string;
  readonly robots: "index, follow" | "noindex, follow" | "noindex, nofollow";
  readonly jsonLd: Readonly<Record<string, unknown>> | null;
}

const publicSurfaceLabels: Readonly<Record<string, string>> = {
  sessions: "Sessions",
  speakers: "Speakers",
  agenda: "Agenda",
  schedule: "Schedule itinerary",
  gallery: "Speaker gallery",
};

const segments = (pathname: string): readonly string[] => pathname.split("/").filter(Boolean);
const segment = (value: string): string => encodeURIComponent(value);
const absoluteUrl = (origin: string, pathname: string): string => new URL(pathname, origin).toString();

export const publicSurface = (pathname: string): string =>
  segments(pathname).at(2) ?? "sessions";

export const isSpeakerSurface = (pathname: string): boolean => {
  const surface = publicSurface(pathname);
  return surface === "speakers" || surface === "gallery";
};

const publicProgramUrl = (origin: string, eventSlug: string, surface: "agenda" | "gallery") =>
  absoluteUrl(origin, `/event/${segment(eventSlug)}/${surface}`);

export const canonicalPublicUrl = (url: URL): string => {
  const [root, eventSlug, surface] = segments(url.pathname);
  if (root !== "embed" || !eventSlug) return `${url.origin}${url.pathname}`;
  if (surface === "schedule") return publicProgramUrl(url.origin, eventSlug, "agenda");
  if (surface === "speakers") return publicProgramUrl(url.origin, eventSlug, "gallery");
  return `${url.origin}${url.pathname}`;
};

const location = (name: string | null | undefined) =>
  name ? { "@type": "Place", name } : undefined;

const personNames = (talk: PublicAgendaTalk): readonly string[] => {
  const named = talk.speakers?.map(({ name }) => name)
    ?? talk.speakerProfiles?.map(({ name }) => name)
    ?? talk.speakerNames;
  return [...new Set(named)].sort((left, right) => left.localeCompare(right));
};

const sessionUrl = (origin: string, agenda: PublishedAgenda, talk: PublicAgendaTalk): string =>
  absoluteUrl(origin, `/event/${segment(agenda.eventSlug)}/sessions/${segment(talk.id)}`);

const sessionJsonLd = (
  origin: string,
  agenda: PublishedAgenda,
  talk: PublicAgendaTalk,
): Readonly<Record<string, unknown>> => {
  const place = location([talk.room, agenda.location].filter(Boolean).join(" · "));
  const speakers = personNames(talk);
  return {
    "@type": "Event",
    "@id": `${sessionUrl(origin, agenda, talk)}#event`,
    name: talk.title,
    ...(talk.description ? { description: talk.description } : {}),
    url: sessionUrl(origin, agenda, talk),
    startDate: new Date(talk.startsAt).toISOString(),
    endDate: new Date(talk.startsAt + talk.durationMin * 60_000).toISOString(),
    duration: `PT${talk.durationMin}M`,
    eventStatus: "https://schema.org/EventScheduled",
    ...(place ? { location: place } : {}),
    ...(speakers.length > 0
      ? { performer: speakers.map((name) => ({ "@type": "Person", name })) }
      : {}),
  };
};

const eventJsonLd = (agenda: PublishedAgenda, origin: string): Readonly<Record<string, unknown>> => {
  const talks = [...agenda.talks].sort((left, right) => left.startsAt - right.startsAt);
  const startsAt = talks[0]?.startsAt;
  const endsAt = talks.reduce(
    (latest, talk) => Math.max(latest, talk.startsAt + talk.durationMin * 60_000),
    startsAt ?? 0,
  );
  const url = publicProgramUrl(origin, agenda.eventSlug, "agenda");
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    "@id": `${url}#event`,
    name: agenda.eventName,
    description: `${agenda.eventName}: the current published event program.`,
    url,
    eventStatus: "https://schema.org/EventScheduled",
    ...(agenda.location ? { location: location(agenda.location) } : {}),
    ...(startsAt === undefined
      ? {}
      : {
          startDate: new Date(startsAt).toISOString(),
          endDate: new Date(endsAt).toISOString(),
        }),
    subEvent: talks.map((talk) => sessionJsonLd(origin, agenda, talk)),
  };
};

const speakerUrl = (origin: string, gallery: PublicSpeakerGallery, speaker: PublicSpeaker): string =>
  absoluteUrl(origin, `/event/${segment(gallery.event.slug)}/speakers/${segment(speaker.id)}`);

const speakerJsonLd = (
  origin: string,
  gallery: PublicSpeakerGallery,
  speaker: PublicSpeaker,
): Readonly<Record<string, unknown>> => ({
  "@type": "Person",
  "@id": `${speakerUrl(origin, gallery, speaker)}#person`,
  name: speaker.displayName,
  url: speakerUrl(origin, gallery, speaker),
  ...(speaker.bio ? { description: speaker.bio } : {}),
  ...(speaker.title ? { jobTitle: speaker.title } : {}),
  ...(speaker.company ? { worksFor: { "@type": "Organization", name: speaker.company } } : {}),
  ...(speaker.links.length > 0 ? { sameAs: speaker.links.map(({ url }) => url) } : {}),
});

const speakerCollectionJsonLd = (
  gallery: PublicSpeakerGallery,
  origin: string,
  canonicalUrl: string,
): Readonly<Record<string, unknown>> => ({
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "@id": `${canonicalUrl}#page`,
  name: `${gallery.event.name} speakers`,
  url: canonicalUrl,
  about: {
    "@type": "Event",
    "@id": `${publicProgramUrl(origin, gallery.event.slug, "agenda")}#event`,
    name: gallery.event.name,
    ...(gallery.event.startsAt !== null ? { startDate: new Date(gallery.event.startsAt).toISOString() } : {}),
    ...(gallery.event.endsAt !== null ? { endDate: new Date(gallery.event.endsAt).toISOString() } : {}),
    ...(gallery.event.location ? { location: location(gallery.event.location) } : {}),
  },
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: gallery.speakers.length,
    itemListElement: gallery.speakers.map((speaker, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: speakerJsonLd(origin, gallery, speaker),
    })),
  },
});

const detailId = (pathname: string): string | undefined => segments(pathname).at(3);

export function publicProgramMetadata(
  pathname: string,
  data: PublicPageData,
  canonicalUrl: string,
): PublicPageMetadata {
  const surface = publicSurface(pathname);
  const label = publicSurfaceLabels[surface] ?? "Sessions";
  const eventName = data.agenda?.eventName ?? data.gallery?.event.name ?? "Published event";
  const origin = new URL(canonicalUrl).origin;
  const isEmbed = pathname.startsWith("/embed/");
  const id = detailId(pathname);
  const talk = surface === "sessions" && id
    ? data.agenda?.talks.find(({ id: talkId }) => talkId === id)
    : undefined;
  const speaker = surface === "speakers" && id
    ? data.gallery?.speakers.find(({ id: speakerId }) => speakerId === id)
    : undefined;

  if (talk && data.agenda) {
    return {
      title: `${talk.title} — ${eventName} — Session Party`,
      description: talk.description ?? `${talk.title}, a published session at ${eventName}.`,
      canonicalUrl,
      robots: isEmbed ? "noindex, follow" : "index, follow",
      jsonLd: {
        "@context": "https://schema.org",
        ...sessionJsonLd(origin, data.agenda, talk),
        superEvent: {
          "@type": "Event",
          "@id": `${publicProgramUrl(origin, data.agenda.eventSlug, "agenda")}#event`,
          name: eventName,
        },
      },
    };
  }

  if (speaker && data.gallery) {
    return {
      title: `${speaker.displayName} — ${eventName} — Session Party`,
      description: speaker.bio ?? `${speaker.displayName}, a published speaker at ${eventName}.`,
      canonicalUrl,
      robots: isEmbed ? "noindex, follow" : "index, follow",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        "@id": `${canonicalUrl}#page`,
        url: canonicalUrl,
        mainEntity: speakerJsonLd(origin, data.gallery, speaker),
      },
    };
  }

  const galleryDescription = data.gallery?.event.description;
  return {
    title: `${label} — ${eventName} — Session Party`,
    description: galleryDescription ?? `${eventName} ${label.toLowerCase()}: the current published event program.`,
    canonicalUrl,
    robots: isEmbed ? "noindex, follow" : "index, follow",
    jsonLd: data.gallery
      ? speakerCollectionJsonLd(data.gallery, origin, canonicalUrl)
      : data.agenda ? eventJsonLd(data.agenda, origin) : null,
  };
}

export const unavailablePublicMetadata = (
  pathname: string,
  canonicalUrl: string,
): PublicPageMetadata => {
  const label = publicSurfaceLabels[publicSurface(pathname)] ?? "Published program";
  return {
    title: `${label} unavailable — Session Party`,
    description: "This public event page is not currently available.",
    canonicalUrl,
    robots: "noindex, nofollow",
    jsonLd: null,
  };
};

export const embeddedProgramMetadata = (canonicalUrl: string): PublicPageMetadata => ({
  title: "Embedded event program — Session Party",
  description: "An embedded public event program powered by Session Party.",
  canonicalUrl,
  robots: "noindex, nofollow",
  jsonLd: null,
});

export const jsonLdScript = (metadata: PublicPageMetadata): string =>
  metadata.jsonLd
    ? `<script id="session-party-json-ld" type="application/ld+json">${JSON.stringify(metadata.jsonLd).replaceAll("<", "\\u003c")}</script>`
    : "";
