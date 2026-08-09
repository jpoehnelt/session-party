import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { useEventRoom } from "@/client/socket";
import { loginPathForLocation } from "@/client/return-to";
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
  RoomMutationResult,
  TrackMutationResult,
  type AgendaTalk,
  type AgendaView,
  type BacklogProposal,
  type RealtimeIntentState,
  type Room,
  type Track,
} from "../schema";

export const path = "/e/:eventSlug/agenda";

interface EventIdentity {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
}

const views = [
  { id: "list", label: "List", panelId: "agenda-view-list" },
  { id: "day", label: "Day", panelId: "agenda-view-day" },
  { id: "week", label: "Week", panelId: "agenda-view-week" },
  { id: "track", label: "Track", panelId: "agenda-view-track" },
  { id: "room", label: "Room", panelId: "agenda-view-room" },
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

interface TrackDraft {
  readonly id: string | null;
  readonly name: string;
  readonly color: string;
  readonly order: string;
  readonly version: number;
}

interface RoomDraft {
  readonly id: string | null;
  readonly name: string;
  readonly capacity: string;
  readonly order: string;
  readonly version: number;
}

const emptyTrackDraft = (): TrackDraft => ({ id: null, name: "", color: "", order: "0", version: 0 });
const emptyRoomDraft = (): RoomDraft => ({ id: null, name: "", capacity: "", order: "0", version: 0 });

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
  const location = useLocation();
  const navigate = useNavigate();
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
        const unauthorized = error instanceof ApiError && error.status === 401;
        const notFound = error instanceof ApiError && error.status === 404;
        const message = error instanceof Error ? error.message : "Could not load event";
        setEventError(notFound ? null : unauthorized ? "unauthenticated" : message);
        setEvent(null);
        if (!notFound && !unauthorized) toast(message, { tone: "danger" });
      });
    return () => { active = false; };
  }, [eventRequest, eventSlug]);

  if (event === undefined) {
    return <LoadingRegion label="Loading event agenda" className="h-48" />;
  }
  if (event === null) {
    if (eventError === "unauthenticated") {
      return (
        <>
          <EmptyState
            title="Sign in to view this event"
            description="Sign in to continue to this event agenda."
            action={
              <Button
                className="min-h-11"
                onClick={() => navigate(loginPathForLocation(location))}
              >
                Sign in
              </Button>
            }
          />
          <Toaster />
        </>
      );
    }

    const recoverable = eventError !== null;
    return (
      <>
        <EmptyState
          title={recoverable ? "Could not load event" : "Event not found"}
          description={eventError ?? "The event may have moved or been removed."}
          action={
            recoverable ? (
              <Button className="min-h-11" onClick={() => setEventRequest((request) => request + 1)}>
                Try again
              </Button>
            ) : undefined
          }
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
  const [setupOpen, setSetupOpen] = useState(false);
  const [trackDraft, setTrackDraft] = useState<TrackDraft>(emptyTrackDraft);
  const [roomDraft, setRoomDraft] = useState<RoomDraft>(emptyRoomDraft);
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

  const editTrack = (track: Track) => {
    setTrackDraft({
      id: track.id,
      name: track.name,
      color: track.color ?? "",
      order: String(track.order),
      version: track.version,
    });
  };

  const editRoom = (room: Room) => {
    setRoomDraft({
      id: room.id,
      name: room.name,
      capacity: room.capacity === null ? "" : String(room.capacity),
      order: String(room.order),
      version: room.version,
    });
  };

  const saveTrack = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const name = trackDraft.name.trim();
    const color = trackDraft.color.trim() || null;
    const order = Number(trackDraft.order);
    if (!name || !Number.isInteger(order) || order < 0 || order > 10_000) {
      toast("Enter a track name and an order from 0 to 10,000", { tone: "danger" });
      return;
    }
    if (color !== null && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      toast("Track color must be a six-digit hex value such as #2563EB", { tone: "danger" });
      return;
    }
    const updating = trackDraft.id !== null;
    const path = updating
      ? `/api/v1/events/${encodeURIComponent(event.id)}/agenda/tracks/${encodeURIComponent(trackDraft.id!)}`
      : `/api/v1/events/${encodeURIComponent(event.id)}/agenda/tracks`;
    const clientId = clientIntentId();
    try {
      await runMutation(clientId, () => apiFetch<TrackMutationResult>(path, {
        method: updating ? "PATCH" : "POST",
        body: {
          name,
          color,
          order,
          ...(updating ? { expectedVersion: trackDraft.version } : {}),
          idempotencyKey: idempotencyKey(updating ? "update-track" : "create-track"),
        },
        schema: TrackMutationResult,
      }));
      setTrackDraft(emptyTrackDraft());
      toast(updating ? "Track updated" : "Track created", { tone: "success" });
      await refreshAfterCommit();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save track", { tone: "danger" });
      await refreshAfterStaleFailure(error);
    }
  };

  const saveRoom = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const name = roomDraft.name.trim();
    const capacity = roomDraft.capacity.trim() === "" ? null : Number(roomDraft.capacity);
    const order = Number(roomDraft.order);
    if (!name || !Number.isInteger(order) || order < 0 || order > 10_000) {
      toast("Enter a room name and an order from 0 to 10,000", { tone: "danger" });
      return;
    }
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000)) {
      toast("Room capacity must be a whole number from 1 to 1,000,000", { tone: "danger" });
      return;
    }
    const updating = roomDraft.id !== null;
    const path = updating
      ? `/api/v1/events/${encodeURIComponent(event.id)}/agenda/rooms/${encodeURIComponent(roomDraft.id!)}`
      : `/api/v1/events/${encodeURIComponent(event.id)}/agenda/rooms`;
    const clientId = clientIntentId();
    try {
      await runMutation(clientId, () => apiFetch<RoomMutationResult>(path, {
        method: updating ? "PATCH" : "POST",
        body: {
          name,
          capacity,
          order,
          ...(updating ? { expectedVersion: roomDraft.version } : {}),
          idempotencyKey: idempotencyKey(updating ? "update-room" : "create-room"),
        },
        schema: RoomMutationResult,
      }));
      setRoomDraft(emptyRoomDraft());
      toast(updating ? "Room updated" : "Room created", { tone: "success" });
      await refreshAfterCommit();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save room", { tone: "danger" });
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
            expectedEventVersion: agenda.eventVersion,
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
  const scheduledTalkCount = agenda.talks.filter(
    ({ startsAt, status }) => startsAt !== null && status !== "cancelled",
  ).length;
  const confirmedTalkCount = agenda.talks.filter(({ status }) => status === "confirmed").length;

  return (
    <>
      <PageHeader
        className="relative"
        title={
          <span>
            <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.2em] text-accent">Run of show / live desk</span>
            {agenda.eventName}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2 font-black uppercase tracking-[0.08em]">
            <span>Agenda control room</span>
            <span aria-hidden="true">◆</span>
            <span>{agenda.timezone}</span>
            <Badge tone={agenda.publication.revision > 0 ? "success" : "neutral"}>
              {agenda.publication.revision > 0 ? `Published r${agenda.publication.revision}` : "Private draft"}
            </Badge>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={busy || refresh.status !== "idle"}
              onClick={() => setSetupOpen(true)}
            >
              Tracks & rooms
            </Button>
            <Button
              disabled={busy || refresh.status !== "idle" || agenda.conflicts.length > 0}
              loading={busy && intent.acknowledgement === "pending"}
              onClick={() => void publish()}
            >
              Publish run sheet
            </Button>
          </div>
        }
      />
      <section aria-label="Agenda production status" className="mb-7 grid border-2 border-line-strong bg-surface shadow-card sm:grid-cols-2 xl:grid-cols-4">
        {[
          [String(scheduledTalkCount).padStart(2, "0"), "Talks placed", `${confirmedTalkCount} confirmed`, "bg-production-sky"],
          [String(agenda.rooms.length).padStart(2, "0"), "Rooms online", `${agenda.tracks.length} tracks`, "bg-production-lime"],
          [String(agenda.conflicts.length).padStart(2, "0"), "Conflicts", agenda.conflicts.length === 0 ? "Clear to publish" : "Needs attention", agenda.conflicts.length === 0 ? "bg-production-yellow" : "bg-production-coral"],
          [agenda.publication.revision > 0 ? `R${agenda.publication.revision}` : "—", "Public release", agenda.publication.publishedAt === null ? "Not on air" : "Snapshot locked", "bg-accent text-on-accent"],
        ].map(([value, label, detail, color], index) => (
          <div className={`min-h-28 p-4 ${color} ${
            index === 1
              ? "border-t-2 border-line-strong sm:border-l-2 sm:border-t-0"
              : index === 2
                ? "border-t-2 border-line-strong xl:border-l-2 xl:border-t-0"
                : index === 3
                  ? "border-t-2 border-line-strong sm:border-l-2 xl:border-t-0"
                  : ""
          }`} key={label}>
            <div className="flex h-full items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.14em] opacity-65">{label}</p>
                <p className="mt-2 text-xs font-black uppercase tracking-[0.06em]">{detail}</p>
              </div>
              <p className="text-4xl font-black leading-none tracking-[-0.07em]">{value}</p>
            </div>
          </div>
        ))}
      </section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 border-b-2 border-line-strong pb-5">
        <Tabs
          tabs={views}
          active={view}
          onChange={(id) => setView(id as AgendaView)}
        />
        <p className="w-full max-w-md border-l-4 border-production-coral pl-3 text-xs font-bold text-ink-secondary md:w-auto">
          Confirmed talks stay backstage until this run sheet is published.
        </p>
      </div>
      {refresh.status !== "idle" && (
        <div className="mb-5 flex flex-wrap items-center gap-2 border-2 border-line-strong bg-production-yellow px-3 py-2.5 text-sm font-semibold text-ink shadow-[3px_3px_0_#171714]" role="status" aria-live="polite">
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
      <section
        id={`agenda-view-${view}`}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={`agenda-view-${view}-tab`}
      >
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
      </section>

      <Sheet
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        title="Tracks and rooms"
        size="lg"
      >
        <div className="space-y-8">
          <section aria-labelledby="agenda-track-setup-heading" className="space-y-4">
            <div className="border-l-4 border-accent pl-3">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-accent">Signal routing</p>
              <h2 id="agenda-track-setup-heading" className="mt-1 text-2xl font-black tracking-[-0.04em] text-ink">Tracks</h2>
              <p className="mt-1 text-sm font-semibold text-ink-secondary">Create program lanes and control their stable display order.</p>
            </div>
            {agenda.tracks.length > 0 && (
              <ul className="divide-y-2 divide-line-strong border-2 border-line-strong bg-surface shadow-[4px_4px_0_#171714]">
                {agenda.tracks.map((track) => (
                  <li key={track.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-ink">{track.name}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-secondary">Order {track.order} · Version {track.version}{track.color ? ` · ${track.color}` : ""}</p>
                    </div>
                    <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => editTrack(track)}>Edit</Button>
                  </li>
                ))}
              </ul>
            )}
            <form className="space-y-3 border-2 border-line-strong bg-production-sky/35 p-4 shadow-[4px_4px_0_#171714]" onSubmit={(event) => void saveTrack(event)}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  required
                  label={trackDraft.id ? "Track name" : "New track name"}
                  maxLength={120}
                  value={trackDraft.name}
                  onChange={(event) => setTrackDraft((current) => ({ ...current, name: event.target.value }))}
                />
                <Input
                  label="Color (hex)"
                  placeholder="#2563EB"
                  value={trackDraft.color}
                  onChange={(event) => setTrackDraft((current) => ({ ...current, color: event.target.value }))}
                />
                <Input
                  required
                  type="number"
                  min={0}
                  max={10_000}
                  label="Display order"
                  value={trackDraft.order}
                  onChange={(event) => setTrackDraft((current) => ({ ...current, order: event.target.value }))}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                {trackDraft.id && <Button type="button" variant="secondary" disabled={busy} onClick={() => setTrackDraft(emptyTrackDraft())}>Cancel edit</Button>}
                <Button type="submit" loading={busy}>{trackDraft.id ? "Update track" : "Create track"}</Button>
              </div>
            </form>
          </section>

          <section aria-labelledby="agenda-room-setup-heading" className="space-y-4">
            <div className="border-l-4 border-production-coral pl-3">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-danger">Venue map</p>
              <h2 id="agenda-room-setup-heading" className="mt-1 text-2xl font-black tracking-[-0.04em] text-ink">Rooms</h2>
              <p className="mt-1 text-sm font-semibold text-ink-secondary">Add physical or virtual spaces before scheduling talks.</p>
            </div>
            {agenda.rooms.length > 0 && (
              <ul className="divide-y-2 divide-line-strong border-2 border-line-strong bg-surface shadow-[4px_4px_0_#171714]">
                {agenda.rooms.map((room) => (
                  <li key={room.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-ink">{room.name}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-secondary">Order {room.order} · Version {room.version}{room.capacity === null ? "" : ` · ${room.capacity} seats`}</p>
                    </div>
                    <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => editRoom(room)}>Edit</Button>
                  </li>
                ))}
              </ul>
            )}
            <form className="space-y-3 border-2 border-line-strong bg-production-coral/25 p-4 shadow-[4px_4px_0_#171714]" onSubmit={(event) => void saveRoom(event)}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  required
                  label={roomDraft.id ? "Room name" : "New room name"}
                  maxLength={120}
                  value={roomDraft.name}
                  onChange={(event) => setRoomDraft((current) => ({ ...current, name: event.target.value }))}
                />
                <Input
                  type="number"
                  min={1}
                  max={1_000_000}
                  label="Capacity"
                  hint="Optional"
                  value={roomDraft.capacity}
                  onChange={(event) => setRoomDraft((current) => ({ ...current, capacity: event.target.value }))}
                />
                <Input
                  required
                  type="number"
                  min={0}
                  max={10_000}
                  label="Display order"
                  value={roomDraft.order}
                  onChange={(event) => setRoomDraft((current) => ({ ...current, order: event.target.value }))}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                {roomDraft.id && <Button type="button" variant="secondary" disabled={busy} onClick={() => setRoomDraft(emptyRoomDraft())}>Cancel edit</Button>}
                <Button type="submit" loading={busy}>{roomDraft.id ? "Update room" : "Create room"}</Button>
              </div>
            </form>
          </section>
        </div>
      </Sheet>

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
            <div className="border-2 border-line-strong bg-production-sky p-4 shadow-[4px_4px_0_#171714]">
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-ink/65">On stage</p>
              <p className="mt-1 text-lg font-black tracking-[-0.025em] text-ink">{selectedTalk.speakerNames.join(", ")}</p>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-secondary">Cue version {selectedTalk.version}</p>
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
