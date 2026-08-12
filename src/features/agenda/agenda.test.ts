import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal as CurrentUserValue } from "contracts/principal";
import type { ServerMessage } from "contracts/protocol";
import {
  acceptanceEvents,
  airtableOutbox,
  airtablePendingEdits,
  auditLog,
  domainChanges,
  events,
  eventMembers,
  formVersionFields,
  formVersions,
  forms,
  idempotencyRecords,
  integrations,
  mailCalendarEvents,
  mailDeliveries,
  mailDeliverySnapshots,
  rooms,
  speakerProvisioning,
  speakerProfiles,
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
import { AirtableSync, AppLayer, Authorizer, CurrentUser, Db, Rooms } from "@/server/services";
import { authorizeMailDispatch } from "@/server/party/Scheduler";
import { updateEvent } from "@/features/events/service";
import { updateSpeakerProfile, updateSpeakerPublication } from "@/features/portal/service";
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
  autoPlaceTalk,
  cancelTalk,
  createRoom,
  createTalk,
  createTrack,
  getAgendaDeliveryProjection,
  getPublishedAgenda,
  listAgenda,
  listTalkContentHistory,
  moveTalk,
  publishAgenda,
  scheduleTalk,
  updateRoom,
  updateTalkContent,
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
  effect: Effect.Effect<A, E, AirtableSync | Db | CurrentUser | Rooms>,
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
  readonly linkedSpeaker?: boolean;
  readonly duplicateStableSpeaker?: "accountEmail" | "profile";
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
  const speakerUserId = id("speaker-user");
  const speakerProfileId = id("speaker-profile");
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
    ...(options.duplicateStableSpeaker ? [
      db.insert(users).values({
        id: speakerUserId,
        email: `${speakerUserId}@example.com`,
        name: "Ada Rivera",
        createdAt: now,
        updatedAt: now,
      }),
      ...(options.duplicateStableSpeaker === "profile" ? [
        db.insert(speakerProfiles).values({
          id: speakerProfileId,
          userId: speakerUserId,
          slug: id("ada-rivera"),
          displayName: "Ada Rivera",
          visible: true,
          createdAt: now,
          updatedAt: now,
        }),
      ] : []),
    ] : []),
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
        userId: options.duplicateStableSpeaker ? speakerUserId : options.linkedSpeaker ? userId : null,
        displayName: "Ada Rivera",
        visible: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: speakerB,
        eventId,
        displayName: options.duplicateStableSpeaker ? "Ada Rivera" : "Lin Okafor",
        contactEmail: options.duplicateStableSpeaker === "accountEmail" ? `${speakerUserId}@example.com` : null,
        profileSourceId: options.duplicateStableSpeaker === "profile" ? speakerProfileId : null,
        profileSourceVersion: options.duplicateStableSpeaker === "profile" ? 1 : null,
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
    formVersionId,
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

  it("prefers a configured track answer that matches an agenda track over the stored category", async () => {
    const seeded = await seedAgenda("backlog-track-answer");
    const now = new Date(FIXED_NOW);
    const trackFieldId = "backlog-track-answer-field-track";
    await seeded.db.batch([
      seeded.db.insert(formVersionFields).values({
        id: trackFieldId,
        eventId: seeded.eventId,
        formVersionId: seeded.formVersionId,
        order: 2,
        type: "radio",
        label: "Best-fit track",
        semanticKey: null,
        required: true,
        options: ["Platform & Infra"],
        routing: { "Platform & Infra": "platform-infra" },
        createdAt: now,
      }),
      seeded.db.insert(submissionAnswers).values({
        id: "backlog-track-answer-answer-track",
        eventId: seeded.eventId,
        submissionId: seeded.submissionA,
        formVersionId: seeded.formVersionId,
        formVersionFieldId: trackFieldId,
        value: " Platform & Infra ",
        createdAt: now,
        updatedAt: now,
      }),
      seeded.db.insert(tracks).values({
        id: "backlog-track-answer-track-platform-infra",
        eventId: seeded.eventId,
        name: "Platform & Infra",
        order: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    const agenda = await runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "day" }));

    expect(agenda.backlog.find(({ submissionId }) => submissionId === seeded.submissionA)?.category)
      .toBe("Platform & Infra");
    expect(agenda.backlog.find(({ submissionId }) => submissionId === seeded.submissionB)?.category)
      .toBe("Practice");
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
    const integrationId = `airtable-${seeded.eventId}`;
    const integrationNow = new Date(FIXED_NOW);
    await seeded.db.insert(integrations).values({
      id: integrationId,
      eventId: seeded.eventId,
      kind: "airtable",
      secretRef: "AIRTABLE_PAT",
      config: {},
      createdAt: integrationNow,
      updatedAt: integrationNow,
    });
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

    const [idempotency, changes, audits, outbox] = await Promise.all([
      seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId)),
      seeded.db.select().from(domainChanges).where(eq(domainChanges.eventId, seeded.eventId)),
      seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId)),
      seeded.db.select().from(airtableOutbox).where(eq(airtableOutbox.integrationId, integrationId)),
    ]);
    expect(idempotency).toHaveLength(4);
    expect(changes).toHaveLength(4);
    expect(audits).toHaveLength(4);
    expect(outbox).toHaveLength(4);
    const orderedOutbox = [...outbox].sort((left, right) => left.outboundRevision - right.outboundRevision);
    expect(orderedOutbox.map((row) => row.origin)).toEqual([
      "agenda.createTalk",
      "agenda.scheduleTalk",
      "agenda.moveTalk",
      "agenda.cancelTalk",
    ]);
    expect(orderedOutbox.at(-1)).toMatchObject({
      entityType: "talk",
      entityId: created.talk.id,
      changedFields: { status: "cancelled" },
      outboundRevision: 4,
      status: "pending",
    });
  });

  it("auto-places an unplaced talk into the first conflict-free event slot", async () => {
    const seeded = await seedAgenda("auto-place", { scheduled: true });
    const created = await runAs(seeded.user, createTalk({
      eventId: seeded.eventId,
      submissionId: seeded.submissionB,
      trackId: seeded.trackId,
      roomId: null,
      startsAt: null,
      durationMin: 30,
      idempotencyKey: "auto-place-create-0001",
    }));
    const input = {
      eventId: seeded.eventId,
      talkId: created.talk.id,
      expectedVersion: created.talk.version,
      idempotencyKey: "auto-place-talk-0001",
    } as const;
    const placed = await runAs(seeded.user, autoPlaceTalk(input));
    await runAs(seeded.user, cancelTalk({
      eventId: seeded.eventId,
      talkId: created.talk.id,
      expectedVersion: placed.talk.version,
      idempotencyKey: "auto-place-cancel-0001",
    }));
    const replayed = await runAs(seeded.user, autoPlaceTalk(input));

    expect(placed.talk).toMatchObject({
      roomId: seeded.roomB,
      startsAt: FIXED_DAY_START,
      status: "confirmed",
      version: 2,
    });
    expect(placed.conflicts).toEqual([]);
    expect(replayed).toMatchObject({ replayed: true, changeId: placed.changeId });
  });

  it("edits the organizer session title and abstract with versioned evidence", async () => {
    const seeded = await seedAgenda("content-edit", { scheduled: true });
    const input = {
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      title: "Effects at global scale",
      description: "A revised abstract owned by the organizer.",
      expectedVersion: 2,
      idempotencyKey: "content-edit-talk-0001",
    } as const;
    const updated = await runAs(seeded.user, updateTalkContent(input));
    const replayed = await runAs(seeded.user, updateTalkContent(input));

    expect(updated.talk).toMatchObject({
      title: "Effects at global scale",
      description: "A revised abstract owned by the organizer.",
      version: 3,
    });
    expect(replayed).toMatchObject({ replayed: true, changeId: updated.changeId });
    const [stored, change, audit] = await Promise.all([
      seeded.db.select().from(talks).where(eq(talks.id, seeded.talkA)).get(),
      seeded.db.select().from(domainChanges).where(eq(domainChanges.id, updated.changeId)).get(),
      seeded.db.select().from(auditLog).where(eq(auditLog.id, updated.auditId)).get(),
    ]);
    expect(stored).toMatchObject({ title: "Effects at global scale", version: 3 });
    expect(change?.payload).toMatchObject({ action: "content_updated" });
    expect(audit?.action).toBe("agenda.talk_content_updated");
  });

  it("lists durable attributed content revisions that can be restored", async () => {
    const seeded = await seedAgenda("content-history", { scheduled: true });
    const first = await runAs(seeded.user, updateTalkContent({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      title: "Effects at global scale",
      description: "The first organizer revision.",
      expectedVersion: 2,
      idempotencyKey: "content-history-first-0001",
    }));
    const second = await runAs(seeded.user, updateTalkContent({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      title: first.talk.title,
      description: "The first organizer revision. A second sentence.",
      expectedVersion: first.talk.version,
      idempotencyKey: "content-history-second-0001",
    }));

    const history = await runAs(seeded.user, listTalkContentHistory({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
    }));
    expect(history).toHaveLength(2);
    expect(history.map((revision) => revision.description)).toEqual([
      "The first organizer revision. A second sentence.",
      "The first organizer revision.",
    ]);
    expect(history.every((revision) => revision.editorName === "Agenda Owner")).toBe(true);
    expect(history.every((revision) => Number.isFinite(revision.occurredAt))).toBe(true);
    expect(history[0]!.occurredAt).toBeGreaterThanOrEqual(history[1]!.occurredAt);

    const restored = await runAs(seeded.user, updateTalkContent({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      title: history[1]!.title,
      description: history[1]!.description,
      expectedVersion: second.talk.version,
      idempotencyKey: "content-history-restore-0001",
    }));
    expect(restored.talk.description).toBe("The first organizer revision.");
    await expect(runAs(seeded.user, listTalkContentHistory({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
    }))).resolves.toHaveLength(3);
  });

  it("keeps Airtable-authoritative talk content as a pending overlay", async () => {
    const seeded = await seedAgenda("content-edit-airtable", { scheduled: true });
    const [before] = await seeded.db.select().from(talks).where(eq(talks.id, seeded.talkA));
    const integrationId = `airtable-${seeded.eventId}`;
    const integrationNow = new Date(FIXED_NOW);
    await seeded.db.insert(integrations).values({
      id: integrationId,
      eventId: seeded.eventId,
      kind: "airtable",
      secretRef: "AIRTABLE_PAT",
      config: {},
      createdAt: integrationNow,
      updatedAt: integrationNow,
    });
    const input = {
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      title: "Pending Airtable title",
      description: "Pending Airtable description",
      expectedVersion: before!.version,
      idempotencyKey: "content-edit-airtable-0001",
    } as const;
    const updated = await runAs(seeded.user, updateTalkContent(input));
    const replayed = await runAs(seeded.user, updateTalkContent(input));
    const [stored, pending, outbox, agenda] = await Promise.all([
      seeded.db.select().from(talks).where(eq(talks.id, seeded.talkA)).get(),
      seeded.db.select().from(airtablePendingEdits).where(eq(airtablePendingEdits.entityId, seeded.talkA)),
      seeded.db.select().from(airtableOutbox).where(eq(airtableOutbox.entityId, seeded.talkA)),
      runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "list" })),
    ]);
    expect(updated.talk).toMatchObject({ title: input.title, description: input.description, version: before!.version + 1 });
    expect(replayed).toMatchObject({ replayed: true, changeId: updated.changeId });
    expect(stored).toMatchObject({ title: before!.title, description: before!.description, version: before!.version + 1 });
    expect(pending.map((row) => row.fieldKey).sort()).toEqual(["description", "title"]);
    expect(outbox.map((row) => row.changedFields)).toEqual(expect.arrayContaining([
      { title: input.title }, { description: input.description },
    ]));
    expect(new Set(outbox.map((row) => row.outboundHash)).size).toBe(1);
    expect(agenda.talks.find((talk) => talk.id === seeded.talkA)).toMatchObject({
      title: input.title,
      description: input.description,
    });
    const conflicted = await runEither(seeded.user, updateTalkContent({
      ...input,
      expectedVersion: updated.talk.version,
      idempotencyKey: "content-edit-airtable-0002",
    }));
    expect(conflicted).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
  });

  it("blocks publication while Airtable-authoritative talk content is pending", async () => {
    const seeded = await seedAgenda("pending-content-publication", { scheduled: true });
    const [before] = await seeded.db.select().from(talks).where(eq(talks.id, seeded.talkA));
    const integrationId = `airtable-${seeded.eventId}`;
    const integrationNow = new Date(FIXED_NOW);
    await seeded.db.insert(integrations).values({
      id: integrationId,
      eventId: seeded.eventId,
      kind: "airtable",
      secretRef: "AIRTABLE_PAT",
      config: {},
      createdAt: integrationNow,
      updatedAt: integrationNow,
    });
    await runAs(seeded.user, updateTalkContent({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      title: "Unconfirmed Airtable title",
      description: before!.description,
      expectedVersion: before!.version,
      idempotencyKey: "pending-content-publication-edit-0001",
    }));

    const publication = await runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 1,
      expectedEventVersion: 1,
      idempotencyKey: "pending-content-publication-0001",
    }));
    expect(publication).toMatchObject({ _tag: "Left", left: { _tag: "Validation" } });
    expect(await seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId), eq(domainChanges.eventType, "agenda/published"),
    ))).toHaveLength(0);
  });

  it("saves room and speaker overlaps as named non-blocking agenda warnings", async () => {
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
    const roomResult = await runAs(roomSeed.user, scheduleTalk({
      eventId: roomSeed.eventId,
      talkId: roomTalk.talk.id,
      trackId: roomSeed.trackId,
      roomId: roomSeed.roomA,
      startsAt: FIXED_DAY_START + 15 * 60_000,
      durationMin: 30,
      expectedVersion: roomTalk.talk.version,
      idempotencyKey: "room-conflict-schedule-0001",
    }));
    expect(roomResult).toMatchObject({
      talk: { status: "confirmed" },
      conflicts: [expect.objectContaining({ kind: "room_overlap", roomName: "Harbor" })],
    });
    const roomSnapshot = await runAs(roomSeed.user, listAgenda({ eventId: roomSeed.eventId, view: "day" }));
    expect(roomSnapshot.warnings).toEqual({
      unplacedTalkCount: 0,
      conflictCount: 1,
      roomConflictCount: 1,
      speakerConflictCount: 0,
    });
    const roomPublication = await runEither(roomSeed.user, publishAgenda({
      eventId: roomSeed.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 2,
      expectedEventVersion: 1,
      idempotencyKey: "room-conflict-publish-0001",
    }));
    expect(roomPublication).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    if (roomPublication._tag === "Left") expect(roomPublication.left.message).toContain("Harbor");

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
    const speakerResult = await runAs(speakerSeed.user, scheduleTalk({
      eventId: speakerSeed.eventId,
      talkId: speakerTalk.talk.id,
      trackId: speakerSeed.trackId,
      roomId: speakerSeed.roomB,
      startsAt: FIXED_DAY_START + 15 * 60_000,
      durationMin: 30,
      expectedVersion: speakerTalk.talk.version,
      idempotencyKey: "speaker-conflict-schedule-0001",
    }));
    expect(speakerResult).toMatchObject({
      talk: { status: "confirmed" },
      conflicts: [expect.objectContaining({ kind: "speaker_overlap", speakerName: "Ada Rivera" })],
    });
    const speakerSnapshot = await runAs(speakerSeed.user, listAgenda({ eventId: speakerSeed.eventId, view: "day" }));
    expect(speakerSnapshot.warnings).toEqual({
      unplacedTalkCount: 0,
      conflictCount: 1,
      roomConflictCount: 0,
      speakerConflictCount: 1,
    });
  });

  it.each(["accountEmail", "profile"] as const)(
    "detects and clears overlaps across duplicate speaker rows tied by %s identity",
    async (identitySource) => {
      const seeded = await seedAgenda(`stable-speaker-conflict-${identitySource}`, {
        scheduled: true,
        duplicateStableSpeaker: identitySource,
      });
      const created = await runAs(seeded.user, createTalk({
        eventId: seeded.eventId,
        submissionId: seeded.submissionB,
        trackId: null,
        roomId: null,
        startsAt: null,
        durationMin: 30,
        idempotencyKey: `stable-speaker-conflict-${identitySource}-create-0001`,
      }));

      const overlapping = await runAs(seeded.user, scheduleTalk({
        eventId: seeded.eventId,
        talkId: created.talk.id,
        trackId: seeded.trackId,
        roomId: seeded.roomB,
        startsAt: FIXED_DAY_START + 15 * 60_000,
        durationMin: 30,
        expectedVersion: created.talk.version,
        idempotencyKey: `stable-speaker-conflict-${identitySource}-schedule-0001`,
      }));
      expect(overlapping.conflicts).toEqual([
        expect.objectContaining({
          kind: "speaker_overlap",
          speakerId: seeded.speakerB,
          speakerName: "Ada Rivera",
        }),
      ]);

      const resolved = await runAs(seeded.user, moveTalk({
        eventId: seeded.eventId,
        talkId: overlapping.talk.id,
        trackId: seeded.trackId,
        roomId: seeded.roomB,
        startsAt: FIXED_DAY_START + 60 * 60_000,
        durationMin: 30,
        expectedVersion: overlapping.talk.version,
        idempotencyKey: `stable-speaker-conflict-${identitySource}-move-0001`,
      }));
      expect(resolved.conflicts).toEqual([]);

      const snapshot = await runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "day" }));
      expect(snapshot.warnings).toEqual({
        unplacedTalkCount: 0,
        conflictCount: 0,
        roomConflictCount: 0,
        speakerConflictCount: 0,
      });
    },
  );

  it("saves TBD placement through the versioned move operation and defers completeness to publication", async () => {
    const seeded = await seedAgenda("partial-draft", { scheduled: true });

    const saved = await runAs(seeded.user, moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      trackId: seeded.trackId,
      roomId: null,
      startsAt: null,
      durationMin: 30,
      expectedVersion: 2,
      idempotencyKey: "partial-draft-save-0001",
    }));
    expect(saved.talk).toMatchObject({ status: "draft", roomId: null, startsAt: null, version: 3 });

    const snapshot = await runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "day" }));
    expect(snapshot.warnings).toEqual({
      unplacedTalkCount: 1,
      conflictCount: 0,
      roomConflictCount: 0,
      speakerConflictCount: 0,
    });

    const publication = await runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 1,
      expectedEventVersion: 1,
      idempotencyKey: "partial-draft-publish-0001",
    }));
    expect(publication).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "Validation",
        message: "Agenda publication requires all active talks to be placed; 1 talk is still TBD",
      },
    });
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

  it("keeps an existing published widget immutable while organizer drafts continue changing", async () => {
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

    const edited = await runAs(seeded.user, updateTalkContent({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      title: "Live organizer title",
      description: "Live organizer description",
      expectedVersion: 2,
      idempotencyKey: "post-publish-content-0001",
    }));
    await runAs(seeded.user, moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      trackId: seeded.trackId,
      roomId: seeded.roomB,
      startsAt: FIXED_DAY_START + 7_200_000,
      durationMin: 30,
      expectedVersion: edited.talk.version,
      idempotencyKey: "post-publish-move-0001",
    }));
    const [stillPublished, organizerAgenda] = await Promise.all([
      runAs(
      seeded.user,
      getPublishedAgenda({ eventSlug: seeded.eventSlug }),
      ),
      runAs(seeded.user, listAgenda({ eventId: seeded.eventId, view: "day" })),
    ]);
    const organizerTalk = organizerAgenda.talks.find((talk) => talk.id === seeded.talkA)!;
    expect(organizerTalk).toMatchObject({
      title: "Live organizer title",
      roomId: seeded.roomB,
      startsAt: FIXED_DAY_START + 7_200_000,
    });
    expect(stillPublished).toEqual(published);
    expect(JSON.stringify(stillPublished)).not.toContain("Live organizer");
  });

  it("reissues changed published calendars once per prior recipient with stable identity", async () => {
    const seeded = await seedAgenda("calendar-reissue", { scheduled: true });
    const first = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "calendar-reissue-publish-0001",
    }));
    const originalSnapshotId = "calendar-reissue-snapshot";
    const originalDeliveryId = "calendar-reissue-delivery";
    const originalUid = `${seeded.talkA}@${seeded.eventSlug}.session-party`;
    await seeded.db.batch([
      seeded.db.update(speakers).set({
        contactEmail: "ada-calendar@example.com",
      }).where(and(
        eq(speakers.eventId, seeded.eventId),
        eq(speakers.id, seeded.speakerA),
      )),
      seeded.db.insert(mailDeliverySnapshots).values({
        id: originalSnapshotId,
        eventId: seeded.eventId,
        templateId: null,
        recipientUserId: null,
        recipientEmail: "ada-calendar@example.com",
        recipientName: "Ada Rivera",
        fromEmail: "Agenda <agenda@example.com>",
        replyToEmail: "organizer@example.com",
        subject: "Your agenda",
        renderedHtml: "<p>Your agenda</p>",
        renderedText: "Your agenda",
        icsFilename: "calendar-reissue-ada-rivera-agenda.ics",
        icsContent: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "METHOD:REQUEST",
          "BEGIN:VEVENT",
          `UID:${originalUid}`,
          "DTSTAMP:20260810T000000Z",
          "LAST-MODIFIED:20260810T000000Z",
          "SEQUENCE:7",
          "DTSTART:20260812T160000Z",
          "DTEND:20260812T164500Z",
          "SUMMARY:Effects at scale",
          "LOCATION:Harbor",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"),
        createdAt: new Date(FIXED_NOW),
      }),
      seeded.db.insert(mailDeliveries).values({
        id: originalDeliveryId,
        snapshotId: originalSnapshotId,
        idempotencyKey: "calendar-reissue-original",
        status: "sent",
        scheduledFor: new Date(FIXED_NOW),
        availableAt: new Date(FIXED_NOW),
        attemptCount: 1,
        maxAttempts: 8,
        provider: "cloudflare-email",
        providerMessageId: "provider-calendar-reissue-original",
        sentAt: new Date(FIXED_NOW),
        createdAt: new Date(FIXED_NOW),
      }),
    ]);

    await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: first.revision,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "calendar-reissue-publish-unchanged-0002",
    }));
    await expect(seeded.db.select().from(mailCalendarEvents)
      .where(eq(mailCalendarEvents.eventId, seeded.eventId))).resolves.toEqual([
      expect.objectContaining({
        snapshotId: originalSnapshotId,
        calendarUid: originalUid,
        sequence: 7,
      }),
    ]);
    await expect(seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).resolves.toHaveLength(1);

    await runAs(seeded.user, moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      trackId: seeded.trackId,
      roomId: seeded.roomB,
      startsAt: FIXED_DAY_START + 7_200_000,
      durationMin: 60,
      expectedVersion: 2,
      idempotencyKey: "calendar-reissue-draft-move-0001",
    }));
    await expect(seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).resolves.toHaveLength(1);

    const changed = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 2,
      expectedWorkspaceVersion: 1,
      expectedEventVersion: 1,
      idempotencyKey: "calendar-reissue-publish-changed-0003",
    }));
    expect(changed.revision).toBe(3);
    const snapshotsAfterChange = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId));
    expect(snapshotsAfterChange).toHaveLength(2);
    const updateSnapshot = snapshotsAfterChange.find(({ id }) => id !== originalSnapshotId)!;
    expect(updateSnapshot.icsContent).toContain(`UID:${originalUid}`);
    expect(updateSnapshot.icsContent).toContain("SEQUENCE:8");
    expect(updateSnapshot.icsContent).toContain("DTSTART:20260812T180000Z");
    expect(updateSnapshot.icsContent).toContain("DTEND:20260812T190000Z");
    expect((await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.id, originalSnapshotId)))[0]?.icsContent).toContain("LOCATION:Harbor");
    const [updateDelivery] = await seeded.db.select().from(mailDeliveries)
      .where(eq(mailDeliveries.snapshotId, updateSnapshot.id));
    expect(updateDelivery).toBeDefined();

    await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 2,
      expectedWorkspaceVersion: 1,
      expectedEventVersion: 1,
      idempotencyKey: "calendar-reissue-publish-changed-0003",
    }));
    await expect(seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).resolves.toHaveLength(2);

    await runAs(seeded.user, cancelTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      expectedVersion: 3,
      idempotencyKey: "calendar-reissue-draft-cancel-0001",
    }));
    await expect(seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).resolves.toHaveLength(2);
    const cancellationInput = {
      eventId: seeded.eventId,
      expectedRevision: 3,
      expectedWorkspaceVersion: 2,
      expectedEventVersion: 1,
      idempotencyKey: "calendar-reissue-publish-cancelled-0004",
    } as const;
    const claimLease = "calendar-reissue-claim-lease";
    const claimedRace = await runEither(seeded.user, publishAgenda(
      cancellationInput,
      () => Effect.promise(async () => {
        await seeded.db.update(mailDeliveries).set({
          status: "claimed",
          attemptCount: 1,
          leaseOwner: claimLease,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }).where(eq(mailDeliveries.id, updateDelivery!.id));
      }),
    ));
    expect(claimedRace).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    const dispatchRace = await runEither(seeded.user, publishAgenda(
      cancellationInput,
      () => Effect.promise(async () => {
        expect(await authorizeMailDispatch(seeded.db, updateDelivery!.id, claimLease)).toBe(true);
      }),
    ));
    expect(dispatchRace).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    await expect(seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).resolves.toHaveLength(2);
    const claimedLeaseExpiresAt = new Date(Date.now() + 10 * 60_000);
    await seeded.db.update(mailDeliveries).set({
      status: "claimed",
      leaseOwner: "calendar-reissue-claimed-lease",
      leaseExpiresAt: claimedLeaseExpiresAt,
    }).where(eq(mailDeliveries.id, updateDelivery!.id));
    await runAs(seeded.user, publishAgenda(cancellationInput));
    const finalSnapshots = await seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId));
    expect(finalSnapshots).toHaveLength(3);
    const cancellation = finalSnapshots.find(({ id }) =>
      id !== originalSnapshotId && id !== updateSnapshot.id
    )!;
    expect(cancellation.icsContent).toContain("METHOD:CANCEL");
    expect(cancellation.icsContent).toContain("STATUS:CANCELLED");
    expect(cancellation.icsContent).toContain(`UID:${originalUid}`);
    expect(cancellation.icsContent).toContain("SEQUENCE:9");
    expect(cancellation.icsContent).toContain("DTSTART:20260812T180000Z");
    await expect(seeded.db.select({
      status: mailDeliveries.status,
      supersededAt: mailDeliveries.supersededAt,
    }).from(mailDeliveries)
      .where(eq(mailDeliveries.id, updateDelivery!.id))).resolves.toEqual([{
        status: "claimed",
        supersededAt: expect.any(Date),
      }]);
    await expect(seeded.db.select({
      scheduledFor: mailDeliveries.scheduledFor,
      availableAt: mailDeliveries.availableAt,
    }).from(mailDeliveries)
      .where(eq(mailDeliveries.snapshotId, cancellation.id))).resolves.toEqual([{
        scheduledFor: claimedLeaseExpiresAt,
        availableAt: claimedLeaseExpiresAt,
      }]);
    await seeded.db.update(mailDeliveries).set({
      status: "dead_letter",
      deadLetteredAt: new Date(FIXED_NOW),
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(eq(mailDeliveries.id, originalDeliveryId));
    await seeded.db.update(mailDeliveries).set({
      status: "dead_letter",
      deadLetteredAt: new Date(FIXED_NOW),
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(eq(mailDeliveries.id, updateDelivery!.id));
    await seeded.db.update(mailDeliveries).set({
      status: "cancelled",
    }).where(eq(mailDeliveries.snapshotId, cancellation.id));
    await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 4,
      expectedWorkspaceVersion: 2,
      expectedEventVersion: 1,
      idempotencyKey: "calendar-reissue-terminal-lineage-0005",
    }));
    await expect(seeded.db.select().from(mailDeliverySnapshots)
      .where(eq(mailDeliverySnapshots.eventId, seeded.eventId))).resolves.toHaveLength(3);
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

  it.each([
    {
      name: "starts-exactly-at-event-start",
      startsAt: FIXED_DAY_START,
      durationMin: 45,
      publishes: true,
    },
    {
      name: "ends-exactly-at-event-end",
      startsAt: FIXED_DAY_START + 2 * 86_400_000 - 45 * 60_000,
      durationMin: 45,
      publishes: true,
    },
    {
      name: "starts-before-event",
      startsAt: FIXED_DAY_START - 1,
      durationMin: 45,
      publishes: false,
    },
    {
      name: "starts-after-event",
      startsAt: FIXED_DAY_START + 2 * 86_400_000 + 1,
      durationMin: 45,
      publishes: false,
    },
    {
      name: "starts-exactly-at-event-end",
      startsAt: FIXED_DAY_START + 2 * 86_400_000,
      durationMin: 45,
      publishes: false,
    },
    {
      name: "duration-overflow",
      startsAt: FIXED_DAY_START + 2 * 86_400_000 - 30 * 60_000,
      durationMin: 45,
      publishes: false,
    },
  ])("$name is handled at publication without restricting draft storage", async ({ name, startsAt, durationMin, publishes }) => {
    const seeded = await seedAgenda(`talk-bounds-${name}`, { scheduled: true });
    await seeded.db
      .update(talks)
      .set({ startsAt: new Date(startsAt), durationMin })
      .where(and(eq(talks.eventId, seeded.eventId), eq(talks.id, seeded.talkA)));

    const result = await runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: `publish-talk-bounds-${name}-0001`,
    }));

    if (publishes) {
      expect(result).toMatchObject({
        _tag: "Right",
        right: { revision: 1, talks: [{ startsAt, durationMin }] },
      });
      return;
    }
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "Validation",
        message: "Agenda publication requires confirmed talks to fit within the event interval; 1 talk falls outside it",
      },
    });
    await expect(seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ))).resolves.toHaveLength(0);
  });

  it("keeps out-of-bounds draft scheduling permissive and rejects only publication", async () => {
    const seeded = await seedAgenda("talk-bounds-draft", { scheduled: true });
    const saved = await runAs(seeded.user, moveTalk({
      eventId: seeded.eventId,
      talkId: seeded.talkA,
      trackId: seeded.trackId,
      roomId: seeded.roomA,
      startsAt: FIXED_DAY_START - 1,
      durationMin: 45,
      expectedVersion: 2,
      idempotencyKey: "talk-bounds-draft-move-0001",
    }));
    expect(saved.talk.startsAt).toBe(FIXED_DAY_START - 1);

    const publication = await runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 1,
      expectedEventVersion: 1,
      idempotencyKey: "talk-bounds-draft-publish-0001",
    }));
    expect(publication).toMatchObject({ _tag: "Left", left: { _tag: "Validation" } });
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
    expect(published.talks[0]).toMatchObject({
      speakerNames: ["Ada Rivera"],
      speakers: [{ id: seeded.speakerA, name: "Ada Rivera" }],
    });
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
    const speakerChange = changes.find(({ aggregateType }) => aggregateType === "speaker-publication");
    expect(changes).toHaveLength(3);
    expect(speakerChange).toMatchObject({
      aggregateId: seeded.eventId,
      aggregateVersion: published.revision,
      eventType: "portal/speakers-published",
      audiences: [{ kind: "public" }],
      payload: expect.objectContaining({
        revision: published.revision,
        event: expect.objectContaining({ id: seeded.eventId }),
      }),
      requestId: publicChange?.requestId,
      idempotencyRecordId: publicChange?.idempotencyRecordId,
    });
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

  it("rejects an Airtable pending edit introduced after publication sampling", async () => {
    const seeded = await seedAgenda("publication-pending-race", { scheduled: true });
    const integrationId = `airtable-${seeded.eventId}`;
    const now = new Date(FIXED_NOW);
    await seeded.db.insert(integrations).values({
      id: integrationId,
      eventId: seeded.eventId,
      kind: "airtable",
      secretRef: "AIRTABLE_PAT",
      config: {},
      createdAt: now,
      updatedAt: now,
    });
    const barrier = publicationBarrier();
    const publication = runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publication-pending-race-0001",
    }, barrier.interlock));
    await barrier.sampled;
    try {
      await seeded.db.insert(airtablePendingEdits).values({
        id: "publication-pending-race-edit",
        eventId: seeded.eventId,
        integrationId,
        entityType: "talk",
        entityId: seeded.talkA,
        speakerId: null,
        submissionId: null,
        talkId: seeded.talkA,
        fieldKey: "title",
        intendedValue: "Losing pending title",
        status: "pending",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    } finally {
      barrier.release();
    }
    expect(await publication).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    expect(await seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId), eq(domainChanges.eventType, "agenda/published"),
    ))).toHaveLength(0);
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
          expectedVersion: 1,
          name: "Conference publication-event-race updated",
        }),
      );
    } finally {
      barrier.release();
    }

    const result = await stalePublication;
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    await expect(seeded.db.select().from(domainChanges).where(eq(domainChanges.eventId, seeded.eventId))).resolves.toEqual([
      expect.objectContaining({ eventType: "events.updated", aggregateVersion: 2 }),
    ]);
    await expect(seeded.db.select().from(auditLog).where(eq(auditLog.eventId, seeded.eventId))).resolves.toEqual([
      expect.objectContaining({ action: "events.update", resourceType: "event" }),
    ]);
    await expect(seeded.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, seeded.eventId))).resolves.toHaveLength(0);
  });

  it("rejects a hidden-to-visible race without partial publication evidence", async () => {
    const seeded = await seedAgenda("publication-speaker-visible-race", { scheduled: true });
    await seeded.db
      .update(speakers)
      .set({ visible: false })
      .where(and(eq(speakers.eventId, seeded.eventId), eq(speakers.id, seeded.speakerA)));
    const barrier = publicationBarrier();
    const stalePublication = runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-speaker-visible-race-0001",
    }, barrier.interlock));
    await barrier.sampled;
    try {
      await runEventAs(seeded.user, updateSpeakerPublication({
        eventId: seeded.eventId,
        speakerId: seeded.speakerA,
        expectedVersion: 1,
        visible: true,
      }));
    } finally {
      barrier.release();
    }

    await expect(stalePublication).resolves.toMatchObject({
      _tag: "Left",
      left: { _tag: "Conflict" },
    });
    await expect(seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-delivery"),
    ))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(auditLog).where(and(
      eq(auditLog.eventId, seeded.eventId),
      eq(auditLog.action, "agenda.revision_published"),
    ))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, seeded.eventId),
      eq(idempotencyRecords.operationId, "agenda.publish"),
    ))).resolves.toHaveLength(0);
  });

  it("publishes a visible in-review speaker as private without tripping the projection interlock", async () => {
    const seeded = await seedAgenda("publication-speaker-in-review", { scheduled: true });
    await seeded.db
      .update(speakers)
      .set({ profileReviewStatus: "in_review", profileSubmittedAt: new Date(FIXED_NOW) })
      .where(and(eq(speakers.eventId, seeded.eventId), eq(speakers.id, seeded.speakerA)));

    const publication = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-speaker-in-review-0001",
    }));

    expect(publication).toMatchObject({
      revision: 1,
      talks: [{ speakerNames: [] }],
    });
  });

  it("rejects a visible-to-private race without publication evidence and permits a clean retry", async () => {
    const seeded = await seedAgenda("publication-speaker-private-race", { scheduled: true });
    const barrier = publicationBarrier();
    const input = {
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-speaker-private-race-0001",
    } as const;
    const stalePublication = runEither(seeded.user, publishAgenda(input, barrier.interlock));
    await barrier.sampled;
    try {
      await runEventAs(seeded.user, updateSpeakerPublication({
        eventId: seeded.eventId,
        speakerId: seeded.speakerA,
        expectedVersion: 1,
        visible: false,
      }));
    } finally {
      barrier.release();
    }

    await expect(stalePublication).resolves.toMatchObject({
      _tag: "Left",
      left: { _tag: "Conflict" },
    });
    await expect(seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-delivery"),
    ))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(auditLog).where(and(
      eq(auditLog.eventId, seeded.eventId),
      eq(auditLog.action, "agenda.revision_published"),
    ))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, seeded.eventId),
      eq(idempotencyRecords.operationId, "agenda.publish"),
    ))).resolves.toHaveLength(0);

    const retried = await runAs(seeded.user, publishAgenda(input));
    expect(retried).toMatchObject({
      revision: 1,
      talks: [{ speakerNames: [] }],
    });
  });

  it("rejects a visible display-name race before committing the immutable revision", async () => {
    const seeded = await seedAgenda("publication-speaker-name-race", {
      scheduled: true,
      linkedSpeaker: true,
    });
    const barrier = publicationBarrier();
    const stalePublication = runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-speaker-name-race-0001",
    }, barrier.interlock));
    await barrier.sampled;
    try {
      await runAs(seeded.user, updateSpeakerProfile({
        eventId: seeded.eventId,
        expectedVersion: 1,
        idempotencyKey: "speaker-name-race-update-0001",
        displayName: "Ada Private",
        title: null,
        company: null,
        bio: null,
        links: [],
      }));
    } finally {
      barrier.release();
    }

    await expect(stalePublication).resolves.toMatchObject({
      _tag: "Left",
      left: { _tag: "Conflict" },
    });
    await expect(seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ))).resolves.toHaveLength(0);
    const published = await runAs(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-speaker-name-race-retry-0001",
    }));
    expect(published.talks[0]?.speakerNames).toEqual(["Ada Private"]);
  });

  it("rejects a contributing speaker version change even when the visible name is unchanged", async () => {
    const seeded = await seedAgenda("publication-speaker-version-race", {
      scheduled: true,
      linkedSpeaker: true,
    });
    const barrier = publicationBarrier();
    const stalePublication = runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-speaker-version-race-0001",
    }, barrier.interlock));
    await barrier.sampled;
    try {
      await runAs(seeded.user, updateSpeakerProfile({
        eventId: seeded.eventId,
        expectedVersion: 1,
        idempotencyKey: "speaker-version-race-update-0001",
        displayName: "Ada Rivera",
        title: "Staff Engineer",
        company: null,
        bio: null,
        links: [],
      }));
    } finally {
      barrier.release();
    }

    await expect(stalePublication).resolves.toMatchObject({
      _tag: "Left",
      left: { _tag: "Conflict" },
    });
    await expect(seeded.db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, seeded.eventId),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ))).resolves.toHaveLength(0);
    await expect(seeded.db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, seeded.eventId),
      eq(idempotencyRecords.operationId, "agenda.publish"),
    ))).resolves.toHaveLength(0);
  });

  it("allows unrelated speaker publication changes while the projection is pending", async () => {
    const seeded = await seedAgenda("publication-unrelated-speaker-race", { scheduled: true });
    const barrier = publicationBarrier();
    const publication = runEither(seeded.user, publishAgenda({
      eventId: seeded.eventId,
      expectedRevision: 0,
      expectedWorkspaceVersion: 0,
      expectedEventVersion: 1,
      idempotencyKey: "publish-unrelated-speaker-race-0001",
    }, barrier.interlock));
    await barrier.sampled;
    try {
      await runEventAs(seeded.user, updateSpeakerPublication({
        eventId: seeded.eventId,
        speakerId: seeded.speakerB,
        expectedVersion: 1,
        visible: false,
      }));
    } finally {
      barrier.release();
    }

    await expect(publication).resolves.toMatchObject({
      _tag: "Right",
      right: {
        revision: 1,
        talks: [{ speakerNames: ["Ada Rivera"] }],
      },
    });
  });
});
