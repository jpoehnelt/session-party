import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import {
  browserSessionAuthorization,
  eventAuthorization,
  type AuthorizationPolicy,
} from "contracts/principal";
import { apiKeys, auditLog, domainChanges, eventMembers, events, idempotencyRecords, users } from "contracts/schema";
import { Effect, Schema } from "effect";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ApiKeyCredentials, Authorizer, CurrentUser, Db } from "@/server/services";
import {
  AddEventMemberOutput,
  type AddEventMemberInput,
  type AddEventMemberOutput as AddEventMemberOutputType,
  type EventMember as EventMemberType,
  type EventApiKey as EventApiKeyType,
  type CreateEventApiKeyInput,
  type CreateEventApiKeyOutput,
  type ListEventApiKeysInput,
  type ListEventMembersInput,
  RemoveEventMemberOutput,
  type RemoveEventMemberInput,
  type RemoveEventMemberOutput as RemoveEventMemberOutputType,
  type RevokeEventApiKeyInput,
  UpdateEventMemberOutput,
  type UpdateEventMemberInput,
  type UpdateEventMemberOutput as UpdateEventMemberOutputType,
  UpdateEventInput as UpdateEventInputSchema,
  type UpdateEventInput as UpdateEventInputType,
} from "./schema";

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

/** Membership lookup is deliberately browser-only: adding an account is not an API-key bulk import. */
const memberManagementAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
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

export const UpdateEventInput = UpdateEventInputSchema;
export type UpdateEventInput = UpdateEventInputType;

export const GetEventInput = Schema.Struct({ idOrSlug: Schema.String.pipe(Schema.minLength(1)) });

export type EventRecord = typeof events.$inferSelect;

type EventMemberRow = {
  readonly membership: typeof eventMembers.$inferSelect;
  readonly user: Pick<typeof users.$inferSelect, "email" | "name">;
};

type ManagedRole = "owner" | "admin" | "reviewer";

const normalizedEmail = (email: string) => email.trim().toLowerCase();
const commandId = (prefix: string) => `${prefix}_${nanoid()}`;

const apiKeyOutput = (row: typeof apiKeys.$inferSelect): EventApiKeyType => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes as EventApiKeyType["scopes"],
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  version: row.version,
  createdAt: row.createdAt,
});

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (error) => new External({ service: "crypto", detail: String(error) }),
  });

const memberOutput = (row: EventMemberRow): EventMemberType => ({
  id: row.membership.id,
  userId: row.membership.userId,
  email: normalizedEmail(row.user.email),
  name: row.user.name,
  role: row.membership.role,
  version: row.membership.version,
  createdAt: row.membership.createdAt,
  updatedAt: row.membership.updatedAt,
});

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

const validateDateOrder = (startsAt: number | null, endsAt: number | null) =>
  startsAt !== null && endsAt !== null && endsAt < startsAt
    ? Effect.fail(new Validation({ message: "End must be at or after start." }))
    : Effect.void;

const isDateOrderConstraint = (error: External): boolean =>
  error.detail?.includes("events_date_order") ?? false;

const eventDatabaseFailure = (
  error: External,
  slug: string,
): Effect.Effect<never, External | Validation | Conflict> => {
  if (isDateOrderConstraint(error)) {
    return Effect.fail(new Validation({ message: "End must be at or after start." }));
  }
  if (error.detail?.includes("UNIQUE constraint failed: events.slug")) {
    return Effect.fail(new Conflict({ message: `Event slug '${slug}' is already in use` }));
  }
  return Effect.fail(error);
};

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

    yield* validateDateOrder(input.startsAt ?? null, input.endsAt ?? null);

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
    Effect.catchTag("External", (error) => eventDatabaseFailure(error, input.slug)),
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

    yield* validateDateOrder(
      input.startsAt === undefined ? event.startsAt?.getTime() ?? null : input.startsAt,
      input.endsAt === undefined ? event.endsAt?.getTime() ?? null : input.endsAt,
    );

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
          version: sql`${events.version} + 1`,
        })
        .where(eq(events.id, event.id))
        .returning(),
    );
    if (!updated) return yield* Effect.fail(new NotFound({ entity: "event", id: idOrSlug }));
    return updated;
  }).pipe(
    Effect.catchTag("External", (error) => eventDatabaseFailure(error, input.slug ?? idOrSlug)),
  );

