import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal as CurrentUserValue } from "contracts/principal";
import type { ServerMessage } from "contracts/protocol";
import {
  acceptanceEvents,
  auditLog,
  domainChanges,
  events,
  eventMembers,
  formVersionFields,
  formVersions,
  forms,
  idempotencyRecords,
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
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, Authorizer, CurrentUser, Db, Rooms } from "@/server/services";
import { updateEvent } from "@/features/events/service";
import { agendaFixtures, FIXED_DAY_START, FIXED_NOW } from "./fixtures";
import {
  createRoomOperation,
  createTrackOperation,
  getPublishedAgendaOperation,
  operations,
  partyDescriptors,
  updateRoomOperation,
  updateTrackOperation,
} from "./operations";
import type { AgendaMutationResult } from "./schema";
import {
  cancelTalk,
  createRoom,
  createTalk,
  createTrack,
  getAgendaDeliveryProjection,
  getPublishedAgenda,
  listAgenda,
  moveTalk,
  publishAgenda,
  scheduleTalk,
  updateRoom,
  updateTrack,
  type AgendaMutationInterlock,
  type AgendaSnapshotInterlock,
  type AgendaPublicationInterlock,
} from "./service";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const hasMigrations = (value: Cloudflare.Env): value is TestEnv => "TEST_MIGRATIONS" in value;

const owner = (userId: string): CurrentUserValue => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name: "Agenda Owner",
  sessionId: `session-${userId}`,
  expiresAt: FIXED_NOW + 86_400_000,
});

