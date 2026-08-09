import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type {
  ApiScope,
  BrowserSessionPrincipal,
  EventApiKeyPrincipal,
  EventRole,
} from "contracts/principal";
import { auditLog, domainChanges, eventMembers, events } from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Exit, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Authorizer,
  type CurrentUser,
  AppLayer,
  CurrentUser as CurrentUserTag,
  type Db,
} from "@/server/services";
import {
  addEventMember,
  createEvent,
  getEvent,
  listEventMembers,
  listEvents,
  removeEventMember,
  updateEvent,
  updateEventMember,
} from "./service";
import { operations } from "./operations";
import { operationEffect, runEffect } from "@/server/adapt";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

function hasTestMigrations(env: Cloudflare.Env): env is TestEnv {
  return "TEST_MIGRATIONS" in env;
}

const expiresAt = Date.UTC(2100, 0, 1);

const browserPrincipal = (
  userId: string,
  name: string,
): BrowserSessionPrincipal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name,
  sessionId: `session-${userId}`,
  expiresAt,
});

const apiKeyPrincipal = (
  apiKeyId: string,
  eventId: string,
  scopes: readonly ApiScope[],
): EventApiKeyPrincipal => ({
  kind: "api-key",
  userId: `api-key:${apiKeyId}`,
  apiKeyId,
  eventId,
  name: apiKeyId,
  scopes,
  expiresAt,
});

const owner = browserPrincipal("user-owner", "Owner");
const admin = browserPrincipal("user-admin", "Admin");
const reviewer = browserPrincipal("user-reviewer", "Reviewer");
const outsider = browserPrincipal("user-outsider", "Outsider");
const secondOwner = browserPrincipal("user-second-owner", "Second owner");

type EventServiceRequirements = Authorizer | CurrentUser | Db;

const runEitherAs = <A, E>(
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<A, E, EventServiceRequirements>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.either,
      Effect.provide(
        Layer.merge(AppLayer(env), Layer.succeed(CurrentUserTag, principal)),
      ),
    ),
  );

const describeFailure = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return String(error);
  }
  const tagged = error as { readonly _tag: unknown; readonly detail?: unknown };
  return typeof tagged.detail === "string"
    ? `${String(tagged._tag)}: ${tagged.detail}`
    : String(tagged._tag);
};

const runAs = async <A>(
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<A, AppError, EventServiceRequirements>,
): Promise<A> => {
  const result = await runEitherAs(principal, effect);
  if (result._tag === "Left") {
    throw new Error(`Unexpected Effect failure (${describeFailure(result.left)})`);
  }
  return result.right;
};

const expectFailure = async (
  principal: BrowserSessionPrincipal | EventApiKeyPrincipal,
  effect: Effect.Effect<unknown, AppError, EventServiceRequirements>,
  tag: AppError["_tag"],
): Promise<AppError> => {
  const result = await runEitherAs(principal, effect);
  if (result._tag === "Right") {
    throw new Error(`Expected ${tag}, but the Effect succeeded`);
  }
  expect(result.left._tag).toBe(tag);
  return result.left;
};

const addMember = async (eventId: string, userId: string, role: EventRole) => {
  const now = new Date();
  await drizzle(env.DB)
    .insert(eventMembers)
    .values({
      id: `member-${eventId}-${userId}`,
      eventId,
      userId,
      role,
      createdAt: now,
      updatedAt: now,
    })
    .run();
};

beforeAll(async () => {
  if (!hasTestMigrations(env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }

  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);

  const now = Date.now();
  await env.DB.batch(
    [owner, admin, reviewer, outsider, secondOwner].map((principal) =>
      env.DB
        .prepare(
          "insert or ignore into users (id, email, name, created_at, updated_at) values (?, ?, ?, ?, ?)",
        )
        .bind(principal.userId, principal.email, principal.name, now, now),
    ),
  );
});