type MemberActor = { readonly userId: string; readonly role: ManagedRole };

const requireMemberManager = (eventId: string): Effect.Effect<MemberActor, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    yield* authorizeCurrent(memberManagementAuthorization, eventId);
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "Member management requires an owner or admin browser session" }));
    }
    const { db } = yield* Db;
    const [membership] = yield* database(() =>
      db.select({ role: eventMembers.role })
        .from(eventMembers)
        .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, principal.userId)))
        .limit(1),
    );
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      return yield* Effect.fail(new Forbidden({ reason: "Owner or admin role required" }));
    }
    return { userId: principal.userId, role: membership.role };
  });

export const listEventApiKeys = (
  input: ListEventApiKeysInput,
): Effect.Effect<readonly EventApiKeyType[], AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(input.eventId);
    yield* requireMemberManager(event.id);
    const { db } = yield* Db;
    const rows = yield* database(() =>
      db.select().from(apiKeys).where(eq(apiKeys.eventId, event.id)).orderBy(desc(apiKeys.createdAt), asc(apiKeys.id)),
    );
    return rows.map(apiKeyOutput);
  });

export const createEventApiKey = (
  input: CreateEventApiKeyInput,
): Effect.Effect<CreateEventApiKeyOutput, AppError, ApiKeyCredentials | Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(input.eventId);
    const actor = yield* requireMemberManager(event.id);
    const name = input.name.trim();
    if (!name) return yield* Effect.fail(new Validation({ message: "API key name is required" }));
    const now = new Date();
    const expiresAt = new Date(input.expiresAt);
    const minimumExpiry = now.getTime() + 60 * 60_000;
    const maximumExpiry = now.getTime() + 366 * 24 * 60 * 60_000;
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < minimumExpiry || expiresAt.getTime() > maximumExpiry) {
      return yield* Effect.fail(new Validation({ message: "API keys must expire between one hour and one year from now" }));
    }
    const scopes = [...new Set(input.scopes)];
    const credentials = yield* ApiKeyCredentials;
    const { secret, hash } = yield* credentials.generate();
    const id = commandId("api_key");
    const row = {
      id,
      eventId: event.id,
      name,
      keyHash: hash,
      scopes,
      expiresAt,
      revokedAt: null,
      createdBy: actor.userId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as const;
    const requestId = `event-api-key:create:${id}`;
    const { db } = yield* Db;
    yield* database(() => db.batch([
      db.insert(apiKeys).values(row),
      db.insert(auditLog).values({
        id: commandId("audit"), eventId: event.id, requestId, actorUserId: actor.userId,
        actorApiKeyId: null, action: "events.createApiKey", resourceType: "apiKey", resourceId: id,
        before: null, after: { id, name, scopes, expiresAt: expiresAt.toISOString(), version: 1 },
        metadata: { secretReturnedOnce: true }, occurredAt: now,
      }),
    ]));
    return { apiKey: apiKeyOutput(row), secret };
  });

export const revokeEventApiKey = (
  input: RevokeEventApiKeyInput,
): Effect.Effect<EventApiKeyType, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(input.eventId);
    const actor = yield* requireMemberManager(event.id);
    const { db } = yield* Db;
    const [existing] = yield* database(() => db.select().from(apiKeys).where(and(
      eq(apiKeys.eventId, event.id), eq(apiKeys.id, input.apiKeyId),
    )).limit(1));
    if (!existing) return yield* Effect.fail(new NotFound({ entity: "API key", id: input.apiKeyId }));
    if (existing.revokedAt || existing.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "API key changed or was already revoked; refresh and try again" }));
    }
    const revokedAt = new Date();
    const anticipated = apiKeyOutput({ ...existing, revokedAt, updatedAt: revokedAt, version: existing.version + 1 });
    const result = yield* database(() => db.batch([db.update(apiKeys).set({
      revokedAt, updatedAt: revokedAt, version: sql`${apiKeys.version} + 1`,
    }).where(and(
      eq(apiKeys.eventId, event.id), eq(apiKeys.id, input.apiKeyId),
      eq(apiKeys.version, input.expectedVersion), isNull(apiKeys.revokedAt),
    )).returning(), db.insert(auditLog).values({
      id: commandId("audit"), eventId: event.id, requestId: `event-api-key:revoke:${existing.id}`,
      actorUserId: actor.userId, actorApiKeyId: null, action: "events.revokeApiKey",
      resourceType: "apiKey", resourceId: existing.id,
      before: { id: existing.id, name: existing.name, scopes: existing.scopes, expiresAt: existing.expiresAt.toISOString(), version: existing.version },
      after: { id: anticipated.id, revokedAt: anticipated.revokedAt?.toISOString(), version: anticipated.version },
      metadata: null, occurredAt: revokedAt,
    })]));
    const revoked = result[0][0];
    if (!revoked) return yield* Effect.fail(new Conflict({ message: "API key changed; refresh and try again" }));
    return apiKeyOutput(revoked);
  });

