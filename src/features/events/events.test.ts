import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type {
  ApiScope,
  BrowserSessionPrincipal,
  EventApiKeyPrincipal,
  EventRole,
} from "contracts/principal";
import {
  apiKeys,
  auditLog,
  domainChanges,
  eventMembers,
  events,
  mailDeliveries,
  mailDeliverySnapshots,
  reviewerInvitations,
} from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Exit, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Authorizer,
  type ApiKeyCredentials,
  type CurrentUser,
  type MailQueue,
  AppLayer,
  CurrentUser as CurrentUserTag,
  type Db,
} from "@/server/services";
import {
  addEventMember,
  applyTeamCopy,
  acceptReviewerInvitation,
  createEventApiKey,
  createEvent,
  createReviewerInvitation,
  getEvent,
  listEventMembers,
  listEventAccess,
  listEventApiKeys,
  listEvents,
  listReviewerInvitations,
  previewTeamCopy,
  removeEventMember,
  revokeEventApiKey,
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

type EventServiceRequirements = ApiKeyCredentials | Authorizer | CurrentUser | Db | MailQueue;

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
    await expect(runAs(owner, listEventAccess())).resolves.toEqual([{
      event: created,
      memberRole: "owner",
      staff: false,
      speakerPortal: false,
    }]);
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
      updateEvent(created.id, { expectedVersion: created.version, name: "Versioned event — first update" }),
    );
    const second = await runAs(
      owner,
      updateEvent(created.id, { expectedVersion: first.version, location: "Updated venue" }),
    );

    expect(first.version).toBe(created.version + 1);
    expect(second.version).toBe(first.version + 1);

    const persisted = await runAs(owner, getEvent(created.id));
    expect(persisted).toEqual(second);
    const changes = await drizzle(env.DB).select().from(domainChanges).where(eq(domainChanges.eventId, created.id));
    const audits = await drizzle(env.DB).select().from(auditLog).where(eq(auditLog.eventId, created.id));
    expect(changes.map(({ eventType, aggregateVersion }) => ({ eventType, aggregateVersion }))).toEqual([
      { eventType: "events.updated", aggregateVersion: first.version },
      { eventType: "events.updated", aggregateVersion: second.version },
    ]);
    expect(audits.map(({ action, before, after }) => ({
      action,
      beforeVersion: (before as { version: number }).version,
      afterVersion: (after as { version: number }).version,
    }))).toEqual([
      { action: "events.update", beforeVersion: created.version, afterVersion: first.version },
      { action: "events.update", beforeVersion: first.version, afterVersion: second.version },
    ]);
  });

  it("allows exactly one competing metadata writer and records evidence only for the winner", async () => {
    const created = await runAs(owner, createEvent({ name: "Concurrent event", slug: "concurrent-event" }));
    const competing = await Promise.all([
      runEitherAs(owner, updateEvent(created.id, { expectedVersion: created.version, location: "Writer A" })),
      runEitherAs(owner, updateEvent(created.id, { expectedVersion: created.version, location: "Writer B" })),
    ]);
    expect(competing.filter((result) => result._tag === "Right")).toHaveLength(1);
    expect(competing.filter((result) => result._tag === "Left")).toEqual([
      expect.objectContaining({ left: expect.objectContaining({ _tag: "Conflict" }) }),
    ]);
    const persisted = await runAs(owner, getEvent(created.id));
    expect(["Writer A", "Writer B"]).toContain(persisted.location);
    expect(persisted.version).toBe(created.version + 1);
    expect(await drizzle(env.DB).select().from(domainChanges).where(eq(domainChanges.eventId, created.id))).toHaveLength(1);
    expect(await drizzle(env.DB).select().from(auditLog).where(eq(auditLog.eventId, created.id))).toHaveLength(1);
  });

  it("fails with Conflict for a duplicate slug", async () => {
    await runAs(owner, createEvent({ name: "First", slug: "duplicate-event" }));
    await expectFailure(
      owner,
      createEvent({ name: "Second", slug: "duplicate-event" }),
      "Conflict",
    );
  });

  it("rejects invalid event date order with Validation", async () => {
    await expectFailure(
      owner,
      createEvent({
        name: "Invalid dates",
        slug: "invalid-create-dates",
        startsAt: Date.UTC(2026, 7, 24),
        endsAt: Date.UTC(2026, 7, 14),
      }),
      "Validation",
    );

    const created = await runAs(
      owner,
      createEvent({ name: "Valid dates", slug: "invalid-update-dates" }),
    );
    await expectFailure(
      owner,
      updateEvent(created.id, {
        expectedVersion: created.version,
        startsAt: Date.UTC(2026, 7, 24),
        endsAt: Date.UTC(2026, 7, 14),
      }),
      "Validation",
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
      updateEvent(created.id, { expectedVersion: created.version, name: "Owner changed" }),
    );
    expect(ownerUpdate.name).toBe("Owner changed");

    const adminUpdate = await runAs(
      admin,
      updateEvent(created.id, { expectedVersion: ownerUpdate.version, location: "Admin changed" }),
    );
    expect(adminUpdate.location).toBe("Admin changed");

    await expectFailure(
      reviewer,
      updateEvent(created.id, { expectedVersion: adminUpdate.version, name: "Reviewer changed" }),
      "Forbidden",
    );
    await expectFailure(
      outsider,
      updateEvent(created.id, { expectedVersion: adminUpdate.version, name: "Outsider changed" }),
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
    const issuedWriteKey = await runAs(owner, createEventApiKey({
      eventId: target.id,
      name: "Target writer",
      scopes: ["event:write"],
      expiresAt: Date.now() + 2 * 60 * 60_000,
    }));
    const writeKey = apiKeyPrincipal(issuedWriteKey.apiKey.id, target.id, ["event:write"]);
    const crossEventKey = apiKeyPrincipal("other-reader", other.id, [
      "event:read",
    ]);

    await expect(runAs(readKey, getEvent(target.id))).resolves.toEqual(target);
    await expect(runAs(readKey, listEvents())).resolves.toEqual([target]);
    await expectFailure(writeKey, getEvent(target.id), "Forbidden");
    await expectFailure(
      readKey,
      updateEvent(target.id, { expectedVersion: target.version, name: "Read key changed" }),
      "Forbidden",
    );

    const updated = await runAs(
      writeKey,
      updateEvent(target.id, { expectedVersion: target.version, name: "Write key changed" }),
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

  it("previews exact team creates, skips every existing member, and replays the audited copy", async () => {
    const previewOperation = operations.find((candidate) => candidate.id === "events.previewTeamCopy");
    const applyOperation = operations.find((candidate) => candidate.id === "events.applyTeamCopy");
    if (!previewOperation || !applyOperation) throw new Error("Team-copy operations missing");
    expect([previewOperation, applyOperation].every((operation) => !("mcp" in operation) && !("party" in operation))).toBe(true);

    const source = await runAs(owner, createEvent({ name: "Prior committee", slug: "prior-committee" }));
    const target = await runAs(owner, createEvent({ name: "Next committee", slug: "next-committee" }));
    await runAs(owner, addEventMember({ eventId: source.id, email: admin.email, role: "admin", idempotencyKey: "copy-source-admin" }));
    await runAs(owner, addEventMember({ eventId: source.id, email: reviewer.email, role: "reviewer", idempotencyKey: "copy-source-reviewer" }));
    await runAs(owner, addEventMember({ eventId: target.id, email: admin.email, role: "reviewer", idempotencyKey: "copy-target-existing-admin" }));

    const preview = await runAs(owner, previewTeamCopy({ eventId: target.id, sourceEventId: source.id }));
    expect(preview.create).toEqual([
      expect.objectContaining({ userId: reviewer.userId, email: reviewer.email, role: "reviewer", existingRole: null }),
    ]);
    expect(preview.skip).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: owner.userId, role: "owner", existingRole: "owner" }),
      expect.objectContaining({ userId: admin.userId, role: "admin", existingRole: "reviewer" }),
    ]));

    const input = { eventId: target.id, sourceEventId: source.id, idempotencyKey: "copy-prior-committee" } as const;
    const copied = await runAs(owner, applyTeamCopy(input));
    const replayed = await runAs(owner, applyTeamCopy(input));
    expect(copied).toMatchObject({ createdCount: 1, skippedCount: 2, idempotent: false });
    expect(copied.created).toEqual([expect.objectContaining({ userId: reviewer.userId, role: "reviewer" })]);
    expect(replayed).toEqual({ ...copied, idempotent: true });
    const members = await runAs(owner, listEventMembers({ eventId: target.id }));
    expect(members.find((member) => member.userId === admin.userId)?.role).toBe("reviewer");
    expect(members.filter((member) => member.userId === reviewer.userId)).toHaveLength(1);
    const audits = await drizzle(env.DB).select().from(auditLog).where(eq(auditLog.eventId, target.id));
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining([
      "events.copyTeam.member",
      "events.copyTeam",
    ]));
  });

  it("allows an admin over both events, denies cross-event authority gaps and API keys, and serializes a copy race", async () => {
    const source = await runAs(owner, createEvent({ name: "Admin copy source", slug: "admin-copy-source" }));
    const target = await runAs(owner, createEvent({ name: "Admin copy target", slug: "admin-copy-target" }));
    await runAs(owner, addEventMember({ eventId: source.id, email: admin.email, role: "admin", idempotencyKey: "admin-copy-source-admin" }));
    await runAs(owner, addEventMember({ eventId: target.id, email: admin.email, role: "admin", idempotencyKey: "admin-copy-target-admin" }));
    await runAs(owner, addEventMember({ eventId: source.id, email: reviewer.email, role: "reviewer", idempotencyKey: "admin-copy-source-reviewer" }));
    await expect(runAs(admin, previewTeamCopy({ eventId: target.id, sourceEventId: source.id }))).resolves.toMatchObject({ create: [expect.objectContaining({ userId: reviewer.userId })] });

    const raceInput = { eventId: target.id, sourceEventId: source.id, idempotencyKey: "admin-copy-race" } as const;
    const raced = await Promise.all([runAs(admin, applyTeamCopy(raceInput)), runAs(admin, applyTeamCopy(raceInput))]);
    expect(raced.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(raced[0]?.createdCount).toBe(1);
    expect(await runAs(admin, listEventMembers({ eventId: target.id }))).toContainEqual(expect.objectContaining({ userId: reviewer.userId, role: "reviewer" }));

    const competingSource = await runAs(owner, createEvent({ name: "Competing copy source", slug: "competing-copy-source" }));
    const competingTarget = await runAs(owner, createEvent({ name: "Competing copy target", slug: "competing-copy-target" }));
    await runAs(owner, addEventMember({ eventId: competingSource.id, email: outsider.email, role: "reviewer", idempotencyKey: "competing-copy-reviewer" }));
    const competing = await Promise.all([
      runAs(owner, applyTeamCopy({ eventId: competingTarget.id, sourceEventId: competingSource.id, idempotencyKey: "competing-copy-a" })),
      runAs(owner, applyTeamCopy({ eventId: competingTarget.id, sourceEventId: competingSource.id, idempotencyKey: "competing-copy-b" })),
    ]);
    expect(competing.map((result) => result.createdCount).sort()).toEqual([0, 1]);
    const competingMembers = await runAs(owner, listEventMembers({ eventId: competingTarget.id }));
    expect(competingMembers.filter((member) => member.userId === outsider.userId)).toHaveLength(1);

    const inaccessibleSource = await runAs(secondOwner, createEvent({ name: "Private copy source", slug: "private-copy-source" }));
    await expectFailure(admin, previewTeamCopy({ eventId: target.id, sourceEventId: inaccessibleSource.id }), "Forbidden");
    await expectFailure(
      apiKeyPrincipal("team-copy-key", target.id, ["event:read", "event:write"]),
      previewTeamCopy({ eventId: target.id, sourceEventId: source.id }),
      "Forbidden",
    );
  });

  it("queues a reviewer invitation and securely accepts it into the existing reviewer membership", async () => {
    const created = await runAs(owner, createEvent({ name: "Reviewer invite", slug: "reviewer-invite" }));
    const input = {
      eventId: created.id,
      email: `  ${outsider.email.toUpperCase()}  `,
      idempotencyKey: "reviewer-invitation-create-1",
      requestId: "request-reviewer-invitation-create-1",
    } as const;
    const invited = await runAs(owner, createReviewerInvitation(input));
    expect(invited).toMatchObject({
      invitation: { email: outsider.email, status: "pending", deliveryStatus: "pending", version: 1 },
      idempotent: false,
    });
    const duplicate = await runAs(owner, createReviewerInvitation({
      ...input,
      idempotencyKey: "reviewer-invitation-create-duplicate",
      requestId: "request-reviewer-invitation-create-duplicate",
    }));
    expect(duplicate).toMatchObject({ invitation: { id: invited.invitation.id }, idempotent: true });
    await expect(runAs(owner, createReviewerInvitation({
      ...input,
      idempotencyKey: "reviewer-invitation-create-duplicate",
      requestId: "request-reviewer-invitation-create-duplicate-replay",
    }))).resolves.toEqual(duplicate);

    const db = drizzle(env.DB);
    const [stored] = await db.select({
      invitation: reviewerInvitations,
      delivery: mailDeliveries,
      snapshot: mailDeliverySnapshots,
    })
      .from(reviewerInvitations)
      .innerJoin(mailDeliveries, eq(mailDeliveries.id, reviewerInvitations.deliveryId))
      .innerJoin(mailDeliverySnapshots, eq(mailDeliverySnapshots.id, mailDeliveries.snapshotId))
      .where(eq(reviewerInvitations.id, invited.invitation.id));
    expect(stored?.invitation.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.snapshot.eventId).toBe(created.id);
    expect(stored?.snapshot.recipientEmail).toBe(outsider.email);
    expect(stored?.delivery.idempotencyKey).toBe(`auth-reviewer-invitation:${invited.invitation.id}`);
    const tokenMatch = stored?.snapshot.renderedText?.match(/[?&]token=([^\s&]+)/);
    const rawToken = tokenMatch ? decodeURIComponent(tokenMatch[1]!) : "";
    expect(rawToken).toMatch(/^reviewer_inv_/);
    expect(stored?.invitation.tokenHash).not.toBe(rawToken);

    await expectFailure(reviewer, acceptReviewerInvitation({
      token: rawToken,
      idempotencyKey: "reviewer-invitation-wrong-user",
      requestId: "request-reviewer-invitation-wrong-user",
    }), "Forbidden");

    const acceptanceInput = {
      token: rawToken,
      idempotencyKey: "reviewer-invitation-accept-1",
      requestId: "request-reviewer-invitation-accept-1",
    } as const;
    const concurrentAcceptances = await Promise.all([
      runAs(outsider, acceptReviewerInvitation(acceptanceInput)),
      runAs(outsider, acceptReviewerInvitation(acceptanceInput)),
    ]);
    expect(concurrentAcceptances.map((result) => result.idempotent).sort()).toEqual([false, true]);
    const accepted = concurrentAcceptances.find((result) => !result.idempotent)!;
    const replayed = await runAs(outsider, acceptReviewerInvitation(acceptanceInput));
    expect(accepted).toMatchObject({
      invitationId: invited.invitation.id,
      eventId: created.id,
      eventSlug: created.slug,
      member: { userId: outsider.userId, email: outsider.email, role: "reviewer", version: 1 },
      idempotent: false,
    });
    expect(replayed).toEqual({ ...accepted, idempotent: true });
    expect(await runAs(owner, listReviewerInvitations({ eventId: created.id }))).toContainEqual(expect.objectContaining({
      id: invited.invitation.id,
      status: "accepted",
    }));
    expect(await runAs(owner, listEventMembers({ eventId: created.id }))).toContainEqual(expect.objectContaining({
      userId: outsider.userId,
      role: "reviewer",
    }));
    const changes = await db.select().from(domainChanges).where(eq(domainChanges.eventId, created.id));
    const audits = await db.select().from(auditLog).where(eq(auditLog.eventId, created.id));
    expect(changes.map((change) => change.eventType)).toEqual(expect.arrayContaining([
      "events.reviewerInvitation.created",
      "events.reviewerInvitation.accepted",
    ]));
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining([
      "events.createReviewerInvitation",
      "events.acceptReviewerInvitation",
    ]));
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

  it("creates, lists, and revokes event-bound API keys without persisting the bearer secret", async () => {
    const created = await runAs(owner, createEvent({ name: "MCP access", slug: "mcp-access" }));
    const issued = await runAs(owner, createEventApiKey({
      eventId: created.id,
      name: "Agenda automation",
      scopes: ["event:read", "agenda:read", "agenda:write"],
      expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
    }));

    expect(issued.secret).toMatch(/^spk_[0-9a-f]{64}$/);
    expect(issued.apiKey).toMatchObject({
      name: "Agenda automation", scopes: ["event:read", "agenda:read", "agenda:write"],
      revokedAt: null, version: 1,
    });
    expect(JSON.stringify(issued.apiKey)).not.toContain(issued.secret);

    const db = drizzle(env.DB);
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, issued.apiKey.id));
    expect(stored?.eventId).toBe(created.id);
    expect(stored?.createdBy).toBe(owner.userId);
    expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.keyHash).not.toBe(issued.secret);

    const listed = await runAs(owner, listEventApiKeys({ eventId: created.id }));
    expect(listed).toEqual([issued.apiKey]);
    expect(JSON.stringify(listed)).not.toContain(issued.secret);

    const revoked = await runAs(owner, revokeEventApiKey({
      eventId: created.id, apiKeyId: issued.apiKey.id, expectedVersion: 1,
    }));
    expect(revoked).toMatchObject({ id: issued.apiKey.id, version: 2 });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    await expectFailure(owner, revokeEventApiKey({
      eventId: created.id, apiKeyId: issued.apiKey.id, expectedVersion: 1,
    }), "Conflict");

    const audits = await db.select().from(auditLog).where(eq(auditLog.eventId, created.id));
    expect(audits.map(({ action }) => action)).toEqual(expect.arrayContaining([
      "events.createApiKey", "events.revokeApiKey",
    ]));
    expect(JSON.stringify(audits)).not.toContain(issued.secret);
  });

  it("keeps API-key management browser-only and limited to owners and admins", async () => {
    const created = await runAs(owner, createEvent({ name: "Guarded MCP", slug: "guarded-mcp" }));
    await addMember(created.id, admin.userId, "admin");
    await addMember(created.id, reviewer.userId, "reviewer");
    const input = {
      eventId: created.id,
      name: "Read access",
      scopes: ["event:read"] as const,
      expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
    };

    const adminIssued = await runAs(admin, createEventApiKey(input));
    expect(adminIssued.apiKey.scopes).toEqual(["event:read"]);
    await expectFailure(reviewer, createEventApiKey(input), "Forbidden");
    await expectFailure(outsider, listEventApiKeys({ eventId: created.id }), "Forbidden");
    await expectFailure(apiKeyPrincipal("self-managing", created.id, ["event:read", "event:write"]), createEventApiKey(input), "Forbidden");
  });
});
