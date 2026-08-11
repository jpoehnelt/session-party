import { Conflict, External, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization, type Principal as CurrentUserValue } from "contracts/principal";
import {
  acceptanceEvents,
  airtablePendingEdits,
  airtableRecordLinks,
  auditLog,
  domainChanges,
  events,
  formVersionFields,
  idempotencyRecords,
  integrations,
  mailCalendarEvents,
  mailDeliveries,
  mailDeliverySnapshots,
  rooms,
  speakerProvisioning,
  speakers,
  submissionAnswers,
  submissionSpeakers,
  submissions,
  talkSpeakers,
  talks,
  tracks,
  users,
} from "contracts/schema";
import type { JsonValue } from "contracts/domain";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
// BaselineGreen may rename these invocation seams; keep the shared import isolated here.
import { Authorizer, CurrentUser, Db, Rooms } from "@/server/services";
import { prepareAirtableTalkProjection } from "@/server/sync/airtable-outbox";
import {
  parseCalendarEvents,
  type CalendarMethod,
  renderCalendar,
  stableCalendarUid,
  type CalendarEventSnapshot,
} from "@/features/comms/calendar";
import {
  AgendaDeliveryProjection as AgendaDeliveryProjectionSchema,
  PublishedAgenda as PublishedAgendaSchema,
} from "./schema";
import type {
  AgendaConflict,
  AgendaDeliveryProjection,
  AgendaMutationResult,
  AgendaSnapshot,
  AgendaTalk,
  AgendaWarnings,
  AutoPlaceTalkInput,
  BacklogProposal,
  CancelTalkInput,
  CreateRoomInput,
  CreateTalkInput,
  CreateTrackInput,
  GetAgendaDeliveryProjectionInput,
  GetPublishedAgendaInput,
  ListAgendaInput,
  MoveTalkInput,
  PublishedAgenda,
  PublishAgendaInput,
  PublicAgendaTalk,
  Room,
  RoomMutationResult,
  ScheduleTalkInput,
  Track,
  TrackMutationResult,
  UpdateTalkContentInput,
  UpdateRoomInput,
  UpdateTrackInput,
} from "./schema";

const DAY_MS = 86_400_000;
const IDEMPOTENCY_TTL_MS = DAY_MS;
const PRIVATE_AUDIENCE = [{ kind: "admins" }] as const;
const PUBLIC_AUDIENCE = [{ kind: "public" }] as const;
const TALK_CHANGE_EVENT = "agenda.talk_changed";
const AGENDA_SNAPSHOT_MAX_ATTEMPTS = 3;
const PUBLICATION_EVENT = "agenda/published";
const DELIVERY_PROJECTION_EVENT = "agenda/delivery-published";
const SETUP_WRITE_AUTHORIZATION = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["agenda:write"] },
);

type Principal = CurrentUserValue;
type AgendaCommandResult =
  | AgendaMutationResult
  | PublishedAgenda
  | RoomMutationResult
  | TrackMutationResult;
type IdempotencyContext = {
  readonly id: string;
  readonly requestId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly principalId: string;
  readonly now: Date;
};

export interface AgendaMutationReservation {
  readonly eventId: string;
  readonly operationId: "agenda.autoPlaceTalk" | "agenda.createTalk" | "agenda.moveTalk" | "agenda.scheduleTalk";
  readonly workspaceVersion: number;
}

/** Feature-local deterministic contention seam; transport operations never provide it. */
export type AgendaMutationInterlock = (
  reservation: AgendaMutationReservation,
) => Effect.Effect<void, never>;

export interface AgendaSnapshotReservation {
  readonly eventId: string;
  readonly workspaceVersion: number;
  readonly attempt: number;
}

/** Feature-local deterministic snapshot seam; transport operations never provide it. */
export type AgendaSnapshotInterlock = (
  reservation: AgendaSnapshotReservation,
) => Effect.Effect<void, never>;

export interface AgendaPublicationReservation {
  readonly eventId: string;
  readonly expectedWorkspaceVersion: number;
  readonly expectedEventVersion: number;
  readonly nextRevision: number;
}

/** Feature-local deterministic publication seam; transport operations never provide it. */
export type AgendaPublicationInterlock = (
  reservation: AgendaPublicationReservation,
) => Effect.Effect<void, never>;
const waitAfterWorkspaceSample = (
  interlock: AgendaMutationInterlock | undefined,
  reservation: AgendaMutationReservation,
) =>
  interlock
    ? interlock(reservation)
    : Effect.void;

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const timestamp = (value: Date | null): number | null => value?.getTime() ?? null;

const calendarProjectionRevision = (
  eventVersion: number,
  ...collections: readonly (readonly { readonly version: number }[])[]
): number => Math.max(1, eventVersion + collections.flat().reduce((total, row) => total + row.version, 0));

const calendarProjectionUpdatedAt = (
  publishedAt: number,
  ...collections: readonly (readonly { readonly updatedAt: Date }[])[]
): number => Math.max(publishedAt, ...collections.flat().map(({ updatedAt }) => updatedAt.getTime()));

const actorColumns = (principal: Principal) =>
  principal.kind === "api-key"
    ? { actorUserId: null, actorApiKeyId: principal.apiKeyId }
    : { actorUserId: principal.userId, actorApiKeyId: null };

const authorizeSetupWrite = (eventId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    yield* authorize({ principal, eventId, policy: SETUP_WRITE_AUTHORIZATION });
    return principal;
  });

const setupName = (name: string): Effect.Effect<string, Validation> => {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return Effect.fail(new Validation({ message: "Name must contain visible characters" }));
  }
  if (normalized.length > 120) {
    return Effect.fail(new Validation({ message: "Name must be 120 characters or fewer" }));
  }
  return Effect.succeed(normalized);
};

const trackView = (track: typeof tracks.$inferSelect): Track => ({
  id: track.id,
  name: track.name,
  color: track.color,
  order: track.order,
  version: track.version,
});

const roomView = (room: typeof rooms.$inferSelect): Room => ({
  id: room.id,
  name: room.name,
  capacity: room.capacity,
  order: room.order,
  version: room.version,
});

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (error) =>
      new External({
        service: "crypto",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const getEvent = (eventId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db.select().from(events).where(eq(events.id, eventId)).limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: eventId }));
    return event;
  });

const resolveEventIdBySlug = (eventSlug: string): Effect.Effect<string, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db.select({ id: events.id }).from(events).where(eq(events.slug, eventSlug)).limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: eventSlug }));
    return event.id;
  });

const loadTalkRows = (eventId: string): Effect.Effect<readonly AgendaTalk[], AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const talkRows = yield* database(() =>
      db.select().from(talks).where(eq(talks.eventId, eventId)).orderBy(asc(talks.startsAt), asc(talks.id)),
    );
    if (talkRows.length === 0) return [];

    const [speakerRows, pendingRows] = yield* Effect.all([
      database(() => db
        .select({ talkId: talkSpeakers.talkId, speakerId: speakers.id, speakerName: speakers.displayName })
        .from(talkSpeakers)
        .innerJoin(
          speakers,
          and(eq(speakers.eventId, talkSpeakers.eventId), eq(speakers.id, talkSpeakers.speakerId)),
        )
        .where(and(eq(talkSpeakers.eventId, eventId), inArray(talkSpeakers.talkId, talkRows.map(({ id }) => id))))
        .orderBy(asc(talkSpeakers.talkId), asc(speakers.displayName), asc(speakers.id))),
      database(() => db.select({
        talkId: airtablePendingEdits.talkId,
        fieldKey: airtablePendingEdits.fieldKey,
        intendedValue: airtablePendingEdits.intendedValue,
      }).from(airtablePendingEdits).where(and(
        eq(airtablePendingEdits.eventId, eventId),
        eq(airtablePendingEdits.entityType, "talk"),
        eq(airtablePendingEdits.status, "pending"),
        inArray(airtablePendingEdits.entityId, talkRows.map(({ id }) => id)),
      ))),
    ]);

    const speakersByTalk = new Map<string, { ids: string[]; names: string[] }>();
    for (const row of speakerRows) {
      const entry = speakersByTalk.get(row.talkId) ?? { ids: [], names: [] };
      entry.ids.push(row.speakerId);
      entry.names.push(row.speakerName);
      speakersByTalk.set(row.talkId, entry);
    }
    const pendingByTalk = new Map<string, Map<string, unknown>>();
    for (const row of pendingRows) {
      if (!row.talkId) continue;
      const fields = pendingByTalk.get(row.talkId) ?? new Map<string, unknown>();
      fields.set(row.fieldKey, row.intendedValue);
      pendingByTalk.set(row.talkId, fields);
    }

    return talkRows.map((talk) => {
      const talkSpeakerRows = speakersByTalk.get(talk.id) ?? { ids: [], names: [] };
      const pending = pendingByTalk.get(talk.id);
      return {
        id: talk.id,
        eventId: talk.eventId,
        submissionId: talk.submissionId,
        title: typeof pending?.get("title") === "string" ? pending.get("title") as string : talk.title,
        description: pending?.has("description") ? pending.get("description") as string | null : talk.description,
        trackId: talk.trackId,
        roomId: talk.roomId,
        startsAt: timestamp(talk.startsAt),
        durationMin: talk.durationMin,
        status: talk.status,
        version: talk.version,
        speakerIds: talkSpeakerRows.ids,
        speakerNames: talkSpeakerRows.names,
      } satisfies AgendaTalk;
    });
  });

const loadTalk = (eventId: string, talkId: string) =>
  Effect.gen(function* () {
    const allTalks = yield* loadTalkRows(eventId);
    const talk = allTalks.find(({ id }) => id === talkId);
    if (!talk) return yield* Effect.fail(new NotFound({ entity: "talk", id: talkId }));
    return talk;
  });

const loadBacklog = (eventId: string): Effect.Effect<readonly BacklogProposal[], AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [acceptances, provisionings, activeTalks] = yield* Effect.all([
      database(() =>
        db
          .select({
            acceptanceEventId: acceptanceEvents.id,
            submissionId: acceptanceEvents.submissionId,
            primarySpeakerId: acceptanceEvents.primarySpeakerId,
            type: acceptanceEvents.type,
            submissionVersion: acceptanceEvents.submissionVersion,
            occurredAt: acceptanceEvents.occurredAt,
            title: submissions.title,
            category: submissions.category,
            submissionStatus: submissions.status,
            speakerName: speakers.displayName,
          })
          .from(acceptanceEvents)
          .innerJoin(
            submissions,
            and(eq(submissions.eventId, acceptanceEvents.eventId), eq(submissions.id, acceptanceEvents.submissionId)),
          )
          .innerJoin(
            speakers,
            and(eq(speakers.eventId, acceptanceEvents.eventId), eq(speakers.id, acceptanceEvents.primarySpeakerId)),
          )
          .where(eq(acceptanceEvents.eventId, eventId))
          .orderBy(asc(acceptanceEvents.submissionId), desc(acceptanceEvents.submissionVersion), desc(acceptanceEvents.occurredAt)),
      ),
      database(() =>
        db
          .select()
          .from(speakerProvisioning)
          .where(eq(speakerProvisioning.eventId, eventId))
          .orderBy(desc(speakerProvisioning.version), desc(speakerProvisioning.updatedAt)),
      ),
      database(() =>
        db
          .select({ submissionId: talks.submissionId })
          .from(talks)
          .where(and(eq(talks.eventId, eventId), ne(talks.status, "cancelled"))),
      ),
    ]);

    const latestAcceptance = new Map<string, (typeof acceptances)[number]>();
    for (const row of acceptances) {
      if (!latestAcceptance.has(row.submissionId)) latestAcceptance.set(row.submissionId, row);
    }
    const provisioningByAcceptance = new Map(
      provisionings.map((row) => [row.acceptanceEventId, row] as const),
    );
    const scheduledSubmissions = new Set(activeTalks.flatMap(({ submissionId }) => submissionId ? [submissionId] : []));

    return [...latestAcceptance.values()]
      .filter((row) => {
        const provisioning = provisioningByAcceptance.get(row.acceptanceEventId);
        return row.type === "accepted" &&
          row.submissionStatus === "accepted" &&
          provisioning?.status === "provisioned" &&
          provisioning.provisionedAt !== null &&
          !scheduledSubmissions.has(row.submissionId);
      })
      .map((row) => {
        const provisioning = provisioningByAcceptance.get(row.acceptanceEventId)!;
        return {
          submissionId: row.submissionId,
          title: row.title,
          category: row.category,
          submissionVersion: row.submissionVersion,
          acceptanceEventId: row.acceptanceEventId,
          primarySpeakerId: row.primarySpeakerId,
          primarySpeakerName: row.speakerName,
          provisionedAt: provisioning.provisionedAt!.getTime(),
        } satisfies BacklogProposal;
      })
      .sort((left, right) => left.title.localeCompare(right.title) || left.submissionId.localeCompare(right.submissionId));
  });

