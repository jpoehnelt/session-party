import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { copyText } from "@/client/clipboard";
import type { PublicAgendaTalk, PublishedAgenda } from "@/features/agenda/schema";
import type {
  PublicSpeaker,
  PublicSpeakerGallery,
} from "@/features/portal/schema";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  SpeakerGallery,
  Tabs,
} from "@/ui";

export type PublicProgramSurface =
  | "sessions"
  | "speakers"
  | "agenda"
  | "schedule"
  | "gallery"
  | "widgets";

const SURFACES: readonly { readonly id: PublicProgramSurface; readonly label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "speakers", label: "Speakers" },
  { id: "agenda", label: "Agenda" },
  { id: "schedule", label: "Schedule itinerary" },
  { id: "gallery", label: "Speaker gallery" },
  { id: "widgets", label: "Embed & share" },
];

const PRODUCTION_ACCENTS = [
  "bg-surface-muted",
  "bg-surface-muted",
  "bg-surface-muted",
  "bg-surface-muted",
] as const;

const normalize = (value: string) => value.trim().toLocaleLowerCase();

export function publicSurfaceFromSplat(value: string | undefined): PublicProgramSurface {
  const segment = value?.split("/").find(Boolean);
  return SURFACES.some(({ id }) => id === segment)
    ? segment as PublicProgramSurface
    : "sessions";
}

export function sessionMatches(
  talk: PublicAgendaTalk,
  query: string,
  track: string,
  room: string,
): boolean {
  const needle = normalize(query);
  const text = normalize([talk.title, talk.description ?? "", ...talk.speakerNames].join(" "));
  return (!needle || text.includes(needle))
    && (!track || talk.track === track)
    && (!room || talk.room === room);
}

const surname = (name: string) => normalize(name).split(/\s+/).at(-1) ?? normalize(name);

export function sortPublicSpeakers(
  speakers: readonly PublicSpeaker[],
): readonly PublicSpeaker[] {
  return [...speakers].sort((left, right) =>
    surname(left.displayName).localeCompare(surname(right.displayName))
    || left.displayName.localeCompare(right.displayName)
    || left.id.localeCompare(right.id)
  );
}

function localDayKey(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function formatDay(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    timeZone: timezone,
    weekday: "long",
  }).format(timestamp);
}

function formatTime(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(timestamp);
}

function formatDateTime(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone,
  }).format(timestamp);
}

function endTime(talk: PublicAgendaTalk): number {
  return talk.startsAt + talk.durationMin * 60_000;
}

function SurfaceIntro({
  eyebrow,
  title,
  description,
  titleId,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly titleId: string;
}) {
  return (
    <header className="border-b-2 border-line-strong pb-5 sm:flex sm:items-end sm:justify-between sm:gap-8">
      <div>
        <p className="inline-block -rotate-1 border-2 border-line-strong bg-production-coral px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-ink shadow-[3px_3px_0_#171714]">
          {eyebrow}
        </p>
        <h1 id={titleId} className="mt-5 text-4xl font-black leading-[0.88] tracking-[-0.055em] text-ink sm:text-5xl">
          {title}
        </h1>
      </div>
      <p className="mt-4 max-w-xl border-l-4 border-accent pl-4 text-sm font-semibold leading-6 text-ink-secondary sm:mt-0">
        {description}
      </p>
    </header>
  );
}

function speakerByName(gallery: PublicSpeakerGallery): ReadonlyMap<string, PublicSpeaker> {
  return new Map(gallery.speakers.map((speaker) => [normalize(speaker.displayName), speaker]));
}

function talksForSpeaker(
  agenda: PublishedAgenda,
  speaker: PublicSpeaker,
): readonly PublicAgendaTalk[] {
  const name = normalize(speaker.displayName);
  return agenda.talks.filter((talk) =>
    talk.speakerNames.some((speakerName) => normalize(speakerName) === name)
  );
}

