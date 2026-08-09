import { Conflict, External, NotFound, Validation, type AppError } from "contracts/errors";
import type { Principal as CurrentUserValue } from "contracts/principal";
import {
  acceptanceEvents,
  auditLog,
  domainChanges,
  events,
  idempotencyRecords,
  rooms,
  speakerProvisioning,
  speakers,
  submissionSpeakers,
  submissions,
  talkSpeakers,
  talks,
  tracks,
} from "contracts/schema";
import type { JsonValue } from "contracts/domain";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
// BaselineGreen may rename these invocation seams; keep the shared import isolated here.
import { CurrentUser, Db, Rooms } from "@/server/services";
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
  BacklogProposal,
  CancelTalkInput,
  CreateTalkInput,
  GetAgendaDeliveryProjectionInput,
  GetPublishedAgendaInput,
  ListAgendaInput,
  MoveTalkInput,
  PublishedAgenda,
  PublishAgendaInput,
  PublicAgendaTalk,
  ScheduleTalkInput,
} from "./schema";

const DAY_MS = 86_400_000;
const IDEMPOTENCY_TTL_MS = DAY_MS;
const PRIVATE_AUDIENCE = [{ kind: "admins" }] as const;
const PUBLIC_AUDIENCE = [{ kind: "public" }] as const;
const TALK_CHANGE_EVENT = "agenda.talk_changed";
const AGENDA_SNAPSHOT_MAX_ATTEMPTS = 3;
const PUBLICATION_EVENT = "agenda/published";
const DELIVERY_PROJECTION_EVENT = "agenda/delivery-published";

type Principal = CurrentUserValue;
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
  readonly operationId: "agenda.createTalk" | "agenda.moveTalk" | "agenda.scheduleTalk";
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

const actorColumns = (principal: Principal) =>
  principal.kind === "api-key"
    ? { actorUserId: null, actorApiKeyId: principal.apiKeyId }
    : { actorUserId: principal.userId, actorApiKeyId: null };

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

    const speakerRows = yield* database(() =>
      db
        .select({ talkId: talkSpeakers.talkId, speakerId: speakers.id, speakerName: speakers.displayName })
        .from(talkSpeakers)
        .innerJoin(
          speakers,
          and(eq(speakers.eventId, talkSpeakers.eventId), eq(speakers.id, talkSpeakers.speakerId)),
        )
        .where(and(eq(talkSpeakers.eventId, eventId), inArray(talkSpeakers.talkId, talkRows.map(({ id }) => id))))
        .orderBy(asc(talkSpeakers.talkId), asc(speakers.displayName), asc(speakers.id)),
    );

    const speakersByTalk = new Map<string, { ids: string[]; names: string[] }>();
    for (const row of speakerRows) {
      const entry = speakersByTalk.get(row.talkId) ?? { ids: [], names: [] };
      entry.ids.push(row.speakerId);
      entry.names.push(row.speakerName);
      speakersByTalk.set(row.talkId, entry);
    }

    return talkRows.map((talk) => {
      const talkSpeakerRows = speakersByTalk.get(talk.id) ?? { ids: [], names: [] };
      return {
        id: talk.id,
        eventId: talk.eventId,
        submissionId: talk.submissionId,
        title: talk.title,
        description: talk.description,
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
        database(() => db.select().from(tracks).where(eq(tracks.eventId, input.eventId)).orderBy(asc(tracks.order), asc(tracks.name))),
        database(() => db.select().from(rooms).where(eq(rooms.eventId, input.eventId)).orderBy(asc(rooms.order), asc(rooms.name))),
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
        tracks: trackRows.map((track) => ({ id: track.id, name: track.name, color: track.color, order: track.order })),
        rooms: roomRows.map((room) => ({ id: room.id, name: room.name, capacity: room.capacity, order: room.order })),
        backlog,
        talks: agendaTalks,
        conflicts,
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
): Effect.Effect<IdempotencyContext | AgendaMutationResult | PublishedAgenda, AppError, Db | CurrentUser> =>
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
      const replay = existing.responseBody as AgendaMutationResult | PublishedAgenda;
      return "talk" in replay ? { ...replay, replayed: true } : replay;
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

    const status = input.roomId !== null && input.startsAt !== null ? "confirmed" as const : "draft" as const;
    const talkId = nanoid();
    const candidate: AgendaTalk = {
      id: talkId,
      eventId: input.eventId,
      submissionId: input.submissionId,
      title: submission.title,
      description: null,
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
    yield* rejectConflicts(conflicts.filter(({ talkIds }) => talkIds.includes(candidate.id)));

    const changeId = nanoid();
    const auditId = nanoid();
    const result: AgendaMutationResult = { talk: candidate, conflicts: [], changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    const talkInsert = db.insert(talks).values({
      id: talkId,
      eventId: input.eventId,
      submissionId: input.submissionId,
      title: submission.title,
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
    yield* database(() => db.batch([talkInsert, ...speakerInserts, idempotencyInsertQuery, changeInsert, auditInsert]));
    yield* broadcastMutation(result, principal.name, prepared.requestId);
    return result;
  }));

const repositionTalk = (
  operationId: "agenda.scheduleTalk" | "agenda.moveTalk",
  action: "scheduled" | "moved",
  input: ScheduleTalkInput | MoveTalkInput,
  interlock?: AgendaMutationInterlock,
): Effect.Effect<AgendaMutationResult, AppError, Db | CurrentUser | Rooms> =>
  mutationContention(Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    const prepared = yield* prepareIdempotency(operationId, input);
    if (!("requestId" in prepared)) return prepared as AgendaMutationResult;
    const workspaceVersion = yield* nextWorkspaceVersion(input.eventId);
    yield* waitAfterWorkspaceSample(interlock, {
      eventId: input.eventId,
      operationId,
      workspaceVersion,
    });
    yield* ensureScheduleReferences(input.eventId, input.roomId, input.trackId);
    const before = yield* loadTalk(input.eventId, input.talkId);
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: `Talk version is ${before.version}; expected ${input.expectedVersion}` }));
    }
    if (before.status === "cancelled") {
      return yield* Effect.fail(new Conflict({ message: "Cancelled talks cannot be scheduled or moved" }));
    }
    const candidate: AgendaTalk = {
      ...before,
      trackId: input.trackId,
      roomId: input.roomId,
      startsAt: input.startsAt,
      durationMin: input.durationMin,
      status: "confirmed",
      version: before.version + 1,
    };
    const existing = yield* loadTalkRows(input.eventId);
    const conflicts = yield* loadConflicts(input.eventId, [...existing.filter(({ id }) => id !== candidate.id), candidate]);
    yield* rejectConflicts(conflicts.filter(({ talkIds }) => talkIds.includes(candidate.id)));

    const changeId = nanoid();
    const auditId = nanoid();
    const result: AgendaMutationResult = { talk: candidate, conflicts: [], changeId, auditId, replayed: false };
    const actor = actorColumns(principal);
    const update = db
      .update(talks)
      .set({
        trackId: input.trackId,
        roomId: input.roomId,
        startsAt: new Date(input.startsAt),
        durationMin: input.durationMin,
        status: "confirmed",
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
    yield* database(() => db.batch([update, idempotencyInsertQuery, changeInsert, auditInsert]));
    yield* broadcastMutation(result, principal.name, prepared.requestId);
    return result;
  }));