const overlaps = (leftStart: number, leftDuration: number, rightStart: number, rightDuration: number) =>
  leftStart < rightStart + rightDuration * 60_000 && rightStart < leftStart + leftDuration * 60_000;

export const detectAgendaConflicts = (
  candidate: AgendaTalk,
  existing: readonly AgendaTalk[],
  roomNames: ReadonlyMap<string, string> = new Map(),
  speakerNames: ReadonlyMap<string, string> = new Map(),
): readonly AgendaConflict[] => {
  if (candidate.status === "cancelled" || candidate.startsAt === null) return [];
  const conflicts: AgendaConflict[] = [];
  for (const other of existing) {
    if (
      other.id === candidate.id ||
      other.status === "cancelled" ||
      other.startsAt === null ||
      !overlaps(candidate.startsAt, candidate.durationMin, other.startsAt, other.durationMin)
    ) continue;

    if (candidate.roomId !== null && candidate.roomId === other.roomId) {
      const roomName = roomNames.get(candidate.roomId);
      conflicts.push({
        kind: "room_overlap",
        talkIds: [other.id, candidate.id],
        roomId: candidate.roomId,
        ...(roomName ? { roomName } : {}),
        explanation: `${roomName ?? "This room"} already hosts ${other.title} during this time.`,
      });
    }

    for (const speakerId of candidate.speakerIds) {
      if (!other.speakerIds.includes(speakerId)) continue;
      const speakerName = speakerNames.get(speakerId) ??
        candidate.speakerNames[candidate.speakerIds.indexOf(speakerId)] ?? "This speaker";
      conflicts.push({
        kind: "speaker_overlap",
        talkIds: [other.id, candidate.id],
        speakerId,
        speakerName,
        explanation: `${speakerName} is already speaking in ${other.title} during this time.`,
      });
    }
  }
  return conflicts.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.talkIds.join(":").localeCompare(right.talkIds.join(":")),
  );
};

const loadConflicts = (
  eventId: string,
  agendaTalks?: readonly AgendaTalk[],
): Effect.Effect<readonly AgendaConflict[], AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [allTalks, roomRows, speakerRows] = yield* Effect.all([
      agendaTalks ? Effect.succeed(agendaTalks) : loadTalkRows(eventId),
      database(() => db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.eventId, eventId))),
      database(() => db.select({ id: speakers.id, name: speakers.displayName }).from(speakers).where(eq(speakers.eventId, eventId))),
    ]);
    const roomNames = new Map(roomRows.map((row) => [row.id, row.name] as const));
    const speakerNames = new Map(speakerRows.map((row) => [row.id, row.name] as const));
    return allTalks.flatMap((talk, index) => detectAgendaConflicts(talk, allTalks.slice(0, index), roomNames, speakerNames));
  });

const decodePublishedAgenda = (payload: unknown): Effect.Effect<PublishedAgenda, External> =>
  Schema.decodeUnknown(PublishedAgendaSchema)(payload).pipe(
    Effect.mapError((error) =>
      new External({ service: "agenda-publication", detail: String(error) }),
    ),
  );

const decodeAgendaDeliveryProjection = (
  payload: unknown,
): Effect.Effect<AgendaDeliveryProjection, External> =>
  Schema.decodeUnknown(AgendaDeliveryProjectionSchema)(payload).pipe(
    Effect.mapError((error) =>
      new External({ service: "agenda-delivery-projection", detail: String(error) }),
    ),
  );

const latestPublication = (eventId: string): Effect.Effect<PublishedAgenda | null, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [change] = yield* database(() =>
      db
        .select({ payload: domainChanges.payload })
        .from(domainChanges)
        .where(and(
          eq(domainChanges.eventId, eventId),
          eq(domainChanges.aggregateType, "agenda-publication"),
          eq(domainChanges.aggregateId, eventId),
          eq(domainChanges.eventType, PUBLICATION_EVENT),
        ))
        .orderBy(desc(domainChanges.aggregateVersion), desc(domainChanges.sequence))
        .limit(1),
    );
    if (!change) return null;
    return yield* decodePublishedAgenda(change.payload);
  });

/** Internal immutable publication record for mail/calendar snapshots and revision reconciliation. */
export const getLatestPublishedAgendaSnapshot = (
  eventId: string,
): Effect.Effect<PublishedAgenda, AppError, Db> =>
  Effect.gen(function* () {
    const published = yield* latestPublication(eventId);
    if (!published) return yield* Effect.fail(new NotFound({ entity: "published agenda", id: eventId }));
    return published;
  });

export const getAgendaDeliveryProjection = (
  input: GetAgendaDeliveryProjectionInput,
): Effect.Effect<AgendaDeliveryProjection, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [change] = yield* database(() =>
      db
        .select({ payload: domainChanges.payload })
        .from(domainChanges)
        .where(and(
          eq(domainChanges.eventId, input.eventId),
          eq(domainChanges.aggregateType, "agenda-delivery"),
          eq(domainChanges.aggregateId, input.eventId),
          eq(domainChanges.aggregateVersion, input.revision),
          eq(domainChanges.eventType, DELIVERY_PROJECTION_EVENT),
        ))
        .limit(1),
    );
    if (!change) {
      return yield* Effect.fail(new NotFound({
        entity: "agenda delivery projection",
        id: `${input.eventId}:${input.revision}`,
      }));
    }
    const projection = yield* decodeAgendaDeliveryProjection(change.payload);
    if (projection.eventId !== input.eventId || projection.revision !== input.revision) {
      return yield* Effect.fail(new External({
        service: "agenda-delivery-projection",
        detail: `Projection key does not match ${input.eventId}:${input.revision}`,
      }));
    }
    return projection;
  });

const currentWorkspaceVersion = (eventId: string): Effect.Effect<number, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [change] = yield* database(() =>
      db
        .select({ aggregateVersion: domainChanges.aggregateVersion })
        .from(domainChanges)
        .where(and(
          eq(domainChanges.eventId, eventId),
          eq(domainChanges.aggregateType, "agenda-workspace"),
          eq(domainChanges.aggregateId, eventId),
          eq(domainChanges.eventType, TALK_CHANGE_EVENT),
        ))
        .orderBy(desc(domainChanges.aggregateVersion), desc(domainChanges.sequence))
        .limit(1),
    );
    return change?.aggregateVersion ?? 0;
  });

const nextWorkspaceVersion = (eventId: string): Effect.Effect<number, AppError, Db> =>
  currentWorkspaceVersion(eventId).pipe(Effect.map((version) => version + 1));
export const listAgenda = (
  input: ListAgendaInput,
  interlock?: AgendaSnapshotInterlock,
): Effect.Effect<AgendaSnapshot, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    for (let attempt = 1; attempt <= AGENDA_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      const workspaceVersion = yield* currentWorkspaceVersion(input.eventId);
      const event = yield* getEvent(input.eventId);
      const [trackRows, roomRows, backlog, agendaTalks, published] = yield* Effect.all([
        database(() => db.select().from(tracks).where(eq(tracks.eventId, input.eventId)).orderBy(asc(tracks.order), asc(tracks.name), asc(tracks.id))),
        database(() => db.select().from(rooms).where(eq(rooms.eventId, input.eventId)).orderBy(asc(rooms.order), asc(rooms.name), asc(rooms.id))),
        loadBacklog(input.eventId),
        loadTalkRows(input.eventId),
        latestPublication(input.eventId),
      ]);
      const conflicts = yield* loadConflicts(input.eventId, agendaTalks);
      if (interlock) {
        yield* interlock({ eventId: input.eventId, workspaceVersion, attempt });
      }
      const confirmedWorkspaceVersion = yield* currentWorkspaceVersion(input.eventId);
      if (confirmedWorkspaceVersion !== workspaceVersion) continue;
      return {
        eventId: event.id,
        eventName: event.name,
        eventSlug: event.slug,
        timezone: event.timezone,
        view: input.view,
        workspaceVersion,
        eventVersion: event.version,
        tracks: trackRows.map(trackView),
        rooms: roomRows.map(roomView),
        backlog,
        talks: agendaTalks,
        conflicts,
        warnings: agendaWarnings(agendaTalks, conflicts),
        publication: {
          revision: published?.revision ?? 0,
          publishedAt: published?.publishedAt ?? null,
          talkCount: published?.talks.length ?? 0,
        },
      };
    }
    return yield* Effect.fail(new Conflict({
      message: "Agenda changed repeatedly while loading; refresh and try again",
    }));
  });

const prepareIdempotency = <A extends { readonly idempotencyKey: string }>(
  operationId: string,
  input: A,
): Effect.Effect<IdempotencyContext | AgendaCommandResult, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    const principalId = principal.kind === "api-key" ? `api-key:${principal.apiKeyId}` : `user:${principal.userId}`;
    const [keyHash, requestHash] = yield* Effect.all([
      sha256(input.idempotencyKey),
      sha256(canonicalJson(input)),
    ]);
    const [existing] = yield* database(() =>
      db
        .select()
        .from(idempotencyRecords)
        .where(and(
          eq(idempotencyRecords.eventId, (input as A & { eventId: string }).eventId),
          eq(idempotencyRecords.operationId, operationId),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.keyHash, keyHash),
        ))
        .limit(1),
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different request" }));
      }
      if (existing.status !== "completed" || existing.responseBody === null) {
        return yield* Effect.fail(new Conflict({ message: "An equivalent agenda change is still in progress" }));
      }
      const replay = existing.responseBody as AgendaCommandResult;
      return "replayed" in replay ? { ...replay, replayed: true } : replay;
    }
    return {
      id: nanoid(),
      requestId: `agenda-${nanoid()}`,
      keyHash,
      requestHash,
      principalId,
      now: new Date(),
    };
  });

const idempotencyInsert = (
  context: IdempotencyContext,
  eventId: string,
  operationId: string,
  responseBody: JsonValue,
  requirePriorWrite = false,
) => ({
  id: context.id,
  eventId,
  operationId,
  principalId: context.principalId,
  keyHash: context.keyHash,
  requestHash: context.requestHash,
  status: "completed" as const,
  responseStatus: 200,
  responseBody,
  expiresAt: new Date(context.now.getTime() + IDEMPOTENCY_TTL_MS),
  completedAt: requirePriorWrite
    ? sql<Date>`case when changes() = 1 then ${context.now.getTime()} else null end`
    : context.now,
  createdAt: context.now,
});

const ensureScheduleReferences = (eventId: string, roomId: string | null, trackId: string | null) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    if (roomId !== null) {
      const [room] = yield* database(() =>
        db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.eventId, eventId), eq(rooms.id, roomId))).limit(1),
      );
      if (!room) return yield* Effect.fail(new NotFound({ entity: "room", id: roomId }));
    }
    if (trackId !== null) {
      const [track] = yield* database(() =>
        db.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.eventId, eventId), eq(tracks.id, trackId))).limit(1),
      );
      if (!track) return yield* Effect.fail(new NotFound({ entity: "track", id: trackId }));
    }
  });

const rejectConflicts = (conflicts: readonly AgendaConflict[]) =>
  conflicts.length === 0
    ? Effect.void
    : Effect.fail(new Conflict({ message: conflicts.map(({ explanation }) => explanation).join(" ") }));

const agendaWarnings = (
  agendaTalks: readonly AgendaTalk[],
  conflicts: readonly AgendaConflict[],
): AgendaWarnings => {
  const activeTalks = agendaTalks.filter(({ status }) => status !== "cancelled");
  const roomConflictCount = conflicts.filter(({ kind }) => kind === "room_overlap").length;
  return {
    // Tracks are optional. A public placement needs both a room and a start.
    unplacedTalkCount: activeTalks.filter(({ roomId, startsAt }) => roomId === null || startsAt === null).length,
    conflictCount: conflicts.length,
    roomConflictCount,
    speakerConflictCount: conflicts.length - roomConflictCount,
  };
};

