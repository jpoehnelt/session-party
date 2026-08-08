import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { ServerMessage } from "contracts/protocol";
import {
  acceptanceEvents,
  auditLog,
  domainChanges,
  events,
  formVersions,
  forms,
  idempotencyRecords,
  rooms,
  speakerProvisioning,
  speakers,
  submissionSpeakers,
  submissions,
  talkSpeakers,
  talks,
  tracks,
  users,
} from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, CurrentUser, Rooms, type CurrentUserValue } from "@/server/services";
import { agendaFixtures, FIXED_DAY_START, FIXED_NOW } from "./fixtures";
import { operations, partyDescriptors } from "./operations";
import { zonedTimestamp } from "./routes/agenda";
import {
  cancelTalk,
  createTalk,
  getPublishedAgenda,
  listAgenda,
  moveTalk,
  publishAgenda,
  scheduleTalk,
  type AgendaMutationInterlock,
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

const runAs = <A, E>(principal: CurrentUserValue, effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runEither = <A, E>(principal: CurrentUserValue, effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runAsRecording = <A, E>(
  principal: CurrentUserValue,
  effect: Effect.Effect<A, E, never>,
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
  effect: Effect.Effect<A, E, never>,
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
  const userId = id("owner");
  const formId = id("form");
  const formVersionId = id("form-v1");
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

  const statements = [
    db.insert(users).values({
      id: userId,
      email: `${userId}@example.com`,
      name: "Agenda Owner",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(events).values({
      id: eventId,
      slug: id("slug"),
      name: `Conference ${name}`,
      location: "Pier 27",
      timezone: "America/Los_Angeles",
      startsAt: new Date(FIXED_DAY_START),
      endsAt: new Date(FIXED_DAY_START + 2 * 86_400_000),
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
  });

  it("rejects DST gaps and chooses the earlier fall-back instant", () => {
    expect(zonedTimestamp("2026-03-08T02:30", "America/Los_Angeles")).toBeNull();
    expect(zonedTimestamp("2026-11-01T01:30", "America/Los_Angeles")).toBe(
      Date.UTC(2026, 10, 1, 8, 30),
    );
  });
});

describe("agenda service", () => {
  it("lists only accepted, provisioned proposals in the backlog", async () => {
    const seeded = await seedAgenda("backlog");
    const agenda = await runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "day" }) as never);
    expect(agenda.timezone).toBe("America/Los_Angeles");
    expect(agenda.backlog.map(({ title }) => title)).toEqual(["Durable workflows", "Effects at scale"]);
    expect(agenda.talks).toEqual([]);
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
    const created = await runAs(seeded.user, createTalk(createInput) as never);
    const replayed = await runAs(seeded.user, createTalk(createInput) as never);
    expect(created.talk.status).toBe("draft");
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
    }) as never);
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
    }) as never);
    expect(moved.talk).toMatchObject({ version: 3, roomId: seeded.roomB, durationMin: 30 });

    const cancelled = await runAs(seeded.user, cancelTalk({
      eventId: seeded.eventId,
      talkId: created.talk.id,
      expectedVersion: moved.talk.version,
      idempotencyKey: "lifecycle-cancel-0001",
    }) as never);
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
    }) as never);
    const roomResult = await runEither(roomSeed.user, scheduleTalk({
      eventId: roomSeed.eventId,
      talkId: roomTalk.talk.id,
      trackId: roomSeed.trackId,
      roomId: roomSeed.roomA,
      startsAt: FIXED_DAY_START + 15 * 60_000,
      durationMin: 30,
      expectedVersion: roomTalk.talk.version,
      idempotencyKey: "room-conflict-schedule-0001",
    }) as never);
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
    }) as never);
    const speakerResult = await runEither(speakerSeed.user, scheduleTalk({
      eventId: speakerSeed.eventId,
      talkId: speakerTalk.talk.id,
      trackId: speakerSeed.trackId,
      roomId: speakerSeed.roomB,
      startsAt: FIXED_DAY_START + 15 * 60_000,
      durationMin: 30,
      expectedVersion: speakerTalk.talk.version,
      idempotencyKey: "speaker-conflict-schedule-0001",
    }) as never);
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
    }) as never);
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
      }, createBarrier.interlock) as never,
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
        }) as never,
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
      }, moveBarrier.interlock) as never,
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
        }) as never,
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

    const outcomes = await Promise.allSettled([
      runAs(seeded.user, first as never),
      runAs(seeded.user, second as never),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: { _tag: "Conflict" } });

    const stored = await seeded.db.select().from(talks).where(eq(talks.eventId, seeded.eventId));
    expect(stored.reduce((total, talk) => total + talk.version, 0)).toBe(4);
    await expect(seeded.db.select().from(domainChanges).where(eq(domainChanges.eventId, seeded.eventId))).resolves.toHaveLength(1);
    await expect(seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId))).resolves.toHaveLength(1);
    await expect(seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId))).resolves.toHaveLength(1);
  });

  it("keeps confirmed talks private until publishing an immutable revision", async () => {
    const seeded = await seedAgenda("publication", { scheduled: true });
    const before = await runEither(seeded.user, getPublishedAgenda({ eventId: seeded.eventId }) as never);
    expect(before._tag).toBe("Left");
    if (before._tag === "Left") expect(before.left).toMatchObject({ _tag: "NotFound" });

    const published = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      idempotencyKey: "publish-revision-0001",
    }) as never);
    expect(published).toMatchObject({ revision: 1, timezone: "America/Los_Angeles" });
    expect(published.talks).toHaveLength(1);
    expect(published.talks[0]).not.toHaveProperty("version");
    expect(published.talks[0]).not.toHaveProperty("submissionId");
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
    }) as never);
    const stillPublished = await runAs(seeded.user, getPublishedAgenda({ eventId: seeded.eventId }) as never);
    expect(stillPublished.revision).toBe(1);
    expect(stillPublished.talks[0]?.startsAt).toBe(FIXED_DAY_START);
  });
});
