import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import {
  events,
  eventMembers,
  rooms,
  speakers,
  talkSpeakers,
  talks,
  tracks,
  users,
} from "contracts/schema";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getPublishedAgendaOperation,
  listAgendaOperation,
  publishAgendaOperation,
} from "@/features/agenda/operations";
import { getPublishedAgenda, publishAgenda } from "@/features/agenda/service";
import { AppLayer, CurrentUser, Db } from "@/server/services";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const FIXED_NOW = Date.UTC(2026, 7, 8, 18, 0, 0);
const STARTS_AT = Date.UTC(2026, 7, 10, 16, 0, 0);

const hasMigrations = (value: Cloudflare.Env): value is TestEnv => "TEST_MIGRATIONS" in value;

const browserPrincipal = (userId: string): Principal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name: userId,
  sessionId: `session-${userId}`,
  expiresAt: FIXED_NOW + 86_400_000,
});

const runEitherAs = <A, E>(
  principal: Principal,
  effect: Effect.Effect<A, E, CurrentUser | Db>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runAs = <A, E>(
  principal: Principal,
  effect: Effect.Effect<A, E, CurrentUser | Db>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const seedPublication = async (name: string) => {
  const db = drizzle(env.DB);
  const id = (suffix: string) => `${name}-${suffix}`;
  const now = new Date(FIXED_NOW);
  const eventId = id("event");
  const eventSlug = id("summit");
  const ownerId = id("owner");
  const trackId = id("track");
  const roomId = id("room");
  const visibleSpeakerId = id("speaker-visible");
  const hiddenSpeakerId = id("speaker-hidden");
  const confirmedTalkId = id("talk-confirmed");
  const cancelledTalkId = id("talk-cancelled");

  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.com`,
      name: "Publication Owner",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(events).values({
      id: eventId,
      slug: eventSlug,
      name: `Publication ${name}`,
      location: "Harbor Hall",
      timezone: "America/Los_Angeles",
      startsAt: new Date(STARTS_AT),
      endsAt: new Date(STARTS_AT + 86_400_000),
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(eventMembers).values({
      id: id("member-owner"),
      eventId,
      userId: ownerId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(tracks).values({
      id: trackId,
      eventId,
      name: "Systems",
      color: "#2563EB",
      order: 0,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(rooms).values({
      id: roomId,
      eventId,
      name: "Harbor",
      capacity: 120,
      order: 0,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(speakers).values([
      {
        id: visibleSpeakerId,
        eventId,
        displayName: "Ada Rivera",
        visible: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: hiddenSpeakerId,
        eventId,
        displayName: "Private Speaker",
        visible: false,
        createdAt: now,
        updatedAt: now,
      },
    ]),
    db.insert(talks).values([
      {
        id: confirmedTalkId,
        eventId,
        submissionId: null,
        title: "Effects at scale",
        description: "A production scheduling case study.",
        trackId,
        roomId,
        startsAt: new Date(STARTS_AT),
        durationMin: 45,
        status: "confirmed",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cancelledTalkId,
        eventId,
        submissionId: null,
        title: "Private cancelled talk",
        description: "Never publish this cancelled session.",
        trackId,
        roomId,
        startsAt: new Date(STARTS_AT + 3_600_000),
        durationMin: 30,
        status: "cancelled",
        createdAt: now,
        updatedAt: now,
      },
    ]),
    db.insert(talkSpeakers).values([
      {
        id: id("talk-visible-speaker"),
        eventId,
        talkId: confirmedTalkId,
        speakerId: visibleSpeakerId,
        createdAt: now,
      },
      {
        id: id("talk-hidden-speaker"),
        eventId,
        talkId: confirmedTalkId,
        speakerId: hiddenSpeakerId,
        createdAt: now,
      },
    ]),
  ];

  await db.batch(statements);
  return {
    confirmedTalkId,
    db,
    eventId,
    eventSlug,
    owner: browserPrincipal(ownerId),
    visibleSpeakerId,
  };
};

beforeAll(async () => {
  if (!hasMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
});

describe("publication boundary", () => {
  it("owns no shadow agenda REST, MCP, DTO, or operation aliases", () => {
    expect([
      listAgendaOperation.id,
      publishAgendaOperation.id,
      getPublishedAgendaOperation.id,
    ]).toEqual(["agenda.list", "agenda.publish", "agenda.getPublished"]);
    expect([
      listAgendaOperation.rest.path,
      publishAgendaOperation.rest.path,
      getPublishedAgendaOperation.rest.path,
    ]).toEqual([
      "/events/:eventId/agenda",
      "/events/:eventId/agenda/publications",
      "/public/events/:eventSlug/agenda/published",
    ]);
    expect([
      listAgendaOperation.mcp?.name,
      publishAgendaOperation.mcp?.name,
      undefined,
    ]).toEqual(["agenda_list", "agenda_publish", undefined]);
  });

  it("keeps unpublished schedules private", async () => {
    const seeded = await seedPublication("unpublished-privacy");
    const result = await runEitherAs(
      seeded.owner,
      getPublishedAgenda({ eventSlug: seeded.eventSlug }),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "NotFound" } });
    expect(JSON.stringify(result)).not.toContain("Effects at scale");
    expect(JSON.stringify(result)).not.toContain("Private cancelled talk");
  });

  it("publishes only confirmed talks and visible speaker names as an immutable snapshot", async () => {
    const seeded = await seedPublication("immutable-publication");
    const published = await runAs(
      seeded.owner,
      publishAgenda({
        eventId: seeded.eventId,
        expectedRevision: 0,
        expectedWorkspaceVersion: 0,
        expectedEventVersion: 1,
        idempotencyKey: "publication-immutable-snapshot-0001",
      }),
    );

    expect(published.talks).toEqual([
      expect.objectContaining({
        id: seeded.confirmedTalkId,
        speakerNames: ["Ada Rivera"],
        startsAt: STARTS_AT,
        title: "Effects at scale",
        track: "Systems",
        room: "Harbor",
      }),
    ]);
    expect(JSON.stringify(published)).not.toContain("Private Speaker");
    expect(JSON.stringify(published)).not.toContain("Private cancelled talk");
    expect(published.talks[0]).not.toHaveProperty("submissionId");
    expect(published.talks[0]).not.toHaveProperty("version");

    await seeded.db
      .update(talks)
      .set({
        title: "Unpublished agenda edit",
        startsAt: new Date(STARTS_AT + 7_200_000),
        version: 2,
        updatedAt: new Date(FIXED_NOW + 1_000),
      })
      .where(eq(talks.id, seeded.confirmedTalkId));
    await seeded.db
      .update(speakers)
      .set({
        displayName: "Unpublished speaker edit",
        version: 2,
        updatedAt: new Date(FIXED_NOW + 1_000),
      })
      .where(eq(speakers.id, seeded.visibleSpeakerId));

    const stillPublished = await runAs(
      seeded.owner,
      getPublishedAgenda({ eventSlug: seeded.eventSlug }),
    );
    expect(stillPublished).toEqual(published);
    expect(JSON.stringify(stillPublished)).not.toContain("Unpublished");
  });
});
