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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, Authorizer, CurrentUser, Db } from "@/server/services";
import type { PublishedAgenda } from "@/features/agenda/schema";
import { PublishedSchedule } from "./components/PublishedSchedule";
import { operations } from "./operations";
import {
  getPublicationStatus,
  getPublicSchedule,
  publishSchedule,
} from "./service";
import { layout as embedLayout, path as embedPath } from "./routes/schedule-embed";

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

const runEitherAs = <A, E, R extends Authorizer | CurrentUser | Db>(
  principal: Principal,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runAs = <A, E, R extends Authorizer | CurrentUser | Db>(
  principal: Principal,
  effect: Effect.Effect<A, E, R>,
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
  const reviewerId = id("reviewer");
  const trackId = id("track");
  const roomId = id("room");
  const visibleSpeakerId = id("speaker-visible");
  const hiddenSpeakerId = id("speaker-hidden");
  const confirmedTalkId = id("talk-confirmed");
  const draftTalkId = id("talk-draft");

  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(users).values([
      {
        id: ownerId,
        email: `${ownerId}@example.com`,
        name: "Publication Owner",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: reviewerId,
        email: `${reviewerId}@example.com`,
        name: "Publication Reviewer",
        createdAt: now,
        updatedAt: now,
      },
    ]),
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
    db.insert(eventMembers).values([
      {
        id: id("member-owner"),
        eventId,
        userId: ownerId,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: id("member-reviewer"),
        eventId,
        userId: reviewerId,
        role: "reviewer",
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
        id: draftTalkId,
        eventId,
        submissionId: null,
        title: "Private draft talk",
        description: "Never publish this draft.",
        trackId,
        roomId,
        startsAt: new Date(STARTS_AT + 3_600_000),
        durationMin: 30,
        status: "draft",
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
    reviewer: browserPrincipal(reviewerId),
  };
};

beforeAll(async () => {
  if (!hasMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
});

describe("publication service and descriptors", () => {
  it("owns publication operations and enforces organizer authorization", async () => {
    expect(operations.map(({ id }) => id)).toEqual([
      "publication.getSchedule",
      "publication.getStatus",
      "publication.publishSchedule",
    ]);
    expect(operations.map(({ mcp }) => mcp?.name)).toEqual([
      "publication_get_schedule",
      "publication_get_status",
      "publication_publish_schedule",
    ]);

    const seeded = await seedPublication("organizer-auth");
    const ownerStatus = await runEitherAs(
      seeded.owner,
      getPublicationStatus({ eventSlug: seeded.eventSlug }),
    );
    expect(ownerStatus).toMatchObject({ _tag: "Right", right: { eventId: seeded.eventId } });

    const reviewerStatus = await runEitherAs(
      seeded.reviewer,
      getPublicationStatus({ eventSlug: seeded.eventSlug }),
    );
    expect(reviewerStatus).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });

    const reviewerPublish = await runEitherAs(
      seeded.reviewer,
      publishSchedule({
        eventId: seeded.eventId,
        expectedRevision: 0,
        expectedWorkspaceVersion: 0,
        expectedEventVersion: 1,
        idempotencyKey: "publication-reviewer-denied-0001",
      }),
    );
    expect(reviewerPublish).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });
  });

  it("reads the immutable publication after private agenda changes", async () => {
    const seeded = await seedPublication("immutable-read");
    const published = await runAs(
      seeded.owner,
      publishSchedule({
        eventId: seeded.eventId,
        expectedRevision: 0,
        expectedWorkspaceVersion: 0,
        expectedEventVersion: 1,
        idempotencyKey: "publication-immutable-read-0001",
      }),
    );
    expect(published.talks).toEqual([
      expect.objectContaining({
        id: seeded.confirmedTalkId,
        speakerNames: ["Ada Rivera"],
        startsAt: STARTS_AT,
        title: "Effects at scale",
      }),
    ]);
    expect(JSON.stringify(published)).not.toContain("Private Speaker");
    expect(JSON.stringify(published)).not.toContain("Private draft talk");

    await seeded.db
      .update(talks)
      .set({
        title: "Unpublished agenda edit",
        startsAt: new Date(STARTS_AT + 7_200_000),
        version: 2,
        updatedAt: new Date(FIXED_NOW + 1_000),
      })
      .where(eq(talks.id, seeded.confirmedTalkId));

    const publicRead = await runAs(
      seeded.owner,
      getPublicSchedule({ eventSlug: seeded.eventSlug }),
    );
    expect(publicRead).toEqual(published);
    expect(JSON.stringify(publicRead)).not.toContain("Unpublished agenda edit");
  });

  it("returns no private schedule before the first publication", async () => {
    const seeded = await seedPublication("unpublished-privacy");
    const result = await runEitherAs(
      seeded.owner,
      getPublicSchedule({ eventSlug: seeded.eventSlug }),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "NotFound" } });
    expect(JSON.stringify(result)).not.toContain("Effects at scale");
    expect(JSON.stringify(result)).not.toContain("Private draft talk");
  });
});

describe("public schedule rendering", () => {
  const agenda: PublishedAgenda = {
    eventId: "render-event",
    eventName: "Render Summit",
    eventSlug: "render-summit",
    timezone: "America/Los_Angeles",
    location: "Harbor Hall",
    revision: 2,
    publishedAt: FIXED_NOW,
    talks: [{
      id: "render-talk",
      title: "Immutable systems",
      description: "How to publish without leaking drafts.",
      track: "Systems",
      room: "Harbor",
      startsAt: STARTS_AT,
      durationMin: 45,
      speakerNames: ["Ada Rivera"],
    }],
  };

  it("owns the bare public embed route and renders only publication fields", () => {
    expect(embedPath).toBe("/embed/:eventSlug/schedule");
    expect(embedLayout).toBe("bare");
    const markup = renderToStaticMarkup(createElement(PublishedSchedule, { agenda }));
    expect(markup).toContain("Immutable systems");
    expect(markup).toContain("Ada Rivera");
    expect(markup).toContain("Systems");
    expect(markup).toContain("Harbor");
    expect(markup).not.toContain("submissionId");
    expect(markup).not.toContain("version");
  });

  it("renders a truthful empty state for an empty published revision", () => {
    const markup = renderToStaticMarkup(createElement(PublishedSchedule, {
      agenda: { ...agenda, talks: [] },
    }));
    expect(markup).toContain("Schedule coming soon");
    expect(markup).toContain("no sessions have been added");
  });
});
