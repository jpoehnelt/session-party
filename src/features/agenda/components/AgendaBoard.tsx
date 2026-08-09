import { useEffect, useId, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { Badge, Button, Card, EmptyState, Table } from "@/ui";
import type {
  AgendaSnapshot,
  AgendaTalk,
  AgendaView,
  BacklogProposal,
  RealtimeIntentState,
} from "../schema";
import { ConflictIndicator } from "./ConflictIndicator";

export interface AgendaMoveTarget {
  readonly trackId: string | null;
  readonly roomId: string | null;
  readonly startsAt: number | null;
  readonly durationMin: number;
}

export interface AgendaBoardProps {
  readonly agenda: AgendaSnapshot;
  readonly view: AgendaView;
  readonly intent: RealtimeIntentState;
  readonly selectedTalkId?: string | null;
  readonly disabled?: boolean;
  readonly onCreateTalk: (proposal: BacklogProposal) => void;
  readonly onSelectTalk: (talk: AgendaTalk) => void;
  readonly onMoveTalk: (talk: AgendaTalk, target: AgendaMoveTarget) => void;
}

interface Lane {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly talks: readonly AgendaTalk[];
  readonly target?: Pick<AgendaMoveTarget, "roomId" | "trackId">;
}

const timeFormatter = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  });

const dateFormatter = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  });

