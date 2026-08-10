export interface CalendarEventSnapshot {
  readonly talkId: string;
  readonly uid: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly durationMin: number;
  readonly roomName: string;
  readonly sequence: number;
  readonly updatedAt: Date;
  readonly status: "confirmed" | "cancelled";
}

export interface CalendarRecipient {
  readonly name: string;
  readonly email: string;
}

export interface CalendarEventIdentity {
  readonly id: string;
  readonly name: string;
}

export const stableCalendarUid = (eventId: string, talkId: string): string =>
  `${talkId}@${eventId}.session-party`;

const calendarTimestamp = (date: Date): string =>
  date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");

const escapeCalendarText = (value: string): string => value
  .replaceAll("\\", "\\\\")
  .replaceAll("\r\n", "\\n")
  .replaceAll("\n", "\\n")
  .replaceAll(",", "\\,")
  .replaceAll(";", "\\;");

const mailboxAddress = (mailbox: string): string => {
  const bracketed = /<([^<>]+)>$/.exec(mailbox);
  return bracketed?.[1] ?? mailbox;
};

const escapeCalendarParameter = (value: string): string => value
  .replaceAll("^", "^^")
  .replaceAll("\r\n", "^n")
  .replaceAll("\n", "^n")
  .replaceAll('"', "^'");

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

export type CalendarMethod = "REQUEST" | "CANCEL";

export const renderCalendar = (
  event: CalendarEventIdentity,
  recipient: CalendarRecipient,
  calendarEvents: readonly CalendarEventSnapshot[],
  method: CalendarMethod,
  createdAt: Date,
  organizerMailbox: string,
): string => {
  if (calendarEvents.some(({ status }) =>
    method === "CANCEL" ? status !== "cancelled" : status !== "confirmed"
  )) {
    throw new Error(`Calendar ${method} payload contains an incompatible event status`);
  }
  const organizerAddress = mailboxAddress(organizerMailbox);
  const attendee = `ATTENDEE;CN="${escapeCalendarParameter(recipient.name)}";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${recipient.email}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Session Party//Speaker Agenda//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    ...calendarEvents.flatMap((calendarEvent) => [
      "BEGIN:VEVENT",
      `UID:${escapeCalendarText(calendarEvent.uid)}`,
      `DTSTAMP:${calendarTimestamp(createdAt)}`,
      `LAST-MODIFIED:${calendarTimestamp(calendarEvent.updatedAt)}`,
      `SEQUENCE:${calendarEvent.sequence}`,
      `DTSTART:${calendarTimestamp(calendarEvent.startsAt)}`,
      `DTEND:${calendarTimestamp(new Date(calendarEvent.startsAt.getTime() + calendarEvent.durationMin * 60_000))}`,
      `ORGANIZER:mailto:${organizerAddress}`,
      attendee,
      `SUMMARY:${escapeCalendarText(calendarEvent.title)}`,
      `LOCATION:${escapeCalendarText(calendarEvent.roomName)}`,
      `DESCRIPTION:${escapeCalendarText(`${recipient.name} — ${event.name}`)}`,
      ...(calendarEvent.status === "cancelled" ? ["STATUS:CANCELLED"] : []),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ];
  return lines.map(foldCalendarLine).join("\r\n");
};

const parseCalendarTimestamp = (value: string): Date | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const unescapeCalendarText = (value: string): string => value
  .replaceAll("\\n", "\n")
  .replaceAll("\\,", ",")
  .replaceAll("\\;", ";")
  .replaceAll("\\\\", "\\");

/** One-time compatibility reader for retained pre-lineage snapshots. */
export const parseCalendarEvents = (content: string): readonly CalendarEventSnapshot[] => {
  const lines = content.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events: CalendarEventSnapshot[] = [];
  let block: string[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      block = [];
      continue;
    }
    if (line === "END:VEVENT") {
      if (!block) continue;
      const value = (name: string): string | null => {
        const lineValue = block!.find((candidate) => candidate.startsWith(`${name}:`));
        return lineValue?.slice(name.length + 1) ?? null;
      };
      const uid = value("UID");
      const startsAt = parseCalendarTimestamp(value("DTSTART") ?? "");
      const endsAt = parseCalendarTimestamp(value("DTEND") ?? "");
      const updatedAt = parseCalendarTimestamp(value("LAST-MODIFIED") ?? "")
        ?? parseCalendarTimestamp(value("DTSTAMP") ?? "");
      const sequence = Number(value("SEQUENCE"));
      const title = value("SUMMARY");
      const roomName = value("LOCATION");
      const separator = uid?.indexOf("@") ?? -1;
      const durationMin = startsAt && endsAt
        ? (endsAt.getTime() - startsAt.getTime()) / 60_000
        : 0;
      if (
        uid
        && separator > 0
        && startsAt
        && updatedAt
        && Number.isInteger(sequence)
        && sequence > 0
        && Number.isInteger(durationMin)
        && durationMin > 0
        && title !== null
        && roomName !== null
      ) {
        events.push({
          talkId: unescapeCalendarText(uid.slice(0, separator)),
          uid: unescapeCalendarText(uid),
          title: unescapeCalendarText(title),
          startsAt,
          durationMin,
          roomName: unescapeCalendarText(roomName),
          sequence,
          updatedAt,
          status: value("STATUS") === "CANCELLED" ? "cancelled" : "confirmed",
        });
      }
      block = null;
      continue;
    }
    if (block) block.push(line);
  }
  return events;
};