const broadcastMutation = (result: AgendaMutationResult, by: string, replyTo: string) =>
  Effect.gen(function* () {
    const { broadcast } = yield* Rooms;
    yield* broadcast(result.talk.eventId, {
      t: "agenda/talk_upserted",
      talk: {
        id: result.talk.id,
        title: result.talk.title,
        trackId: result.talk.trackId,
        roomId: result.talk.roomId,
        startsAt: result.talk.startsAt,
        durationMin: result.talk.durationMin,
        status: result.talk.status,
        speakerNames: [...result.talk.speakerNames],
      },
      by,
      replyTo,
    }).pipe(Effect.catchAll(() => Effect.void));
  });

const mutationContention = <A, R>(effect: Effect.Effect<A, AppError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is External => {
        const detail = error._tag === "External" ? error.detail ?? "" : "";
        return detail.includes("UNIQUE constraint failed") ||
          detail.includes("idempotency_completion_state");
      },
      () => Effect.fail(new Conflict({ message: "Agenda changed while this request was being applied; refresh and try again" })),
    ),
  );

const ensureUniqueTrackName = (eventId: string, name: string, exceptId?: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const conditions = [
      eq(tracks.eventId, eventId),
      sql`lower(trim(${tracks.name})) = lower(${name})`,
    ];
    if (exceptId) conditions.push(ne(tracks.id, exceptId));
    const [duplicate] = yield* database(() =>
      db.select({ id: tracks.id }).from(tracks).where(and(...conditions)).limit(1),
    );
    if (duplicate) {
      return yield* Effect.fail(new Conflict({ message: `A track named '${name}' already exists` }));
    }
  });

const ensureUniqueRoomName = (eventId: string, name: string, exceptId?: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const conditions = [
      eq(rooms.eventId, eventId),
      sql`lower(trim(${rooms.name})) = lower(${name})`,
    ];
    if (exceptId) conditions.push(ne(rooms.id, exceptId));
    const [duplicate] = yield* database(() =>
      db.select({ id: rooms.id }).from(rooms).where(and(...conditions)).limit(1),
    );
    if (duplicate) {
      return yield* Effect.fail(new Conflict({ message: `A room named '${name}' already exists` }));
    }
  });

export const createTrack = (
  input: CreateTrackInput,
): Effect.Effect<TrackMutationResult, AppError, Authorizer | CurrentUser | Db> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* authorizeSetupWrite(input.eventId);
    const prepared = yield* prepareIdempotency("agenda.createTrack", input);
    if (!("requestId" in prepared)) return prepared as TrackMutationResult;
    yield* getEvent(input.eventId);
    const name = yield* setupName(input.name);
    yield* ensureUniqueTrackName(input.eventId, name);
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    const track: Track = {
      id: nanoid(),
      name,
      color: input.color,
      order: input.order,
      version: 1,
    };
    const changeId = nanoid();
    const auditId = nanoid();
    const result: TrackMutationResult = { track, changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    yield* database(() => db.batch([
      db.insert(tracks).values({
        ...track,
        eventId: input.eventId,
        createdAt: prepared.now,
        updatedAt: prepared.now,
      }),
      db.insert(idempotencyRecords).values(idempotencyInsert(
        prepared,
        input.eventId,
        "agenda.createTrack",
        result as unknown as JsonValue,
      )),
      db.insert(domainChanges).values({
        id: changeId,
        eventId: input.eventId,
        aggregateType: "agenda-workspace",
        aggregateId: input.eventId,
        aggregateVersion: workspaceVersion,
        eventType: TALK_CHANGE_EVENT,
        audiences: PRIVATE_AUDIENCE,
        payload: { action: "track_created", track },
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: auditId,
        eventId: input.eventId,
        requestId: prepared.requestId,
        ...actor,
        action: "agenda.track_created",
        resourceType: "track",
        resourceId: track.id,
        before: null,
        after: track,
        metadata: { idempotencyKeyHash: prepared.keyHash },
        occurredAt: prepared.now,
      }),
    ]));
    return result;
  }));

export const updateTrack = (
  input: UpdateTrackInput,
): Effect.Effect<TrackMutationResult, AppError, Authorizer | CurrentUser | Db> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* authorizeSetupWrite(input.eventId);
    const prepared = yield* prepareIdempotency("agenda.updateTrack", input);
    if (!("requestId" in prepared)) return prepared as TrackMutationResult;
    const [stored] = yield* database(() => db.select().from(tracks).where(and(
      eq(tracks.eventId, input.eventId),
      eq(tracks.id, input.trackId),
    )).limit(1));
    if (!stored) return yield* Effect.fail(new NotFound({ entity: "track", id: input.trackId }));
    if (stored.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Track version is ${stored.version}; expected ${input.expectedVersion}`,
      }));
    }
    const name = yield* setupName(input.name);
    yield* ensureUniqueTrackName(input.eventId, name, input.trackId);
    const before = trackView(stored);
    const track: Track = {
      id: stored.id,
      name,
      color: input.color,
      order: input.order,
      version: stored.version + 1,
    };
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    const changeId = nanoid();
    const auditId = nanoid();
    const result: TrackMutationResult = { track, changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    yield* database(() => db.batch([
      db.update(tracks).set({
        name,
        color: input.color,
        order: input.order,
        version: track.version,
        updatedAt: prepared.now,
      }).where(and(
        eq(tracks.eventId, input.eventId),
        eq(tracks.id, input.trackId),
        eq(tracks.version, input.expectedVersion),
      )),
      db.insert(idempotencyRecords).values(idempotencyInsert(
        prepared,
        input.eventId,
        "agenda.updateTrack",
        result as unknown as JsonValue,
        true,
      )),
      db.insert(domainChanges).values({
        id: changeId,
        eventId: input.eventId,
        aggregateType: "agenda-workspace",
        aggregateId: input.eventId,
        aggregateVersion: workspaceVersion,
        eventType: TALK_CHANGE_EVENT,
        audiences: PRIVATE_AUDIENCE,
        payload: { action: "track_updated", track },
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: auditId,
        eventId: input.eventId,
        requestId: prepared.requestId,
        ...actor,
        action: "agenda.track_updated",
        resourceType: "track",
        resourceId: track.id,
        before,
        after: track,
        metadata: { idempotencyKeyHash: prepared.keyHash },
        occurredAt: prepared.now,
      }),
    ]));
    return result;
  }));

export const createRoom = (
  input: CreateRoomInput,
): Effect.Effect<RoomMutationResult, AppError, Authorizer | CurrentUser | Db> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* authorizeSetupWrite(input.eventId);
    const prepared = yield* prepareIdempotency("agenda.createRoom", input);
    if (!("requestId" in prepared)) return prepared as RoomMutationResult;
    yield* getEvent(input.eventId);
    const name = yield* setupName(input.name);
    yield* ensureUniqueRoomName(input.eventId, name);
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    const room: Room = {
      id: nanoid(),
      name,
      capacity: input.capacity,
      order: input.order,
      version: 1,
    };
    const changeId = nanoid();
    const auditId = nanoid();
    const result: RoomMutationResult = { room, changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    yield* database(() => db.batch([
      db.insert(rooms).values({
        ...room,
        eventId: input.eventId,
        createdAt: prepared.now,
        updatedAt: prepared.now,
      }),
      db.insert(idempotencyRecords).values(idempotencyInsert(
        prepared,
        input.eventId,
        "agenda.createRoom",
        result as unknown as JsonValue,
      )),
      db.insert(domainChanges).values({
        id: changeId,
        eventId: input.eventId,
        aggregateType: "agenda-workspace",
        aggregateId: input.eventId,
        aggregateVersion: workspaceVersion,
        eventType: TALK_CHANGE_EVENT,
        audiences: PRIVATE_AUDIENCE,
        payload: { action: "room_created", room },
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: auditId,
        eventId: input.eventId,
        requestId: prepared.requestId,
        ...actor,
        action: "agenda.room_created",
        resourceType: "room",
        resourceId: room.id,
        before: null,
        after: room,
        metadata: { idempotencyKeyHash: prepared.keyHash },
        occurredAt: prepared.now,
      }),
    ]));
    return result;
  }));

export const updateRoom = (
  input: UpdateRoomInput,
): Effect.Effect<RoomMutationResult, AppError, Authorizer | CurrentUser | Db> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* authorizeSetupWrite(input.eventId);
    const prepared = yield* prepareIdempotency("agenda.updateRoom", input);
    if (!("requestId" in prepared)) return prepared as RoomMutationResult;
    const [stored] = yield* database(() => db.select().from(rooms).where(and(
      eq(rooms.eventId, input.eventId),
      eq(rooms.id, input.roomId),
    )).limit(1));
    if (!stored) return yield* Effect.fail(new NotFound({ entity: "room", id: input.roomId }));
    if (stored.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Room version is ${stored.version}; expected ${input.expectedVersion}`,
      }));
    }
    const name = yield* setupName(input.name);
    yield* ensureUniqueRoomName(input.eventId, name, input.roomId);
    const before = roomView(stored);
    const room: Room = {
      id: stored.id,
      name,
      capacity: input.capacity,
      order: input.order,
      version: stored.version + 1,
    };
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    const changeId = nanoid();
    const auditId = nanoid();
    const result: RoomMutationResult = { room, changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    yield* database(() => db.batch([
      db.update(rooms).set({
        name,
        capacity: input.capacity,
        order: input.order,
        version: room.version,
        updatedAt: prepared.now,
      }).where(and(
        eq(rooms.eventId, input.eventId),
        eq(rooms.id, input.roomId),
        eq(rooms.version, input.expectedVersion),
      )),
      db.insert(idempotencyRecords).values(idempotencyInsert(
        prepared,
        input.eventId,
        "agenda.updateRoom",
        result as unknown as JsonValue,
        true,
      )),
      db.insert(domainChanges).values({
        id: changeId,
        eventId: input.eventId,
        aggregateType: "agenda-workspace",
        aggregateId: input.eventId,
        aggregateVersion: workspaceVersion,
        eventType: TALK_CHANGE_EVENT,
        audiences: PRIVATE_AUDIENCE,
        payload: { action: "room_updated", room },
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: auditId,
        eventId: input.eventId,
        requestId: prepared.requestId,
        ...actor,
        action: "agenda.room_updated",
        resourceType: "room",
        resourceId: room.id,
        before,
        after: room,
        metadata: { idempotencyKeyHash: prepared.keyHash },
        occurredAt: prepared.now,
      }),
    ]));
    return result;
  }));

