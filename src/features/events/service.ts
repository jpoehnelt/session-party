import { Conflict, External, Forbidden, NotFound, type AppError } from "contracts/errors";
import {
  browserSessionAuthorization,
  eventAuthorization,
  type AuthorizationPolicy,
} from "contracts/principal";
import { eventMembers, events } from "contracts/schema";
import { Effect, Schema } from "effect";
import { eq, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Authorizer, CurrentUser, Db } from "@/server/services";

const OptionalText = Schema.optional(Schema.Union(Schema.String, Schema.Null));
const OptionalTimestamp = Schema.optional(Schema.Union(Schema.Number, Schema.Null));

const eventReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
  { kind: "api-key", scopes: ["event:read"] },
);

const eventWriteAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["event:write"] },
);

const authorizeCurrent = (policy: AuthorizationPolicy, eventId: string | null) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    return yield* authorize({ principal, policy, eventId });
  });

export const CreateEventInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  slug: Schema.String.pipe(
    Schema.minLength(2),
    Schema.maxLength(80),
    Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ),
  description: OptionalText,
  location: OptionalText,
  timezone: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  startsAt: OptionalTimestamp,
  endsAt: OptionalTimestamp,
  accentColor: OptionalText,
});
export type CreateEventInput = typeof CreateEventInput.Type;

export const UpdateEventInput = Schema.Struct({
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))),
  slug: Schema.optional(
    Schema.String.pipe(
      Schema.minLength(2),
      Schema.maxLength(80),
      Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    ),
  ),
  description: OptionalText,
  location: OptionalText,
  timezone: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  startsAt: OptionalTimestamp,
  endsAt: OptionalTimestamp,
  accentColor: OptionalText,
});
export type UpdateEventInput = typeof UpdateEventInput.Type;

export const GetEventInput = Schema.Struct({ idOrSlug: Schema.String.pipe(Schema.minLength(1)) });

export type EventRecord = typeof events.$inferSelect;

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const dates = (input: {
  readonly startsAt?: number | null;
  readonly endsAt?: number | null;
}) => ({
  startsAt: input.startsAt === undefined ? undefined : input.startsAt === null ? null : new Date(input.startsAt),
  endsAt: input.endsAt === undefined ? undefined : input.endsAt === null ? null : new Date(input.endsAt),
});

const findEvent = (idOrSlug: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db
        .select()
        .from(events)
        .where(or(eq(events.id, idOrSlug), eq(events.slug, idOrSlug)))
        .limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: idOrSlug }));
    return event;
  });

export const createEvent = (
  input: CreateEventInput,
): Effect.Effect<EventRecord, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* authorizeCurrent(browserSessionAuthorization, null);
    if (!principal || principal.kind !== "browser-session") {
      return yield* Effect.fail(
        new Forbidden({ reason: "This operation requires a browser session" }),
      );
    }

    const [existing] = yield* database(() =>
      db.select({ id: events.id }).from(events).where(eq(events.slug, input.slug)).limit(1),
    );
    if (existing) {
      return yield* Effect.fail(new Conflict({ message: `Event slug '${input.slug}' is already in use` }));
    }

    const now = new Date();
    const eventId = nanoid();
    const eventInsert = db
      .insert(events)
      .values({
        id: eventId,
        name: input.name.trim(),
        slug: input.slug,
        description: input.description,
        location: input.location,
        timezone: input.timezone,
        accentColor: input.accentColor,
        ...dates(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const memberInsert = db.insert(eventMembers).values({
      id: nanoid(),
      eventId,
      userId: principal.userId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });

    const result = yield* database(() => db.batch([eventInsert, memberInsert]));
    const event = result[0][0];
    if (!event) {
      return yield* Effect.fail(new External({ service: "database", detail: "Event insert returned no row" }));
    }
    return event;
  }).pipe(
    Effect.catchIf(
      (error): error is External =>
        error._tag === "External" &&
        (error.detail?.includes("UNIQUE constraint failed: events.slug") ?? false),
      () => Effect.fail(new Conflict({ message: `Event slug '${input.slug}' is already in use` })),
    ),
  );

export const getEvent = (
  idOrSlug: string,
): Effect.Effect<EventRecord, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(idOrSlug);
    yield* authorizeCurrent(eventReadAuthorization, event.id);
    return event;
  });

export const listEvents = (): Effect.Effect<
  readonly EventRecord[],
  AppError,
  Authorizer | CurrentUser | Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const principal = yield* CurrentUser;
    if (principal.kind === "api-key") {
      const { authorize } = yield* Authorizer;
      yield* authorize({
        principal,
        policy: eventReadAuthorization,
        eventId: principal.eventId,
      });
      return yield* database(() =>
        db.select().from(events).where(eq(events.id, principal.eventId)),
      );
    }
    return yield* database(() =>
      db
        .select({ event: events })
        .from(events)
        .innerJoin(eventMembers, eq(eventMembers.eventId, events.id))
        .where(eq(eventMembers.userId, principal.userId))
        .then((rows) => rows.map(({ event }) => event)),
    );
  });

export const updateEvent = (
  idOrSlug: string,
  input: UpdateEventInput,
): Effect.Effect<EventRecord, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const event = yield* findEvent(idOrSlug);
    yield* authorizeCurrent(eventWriteAuthorization, event.id);

    if (input.slug && input.slug !== event.slug) {
      const [slugOwner] = yield* database(() =>
        db.select({ id: events.id }).from(events).where(eq(events.slug, input.slug!)).limit(1),
      );
      if (slugOwner) {
        return yield* Effect.fail(new Conflict({ message: `Event slug '${input.slug}' is already in use` }));
      }
    }

    const [updated] = yield* database(() =>
      db
        .update(events)
        .set({
          ...input,
          ...dates(input),
          name: input.name?.trim(),
          updatedAt: new Date(),
        })
        .where(eq(events.id, event.id))
        .returning(),
    );
    if (!updated) return yield* Effect.fail(new NotFound({ entity: "event", id: idOrSlug }));
    return updated;
  }).pipe(
    Effect.catchIf(
      (error): error is External =>
        error._tag === "External" &&
        (error.detail?.includes("UNIQUE constraint failed: events.slug") ?? false),
      () => Effect.fail(new Conflict({ message: `Event slug '${input.slug}' is already in use` })),
    ),
  );

