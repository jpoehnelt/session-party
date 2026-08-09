import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
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
    <ul className="space-y-1 text-sm text-ink-secondary" aria-label="Speakers">
      {talk.speakerNames.map((name) => {
        const speaker = speakers.get(normalize(name));
        const identity = [speaker?.title, speaker?.company].filter(Boolean).join(" at ");
        return (
          <li key={name}>
            <span className="font-medium text-ink">{name}</span>
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
      <Badge tone="neutral">Format · {talk.durationMin} minutes</Badge>
      {talk.room ? <Badge tone="neutral">Room · {talk.room}</Badge> : null}
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
      <p className="text-sm font-semibold text-ink">
        {formatDateTime(talk.startsAt, agenda.timezone)}–{formatTime(endTime(talk), agenda.timezone)}
      </p>
      <SessionBadges talk={talk} />
      <p className="whitespace-pre-wrap text-sm leading-6 text-ink-secondary">
        {talk.description ?? "A description has not been published for this session yet."}
      </p>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Speakers</h3>
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
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-deep">Published program</p>
        <h1 id="public-sessions-title" className="mt-2 text-3xl font-semibold text-ink">Sessions</h1>
        <p className="mt-2 text-sm text-ink-secondary">Search by session or speaker, then narrow by track and room.</p>
      </div>
      <div className="grid gap-3 rounded-card border border-line bg-surface p-4 md:grid-cols-[minmax(0,1fr)_14rem_14rem]">
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
      <p role="status" className="text-sm font-medium text-ink-secondary">
        {filtered.length} {filtered.length === 1 ? "session" : "sessions"}
      </p>
      {filtered.length === 0 ? (
        <EmptyState title="No matching sessions" description="Try a broader search or clear a filter." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filtered.map((talk) => {
            const description = talk.description ?? "A description has not been published for this session yet.";
            const isExpanded = expanded.has(talk.id);
            const canExpand = description.length > 120;
            return (
              <Card key={talk.id} className="h-full">
                <article className="flex h-full flex-col gap-4">
                  <div>
                    <p className="text-xs font-semibold text-accent-deep">
                      {formatDateTime(talk.startsAt, agenda.timezone)}
                    </p>
                    <button type="button" className="mt-2 text-left" onClick={() => onSelect(talk)}>
                      <h2 className="text-lg font-semibold text-ink underline-offset-4 hover:underline">{talk.title}</h2>
                    </button>
                  </div>
                  <SessionBadges talk={talk} />
                  <SpeakerLines talk={talk} speakers={speakers} />
                  <div className="mt-auto">
                    <p className={isExpanded || !canExpand ? "text-sm leading-6 text-ink-secondary" : "line-clamp-3 text-sm leading-6 text-ink-secondary"}>
                      {description}
                    </p>
                    {canExpand ? (
                      <Button
                        className="mt-2"
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
      <div className="flex items-start gap-4">
        <Avatar name={speaker.displayName} src={speaker.headshotUrl ?? undefined} size="lg" />
        <div>
          <p className="font-semibold text-ink">{speaker.displayName}</p>
          <p className="text-sm text-ink-secondary">
            {[speaker.title, speaker.company].filter(Boolean).join(" at ") || "Profile details coming soon"}
          </p>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-ink">Biography</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">
          {speaker.bio ?? "This speaker has not published a biography yet."}
        </p>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-ink">Sessions</h3>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-ink-secondary">No published sessions are attached yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-card border border-line">
            {sessions.map((talk) => (
              <li key={talk.id} className="p-3">
                <p className="font-medium text-ink">{talk.title}</p>
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
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-deep">Meet the program</p>
        <h1 id="public-speakers-title" className="mt-2 text-3xl font-semibold text-ink">{heading}</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          {mode === "gallery" ? "Browse the visual speaker wall and open any profile." : "An alphabetical directory of published speakers and their sessions."}
        </p>
      </div>
      <div className="max-w-xl">
        <Input
          label="Search speakers"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Name, title, or company"
        />
      </div>
      <p role="status" className="text-sm font-medium text-ink-secondary">
        {filtered.length} {filtered.length === 1 ? "speaker" : "speakers"}
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
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {filtered.map((speaker) => {
            const sessions = talksForSpeaker(agenda, speaker);
            return (
              <li key={speaker.id}>
                <button
                  type="button"
                  className="flex min-h-20 w-full items-center gap-4 px-4 py-3 text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  onClick={() => onSelect(speaker)}
                >
                  <Avatar name={speaker.displayName} src={speaker.headshotUrl ?? undefined} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ink">{speaker.displayName}</span>
                    <span className="block text-sm text-ink-secondary">
                      {[speaker.title, speaker.company].filter(Boolean).join(" at ") || "Profile details coming soon"}
                    </span>
                  </span>
                  <Badge tone="neutral">{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</Badge>
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
  return <Tabs tabs={days} active={value} onChange={onChange} className="max-w-full overflow-x-auto" />;
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
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-deep">Run of show</p>
        <h1 id="public-agenda-title" className="mt-2 text-3xl font-semibold text-ink">Agenda</h1>
        <p className="mt-2 text-sm text-ink-secondary">Sessions organized by day, time, and room.</p>
      </div>
      <DayTabs agenda={agenda} value={day} onChange={setSelectedDay} />
      <div role="region" aria-label={`${day} agenda`} className="space-y-7">
        {times.map((time) => (
          <section key={time} className="grid gap-3 md:grid-cols-[8rem_minmax(0,1fr)]">
            <h2 className="pt-4 text-base font-semibold text-ink">{formatTime(time, agenda.timezone)}</h2>
            <div className="grid gap-3 lg:grid-cols-2">
              {talks.filter((talk) => talk.startsAt === time).map((talk) => (
                <button key={talk.id} type="button" className="text-left" onClick={() => onSelect(talk)}>
                  <Card className="h-full transition-colors hover:border-accent">
                    <p className="font-semibold text-ink">{talk.title}</p>
                    <p className="mt-2 text-sm text-ink-secondary">{talk.speakerNames.join(", ")}</p>
                    <p className="mt-2 text-xs text-ink-faint">{talk.room ?? "Room TBA"} · {talk.track ?? "General"}</p>
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
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-deep">Plan your event</p>
        <h1 id="public-schedule-title" className="mt-2 text-3xl font-semibold text-ink">Schedule itinerary</h1>
        <p className="mt-2 text-sm text-ink-secondary">Save sessions to build a personal itinerary that stays on this device.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant={personalOnly ? "secondary" : "primary"} onClick={() => setPersonalOnly(false)}>
          Full schedule
        </Button>
        <Button type="button" variant={personalOnly ? "primary" : "secondary"} onClick={() => setPersonalOnly(true)}>
          My schedule ({saved.size})
        </Button>
        <a
          className="inline-flex min-h-11 items-center rounded-control border border-line px-4 text-sm font-medium text-ink hover:bg-surface-muted"
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
          {visible.map((talk) => (
            <li key={talk.id}>
              <Card>
                <article className="grid gap-4 md:grid-cols-[10rem_minmax(0,1fr)_auto]">
                  <div>
                    <time className="font-semibold text-ink" dateTime={new Date(talk.startsAt).toISOString()}>
                      {formatDateTime(talk.startsAt, agenda.timezone)}
                    </time>
                    <p className="mt-1 text-xs text-ink-faint">Ends {formatTime(endTime(talk), agenda.timezone)}</p>
                  </div>
                  <div className="space-y-3">
                    <SessionBadges talk={talk} />
                    <h2 className="text-lg font-semibold text-ink">{talk.title}</h2>
                    <p className="text-sm leading-6 text-ink-secondary">
                      {talk.description ?? "A description has not been published for this session yet."}
                    </p>
                    <SpeakerLines talk={talk} speakers={speakers} />
                  </div>
                  <Button
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
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-deep">Live event data</p>
        <h1 id="public-widgets-title" className="mt-2 text-3xl font-semibold text-ink">Embed & share</h1>
        <p className="mt-2 text-sm text-ink-secondary">Generate a link or snippet backed by the currently published program.</p>
      </div>
      <Card title="Widget builder">
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
        <div className="mt-5 space-y-2">
          <label className="text-sm font-medium text-ink" htmlFor="generated-widget-code">Generated share URL or code</label>
          <textarea
            id="generated-widget-code"
            className="min-h-36 w-full rounded-control border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink"
            readOnly
            value={generated}
          />
          <a className="text-sm font-medium text-accent-deep underline" href={publicUrl}>Preview live {widget}</a>
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

  return (
    <main className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <Link className="text-xl font-semibold text-ink" to={`/event/${agenda.eventSlug}/sessions`}>{agenda.eventName}</Link>
              <p className="mt-1 text-sm text-ink-secondary">{agenda.location ?? "Online"} · {agenda.timezone}</p>
            </div>
            <Badge tone="success">Published program</Badge>
          </div>
          <nav className="mt-5 flex gap-1 overflow-x-auto" aria-label="Public event navigation">
            {SURFACES.map((item) => (
              <Link
                key={item.id}
                to={`/event/${agenda.eventSlug}/${item.id}`}
                aria-current={surface === item.id ? "page" : undefined}
                className={surface === item.id
                  ? "whitespace-nowrap rounded-control bg-accent px-3 py-2 text-sm font-medium text-on-accent"
                  : "whitespace-nowrap rounded-control px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-surface-muted hover:text-ink"}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        {surface === "sessions" ? <SessionsSurface agenda={agenda} gallery={gallery} onSelect={setSelectedTalk} /> : null}
        {surface === "speakers" ? <SpeakersSurface agenda={agenda} gallery={gallery} mode="list" onSelect={setSelectedSpeaker} /> : null}
        {surface === "agenda" ? <AgendaSurface agenda={agenda} onSelect={setSelectedTalk} /> : null}
        {surface === "schedule" ? <ScheduleSurface agenda={agenda} gallery={gallery} /> : null}
        {surface === "gallery" ? <SpeakersSurface agenda={agenda} gallery={gallery} mode="gallery" onSelect={setSelectedSpeaker} /> : null}
        {surface === "widgets" ? <WidgetsSurface agenda={agenda} /> : null}
      </div>
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
