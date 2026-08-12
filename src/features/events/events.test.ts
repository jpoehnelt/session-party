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
  emailTemplates,
  embeds,
  eventMembers,
  events,
  formFields,
  formVersionFields,
  formVersions,
  forms,
  integrations,
  mailDeliveries,
  mailDeliverySnapshots,
  pages,
  reviewRounds,
  reviews,
  reviewerInvitations,
  rooms,
  speakers,
  submissions,
  talks,
  tasks,
  tracks,
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
  applyEventClone,
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
  previewEventClone,
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

  it("previews and concurrently replays an exact structure-only clone without public or operational state", async () => {
    const source = await runAs(owner, createEvent({
      name: "Published 2026 edition",
      slug: "published-2026-edition",
      description: "Reusable event structure",
      location: "Denver",
      timezone: "America/Denver",
      startsAt: Date.UTC(2026, 8, 10, 15),
      endsAt: Date.UTC(2026, 8, 11, 23),
      accentColor: "#635BFF",
    }));
    await runAs(owner, addEventMember({
      eventId: source.id,
      email: reviewer.email,
      role: "reviewer",
      idempotencyKey: "clone-source-reviewer",
    }));
    const db = drizzle(env.DB);
    const now = new Date("2026-08-12T14:00:00.000Z");
    await db.batch([
      db.insert(forms).values({
        id: "clone-source-form", eventId: source.id, kind: "cfp", name: "Published CFP",
        description: "Published source form", status: "open", opensAt: now, closesAt: new Date(now.getTime() + 86_400_000),
        version: 3, createdAt: now, updatedAt: now,
      }),
      db.insert(formFields).values([
        {
          id: "clone-source-title", eventId: source.id, formId: "clone-source-form", order: 1,
          type: "text", label: "Session title", semanticKey: "submissionTitle", required: true,
          options: [], logic: null, routing: {}, version: 2, createdAt: now, updatedAt: now,
        },
        {
          id: "clone-source-track", eventId: source.id, formId: "clone-source-form", order: 2,
          type: "select", label: "Track", semanticKey: null, required: true,
          options: ["Systems", "Tools"],
          logic: { action: "show", mode: "all", conditions: [{ fieldId: "clone-source-title", op: "not_empty" }] },
          routing: { Systems: "Systems", Tools: "Tools" }, version: 2, createdAt: now, updatedAt: now,
        },
      ]),
      db.insert(formVersions).values({
        id: "clone-source-form-v2", eventId: source.id, formId: "clone-source-form", versionNumber: 2,
        name: "Published CFP v2", description: "Immutable source version", publishedAt: now, createdAt: now,
      }),
      db.insert(formVersionFields).values([
        {
          id: "clone-source-title-v2", eventId: source.id, formVersionId: "clone-source-form-v2",
          sourceFieldId: "clone-source-title", order: 1, type: "text", label: "Session title",
          semanticKey: "submissionTitle", required: true, options: [], logic: null, routing: {}, createdAt: now,
        },
        {
          id: "clone-source-track-v2", eventId: source.id, formVersionId: "clone-source-form-v2",
          sourceFieldId: "clone-source-track", order: 2, type: "select", label: "Track",
          semanticKey: null, required: true, options: ["Systems", "Tools"],
          logic: { action: "show", mode: "all", conditions: [{ fieldId: "clone-source-title", op: "not_empty" }] },
          routing: { Systems: "Systems", Tools: "Tools" }, createdAt: now,
        },
      ]),
      db.insert(reviewRounds).values({
        id: "clone-source-round", eventId: source.id, name: "Program review", order: 1,
        status: "active", startsAt: now, endsAt: new Date(now.getTime() + 86_400_000), blind: true,
        rubric: { criteria: [{ key: "fit", label: "Fit", max: 5 }] }, version: 2, createdAt: now, updatedAt: now,
      }),
      db.insert(tracks).values({ id: "clone-source-track-record", eventId: source.id, name: "Systems", color: "#635BFF", order: 1, version: 2, createdAt: now, updatedAt: now }),
      db.insert(rooms).values({ id: "clone-source-room", eventId: source.id, name: "Main stage", capacity: 300, order: 1, version: 2, createdAt: now, updatedAt: now }),
      db.insert(tasks).values({
        id: "clone-source-task", eventId: source.id, name: "Travel form", description: "Collect logistics",
        kind: "form", formId: "clone-source-form", dueAt: new Date(now.getTime() + 172_800_000), order: 1,
        targetMode: "selected", version: 2, createdAt: now, updatedAt: now,
      }),
      db.insert(pages).values({
        id: "clone-source-page", eventId: source.id, slug: "speaker-guide", title: "Speaker guide",
        body: "Reusable guide", htmlEmbed: null, audience: "public", order: 1, version: 2, createdAt: now, updatedAt: now,
      }),
      db.insert(emailTemplates).values({
        id: "clone-source-template", eventId: source.id, name: "Acceptance",
        subject: "Welcome {{speaker.name}}", body: "Join {{event.name}} at {{event.startsAt}}.",
        attachIcs: true, version: 2, createdAt: now, updatedAt: now,
      }),
      db.insert(submissions).values({
        id: "clone-source-submission", eventId: source.id, formId: "clone-source-form",
        formVersionId: "clone-source-form-v2", title: "State must not clone", status: "accepted",
        submittedAt: now, acceptedAt: now, version: 2, createdAt: now, updatedAt: now,
      }),
      db.insert(speakers).values({
        id: "clone-source-speaker", eventId: source.id, contactEmail: "clone-speaker@example.com",
        displayName: "Source speaker", profileReviewStatus: "approved", version: 2, createdAt: now, updatedAt: now,
      }),
      db.insert(reviews).values({
        id: "clone-source-review", eventId: source.id, roundId: "clone-source-round",
        submissionId: "clone-source-submission", reviewerUserId: reviewer.userId, ai: false,
        score: 5, scores: { fit: 5 }, comment: "Source-only review", version: 1, createdAt: now, updatedAt: now,
      }),
      db.insert(talks).values({
        id: "clone-source-talk", eventId: source.id, submissionId: "clone-source-submission",
        title: "Placed source talk", trackId: "clone-source-track-record", roomId: "clone-source-room",
        startsAt: new Date(Date.UTC(2026, 8, 10, 16)), durationMin: 30, status: "confirmed",
        version: 2, createdAt: now, updatedAt: now,
      }),
      db.insert(embeds).values({
        id: "clone-source-embed", eventId: source.id, name: "Published schedule", widget: "schedule",
        preset: "agenda", aesthetic: "bold", accent: "#635BFF", trackId: null, track: null,
        fields: ["title", "time"], enabled: true, version: 1, createdAt: now, updatedAt: now,
      }),
      db.insert(integrations).values({
        id: "clone-source-integration", eventId: source.id, kind: "airtable", secretRef: "AIRTABLE_PAT",
        config: { baseId: "appSource" }, version: 1, createdAt: now, updatedAt: now,
      }),
      db.insert(mailDeliverySnapshots).values({
        id: "clone-source-delivery", eventId: source.id, templateId: "clone-source-template",
        recipientEmail: "recipient@example.com", fromEmail: "events@example.com", subject: "Delivered source",
        renderedHtml: "<p>Source only</p>", renderedText: "Source only", createdAt: now,
      }),
      db.insert(domainChanges).values({
        id: "clone-source-agenda-publication", eventId: source.id, aggregateType: "agenda-publication",
        aggregateId: source.id, aggregateVersion: 1, eventType: "agenda.published",
        audiences: [{ kind: "admins" }], payload: { revision: 1 }, actorUserId: owner.userId,
        actorApiKeyId: null, requestId: "clone-source-publication", idempotencyRecordId: null, occurredAt: now,
      }),
    ]);
    await runAs(owner, createEventApiKey({
      eventId: source.id,
      name: "Source key",
      scopes: ["event:read"],
      expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
    }));

    const target = {
      eventId: source.id,
      name: "Published 2027 edition",
      slug: "published-2027-edition",
      startsAt: Date.UTC(2027, 8, 9, 15),
      endsAt: Date.UTC(2027, 8, 10, 23),
      includeTeam: true,
    } as const;
    const preview = await runAs(owner, previewEventClone(target));
    expect(preview.collections).toEqual([
      { collection: "forms", count: 1 },
      { collection: "formFields", count: 2 },
      { collection: "reviewRounds", count: 1 },
      { collection: "taskTemplates", count: 1 },
      { collection: "resourcePages", count: 1 },
      { collection: "tracks", count: 1 },
      { collection: "rooms", count: 1 },
      { collection: "messageTemplates", count: 1 },
      { collection: "teamMemberships", count: 1 },
    ]);
    expect(preview.excluded).toEqual([
      { collection: "submissions", sourceCount: 1 },
      { collection: "reviews", sourceCount: 1 },
      { collection: "decisions", sourceCount: 1 },
      { collection: "speakers", sourceCount: 1 },
      { collection: "agendaPlacements", sourceCount: 1 },
      { collection: "publishedFormVersions", sourceCount: 1 },
      { collection: "publishedAgendaRevisions", sourceCount: 1 },
      { collection: "embeds", sourceCount: 1 },
      { collection: "deliveries", sourceCount: 1 },
      { collection: "apiKeys", sourceCount: 1 },
      { collection: "integrations", sourceCount: 1 },
    ]);
    const cloneInput = {
      ...target,
      expectedSourceVersion: preview.sourceVersion,
      expectedStructureFingerprint: preview.structureFingerprint,
      idempotencyKey: "clone-published-edition-replay",
    } as const;
    const raced = await Promise.all([
      runAs(owner, applyEventClone(cloneInput)),
      runAs(owner, applyEventClone(cloneInput)),
    ]);
    expect(raced.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(new Set(raced.map((result) => result.event.id)).size).toBe(1);
    const cloned = raced[0]!.event;
    await expect(runAs(owner, applyEventClone(cloneInput))).resolves.toEqual({ ...raced[0], idempotent: true });
    expect(await db.select().from(events).where(eq(events.slug, target.slug))).toHaveLength(1);

    const [clonedForm] = await db.select().from(forms).where(eq(forms.eventId, cloned.id));
    expect(clonedForm).toMatchObject({
      name: "Published CFP v2", status: "draft", opensAt: null, closesAt: null,
      clonedFromEventId: source.id, clonedFromFormId: "clone-source-form", clonedFromVersion: 2, version: 1,
    });
    expect(await db.select().from(formVersions).where(eq(formVersions.eventId, cloned.id))).toHaveLength(0);
    const clonedFieldRows = await db.select().from(formFields).where(eq(formFields.eventId, cloned.id));
    expect(clonedFieldRows).toHaveLength(2);
    expect(clonedFieldRows.map((field) => field.semanticKey)).toContain("submissionTitle");
    const titleField = clonedFieldRows.find((field) => field.semanticKey === "submissionTitle")!;
    const dependentField = clonedFieldRows.find((field) => field.semanticKey === null)!;
    const dependentLogic = typeof dependentField.logic === "string"
      ? JSON.parse(dependentField.logic) as { conditions: readonly { fieldId: string }[] }
      : dependentField.logic as { conditions: readonly { fieldId: string }[] };
    expect(dependentLogic.conditions[0]?.fieldId).toBe(titleField.id);
    const [clonedTask] = await db.select().from(tasks).where(eq(tasks.eventId, cloned.id));
    expect(clonedTask).toMatchObject({ formId: clonedForm!.id, dueAt: null, targetMode: "selected" });
    await expect(db.select().from(reviewRounds).where(eq(reviewRounds.eventId, cloned.id))).resolves.toEqual([
      expect.objectContaining({ status: "pending", startsAt: null, endsAt: null, blind: true }),
    ]);
    await expect(db.select().from(emailTemplates).where(eq(emailTemplates.eventId, cloned.id))).resolves.toEqual([
      expect.objectContaining({ subject: "Welcome {{speaker.name}}", body: "Join {{event.name}} at {{event.startsAt}}." }),
    ]);
    await expect(runAs(owner, listEventMembers({ eventId: cloned.id }))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: owner.userId, role: "owner" }),
      expect.objectContaining({ userId: reviewer.userId, role: "reviewer" }),
    ]));

    const excludedTargetRows = await Promise.all([
      db.select().from(submissions).where(eq(submissions.eventId, cloned.id)),
      db.select().from(reviews).where(eq(reviews.eventId, cloned.id)),
      db.select().from(speakers).where(eq(speakers.eventId, cloned.id)),
      db.select().from(talks).where(eq(talks.eventId, cloned.id)),
      db.select().from(embeds).where(eq(embeds.eventId, cloned.id)),
      db.select().from(mailDeliverySnapshots).where(eq(mailDeliverySnapshots.eventId, cloned.id)),
      db.select().from(apiKeys).where(eq(apiKeys.eventId, cloned.id)),
      db.select().from(integrations).where(eq(integrations.eventId, cloned.id)),
    ]);
    expect(excludedTargetRows.every((rows) => rows.length === 0)).toBe(true);
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, cloned.id),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ))).toHaveLength(0);
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, source.id),
      eq(domainChanges.aggregateType, "agenda-publication"),
    ))).toEqual([expect.objectContaining({ id: "clone-source-agenda-publication", aggregateVersion: 1 })]);
    expect(await db.select().from(talks).where(eq(talks.eventId, source.id))).toEqual([
      expect.objectContaining({ id: "clone-source-talk", status: "confirmed" }),
    ]);
    await expect(db.select().from(auditLog).where(and(
      eq(auditLog.eventId, cloned.id),
      eq(auditLog.action, "events.clone"),
    ))).resolves.toHaveLength(1);
    await expect(db.select().from(auditLog).where(and(
      eq(auditLog.eventId, cloned.id),
      eq(auditLog.action, "events.copyTeam"),
    ))).resolves.toHaveLength(1);
  });

  it("keeps event clone browser-only, owner/admin authorized, and stale-preview guarded", async () => {
    const source = await runAs(owner, createEvent({ name: "Clone policy source", slug: "clone-policy-source" }));
    await addMember(source.id, admin.userId, "admin");
    const previewOperation = operations.find((candidate) => candidate.id === "events.previewClone");
    const cloneOperation = operations.find((candidate) => candidate.id === "events.clone");
    if (!previewOperation || !cloneOperation) throw new Error("Event clone operations missing");
    expect([previewOperation, cloneOperation].every((operation) => !("mcp" in operation) && !("party" in operation))).toBe(true);
    const target = {
      eventId: source.id,
      name: "Clone policy target",
      slug: "clone-policy-target",
      startsAt: Date.UTC(2027, 0, 1),
      endsAt: Date.UTC(2027, 0, 2),
      includeTeam: false,
    } as const;
    const preview = await runAs(admin, previewEventClone(target));
    await expectFailure(reviewer, previewEventClone(target), "Forbidden");
    await expectFailure(outsider, previewEventClone(target), "Forbidden");
    await expectFailure(apiKeyPrincipal("clone-source-key", source.id, ["event:read", "event:write"]), previewEventClone(target), "Forbidden");
    await runAs(owner, updateEvent(source.id, { expectedVersion: source.version, description: "Structure version changed" }));
    await expectFailure(admin, applyEventClone({
      ...target,
      expectedSourceVersion: preview.sourceVersion,
      expectedStructureFingerprint: preview.structureFingerprint,
      idempotencyKey: "stale-event-clone",
    }), "Conflict");
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