function SpeakerLines({
  talk,
  speakers,
}: {
  readonly talk: PublicAgendaTalk;
  readonly speakers: ReadonlyMap<string, PublicSpeaker>;
}) {
  return (
    <ul className="space-y-1.5 border-l-4 border-production-sky pl-3 text-sm text-ink-secondary" aria-label="Speakers">
      {talk.speakerNames.map((name) => {
        const speaker = speakers.get(normalize(name));
        const identity = [speaker?.title, speaker?.company].filter(Boolean).join(" at ");
        return (
          <li key={name}>
            <span className="font-black text-ink">{name}</span>
            {identity ? ` — ${identity}` : ""}
          </li>
        );
      })}
    </ul>
  );
}

function SessionBadges({ talk }: { readonly talk: PublicAgendaTalk }) {
  return (
    <div className="flex flex-wrap gap-2">
      {talk.track ? <Badge tone="accent">Track · {talk.track}</Badge> : null}
      <Badge tone="warning">Format · {talk.durationMin} minutes</Badge>
      {talk.room ? <Badge tone="success">Room · {talk.room}</Badge> : null}
    </div>
  );
}

function SessionDetail({
  talk,
  agenda,
  speakers,
}: {
  readonly talk: PublicAgendaTalk;
  readonly agenda: PublishedAgenda;
  readonly speakers: ReadonlyMap<string, PublicSpeaker>;
}) {
  return (
    <div className="space-y-5">
      <p className="border-2 border-line-strong bg-ink px-3 py-2.5 text-sm font-black text-production-lime shadow-[3px_3px_0_#7857ff]">
        {formatDateTime(talk.startsAt, agenda.timezone)}–{formatTime(endTime(talk), agenda.timezone)}
      </p>
      <SessionBadges talk={talk} />
      <p className="whitespace-pre-wrap text-sm leading-6 text-ink-secondary">
        {talk.description ?? "A description has not been published for this session yet."}
      </p>
      <div>
        <h3 className="mb-3 text-[10px] font-black uppercase tracking-[0.14em] text-accent-deep">Speakers on this cue</h3>
        <SpeakerLines talk={talk} speakers={speakers} />
      </div>
    </div>
  );
}

