import { Conflict, External, NotFound, Validation, type AppError } from "contracts/errors";
import { eventAuthorization, type Principal } from "contracts/principal";
import { domainChanges, embeds, events, tracks } from "contracts/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db } from "@/server/services";
import { SCHEDULE_EMBED_FIELDS, type ScheduleEmbedField } from "./embed-content";
import type {
  CreateEmbedInput,
  EmbedDefinition,
  EmbedPreset,
  EmbedWidget,
  ListEmbedsInput,
  PublicEmbedInput,
  UpdateEmbedInput,
} from "./schema";

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const authorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["content:write"] },
);

const organizer = (eventId: string): Effect.Effect<Principal, AppError, Db | CurrentUser | Authorizer> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    yield* authorize({ principal, eventId, policy: authorization });
    return principal;
  });

const validPreset = (widget: EmbedWidget, preset: EmbedPreset): boolean =>
  widget === "schedule"
    ? preset === "sessions" || preset === "agenda" || preset === "itinerary"
    : preset === "speakerList" || preset === "speakerGallery";

const normalizedConfiguration = <T extends CreateEmbedInput | UpdateEmbedInput>(input: T) => {
  const name = input.name.trim();
  const accent = input.accent.toUpperCase();
  const allowedFields = new Set<string>(SCHEDULE_EMBED_FIELDS);
  const fields = input.widget === "schedule"
    ? [...new Set(input.fields.filter((field): field is ScheduleEmbedField => allowedFields.has(field)))]
    : [];
  return { name, accent, fields };
};

const validateConfiguration = (input: CreateEmbedInput | UpdateEmbedInput) => {
  if (!validPreset(input.widget, input.preset)) {
    return Effect.fail(new Validation({ message: "Embed preset does not match the selected widget" }));
  }
  if (input.widget === "speakerGallery" && (input.trackId != null || input.track !== null || input.fields.length > 0)) {
    return Effect.fail(new Validation({ message: "Speaker gallery embeds do not accept schedule filters" }));
  }
  return Effect.void;
};

const resolveTrackConfiguration = (input: CreateEmbedInput | UpdateEmbedInput) => Effect.gen(function* () {
  if (input.widget !== "schedule") return { trackId: null, track: null } as const;
  const trackId = input.trackId ?? null;
  const trackName = input.track?.trim() || null;
  if (trackId === null && trackName === null) return { trackId: null, track: null } as const;
  const { db } = yield* Db;
  const [resolved] = yield* database(() => db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(and(
    eq(tracks.eventId, input.eventId),
    trackId === null ? eq(tracks.name, trackName!) : eq(tracks.id, trackId),
  )).limit(1));
  if (!resolved) {
    return yield* Effect.fail(new Validation({ message: "Embed track filter must reference a current event track" }));
  }
  return { trackId: resolved.id, track: resolved.name } as const;
});

type EmbedRow = typeof embeds.$inferSelect;
const view = (row: EmbedRow, eventSlug: string, currentTrackName: string | null = null): EmbedDefinition => ({
  id: row.id,
  eventId: row.eventId,
  eventSlug,
  name: row.name,
  widget: row.widget,
  preset: row.preset,
  aesthetic: row.aesthetic,
  accent: row.accent,
  trackId: row.trackId,
  track: row.trackId === null ? row.track : currentTrackName ?? row.track,
  fields: row.fields as readonly ScheduleEmbedField[],
  enabled: row.enabled,
  version: row.version,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const eventSlug = (eventId: string) => Effect.gen(function* () {
  const { db } = yield* Db;
  const [event] = yield* database(() => db.select({ slug: events.slug }).from(events).where(eq(events.id, eventId)).limit(1));
  if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: eventId }));
  return event.slug;
});

export const listEmbeds = (input: ListEmbedsInput): Effect.Effect<readonly EmbedDefinition[], AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  yield* organizer(input.eventId);
  const slug = yield* eventSlug(input.eventId);
  const { db } = yield* Db;
  const rows = yield* database(() => db.select({ embed: embeds, currentTrackName: tracks.name }).from(embeds)
    .leftJoin(tracks, and(eq(tracks.eventId, embeds.eventId), eq(tracks.id, embeds.trackId)))
    .where(eq(embeds.eventId, input.eventId)).orderBy(desc(embeds.updatedAt)));
  return rows.map((row) => view(row.embed, slug, row.currentTrackName));
});

