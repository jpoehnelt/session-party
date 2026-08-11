import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import {
  domainChanges,
  events,
  speakerProfileChanges,
  speakerProfiles,
  speakers,
} from "contracts/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { CurrentUser, Db } from "@/server/services";
import { PublishedAgenda as PublishedAgendaSchema } from "@/features/agenda/schema";
import { PublishedSpeakerGallerySnapshot as PublishedSpeakerGallerySnapshotSchema } from "@/features/portal/schema";
import {
  type GetPublicProfileInput,
  type MyProfile,
  type PublicProfileAppearance,
  type PublicReusableSpeakerProfile,
  type ReusableSpeakerProfile,
  type SaveMyProfileInput,
} from "./schema";

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const millis = (value: Date | null): number | null => value?.getTime() ?? null;
const profileView = (profile: typeof speakerProfiles.$inferSelect): ReusableSpeakerProfile => ({
  id: profile.id,
  slug: profile.slug,
  displayName: profile.displayName,
  title: profile.title,
  company: profile.company,
  bio: profile.bio,
  headshotUrl: profile.headshotUrl,
  links: profile.links ?? [],
  visible: profile.visible,
  version: profile.version,
  updatedAt: profile.updatedAt.getTime(),
});

const browserUser = Effect.gen(function* () {
  const principal = yield* CurrentUser;
  if (principal.kind !== "browser-session") {
    return yield* Effect.fail(new Forbidden({ reason: "A speaker account is required" }));
  }
  return principal;
});

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const validateProfileUrls = (input: SaveMyProfileInput): Effect.Effect<void, Validation> => {
  if (input.headshotUrl !== null) {
    try {
      if (new URL(input.headshotUrl).protocol !== "https:") {
        return Effect.fail(new Validation({ message: "Headshot URL must use HTTPS" }));
      }
    } catch {
      return Effect.fail(new Validation({ message: "Headshot URL must be a valid HTTPS URL" }));
    }
  }
  if (input.links.some(({ url }) => !isHttpUrl(url))) {
    return Effect.fail(new Validation({ message: "Profile links must use HTTP or HTTPS" }));
  }
  return Effect.void;
};

export const getMyProfile = (): Effect.Effect<MyProfile, AppError, CurrentUser | Db> => Effect.gen(function* () {
  const actor = yield* browserUser;
  const { db } = yield* Db;
  const [profile] = yield* database(() => db.select().from(speakerProfiles).where(eq(speakerProfiles.userId, actor.userId)).limit(1));
  return profile ? profileView(profile) : null;
});

export const saveMyProfile = (input: SaveMyProfileInput): Effect.Effect<ReusableSpeakerProfile, AppError, CurrentUser | Db> => Effect.gen(function* () {
  const actor = yield* browserUser;
  yield* validateProfileUrls(input);
  const { db } = yield* Db;
  const [existing, slugOwner] = yield* Effect.all([
    database(() => db.select().from(speakerProfiles).where(eq(speakerProfiles.userId, actor.userId)).limit(1)),
    database(() => db.select({ userId: speakerProfiles.userId }).from(speakerProfiles).where(eq(speakerProfiles.slug, input.slug)).limit(1)),
  ], { concurrency: 1 });
  const current = existing[0];
  if (slugOwner[0] && slugOwner[0].userId !== actor.userId) {
    return yield* Effect.fail(new Conflict({ message: "That public speaker URL is already in use" }));
  }
  const updatedAt = new Date();
  const values = {
    slug: input.slug,
    displayName: input.displayName.trim(),
    title: input.title?.trim() || null,
    company: input.company?.trim() || null,
    bio: input.bio?.trim() || null,
    headshotUrl: input.headshotUrl,
    links: input.links,
    visible: input.visible,
    updatedAt,
  };
  if (!current) {
    if (input.expectedVersion !== 0) {
      return yield* Effect.fail(new Conflict({ message: "Speaker profile does not exist; reload before saving" }));
    }
    const record: typeof speakerProfiles.$inferInsert = {
      id: `speaker_profile_${nanoid()}`,
      userId: actor.userId,
      ...values,
      version: 1,
      createdAt: updatedAt,
    };
    const result = profileView(record as typeof speakerProfiles.$inferSelect);
    yield* database(() => db.batch([
      db.insert(speakerProfiles).values(record),
      db.insert(speakerProfileChanges).values({
        id: `speaker_profile_change_${nanoid()}`,
        profileId: record.id,
        profileVersion: 1,
        actorUserId: actor.userId,
        before: null,
        after: result,
        createdAt: updatedAt,
      }),
    ])).pipe(Effect.catchAll((error) => Effect.fail(new Conflict({ message: error.detail?.includes("slug") ? "That public speaker URL is already in use" : "Speaker profile was created elsewhere; reload" }))));
    return result;
  }
  if (current.version !== input.expectedVersion) {
    return yield* Effect.fail(new Conflict({ message: "Speaker profile changed; reload before saving" }));
  }
  const version = current.version + 1;
  const result = profileView({ ...current, ...values, version });
  const changeId = `speaker_profile_change_${nanoid()}`;
  const updated = yield* database(() => db.batch([
    db.update(speakerProfiles).set({ ...values, version }).where(and(
      eq(speakerProfiles.id, current.id),
      eq(speakerProfiles.version, current.version),
    )).returning(),
    db.insert(speakerProfileChanges).select(db.select({
      id: sql<string>`${changeId}`.as("id"),
      profileId: speakerProfiles.id,
      profileVersion: speakerProfiles.version,
      actorUserId: speakerProfiles.userId,
      before: sql<unknown>`${JSON.stringify(profileView(current))}`.as("before"),
      after: sql<unknown>`${JSON.stringify(result)}`.as("after"),
      createdAt: sql<Date>`${updatedAt.getTime()}`.as("created_at"),
    }).from(speakerProfiles).where(and(
      eq(speakerProfiles.id, current.id),
      eq(speakerProfiles.version, version),
    ))),
  ]));
  if ((updated[0] as (typeof speakerProfiles.$inferSelect)[]).length === 0) {
    return yield* Effect.fail(new Conflict({ message: "Speaker profile changed; reload before saving" }));
  }
  return result;
});

