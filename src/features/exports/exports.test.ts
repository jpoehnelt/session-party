import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import { eventMembers, events, speakerContacts, speakers, talkSpeakers, talks, taskCompletions, tasks, users } from "contracts/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, Authorizer, CurrentUser, Db } from "@/server/services";
import { getInstitutionalArchive } from "./service";
import { getArchiveOperation } from "./operations";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const hasMigrations = (value: Cloudflare.Env): value is TestEnv => "TEST_MIGRATIONS" in value;
const principal = (userId: string): Principal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name: userId,
  sessionId: `session-${userId}`,
  expiresAt: Date.now() + 86_400_000,
});

const reviewReadApiKey = (eventId: string): Principal => ({
  kind: "api-key",
  userId: "api-key:archive-review-reader",
  apiKeyId: "archive-review-reader",
  eventId,
  name: "Archive review reader",
  scopes: ["event:read", "reviews:read"],
  expiresAt: Date.now() + 86_400_000,
});

const runAs = <A, E>(user: Principal, effect: Effect.Effect<A, E, Authorizer | CurrentUser | Db>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, user)))));

const runEitherAs = <A, E>(user: Principal, effect: Effect.Effect<A, E, Authorizer | CurrentUser | Db>) =>
  Effect.runPromise(effect.pipe(Effect.either, Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, user)))));

beforeAll(async () => {
  if (!hasMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
});

const seed = async (name: string) => {
  const db = drizzle(env.DB);
  const id = (suffix: string) => `${name}-${suffix}`;
  const now = new Date(Date.UTC(2026, 7, 9, 18));
  const eventId = id("event");
  const ownerId = id("owner");
  const reviewerId = id("reviewer");
  const adminId = id("admin");
  const speakerId = id("speaker");
  const talkId = id("talk");
  const taskId = id("task");
  const rows: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(users).values([
      { id: ownerId, email: `${ownerId}@example.com`, name: "Archive Owner", createdAt: now, updatedAt: now },
      { id: reviewerId, email: `${reviewerId}@example.com`, name: "Archive Reviewer", createdAt: now, updatedAt: now },
      { id: adminId, email: `${adminId}@example.com`, name: "Archive Admin", createdAt: now, updatedAt: now },
    ]),
    db.insert(events).values({
      id: eventId,
      slug: id("summit"),
      name: "Archive Summit",
      timezone: "America/Denver",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(eventMembers).values([
      { id: id("owner-member"), eventId, userId: ownerId, role: "owner", createdAt: now, updatedAt: now },
      { id: id("admin-member"), eventId, userId: adminId, role: "admin", createdAt: now, updatedAt: now },
      { id: id("reviewer-member"), eventId, userId: reviewerId, role: "reviewer", createdAt: now, updatedAt: now },
    ]),
    db.insert(speakers).values({
      id: speakerId,
      eventId,
      displayName: "Stable Speaker",
      title: "Director",
      company: "Durable Systems",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(talks).values({
      id: talkId,
      eventId,
      title: "Institutional memory",
      startsAt: new Date(now.getTime() + 86_400_000),
      durationMin: 45,
      status: "confirmed",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(talkSpeakers).values({ id: id("talk-speaker"), eventId, talkId, speakerId, createdAt: now }),
    db.insert(tasks).values({
      id: taskId,
      eventId,
      name: "Employer approval",
      kind: "confirm",
      order: 0,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(taskCompletions).values({
      id: id("completion"),
      eventId,
      taskId,
      speakerId,
      completedAt: now,
      data: { approved: true },
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(speakerContacts).values({
      id: id("contact"),
      eventId,
      speakerId,
      actorUserId: ownerId,
      medium: "personalEmail",
      note: "Asked about employer approval",
      contactedAt: now,
      createdAt: now,
    }),
  ];
  await db.batch(rows);
  return {
    eventId,
    owner: principal(ownerId),
    admin: principal(adminId),
    reviewer: principal(reviewerId),
    speakerId,
    talkId,
    taskId,
  };
};

describe("institutional archive", () => {
  it("exports stable entity IDs and onboarding evidence in deterministic projections", async () => {
    const seeded = await seed("archive-stable");
    const archive = await runAs(seeded.owner, getInstitutionalArchive({ eventId: seeded.eventId }));

    expect(archive).toMatchObject({
      format: "session-party.archive.v1",
      event: { id: seeded.eventId, name: "Archive Summit" },
      speakers: [{ id: seeded.speakerId, title: "Director", organization: "Durable Systems" }],
      sessions: [{ id: seeded.talkId, speakerIds: [seeded.speakerId] }],
      tasks: [{ id: seeded.taskId, name: "Employer approval", kind: "confirm" }],
      taskCompletions: [{ taskId: seeded.taskId, speakerId: seeded.speakerId }],
      speakerContacts: [{ speakerId: seeded.speakerId, medium: "personalEmail" }],
    });
    expect(archive.exportedAt).toEqual(expect.any(Number));
  });

  it("allows an event admin to export the institutional archive", async () => {
    const seeded = await seed("archive-admin");
    const archive = await runAs(seeded.admin, getInstitutionalArchive({ eventId: seeded.eventId }));
    expect(archive).toMatchObject({
      format: "session-party.archive.v1",
      event: { id: seeded.eventId },
      taskCompletions: [{ taskId: seeded.taskId, speakerId: seeded.speakerId }],
    });
  });

  it("denies reviewers and review-scoped API keys", async () => {
    const seeded = await seed("archive-private");
    for (const actor of [seeded.reviewer, reviewReadApiKey(seeded.eventId)]) {
      const result = await runEitherAs(actor, getInstitutionalArchive({ eventId: seeded.eventId }));
      expect(result).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });
    }
    expect("mcp" in getArchiveOperation).toBe(false);
  });
});