export const createEmbed = (input: CreateEmbedInput): Effect.Effect<EmbedDefinition, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const principal = yield* organizer(input.eventId);
  yield* validateConfiguration(input);
  const slug = yield* eventSlug(input.eventId);
  const { db } = yield* Db;
  const timestamp = new Date();
  const config = { ...normalizedConfiguration(input), ...(yield* resolveTrackConfiguration(input)) };
  const row = {
    id: `embed_${nanoid()}`,
    eventId: input.eventId,
    ...config,
    widget: input.widget,
    preset: input.preset,
    aesthetic: input.aesthetic,
    enabled: input.enabled,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  yield* database(() => db.batch([
    db.insert(embeds).values(row),
    db.insert(domainChanges).values({
      id: `change_${nanoid()}`,
      eventId: input.eventId,
      aggregateType: "embed",
      aggregateId: row.id,
      aggregateVersion: 1,
      eventType: "publication.embed.created",
      audiences: [{ kind: "admins" }],
      payload: { embedId: row.id },
      actorUserId: principal.kind === "browser-session" ? principal.userId : null,
      actorApiKeyId: principal.kind === "api-key" ? principal.apiKeyId : null,
      requestId: `publication_request_${nanoid()}`,
      idempotencyRecordId: null,
      occurredAt: timestamp,
    }),
  ]));
  return view(row, slug, config.track);
});

export const updateEmbed = (input: UpdateEmbedInput): Effect.Effect<EmbedDefinition, AppError, Db | CurrentUser | Authorizer> => Effect.gen(function* () {
  const principal = yield* organizer(input.eventId);
  yield* validateConfiguration(input);
  const slug = yield* eventSlug(input.eventId);
  const { db } = yield* Db;
  const timestamp = new Date();
  const version = input.expectedVersion + 1;
  const config = { ...normalizedConfiguration(input), ...(yield* resolveTrackConfiguration(input)) };
  const guard = and(eq(embeds.eventId, input.eventId), eq(embeds.id, input.embedId), eq(embeds.version, input.expectedVersion));
  const changeId = `change_${nanoid()}`;
  const requestId = `publication_request_${nanoid()}`;
  const audiences = [{ kind: "admins" }] as const;
  const payload = { embedId: input.embedId, enabled: input.enabled } as const;
  const [, rows] = yield* database(() => db.batch([
    db.insert(domainChanges).select(db.select({
      sequence: sql<number | null>`null`.as("sequence"),
      id: sql<string>`${changeId}`.as("id"),
      eventId: sql<string>`${input.eventId}`.as("event_id"),
      aggregateType: sql<string>`'embed'`.as("aggregate_type"),
      aggregateId: sql<string>`${input.embedId}`.as("aggregate_id"),
      aggregateVersion: sql<number>`${version}`.as("aggregate_version"),
      eventType: sql<string>`'publication.embed.updated'`.as("event_type"),
      audiences: sql<typeof audiences>`${JSON.stringify(audiences)}`.as("audiences"),
      payload: sql<typeof payload>`${JSON.stringify(payload)}`.as("payload"),
      actorUserId: sql<string | null>`${principal.kind === "browser-session" ? principal.userId : null}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`${principal.kind === "api-key" ? principal.apiKeyId : null}`.as("actor_api_key_id"),
      requestId: sql<string>`${requestId}`.as("request_id"),
      idempotencyRecordId: sql<string | null>`null`.as("idempotency_record_id"),
      occurredAt: sql<Date>`${timestamp.getTime()}`.as("occurred_at"),
    }).from(embeds).where(guard)),
    db.update(embeds).set({
      ...config,
      widget: input.widget,
      preset: input.preset,
      aesthetic: input.aesthetic,
      enabled: input.enabled,
      version,
      updatedAt: timestamp,
    }).where(guard).returning(),
  ]));
  const row = rows[0];
  if (!row) return yield* Effect.fail(new Conflict({ message: "Embed changed; reload before saving" }));
  return view(row, slug, config.track);
});

export const getPublicEmbed = (input: PublicEmbedInput): Effect.Effect<EmbedDefinition, AppError, Db> => Effect.gen(function* () {
  const { db } = yield* Db;
  const [row] = yield* database(() => db.select({ embed: embeds, slug: events.slug, currentTrackName: tracks.name }).from(embeds)
    .innerJoin(events, eq(events.id, embeds.eventId))
    .leftJoin(tracks, and(eq(tracks.eventId, embeds.eventId), eq(tracks.id, embeds.trackId)))
    .where(and(eq(events.slug, input.eventSlug), eq(embeds.id, input.embedId), eq(embeds.enabled, true)))
    .limit(1));
  if (!row) return yield* Effect.fail(new NotFound({ entity: "embed", id: input.embedId }));
  return view(row.embed, row.slug, row.currentTrackName);
});

export { authorization as embedOrganizerAuthorization };
