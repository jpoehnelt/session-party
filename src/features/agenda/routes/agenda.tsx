import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { useEventRoom } from "@/client/socket";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Sheet,
  Skeleton,
  Tabs,
  Toaster,
  toast,
} from "@/ui";
import { AgendaBoard, type AgendaMoveTarget } from "../components/AgendaBoard";
import { ConflictIndicator } from "../components/ConflictIndicator";
import {
  AgendaMutationResult,
  AgendaSnapshot,
  PublishedAgenda,
  type AgendaTalk,
  type AgendaView,
  type BacklogProposal,
  type RealtimeIntentState,
} from "../schema";

export const path = "/e/:eventSlug/agenda";

interface EventIdentity {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
}

const views = [
  { id: "list", label: "List" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "track", label: "Track" },
  { id: "room", label: "Room" },
];

const idleIntent = (): RealtimeIntentState => ({
  clientIntentId: null,
  connection: typeof navigator !== "undefined" && navigator.onLine ? "reconnecting" : "offline",
  acknowledgement: "idle",
  sentAt: null,
  message: null,
});

const clientIntentId = () => `intent-${crypto.randomUUID()}`;
const idempotencyKey = (action: string) => `${action}-${crypto.randomUUID()}`;

const localInputValue = (timestamp: number | null, timezone: string) => {
  if (timestamp === null) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
};

/**
 * Interprets a wall time in the event zone. Nonexistent DST-gap values are
 * rejected; ambiguous fall-back values resolve to the earliest matching instant.
 */
export const zonedTimestamp = (value: string, timezone: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const desired = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const represented = localInputValue(candidate, timezone);
    const representedMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(represented);
    if (!representedMatch) return null;
    const representedUtc = Date.UTC(
      Number(representedMatch[1]),
      Number(representedMatch[2]) - 1,
      Number(representedMatch[3]),
      Number(representedMatch[4]),
      Number(representedMatch[5]),
    );
    candidate += desired - representedUtc;
  }

  const offsetCandidates = [-7_200_000, -3_600_000, -1_800_000, 0, 1_800_000, 3_600_000, 7_200_000]
    .map((offset) => candidate + offset)
    .filter((instant) => localInputValue(instant, timezone) === value);
  return offsetCandidates.length === 0 ? null : Math.min(...offsetCandidates);
};

const intentFailure = (error: unknown): Pick<RealtimeIntentState, "acknowledgement" | "message"> => {
  const message = error instanceof Error ? error.message : "Agenda change failed";
  const stale = error instanceof ApiError && error.status === 409 && /version|revision|changed|stale/i.test(message);
  return { acknowledgement: stale ? "stale" : "rejected", message };
};

function LoadingRegion({ label, className }: { readonly label: string; readonly className: string }) {
  return (
    <>
      <div role="status" aria-live="polite" aria-label={label}>
        <span className="sr-only">{label}</span>
        <Skeleton className={`${className} motion-reduce:animate-none`} />
      </div>
      <Toaster />
    </>
  );
}

export default function AgendaPage() {
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventIdentity | null | undefined>(undefined);
  const [eventError, setEventError] = useState<string | null>(null);
  const [eventRequest, setEventRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setEvent(undefined);
    setEventError(null);
    void apiFetch<EventIdentity>(`/api/v1/events/${encodeURIComponent(eventSlug)}`)
      .then((loaded) => {
        if (active) {
          setEventError(null);
          setEvent(loaded);
        }
      })
      .catch((error) => {
        if (!active) return;
        const notFound = error instanceof ApiError && error.status === 404;
        const message = error instanceof Error ? error.message : "Could not load event";
        setEventError(notFound ? null : message);
        setEvent(null);
        if (!notFound) toast(message, { tone: "danger" });
      });
    return () => { active = false; };
  }, [eventRequest, eventSlug]);

  if (event === undefined) {
    return <LoadingRegion label="Loading event agenda" className="h-48" />;
  }
  if (event === null) {
    const recoverable = eventError !== null;
    return (
      <>
        <EmptyState
          title={recoverable ? "Could not load event" : "Event not found"}
          description={eventError ?? "The event may have moved or been removed."}
          action={recoverable ? <Button onClick={() => setEventRequest((request) => request + 1)}>Try again</Button> : undefined}
        />
        <Toaster />
      </>
    );
  }
  return <AgendaWorkspace key={event.id} event={event} />;
}

type RefreshState =
  | { readonly status: "idle"; readonly message: null }
  | { readonly status: "refreshing"; readonly message: null }
  | { readonly status: "error"; readonly message: string };

