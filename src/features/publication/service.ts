import { External, NotFound, type AppError } from "contracts/errors";
import {
  eventAuthorization,
  type AuthorizationPolicy,
} from "contracts/principal";
import { events } from "contracts/schema";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Authorizer, CurrentUser, Db } from "@/server/services";
import {
  getPublishedAgenda,
  listAgenda,
  publishAgenda,
} from "@/features/agenda/service";
import type {
  AgendaSnapshot,
  PublishedAgenda,
  PublishAgendaInput,
} from "@/features/agenda/schema";
import type { PublicationBySlugInput } from "./schema";

const publicationReadAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["agenda:read"] },
);

const publicationWriteAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["agenda:write"] },
);

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const findEventBySlug = (eventSlug: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.slug, eventSlug))
        .limit(1),
    );
    if (!event) {
      return yield* Effect.fail(new NotFound({ entity: "event", id: eventSlug }));
    }
    return event;
  });

const authorizeCurrent = (policy: AuthorizationPolicy, eventId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const { authorize } = yield* Authorizer;
    yield* authorize({ principal, policy, eventId });
  });

export const getPublicationStatus = (
  input: PublicationBySlugInput,
): Effect.Effect<AgendaSnapshot, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEventBySlug(input.eventSlug);
    yield* authorizeCurrent(publicationReadAuthorization, event.id);
    return yield* listAgenda({ eventId: event.id, view: "day" });
  });

export const publishSchedule = (
  input: PublishAgendaInput,
): Effect.Effect<PublishedAgenda, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    yield* authorizeCurrent(publicationWriteAuthorization, input.eventId);
    return yield* publishAgenda(input);
  });

/** Public reads resolve only the event identity and the immutable agenda publication. */
export const getPublicSchedule = (
  input: PublicationBySlugInput,
): Effect.Effect<PublishedAgenda, AppError, Db> =>
  Effect.gen(function* () {
    const event = yield* findEventBySlug(input.eventSlug);
    return yield* getPublishedAgenda({ eventId: event.id });
  });
