import { useState } from "react";
import { EmptyState, ScheduleList, Tabs } from "@/ui";
import type {
  AgendaView,
  PublishedAgenda,
  PublicAgendaTalk,
} from "@/features/agenda/schema";

export interface PublishedScheduleProps {
  readonly agenda: PublishedAgenda;
  readonly compact?: boolean;
  readonly initialView?: AgendaView;
}

interface ScheduleGroup {
  readonly key: string;
  readonly label: string;
  readonly talks: readonly PublicAgendaTalk[];
}

const DAY_MS = 86_400_000;
const VIEW_LABELS: Record<AgendaView, string> = {
  list: "List",
  day: "Day",
  week: "Week",
  track: "Track",
  room: "Room",
};

const GROUP_ACCENTS = [
  "bg-production-sky",
  "bg-production-lime",
  "bg-production-coral",
  "bg-production-yellow",
] as const;

const zonedDateParts = (startsAt: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(startsAt);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { day: value("day"), month: value("month"), year: value("year") };
};

const localDayKey = (startsAt: number, timezone: string) => {
  const { day, month, year } = zonedDateParts(startsAt, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const localWeekStart = (startsAt: number, timezone: string) => {
  const { day, month, year } = zonedDateParts(startsAt, timezone);
  const localDate = Date.UTC(year, month - 1, day);
  const daysFromMonday = (new Date(localDate).getUTCDay() + 6) % 7;
  return localDate - daysFromMonday * DAY_MS;
};

function scheduleGroups(
  agenda: PublishedAgenda,
  view: AgendaView,
): readonly ScheduleGroup[] {
  const talks = [...agenda.talks].sort(
    (left, right) =>
      left.startsAt - right.startsAt ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  );
  if (view === "list") {
    return [{ key: "all", label: "All sessions", talks }];
  }

  const dayLabel = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    timeZone: agenda.timezone,
    weekday: "long",
    year: "numeric",
  });
  const weekLabel = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
  const groups = new Map<string, { label: string; talks: PublicAgendaTalk[] }>();

  for (const talk of talks) {
    let key: string;
    let label: string;
    if (view === "day") {
      key = localDayKey(talk.startsAt, agenda.timezone);
      label = dayLabel.format(talk.startsAt);
    } else if (view === "week") {
      const weekStart = localWeekStart(talk.startsAt, agenda.timezone);
      key = String(weekStart);
      label = `${weekLabel.format(weekStart)} – ${weekLabel.format(weekStart + 6 * DAY_MS)}`;
    } else if (view === "track") {
      label = talk.track?.trim() || "Unassigned track";
      key = label;
    } else {
      label = talk.room?.trim() || "Unassigned room";
      key = label;
    }
    const group = groups.get(key);
    if (group) {
      group.talks.push(talk);
    } else {
      groups.set(key, { label, talks: [talk] });
    }
  }

  return [...groups].map(([key, group]) => ({ key, ...group }));
}

export function PublishedSchedule({
  agenda,
  compact = false,
  initialView = "day",
}: PublishedScheduleProps) {
  const supportsTrack = agenda.talks.some((talk) => Boolean(talk.track?.trim()));
  const supportsRoom = agenda.talks.some((talk) => Boolean(talk.room?.trim()));
  const tabs = ([
    { id: "list", label: VIEW_LABELS.list },
    { id: "day", label: VIEW_LABELS.day },
    { id: "week", label: VIEW_LABELS.week },
    ...(supportsTrack ? [{ id: "track" as const, label: VIEW_LABELS.track }] : []),
    ...(supportsRoom ? [{ id: "room" as const, label: VIEW_LABELS.room }] : []),
  ]) satisfies { id: AgendaView; label: string }[];
  const [selectedView, setSelectedView] = useState<AgendaView>(initialView);
  const view = tabs.some(({ id }) => id === selectedView) ? selectedView : "list";

  if (agenda.talks.length === 0) {
    return (
      <EmptyState
        title="Schedule coming soon"
        description="This schedule is published, but no sessions have been added to it yet."
      />
    );
  }

  const groups = scheduleGroups(agenda, view);
  const sessionLabel = `${agenda.talks.length} ${agenda.talks.length === 1 ? "session" : "sessions"}`;

  return (
    <div className={compact ? "space-y-5" : "space-y-8"}>
      <section
        aria-label="Schedule display controls"
        className="grid border-2 border-line-strong bg-surface shadow-[5px_5px_0_#171714] lg:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="min-w-0 p-3 sm:p-4">
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-accent-deep">
            Cut the schedule by
          </p>
          <Tabs
            tabs={tabs}
            active={view}
            onChange={(id) => setSelectedView(id as AgendaView)}
            className="max-w-full overflow-x-auto shadow-none"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t-2 border-line-strong bg-ink px-4 py-3 text-on-accent lg:min-w-52 lg:flex-col lg:items-start lg:justify-center lg:border-l-2 lg:border-t-0">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-production-sky">Audience clock</p>
          <p className="text-sm font-black">{agenda.timezone}</p>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">{sessionLabel} on air</p>
        </div>
      </section>
      <div
        role="region"
        aria-label={`${VIEW_LABELS[view]} schedule view`}
        className={compact ? "space-y-6" : "space-y-10"}
      >
        {groups.map((group, index) => (
          <section
            key={group.key}
            {...(view === "list"
              ? { "aria-label": "All sessions" }
              : { "aria-labelledby": `schedule-group-${index}` })}
          >
            {view === "list" ? null : (
              <div className="mb-4 flex items-stretch">
                <h2
                  id={`schedule-group-${index}`}
                  className={`min-w-0 border-2 border-line-strong px-3 py-2.5 text-sm font-black uppercase tracking-[0.08em] text-ink shadow-[3px_3px_0_#171714] sm:px-4 sm:text-base ${GROUP_ACCENTS[index % GROUP_ACCENTS.length] ?? "bg-production-sky"}`}
                >
                  {group.label}
                </h2>
                <span className="my-auto h-0.5 min-w-4 flex-1 bg-line-strong" aria-hidden="true" />
                <span className="my-auto border-y-2 border-r-2 border-line-strong bg-surface px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">
                  {String(group.talks.length).padStart(2, "0")} cues
                </span>
              </div>
            )}
            <ScheduleList
              className="rounded-none shadow-[6px_6px_0_#171714] [&>li:nth-child(even)>div:last-child]:bg-production-sky/15"
              timezone={agenda.timezone}
              talks={group.talks.map((talk) => ({
                id: talk.id,
                title: talk.title,
                startsAt: new Date(talk.startsAt).toISOString(),
                durationMin: talk.durationMin,
                speakerNames: talk.speakerNames,
                ...(talk.description === null ? {} : { description: talk.description }),
                ...(talk.track === null ? {} : { track: talk.track }),
                ...(talk.room === null ? {} : { room: talk.room }),
              }))}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