describe("events service", () => {
  it("creates, lists, and gets an event for its owner", async () => {
    const created = await runAs(
      owner,
      createEvent({ name: "Effect Summit", slug: "effect-summit" }),
    );

    expect(created.slug).toBe("effect-summit");
    await expect(runAs(owner, listEvents())).resolves.toEqual([created]);
    await expect(runAs(owner, getEvent(created.id))).resolves.toEqual(created);
    await expect(runAs(owner, getEvent(created.slug))).resolves.toEqual(created);
  });

  it("increments the event version on every successful metadata update", async () => {
    const created = await runAs(
      owner,
      createEvent({ name: "Versioned event", slug: "versioned-event" }),
    );

    const first = await runAs(
      owner,
      updateEvent(created.id, { name: "Versioned event — first update" }),
    );
    const second = await runAs(
      owner,
      updateEvent(created.id, { location: "Updated venue" }),
    );

    expect(first.version).toBe(created.version + 1);
    expect(second.version).toBe(first.version + 1);

    const persisted = await runAs(owner, getEvent(created.id));
    expect(persisted).toEqual(second);
  });

  it("fails with Conflict for a duplicate slug", async () => {
    await runAs(owner, createEvent({ name: "First", slug: "duplicate-event" }));
    await expectFailure(
      owner,
      createEvent({ name: "Second", slug: "duplicate-event" }),
      "Conflict",
    );
  });

  it("allows owner and admin writes but denies reviewer and nonmember writes", async () => {
    const created = await runAs(
      owner,
      createEvent({ name: "Private", slug: "private-event" }),
    );
    await addMember(created.id, admin.userId, "admin");
    await addMember(created.id, reviewer.userId, "reviewer");
    await expect(runAs(reviewer, getEvent(created.id))).resolves.toEqual(created);
    await expectFailure(outsider, getEvent(created.id), "Forbidden");
    await expectFailure(outsider, getEvent(created.slug), "Forbidden");
    await expect(runAs(outsider, listEvents())).resolves.toEqual([]);

    const ownerUpdate = await runAs(
      owner,
      updateEvent(created.id, { name: "Owner changed" }),
    );
    expect(ownerUpdate.name).toBe("Owner changed");

    const adminUpdate = await runAs(
      admin,
      updateEvent(created.id, { location: "Admin changed" }),
    );
    expect(adminUpdate.location).toBe("Admin changed");

    await expectFailure(
      reviewer,
      updateEvent(created.id, { name: "Reviewer changed" }),
      "Forbidden",
    );
    await expectFailure(
      outsider,
      updateEvent(created.id, { name: "Outsider changed" }),
      "Forbidden",
    );

    const db = drizzle(env.DB);
    const memberships = await db
      .select()
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.eventId, created.id),
          eq(eventMembers.userId, outsider.userId),
        ),
      );
    expect(memberships).toHaveLength(0);

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, created.id))
      .limit(1);
    expect(event?.name).toBe(ownerUpdate.name);
  });

  it("requires exact API-key scopes and rejects cross-event keys", async () => {
    const target = await runAs(
      owner,
      createEvent({ name: "Target", slug: "key-target" }),
    );
    const other = await runAs(
      owner,
      createEvent({ name: "Other", slug: "key-other" }),
    );
    const readKey = apiKeyPrincipal("target-reader", target.id, ["event:read"]);
    const writeKey = apiKeyPrincipal("target-writer", target.id, [
      "event:write",
    ]);
    const crossEventKey = apiKeyPrincipal("other-reader", other.id, [
      "event:read",
    ]);

    await expect(runAs(readKey, getEvent(target.id))).resolves.toEqual(target);
    await expect(runAs(readKey, listEvents())).resolves.toEqual([target]);
    await expectFailure(writeKey, getEvent(target.id), "Forbidden");
    await expectFailure(
      readKey,
      updateEvent(target.id, { name: "Read key changed" }),
      "Forbidden",
    );

    const updated = await runAs(
      writeKey,
      updateEvent(target.id, { name: "Write key changed" }),
    );
    expect(updated.name).toBe("Write key changed");

    await expectFailure(crossEventKey, getEvent(target.id), "Forbidden");
    await expectFailure(
      apiKeyPrincipal("creator", target.id, ["event:read", "event:write"]),
      createEvent({ name: "Key-created", slug: "key-created" }),
      "Forbidden",
    );
  });

  it("adds an existing user by normalized email, lists it, and records replayable evidence", async () => {
    const created = await runAs(owner, createEvent({ name: "Members", slug: "event-members" }));
    const first = await runAs(owner, addEventMember({
      eventId: created.id,
      email: `  ${reviewer.email.toUpperCase()}  `,
      role: "reviewer",
      idempotencyKey: "event-members-add-reviewer",
    }));
    expect(first.created).toBe(true);
    expect(first.member.email).toBe(reviewer.email);
    const replayed = await runAs(owner, addEventMember({
      eventId: created.id,
      email: reviewer.email,
      role: "reviewer",
      idempotencyKey: "event-members-add-reviewer",
    }));
    expect(replayed).toMatchObject({ created: true, idempotent: true, member: { id: first.member.id } });
    const listed = await runAs(owner, listEventMembers({ eventId: created.id }));
    expect(listed.map((member) => member.email)).toEqual([owner.email, reviewer.email]);
    const db = drizzle(env.DB);
    const changes = await db.select().from(domainChanges).where(eq(domainChanges.eventId, created.id));
    const audits = await db.select().from(auditLog).where(eq(auditLog.eventId, created.id));
    expect(changes.some((change) => change.eventType === "events.member.added")).toBe(true);
    expect(audits.some((audit) => audit.action === "events.addMember")).toBe(true);
  });

  it("authorizes member management at the operation boundary with canonical eventId", async () => {
    const created = await runAs(owner, createEvent({ name: "Member adapter", slug: "member-adapter" }));
    const operation = operations.find((candidate) => candidate.id === "events.listMembers");
    if (!operation) throw new Error("events.listMembers operation missing");

    const exit = await runEffect(env, owner, operationEffect(operation, {
      eventId: created.id,
    }, owner));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: owner.userId, role: "owner" }),
      ]));
    }
  });

  it("keeps owner/admin escalation, tenant boundaries, and last-owner safety intact", async () => {
    const created = await runAs(owner, createEvent({ name: "Guarded", slug: "guarded-members" }));
    await runAs(owner, addEventMember({
      eventId: created.id, email: admin.email, role: "admin", idempotencyKey: "guarded-add-admin",
    }));
    await expectFailure(admin, addEventMember({
      eventId: created.id, email: reviewer.email, role: "admin", idempotencyKey: "admin-escalation",
    }), "Forbidden");
    const reviewerMember = await runAs(admin, addEventMember({
      eventId: created.id, email: reviewer.email, role: "reviewer", idempotencyKey: "admin-add-reviewer",
    }));
    await expectFailure(admin, updateEventMember({
      eventId: created.id, memberId: reviewerMember.member.id, role: "admin", expectedVersion: 1,
      idempotencyKey: "admin-promote-reviewer",
    }), "Forbidden");
    const other = await runAs(owner, createEvent({ name: "Other guarded", slug: "other-guarded-members" }));
    const foreignMember = await runAs(owner, addEventMember({
      eventId: other.id, email: outsider.email, role: "reviewer", idempotencyKey: "other-event-reviewer",
    }));
    await expectFailure(owner, updateEventMember({
      eventId: created.id, memberId: foreignMember.member.id, role: "admin", expectedVersion: 1,
      idempotencyKey: "missing-member-is-not-cross-tenant",
    }), "NotFound");
    const ownerMember = (await runAs(owner, listEventMembers({ eventId: created.id })))
      .find((member) => member.userId === owner.userId)!;
    await expectFailure(owner, removeEventMember({
      eventId: created.id, memberId: ownerMember.id, expectedVersion: ownerMember.version,
      idempotencyKey: "cannot-delete-last-owner",
    }), "Conflict");
    const updated = await runAs(owner, updateEventMember({
      eventId: created.id, memberId: reviewerMember.member.id, role: "admin", expectedVersion: 1,
      idempotencyKey: "owner-promote-reviewer",
    }));
    expect(updated.member).toMatchObject({ role: "admin", version: 2 });
    await expectFailure(owner, updateEventMember({
      eventId: created.id, memberId: reviewerMember.member.id, role: "reviewer", expectedVersion: 1,
      idempotencyKey: "stale-member-update",
    }), "Conflict");
  });

  it("allows owner transfer before removal and makes a completed removal replayable", async () => {
    const created = await runAs(owner, createEvent({ name: "Transfer", slug: "member-transfer" }));
    await runAs(owner, addEventMember({
      eventId: created.id, email: secondOwner.email, role: "owner", idempotencyKey: "transfer-add-owner",
    }));
    const members = await runAs(owner, listEventMembers({ eventId: created.id }));
    const ownerMember = members.find((member) => member.userId === secondOwner.userId)!;
    const removed = await runAs(owner, removeEventMember({
      eventId: created.id, memberId: ownerMember.id, expectedVersion: ownerMember.version,
      idempotencyKey: "transfer-remove-owner",
    }));
    expect(removed).toMatchObject({ deleted: true, idempotent: false });
    const replayed = await runAs(owner, removeEventMember({
      eventId: created.id, memberId: ownerMember.id, expectedVersion: ownerMember.version,
      idempotencyKey: "transfer-remove-owner",
    }));
    expect(replayed).toMatchObject({ deleted: true, idempotent: true });
  });
});