function AgendaWorkspace({ event }: { readonly event: EventIdentity }) {
  const [view, setView] = useState<AgendaView>("day");
  const [agenda, setAgenda] = useState<AgendaSnapshot | null | undefined>(undefined);
  const [refresh, setRefresh] = useState<RefreshState>({ status: "idle", message: null });
  const [selectedTalkId, setSelectedTalkId] = useState<string | null>(null);
  const [intent, setIntent] = useState<RealtimeIntentState>(idleIntent);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ trackId: "", roomId: "", startsAt: "", durationMin: "30" });
  const agendaRequest = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const mounted = useRef(true);

  const fetchAgenda = useCallback((nextView: AgendaView) =>
    apiFetch<AgendaSnapshot>(
      `/api/v1/events/${encodeURIComponent(event.id)}/agenda?view=${encodeURIComponent(nextView)}`,
      { schema: AgendaSnapshot },
    ), [event.id]);

  const refreshAgenda = useCallback(async (nextView: AgendaView): Promise<AgendaSnapshot | null> => {
    const request = ++agendaRequest.current;
    setRefresh({ status: "refreshing", message: null });
    try {
      const loaded = await fetchAgenda(nextView);
      if (!mounted.current || request !== agendaRequest.current || nextView !== viewRef.current) return null;
      setAgenda(loaded);
      setRefresh({ status: "idle", message: null });
      return loaded;
    } catch (error) {
      if (!mounted.current || request !== agendaRequest.current || nextView !== viewRef.current) return null;
      const message = error instanceof Error ? error.message : "Could not load agenda";
      setAgenda((current) => current === undefined ? null : current);
      setRefresh({ status: "error", message });
      throw error;
    }
  }, [fetchAgenda]);

  const retryRefresh = useCallback(async () => {
    try {
      await refreshAgenda(viewRef.current);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not refresh agenda", { tone: "danger" });
    }
  }, [refreshAgenda]);

  const closeTalkSheet = useCallback(() => setSelectedTalkId(null), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      agendaRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    void refreshAgenda(view).catch((error) => {
      toast(error instanceof Error ? error.message : "Could not load agenda", { tone: "danger" });
    });
  }, [refreshAgenda, view]);

  useEventRoom(event.id, (message) => {
    setIntent((current) => ({ ...current, connection: "connected" }));
    if (message.t === "agenda/talk_upserted" || message.t === "agenda/talk_deleted" || message.t === "agenda/conflicts") {
      void refreshAgenda(viewRef.current).catch(() => {
        setIntent((current) => ({ ...current, connection: "reconnecting", message: "Live refresh missed; reconnecting." }));
      });
    }
  });

  useEffect(() => {
    const offline = () => setIntent((current) => ({ ...current, connection: "offline", message: "Changes are unavailable while offline." }));
    const online = () => {
      setIntent((current) => ({ ...current, connection: "reconnecting", message: "Connection restored; refreshing agenda." }));
      void refreshAgenda(viewRef.current).then((loaded) => {
        if (loaded) setIntent((current) => ({ ...current, connection: "connected", message: null }));
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "Could not refresh agenda";
        setIntent((current) => ({ ...current, connection: "reconnecting", message: `Connection restored, but refresh failed: ${message}` }));
        toast(`Agenda refresh failed: ${message}`, { tone: "danger" });
      });
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [refreshAgenda]);

  const selectedTalk = useMemo(
    () => agenda?.talks.find(({ id }) => id === selectedTalkId) ?? null,
    [agenda, selectedTalkId],
  );

  const selectTalk = (talk: AgendaTalk, message: string | null = null) => {
    setSelectedTalkId(talk.id);
    setForm({
      trackId: talk.trackId ?? "",
      roomId: talk.roomId ?? "",
      startsAt: localInputValue(talk.startsAt, event.timezone),
      durationMin: String(talk.durationMin),
    });
    if (message) setIntent((current) => ({ ...current, message }));
  };

  const runMutation = async <A,>(clientId: string, action: () => Promise<A>): Promise<A> => {
    setBusy(true);
    setIntent((current) => ({
      ...current,
      clientIntentId: clientId,
      acknowledgement: "pending",
      sentAt: Date.now(),
      message: "Waiting for the server to confirm this change.",
    }));
    try {
      const result = await action();
      setIntent((current) => ({
        ...current,
        clientIntentId: clientId,
        acknowledgement: "acknowledged",
        message: "Server acknowledged the change.",
      }));
      return result;
    } catch (error) {
      setIntent((current) => ({ ...current, clientIntentId: clientId, ...intentFailure(error) }));
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const refreshAfterCommit = async () => {
    try {
      await refreshAgenda(viewRef.current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh agenda";
      toast(`The change was saved, but the agenda refresh failed: ${message}`, { tone: "danger" });
    }
  };
  const refreshAfterStaleFailure = async (error: unknown) => {
    if (intentFailure(error).acknowledgement !== "stale") return;
    try {
      await refreshAgenda(viewRef.current);
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : "Could not refresh agenda";
      toast(`The change was rejected and the agenda refresh failed: ${message}`, { tone: "danger" });
    }
  };

  const createTalk = async (proposal: BacklogProposal) => {
    const clientId = clientIntentId();
    try {
      const result = await runMutation(clientId, () => apiFetch<AgendaMutationResult>(
        `/api/v1/events/${encodeURIComponent(event.id)}/agenda/talks`,
        {
          method: "POST",
          body: {
            submissionId: proposal.submissionId,
            trackId: null,
            roomId: null,
            startsAt: null,
            durationMin: 30,
            idempotencyKey: idempotencyKey("create-talk"),
          },
          schema: AgendaMutationResult,
        },
      ));
      selectTalk(result.talk);
      toast("Talk created", { tone: "success" });
      await refreshAfterCommit();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not create talk", { tone: "danger" });
      await refreshAfterStaleFailure(error);
    }
  };

  const moveTalk = async (talk: AgendaTalk, target: AgendaMoveTarget) => {
    if (target.roomId === null || target.startsAt === null) {
      selectTalk(talk, "Choose a room and start time in the move form.");
      return;
    }
    const clientId = clientIntentId();
    try {
      await runMutation(clientId, () => apiFetch<AgendaMutationResult>(
        `/api/v1/events/${encodeURIComponent(event.id)}/agenda/talks/${encodeURIComponent(talk.id)}/position`,
        {
          method: "PATCH",
          body: {
            trackId: target.trackId,
            roomId: target.roomId,
            startsAt: target.startsAt,
            durationMin: target.durationMin,
            expectedVersion: talk.version,
            idempotencyKey: idempotencyKey("move-talk"),
          },
          schema: AgendaMutationResult,
        },
      ));
      toast("Talk moved", { tone: "success" });
      await refreshAfterCommit();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not move talk", { tone: "danger" });
      await refreshAfterStaleFailure(error);
    }
  };

  const saveSchedule = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (!selectedTalk) return;
    const startsAt = zonedTimestamp(form.startsAt, event.timezone);
    const durationMin = Number(form.durationMin);
    if (!form.roomId || startsAt === null || !Number.isInteger(durationMin) || durationMin < 5 || durationMin > 480) {
      toast("Choose a room, valid start time, and duration from 5 to 480 minutes", { tone: "danger" });
      return;
    }
    const clientId = clientIntentId();
    const operation = selectedTalk.status === "draft" ? "schedule" : "position";
    const method = selectedTalk.status === "draft" ? "PUT" : "PATCH";
    try {
      const result = await runMutation(clientId, () => apiFetch<AgendaMutationResult>(
        `/api/v1/events/${encodeURIComponent(event.id)}/agenda/talks/${encodeURIComponent(selectedTalk.id)}/${operation}`,
        {
          method,
          body: {
            trackId: form.trackId || null,
            roomId: form.roomId,
            startsAt,
            durationMin,
            expectedVersion: selectedTalk.version,
            idempotencyKey: idempotencyKey(selectedTalk.status === "draft" ? "schedule-talk" : "move-talk"),
          },
          schema: AgendaMutationResult,
        },
      ));
      selectTalk(result.talk);
      toast(selectedTalk.status === "draft" ? "Talk scheduled" : "Talk moved", { tone: "success" });
      await refreshAfterCommit();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save schedule", { tone: "danger" });
      await refreshAfterStaleFailure(error);
    }
  };

  const cancelTalk = async () => {
    if (!selectedTalk) return;
    const clientId = clientIntentId();
    try {
      await runMutation(clientId, () => apiFetch<AgendaMutationResult>(
        `/api/v1/events/${encodeURIComponent(event.id)}/agenda/talks/${encodeURIComponent(selectedTalk.id)}`,
        {
          method: "DELETE",
          body: {
            expectedVersion: selectedTalk.version,
            idempotencyKey: idempotencyKey("cancel-talk"),
          },
          schema: AgendaMutationResult,
        },
      ));
      closeTalkSheet();
      toast("Talk cancelled", { tone: "success" });
      await refreshAfterCommit();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not cancel talk", { tone: "danger" });
      await refreshAfterStaleFailure(error);
    }
  };

  const publish = async () => {
    if (!agenda) return;
    const clientId = clientIntentId();
    try {
      const published = await runMutation(clientId, () => apiFetch<PublishedAgenda>(
        `/api/v1/events/${encodeURIComponent(event.id)}/agenda/publications`,
        {
          method: "POST",
          body: {
            expectedRevision: agenda.publication.revision,
            expectedWorkspaceVersion: agenda.workspaceVersion,
            idempotencyKey: idempotencyKey("publish-agenda"),
          },
          schema: PublishedAgenda,
        },
      ));
      toast(`Agenda revision ${published.revision} published`, { tone: "success" });
      await refreshAfterCommit();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not publish agenda", { tone: "danger" });
      await refreshAfterStaleFailure(error);
    }
  };

  if (agenda === undefined) {
    return <LoadingRegion label={`Loading ${event.name} agenda`} className="h-[36rem]" />;
  }
  if (agenda === null) {
    return (
      <>
        <PageHeader title={event.name} description={`Agenda · ${event.timezone}`} />
        <EmptyState
          title="Agenda unavailable"
          description={refresh.message ?? "Refresh after the agenda operations are activated for this event."}
          action={
            <Button
              loading={refresh.status === "refreshing"}
              disabled={refresh.status === "refreshing"}
              onClick={() => void retryRefresh()}
            >
              Try again
            </Button>
          }
        />
        <Toaster />
      </>
    );
  }

  const selectedConflicts = selectedTalk
    ? agenda.conflicts.filter(({ talkIds }) => talkIds.includes(selectedTalk.id))
    : [];

  return (
    <>
      <PageHeader
        title={agenda.eventName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>Agenda operations</span>
            <span aria-hidden="true">·</span>
            <span>{agenda.timezone}</span>
            <Badge tone={agenda.publication.revision > 0 ? "success" : "neutral"}>
              {agenda.publication.revision > 0 ? `Published r${agenda.publication.revision}` : "Private draft"}
            </Badge>
          </span>
        }
        actions={
          <Button
            disabled={busy || refresh.status !== "idle" || agenda.conflicts.length > 0}
            loading={busy && intent.acknowledgement === "pending"}
            onClick={() => void publish()}
          >
            Publish revision
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          tabs={views}
          active={view}
          onChange={(id) => setView(id as AgendaView)}
        />
        <p className="hidden text-xs text-ink-faint md:block">Confirmed talks stay private until this revision is published.</p>
      </div>
      {refresh.status !== "idle" && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink-secondary" role="status" aria-live="polite">
          <Badge tone={refresh.status === "error" ? "danger" : "neutral"}>
            {refresh.status === "error" ? "Refresh failed" : "Refreshing"}
          </Badge>
          <span>
            {refresh.status === "error" ? refresh.message : `Updating the ${view} view without clearing the board.`}
          </span>
          {refresh.status === "error" && (
            <Button size="sm" variant="secondary" onClick={() => void retryRefresh()}>Retry refresh</Button>
          )}
        </div>
      )}
      <AgendaBoard
        agenda={agenda}
        view={view}
        intent={intent}
        selectedTalkId={selectedTalkId}
        disabled={busy || refresh.status !== "idle" || intent.connection === "offline"}
        onCreateTalk={(proposal) => void createTalk(proposal)}
        onSelectTalk={selectTalk}
        onMoveTalk={(talk, target) => void moveTalk(talk, target)}
      />

      <Sheet
        open={selectedTalk !== null}
        onClose={closeTalkSheet}
        title={selectedTalk?.title ?? "Talk details"}
        size="lg"
        footer={
          selectedTalk ? (
            <div className="flex w-full items-center justify-between gap-3">
              <Button variant="danger" disabled={busy || refresh.status !== "idle"} onClick={() => void cancelTalk()}>Cancel talk</Button>
              <Button form="agenda-move-form" type="submit" loading={busy} disabled={refresh.status !== "idle"}>Save schedule</Button>
            </div>
          ) : null
        }
      >
        {selectedTalk && (
          <form id="agenda-move-form" className="space-y-5" onSubmit={(event) => void saveSchedule(event)}>
            <div className="rounded-control border border-line bg-surface-muted p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Speakers</p>
              <p className="mt-1 text-sm text-ink">{selectedTalk.speakerNames.join(", ")}</p>
              <p className="mt-1 text-xs text-ink-secondary">Current version {selectedTalk.version}</p>
            </div>
            <ConflictIndicator conflicts={selectedConflicts} />
            <Select
              label="Track"
              value={form.trackId}
              onChange={(event) => setForm((current) => ({ ...current, trackId: event.target.value }))}
            >
              <option value="">No track</option>
              {agenda.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
            </Select>
            <Select
              required
              label="Room"
              value={form.roomId}
              onChange={(event) => setForm((current) => ({ ...current, roomId: event.target.value }))}
            >
              <option value="">Choose room</option>
              {agenda.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
            </Select>
            <Input
              required
              type="datetime-local"
              label={`Start time (${agenda.timezone})`}
              value={form.startsAt}
              onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))}
              hint="This wall time is interpreted in the event timezone, not your device timezone."
            />
            <Input
              required
              type="number"
              min={5}
              max={480}
              step={5}
              label="Duration (minutes)"
              value={form.durationMin}
              onChange={(event) => setForm((current) => ({ ...current, durationMin: event.target.value }))}
            />
          </form>
        )}
      </Sheet>
      <Toaster />
    </>
  );
}
