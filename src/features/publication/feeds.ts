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

export const publishedScheduleIcsPath = (eventSlug: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/schedule.ics`;

export const publishedScheduleJsonPath = (eventSlug: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/schedule.json`;

export const publishedSessionIcsPath = (eventSlug: string, talkId: string): string =>
  `/events/${encodeURIComponent(eventSlug)}/sessions/${encodeURIComponent(talkId)}.ics`;