export const createTalk = (
  input: CreateTalkInput,
  interlock?: AgendaMutationInterlock,
): Effect.Effect<AgendaMutationResult, AppError, Db | CurrentUser | Rooms> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    const prepared = yield* prepareIdempotency("agenda.createTalk", input);
    if (!("requestId" in prepared)) return prepared as AgendaMutationResult;
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    yield* waitAfterWorkspaceSample(interlock, {
      eventId: input.eventId,
      operationId: "agenda.createTalk",
      workspaceVersion,
    });
    yield* getEvent(input.eventId);
    yield* ensureScheduleReferences(input.eventId, input.roomId, input.trackId);

    const [submission] = yield* database(() =>
      db.select().from(submissions).where(and(eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId))).limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));

    const [acceptance] = yield* database(() =>
      db
        .select()
        .from(acceptanceEvents)
        .where(and(eq(acceptanceEvents.eventId, input.eventId), eq(acceptanceEvents.submissionId, input.submissionId)))
        .orderBy(desc(acceptanceEvents.submissionVersion), desc(acceptanceEvents.occurredAt))
        .limit(1),
    );
    if (!acceptance || acceptance.type !== "accepted" || submission.status !== "accepted") {
      return yield* Effect.fail(new Validation({ message: "Only currently accepted proposals can become talks" }));
    }
    const [provisioning] = yield* database(() =>
      db
        .select()
        .from(speakerProvisioning)
        .where(and(
          eq(speakerProvisioning.eventId, input.eventId),
          eq(speakerProvisioning.acceptanceEventId, acceptance.id),
          eq(speakerProvisioning.status, "provisioned"),
        ))
        .limit(1),
    );
    if (!provisioning?.provisionedAt) {
      return yield* Effect.fail(new Validation({ message: "The accepted proposal must have a provisioned primary speaker" }));
    }
    const [active] = yield* database(() =>
      db
        .select({ id: talks.id })
        .from(talks)
        .where(and(eq(talks.eventId, input.eventId), eq(talks.submissionId, input.submissionId), ne(talks.status, "cancelled")))
        .limit(1),
    );
    if (active) return yield* Effect.fail(new Conflict({ message: "This proposal already has an active talk" }));

    const proposalSpeakers = yield* database(() =>
      db
        .select({ id: speakers.id, name: speakers.displayName })
        .from(submissionSpeakers)
        .innerJoin(
          speakers,
          and(eq(speakers.eventId, submissionSpeakers.eventId), eq(speakers.id, submissionSpeakers.speakerId)),
        )
        .where(and(eq(submissionSpeakers.eventId, input.eventId), eq(submissionSpeakers.submissionId, input.submissionId)))
        .orderBy(desc(submissionSpeakers.isPrimary), asc(speakers.displayName), asc(speakers.id)),
    );
    if (proposalSpeakers.length === 0) {
      return yield* Effect.fail(new Validation({ message: "The accepted proposal has no linked speakers" }));
    }

    const [abstractAnswer] = yield* database(() =>
      db
        .select({ value: submissionAnswers.value })
        .from(submissionAnswers)
        .innerJoin(
          formVersionFields,
          and(
            eq(formVersionFields.eventId, submissionAnswers.eventId),
            eq(formVersionFields.formVersionId, submissionAnswers.formVersionId),
            eq(formVersionFields.id, submissionAnswers.formVersionFieldId),
          ),
        )
        .where(and(
          eq(submissionAnswers.eventId, input.eventId),
          eq(submissionAnswers.submissionId, input.submissionId),
          eq(formVersionFields.semanticKey, "submissionAbstract"),
        ))
        .limit(1),
    );
    const description = typeof abstractAnswer?.value === "string"
      ? abstractAnswer.value.trim() || null
      : null;

    const status = input.roomId !== null && input.startsAt !== null ? "confirmed" as const : "draft" as const;
    const talkId = nanoid();
    const candidate: AgendaTalk = {
      id: talkId,
      eventId: input.eventId,
      submissionId: input.submissionId,
      title: submission.title,
      description,
      trackId: input.trackId,
      roomId: input.roomId,
      startsAt: input.startsAt,
      durationMin: input.durationMin,
      status,
      version: 1,
      speakerIds: proposalSpeakers.map(({ id }) => id),
      speakerNames: proposalSpeakers.map(({ name }) => name),
    };
    const existing = yield* loadTalkRows(input.eventId);
    const conflicts = yield* loadConflicts(input.eventId, [...existing, candidate]);

    const changeId = nanoid();
    const auditId = nanoid();
    const result: AgendaMutationResult = {
      talk: candidate,
      conflicts: conflicts.filter(({ talkIds }) => talkIds.includes(candidate.id)),
      changeId,
      auditId,
      replayed: false,
    };
    const actor = actorColumns(principal);
    const talkInsert = db.insert(talks).values({
      id: talkId,
      eventId: input.eventId,
      submissionId: input.submissionId,
      title: submission.title,
      description,
      trackId: input.trackId,
      roomId: input.roomId,
      startsAt: input.startsAt === null ? null : new Date(input.startsAt),
      durationMin: input.durationMin,
      status,
      version: 1,
      createdAt: prepared.now,
      updatedAt: prepared.now,
    });
    const speakerInserts = proposalSpeakers.map((speaker) =>
      db.insert(talkSpeakers).values({
        id: nanoid(),
        eventId: input.eventId,
        talkId,
        speakerId: speaker.id,
        createdAt: prepared.now,
      }),
    );
    const idempotencyInsertQuery = db.insert(idempotencyRecords).values(
      idempotencyInsert(prepared, input.eventId, "agenda.createTalk", result as unknown as JsonValue),
    );
    const changeInsert = db.insert(domainChanges).values({
      id: changeId,
      eventId: input.eventId,
      aggregateType: "agenda-workspace",
      aggregateId: input.eventId,
      aggregateVersion: workspaceVersion,
      eventType: TALK_CHANGE_EVENT,
      audiences: PRIVATE_AUDIENCE,
      payload: { action: "created", talk: candidate },
      ...actor,
      requestId: prepared.requestId,
      idempotencyRecordId: prepared.id,
      occurredAt: prepared.now,
    });
    const auditInsert = db.insert(auditLog).values({
      id: auditId,
      eventId: input.eventId,
      requestId: prepared.requestId,
      ...actor,
      action: "agenda.talk_created",
      resourceType: "talk",
      resourceId: talkId,
      before: null,
      after: candidate,
      metadata: { idempotencyKeyHash: prepared.keyHash },
      occurredAt: prepared.now,
    });
    const airtableProjection = yield* database(() => prepareAirtableTalkProjection(db, {
      eventId: input.eventId,
      talk: candidate,
      changedKeys: [],
      bootstrap: true,
      origin: "agenda.createTalk",
      idempotencyKey: `agenda.createTalk:${prepared.id}`,
      now: prepared.now,
    }));
    yield* database(() => db.batch([
      talkInsert,
      ...speakerInserts,
      idempotencyInsertQuery,
      changeInsert,
      auditInsert,
      ...(airtableProjection ? [airtableProjection.statement] : []),
    ] as never));
    yield* broadcastMutation(result, principal.name, prepared.requestId);
    return result;
  }));

const repositionTalk = (
  operationId: "agenda.autoPlaceTalk" | "agenda.scheduleTalk" | "agenda.moveTalk",
  action: "auto_placed" | "scheduled" | "moved",
  input: ScheduleTalkInput | MoveTalkInput,
  interlock?: AgendaMutationInterlock,
  idempotencyInput: AutoPlaceTalkInput | ScheduleTalkInput | MoveTalkInput = input,
  preparedContext?: IdempotencyContext,
): Effect.Effect<AgendaMutationResult, AppError, Db | CurrentUser | Rooms> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    const prepared = preparedContext ?? (yield* prepareIdempotency(operationId, idempotencyInput));
    if (!("requestId" in prepared)) return prepared as AgendaMutationResult;
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    yield* waitAfterWorkspaceSample(interlock, {
      eventId: input.eventId,
      operationId,
      workspaceVersion,
    });
    yield* ensureScheduleReferences(input.eventId, input.roomId, input.trackId);
    const existing = yield* loadTalkRows(input.eventId);
    const before = existing.find(({ id }) => id === input.talkId);
    if (!before) return yield* Effect.fail(new NotFound({ entity: "talk", id: input.talkId }));
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Talk version is ${before.version}; expected ${input.expectedVersion}` }));
    }
    if (before.status === "cancelled") {
      return yield* Effect.fail(new Conflict({ message: "Cancelled talks cannot be scheduled or moved" }));
    }
    const status = input.roomId !== null && input.startsAt !== null ? "confirmed" as const : "draft" as const;
    const candidate: AgendaTalk = {
      ...before,
      trackId: input.trackId,
      roomId: input.roomId,
      startsAt: input.startsAt,
      durationMin: input.durationMin,
      status,
      version: before.version + 1,
    };
    const conflicts = yield* loadConflicts(input.eventId, [...existing.filter(({ id }) => id !== candidate.id), candidate]);

    const changeId = nanoid();
    const auditId = nanoid();
    const result: AgendaMutationResult = {
      talk: candidate,
      conflicts: conflicts.filter(({ talkIds }) => talkIds.includes(candidate.id)),
      changeId,
      auditId,
      replayed: false,
    };
    const actor = actorColumns(principal);
    const update = db
      .update(talks)
      .set({
        trackId: input.trackId,
        roomId: input.roomId,
        startsAt: input.startsAt === null ? null : new Date(input.startsAt),
        durationMin: input.durationMin,
        status,
        version: candidate.version,
        updatedAt: prepared.now,
      })
      .where(and(eq(talks.eventId, input.eventId), eq(talks.id, input.talkId), eq(talks.version, input.expectedVersion)));
    const idempotencyInsertQuery = db.insert(idempotencyRecords).values(
      idempotencyInsert(prepared, input.eventId, operationId, result as unknown as JsonValue, true),
    );
    const changeInsert = db.insert(domainChanges).values({
      id: changeId,
      eventId: input.eventId,
      aggregateType: "agenda-workspace",
      aggregateId: input.eventId,
      aggregateVersion: workspaceVersion,
      eventType: TALK_CHANGE_EVENT,
      audiences: PRIVATE_AUDIENCE,
      payload: { action, talk: candidate },
      ...actor,
      requestId: prepared.requestId,
      idempotencyRecordId: prepared.id,
      occurredAt: prepared.now,
    });
    const auditInsert = db.insert(auditLog).values({
      id: auditId,
      eventId: input.eventId,
      requestId: prepared.requestId,
      ...actor,
      action: `agenda.talk_${action}`,
      resourceType: "talk",
      resourceId: input.talkId,
      before,
      after: candidate,
      metadata: { idempotencyKeyHash: prepared.keyHash },
      occurredAt: prepared.now,
    });
    const airtableProjection = yield* database(() => prepareAirtableTalkProjection(db, {
      eventId: input.eventId,
      talk: candidate,
      changedKeys: ["track", "room", "startsAt", "durationMin", "status"],
      origin: operationId,
      idempotencyKey: `${operationId}:${prepared.id}`,
      now: prepared.now,
    }));
    yield* database(() => db.batch([
      update,
      idempotencyInsertQuery,
      changeInsert,
      auditInsert,
      ...(airtableProjection ? [airtableProjection.statement] : []),
    ] as never));
    yield* broadcastMutation(result, principal.name, prepared.requestId);
    return result;
  }));

export const scheduleTalk = (input: ScheduleTalkInput, interlock?: AgendaMutationInterlock) =>
  repositionTalk("agenda.scheduleTalk", "scheduled", input, interlock);

export const moveTalk = (input: MoveTalkInput, interlock?: AgendaMutationInterlock) =>
  repositionTalk("agenda.moveTalk", "moved", input, interlock);

export const autoPlaceTalk = (
  input: AutoPlaceTalkInput,
): Effect.Effect<AgendaMutationResult, AppError, Db | CurrentUser | Rooms> =>
  Effect.gen(function* () {
    const prepared = yield* prepareIdempotency("agenda.autoPlaceTalk", input);
    if (!("requestId" in prepared)) return prepared as AgendaMutationResult;
    const { db } = yield* Db;
    const [event, roomRows, existing] = yield* Effect.all([
      getEvent(input.eventId),
      database(() => db.select().from(rooms).where(eq(rooms.eventId, input.eventId)).orderBy(asc(rooms.order), asc(rooms.name), asc(rooms.id))),
      loadTalkRows(input.eventId),
    ]);
    const before = existing.find(({ id }) => id === input.talkId);
    if (!before) return yield* Effect.fail(new NotFound({ entity: "talk", id: input.talkId }));
    if (before.status === "cancelled") {
      return yield* Effect.fail(new Conflict({ message: "Cancelled talks cannot be auto-placed" }));
    }
    const eventStartsAt = timestamp(event.startsAt);
    const eventEndsAt = timestamp(event.endsAt);
    if (eventStartsAt === null || eventEndsAt === null) {
      return yield* Effect.fail(new Validation({ message: "Set event start and end dates before auto-placement" }));
    }
    if (roomRows.length === 0) {
      return yield* Effect.fail(new Validation({ message: "Create at least one room before auto-placement" }));
    }
    const scheduled = existing.filter(({ id, status, startsAt }) =>
      id !== before.id && status !== "cancelled" && startsAt !== null);
    const stepMs = 15 * 60_000;
    let placement: { readonly roomId: string; readonly startsAt: number } | null = null;
    for (
      let startsAt = eventStartsAt;
      startsAt + before.durationMin * 60_000 <= eventEndsAt && placement === null;
      startsAt += stepMs
    ) {
      for (const room of roomRows) {
        const candidate: AgendaTalk = {
          ...before,
          roomId: room.id,
          startsAt,
          status: "confirmed",
        };
        if (detectAgendaConflicts(candidate, scheduled).length === 0) {
          placement = { roomId: room.id, startsAt };
          break;
        }
      }
    }
    if (placement === null) {
      return yield* Effect.fail(new Conflict({ message: "No conflict-free room and time remain inside the event window" }));
    }
    return yield* repositionTalk("agenda.autoPlaceTalk", "auto_placed", {
      ...input,
      trackId: before.trackId,
      roomId: placement.roomId,
      startsAt: placement.startsAt,
      durationMin: before.durationMin,
    }, undefined, input, prepared);
  });

export const updateTalkContent = (
  input: UpdateTalkContentInput,
): Effect.Effect<AgendaMutationResult, AppError, Db | CurrentUser | Rooms> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    const prepared = yield* prepareIdempotency("agenda.updateTalkContent", input);
    if (!("requestId" in prepared)) return prepared as AgendaMutationResult;
    const existing = yield* loadTalkRows(input.eventId);
    const before = existing.find(({ id }) => id === input.talkId);
    if (!before) return yield* Effect.fail(new NotFound({ entity: "talk", id: input.talkId }));
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Talk version is ${before.version}; expected ${input.expectedVersion}` }));
    }
    if (before.status === "cancelled") {
      return yield* Effect.fail(new Conflict({ message: "Cancelled talks cannot be edited" }));
    }
    const title = input.title.trim().replace(/\s+/g, " ");
    if (title.length === 0) return yield* Effect.fail(new Validation({ message: "Talk title must contain visible characters" }));
    const description = input.description?.trim() || null;
    const [airtableIntegration] = yield* database(() => db.select({ id: integrations.id }).from(integrations).where(and(
      eq(integrations.eventId, input.eventId), eq(integrations.kind, "airtable"),
    )).limit(1));
    const changedKeys = ([
      ...(title !== before.title ? ["title" as const] : []),
      ...(description !== before.description ? ["description" as const] : []),
    ]);
    if (airtableIntegration) {
      const existingPending = yield* database(() => db.select({ fieldKey: airtablePendingEdits.fieldKey }).from(airtablePendingEdits).where(and(
        eq(airtablePendingEdits.eventId, input.eventId),
        eq(airtablePendingEdits.integrationId, airtableIntegration.id),
        eq(airtablePendingEdits.entityType, "talk"),
        eq(airtablePendingEdits.entityId, input.talkId),
        eq(airtablePendingEdits.status, "pending"),
        inArray(airtablePendingEdits.fieldKey, ["title", "description"]),
      )));
      if (existingPending.length > 0) {
        return yield* Effect.fail(new Conflict({ message: "Talk content changes are already pending Airtable confirmation" }));
      }
    }
    const candidate: AgendaTalk = { ...before, title, description, version: before.version + 1 };
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    const changeId = nanoid();
    const auditId = nanoid();
    const conflicts = yield* loadConflicts(input.eventId, [
      ...existing.filter(({ id }) => id !== candidate.id),
      candidate,
    ]);
    const result: AgendaMutationResult = {
      talk: candidate,
      conflicts: conflicts.filter(({ talkIds }) => talkIds.includes(candidate.id)),
      changeId,
      auditId,
      replayed: false,
    };
    const actor = actorColumns(principal);
    const [recordLink] = airtableIntegration ? yield* database(() => db.select({
      inboundRevision: airtableRecordLinks.inboundRevision,
      inboundHash: airtableRecordLinks.inboundHash,
    }).from(airtableRecordLinks).where(and(
      eq(airtableRecordLinks.integrationId, airtableIntegration.id),
      eq(airtableRecordLinks.entityType, "talk"),
      eq(airtableRecordLinks.entityId, input.talkId),
    )).limit(1)) : [undefined];
    const pendingEdits = airtableIntegration ? changedKeys.map((fieldKey) => ({
      id: nanoid(),
      eventId: input.eventId,
      integrationId: airtableIntegration.id,
      entityType: "talk" as const,
      entityId: input.talkId,
      speakerId: null,
      submissionId: null,
      talkId: input.talkId,
      fieldKey,
      intendedValue: fieldKey === "title" ? title : description,
      baseInboundRevision: recordLink?.inboundRevision ?? null,
      baseInboundHash: recordLink?.inboundHash ?? null,
      status: "pending" as const,
      version: 1,
      createdAt: prepared.now,
      updatedAt: prepared.now,
    })) : [];
    const airtableProjections = yield* Effect.forEach(pendingEdits, (edit, index) => database(() => prepareAirtableTalkProjection(db, {
      eventId: input.eventId,
      talk: candidate,
      changedKeys: [edit.fieldKey],
      origin: "agenda.updateTalkContent",
      idempotencyKey: `agenda.updateTalkContent:${prepared.id}:${edit.fieldKey}`,
      now: prepared.now,
      pendingEditId: edit.id,
      revisionOffset: index,
    })));
    yield* database(() => db.batch([
      db.update(talks).set({
        ...(airtableIntegration ? {} : { title, description }),
        version: candidate.version,
        updatedAt: prepared.now,
      }).where(and(
        eq(talks.eventId, input.eventId),
        eq(talks.id, input.talkId),
        eq(talks.version, input.expectedVersion),
      )),
      ...pendingEdits.map((edit) => db.insert(airtablePendingEdits).values(edit)),
      db.insert(idempotencyRecords).values(idempotencyInsert(
        prepared,
        input.eventId,
        "agenda.updateTalkContent",
        result as unknown as JsonValue,
        true,
      )),
      db.insert(domainChanges).values({
        id: changeId,
        eventId: input.eventId,
        aggregateType: "agenda-workspace",
        aggregateId: input.eventId,
        aggregateVersion: workspaceVersion,
        eventType: TALK_CHANGE_EVENT,
        audiences: PRIVATE_AUDIENCE,
        payload: { action: "content_updated", talk: candidate },
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: auditId,
        eventId: input.eventId,
        requestId: prepared.requestId,
        ...actor,
        action: "agenda.talk_content_updated",
        resourceType: "talk",
        resourceId: input.talkId,
        before,
        after: candidate,
        metadata: { idempotencyKeyHash: prepared.keyHash },
        occurredAt: prepared.now,
      }),
      ...airtableProjections.flatMap((projection) => projection ? [projection.statement] : []),
    ] as never));
    yield* broadcastMutation(result, principal.name, prepared.requestId);
    return result;
  }));