const dateKey = (startsAt: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(startsAt);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

const connectionLabel = (intent: RealtimeIntentState) => {
  if (intent.connection === "offline") return { label: "Offline", tone: "danger" as const };
  if (intent.connection === "reconnecting") return { label: "Reconnecting", tone: "warning" as const };
  if (intent.acknowledgement === "pending") return { label: "Waiting for acknowledgement", tone: "warning" as const };
  if (intent.acknowledgement === "stale") return { label: "Stale change", tone: "danger" as const };
  if (intent.acknowledgement === "rejected") return { label: "Change rejected", tone: "danger" as const };
  if (intent.acknowledgement === "acknowledged") return { label: "Saved", tone: "success" as const };
  return { label: "Live", tone: "success" as const };
};

export function AgendaBoard({
  agenda,
  view,
  intent,
  selectedTalkId = null,
  disabled = false,
  onCreateTalk,
  onSelectTalk,
  onMoveTalk,
}: AgendaBoardProps) {
  const boardHeadingId = useId();
  const [draggedTalkId, setDraggedTalkId] = useState<string | null>(null);
  const connection = connectionLabel(intent);
  const scheduled = useMemo(
    () => agenda.talks
      .filter(({ status }) => status !== "cancelled")
      .sort((left, right) =>
        (left.startsAt ?? Number.MAX_SAFE_INTEGER) - (right.startsAt ?? Number.MAX_SAFE_INTEGER) ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id),
      ),
    [agenda.talks],
  );
  const time = useMemo(() => timeFormatter(agenda.timezone), [agenda.timezone]);
  const date = useMemo(() => dateFormatter(agenda.timezone), [agenda.timezone]);
  const availableDays = useMemo(() => {
    const days = new Map<string, number>();
    for (const talk of scheduled) {
      if (talk.startsAt === null) continue;
      const key = dateKey(talk.startsAt, agenda.timezone);
      if (!days.has(key)) days.set(key, talk.startsAt);
    }
    return [...days.entries()]
      .sort(([, left], [, right]) => left - right)
      .map(([key, startsAt]) => ({ key, label: date.format(startsAt) }));
  }, [agenda.timezone, date, scheduled]);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  useEffect(() => {
    setActiveDay((current) =>
      current && availableDays.some(({ key }) => key === current)
        ? current
        : availableDays[0]?.key ?? null,
    );
  }, [agenda.eventId, availableDays]);
  const activeDayLabel = availableDays.find(({ key }) => key === activeDay)?.label ?? "No scheduled day";
  const activeDayTalks = useMemo(
    () => activeDay === null
      ? []
      : scheduled.filter((talk) =>
        talk.startsAt !== null && dateKey(talk.startsAt, agenda.timezone) === activeDay,
      ),
    [activeDay, agenda.timezone, scheduled],
  );

  const lanes = useMemo<readonly Lane[]>(() => {
    if (view === "track") {
      return [
        ...agenda.tracks.map((track) => ({
          id: `track:${track.id}`,
          label: track.name,
          hint: "Track",
          talks: scheduled.filter(({ trackId }) => trackId === track.id),
          target: { trackId: track.id, roomId: null },
        })),
        {
          id: "track:unassigned",
          label: "Unassigned track",
          hint: "Needs placement",
          talks: scheduled.filter(({ trackId }) => trackId === null),
          target: { trackId: null, roomId: null },
        },
      ];
    }
    if (view === "room") {
      return agenda.rooms.map((room) => ({
        id: `room:${room.id}`,
        label: `${room.name} · ${activeDayLabel}`,
        hint: room.capacity === null ? "Room" : `${room.capacity} seats`,
        talks: activeDayTalks.filter(({ roomId }) => roomId === room.id),
        target: { trackId: null, roomId: room.id },
      }));
    }
    if (view === "day") {
      return agenda.rooms.map((room) => ({
        id: `room:${room.id}`,
        label: `${room.name} · ${activeDayLabel}`,
        hint: room.capacity === null ? "Room" : `${room.capacity} seats`,
        talks: activeDayTalks.filter(({ roomId }) => roomId === room.id),
        target: { trackId: null, roomId: room.id },
      }));
    }
    if (view === "week") {
      const days = new Map<string, AgendaTalk[]>();
      for (const talk of scheduled) {
        const key = talk.startsAt === null ? "unscheduled" : dateKey(talk.startsAt, agenda.timezone);
        const entries = days.get(key) ?? [];
        entries.push(talk);
        days.set(key, entries);
      }
      return [...days.entries()].map(([key, talks]) => ({
        id: `day:${key}`,
        label: key === "unscheduled" || talks[0]?.startsAt === null ? "Unscheduled" : date.format(talks[0]!.startsAt!),
        hint: `${talks.length} ${talks.length === 1 ? "talk" : "talks"}`,
        talks,
      }));
    }
    return [];
  }, [activeDayLabel, activeDayTalks, agenda.rooms, agenda.timezone, agenda.tracks, date, scheduled, view]);

  const dropOnLane = (event: DragEvent<HTMLElement>, lane: Lane) => {
    event.preventDefault();
    const talkId = event.dataTransfer.getData("text/agenda-talk") || draggedTalkId;
    const talk = agenda.talks.find(({ id }) => id === talkId);
    setDraggedTalkId(null);
    if (!talk || !lane.target || disabled) return;
    onMoveTalk(talk, {
      trackId: lane.id.startsWith("track:") ? lane.target.trackId : talk.trackId,
      roomId: lane.id.startsWith("room:") ? lane.target.roomId : talk.roomId,
      startsAt: talk.startsAt,
      durationMin: talk.durationMin,
    });
  };

  const openWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, talk: AgendaTalk) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectTalk(talk);
  };

  return (
    <section className="space-y-5" aria-labelledby={boardHeadingId}>
      <h2 id={boardHeadingId} className="sr-only">{agenda.eventName} agenda scheduling board</h2>
      <div className="flex flex-wrap items-center justify-between gap-4 border-2 border-line-strong bg-ink px-4 py-3 text-on-accent shadow-card sm:px-5">
        <div className="flex flex-wrap items-center gap-3 text-xs font-black uppercase tracking-[0.09em]">
          <span className="bg-production-lime px-2.5 py-1.5 text-ink">Cue clock · {agenda.timezone}</span>
          <span>{scheduled.length} active</span>
          <span className="text-on-accent/35" aria-hidden="true">◆</span>
          <span>{agenda.backlog.length} waiting</span>
          <span className="text-on-accent/35" aria-hidden="true">◆</span>
          <span>{agenda.warnings.unplacedTalkCount} unplaced</span>
          {agenda.warnings.conflictCount > 0 && (
            <>
              <span className="text-on-accent/35" aria-hidden="true">◆</span>
              <span>{agenda.warnings.conflictCount} scheduling warnings</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <Badge tone={connection.tone}>{connection.label}</Badge>
          {intent.message && <span className="max-w-md text-xs font-semibold text-on-accent/70">{intent.message}</span>}
        </div>
      </div>

      <ConflictIndicator conflicts={agenda.conflicts} blocking={false} />

      {(view === "day" || view === "room") && (
        <fieldset
          className="flex items-center gap-2 overflow-x-auto border-2 border-line-strong bg-production-sky px-3 py-3 shadow-[4px_4px_0_#171714]"
        >
          <legend className="sr-only">Choose active agenda day in {agenda.timezone}</legend>
          <span className="mr-1 shrink-0 text-[10px] font-black uppercase tracking-[0.14em] text-ink" aria-hidden="true">On deck</span>
          {availableDays.length === 0 ? (
            <span className="text-sm font-semibold text-ink-secondary">Schedule a talk to create the first day rail.</span>
          ) : availableDays.map((day) => (
            <Button
              className="shrink-0"
              key={day.key}
              size="sm"
              variant={activeDay === day.key ? "primary" : "secondary"}
              aria-pressed={activeDay === day.key}
              onClick={() => setActiveDay(day.key)}
            >
              {day.label}
            </Button>
          ))}
        </fieldset>
      )}

      <div className="grid min-h-[34rem] gap-6 xl:grid-cols-[19rem_minmax(0,1fr)]">

        <section
          className="order-1 min-w-0 xl:order-2"
          aria-label={
            view === "day"
              ? `Day agenda for ${activeDayLabel}`
              : view === "room"
                ? `Room agenda for ${activeDayLabel}`
                : `${view} agenda view`
          }
        >
          {view === "list" ? (
            <Table
              columns={[
                {
                  key: "title",
                  header: "Talk",
                  render: (talk) => (
                    <button
                      type="button"
                      className="text-left font-medium text-ink underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      onClick={() => onSelectTalk(talk)}
                    >
                      {talk.title}
                    </button>
                  ),
                },
                { key: "speakerNames", header: "Speakers", render: (talk) => talk.speakerNames.join(", ") },
                {
                  key: "startsAt",
                  header: `Start (${agenda.timezone})`,
                  render: (talk) => talk.startsAt === null ? "Unscheduled" : `${date.format(talk.startsAt)}, ${time.format(talk.startsAt)}`,
                },
                {
                  key: "placement",
                  header: "Placement",
                  render: (talk) => [
                    agenda.tracks.find(({ id }) => id === talk.trackId)?.name,
                    agenda.rooms.find(({ id }) => id === talk.roomId)?.name,
                  ].filter(Boolean).join(" · ") || "Unassigned",
                },
                { key: "durationMin", header: "Duration", render: (talk) => `${talk.durationMin} min` },
                { key: "status", header: "Status", render: (talk) => <Badge tone={talk.status === "confirmed" ? "success" : "neutral"}>{talk.status}</Badge> },
              ]}
              rows={[...scheduled]}
              rowKey={(talk) => talk.id}
              empty={<EmptyState title="No talks yet" description="Create a talk from the accepted backlog." />}
            />
          ) : lanes.length === 0 ? (
            <EmptyState
              title={view === "day" ? "No scheduled days" : "No schedule lanes"}
              description={view === "day" ? "Schedule a talk to create the first event day." : "Add rooms or tracks before placing talks."}
            />
          ) : (
            <div className="overflow-x-auto pb-4">
              <div className="grid min-w-max auto-cols-[19rem] grid-flow-col gap-4 pr-1">
                {lanes.map((lane, laneIndex) => (
                  <section
                    key={lane.id}
                    className="min-h-[30rem] border-2 border-line-strong bg-surface-muted shadow-[5px_5px_0_#171714]"
                    aria-label={lane.label}
                    onDragOver={lane.target ? (event) => event.preventDefault() : undefined}
                    onDrop={lane.target ? (event) => dropOnLane(event, lane) : undefined}
                  >
                    <header className="sticky top-0 z-10 flex min-h-[4.5rem] items-center justify-between border-b-2 border-line-strong bg-surface-muted px-3 py-3 text-ink">
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-[0.15em] opacity-65">Lane {String(laneIndex + 1).padStart(2, "0")}</p>
                        <h3 className="mt-0.5 text-base font-black leading-tight tracking-[-0.03em]">{lane.label}</h3>
                        <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.09em] opacity-65">{lane.hint}</p>
                      </div>
                      <span className="grid size-8 place-items-center border-2 border-line-strong bg-surface text-xs font-black text-ink shadow-[2px_2px_0_#171714]">
                        {lane.talks.length}
                      </span>
                    </header>
                    <ol className="space-y-3 p-3">
                      {lane.talks.map((talk) => {
                        const talkConflicts = agenda.conflicts.filter(({ talkIds }) => talkIds.includes(talk.id));
                        const formattedStart = talk.startsAt === null
                          ? "Unscheduled"
                          : view === "room"
                            ? `${date.format(talk.startsAt)}, ${time.format(talk.startsAt)}`
                            : time.format(talk.startsAt);
                        return (
                          <li
                            key={talk.id}
                            draggable={!disabled}
                            onDragStart={(event) => {
                              setDraggedTalkId(talk.id);
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/agenda-talk", talk.id);
                            }}
                            onDragEnd={() => setDraggedTalkId(null)}
                            className={`border-2 bg-surface p-3 shadow-[3px_3px_0_#171714] transition motion-reduce:transition-none ${
                              selectedTalkId === talk.id ? "border-accent bg-accent-soft ring-2 ring-accent ring-offset-2" : "border-line-strong"
                            } ${draggedTalkId === talk.id ? "opacity-50" : ""}`}
                          >
                            <button
                              type="button"
                              className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                              aria-label={`Edit ${talk.title}. ${formattedStart}. Press Enter for move controls.`}
                              onClick={() => onSelectTalk(talk)}
                              onKeyDown={(event) => openWithKeyboard(event, talk)}
                            >
                              <span className="flex items-start justify-between gap-2">
                                <span className={`px-1.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-ink ${
                                  talk.status === "confirmed" ? "bg-production-lime" : "bg-production-yellow"
                                }`}>
                                  {formattedStart}
                                </span>
                                <span className="text-[10px] font-black uppercase tracking-[0.1em] text-ink-faint">{talk.durationMin}m</span>
                              </span>
                              <span className="mt-2 block text-base font-black leading-tight tracking-[-0.025em] text-ink">{talk.title}</span>
                              <span className="mt-1.5 block border-t border-line pt-1.5 text-xs font-semibold text-ink-secondary">{talk.speakerNames.join(", ")}</span>
                            </button>
                            {talkConflicts.length > 0 && (
                              <div className="mt-2">
                                <ConflictIndicator conflicts={talkConflicts} compact />
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ))}
              </div>
            </div>
          )}
        </section>
        <Card
          className="order-2 self-start xl:order-1"
          title={<span className="flex items-center justify-between"><span>Accepted backlog</span><Badge tone="accent">{agenda.backlog.length}</Badge></span>}
        >
          {agenda.backlog.length === 0 ? (
            <EmptyState
              title="Backlog clear"
              description="Accepted, provisioned proposals appear here until a talk is created."
            />
          ) : (
            <ol className="space-y-3">
              {agenda.backlog.map((proposal) => (
                <li key={proposal.submissionId} className="border-2 border-line-strong bg-production-yellow/25 p-3 shadow-[3px_3px_0_#171714] odd:bg-production-sky/35">
                  <p className="text-sm font-black leading-snug tracking-[-0.015em] text-ink">{proposal.title}</p>
                  <p className="mt-1.5 text-xs font-semibold text-ink-secondary">
                    {proposal.primarySpeakerName}{proposal.category ? ` · ${proposal.category}` : ""}
                  </p>
                  <Button
                    className="mt-3 w-full"
                    size="sm"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => onCreateTalk(proposal)}
                  >
                    Create talk
                  </Button>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      <p className="border-l-4 border-accent bg-surface px-4 py-2.5 text-xs font-semibold text-ink-secondary">
        <span className="font-black uppercase tracking-[0.1em] text-ink">Stage direction:</span>{" "}
        Drag a talk between track or room lanes. For exact track, room, start, and duration changes, open the talk and use the labeled form controls.
      </p>
    </section>
  );
}
