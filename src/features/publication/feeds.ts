import type { PublicAgendaTalk, PublishedAgenda } from "@/features/agenda/schema";
import { stableCalendarUid } from "@/features/comms/calendar";
import { SCHEDULE_EMBED_FIELDS, type ScheduleEmbedField } from "./embed-content";

const calendarTimestamp = (timestamp: number): string =>
  new Date(timestamp).toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");

const escapeCalendarText = (value: string): string => value
  .replaceAll("\\", "\\\\")
  .replaceAll("\r\n", "\\n")
  .replaceAll("\n", "\\n")
  .replaceAll("\r", "\\n")
  .replaceAll(",", "\\,")
  .replaceAll(";", "\\;");

const foldCalendarLine = (line: string): string => {
  let folded = "";
  let physicalLine = "";
  let octets = 0;
  for (const character of line) {
    const codePoint = character.codePointAt(0)!;
    const characterOctets = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (octets + characterOctets > 75 && physicalLine.length > 0) {
      folded += `${physicalLine}\r\n`;
      physicalLine = ` ${character}`;
      octets = 1 + characterOctets;
    } else {
      physicalLine += character;
      octets += characterOctets;
    }
  }
  return folded + physicalLine;
};

const descriptionFor = (talk: PublicAgendaTalk, visible: ReadonlySet<ScheduleEmbedField>): string | null => {
  const speakers = visible.has("speakers") && talk.speakerNames.length > 0
    ? `Speakers: ${talk.speakerNames.join(", ")}`
    : null;
  return [visible.has("description") ? talk.description : null, speakers]
    .filter((value): value is string => Boolean(value)).join("\n\n") || null;
};

const locationFor = (agenda: PublishedAgenda, talk: PublicAgendaTalk): string | null => {
  if (talk.room && agenda.location && talk.room !== agenda.location) {
    return `${talk.room}, ${agenda.location}`;
  }
  return talk.room ?? agenda.location;
};

const renderPublishedEvent = (
  agenda: PublishedAgenda,
  talk: PublicAgendaTalk,
  visible: ReadonlySet<ScheduleEmbedField>,
): readonly string[] => {
  const description = descriptionFor(talk, visible);
  const location = visible.has("room") ? locationFor(agenda, talk) : null;
  const calendarUpdatedAt = agenda.calendarUpdatedAt ?? agenda.publishedAt;
  const calendarRevision = agenda.calendarRevision ?? agenda.revision;
  return [
    "BEGIN:VEVENT",
    `UID:${escapeCalendarText(stableCalendarUid(agenda.eventId, talk.id))}`,
    `DTSTAMP:${calendarTimestamp(calendarUpdatedAt)}`,
    `LAST-MODIFIED:${calendarTimestamp(calendarUpdatedAt)}`,
    `SEQUENCE:${calendarRevision}`,
    ...(visible.has("time") ? [
      `DTSTART:${calendarTimestamp(talk.startsAt)}`,
      `DTEND:${calendarTimestamp(talk.startsAt + talk.durationMin * 60_000)}`,
    ] : []),
    ...(visible.has("title") ? [`SUMMARY:${escapeCalendarText(talk.title)}`] : []),
    ...(description ? [`DESCRIPTION:${escapeCalendarText(description)}`] : []),
    ...(location ? [`LOCATION:${escapeCalendarText(location)}`] : []),
    ...(visible.has("track") && talk.track ? [`CATEGORIES:${escapeCalendarText(talk.track)}`] : []),
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ];
};