export const cancelTalk = (
  input: CancelTalkInput,
): Effect.Effect<AgendaMutationResult, AppError, Db | CurrentUser | Rooms> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    const prepared = yield* prepareIdempotency("agenda.cancelTalk", input);
    if (!("requestId" in prepared)) return prepared as AgendaMutationResult;
    const before = yield* loadTalk(input.eventId, input.talkId);
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Talk version is ${before.version}; expected ${input.expectedVersion}` }));
    }
    if (before.status === "cancelled") {
      return yield* Effect.fail(new Conflict({ message: "Talk is already cancelled" }));
    }
    const candidate: AgendaTalk = { ...before, status: "cancelled", version: before.version + 1 };
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    const changeId = nanoid();
    const auditId = nanoid();
    const result: AgendaMutationResult = { talk: candidate, conflicts: [], changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    const airtableProjection = yield* database(() => prepareAirtableTalkProjection(db, {
      eventId: input.eventId,
      talk: candidate,
      changedKeys: ["status"],
      origin: "agenda.cancelTalk",
      idempotencyKey: `agenda.cancelTalk:${prepared.id}`,
      now: prepared.now,
    }));
    yield* database(() => db.batch([
      db.update(talks).set({ status: "cancelled", version: candidate.version, updatedAt: prepared.now }).where(and(
        eq(talks.eventId, input.eventId),
        eq(talks.id, input.talkId),
        eq(talks.version, input.expectedVersion),
      )),
      db.insert(idempotencyRecords).values(idempotencyInsert(
        prepared,
        input.eventId,
        "agenda.cancelTalk",
        result as unknown as JsonValue,
        true,
      )),
      db.insert(domainChanges).values({
        id: changeId,
        eventId: input.eventId,
        aggregateType: "agenda-workspace",
        aggregateId: input.eventId,
        aggregateVersion: workspaceVersion,
        eventType: TALK_CHANGE_EVENT,
        audiences: PRIVATE_AUDIENCE,
        payload: { action: "cancelled", talk: candidate },
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      db.insert(auditLog).values({
        id: auditId,
        eventId: input.eventId,
        requestId: prepared.requestId,
        ...actor,
        action: "agenda.talk_cancelled",
        resourceType: "talk",
        resourceId: input.talkId,
        before,
        after: candidate,
        metadata: { idempotencyKeyHash: prepared.keyHash },
        occurredAt: prepared.now,
      }),
      ...(airtableProjection ? [airtableProjection.statement] : []),
    ] as never));
    yield* broadcastMutation(result, principal.name, prepared.requestId);
    return result;
  }));

export const publishAgenda = (
  input: PublishAgendaInput,
  interlock?: AgendaPublicationInterlock,
): Effect.Effect<PublishedAgenda, AppError, Db | CurrentUser> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    const prepared = yield* prepareIdempotency("agenda.publish", input);
    if (!("requestId" in prepared)) return prepared as PublishedAgenda;
    const event = yield* getEvent(input.eventId);
    const current = yield* latestPublication(input.eventId);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      return yield* Effect.fail(new Conflict({ message: `Agenda revision is ${currentRevision}; expected ${input.expectedRevision}` }));
    }
    const workspaceVersion = yield* currentWorkspaceVersion(input.eventId);
    if (workspaceVersion !== input.expectedWorkspaceVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Agenda workspace version is ${workspaceVersion}; expected ${input.expectedWorkspaceVersion}`,
      }));
    }
    if (event.version !== input.expectedEventVersion) {
      return yield* Effect.fail(new Conflict({
        message: `Event version is ${event.version}; expected ${input.expectedEventVersion}`,
      }));
    }
    const eventStartsAt = timestamp(event.startsAt);
    if (eventStartsAt === null) {
      return yield* Effect.fail(new Validation({ message: "Agenda publication requires an event start time" }));
    }
    const eventEndsAt = timestamp(event.endsAt);
    if (eventEndsAt === null) {
      return yield* Effect.fail(new Validation({ message: "Agenda publication requires an event end time" }));
    }
    if (eventEndsAt <= eventStartsAt) {
      return yield* Effect.fail(new Validation({
        message: "Agenda publication requires the event end time to be after the start time",
      }));
    }
    const [agendaTalks, trackRows, roomRows, speakerRows, pendingPublicationRows] = yield* Effect.all([
      loadTalkRows(input.eventId),
      database(() => db.select({ id: tracks.id, name: tracks.name, version: tracks.version, updatedAt: tracks.updatedAt }).from(tracks).where(eq(tracks.eventId, input.eventId))),
      database(() => db.select({ id: rooms.id, name: rooms.name, version: rooms.version, updatedAt: rooms.updatedAt }).from(rooms).where(eq(rooms.eventId, input.eventId))),
      database(() =>
        db
          .select({
            talkId: talkSpeakers.talkId,
            speakerId: speakers.id,
            name: speakers.displayName,
            visible: speakers.visible,
            version: speakers.version,
            updatedAt: speakers.updatedAt,
          })
          .from(talkSpeakers)
          .innerJoin(
            talks,
            and(eq(talks.eventId, talkSpeakers.eventId), eq(talks.id, talkSpeakers.talkId)),
          )
          .innerJoin(
            speakers,
            and(eq(speakers.eventId, talkSpeakers.eventId), eq(speakers.id, talkSpeakers.speakerId)),
          )
          .where(and(eq(talkSpeakers.eventId, input.eventId), eq(talks.status, "confirmed")))
          .orderBy(asc(talkSpeakers.talkId), asc(speakers.displayName), asc(speakers.id)),
      ),
      database(() => db.select({ id: airtablePendingEdits.id }).from(airtablePendingEdits).where(and(
        eq(airtablePendingEdits.eventId, input.eventId),
        eq(airtablePendingEdits.entityType, "talk"),
        eq(airtablePendingEdits.status, "pending"),
        inArray(airtablePendingEdits.fieldKey, ["title", "description"]),
      ))),
    ]);
    if (pendingPublicationRows.length > 0) {
      return yield* Effect.fail(new Validation({
        message: "Resolve pending Airtable talk title and description edits before publishing",
      }));
    }
    const conflicts = yield* loadConflicts(input.eventId, agendaTalks);
    const incompleteTalks = agendaTalks.filter(({ status, roomId, startsAt }) =>
      status !== "cancelled" && (status !== "confirmed" || roomId === null || startsAt === null)
    );
    if (incompleteTalks.length > 0) {
      return yield* Effect.fail(new Validation({
        message: `Agenda publication requires all active talks to be placed; ${incompleteTalks.length} ${incompleteTalks.length === 1 ? "talk is" : "talks are"} still TBD`,
      }));
    }
    yield* rejectConflicts(conflicts);
    const trackNames = new Map(trackRows.map(({ id, name }) => [id, name] as const));
    const roomNames = new Map(roomRows.map(({ id, name }) => [id, name] as const));
    const visibleSpeakerNames = new Map<string, string[]>();
    for (const row of speakerRows) {
      if (!row.visible) continue;
      const names = visibleSpeakerNames.get(row.talkId) ?? [];
      names.push(row.name);
      visibleSpeakerNames.set(row.talkId, names);
    }
    const confirmedTalks = agendaTalks
      .filter((talk): talk is AgendaTalk & { startsAt: number } =>
        talk.status === "confirmed" && talk.startsAt !== null
      )
      .sort((left, right) =>
        left.startsAt - right.startsAt ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id)
      );
    const outOfBoundsTalks = confirmedTalks.filter((talk) =>
      talk.startsAt < eventStartsAt ||
      talk.startsAt > eventEndsAt ||
      talk.startsAt + talk.durationMin * 60_000 > eventEndsAt
    );
    if (outOfBoundsTalks.length > 0) {
      return yield* Effect.fail(new Validation({
        message: `Agenda publication requires confirmed talks to fit within the event interval; ${outOfBoundsTalks.length} ${outOfBoundsTalks.length === 1 ? "talk falls" : "talks fall"} outside it`,
      }));
    }
    const speakerProjection = JSON.stringify(
      speakerRows
        .map(({ talkId, speakerId, name, visible, version }) => ({
          talkId,
          speakerId,
          publicDisplayName: visible ? name : null,
          version,
        }))
        .sort((left, right) =>
          left.talkId.localeCompare(right.talkId) ||
          left.speakerId.localeCompare(right.speakerId)
        ),
    );
    const publicTalks: PublicAgendaTalk[] = confirmedTalks.map((talk) => ({
      id: talk.id,
      title: talk.title,
      description: talk.description,
      trackId: talk.trackId,
      track: talk.trackId === null ? null : trackNames.get(talk.trackId) ?? null,
      room: talk.roomId === null ? null : roomNames.get(talk.roomId) ?? null,
      startsAt: talk.startsAt,
      durationMin: talk.durationMin,
      speakerNames: visibleSpeakerNames.get(talk.id) ?? [],
    }));
    const revision = currentRevision + 1;
    const calendarRevision = calendarProjectionRevision(
      event.version,
      agendaTalks,
      trackRows,
      roomRows,
      speakerRows,
    );
    const published = yield* decodePublishedAgenda({
      eventId: event.id,
      eventName: event.name,
      eventSlug: event.slug,
      timezone: event.timezone,
      location: event.location,
      revision,
      publishedAt: prepared.now.getTime(),
      calendarRevision,
      calendarUpdatedAt: prepared.now.getTime(),
      talks: publicTalks,
    });
    const deliveryProjection = yield* decodeAgendaDeliveryProjection({
      eventId: event.id,
      revision,
      eventStartsAt,
      eventEndsAt,
      talks: confirmedTalks.map((talk) => ({
        talkId: talk.id,
        roomId: talk.roomId,
        startsAt: talk.startsAt,
        durationMin: talk.durationMin,
        speakerIds: [...talk.speakerIds].sort(),
      })),
    });
    const historicalChanges = current === null
      ? []
      : yield* database(() => db.select({
          aggregateType: domainChanges.aggregateType,
          aggregateVersion: domainChanges.aggregateVersion,
          payload: domainChanges.payload,
        }).from(domainChanges).where(and(
          eq(domainChanges.eventId, input.eventId),
          inArray(domainChanges.aggregateType, ["agenda-publication", "agenda-delivery"]),
        )));
    const historicalPublications = new Map<number, PublishedAgenda>();
    const historicalDeliveries = new Map<number, AgendaDeliveryProjection>();
    for (const change of historicalChanges) {
      if (change.aggregateType === "agenda-publication") {
        historicalPublications.set(
          change.aggregateVersion,
          yield* decodePublishedAgenda(change.payload),
        );
      } else {
        historicalDeliveries.set(
          change.aggregateVersion,
          yield* decodeAgendaDeliveryProjection(change.payload),
        );
      }
    }
    type HistoricalFact = {
      readonly speakerIds: readonly string[];
      readonly title: string;
      readonly startsAt: Date;
      readonly durationMin: number;
      readonly roomName: string;
      readonly updatedAt: Date;
    };
    const historicalFacts = new Map<number, ReadonlyMap<string, HistoricalFact>>();
    for (const [historicalRevision, historicalPublication] of historicalPublications) {
      const historicalDelivery = historicalDeliveries.get(historicalRevision);
      if (!historicalDelivery) continue;
      const publishedTalks = new Map(
        historicalPublication.talks.map((talk) => [talk.id, talk] as const),
      );
      const facts = new Map<string, HistoricalFact>();
      for (const deliveryTalk of historicalDelivery.talks) {
        const publicTalk = publishedTalks.get(deliveryTalk.talkId);
        if (!publicTalk?.room) continue;
        facts.set(deliveryTalk.talkId, {
          speakerIds: deliveryTalk.speakerIds,
          title: publicTalk.title,
          startsAt: new Date(deliveryTalk.startsAt),
          durationMin: deliveryTalk.durationMin,
          roomName: publicTalk.room,
          updatedAt: new Date(historicalPublication.publishedAt),
        });
      }
      historicalFacts.set(historicalRevision, facts);
    }
    const calendarLineage = current === null
      ? []
      : yield* database(() => db
          .select({
            snapshotId: mailDeliverySnapshots.id,
            recipientUserId: mailDeliverySnapshots.recipientUserId,
            recipientEmail: mailDeliverySnapshots.recipientEmail,
            recipientName: mailDeliverySnapshots.recipientName,
            fromEmail: mailDeliverySnapshots.fromEmail,
            replyToEmail: mailDeliverySnapshots.replyToEmail,
            icsFilename: mailDeliverySnapshots.icsFilename,
            deliveryId: mailDeliveries.id,
            deliveryStatus: mailDeliveries.status,
            scheduledFor: mailDeliveries.scheduledFor,
            leaseExpiresAt: mailDeliveries.leaseExpiresAt,
            speakerId: mailCalendarEvents.speakerId,
            talkId: mailCalendarEvents.talkId,
            calendarUid: mailCalendarEvents.calendarUid,
            sequence: mailCalendarEvents.sequence,
            publicationRevision: mailCalendarEvents.publicationRevision,
            status: mailCalendarEvents.status,
            createdAt: mailCalendarEvents.createdAt,
          })
          .from(mailCalendarEvents)
          .innerJoin(
            mailDeliverySnapshots,
            eq(mailDeliverySnapshots.id, mailCalendarEvents.snapshotId),
          )
          .innerJoin(
            mailDeliveries,
            eq(mailDeliveries.snapshotId, mailDeliverySnapshots.id),
          )
          .where(eq(mailCalendarEvents.eventId, input.eventId))
          .orderBy(asc(mailCalendarEvents.sequence), asc(mailCalendarEvents.createdAt)));
    const [legacySnapshots, calendarSpeakers] = current === null
      ? [[], []] as const
      : yield* Effect.all([
          database(() => db
            .select({
              snapshotId: mailDeliverySnapshots.id,
              recipientUserId: mailDeliverySnapshots.recipientUserId,
              recipientEmail: mailDeliverySnapshots.recipientEmail,
              recipientName: mailDeliverySnapshots.recipientName,
              fromEmail: mailDeliverySnapshots.fromEmail,
              replyToEmail: mailDeliverySnapshots.replyToEmail,
              icsFilename: mailDeliverySnapshots.icsFilename,
              icsContent: mailDeliverySnapshots.icsContent,
              createdAt: mailDeliverySnapshots.createdAt,
              deliveryId: mailDeliveries.id,
              deliveryStatus: mailDeliveries.status,
              scheduledFor: mailDeliveries.scheduledFor,
              leaseExpiresAt: mailDeliveries.leaseExpiresAt,
            })
            .from(mailDeliverySnapshots)
            .innerJoin(
              mailDeliveries,
              eq(mailDeliveries.snapshotId, mailDeliverySnapshots.id),
            )
            .where(and(
              eq(mailDeliverySnapshots.eventId, input.eventId),
              isNotNull(mailDeliverySnapshots.icsContent),
            ))),
          database(() => db
            .select({
              speakerId: speakers.id,
              userId: speakers.userId,
              contactEmail: speakers.contactEmail,
              userEmail: users.email,
            })
            .from(speakers)
            .leftJoin(users, eq(users.id, speakers.userId))
            .where(eq(speakers.eventId, input.eventId))),
        ]);
    const speakerIdByUser = new Map(
      calendarSpeakers
        .filter((speaker): speaker is typeof speaker & { userId: string } => speaker.userId !== null)
        .map((speaker) => [speaker.userId, speaker.speakerId] as const),
    );
    const speakerIdByEmail = new Map<string, string>();
    for (const speaker of calendarSpeakers) {
      if (speaker.contactEmail) {
        speakerIdByEmail.set(speaker.contactEmail.trim().toLowerCase(), speaker.speakerId);
      }
      if (speaker.userEmail) {
        speakerIdByEmail.set(speaker.userEmail.trim().toLowerCase(), speaker.speakerId);
      }
    }
    const historicalRevisions = [...historicalFacts.entries()]
      .sort(([left], [right]) => right - left);
    const lineageSnapshotIds = new Set(calendarLineage.map(({ snapshotId }) => snapshotId));
    const legacyBackfill = legacySnapshots.flatMap((snapshot) => {
      if (lineageSnapshotIds.has(snapshot.snapshotId) || snapshot.icsContent === null) return [];
      const speakerId = (
        snapshot.recipientUserId ? speakerIdByUser.get(snapshot.recipientUserId) : undefined
      ) ?? speakerIdByEmail.get(snapshot.recipientEmail.trim().toLowerCase());
      if (!speakerId) return [];
      return parseCalendarEvents(snapshot.icsContent).map((calendarEvent) => {
        const publicationRevision = historicalRevisions.find(([, facts]) => {
          const fact = facts.get(calendarEvent.talkId);
          return fact !== undefined &&
            fact.title === calendarEvent.title &&
            fact.startsAt.getTime() === calendarEvent.startsAt.getTime() &&
            fact.durationMin === calendarEvent.durationMin &&
            fact.roomName === calendarEvent.roomName;
        })?.[0];
        return {
          snapshot,
          speakerId,
          calendarEvent,
          publicationRevision,
        };
      });
    });
    const unresolvedLegacy = legacyBackfill.find(({ publicationRevision }) =>
      publicationRevision === undefined
    );
    if (unresolvedLegacy) {
      return yield* Effect.fail(new External({
        service: "mail-calendar-lineage",
        detail: `Legacy calendar snapshot '${unresolvedLegacy.snapshot.snapshotId}' does not match a published agenda revision`,
      }));
    }
    type DeliveryStatus = typeof mailDeliveries.$inferSelect.status;
    type HydratedLineage = {
      readonly snapshotId: string;
      readonly recipientUserId: string | null;
      readonly recipientEmail: string;
      readonly recipientName: string | null;
      readonly fromEmail: string;
      readonly replyToEmail: string | null;
      readonly icsFilename: string | null;
      readonly deliveryId: string;
      readonly deliveryStatus: DeliveryStatus;
      readonly scheduledFor: Date;
      readonly leaseExpiresAt: Date | null;
      readonly speakerId: string;
      readonly talkId: string;
      readonly calendarUid: string;
      readonly sequence: number;
      readonly publicationRevision: number;
      readonly status: "confirmed" | "cancelled";
      readonly createdAt: Date;
      readonly event: CalendarEventSnapshot | null;
    };
    const hydratedLineage: HydratedLineage[] = [];
    for (const row of calendarLineage) {
      const fact = historicalFacts.get(row.publicationRevision)?.get(row.talkId);
      if (row.status === "confirmed" && !fact) {
        return yield* Effect.fail(new External({
          service: "mail-calendar-lineage",
          detail: `Calendar lineage '${row.snapshotId}:${row.talkId}' has no publication facts`,
        }));
      }
      hydratedLineage.push({
        ...row,
        event: fact
          ? {
              talkId: row.talkId,
              uid: row.calendarUid,
              title: fact.title,
              startsAt: fact.startsAt,
              durationMin: fact.durationMin,
              roomName: fact.roomName,
              sequence: row.sequence,
              updatedAt: fact.updatedAt,
              status: row.status,
            }
          : null,
      });
    }
    for (const { snapshot, speakerId, calendarEvent, publicationRevision } of legacyBackfill) {
      hydratedLineage.push({
        snapshotId: snapshot.snapshotId,
        recipientUserId: snapshot.recipientUserId,
        recipientEmail: snapshot.recipientEmail,
        recipientName: snapshot.recipientName,
        fromEmail: snapshot.fromEmail,
        replyToEmail: snapshot.replyToEmail,
        icsFilename: snapshot.icsFilename,
        deliveryId: snapshot.deliveryId,
        deliveryStatus: snapshot.deliveryStatus,
        scheduledFor: snapshot.scheduledFor,
        leaseExpiresAt: snapshot.leaseExpiresAt,
        speakerId,
        talkId: calendarEvent.talkId,
        calendarUid: calendarEvent.uid,
        sequence: calendarEvent.sequence,
        publicationRevision: publicationRevision!,
        status: calendarEvent.status,
        createdAt: snapshot.createdAt,
        event: calendarEvent,
      });
    }
    type LineageEvent = {
      readonly speakerId: string;
      readonly publicationRevision: number;
      readonly event: CalendarEventSnapshot | null;
      readonly talkId: string;
      readonly uid: string;
      readonly sequence: number;
      readonly status: "confirmed" | "cancelled";
    };
    type InFlightCalendar = {
      readonly deliveryId: string;
      readonly scheduledFor: Date;
      readonly leaseExpiresAt: Date | null;
      readonly status: "pending" | "retry" | "claimed" | "dispatching";
      readonly byTalk: Map<string, LineageEvent>;
    };
    type RecipientLineage = {
      recipientUserId: string | null;
      recipientEmail: string;
      recipientName: string;
      fromEmail: string;
      replyToEmail: string | null;
      icsFilename: string | null;
      sequence: number;
      eligibleForUpdates: boolean;
      readonly speakerIds: Set<string>;
      readonly deliveredByTalk: Map<string, LineageEvent>;
      readonly identitiesByTalk: Map<string, LineageEvent>;
      readonly inFlight: Map<string, InFlightCalendar>;
    };
    const recipientsByEmail = new Map<string, RecipientLineage>();
    for (const row of hydratedLineage) {
      const key = row.recipientEmail.trim().toLowerCase();
      let recipient = recipientsByEmail.get(key);
      if (!recipient) {
        recipient = {
          recipientUserId: row.recipientUserId,
          recipientEmail: row.recipientEmail,
          recipientName: row.recipientName?.trim() || row.recipientEmail,
          fromEmail: row.fromEmail,
          replyToEmail: row.replyToEmail,
          icsFilename: row.icsFilename,
          sequence: row.sequence,
          eligibleForUpdates: false,
          speakerIds: new Set(),
          deliveredByTalk: new Map(),
          identitiesByTalk: new Map(),
          inFlight: new Map(),
        };
        recipientsByEmail.set(key, recipient);
      }
      const eligibleForUpdates = row.deliveryStatus !== "cancelled" &&
        row.deliveryStatus !== "dead_letter";
      if (eligibleForUpdates) {
        recipient.eligibleForUpdates = true;
        recipient.speakerIds.add(row.speakerId);
      }
      const lineageEvent: LineageEvent = {
        speakerId: row.speakerId,
        publicationRevision: row.publicationRevision,
        event: row.event,
        talkId: row.talkId,
        uid: row.calendarUid,
        sequence: row.sequence,
        status: row.status,
      };
      const identity = recipient.identitiesByTalk.get(row.talkId);
      if (!identity || identity.sequence <= row.sequence) {
        recipient.identitiesByTalk.set(row.talkId, lineageEvent);
      }
      if (row.deliveryStatus === "sent") {
        const prior = recipient.deliveredByTalk.get(row.talkId);
        if (!prior || prior.sequence <= row.sequence) {
          recipient.deliveredByTalk.set(row.talkId, lineageEvent);
        }
      } else if (eligibleForUpdates) {
        let inFlight = recipient.inFlight.get(row.deliveryId);
        if (!inFlight) {
          inFlight = {
            deliveryId: row.deliveryId,
            scheduledFor: row.scheduledFor,
            leaseExpiresAt: row.leaseExpiresAt,
            status: row.deliveryStatus,
            byTalk: new Map(),
          };
          recipient.inFlight.set(row.deliveryId, inFlight);
        }
        inFlight.byTalk.set(row.talkId, lineageEvent);
      }
      if (recipient.sequence <= row.sequence) {
        recipient.recipientUserId = row.recipientUserId;
        recipient.recipientEmail = row.recipientEmail;
        recipient.recipientName = row.recipientName?.trim() || row.recipientEmail;
        recipient.fromEmail = row.fromEmail;
        recipient.replyToEmail = row.replyToEmail;
        recipient.icsFilename = row.icsFilename;
        recipient.sequence = row.sequence;
      }
    }
    const publicTalksById = new Map(published.talks.map((talk) => [talk.id, talk] as const));
    const staleDeliveryIds = new Set<string>();
    const supersededClaimedIds = new Set<string>();
    const affectedDeliveryIds = new Set<string>();
    const calendarUpdates: Array<{
      readonly snapshot: typeof mailDeliverySnapshots.$inferInsert;
      readonly delivery: typeof mailDeliveries.$inferInsert;
      readonly events: readonly LineageEvent[];
    }> = [];
    const eventFactsEqual = (
      left: CalendarEventSnapshot | null,
      right: CalendarEventSnapshot,
    ): boolean => left !== null
      && left.status === right.status
      && left.startsAt.getTime() === right.startsAt.getTime()
      && left.durationMin === right.durationMin
      && left.roomName === right.roomName
      && left.title === right.title;
    for (const [recipientKey, recipient] of recipientsByEmail) {
      if (!recipient.eligibleForUpdates) continue;
      const desiredByTalk = new Map<string, LineageEvent>();
      for (const deliveryTalk of deliveryProjection.talks) {
        const speakerId = deliveryTalk.speakerIds.find((id) => recipient.speakerIds.has(id));
        if (!speakerId) continue;
        const publicTalk = publicTalksById.get(deliveryTalk.talkId);
        if (!publicTalk?.room) continue;
        const identity = recipient.identitiesByTalk.get(deliveryTalk.talkId);
        desiredByTalk.set(deliveryTalk.talkId, {
          speakerId,
          publicationRevision: published.revision,
          talkId: deliveryTalk.talkId,
          uid: identity?.uid ?? stableCalendarUid(input.eventId, deliveryTalk.talkId),
          sequence: Math.max(published.revision, (identity?.sequence ?? 0) + 1),
          status: "confirmed",
          event: {
            talkId: deliveryTalk.talkId,
            uid: identity?.uid ?? stableCalendarUid(input.eventId, deliveryTalk.talkId),
            title: publicTalk.title,
            startsAt: new Date(deliveryTalk.startsAt),
            durationMin: deliveryTalk.durationMin,
            roomName: publicTalk.room,
            sequence: Math.max(published.revision, (identity?.sequence ?? 0) + 1),
            updatedAt: prepared.now,
            status: "confirmed",
          },
        });
      }
      const affectedInFlight: InFlightCalendar[] = [];
      for (const inFlight of recipient.inFlight.values()) {
        const stale = [...inFlight.byTalk.values()].some((prior) => {
          const desired = desiredByTalk.get(prior.talkId);
          return prior.status === "confirmed"
            ? !desired || !eventFactsEqual(prior.event, desired.event!)
            : desired !== undefined;
        }) || [...desiredByTalk.keys()].some((talkId) => !inFlight.byTalk.has(talkId));
        if (!stale) continue;
        affectedInFlight.push(inFlight);
        affectedDeliveryIds.add(inFlight.deliveryId);
        if (inFlight.status === "claimed") {
          supersededClaimedIds.add(inFlight.deliveryId);
        } else if (inFlight.status === "pending" || inFlight.status === "retry") {
          staleDeliveryIds.add(inFlight.deliveryId);
        }
      }
      const requests: LineageEvent[] = [];
      const cancellations: LineageEvent[] = [];
      for (const desired of desiredByTalk.values()) {
        const prior = recipient.deliveredByTalk.get(desired.talkId);
        if (!prior || prior.status !== "confirmed" || !eventFactsEqual(prior.event, desired.event!)) {
          requests.push(desired);
        }
      }
      for (const prior of recipient.deliveredByTalk.values()) {
        if (prior.status !== "confirmed" || desiredByTalk.has(prior.talkId) || !prior.event) continue;
        const sequence = Math.max(
          published.revision,
          (recipient.identitiesByTalk.get(prior.talkId)?.sequence ?? prior.sequence) + 1,
        );
        cancellations.push({
          ...prior,
          publicationRevision: published.revision,
          sequence,
          status: "cancelled",
          event: {
            ...prior.event,
            sequence,
            updatedAt: prepared.now,
            status: "cancelled",
          },
        });
      }
      for (const inFlight of affectedInFlight) {
        if (inFlight.status !== "claimed") continue;
        for (const prior of inFlight.byTalk.values()) {
          if (prior.status !== "confirmed" || desiredByTalk.has(prior.talkId) || !prior.event) continue;
          const sequence = Math.max(
            published.revision,
            (recipient.identitiesByTalk.get(prior.talkId)?.sequence ?? prior.sequence) + 1,
          );
          const cancellation: LineageEvent = {
            ...prior,
            publicationRevision: published.revision,
            sequence,
            status: "cancelled",
            event: {
              ...prior.event,
              sequence,
              updatedAt: prepared.now,
              status: "cancelled",
            },
          };
          const existingIndex = cancellations.findIndex(({ talkId }) => talkId === prior.talkId);
          if (existingIndex === -1) {
            cancellations.push(cancellation);
          } else if (cancellations[existingIndex]!.sequence <= sequence) {
            cancellations[existingIndex] = cancellation;
          }
        }
      }
      const escapedEventName = event.name
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
      const filenameRecipient = recipient.recipientName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "speaker";
      const appendDelivery = (
        method: CalendarMethod,
        lineageEvents: readonly LineageEvent[],
        scheduledFor: Date,
        keySuffix: string,
      ): void => {
        if (lineageEvents.length === 0) return;
        const snapshotId = nanoid();
        const deliveryId = nanoid();
        const cancellation = method === "CANCEL";
        calendarUpdates.push({
          snapshot: {
            id: snapshotId,
            eventId: input.eventId,
            templateId: null,
            recipientUserId: recipient.recipientUserId,
            recipientEmail: recipient.recipientEmail,
            recipientName: recipient.recipientName,
            fromEmail: recipient.fromEmail,
            replyToEmail: recipient.replyToEmail,
            subject: `${cancellation ? "Calendar cancellation" : "Calendar update"}: ${event.name}`,
            renderedHtml: `<p>The published schedule for <strong>${escapedEventName}</strong> changed. This calendar attachment ${cancellation ? "cancels removed sessions" : "updates your agenda"}.</p>`,
            renderedText: `The published schedule for ${event.name} changed. This calendar attachment ${cancellation ? "cancels removed sessions" : "updates your agenda"}.`,
            icsFilename: recipient.icsFilename ?? `${event.slug}-${filenameRecipient}-agenda.ics`,
            icsContent: renderCalendar(
              event,
              { name: recipient.recipientName, email: recipient.recipientEmail },
              lineageEvents.map(({ event: calendarEvent }) => calendarEvent!),
              method,
              prepared.now,
              recipient.fromEmail,
            ),
            createdAt: prepared.now,
          },
          delivery: {
            id: deliveryId,
            snapshotId,
            idempotencyKey: `agenda-calendar-${keySuffix}:${prepared.id}:${recipientKey}`,
            status: "pending",
            scheduledFor,
            availableAt: scheduledFor,
            attemptCount: 0,
            maxAttempts: 8,
            createdAt: prepared.now,
          },
          events: lineageEvents,
        });
      };
      const updateAvailableAt = affectedInFlight.reduce((latest, inFlight) => {
        const deliveryBoundary = inFlight.status === "claimed" && inFlight.leaseExpiresAt
          ? inFlight.leaseExpiresAt
          : prepared.now;
        return deliveryBoundary > latest ? deliveryBoundary : latest;
      }, prepared.now);
      if (recipient.deliveredByTalk.size > 0) {
        appendDelivery("REQUEST", requests, updateAvailableAt, "request");
        appendDelivery("CANCEL", cancellations, updateAvailableAt, "cancel");
      } else if (affectedInFlight.length > 0) {
        if (desiredByTalk.size > 0) {
          appendDelivery(
            "REQUEST",
            [...desiredByTalk.values()],
            updateAvailableAt,
            "replacement",
          );
        } else {
          appendDelivery("CANCEL", cancellations, updateAvailableAt, "cancel");
        }
      }
    }
    if (interlock) {
      yield* interlock({
        eventId: input.eventId,
        expectedWorkspaceVersion: input.expectedWorkspaceVersion,
        nextRevision: published.revision,
        expectedEventVersion: input.expectedEventVersion,
      });
    }
    const dispatchInterlock = affectedDeliveryIds.size === 0
      ? sql`1 = 1`
      : sql`not exists (
          select 1
          from ${mailDeliveries}
          where ${inArray(mailDeliveries.id, [...affectedDeliveryIds])}
            and ${mailDeliveries.status} = 'dispatching'
        ) and ${
          staleDeliveryIds.size === 0
            ? sql`1 = 1`
            : sql`not exists (
                select 1
                from ${mailDeliveries}
                where ${inArray(mailDeliveries.id, [...staleDeliveryIds])}
                  and ${mailDeliveries.status} not in ('pending', 'retry')
              )`
        } and ${
          supersededClaimedIds.size === 0
            ? sql`1 = 1`
            : sql`not exists (
                select 1
                from ${mailDeliveries}
                where ${inArray(mailDeliveries.id, [...supersededClaimedIds])}
                  and ${mailDeliveries.status} not in ('claimed', 'sent')
              )`
        }`;
    const actor = actorColumns(principal);
    const changeId = nanoid();
    const deliveryChangeId = nanoid();
    const auditId = nanoid();
    const completedIdempotency = idempotencyInsert(
      prepared,
      input.eventId,
      "agenda.publish",
      published as unknown as JsonValue,
    );
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values({
        ...completedIdempotency,
        completedAt: sql<Date>`case when coalesce((
          select max(${domainChanges.aggregateVersion})
          from ${domainChanges}
          where ${domainChanges.eventId} = ${input.eventId}
            and ${domainChanges.aggregateType} = 'agenda-workspace'
            and ${domainChanges.aggregateId} = ${input.eventId}
            and ${domainChanges.eventType} = ${TALK_CHANGE_EVENT}
        ), 0) = ${input.expectedWorkspaceVersion}
          and (
            select ${events.version}
            from ${events}
            where ${events.id} = ${input.eventId}
          ) = ${input.expectedEventVersion}
          and not exists (
            select 1
            from ${airtablePendingEdits}
            where ${airtablePendingEdits.eventId} = ${input.eventId}
              and ${airtablePendingEdits.entityType} = 'talk'
              and ${airtablePendingEdits.status} = 'pending'
              and ${airtablePendingEdits.fieldKey} in ('title', 'description')
          )
          and ${dispatchInterlock}
          and not exists (
            with expected_speakers as (
              select
                json_extract(expected_speaker.value, '$.talkId') as talk_id,
                json_extract(expected_speaker.value, '$.speakerId') as speaker_id,
                json_extract(expected_speaker.value, '$.publicDisplayName') as public_name,
                json_extract(expected_speaker.value, '$.version') as version
              from json_each(${speakerProjection}) as expected_speaker
            ),
            current_speakers as (
              select
                publication_talk_speaker.talk_id,
                publication_speaker.id as speaker_id,
                case
                  when publication_speaker.visible = 1 then publication_speaker.display_name
                  else null
                end as public_name,
                publication_speaker.version
              from talk_speakers as publication_talk_speaker
              inner join talks as publication_talk
                on publication_talk.event_id = publication_talk_speaker.event_id
                and publication_talk.id = publication_talk_speaker.talk_id
              inner join speakers as publication_speaker
                on publication_speaker.event_id = publication_talk_speaker.event_id
                and publication_speaker.id = publication_talk_speaker.speaker_id
              where publication_talk_speaker.event_id = ${input.eventId}
                and publication_talk.status = 'confirmed'
            )
            select 1
            from expected_speakers as expected
            left join current_speakers as current
              on current.talk_id = expected.talk_id
              and current.speaker_id = expected.speaker_id
            where current.speaker_id is null
              or current.public_name is not expected.public_name
              or current.version is not expected.version
            union all
            select 1
            from current_speakers as current
            left join expected_speakers as expected
              on expected.talk_id = current.talk_id
              and expected.speaker_id = current.speaker_id
            where expected.speaker_id is null
              or current.public_name is not expected.public_name
              or current.version is not expected.version
          )
          then ${prepared.now.getTime()}
          else null
        end`,
      }),
      db.insert(domainChanges).values({
        id: changeId,
        eventId: input.eventId,
        aggregateType: "agenda-publication",
        aggregateId: input.eventId,
        aggregateVersion: published.revision,
        eventType: PUBLICATION_EVENT,
        audiences: PUBLIC_AUDIENCE,
        payload: published,
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      db.insert(domainChanges).values({
        id: deliveryChangeId,
        eventId: input.eventId,
        aggregateType: "agenda-delivery",
        aggregateId: input.eventId,
        aggregateVersion: deliveryProjection.revision,
        eventType: DELIVERY_PROJECTION_EVENT,
        audiences: PRIVATE_AUDIENCE,
        payload: deliveryProjection,
        ...actor,
        requestId: prepared.requestId,
        idempotencyRecordId: prepared.id,
        occurredAt: prepared.now,
      }),
      ...(
        staleDeliveryIds.size > 0
          ? [db.update(mailDeliveries).set({
              status: "cancelled",
              leaseOwner: null,
              leaseExpiresAt: null,
            }).where(and(
              inArray(mailDeliveries.id, [...staleDeliveryIds]),
              inArray(mailDeliveries.status, ["pending", "retry"]),
            ))]
          : []
      ),
      ...(
        supersededClaimedIds.size > 0
          ? [db.update(mailDeliveries).set({
              supersededAt: prepared.now,
            }).where(and(
              inArray(mailDeliveries.id, [...supersededClaimedIds]),
              eq(mailDeliveries.status, "claimed"),
            ))]
          : []
      ),
      ...legacyBackfill.map(({ snapshot, speakerId, calendarEvent, publicationRevision }) =>
        db.insert(mailCalendarEvents).values({
          id: nanoid(),
          snapshotId: snapshot.snapshotId,
          eventId: input.eventId,
          speakerId,
          talkId: calendarEvent.talkId,
          calendarUid: calendarEvent.uid,
          sequence: calendarEvent.sequence,
          publicationRevision: publicationRevision!,
          status: calendarEvent.status,
          createdAt: snapshot.createdAt,
        })
      ),
      ...calendarUpdates.flatMap((update) => [
        db.insert(mailDeliverySnapshots).values(update.snapshot),
        db.insert(mailDeliveries).values(update.delivery),
        ...update.events.map((calendarEvent) =>
          db.insert(mailCalendarEvents).values({
            id: nanoid(),
            snapshotId: update.snapshot.id,
            eventId: input.eventId,
            speakerId: calendarEvent.speakerId,
            talkId: calendarEvent.talkId,
            calendarUid: calendarEvent.uid,
            sequence: calendarEvent.sequence,
            publicationRevision: calendarEvent.publicationRevision,
            status: calendarEvent.status,
            createdAt: prepared.now,
          })
        ),
      ]),
      db.insert(auditLog).values({
        id: auditId,
        eventId: input.eventId,
        requestId: prepared.requestId,
        ...actor,
        action: "agenda.revision_published",
        resourceType: "agenda-publication",
        resourceId: input.eventId,
        before: current,
        after: published,
        metadata: {
          idempotencyKeyHash: prepared.keyHash,
          talkCount: published.talks.length,
          calendarUpdateDeliveryIds: calendarUpdates.map(({ delivery }) => delivery.id),
        },
        occurredAt: prepared.now,
      }),
    ]));
    return published;
  }));