const loadMember = (eventId: string, memberId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* database(() =>
      db.select({ membership: eventMembers, user: { email: users.email, name: users.name } })
        .from(eventMembers)
        .innerJoin(users, eq(users.id, eventMembers.userId))
        .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.id, memberId)))
        .limit(1),
    );
    return row as EventMemberRow | undefined;
  });

const ownerCount = (eventId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* database(() =>
      db.select({ count: sql<number>`count(*)` })
        .from(eventMembers)
        .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.role, "owner"))),
    );
    return Number(row?.count ?? 0);
  });

const mayManageRole = (actorRole: ManagedRole, currentRole: ManagedRole | null, nextRole: ManagedRole) =>
  actorRole === "owner" || ((currentRole === null || currentRole === "reviewer") && nextRole === "reviewer");

const replay = <A>(
  eventId: string,
  operationId: string,
  principalId: string,
  keyHash: string,
  requestHash: string,
  output: Schema.Schema<A, any, never>,
): Effect.Effect<A | null, AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [record] = yield* database(() =>
      db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, eventId),
        eq(idempotencyRecords.operationId, operationId),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1),
    );
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different member-management request" }));
    }
    if (record.status !== "completed") {
      return yield* Effect.fail(new Conflict({ message: "Member-management request with this idempotency key is still in progress" }));
    }
    return yield* Schema.decodeUnknown(output)(record.responseBody).pipe(
      Effect.mapError((error) => new External({ service: "database", detail: `Invalid member-management replay: ${String(error)}` })),
    );
  });

export const listEventMembers = (
  input: ListEventMembersInput,
): Effect.Effect<readonly EventMemberType[], AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(input.eventId);
    yield* requireMemberManager(event.id);
    const { db } = yield* Db;
    const rows = yield* database(() =>
      db.select({ membership: eventMembers, user: { email: users.email, name: users.name } })
        .from(eventMembers)
        .innerJoin(users, eq(users.id, eventMembers.userId))
        .where(eq(eventMembers.eventId, event.id))
        .orderBy(asc(users.email), asc(eventMembers.id)),
    );
    return rows.map((row) => memberOutput(row as EventMemberRow));
  });