function SessionsSurface({
  agenda,
  gallery,
  onSelect,
}: {
  readonly agenda: PublishedAgenda;
  readonly gallery: PublicSpeakerGallery;
  readonly onSelect: (talk: PublicAgendaTalk) => void;
}) {
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState("");
  const [room, setRoom] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const tracks = [...new Set(agenda.talks.flatMap((talk) => talk.track ? [talk.track] : []))].sort();
  const rooms = [...new Set(agenda.talks.flatMap((talk) => talk.room ? [talk.room] : []))].sort();
  const filtered = agenda.talks.filter((talk) => sessionMatches(talk, query, track, room));
  const speakers = speakerByName(gallery);

  return (
    <section className="space-y-6" aria-labelledby="public-sessions-title">
      <SurfaceIntro
        eyebrow="Published program"
        title="Sessions"
        titleId="public-sessions-title"
        description="Search by session or speaker, then narrow by track and room."
      />
      <div className="grid gap-4 border-2 border-line-strong bg-production-sky/30 p-4 shadow-[5px_5px_0_#171714] md:grid-cols-[minmax(0,1fr)_14rem_14rem] sm:p-5">
        <Input
          label="Search sessions or speakers"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Session title or speaker name"
        />
        <Select label="Track" value={track} onChange={(event) => setTrack(event.currentTarget.value)}>
          <option value="">All tracks</option>
          {tracks.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <Select label="Room" value={room} onChange={(event) => setRoom(event.currentTarget.value)}>
          <option value="">All rooms</option>
          {rooms.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
      </div>
      <p role="status" className="inline-flex w-fit border-2 border-line-strong bg-ink px-3 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-production-lime shadow-[3px_3px_0_#7857ff]">
        {String(filtered.length).padStart(2, "0")} {filtered.length === 1 ? "session" : "sessions"} on the board
      </p>
      {filtered.length === 0 ? (
        <EmptyState title="No matching sessions" description="Try a broader search or clear a filter." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filtered.map((talk, index) => {
            const description = talk.description ?? "A description has not been published for this session yet.";
            const isExpanded = expanded.has(talk.id);
            const canExpand = description.length > 120;
            return (
              <Card key={talk.id} className="h-full rounded-none transition-transform hover:-translate-y-1 [&>div]:p-0">
                <article className="flex h-full flex-col">
                  <div className={`border-b-2 border-line-strong px-4 py-4 ${PRODUCTION_ACCENTS[index % PRODUCTION_ACCENTS.length] ?? "bg-production-sky"}`}>
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-secondary">
                      {formatDateTime(talk.startsAt, agenda.timezone)}
                    </p>
                    <button type="button" className="mt-2 text-left" onClick={() => onSelect(talk)}>
                      <h2 className="text-xl font-black leading-tight tracking-[-0.03em] text-ink underline-offset-4 hover:underline">{talk.title}</h2>
                    </button>
                  </div>
                  <div className="flex flex-1 flex-col gap-4 px-4 py-4">
                    <SessionBadges talk={talk} />
                    <SpeakerLines talk={talk} speakers={speakers} />
                    <div className="mt-auto border-t-2 border-line-strong pt-4">
                      <p className={isExpanded || !canExpand ? "text-sm font-medium leading-6 text-ink-secondary" : "line-clamp-3 text-sm font-medium leading-6 text-ink-secondary"}>
                        {description}
                      </p>
                      {canExpand ? (
                        <Button
                          className="mt-2 rounded-none"
                          size="sm"
                          variant="ghost"
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() => setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(talk.id)) next.delete(talk.id);
                            else next.add(talk.id);
                            return next;
                          })}
                        >
                          {isExpanded ? "Show less" : "Show more"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </article>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SpeakerDetail({
  speaker,
  agenda,
}: {
  readonly speaker: PublicSpeaker;
  readonly agenda: PublishedAgenda;
}) {
  const sessions = talksForSpeaker(agenda, speaker);
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4 border-2 border-line-strong bg-production-sky/35 p-4 shadow-[3px_3px_0_#171714]">
        <Avatar name={speaker.displayName} src={speaker.headshotUrl ?? undefined} size="lg" />
        <div>
          <p className="text-lg font-black tracking-[-0.025em] text-ink">{speaker.displayName}</p>
          <p className="text-sm text-ink-secondary">
            {[speaker.title, speaker.company].filter(Boolean).join(" at ") || "Profile details coming soon"}
          </p>
        </div>
      </div>
      <div>
        <h3 className="text-[10px] font-black uppercase tracking-[0.14em] text-accent-deep">Biography</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">
          {speaker.bio ?? "This speaker has not published a biography yet."}
        </p>
      </div>
      <div>
        <h3 className="text-[10px] font-black uppercase tracking-[0.14em] text-accent-deep">Sessions</h3>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-ink-secondary">No published sessions are attached yet.</p>
        ) : (
          <ul className="mt-3 divide-y-2 divide-line-strong border-2 border-line-strong shadow-[3px_3px_0_#171714]">
            {sessions.map((talk) => (
              <li key={talk.id} className="bg-surface p-3 odd:bg-production-lime/25">
                <p className="font-black text-ink">{talk.title}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  {formatDateTime(talk.startsAt, agenda.timezone)} · {talk.room ?? "Room to be announced"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SpeakersSurface({
  agenda,
  gallery,
  mode,
  onSelect,
}: {
  readonly agenda: PublishedAgenda;
  readonly gallery: PublicSpeakerGallery;
  readonly mode: "list" | "gallery";
  readonly onSelect: (speaker: PublicSpeaker) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = sortPublicSpeakers(gallery.speakers).filter((speaker) =>
    normalize([speaker.displayName, speaker.title ?? "", speaker.company ?? ""].join(" "))
      .includes(normalize(query))
  );
  const heading = mode === "gallery" ? "Speaker gallery" : "Speakers";

  return (
    <section className="space-y-6" aria-labelledby="public-speakers-title">
      <SurfaceIntro
        eyebrow="Meet the program"
        title={heading}
        titleId="public-speakers-title"
        description={mode === "gallery" ? "Browse the visual speaker wall and open any profile." : "An alphabetical directory of published speakers and their sessions."}
      />
      <div className="max-w-xl border-2 border-line-strong bg-production-sky/30 p-4 shadow-[4px_4px_0_#171714]">
        <Input
          label="Search speakers"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Name, title, or company"
        />
      </div>
      <p role="status" className="inline-flex w-fit border-2 border-line-strong bg-ink px-3 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-production-lime shadow-[3px_3px_0_#7857ff]">
        {String(filtered.length).padStart(2, "0")} {filtered.length === 1 ? "speaker" : "speakers"} published
      </p>
      {filtered.length === 0 ? (
        <EmptyState title="No matching speakers" description="Try another name or clear the search." />
      ) : mode === "gallery" ? (
        <SpeakerGallery
          speakers={filtered.map((speaker) => ({
            id: speaker.id,
            displayName: speaker.displayName,
            title: speaker.title ?? undefined,
            company: speaker.company ?? undefined,
            bio: speaker.bio ?? undefined,
            headshotUrl: speaker.headshotUrl ?? undefined,
            links: speaker.links,
          }))}
          onSelect={(item) => {
            const speaker = filtered.find(({ id }) => id === item.id);
            if (speaker) onSelect(speaker);
          }}
        />
      ) : (
        <ul className="divide-y-2 divide-line-strong border-2 border-line-strong bg-surface shadow-[6px_6px_0_#171714]">
          {filtered.map((speaker, index) => {
            const sessions = talksForSpeaker(agenda, speaker);
            return (
              <li key={speaker.id}>
                <button
                  type="button"
                  className={`flex min-h-24 w-full items-center gap-4 px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/60 ${index % 2 === 0 ? "bg-surface hover:bg-production-sky/35" : "bg-production-lime/20 hover:bg-production-lime/45"}`}
                  onClick={() => onSelect(speaker)}
                >
                  <Avatar name={speaker.displayName} src={speaker.headshotUrl ?? undefined} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-black tracking-[-0.025em] text-ink">{speaker.displayName}</span>
                    <span className="block text-sm text-ink-secondary">
                      {[speaker.title, speaker.company].filter(Boolean).join(" at ") || "Profile details coming soon"}
                    </span>
                  </span>
                  <Badge tone={sessions.length > 0 ? "accent" : "neutral"}>{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</Badge>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DayTabs({
  agenda,
  value,
  onChange,
}: {
  readonly agenda: PublishedAgenda;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const days = [...new Map(
    agenda.talks.map((talk) => [
      localDayKey(talk.startsAt, agenda.timezone),
      { id: localDayKey(talk.startsAt, agenda.timezone), label: formatDay(talk.startsAt, agenda.timezone) },
    ] as const),
  ).values()];
  return <Tabs tabs={days} active={value} onChange={onChange} className="max-w-full overflow-x-auto shadow-[4px_4px_0_#171714]" />;
}

function AgendaSurface({
  agenda,
  onSelect,
}: {
  readonly agenda: PublishedAgenda;
  readonly onSelect: (talk: PublicAgendaTalk) => void;
}) {
  const days = [...new Set(agenda.talks.map((talk) => localDayKey(talk.startsAt, agenda.timezone)))];
  const [selectedDay, setSelectedDay] = useState(days[0] ?? "");
  const day = days.includes(selectedDay) ? selectedDay : days[0] ?? "";
  const talks = agenda.talks.filter((talk) => localDayKey(talk.startsAt, agenda.timezone) === day);
  const times = [...new Set(talks.map((talk) => talk.startsAt))].sort((a, b) => a - b);

  return (
    <section className="space-y-6" aria-labelledby="public-agenda-title">
      <SurfaceIntro
        eyebrow="Run of show"
        title="Agenda"
        titleId="public-agenda-title"
        description="Sessions organized by day, time, and room."
      />
      <DayTabs agenda={agenda} value={day} onChange={setSelectedDay} />
      <div role="region" aria-label={`${day} agenda`} className="space-y-8">
        {times.map((time) => (
          <section key={time} className="grid items-start gap-4 md:grid-cols-[9rem_minmax(0,1fr)]">
            <h2 className="border-2 border-line-strong bg-ink px-3 py-3 text-base font-black uppercase text-production-lime shadow-[4px_4px_0_#7857ff]">{formatTime(time, agenda.timezone)}</h2>
            <div className="grid gap-3 lg:grid-cols-2">
              {talks.filter((talk) => talk.startsAt === time).map((talk, index) => (
                <button key={talk.id} type="button" className="text-left" onClick={() => onSelect(talk)}>
                  <Card className={`h-full rounded-none transition-transform hover:-translate-y-1 [&>div]:border-t-8 ${index % 2 === 0 ? "[&>div]:border-production-sky" : "[&>div]:border-production-coral"}`}>
                    <p className="text-lg font-black leading-tight tracking-[-0.025em] text-ink">{talk.title}</p>
                    <p className="mt-2 text-sm text-ink-secondary">{talk.speakerNames.join(", ")}</p>
                    <p className="mt-3 border-t-2 border-line-strong pt-2 text-[10px] font-black uppercase tracking-[0.1em] text-ink-faint">{talk.room ?? "Room TBA"} · {talk.track ?? "General"}</p>
                  </Card>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function calendarDataUrl(agenda: PublishedAgenda, talks: readonly PublicAgendaTalk[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Session Party//Public Schedule//EN"];
  for (const talk of talks) {
    const stamp = (value: number) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${talk.id}@sessionparty`,
      `DTSTART:${stamp(talk.startsAt)}`,
      `DTEND:${stamp(endTime(talk))}`,
      `SUMMARY:${talk.title.replaceAll(",", "\\,")}`,
      `LOCATION:${(talk.room ?? agenda.location ?? "").replaceAll(",", "\\,")}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join("\r\n"))}`;
}

function ScheduleSurface({
  agenda,
  gallery,
}: {
  readonly agenda: PublishedAgenda;
  readonly gallery: PublicSpeakerGallery;
}) {
  const storageKey = `session-party:${agenda.eventSlug}:personal-schedule`;
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const [personalOnly, setPersonalOnly] = useState(false);
  const days = [...new Set(agenda.talks.map((talk) => localDayKey(talk.startsAt, agenda.timezone)))];
  const [selectedDay, setSelectedDay] = useState(days[0] ?? "");
  const day = days.includes(selectedDay) ? selectedDay : days[0] ?? "";
  const speakers = speakerByName(gallery);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) setSaved(new Set(JSON.parse(stored) as string[]));
    } catch {
      setSaved(new Set());
    }
  }, [storageKey]);

  const visible = [...agenda.talks]
    .filter((talk) => personalOnly ? saved.has(talk.id) : localDayKey(talk.startsAt, agenda.timezone) === day)
    .sort((left, right) => left.startsAt - right.startsAt || left.title.localeCompare(right.title));
  const savedTalks = agenda.talks.filter((talk) => saved.has(talk.id));

  const toggle = (talkId: string) => setSaved((current) => {
    const next = new Set(current);
    if (next.has(talkId)) next.delete(talkId);
    else next.add(talkId);
    window.localStorage.setItem(storageKey, JSON.stringify([...next]));
    return next;
  });

  return (
    <section className="space-y-6" aria-labelledby="public-schedule-title">
      <SurfaceIntro
        eyebrow="Plan your event"
        title="Schedule itinerary"
        titleId="public-schedule-title"
        description="Save sessions to build a personal itinerary that stays on this device."
      />
      <div className="flex flex-wrap items-center gap-3 border-2 border-line-strong bg-production-yellow/35 p-4 shadow-[5px_5px_0_#171714]">
        <Button className="rounded-none" type="button" variant={personalOnly ? "secondary" : "primary"} onClick={() => setPersonalOnly(false)}>
          Full schedule
        </Button>
        <Button className="rounded-none" type="button" variant={personalOnly ? "primary" : "secondary"} onClick={() => setPersonalOnly(true)}>
          My schedule ({saved.size})
        </Button>
        <a
          className="inline-flex min-h-10 items-center border-2 border-line-strong bg-surface px-4 text-xs font-black uppercase tracking-[0.075em] text-ink shadow-[3px_3px_0_#171714] transition-transform hover:-translate-y-0.5 hover:bg-production-sky focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-3"
          href={calendarDataUrl(agenda, personalOnly ? savedTalks : visible)}
          download={`${agenda.eventSlug}-${personalOnly ? "my-schedule" : "schedule"}.ics`}
        >
          Add to calendar (.ics)
        </a>
      </div>
      {!personalOnly ? <DayTabs agenda={agenda} value={day} onChange={setSelectedDay} /> : null}
      {visible.length === 0 ? (
        <EmptyState
          title={personalOnly ? "Your schedule is empty" : "No sessions this day"}
          description={personalOnly ? "Add sessions from the full schedule to see them here." : "Choose another event day."}
        />
      ) : (
        <ol className="space-y-4">
          {visible.map((talk, index) => (
            <li key={talk.id}>
              <Card className="rounded-none [&>div]:p-0">
                <article className="grid md:grid-cols-[11rem_minmax(0,1fr)_auto]">
                  <div className={`border-b-2 border-line-strong p-4 md:border-b-0 md:border-r-2 ${PRODUCTION_ACCENTS[index % PRODUCTION_ACCENTS.length] ?? "bg-production-sky"}`}>
                    <time className="font-black leading-5 text-ink" dateTime={new Date(talk.startsAt).toISOString()}>
                      {formatDateTime(talk.startsAt, agenda.timezone)}
                    </time>
                    <p className="mt-3 border-t-2 border-line-strong pt-2 text-[10px] font-black uppercase tracking-[0.1em] text-ink-faint">Ends {formatTime(endTime(talk), agenda.timezone)}</p>
                  </div>
                  <div className="space-y-3 p-4">
                    <SessionBadges talk={talk} />
                    <h2 className="text-xl font-black leading-tight tracking-[-0.025em] text-ink">{talk.title}</h2>
                    <p className="text-sm leading-6 text-ink-secondary">
                      {talk.description ?? "A description has not been published for this session yet."}
                    </p>
                    <SpeakerLines talk={talk} speakers={speakers} />
                  </div>
                  <Button
                    className="m-4 self-start rounded-none md:ml-0"
                    type="button"
                    variant={saved.has(talk.id) ? "secondary" : "primary"}
                    aria-pressed={saved.has(talk.id)}
                    onClick={() => toggle(talk.id)}
                  >
                    {saved.has(talk.id) ? "Remove" : "Add to my schedule"}
                  </Button>
                </article>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function WidgetsSurface({ agenda }: { readonly agenda: PublishedAgenda }) {
  const [widget, setWidget] = useState<Exclude<PublicProgramSurface, "widgets">>("sessions");
  const [format, setFormat] = useState("styled-html");
  const [accent, setAccent] = useState("#635BFF");
  const [copyStatus, setCopyStatus] = useState("");
  const origin = typeof window === "undefined" ? "https://sessionparty.com" : window.location.origin;
  const publicUrl = `${origin}/event/${agenda.eventSlug}/${widget}`;
  const embedUrl = widget === "speakers" || widget === "gallery"
    ? `${origin}/embed/${agenda.eventSlug}/speakers`
    : `${origin}/embed/${agenda.eventSlug}/schedule`;
  const generated = format === "json"
    ? `${origin}/api/v1/public/events/${agenda.eventSlug}/${widget === "speakers" || widget === "gallery" ? "speakers" : "agenda/published"}`
    : format === "plain-html"
      ? `<a href="${publicUrl}">${agenda.eventName} ${widget}</a>`
      : `<iframe title="${agenda.eventName} ${widget}" src="${embedUrl}" style="width:100%;min-height:720px;border:0;border-top:4px solid ${accent}"></iframe>`;

  return (
    <section className="space-y-6" aria-labelledby="public-widgets-title">
      <SurfaceIntro
        eyebrow="Live event data"
        title="Embed & share"
        titleId="public-widgets-title"
        description="Generate a link or snippet backed by the currently published program."
      />
      <Card className="rounded-none [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Widget builder / output patch bay">
        <div className="grid gap-4 md:grid-cols-3">
          <Select label="Widget type" value={widget} onChange={(event) => setWidget(event.currentTarget.value as Exclude<PublicProgramSurface, "widgets">)}>
            <option value="sessions">Sessions list</option>
            <option value="speakers">Speakers list</option>
            <option value="agenda">Agenda</option>
            <option value="schedule">Schedule itinerary</option>
            <option value="gallery">Speaker gallery</option>
          </Select>
          <Select label="Output format" value={format} onChange={(event) => setFormat(event.currentTarget.value)}>
            <option value="styled-html">Styled HTML</option>
            <option value="plain-html">Plain HTML</option>
            <option value="json">JSON</option>
          </Select>
          <Input label="Brand color" type="color" value={accent} onChange={(event) => setAccent(event.currentTarget.value)} />
        </div>
        <div className="mt-6 space-y-3 border-t-2 border-line-strong pt-5">
          <label className="text-[10px] font-black uppercase tracking-[0.14em] text-accent-deep" htmlFor="generated-widget-code">Generated share URL or code</label>
          <textarea
            id="generated-widget-code"
            className="min-h-40 w-full border-2 border-line-strong bg-ink px-4 py-3 font-mono text-xs leading-5 text-production-lime shadow-[4px_4px_0_#7857ff] outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-3"
            readOnly
            value={generated}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => void copyText(generated).then(() => setCopyStatus("Copied to clipboard."), (error: unknown) => setCopyStatus(error instanceof Error ? error.message : "Could not copy."))}
            >
              Copy generated code
            </Button>
            <a className="inline-flex border-2 border-line-strong bg-production-lime px-3 py-2 text-[10px] font-black uppercase tracking-[0.1em] text-ink shadow-[3px_3px_0_#171714] transition-transform hover:-translate-y-0.5" href={publicUrl}>Preview live {widget} →</a>
            <span className="text-xs font-bold text-ink-secondary" role="status" aria-live="polite">{copyStatus}</span>
          </div>
        </div>
      </Card>
    </section>
  );
}

export function PublicProgram({
  agenda,
  gallery,
  surface,
}: {
  readonly agenda: PublishedAgenda;
  readonly gallery: PublicSpeakerGallery;
  readonly surface: PublicProgramSurface;
}) {
  const [selectedTalk, setSelectedTalk] = useState<PublicAgendaTalk | null>(null);
  const [selectedSpeaker, setSelectedSpeaker] = useState<PublicSpeaker | null>(null);
  const speakers = useMemo(() => speakerByName(gallery), [gallery]);
  const publishedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: agenda.timezone,
  }).format(agenda.publishedAt);

  return (
    <main id="main-content" tabIndex={-1} className="production-grid min-h-dvh bg-canvas text-ink">
      <header className="border-b-2 border-line-strong bg-ink text-on-accent">
        <div className="mx-auto max-w-7xl px-4 pt-5 sm:px-6 sm:pt-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-5 pb-5">
            <div className="flex min-w-0 items-center gap-4">
              <Link
                className="grid size-11 shrink-0 place-items-center border-2 border-on-accent bg-production-lime text-[11px] font-black tracking-[-0.04em] text-ink shadow-[4px_4px_0_#7857ff]"
                to={`/event/${agenda.eventSlug}/sessions`}
                aria-label={`${agenda.eventName} public program home`}
              >
                SP
              </Link>
              <div className="min-w-0">
                <Link className="block truncate text-xl font-black tracking-[-0.035em] text-on-accent underline-offset-4 hover:underline sm:text-2xl" to={`/event/${agenda.eventSlug}/sessions`}>{agenda.eventName}</Link>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">{agenda.location ?? "Online"} · {agenda.timezone}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="size-2.5 bg-production-lime" aria-hidden="true" />
              <Badge tone="success">Published program · R{String(agenda.revision).padStart(2, "0")}</Badge>
            </div>
          </div>
          <p className="border-t-2 border-on-accent bg-production-sky px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.12em] text-ink sm:hidden">Swipe horizontally for more sections →</p>
          <nav className="-mx-4 flex overflow-x-auto border-t-2 border-on-accent bg-surface text-ink sm:-mx-6 lg:-mx-8" aria-label="Public event navigation">
            {SURFACES.map((item) => (
              <Link
                key={item.id}
                to={`/event/${agenda.eventSlug}/${item.id}`}
                aria-current={surface === item.id ? "page" : undefined}
                className={surface === item.id
                  ? "whitespace-nowrap border-r-2 border-line-strong bg-accent px-4 py-3 text-[10px] font-black uppercase tracking-[0.1em] text-ink first:border-l-2 sm:px-5"
                  : "whitespace-nowrap border-r-2 border-line-strong px-4 py-3 text-[10px] font-black uppercase tracking-[0.1em] text-ink-secondary first:border-l-2 hover:bg-production-sky hover:text-ink sm:px-5"}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div id="public-program-content" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-9 sm:px-6 sm:py-12 lg:px-8 lg:py-14">
        {surface === "sessions" ? <SessionsSurface agenda={agenda} gallery={gallery} onSelect={setSelectedTalk} /> : null}
        {surface === "speakers" ? <SpeakersSurface agenda={agenda} gallery={gallery} mode="list" onSelect={setSelectedSpeaker} /> : null}
        {surface === "agenda" ? <AgendaSurface agenda={agenda} onSelect={setSelectedTalk} /> : null}
        {surface === "schedule" ? <ScheduleSurface agenda={agenda} gallery={gallery} /> : null}
        {surface === "gallery" ? <SpeakersSurface agenda={agenda} gallery={gallery} mode="gallery" onSelect={setSelectedSpeaker} /> : null}
        {surface === "widgets" ? <WidgetsSurface agenda={agenda} /> : null}
      </div>
      <footer className="mt-4 border-t-2 border-line-strong bg-ink text-on-accent">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-8">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-production-sky">Session Party · Public program feed</p>
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/60">Schedule revision {agenda.revision} · Published {publishedAt}</p>
        </div>
      </footer>
      <Modal
        open={selectedTalk !== null}
        onClose={() => setSelectedTalk(null)}
        title={selectedTalk?.title ?? "Session details"}
        size="lg"
      >
        {selectedTalk ? <SessionDetail talk={selectedTalk} agenda={agenda} speakers={speakers} /> : null}
      </Modal>
      <Modal
        open={selectedSpeaker !== null}
        onClose={() => setSelectedSpeaker(null)}
        title={selectedSpeaker?.displayName ?? "Speaker details"}
        size="lg"
      >
        {selectedSpeaker ? <SpeakerDetail speaker={selectedSpeaker} agenda={agenda} /> : null}
      </Modal>
    </main>
  );
}