export const renderPublishedCalendar = (
  agenda: PublishedAgenda,
  talks: readonly PublicAgendaTalk[] = agenda.talks,
  fields: readonly ScheduleEmbedField[] = SCHEDULE_EMBED_FIELDS,
): string => {
  const visible = new Set(fields);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Session Party//Published Schedule//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeCalendarText(agenda.eventName)}`,
    `X-WR-TIMEZONE:${escapeCalendarText(agenda.timezone)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    ...talks.flatMap((talk) => renderPublishedEvent(agenda, talk, visible)),
    "END:VCALENDAR",
    "",
  ];
  return lines.map(foldCalendarLine).join("\r\n");
};

const escapeMarkup = (value: string | number): string => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const sessionMarkupFields = (
  talk: PublicAgendaTalk,
  fields: readonly ScheduleEmbedField[],
) => {
  const visible = new Set(fields);
  return {
    visible,
    startsAt: new Date(talk.startsAt).toISOString(),
    endsAt: new Date(talk.startsAt + talk.durationMin * 60_000).toISOString(),
  };
};

/** A standards-shaped data feed for systems that consume XML instead of JSON. */
export const renderPublishedScheduleXml = (
  agenda: PublishedAgenda,
  fields: readonly ScheduleEmbedField[] = SCHEDULE_EMBED_FIELDS,
): string => {
  const sessions = agenda.talks.map((talk) => {
    const { visible, startsAt, endsAt } = sessionMarkupFields(talk, fields);
    return [
      `  <session id="${escapeMarkup(talk.id)}" status="confirmed">`,
      ...(visible.has("title") ? [`    <title>${escapeMarkup(talk.title)}</title>`] : []),
      ...(visible.has("description") && talk.description
        ? [`    <description>${escapeMarkup(talk.description)}</description>`]
        : []),
      ...(visible.has("time") ? [
        `    <starts-at>${startsAt}</starts-at>`,
        `    <ends-at>${endsAt}</ends-at>`,
        `    <duration-minutes>${talk.durationMin}</duration-minutes>`,
      ] : []),
      ...(visible.has("room") && talk.room ? [`    <room>${escapeMarkup(talk.room)}</room>`] : []),
      ...(visible.has("track") && talk.track ? [
        `    <track${talk.trackId ? ` id="${escapeMarkup(talk.trackId)}"` : ""}>${escapeMarkup(talk.track)}</track>`,
      ] : []),
      ...(visible.has("speakers") ? [
        "    <speakers>",
        ...talk.speakerNames.map((speaker) => `      <speaker>${escapeMarkup(speaker)}</speaker>`),
        "    </speakers>",
      ] : []),
      "  </session>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<schedule event-id="${escapeMarkup(agenda.eventId)}" revision="${agenda.revision}">`,
    `  <event-name>${escapeMarkup(agenda.eventName)}</event-name>`,
    `  <event-slug>${escapeMarkup(agenda.eventSlug)}</event-slug>`,
    `  <timezone>${escapeMarkup(agenda.timezone)}</timezone>`,
    ...(agenda.location ? [`  <location>${escapeMarkup(agenda.location)}</location>`] : []),
    `  <published-at>${new Date(agenda.publishedAt).toISOString()}</published-at>`,
    ...sessions,
    "</schedule>",
    "",
  ].join("\n");
};

/** Unstyled semantic HTML with stable classes so host sites can apply their own CSS. */
export const renderPublishedScheduleHtml = (
  agenda: PublishedAgenda,
  fields: readonly ScheduleEmbedField[] = SCHEDULE_EMBED_FIELDS,
): string => {
  const sessions = agenda.talks.map((talk) => {
    const { visible, startsAt, endsAt } = sessionMarkupFields(talk, fields);
    return [
      `    <article class="session-party-session" data-session-id="${escapeMarkup(talk.id)}" data-status="confirmed">`,
      ...(visible.has("title") ? [`      <h2 class="session-party-session__title">${escapeMarkup(talk.title)}</h2>`] : []),
      ...(visible.has("description") && talk.description
        ? [`      <p class="session-party-session__description">${escapeMarkup(talk.description)}</p>`]
        : []),
      ...(visible.has("time") ? [
        `      <p class="session-party-session__time"><time datetime="${startsAt}">${startsAt}</time> – <time datetime="${endsAt}">${endsAt}</time></p>`,
      ] : []),
      ...(visible.has("room") && talk.room
        ? [`      <p class="session-party-session__room">${escapeMarkup(talk.room)}</p>`]
        : []),
      ...(visible.has("track") && talk.track
        ? [`      <p class="session-party-session__track">${escapeMarkup(talk.track)}</p>`]
        : []),
      ...(visible.has("speakers") && talk.speakerNames.length > 0 ? [
        '      <ul class="session-party-session__speakers">',
        ...talk.speakerNames.map((speaker) => `        <li class="session-party-session__speaker">${escapeMarkup(speaker)}</li>`),
        "      </ul>",
      ] : []),
      "    </article>",
    ].join("\n");
  });
  return [
    "<!doctype html>",
    `<html lang="en" data-session-party-revision="${agenda.revision}">`,
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${escapeMarkup(agenda.eventName)} schedule</title>`,
    "  </head>",
    "  <body>",
    `  <main class="session-party-schedule" data-event-id="${escapeMarkup(agenda.eventId)}">`,
    `    <h1 class="session-party-schedule__title">${escapeMarkup(agenda.eventName)}</h1>`,
    ...sessions,
    "  </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
};

export const publishedScheduleIcsPath = (eventSlug: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/schedule.ics`;

export const publishedScheduleJsonPath = (eventSlug: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/schedule.json`;

export const publishedScheduleXmlPath = (eventSlug: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/schedule.xml`;

export const publishedScheduleHtmlPath = (eventSlug: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/schedule.html`;

export const publishedSessionIcsPath = (eventSlug: string, talkId: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/sessions/${encodeURIComponent(talkId)}.ics`;