export const addEventMember = (
  input: AddEventMemberInput,
): Effect.Effect<AddEventMemberOutputType, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(input.eventId);
    const actor = yield* requireMemberManager(event.id);
    const email = normalizedEmail(input.email);
    if (!email.includes("@")) {
      return yield* Effect.fail(new Validation({ message: "Enter a valid existing account email" }));
    }
    if (!mayManageRole(actor.role, null, input.role)) {
      return yield* Effect.fail(new Forbidden({ reason: "Only an owner can add admins or owners" }));
    }
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({ email, role: input.role }));
    const prior = yield* replay(event.id, "events.addMember", actor.userId, keyHash, requestHash, AddEventMemberOutput);
    if (prior) return { ...prior, idempotent: true };
    const { db } = yield* Db;
    const [user] = yield* database(() =>
      db.select().from(users).where(sql`lower(trim(${users.email})) = ${email}`).limit(1),
    );
    if (!user) {
      return yield* Effect.fail(new NotFound({ entity: "authenticated user", id: email }));
    }
    const [existing] = yield* database(() =>
      db.select({ membership: eventMembers, user: { email: users.email, name: users.name } })
        .from(eventMembers)
        .innerJoin(users, eq(users.id, eventMembers.userId))
        .where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.userId, user.id)))
        .limit(1),
    );
    if (existing) {
      const member = memberOutput(existing as EventMemberRow);
      if (member.role !== input.role) {
        return yield* Effect.fail(new Conflict({ message: "This account is already an event member with a different role; use the role change action" }));
      }
      return { member, created: false, idempotent: true };
    }

    const occurredAt = new Date();
    const membership = {
      id: commandId("member"), eventId: event.id, userId: user.id, role: input.role,
      version: 1, createdAt: occurredAt, updatedAt: occurredAt,
    } as const;
    const member: EventMemberType = {
      id: membership.id, userId: user.id, email: normalizedEmail(user.email), name: user.name,
      role: input.role, version: 1, createdAt: occurredAt, updatedAt: occurredAt,
    };
    const output: AddEventMemberOutputType = { member, created: true, idempotent: false };
    const recordId = commandId("idempotency");
    const requestId = `event-member:${recordId}`;
    const commit = database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: recordId, eventId: event.id, operationId: "events.addMember", principalId: actor.userId,
        keyHash, requestHash, status: "completed", responseStatus: 201, responseBody: output,
        expiresAt: new Date(occurredAt.getTime() + 86_400_000), completedAt: occurredAt, createdAt: occurredAt,
      }),
      db.insert(eventMembers).values(membership),
      db.insert(domainChanges).values({
        id: commandId("change"), eventId: event.id, aggregateType: "eventMember", aggregateId: membership.id,
        aggregateVersion: 1, eventType: "events.member.added", audiences: [{ kind: "admins" }], payload: member,
        actorUserId: actor.userId, actorApiKeyId: null, requestId, idempotencyRecordId: recordId, occurredAt,
      }),
      db.insert(auditLog).values({
        id: commandId("audit"), eventId: event.id, requestId, actorUserId: actor.userId, actorApiKeyId: null,
        action: "events.addMember", resourceType: "eventMember", resourceId: membership.id, before: null,
        after: member, metadata: { addExistingUser: true, idempotencyRecordId: recordId }, occurredAt,
      }),
    ]));
    return yield* commit.pipe(
      Effect.as(output),
      Effect.catchAll((error) => replay(event.id, "events.addMember", actor.userId, keyHash, requestHash, AddEventMemberOutput).pipe(
        Effect.flatMap((stored) => stored ? Effect.succeed({ ...stored, idempotent: true }) : Effect.fail(error)),
      )),
    );
  });