export const getPublicProfile = (input: GetPublicProfileInput): Effect.Effect<PublicReusableSpeakerProfile, AppError, Db> => Effect.gen(function* () {
  const { db } = yield* Db;
  const [profile] = yield* database(() => db.select().from(speakerProfiles).where(and(
    eq(speakerProfiles.slug, input.slug),
    eq(speakerProfiles.visible, true),
  )).limit(1));
  if (!profile) return yield* Effect.fail(new NotFound({ entity: "public speaker profile", id: input.slug }));
  const eventRows = yield* database(() => db.select({
    speakerId: speakers.id,
    eventId: events.id,
    eventSlug: events.slug,
    eventName: events.name,
    timezone: events.timezone,
    location: events.location,
    startsAt: events.startsAt,
    endsAt: events.endsAt,
  }).from(speakers).innerJoin(events, eq(events.id, speakers.eventId)).where(eq(speakers.profileSourceId, profile.id)));
  if (eventRows.length === 0) return { profile: profileView(profile), appearances: [] };
  const eventIds = eventRows.map(({ eventId }) => eventId);
  const changes = yield* database(() => db.select({
    eventId: domainChanges.eventId,
    aggregateType: domainChanges.aggregateType,
    payload: domainChanges.payload,
  }).from(domainChanges).where(and(
    inArray(domainChanges.eventId, eventIds),
    inArray(domainChanges.aggregateType, ["speaker-publication", "agenda-publication"]),
  )).orderBy(desc(domainChanges.sequence)));
  const latest = new Map<string, unknown>();
  for (const change of changes) {
    const key = `${change.eventId}\u0000${change.aggregateType}`;
    if (!latest.has(key)) latest.set(key, change.payload);
  }
  const appearances: PublicProfileAppearance[] = [];
  for (const event of eventRows) {
    const galleryPayload = latest.get(`${event.eventId}\u0000speaker-publication`);
    if (!galleryPayload) continue;
    const gallery = yield* Schema.decodeUnknown(PublishedSpeakerGallerySnapshotSchema)(galleryPayload).pipe(Effect.orElseSucceed(() => null));
    if (!gallery?.speakers.some(({ id, publicProfileSlug }) => id === event.speakerId && publicProfileSlug === profile.slug)) continue;
    const agendaPayload = latest.get(`${event.eventId}\u0000agenda-publication`);
    const agenda = agendaPayload
      ? yield* Schema.decodeUnknown(PublishedAgendaSchema)(agendaPayload).pipe(Effect.orElseSucceed(() => null))
      : null;
    appearances.push({
      eventId: event.eventId,
      eventSlug: event.eventSlug,
      eventName: event.eventName,
      timezone: event.timezone,
      location: event.location,
      startsAt: millis(event.startsAt),
      endsAt: millis(event.endsAt),
      talks: (agenda?.talks ?? []).filter(({ speakerProfiles: profiles }) =>
        profiles?.some(({ slug }) => slug === profile.slug),
      ).map((talk) => ({
        id: talk.id,
        title: talk.title,
        description: talk.description,
        track: talk.track,
        room: talk.room,
        startsAt: talk.startsAt,
        durationMin: talk.durationMin,
      })),
    });
  }
  appearances.sort((left, right) => (right.startsAt ?? 0) - (left.startsAt ?? 0) || left.eventName.localeCompare(right.eventName));
  return { profile: profileView(profile), appearances };
});