const runAs = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, Db | CurrentUser | Rooms>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runEventAs = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, Db | CurrentUser | Authorizer>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runSetupAs = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, Authorizer | CurrentUser | Db>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runSetupEither = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, Authorizer | CurrentUser | Db>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runEither = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, Db | CurrentUser | Rooms>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runAsRecording = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, Db | CurrentUser | Rooms>,
  broadcasts: ServerMessage[],
) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.succeed(Rooms, {
      broadcast: (_eventId, message) => Effect.sync(() => { broadcasts.push(message); }),
    })),
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runEitherRecording = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, Db | CurrentUser | Rooms>,
  broadcasts: ServerMessage[],
) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.succeed(Rooms, {
      broadcast: (_eventId, message) => Effect.sync(() => { broadcasts.push(message); }),
    })),
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const reservationBarrier = () => {
  let announceSampled!: () => void;
  let release!: () => void;
  const sampled = new Promise<void>((resolve) => { announceSampled = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const interlock: AgendaMutationInterlock = () =>
    Effect.promise(async () => {
      announceSampled();
      await released;
    });
  return { interlock, release, sampled };
};

const snapshotBarrier = () => {
  let blocked = false;
  let announceSampled!: () => void;
  let release!: () => void;
  const sampled = new Promise<void>((resolve) => { announceSampled = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const interlock: AgendaSnapshotInterlock = () => {
    if (blocked) return Effect.void;
    blocked = true;
    return Effect.promise(async () => {
      announceSampled();
      await released;
    });
  };
  return { interlock, release, sampled };
};

const publicationBarrier = () => {
  let announceSampled!: () => void;
  let release!: () => void;
  const sampled = new Promise<void>((resolve) => { announceSampled = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const interlock: AgendaPublicationInterlock = () =>
    Effect.promise(async () => {
      announceSampled();
      await released;
    });
  return { interlock, release, sampled };
};
interface SeedOptions {
  readonly scheduled?: boolean;
  readonly secondTalk?: boolean;
  readonly sharedSpeaker?: boolean;
}

const seedAgenda = async (name: string, options: SeedOptions = {}) => {
  const db = drizzle(env.DB);
  const id = (value: string) => `${name}-${value}`;
  const now = new Date(FIXED_NOW);
  const eventId = id("event");
  const eventSlug = id("slug");
  const userId = id("owner");
  const formId = id("form");
  const formVersionId = id("form-v1");
  const abstractFieldId = id("field-abstract");
  const submissionA = id("submission-a");
  const submissionB = id("submission-b");
  const speakerA = id("speaker-a");
  const speakerB = id("speaker-b");
  const acceptanceA = id("acceptance-a");
  const acceptanceB = id("acceptance-b");
  const trackId = id("track");
  const roomA = id("room-a");
  const roomB = id("room-b");
  const talkA = id("talk-a");
  const talkB = id("talk-b");

  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(users).values({
      id: userId,
      email: `${userId}@example.com`,
      name: "Agenda Owner",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(events).values({
      id: eventId,
      slug: eventSlug,
      name: `Conference ${name}`,
      location: "Pier 27",
      timezone: "America/Los_Angeles",
      startsAt: new Date(FIXED_DAY_START),
      endsAt: new Date(FIXED_DAY_START + 2 * 86_400_000),
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(eventMembers).values({
      id: id("member-owner"),
      eventId,
      userId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(forms).values({
      id: formId,
      eventId,
      kind: "cfp",
      name: "Call for proposals",
      status: "closed",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(formVersions).values({
      id: formVersionId,
      eventId,
      formId,
      versionNumber: 1,
      name: "Call for proposals",
      publishedAt: new Date(FIXED_NOW - 86_400_000),
      createdAt: new Date(FIXED_NOW - 86_400_000),
    }),
    db.insert(formVersionFields).values({
      id: abstractFieldId,
      eventId,
      formVersionId,
      order: 1,
      type: "textarea",
      label: "Proposal summary",
      semanticKey: "submissionAbstract",
      required: true,
      createdAt: now,
    }),
    db.insert(submissions).values([
      {
        id: submissionA,
        eventId,
        formId,
        formVersionId,
        title: "Effects at scale",
        category: "Systems",
        status: "accepted",
        submittedAt: new Date(FIXED_NOW - 3 * 86_400_000),
        acceptedAt: new Date(FIXED_NOW - 2 * 86_400_000),
        version: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: submissionB,
        eventId,
        formId,
        formVersionId,
        title: "Durable workflows",
        category: "Practice",
        status: "accepted",
        submittedAt: new Date(FIXED_NOW - 3 * 86_400_000),
        acceptedAt: new Date(FIXED_NOW - 2 * 86_400_000),
        version: 2,
        createdAt: now,
        updatedAt: now,
      },
    ]),
    db.insert(submissionAnswers).values([
      {
        id: id("answer-abstract-a"),
        eventId,
        submissionId: submissionA,
        formVersionId,
        formVersionFieldId: abstractFieldId,
        value: "A practical guide to reliable Effect programs at organizational scale.",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: id("answer-abstract-b"),
        eventId,
        submissionId: submissionB,
        formVersionId,
        formVersionFieldId: abstractFieldId,
        value: "How durable workflows preserve progress through retries and restarts.",
        createdAt: now,
        updatedAt: now,
      },
    ]),
    db.insert(speakers).values([
      {
        id: speakerA,
        eventId,
        displayName: "Ada Rivera",
        visible: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: speakerB,
        eventId,
        displayName: "Lin Okafor",
        visible: true,
        createdAt: now,
        updatedAt: now,
      },
    ]),
    db.insert(submissionSpeakers).values([
      {
        id: id("submission-speaker-a"),
        eventId,
        submissionId: submissionA,
        speakerId: speakerA,
        isPrimary: true,
        createdAt: now,
      },
      {
        id: id("submission-speaker-b"),
        eventId,
        submissionId: submissionB,
        speakerId: options.sharedSpeaker ? speakerA : speakerB,
        isPrimary: true,
        createdAt: now,
      },
    ]),
    db.insert(acceptanceEvents).values([
      {
        id: acceptanceA,
        eventId,
        submissionId: submissionA,
        primarySubmissionSpeakerId: id("submission-speaker-a"),
        primarySpeakerId: speakerA,
        type: "accepted",
        submissionVersion: 2,
        actorUserId: userId,
        occurredAt: new Date(FIXED_NOW - 2 * 86_400_000),
      },
      {
        id: acceptanceB,
        eventId,
        submissionId: submissionB,
        primarySubmissionSpeakerId: id("submission-speaker-b"),
        primarySpeakerId: options.sharedSpeaker ? speakerA : speakerB,
        type: "accepted",
        submissionVersion: 2,
        actorUserId: userId,
        occurredAt: new Date(FIXED_NOW - 2 * 86_400_000),
      },
    ]),
    db.insert(speakerProvisioning).values([
      {
        id: id("provisioning-a"),
        eventId,
        acceptanceEventId: acceptanceA,
        submissionId: submissionA,
        primarySpeakerId: speakerA,
        status: "provisioned",
        availableAt: now,
        provisionedAt: new Date(FIXED_NOW - 86_400_000),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: id("provisioning-b"),
        eventId,
        acceptanceEventId: acceptanceB,
        submissionId: submissionB,
        primarySpeakerId: options.sharedSpeaker ? speakerA : speakerB,
        status: "provisioned",
        availableAt: now,
        provisionedAt: new Date(FIXED_NOW - 86_400_000),
        createdAt: now,
        updatedAt: now,
      },
    ]),
    db.insert(tracks).values({
      id: trackId,
      eventId,
      name: "Systems",
      color: "#2563EB",
      order: 0,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(rooms).values([
      { id: roomA, eventId, name: "Harbor", capacity: 180, order: 0, createdAt: now, updatedAt: now },
      { id: roomB, eventId, name: "Summit", capacity: 90, order: 1, createdAt: now, updatedAt: now },
    ]),
  ];

  if (options.scheduled) {
    statements.push(
      db.insert(talks).values({
        id: talkA,
        eventId,
        submissionId: submissionA,
        title: "Effects at scale",
        trackId,
        roomId: roomA,
        startsAt: new Date(FIXED_DAY_START),
        durationMin: 45,
        status: "confirmed",
        version: 2,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(talkSpeakers).values({
        id: id("talk-speaker-a"),
        eventId,
        talkId: talkA,
        speakerId: speakerA,
        createdAt: now,
      }),
    );
  }
  if (options.secondTalk) {
    statements.push(
      db.insert(talks).values({
        id: talkB,
        eventId,
        submissionId: submissionB,
        title: "Durable workflows",
        trackId,
        roomId: roomB,
        startsAt: new Date(FIXED_DAY_START + 3_600_000),
        durationMin: 45,
        status: "confirmed",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(talkSpeakers).values({
        id: id("talk-speaker-b"),
        eventId,
        talkId: talkB,
        speakerId: options.sharedSpeaker ? speakerA : speakerB,
        createdAt: now,
      }),
    );
  }

  await db.batch(statements);
  return {
    db,
    eventId,
    eventSlug,
    user: owner(userId),
    submissionA,
    submissionB,
    speakerA,
    speakerB,
    trackId,
    roomA,
    roomB,
    talkA,
    talkB,
  };
};

beforeAll(async () => {
  if (!hasMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
});

describe("agenda deterministic fixtures and descriptors", () => {
  it("covers every required deterministic scenario", () => {
    expect(agendaFixtures.map(({ name }) => name)).toEqual([
      "empty",
      "backlog",
      "scheduled",
      "speaker-conflict",
      "room-conflict",
      "stale-move",
      "published-revision",
    ]);
  });

  it("exports bytewise-stable operations and Party descriptors", () => {
    const operationIds = operations.map(({ id }) => id);
    expect(operationIds).toEqual([...operationIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    expect(partyDescriptors.map(({ intentType }) => intentType)).toEqual(["agenda/move"]);
    expect(operations.every(({ id }) => id.startsWith("agenda."))).toBe(true);
    expect(operations.some((operation) => "party" in operation)).toBe(false);
    expect(partyDescriptors[0].inputSchema.required).toContain("requestId");
    expect(partyDescriptors[0].inputSchema.required).not.toContain("eventId");
    expect(getPublishedAgendaOperation).toMatchObject({
      authorize: { kind: "public" },
      rest: {
        method: "get",
        path: "/public/events/:eventSlug/agenda/published",
        input: { path: ["eventSlug"] },
      },
    });
    expect("mcp" in getPublishedAgendaOperation).toBe(false);
    for (const operation of [
      createRoomOperation,
      createTrackOperation,
      updateRoomOperation,
      updateTrackOperation,
    ]) {
      expect("mcp" in operation).toBe(false);
      expect(operation.authorize).toEqual({
        kind: "event",
        eventId: "eventId",
        browser: { kind: "event-member", roles: ["owner", "admin"] },
        apiKey: { kind: "api-key", scopes: ["agenda:write"] },
      });
      expect(operation.idempotency).toBe("required");
    }
    expect(createTrackOperation.rest).toMatchObject({ method: "post", path: "/events/:eventId/agenda/tracks" });
    expect(updateTrackOperation.rest).toMatchObject({ method: "patch", path: "/events/:eventId/agenda/tracks/:trackId" });
    expect(createRoomOperation.rest).toMatchObject({ method: "post", path: "/events/:eventId/agenda/rooms" });
    expect(updateRoomOperation.rest).toMatchObject({ method: "patch", path: "/events/:eventId/agenda/rooms/:roomId" });
    expect(updateTrackOperation.concurrency).toBe("required");
    expect(updateRoomOperation.concurrency).toBe("required");
  });


});

describe("agenda service", () => {
  it("creates and updates tracks and rooms idempotently with stable ordering", async () => {
    const seeded = await seedAgenda("setup-crud");
    const trackInput = {
      eventId: seeded.eventId,
      name: "  Applied   AI ",
      color: "#14B8A6",
      order: 0,
      idempotencyKey: "setup-track-create-0001",
    } as const;
    const createdTrack = await runSetupAs(seeded.user, createTrack(trackInput));
    expect(createdTrack).toMatchObject({
      replayed: false,
      track: { name: "Applied AI", color: "#14B8A6", order: 0, version: 1 },
    });
    const replayedTrack = await runSetupAs(seeded.user, createTrack(trackInput));
    expect(replayedTrack).toMatchObject({
      replayed: true,
      changeId: createdTrack.changeId,
      track: { id: createdTrack.track.id },
    });

    const createdRoom = await runSetupAs(seeded.user, createRoom({
      eventId: seeded.eventId,
      name: "Atrium",
      capacity: 240,
      order: 0,
      idempotencyKey: "setup-room-create-0001",
    }));
    expect(createdRoom).toMatchObject({
      replayed: false,
      room: { name: "Atrium", capacity: 240, order: 0, version: 1 },
    });

    const updatedTrack = await runSetupAs(seeded.user, updateTrack({
      eventId: seeded.eventId,
      trackId: createdTrack.track.id,
      name: "Applied AI and Agents",
      color: null,
      order: 2,
      expectedVersion: 1,
      idempotencyKey: "setup-track-update-0001",
    }));
    expect(updatedTrack.track).toMatchObject({
      id: createdTrack.track.id,
      name: "Applied AI and Agents",
      color: null,
      order: 2,
      version: 2,
    });

    const updatedRoom = await runSetupAs(seeded.user, updateRoom({
      eventId: seeded.eventId,
      roomId: createdRoom.room.id,
      name: "Grand Atrium",
      capacity: null,
      order: 0,
      expectedVersion: 1,
      idempotencyKey: "setup-room-update-0001",
    }));
    expect(updatedRoom.room).toMatchObject({
      id: createdRoom.room.id,
      name: "Grand Atrium",
      capacity: null,
      order: 0,
      version: 2,
    });

    const snapshot = await runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "room" }));
    expect(snapshot.workspaceVersion).toBe(4);
    expect(snapshot.tracks.map(({ name }) => name)).toEqual(["Systems", "Applied AI and Agents"]);
    expect(snapshot.rooms.map(({ name }) => name)).toEqual(["Grand Atrium", "Harbor", "Summit"]);
    expect(snapshot.tracks.find(({ id }) => id === createdTrack.track.id)?.version).toBe(2);
    expect(snapshot.rooms.find(({ id }) => id === createdRoom.room.id)?.version).toBe(2);

    const evidence = await seeded.db.select().from(auditLog).where(and(
      eq(auditLog.eventId, seeded.eventId),
      eq(auditLog.resourceId, createdTrack.track.id),
    ));
    expect(evidence.map(({ action }) => action)).toEqual(["agenda.track_created", "agenda.track_updated"]);
  });

  it("rejects stale, duplicate, unauthorized, and cross-event setup mutations", async () => {
    const seeded = await seedAgenda("setup-guards");
    const other = await seedAgenda("setup-other");

    const duplicate = await runSetupEither(seeded.user, createTrack({
      eventId: seeded.eventId,
      name: " systems ",
      color: null,
      order: 4,
      idempotencyKey: "setup-track-duplicate-0001",
    }));
    expect(duplicate._tag).toBe("Left");
    if (duplicate._tag === "Left") expect(duplicate.left).toMatchObject({ _tag: "Conflict" });

    const stale = await runSetupEither(seeded.user, updateRoom({
      eventId: seeded.eventId,
      roomId: seeded.roomA,
      name: "Harbor Hall",
      capacity: 200,
      order: 0,
      expectedVersion: 2,
      idempotencyKey: "setup-room-stale-0001",
    }));
    expect(stale._tag).toBe("Left");
    if (stale._tag === "Left") expect(stale.left).toMatchObject({ _tag: "Conflict" });

    const unauthorized = await runSetupEither(owner("agenda-setup-outsider"), createRoom({
      eventId: seeded.eventId,
      name: "Unauthorized room",
      capacity: null,
      order: 0,
      idempotencyKey: "setup-room-unauthorized-0001",
    }));
    expect(unauthorized._tag).toBe("Left");
    if (unauthorized._tag === "Left") expect(unauthorized.left).toMatchObject({ _tag: "Forbidden" });

    const crossEvent = await runSetupEither(other.user, updateTrack({
      eventId: other.eventId,
      trackId: seeded.trackId,
      name: "Cross tenant",
      color: null,
      order: 0,
      expectedVersion: 1,
      idempotencyKey: "setup-track-cross-event-0001",
    }));
    expect(crossEvent._tag).toBe("Left");
    if (crossEvent._tag === "Left") expect(crossEvent.left).toMatchObject({ _tag: "NotFound" });

    const unauthorizedRows = await seeded.db.select().from(rooms).where(and(
      eq(rooms.eventId, seeded.eventId),
      eq(rooms.name, "Unauthorized room"),
    ));
    expect(unauthorizedRows).toEqual([]);
  });

  it("lists only accepted, provisioned proposals in the backlog", async () => {
    const seeded = await seedAgenda("backlog");
    const agenda = await runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "day" }));
    expect(agenda.workspaceVersion).toBe(0);
    expect(agenda.eventVersion).toBe(1);
    expect(agenda.timezone).toBe("America/Los_Angeles");
    expect(agenda.backlog.map(({ title }) => title)).toEqual(["Durable workflows", "Effects at scale"]);
    expect(agenda.talks).toEqual([]);
  });

  it("retries when a mutation lands between projection and version reads", async () => {
    const seeded = await seedAgenda("snapshot-race", { scheduled: true });
    const barrier = snapshotBarrier();
    const pendingSnapshot = runAs(
      seeded.user,
      listAgenda({ eventId: seeded.eventId, view: "day" }, barrier.interlock),
    );
    await barrier.sampled;
    try {
      await runAs(seeded.user, moveTalk({
        eventId: seeded.eventId,
        talkId: seeded.talkA,
        trackId: seeded.trackId,
        roomId: seeded.roomB,
        startsAt: FIXED_DAY_START + 7_200_000,
        durationMin: 30,
        expectedVersion: 2,
        idempotencyKey: "snapshot-race-move-0001",
      }));
    } finally {
      barrier.release();
    }

    const snapshot = await pendingSnapshot;
    expect(snapshot.workspaceVersion).toBe(1);
    expect(snapshot.talks).toEqual([
      expect.objectContaining({
        id: seeded.talkA,
        roomId: seeded.roomB,
        startsAt: FIXED_DAY_START + 7_200_000,
        version: 3,
      }),
    ]);
  });

  it("creates, schedules, moves, replays idempotently, and cancels a talk with evidence", async () => {
    const seeded = await seedAgenda("lifecycle");
    const createInput = {
      eventId: seeded.eventId,
      submissionId: seeded.submissionA,
      trackId: null,
      roomId: null,
      startsAt: null,
      durationMin: 30,
      idempotencyKey: "lifecycle-create-0001",
    } as const;
    const created = await runAs(seeded.user, createTalk(createInput));
    const replayed = await runAs(seeded.user, createTalk(createInput));
    expect(created.talk.status).toBe("draft");
    expect(created.talk.description).toBe(
      "A practical guide to reliable Effect programs at organizational scale.",
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.changeId).toBe(created.changeId);

    const scheduled = await runAs(seeded.user, scheduleTalk({
      eventId: seeded.eventId,
      talkId: created.talk.id,
      trackId: seeded.trackId,
      roomId: seeded.roomA,
      startsAt: FIXED_DAY_START,
      durationMin: 45,
      expectedVersion: created.talk.version,
      idempotencyKey: "lifecycle-schedule-0001",
    }));
    expect(scheduled.talk).toMatchObject({ status: "confirmed", version: 2, roomId: seeded.roomA });

    const moved = await runAs(seeded.user, moveTalk({
      eventId: seeded.eventId,
      talkId: created.talk.id,
      trackId: seeded.trackId,
      roomId: seeded.roomB,
      startsAt: FIXED_DAY_START + 3_600_000,
      durationMin: 30,
      expectedVersion: scheduled.talk.version,
      idempotencyKey: "lifecycle-move-0001",
    }));
    expect(moved.talk).toMatchObject({ version: 3, roomId: seeded.roomB, durationMin: 30 });

    const cancelled = await runAs(seeded.user, cancelTalk({
      eventId: seeded.eventId,
      talkId: created.talk.id,
      expectedVersion: moved.talk.version,
      idempotencyKey: "lifecycle-cancel-0001",
    }));
    expect(cancelled.talk).toMatchObject({ status: "cancelled", version: 4 });

    const [idempotency, changes, audits] = await Promise.all([
      seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId)),
      seeded.db.select().from(domainChanges).where(eq(domainChanges.eventId, seeded.eventId)),
      seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId)),
    ]);
    expect(idempotency).toHaveLength(4);
    expect(changes).toHaveLength(4);
    expect(audits).toHaveLength(4);
  });

  it("rejects room and speaker overlaps server-side", async () => {
    const roomSeed = await seedAgenda("room-conflict", { scheduled: true });
    const roomTalk = await runAs(roomSeed.user, createTalk({
      eventId: roomSeed.eventId,
      submissionId: roomSeed.submissionB,
      trackId: null,
      roomId: null,
      startsAt: null,
      durationMin: 30,
      idempotencyKey: "room-conflict-create-0001",
    }));
    const roomResult = await runEither(roomSeed.user, scheduleTalk({
      eventId: roomSeed.eventId,
      talkId: roomTalk.talk.id,
      trackId: roomSeed.trackId,
      roomId: roomSeed.roomA,
      startsAt: FIXED_DAY_START + 15 * 60_000,
      durationMin: 30,
      expectedVersion: roomTalk.talk.version,
      idempotencyKey: "room-conflict-schedule-0001",
    }));
    expect(roomResult._tag).toBe("Left");
    if (roomResult._tag === "Left") {
      expect(roomResult.left).toMatchObject({ _tag: "Conflict" });
      expect(roomResult.left.message).toContain("Harbor");
    }

    const speakerSeed = await seedAgenda("speaker-conflict", { scheduled: true, sharedSpeaker: true });
    const speakerTalk = await runAs(speakerSeed.user, createTalk({
      eventId: speakerSeed.eventId,
      submissionId: speakerSeed.submissionB,
      trackId: null,
      roomId: null,
      startsAt: null,
      durationMin: 30,
      idempotencyKey: "speaker-conflict-create-0001",
    }));
    const speakerResult = await runEither(speakerSeed.user, scheduleTalk({
      eventId: speakerSeed.eventId,
      talkId: speakerTalk.talk.id,
      trackId: speakerSeed.trackId,
      roomId: speakerSeed.roomB,
      startsAt: FIXED_DAY_START + 15 * 60_000,
      durationMin: 30,
      expectedVersion: speakerTalk.talk.version,
      idempotencyKey: "speaker-conflict-schedule-0001",
    }));
    expect(speakerResult._tag).toBe("Left");
    if (speakerResult._tag === "Left") {
      expect(speakerResult.left).toMatchObject({ _tag: "Conflict" });
      expect(speakerResult.left.message).toContain("Ada Rivera");
    }
  });

  it("rejects stale moves without writing state or evidence", async () => {
    const seeded = await seedAgenda("stale", { scheduled: true });
    const result = await runEither(seeded.user, moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      trackId: seeded.trackId,
      roomId: seeded.roomB,
      startsAt: FIXED_DAY_START + 3_600_000,
      durationMin: 30,
      expectedVersion: 1,
      idempotencyKey: "stale-move-0001",
    }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({ _tag: "Conflict" });
    const [stored] = await seeded.db.select().from(talks).where(and(eq(talks.eventId, seeded.eventId), eq(talks.id, seeded.talkA)));
    expect(stored).toMatchObject({ version: 2, roomId: seeded.roomA });
    await expect(seeded.db.select().from(domainChanges).where(eq(domainChanges.eventId, seeded.eventId))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId))).resolves.toHaveLength(0);
  });

  it("rejects stale create and move plans after deterministic interleaving", async () => {
    const createSeed = await seedAgenda("stale-create");
    const createBroadcasts: ServerMessage[] = [];
    const createBarrier = reservationBarrier();
    const staleCreate = runEitherRecording(
      createSeed.user,
      createTalk({
        eventId: createSeed.eventId,
        submissionId: createSeed.submissionA,
        trackId: null,
        roomId: null,
        startsAt: null,
        durationMin: 30,
        idempotencyKey: "stale-create-loser-0001",
      }, createBarrier.interlock),
      createBroadcasts,
    );
    await createBarrier.sampled;
    try {
      await runAsRecording(
        createSeed.user,
        createTalk({
          eventId: createSeed.eventId,
          submissionId: createSeed.submissionA,
          trackId: null,
          roomId: null,
          startsAt: null,
          durationMin: 30,
          idempotencyKey: "stale-create-winner-0001",
        }),
        createBroadcasts,
      );
    } finally {
      createBarrier.release();
    }
    const staleCreateResult = await staleCreate;
    expect(staleCreateResult._tag).toBe("Left");
    if (staleCreateResult._tag === "Left") {
      expect(staleCreateResult.left).toMatchObject({ _tag: "Conflict" });
    }
    await expect(createSeed.db.select().from(talks).where(eq(talks.eventId, createSeed.eventId))).resolves.toHaveLength(1);
    await expect(createSeed.db.select().from(domainChanges).where(eq(domainChanges.eventId, createSeed.eventId))).resolves.toHaveLength(1);
    await expect(createSeed.db.select().from(auditLog).where(eq(auditLog.eventId, createSeed.eventId))).resolves.toHaveLength(1);
    await expect(createSeed.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, createSeed.eventId))).resolves.toHaveLength(1);
    expect(createBroadcasts).toHaveLength(1);

    const moveSeed = await seedAgenda("stale-interleaved-move", { scheduled: true });
    const moveBroadcasts: ServerMessage[] = [];
    const moveBarrier = reservationBarrier();
    const staleMove = runEitherRecording(
      moveSeed.user,
      moveTalk({
        eventId: moveSeed.eventId,
        talkId: moveSeed.talkA,
        trackId: moveSeed.trackId,
        roomId: moveSeed.roomB,
        startsAt: FIXED_DAY_START + 7_200_000,
        durationMin: 30,
        expectedVersion: 2,
        idempotencyKey: "stale-interleaved-move-loser-0001",
      }, moveBarrier.interlock),
      moveBroadcasts,
    );
    await moveBarrier.sampled;
    try {
      await runAsRecording(
        moveSeed.user,
        moveTalk({
          eventId: moveSeed.eventId,
          talkId: moveSeed.talkA,
          trackId: moveSeed.trackId,
          roomId: moveSeed.roomB,
          startsAt: FIXED_DAY_START + 3_600_000,
          durationMin: 30,
          expectedVersion: 2,
          idempotencyKey: "stale-interleaved-move-winner-0001",
        }),
        moveBroadcasts,
      );
    } finally {
      moveBarrier.release();
    }
    const staleMoveResult = await staleMove;
    expect(staleMoveResult._tag).toBe("Left");
    if (staleMoveResult._tag === "Left") {
      expect(staleMoveResult.left).toMatchObject({ _tag: "Conflict" });
    }
    const [moved] = await moveSeed.db.select().from(talks).where(and(
      eq(talks.eventId, moveSeed.eventId),
      eq(talks.id, moveSeed.talkA),
    ));
    expect(moved).toMatchObject({ version: 3, roomId: moveSeed.roomB });
    await expect(moveSeed.db.select().from(domainChanges).where(eq(domainChanges.eventId, moveSeed.eventId))).resolves.toHaveLength(1);
    await expect(moveSeed.db.select().from(auditLog).where(eq(auditLog.eventId, moveSeed.eventId))).resolves.toHaveLength(1);
    await expect(moveSeed.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, moveSeed.eventId))).resolves.toHaveLength(1);
    expect(moveBroadcasts).toHaveLength(1);
  });

  it("allows exactly one winner when different talks contend for one schedule revision", async () => {
    const seeded = await seedAgenda("contention", { scheduled: true, secondTalk: true });
    const first = moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      trackId: seeded.trackId,
      roomId: seeded.roomA,
      startsAt: FIXED_DAY_START + 10_800_000,
      durationMin: 30,
      expectedVersion: 2,
      idempotencyKey: "contention-move-first-0001",
    });
    const second = moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkB,
      trackId: seeded.trackId,
      roomId: seeded.roomA,
      startsAt: FIXED_DAY_START + 10_800_000,
      durationMin: 30,
      expectedVersion: 1,
      idempotencyKey: "contention-move-second-0001",
    });

    const outcomes = await Promise.all([
      runEither(seeded.user, first),
      runEither(seeded.user, second),
    ]);
    expect(outcomes.map(({ _tag }) => _tag).sort()).toEqual(["Left", "Right"]);
    const rejected = outcomes.find((outcome) => outcome._tag === "Left");
    expect(rejected).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });

    const stored = await seeded.db.select().from(talks).where(eq(talks.eventId, seeded.eventId));
    expect(stored.reduce((total, talk) => total + talk.version, 0)).toBe(4);
    await expect(seeded.db.select().from(domainChanges).where(eq(domainChanges.eventId, seeded.eventId))).resolves.toHaveLength(1);
    await expect(seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId))).resolves.toHaveLength(1);
    await expect(seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId))).resolves.toHaveLength(1);
  }, 15_000);

  it("returns NotFound for an unknown canonical event slug", async () => {
    const result = await runEither(
      owner("missing-agenda-owner"),
      getPublishedAgenda({ eventSlug: "missing-event" }),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "NotFound", entity: "event", id: "missing-event" },
    });
  });

  it("keeps confirmed talks private until publishing an immutable revision", async () => {
    const seeded = await seedAgenda("publication", { scheduled: true });
    const before = await runEither(
      seeded.user,
      getPublishedAgenda({ eventSlug: seeded.eventSlug }),
    );
    expect(before).toMatchObject({
      _tag: "Left",
      left: { _tag: "NotFound", entity: "published agenda", id: seeded.eventId },
    });

    const published = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-revision-0001",
    }));
    expect(published).toMatchObject({ revision: 1, timezone: "America/Los_Angeles" });
    expect(published.talks).toHaveLength(1);
    expect(published.talks[0]).not.toHaveProperty("version");
    expect(published.talks[0]).not.toHaveProperty("submissionId");
    expect(published.talks[0]).not.toHaveProperty("speakerIds");
    const lookedUp = await runAs(
      seeded.user,
      getPublishedAgenda({ eventSlug: seeded.eventSlug }),
    );
    expect(lookedUp).toEqual(published);
    expect(lookedUp.eventId).toBe(seeded.eventId);
    const [publicationChange] = await seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ));
    expect(publicationChange).toMatchObject({
      aggregateId: seeded.eventId,
      aggregateVersion: 1,
      eventType: "agenda/published",
      payload: published,
    });
    await expect(seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId))).resolves.toHaveLength(1);
    await expect(seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId))).resolves.toHaveLength(1);

    await runAs(seeded.user, moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      trackId: seeded.trackId,
      roomId: seeded.roomB,
      startsAt: FIXED_DAY_START + 7_200_000,
      durationMin: 30,
      expectedVersion: 2,
      idempotencyKey: "post-publish-move-0001",
    }));
    const stillPublished = await runAs(
      seeded.user,
      getPublishedAgenda({ eventSlug: seeded.eventSlug }),
    );
    expect(stillPublished.revision).toBe(1);
    expect(stillPublished.talks[0]?.startsAt).toBe(FIXED_DAY_START);
  });

  it.each([
    {
      name: "missing-start",
      startsAt: null,
      endsAt: new Date(FIXED_DAY_START + 2 * 86_400_000),
      message: "Agenda publication requires an event start time",
    },
    {
      name: "missing-end",
      startsAt: new Date(FIXED_DAY_START),
      endsAt: null,
      message: "Agenda publication requires an event end time",
    },
    {
      name: "unordered",
      startsAt: new Date(FIXED_DAY_START),
      endsAt: new Date(FIXED_DAY_START),
      message: "Agenda publication requires the event end time to be after the start time",
    },
  ])("rejects publication with Validation when event bounds are $name", async ({ name, startsAt, endsAt, message }) => {
    const seeded = await seedAgenda(`publication-bounds-${name}`, { scheduled: true });
    await seeded.db
      .update(events)
      .set({ startsAt, endsAt })
      .where(eq(events.id, seeded.eventId));

    const result = await runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: `publish-bounds-${name}-0001`,
    }));

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "Validation", message },
    });
  });

  it("publishes with non-null ordered event bounds", async () => {
    const seeded = await seedAgenda("publication-valid-bounds", { scheduled: true });
    const published = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-valid-bounds-0001",
    }));

    await expect(runAs(
      seeded.user,
      getAgendaDeliveryProjection({ eventId: seeded.eventId, revision: published.revision }),
    )).resolves.toMatchObject({
      eventStartsAt: FIXED_DAY_START,
      eventEndsAt: FIXED_DAY_START + 2 * 86_400_000,
    });
  });

  it("keeps the internal delivery companion byte-for-byte immutable", async () => {
    const seeded = await seedAgenda("delivery-immutable", { scheduled: true });
    await seeded.db.batch([
      seeded.db
        .update(speakers)
        .set({ visible: false })
        .where(and(eq(speakers.eventId, seeded.eventId), eq(speakers.id, seeded.speakerB))),
      seeded.db.insert(talkSpeakers).values({
        id: "delivery-immutable-talk-speaker-hidden",
        eventId: seeded.eventId,
        talkId: seeded.talkA,
        speakerId: seeded.speakerB,
        createdAt: new Date(FIXED_NOW),
      }),
    ]);

    const published = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-delivery-immutable-0001",
    }));
    expect(published.talks[0]).toMatchObject({ speakerNames: ["Ada Rivera"] });
    expect(published.talks[0]).not.toHaveProperty("speakerIds");

    const before = await runAs(
      seeded.user,
      getAgendaDeliveryProjection({ eventId: published.eventId, revision: published.revision }),
    );
    expect(before).toEqual({
      eventId: seeded.eventId,
      revision: 1,
      eventStartsAt: FIXED_DAY_START,
      eventEndsAt: FIXED_DAY_START + 2 * 86_400_000,
      talks: [{
        talkId: seeded.talkA,
        roomId: seeded.roomA,
        startsAt: FIXED_DAY_START,
        durationMin: 45,
        speakerIds: [seeded.speakerA, seeded.speakerB],
      }],
    });

    const changes = await seeded.db
      .select()
      .from(domainChanges)
      .where(eq(domainChanges.eventId, seeded.eventId));
    const publicChange = changes.find(({ aggregateType }) => aggregateType === "agenda-publication");
    const deliveryChange = changes.find(({ aggregateType }) => aggregateType === "agenda-delivery");
    expect(changes).toHaveLength(2);
    expect(deliveryChange).toMatchObject({
      aggregateId: seeded.eventId,
      aggregateVersion: published.revision,
      eventType: "agenda/delivery-published",
      audiences: [{ kind: "admins" }],
      payload: before,
      requestId: publicChange?.requestId,
      idempotencyRecordId: publicChange?.idempotencyRecordId,
    });

    await seeded.db.batch([
      seeded.db
        .update(events)
        .set({
          startsAt: new Date(FIXED_DAY_START + 86_400_000),
          endsAt: new Date(FIXED_DAY_START + 3 * 86_400_000),
        })
        .where(eq(events.id, seeded.eventId)),
      seeded.db
        .update(talks)
        .set({
          roomId: seeded.roomB,
          startsAt: new Date(FIXED_DAY_START + 7_200_000),
          durationMin: 30,
          version: 3,
        })
        .where(and(eq(talks.eventId, seeded.eventId), eq(talks.id, seeded.talkA))),
      seeded.db
        .delete(talkSpeakers)
        .where(and(
          eq(talkSpeakers.eventId, seeded.eventId),
          eq(talkSpeakers.talkId, seeded.talkA),
          eq(talkSpeakers.speakerId, seeded.speakerA),
        )),
    ]);

    const after = await runAs(
      seeded.user,
      getAgendaDeliveryProjection({ eventId: published.eventId, revision: published.revision }),
    );
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("fails closed when the requested delivery revision is missing", async () => {
    const seeded = await seedAgenda("delivery-missing", { scheduled: true });
    await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-delivery-missing-0001",
    }));

    const result = await runEither(
      seeded.user,
      getAgendaDeliveryProjection({ eventId: seeded.eventId, revision: 2 }),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "NotFound",
        entity: "agenda delivery projection",
        id: `${seeded.eventId}:2`,
      },
    });
  });

  it("fails closed when a delivery payload revision mismatches its key", async () => {
    const seeded = await seedAgenda("delivery-mismatch", { scheduled: true });
    const published = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-delivery-mismatch-0001",
    }));
    const projection = await runAs(
      seeded.user,
      getAgendaDeliveryProjection({ eventId: published.eventId, revision: published.revision }),
    );
    await seeded.db.insert(domainChanges).values({
      id: "delivery-mismatch-corrupt-companion",
      eventId: seeded.eventId,
      aggregateType: "agenda-delivery",
      aggregateId: seeded.eventId,
      aggregateVersion: 2,
      eventType: "agenda/delivery-published",
      audiences: [{ kind: "admins" }],
      payload: projection,
      actorUserId: null,
      actorApiKeyId: null,
      requestId: "delivery-mismatch-request",
      idempotencyRecordId: null,
      occurredAt: new Date(FIXED_NOW),
    });

    const result = await runEither(
      seeded.user,
      getAgendaDeliveryProjection({ eventId: seeded.eventId, revision: 2 }),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "External", service: "agenda-delivery-projection" },
    });
  });

  it("rejects a stale publication snapshot without replacing the prior revision", async () => {
    const seeded = await seedAgenda("publication-race", { scheduled: true });
    const firstPublication = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-race-initial-0001",
    }));
    const barrier = publicationBarrier();
    const stalePublication = runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 1,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-race-stale-0001",
    }, barrier.interlock));
    await barrier.sampled;

    let moved: AgendaMutationResult | undefined;
    try {
      moved = await runAs(seeded.user, moveTalk({
        eventId: seeded.eventId,
        talkId: seeded.talkA,
        trackId: seeded.trackId,
        roomId: seeded.roomB,
        startsAt: FIXED_DAY_START + 7_200_000,
        durationMin: 30,
        expectedVersion: 2,
        idempotencyKey: "publish-race-move-0001",
      }));
    } finally {
      barrier.release();
    }
    const staleResult = await stalePublication;
    expect(moved).toMatchObject({
      talk: { roomId: seeded.roomB, startsAt: FIXED_DAY_START + 7_200_000 },
    });
    expect(staleResult).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });

    const stillPublished = await runAs(
      seeded.user,
      getPublishedAgenda({ eventSlug: seeded.eventSlug }),
    );
    expect(stillPublished).toEqual(firstPublication);
    const publicationChanges = await seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ));
    expect(publicationChanges).toHaveLength(1);
    expect(publicationChanges[0]?.payload).toEqual(firstPublication);
    await expect(seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId))).resolves.toHaveLength(2);
    await expect(seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId))).resolves.toHaveLength(2);
  });

  it("rejects publication when event metadata changes after the agenda read", async () => {
    const seeded = await seedAgenda("publication-event-race", { scheduled: true });
    const barrier = publicationBarrier();
    const stalePublication = runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-event-race-0001",
    }, barrier.interlock));
    await barrier.sampled;
    try {
      await runEventAs(
        seeded.user,
        updateEvent(seeded.eventId, {
          name: "Conference publication-event-race updated",
        }),
      );
    } finally {
      barrier.release();
    }

    const result = await stalePublication;
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    await expect(seeded.db.select().from(domainChanges).where(eq(domainChanges.eventId, seeded.eventId))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId))).resolves.toHaveLength(0);
  });
});