export const scheduleTalk = (input: ScheduleTalkInput, interlock?: AgendaMutationInterlock) =>
  repositionTalk("agenda.scheduleTalk", "scheduled", input, interlock);

export const moveTalk = (input: MoveTalkInput, interlock?: AgendaMutationInterlock) =>
  repositionTalk("agenda.moveTalk", "moved", input, interlock);

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
    ]));
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
    const [agendaTalks, trackRows, roomRows, visibleSpeakerRows] = yield* Effect.all([
      loadTalkRows(input.eventId),
      database(() => db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, input.eventId))),
      database(() => db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.eventId, input.eventId))),
      database(() =>
        db
          .select({ talkId: talkSpeakers.talkId, name: speakers.displayName })
          .from(talkSpeakers)
          .innerJoin(
            speakers,
            and(eq(speakers.eventId, talkSpeakers.eventId), eq(speakers.id, talkSpeakers.speakerId)),
          )
          .where(and(eq(talkSpeakers.eventId, input.eventId), eq(speakers.visible, true)))
          .orderBy(asc(talkSpeakers.talkId), asc(speakers.displayName), asc(speakers.id)),
      ),
    ]);
    const conflicts = yield* loadConflicts(input.eventId, agendaTalks);
    yield* rejectConflicts(conflicts);
    const trackNames = new Map(trackRows.map(({ id, name }) => [id, name] as const));
    const roomNames = new Map(roomRows.map(({ id, name }) => [id, name] as const));
    const visibleSpeakerNames = new Map<string, string[]>();
    for (const row of visibleSpeakerRows) {
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
    const publicTalks: PublicAgendaTalk[] = confirmedTalks.map((talk) => ({
      id: talk.id,
      title: talk.title,
      description: talk.description,
      track: talk.trackId === null ? null : trackNames.get(talk.trackId) ?? null,
      room: talk.roomId === null ? null : roomNames.get(talk.roomId) ?? null,
      startsAt: talk.startsAt,
      durationMin: talk.durationMin,
      speakerNames: visibleSpeakerNames.get(talk.id) ?? [],
    }));
    const revision = currentRevision + 1;
    const published = yield* decodePublishedAgenda({
      eventId: event.id,
      eventName: event.name,
      eventSlug: event.slug,
      timezone: event.timezone,
      location: event.location,
      revision,
      publishedAt: prepared.now.getTime(),
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
    if (interlock) {
      yield* interlock({
        eventId: input.eventId,
        expectedWorkspaceVersion: input.expectedWorkspaceVersion,
        nextRevision: published.revision,
        expectedEventVersion: input.expectedEventVersion,
      });
    }
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
        metadata: { idempotencyKeyHash: prepared.keyHash, talkCount: published.talks.length },
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
    const published = yield* latestPublication(eventId);
    if (!published) return yield* Effect.fail(new NotFound({ entity: "published agenda", id: eventId }));
    return published;
  });