export const getPublishedAgenda = (
  input: GetPublishedAgendaInput,
): Effect.Effect<PublishedAgenda, AppError, Db> =>
  Effect.gen(function* () {
    const eventId = yield* resolveEventIdBySlug(input.eventSlug);
    const published = yield* getLatestPublishedAgendaSnapshot(eventId);
    const { db } = yield* Db;
    const [liveTalks, talkUpdateRows, eventRows, roomRows, trackRows, speakerRows] = yield* Effect.all([
      loadTalkRows(eventId),
      database(() => db.select({ version: talks.version, updatedAt: talks.updatedAt }).from(talks).where(eq(talks.eventId, eventId))),
      database(() => db.select({
        name: events.name,
        slug: events.slug,
        timezone: events.timezone,
        location: events.location,
        version: events.version,
        updatedAt: events.updatedAt,
      }).from(events).where(eq(events.id, eventId)).limit(1)),
      database(() => db.select({ id: rooms.id, name: rooms.name, version: rooms.version, updatedAt: rooms.updatedAt }).from(rooms).where(eq(rooms.eventId, eventId))),
      database(() => db.select({ id: tracks.id, name: tracks.name, version: tracks.version, updatedAt: tracks.updatedAt }).from(tracks).where(eq(tracks.eventId, eventId))),
      database(() => db.select({
        talkId: talkSpeakers.talkId,
        name: speakers.displayName,
        visible: speakers.visible,
        version: speakers.version,
        updatedAt: speakers.updatedAt,
      })
        .from(talkSpeakers)
        .innerJoin(speakers, and(
          eq(speakers.eventId, talkSpeakers.eventId),
          eq(speakers.id, talkSpeakers.speakerId),
        ))
        .where(eq(talkSpeakers.eventId, eventId))
        .orderBy(asc(talkSpeakers.talkId), asc(speakers.displayName), asc(speakers.id))),
    ]);
    const currentEvent = eventRows[0];
    if (!currentEvent) return yield* Effect.fail(new NotFound({ entity: "event", id: eventId }));
    const publishedTalkIds = new Set(published.talks.map(({ id }) => id));
    const relevantSpeakerRows = speakerRows.filter(({ talkId }) => publishedTalkIds.has(talkId));
    const liveById = new Map(liveTalks.map((talk) => [talk.id, talk] as const));
    const roomNames = new Map(roomRows.map((room) => [room.id, room.name] as const));
    const trackNames = new Map(trackRows.map((track) => [track.id, track.name] as const));
    const speakerNames = new Map<string, string[]>();
    for (const speaker of relevantSpeakerRows) {
      if (!speaker.visible) continue;
      speakerNames.set(speaker.talkId, [...(speakerNames.get(speaker.talkId) ?? []), speaker.name]);
    }
    const publicTalks = published.talks.flatMap((snapshot): readonly PublicAgendaTalk[] => {
      const live = liveById.get(snapshot.id);
      if (!live || live.status !== "confirmed" || live.startsAt === null || live.roomId === null) return [];
      const room = roomNames.get(live.roomId);
      if (!room) return [];
      return [{
        id: live.id,
        title: live.title,
        description: live.description,
        trackId: live.trackId,
        track: live.trackId === null ? null : trackNames.get(live.trackId) ?? null,
        room,
        startsAt: live.startsAt,
        durationMin: live.durationMin,
        speakerNames: speakerNames.get(live.id) ?? [],
      }];
    });
    return {
      ...published,
      eventName: currentEvent.name,
      eventSlug: currentEvent.slug,
      timezone: currentEvent.timezone,
      location: currentEvent.location,
      calendarRevision: calendarProjectionRevision(
        currentEvent.version,
        liveTalks,
        trackRows,
        roomRows,
        relevantSpeakerRows,
      ),
      calendarUpdatedAt: calendarProjectionUpdatedAt(
        published.publishedAt,
        [currentEvent],
        talkUpdateRows,
        trackRows,
        roomRows,
        relevantSpeakerRows,
      ),
      talks: publicTalks,
    };
  });
