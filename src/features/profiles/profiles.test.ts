import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type { BrowserSessionPrincipal } from "contracts/principal";
import {
  assets,
  domainChanges,
  events,
  speakerProfileChanges,
  speakers,
  talkSpeakers,
  talks,
  users,
} from "contracts/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, CurrentUser as CurrentUserTag, type CurrentUser, type Db } from "@/server/services";
import { getMyProfile, getPublicProfile, saveMyProfile } from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
type Requirements = CurrentUser | Db;
const expiresAt = Date.UTC(2100, 0, 1);
const speaker: BrowserSessionPrincipal = {
  kind: "browser-session",
  userId: "reusable-profile-speaker",
  email: "reusable-profile-speaker@example.com",
  name: "Ada Rivera",
  sessionId: "session-reusable-profile-speaker",
  expiresAt,
};

const runAs = <A>(effect: Effect.Effect<A, AppError, Requirements>) => Effect.runPromise(effect.pipe(
  Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUserTag, speaker))),
));

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
  const now = new Date();
  await drizzle(env.DB).insert(users).values({
    id: speaker.userId,
    email: speaker.email,
    name: speaker.name,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
});

describe("reusable speaker profiles", () => {
  it("keeps versioned speaker-owned history and exposes only published event appearances", async () => {
    expect(await runAs(getMyProfile())).toBeNull();
    const created = await runAs(saveMyProfile({
      expectedVersion: 0,
      slug: "ada-rivera",
      displayName: "Ada Rivera",
      title: "Principal engineer",
      company: "Session Party",
      bio: "Builds calm systems for busy rooms.",
      headshotUrl: null,
      links: [{ label: "Website", url: "https://ada.example.com" }],
      visible: true,
    }));
    expect(created).toMatchObject({ slug: "ada-rivera", version: 1, visible: true });
    expect(await drizzle(env.DB).select().from(speakerProfileChanges).where(eq(speakerProfileChanges.profileId, created.id)))
      .toHaveLength(1);

    const now = new Date();
    const eventId = "profile-public-event";
    const eventSpeakerId = "profile-public-event-speaker";
    const headshotAssetId = "profile-public-headshot";
    const talkId = "profile-public-talk";
    await drizzle(env.DB).batch([
      drizzle(env.DB).insert(events).values({
        id: eventId, slug: "systems-summit", name: "Systems Summit", description: "Public event",
        location: "Denver", timezone: "America/Denver", startsAt: new Date("2026-09-20T15:00:00Z"),
        endsAt: new Date("2026-09-20T23:00:00Z"), version: 1, createdAt: now, updatedAt: now,
      }),
      drizzle(env.DB).insert(assets).values({
        id: headshotAssetId, eventId, uploaderUserId: speaker.userId, speakerId: eventSpeakerId,
        purpose: "headshot", current: true, filename: "ada.png", contentType: "image/png", size: 128,
        version: 1, createdAt: now, updatedAt: now,
      }),
      drizzle(env.DB).insert(speakers).values({
        id: eventSpeakerId, eventId, userId: speaker.userId, displayName: "Ada Rivera", title: "Principal engineer",
        company: "Session Party", bio: "Event-approved bio", workflowStatus: "Ready", headshotAssetId, links: [], visible: true,
        profileSourceId: created.id, profileSourceVersion: created.version, profileReviewStatus: "approved", version: 1,
        createdAt: now, updatedAt: now,
      }),
      drizzle(env.DB).insert(talks).values({
        id: talkId, eventId, submissionId: null, title: "Durable profiles", description: "Snapshots without surprise.",
        trackId: null, roomId: null, startsAt: new Date("2026-09-20T17:00:00Z"), durationMin: 30,
        status: "confirmed", version: 1, createdAt: now, updatedAt: now,
      }),
      drizzle(env.DB).insert(talkSpeakers).values({ id: "profile-public-membership", eventId, talkId, speakerId: eventSpeakerId, createdAt: now }),
    ]);
    await drizzle(env.DB).insert(domainChanges).values([
      {
        id: "profile-speaker-publication", eventId, aggregateType: "speaker-publication", aggregateId: eventId,
        aggregateVersion: 1, eventType: "speakers.published", audiences: ["public"], requestId: "profile-public-request",
        payload: {
          event: { id: eventId, slug: "systems-summit", name: "Systems Summit", description: "Public event", location: "Denver", timezone: "America/Denver", startsAt: Date.parse("2026-09-20T15:00:00Z"), endsAt: Date.parse("2026-09-20T23:00:00Z"), bannerAssetId: null, accentColor: null },
          revision: 1, publishedAt: now.getTime(),
          speakers: [{ id: eventSpeakerId, displayName: "Ada Rivera", title: "Principal engineer", company: "Session Party", bio: "Event-approved bio", headshotAssetId, publicProfileSlug: "ada-rivera", links: [] }],
        },
        actorUserId: speaker.userId, actorApiKeyId: null, idempotencyRecordId: null, occurredAt: now,
      },
      {
        id: "profile-agenda-publication", eventId, aggregateType: "agenda-publication", aggregateId: eventId,
        aggregateVersion: 1, eventType: "agenda.published", audiences: ["public"], requestId: "profile-public-request",
        payload: {
          eventId, eventName: "Systems Summit", eventSlug: "systems-summit", timezone: "America/Denver", location: "Denver",
          revision: 1, publishedAt: now.getTime(),
          talks: [{ id: talkId, title: "Durable profiles", description: "Snapshots without surprise.", track: null, room: null, startsAt: Date.parse("2026-09-20T17:00:00Z"), durationMin: 30, speakerNames: ["Ada Rivera"], speakerProfiles: [{ name: "Ada Rivera", slug: "ada-rivera" }] }],
        },
        actorUserId: speaker.userId, actorApiKeyId: null, idempotencyRecordId: null, occurredAt: now,
      },
    ]);

    await expect(Effect.runPromise(getPublicProfile({ slug: "ada-rivera" }).pipe(Effect.provide(AppLayer(env)))))
      .resolves.toMatchObject({
        profile: {
          id: created.id,
          displayName: "Ada Rivera",
          headshotUrl: `/api/v1/public/events/systems-summit/speakers/${eventSpeakerId}/headshots/${headshotAssetId}/r1`,
        },
        appearances: [{ eventName: "Systems Summit", talks: [{ id: talkId, title: "Durable profiles" }] }],
      });
  });
});