export const updateEventMember = (
  input: UpdateEventMemberInput,
): Effect.Effect<UpdateEventMemberOutputType, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(input.eventId);
    const actor = yield* requireMemberManager(event.id);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({ memberId: input.memberId, role: input.role, expectedVersion: input.expectedVersion }));
    const prior = yield* replay(event.id, "events.updateMember", actor.userId, keyHash, requestHash, UpdateEventMemberOutput);
    if (prior) return { ...prior, idempotent: true };
    const existing = yield* loadMember(event.id, input.memberId);
    if (!existing) return yield* Effect.fail(new NotFound({ entity: "event member", id: input.memberId }));
    const before = memberOutput(existing);
    if (!mayManageRole(actor.role, before.role, input.role)) {
      return yield* Effect.fail(new Forbidden({ reason: "Only an owner can change owner or admin memberships" }));
    }
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Event member changed; reload before saving" }));
    }
    if (before.role === input.role) return { member: before, idempotent: true };
    if (before.role === "owner" && input.role !== "owner" && (yield* ownerCount(event.id)) <= 1) {
      return yield* Effect.fail(new Conflict({ message: "An event must retain at least one owner" }));
    }
    const occurredAt = new Date();
    const version = before.version + 1;
    const member = { ...before, role: input.role, version, updatedAt: occurredAt };
    const { db } = yield* Db;
    const [updated] = yield* database(() => db.update(eventMembers).set({ role: input.role, version, updatedAt: occurredAt })
      .where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.id, input.memberId), eq(eventMembers.version, input.expectedVersion))).returning());
    if (!updated) return yield* Effect.fail(new Conflict({ message: "Event member changed; reload before saving" }));
    const output: UpdateEventMemberOutputType = { member, idempotent: false };
    const recordId = commandId("idempotency");
    const requestId = `event-member:${recordId}`;
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values({ id: recordId, eventId: event.id, operationId: "events.updateMember", principalId: actor.userId, keyHash, requestHash, status: "completed", responseStatus: 200, responseBody: output, expiresAt: new Date(occurredAt.getTime() + 86_400_000), completedAt: occurredAt, createdAt: occurredAt }),
      db.insert(domainChanges).values({ id: commandId("change"), eventId: event.id, aggregateType: "eventMember", aggregateId: member.id, aggregateVersion: version, eventType: "events.member.updated", audiences: [{ kind: "admins" }], payload: member, actorUserId: actor.userId, actorApiKeyId: null, requestId, idempotencyRecordId: recordId, occurredAt }),
      db.insert(auditLog).values({ id: commandId("audit"), eventId: event.id, requestId, actorUserId: actor.userId, actorApiKeyId: null, action: "events.updateMember", resourceType: "eventMember", resourceId: member.id, before, after: member, metadata: { idempotencyRecordId: recordId }, occurredAt }),
    ]));
    return output;
  });

export const removeEventMember = (
  input: RemoveEventMemberInput,
): Effect.Effect<RemoveEventMemberOutputType, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const event = yield* findEvent(input.eventId);
    const actor = yield* requireMemberManager(event.id);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({ memberId: input.memberId, expectedVersion: input.expectedVersion }));
    const prior = yield* replay(event.id, "events.removeMember", actor.userId, keyHash, requestHash, RemoveEventMemberOutput);
    if (prior) return { ...prior, idempotent: true };
    const existing = yield* loadMember(event.id, input.memberId);
    if (!existing) return { memberId: input.memberId, deleted: false, idempotent: true };
    const before = memberOutput(existing);
    if (!mayManageRole(actor.role, before.role, "reviewer")) {
      return yield* Effect.fail(new Forbidden({ reason: "Only an owner can remove owner or admin memberships" }));
    }
    if (before.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Event member changed; reload before removing" }));
    }
    if (before.role === "owner" && (yield* ownerCount(event.id)) <= 1) {
      return yield* Effect.fail(new Conflict({ message: "An event must retain at least one owner" }));
    }
    const occurredAt = new Date();
    const { db } = yield* Db;
    const [deleted] = yield* database(() => db.delete(eventMembers)
      .where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.id, input.memberId), eq(eventMembers.version, input.expectedVersion))).returning());
    if (!deleted) return yield* Effect.fail(new Conflict({ message: "Event member changed; reload before removing" }));
    const output: RemoveEventMemberOutputType = { memberId: input.memberId, deleted: true, idempotent: false };
    const recordId = commandId("idempotency");
    const requestId = `event-member:${recordId}`;
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values({ id: recordId, eventId: event.id, operationId: "events.removeMember", principalId: actor.userId, keyHash, requestHash, status: "completed", responseStatus: 200, responseBody: output, expiresAt: new Date(occurredAt.getTime() + 86_400_000), completedAt: occurredAt, createdAt: occurredAt }),
      db.insert(domainChanges).values({ id: commandId("change"), eventId: event.id, aggregateType: "eventMember", aggregateId: before.id, aggregateVersion: before.version + 1, eventType: "events.member.removed", audiences: [{ kind: "admins" }], payload: { memberId: before.id, userId: before.userId }, actorUserId: actor.userId, actorApiKeyId: null, requestId, idempotencyRecordId: recordId, occurredAt }),
      db.insert(auditLog).values({ id: commandId("audit"), eventId: event.id, requestId, actorUserId: actor.userId, actorApiKeyId: null, action: "events.removeMember", resourceType: "eventMember", resourceId: before.id, before, after: null, metadata: { idempotencyRecordId: recordId }, occurredAt }),
    ]));
    return output;
  });
