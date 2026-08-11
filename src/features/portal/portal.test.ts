import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type { BrowserSessionPrincipal } from "contracts/principal";
import type { ServerMessage } from "contracts/protocol";
import {
  airtableOutbox,
  airtablePendingEdits,
  assetComments,
  assets,
  auditLog,
  domainChanges,
  eventMembers,
  idempotencyRecords,
  integrations,
  mailDeliveries,
  mailDeliverySnapshots,
  pages,
  speakers,
  speakerContacts,
  submissionSpeakers,
  submissions,
  taskCompletions,
  taskAssignments,
  tasks,
} from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AirtableSync,
  type Authorizer,
  AppLayer,
  type CurrentUser,
  CurrentUser as CurrentUserTag,
  type Db,
  type Files,
  type MailQueue,
  Rooms,
} from "@/server/services";
import { operations } from "./operations";
import {
  claimSpeaker,
  addContentComment,
  createManagedSpeaker,
  createPortalResource,
  createPortalTask,
  deletePortalResource,
  deletePortalTask,
  getPortalDashboard,
  getPortalSnapshot,
  getContentLibrary,
  getSpeakerDirectory,
  logSpeakerContact,
  importSpeakersCsv,
  listPortalTasks,
  getPublicSpeakers,
  updateSpeakerProfile,
  updateManagedSpeaker,
  uploadManagedSpeakerHeadshot,
  restoreContentVersion,
  downloadContent,
  sendSpeakerMessages,
  enqueueAutomatedDueTaskReminders,
  provisionSpeaker,
  setTaskCompletion,
  updatePortalResource,
  updatePortalTask,
  updateSpeakerPublication,
  uploadPortalAsset,
} from "./service";
import { listEventAccess } from "@/features/events/service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
type PortalRequirements = AirtableSync | Authorizer | CurrentUser | Db | Files | MailQueue | Rooms;

const expiresAt = Date.UTC(2100, 0, 1);
const principal = (userId: string): BrowserSessionPrincipal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name: userId,
  sessionId: `session-${userId}`,
  expiresAt,
});

const owner = principal("portal-owner");
const speakerUser = principal("portal-speaker");
const reviewer = principal("portal-reviewer");
const otherUser = principal("portal-other");
let sequence = 0;

const runEither = <A>(
  user: BrowserSessionPrincipal,
  effect: Effect.Effect<A, AppError, PortalRequirements>,
) => Effect.runPromise(effect.pipe(
  Effect.either,
  Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUserTag, user))),
));

const runAs = async <A>(
  user: BrowserSessionPrincipal,
  effect: Effect.Effect<A, AppError, PortalRequirements>,
): Promise<A> => {
  const result = await runEither(user, effect);
  if (result._tag === "Left") {
    const detail = result.left._tag === "External" ? `: ${result.left.detail ?? ""}` : "";
    throw new Error(`Unexpected ${result.left._tag}${detail}`);
  }
  return result.right;
};

const runAsRecording = <A>(
  user: BrowserSessionPrincipal,
  effect: Effect.Effect<A, AppError, PortalRequirements>,
  messages: ServerMessage[],
) => Effect.runPromise(effect.pipe(
  Effect.provide(Layer.succeed(Rooms, {
    broadcast: (_eventId, message) => Effect.sync(() => { messages.push(message); }),
  })),
  Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUserTag, user))),
));

const expectFailure = async (
  user: BrowserSessionPrincipal,
  effect: Effect.Effect<unknown, AppError, PortalRequirements>,
  tag: AppError["_tag"],
) => {
  const result = await runEither(user, effect);
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left._tag).toBe(tag);
};
const base64Payload = (size: number): string => {
  const bytes = new Uint8Array(size);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
};


const fixture = async ({
  linkedUserId = speakerUser.userId as string | null,
  speakerEmail = speakerUser.email,
}: {
  readonly linkedUserId?: string | null;
  readonly speakerEmail?: string;
} = {}) => {
  sequence += 1;
  const suffix = String(sequence);
  const eventId = `portal-event-id-${suffix}`;
  const eventSlug = `portal-event-${suffix}`;
  const speakerId = `portal-speaker-${suffix}`;
  const submissionId = `portal-submission-${suffix}`;
  const acceptanceId = `portal-acceptance-${suffix}`;
  const provisioningId = `portal-provisioning-${suffix}`;
  const formId = `portal-form-${suffix}`;
  const formVersionId = `portal-form-version-${suffix}`;
  const speakerEmailFieldId = `portal-speaker-email-field-${suffix}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("insert or ignore into users (id, email, name, created_at, updated_at) values (?, ?, ?, ?, ?)").bind(owner.userId, owner.email, owner.name, now, now),
    env.DB.prepare("insert or ignore into users (id, email, name, created_at, updated_at) values (?, ?, ?, ?, ?)").bind(speakerUser.userId, speakerUser.email, speakerUser.name, now, now),
    env.DB.prepare("insert or ignore into users (id, email, name, created_at, updated_at) values (?, ?, ?, ?, ?)").bind(otherUser.userId, otherUser.email, otherUser.name, now, now),
    env.DB.prepare("insert or ignore into users (id, email, name, created_at, updated_at) values (?, ?, ?, ?, ?)").bind(reviewer.userId, reviewer.email, reviewer.name, now, now),
    env.DB.prepare("insert into events (id, name, slug, timezone, version, created_at, updated_at) values (?, ?, ?, ?, 1, ?, ?)").bind(eventId, `Portal event ${suffix}`, eventSlug, "UTC", now, now),
    env.DB.prepare("insert into event_members (id, event_id, user_id, role, version, created_at, updated_at) values (?, ?, ?, 'owner', 1, ?, ?)").bind(`member-${suffix}`, eventId, owner.userId, now, now),
    env.DB.prepare("insert into event_members (id, event_id, user_id, role, version, created_at, updated_at) values (?, ?, ?, 'reviewer', 1, ?, ?)").bind(`reviewer-member-${suffix}`, eventId, reviewer.userId, now, now),
    env.DB.prepare("insert into forms (id, event_id, kind, name, status, version, created_at, updated_at) values (?, ?, 'cfp', 'CFP', 'closed', 1, ?, ?)").bind(formId, eventId, now, now),
    env.DB.prepare("insert into form_versions (id, event_id, form_id, version_number, name, published_at, created_at) values (?, ?, ?, 1, 'CFP', ?, ?)").bind(formVersionId, eventId, formId, now, now),
    env.DB.prepare("insert into form_version_fields (id, event_id, form_version_id, source_field_id, \"order\", type, label, semantic_key, required, created_at) values (?, ?, ?, null, 1, 'email', 'Speaker email', 'speakerEmail', 1, ?)").bind(speakerEmailFieldId, eventId, formVersionId, now),
    env.DB.prepare("insert into submissions (id, event_id, form_id, form_version_id, title, status, submitted_at, accepted_at, version, created_at, updated_at) values (?, ?, ?, ?, 'Accepted talk', 'accepted', ?, ?, 1, ?, ?)").bind(submissionId, eventId, formId, formVersionId, now, now, now, now),
    env.DB.prepare("insert into submission_answers (id, event_id, submission_id, form_version_id, form_version_field_id, value, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(`portal-speaker-email-answer-${suffix}`, eventId, submissionId, formVersionId, speakerEmailFieldId, JSON.stringify(speakerEmail), now, now),
    env.DB.prepare("insert into speakers (id, event_id, user_id, display_name, links, visible, version, created_at, updated_at) values (?, ?, ?, 'Exact speaker', '[]', 1, 1, ?, ?)").bind(speakerId, eventId, linkedUserId, now, now),
    env.DB.prepare("insert into submission_speakers (id, event_id, submission_id, speaker_id, is_primary, created_at) values (?, ?, ?, ?, 1, ?)").bind(`submission-speaker-${suffix}`, eventId, submissionId, speakerId, now),
    env.DB.prepare("insert into acceptance_events (id, event_id, submission_id, primary_submission_speaker_id, primary_speaker_id, primary_association_is_primary, type, submission_version, occurred_at) values (?, ?, ?, ?, ?, 1, 'accepted', 1, ?)").bind(acceptanceId, eventId, submissionId, `submission-speaker-${suffix}`, speakerId, now),
    env.DB.prepare("insert into speaker_provisioning (id, event_id, acceptance_event_id, submission_id, primary_speaker_id, status, available_at, attempt_count, version, created_at, updated_at) values (?, ?, ?, ?, ?, 'pending', ?, 0, 1, ?, ?)").bind(provisioningId, eventId, acceptanceId, submissionId, speakerId, now, now, now),
  ]);
  return { eventId, eventSlug, formId, formVersionId, submissionId, speakerId, acceptanceId, provisioningId };
};

beforeAll(async () => {
  if (!("TEST_MIGRATIONS" in env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
});

describe("portal service", () => {
  it("publishes sorted portal REST and useful MCP descriptors", () => {
    const ids = operations.map(({ id }) => id);
    expect(ids).toEqual([...ids].sort());
    expect(ids.every((id) => id.startsWith("portal."))).toBe(true);
    expect(operations
      .filter((operation) => "mcp" in operation)
      .every(({ authorize }) => authorize.kind === "event" && authorize.apiKey.kind === "api-key"))
      .toBe(true);
    expect(operations.find(({ id }) => id === "portal.getSnapshot")).toMatchObject({
      authorize: { kind: "browser-session" },
      rest: { path: "/events/:eventId/portal" },
    });
    expect(operations.find(({ id }) => id === "portal.claimSpeaker")).toMatchObject({
      authorize: { kind: "browser-session" },
      rest: { method: "post", path: "/events/:eventId/portal/claim" },
      idempotency: "required",
      concurrency: "required",
    });
    expect(operations.find(({ id }) => id === "portal.getPublicSpeakers")).toMatchObject({
      authorize: { kind: "public" },
      rest: { path: "/public/events/:eventSlug/speakers" },
    });
    expect(operations.find(({ id }) => id === "portal.manageOnboarding")).toMatchObject({
      authorize: { kind: "event", apiKey: { kind: "api-key", scopes: ["speakers:write"] } },
      mcp: { name: "manage_speaker_onboarding" },
    });
    expect(operations
      .filter(({ authorize }) => authorize.kind === "browser-session")
      .every((operation) => !("mcp" in operation)))
      .toBe(true);
  });

  it("requires organizer membership and the exact provisioned speaker browser session", async () => {
    const setup = await fixture();
    await expectFailure(otherUser, createPortalTask({ eventId: setup.eventId, name: "Bio", description: null, kind: "profile", formId: null, dueAt: null, order: 1 }), "Forbidden");
    await expectFailure(reviewer, getSpeakerDirectory({ eventId: setup.eventId }), "Forbidden");
    await expectFailure(reviewer, getPortalDashboard({ eventId: setup.eventId }), "Forbidden");
    await expectFailure(reviewer, logSpeakerContact({ eventId: setup.eventId, speakerId: setup.speakerId, medium: "text", note: null, idempotencyKey: `contact-${setup.eventId}` }), "Forbidden");
    await expectFailure(speakerUser, getPortalSnapshot({ eventId: setup.eventId }), "Forbidden");
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    await expectFailure(otherUser, getPortalSnapshot({ eventId: setup.eventId }), "Forbidden");
    await expect(runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).resolves.toMatchObject({ provisioningStatus: "provisioned", speaker: { id: setup.speakerId } });
    await expect(runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventSlug }))).resolves.toMatchObject({
      event: { id: setup.eventId, slug: setup.eventSlug },
      speaker: { id: setup.speakerId },
    });
    expect((await runAs(speakerUser, listEventAccess())).find(({ event }) => event.id === setup.eventId))
      .toMatchObject({ memberRole: null, speakerPortal: true });
  });

  it("claims the current accepted primary speaker by normalized immutable email and enables provisioning", async () => {
    const setup = await fixture({
      linkedUserId: null,
      speakerEmail: `  ${speakerUser.email.toUpperCase()}  `,
    });
    const input = {
      eventId: setup.eventSlug,
      idempotencyKey: `claim-${setup.eventId}`,
    } as const;

    await expectFailure(speakerUser, getPortalSnapshot({ eventId: setup.eventSlug }), "Forbidden");
    const claimed = await runAs(speakerUser, claimSpeaker(input));
    expect(claimed).toEqual({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      acceptanceEventId: setup.acceptanceId,
      provisioningId: setup.provisioningId,
      speakerVersion: 2,
      provisioningVersion: 2,
      provisioningStatus: "claimed",
    });
    await expect(runAs(speakerUser, claimSpeaker(input))).resolves.toEqual(claimed);

    const db = drizzle(env.DB);
    const [linked] = await db.select().from(speakers).where(eq(speakers.id, setup.speakerId));
    expect(linked).toMatchObject({ userId: speakerUser.userId, version: 2 });
    expect(await db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, setup.eventId),
      eq(idempotencyRecords.operationId, "portal.claimSpeaker"),
    ))).toHaveLength(1);
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, setup.eventId),
      eq(domainChanges.eventType, "portal.speaker.claimed"),
    ))).toHaveLength(1);
    expect(await db.select().from(auditLog).where(and(
      eq(auditLog.eventId, setup.eventId),
      eq(auditLog.action, "portal.speaker.claimed"),
    ))).toHaveLength(1);

    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      provisioningId: setup.provisioningId,
      expectedVersion: claimed.provisioningVersion,
    }));
    await expect(runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventSlug }))).resolves.toMatchObject({
      provisioningStatus: "provisioned",
      speaker: { id: setup.speakerId },
    });
  });

  it("claims a directly managed speaker by normalized email without acceptance provisioning", async () => {
    const setup = await fixture();
    const managed = await runAs(owner, createManagedSpeaker({
      eventId: setup.eventId,
      displayName: "Direct portal speaker",
      contactEmail: otherUser.email.toUpperCase(),
      title: "Director",
      company: "Direct Co",
      bio: "Invited outside the CFP.",
      workflowStatus: "Invited",
      visible: true,
      idempotencyKey: `managed-claim-create-${setup.eventId}`,
    }));
    const input = {
      eventId: setup.eventSlug,
      idempotencyKey: `managed-claim-${setup.eventId}`,
    } as const;

    const claimed = await runAs(otherUser, claimSpeaker(input));
    expect(claimed).toEqual({
      eventId: setup.eventId,
      speakerId: managed.id,
      acceptanceEventId: null,
      provisioningId: null,
      speakerVersion: 2,
      provisioningVersion: 0,
      provisioningStatus: "provisioned",
    });
    await expect(runAs(otherUser, claimSpeaker(input))).resolves.toEqual(claimed);
    await expect(runAs(otherUser, getPortalSnapshot({ eventId: setup.eventSlug }))).resolves.toMatchObject({
      speaker: { id: managed.id },
      submission: null,
      provisioningStatus: "provisioned",
    });
    expect((await runAs(otherUser, listEventAccess())).find(({ event }) => event.id === setup.eventId))
      .toMatchObject({ memberRole: null, speakerPortal: true });
  });

  it("preserves organizer membership while linking and provisioning the same user as a speaker", async () => {
    const setup = await fixture({ linkedUserId: null });
    const createdAt = new Date();
    const db = drizzle(env.DB);
    await db.insert(eventMembers).values({
      id: `dual-role-member-${setup.eventId}`,
      eventId: setup.eventId,
      userId: speakerUser.userId,
      role: "owner",
      createdAt,
      updatedAt: createdAt,
    });

    const claimed = await runAs(speakerUser, claimSpeaker({
      eventId: setup.eventSlug,
      idempotencyKey: `dual-role-claim-${setup.eventId}`,
    }));

    const [membershipAfterClaim] = await db.select().from(eventMembers).where(and(
      eq(eventMembers.eventId, setup.eventId),
      eq(eventMembers.userId, speakerUser.userId),
    ));
    expect(membershipAfterClaim).toMatchObject({ role: "owner", version: 1 });

    await runAs(speakerUser, provisionSpeaker({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      provisioningId: setup.provisioningId,
      expectedVersion: claimed.provisioningVersion,
    }));

    await expect(runAs(speakerUser, getPortalDashboard({ eventId: setup.eventId })))
      .resolves.toMatchObject({ event: { id: setup.eventId } });
    await expect(runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventSlug })))
      .resolves.toMatchObject({ event: { id: setup.eventId }, speaker: { id: setup.speakerId } });
    expect((await runAs(speakerUser, listEventAccess())).find(({ event }) => event.id === setup.eventId))
      .toMatchObject({ memberRole: "owner", speakerPortal: true });
    const [membershipAfterProvisioning] = await db.select().from(eventMembers).where(and(
      eq(eventMembers.eventId, setup.eventId),
      eq(eventMembers.userId, speakerUser.userId),
    ));
    expect(membershipAfterProvisioning).toMatchObject({ role: "owner", version: 1 });
  });

  it("rejects mismatched, revoked, and other-user-linked speaker claims without evidence", async () => {
    const mismatched = await fixture({ linkedUserId: null, speakerEmail: "someone-else@example.com" });
    await expectFailure(speakerUser, claimSpeaker({
      eventId: mismatched.eventId,
      idempotencyKey: `claim-mismatch-${mismatched.eventId}`,
    }), "Forbidden");

    const linkedElsewhere = await fixture({ linkedUserId: otherUser.userId, speakerEmail: speakerUser.email });
    await expectFailure(speakerUser, claimSpeaker({
      eventId: linkedElsewhere.eventId,
      idempotencyKey: `claim-linked-${linkedElsewhere.eventId}`,
    }), "Conflict");

    const revoked = await fixture({ linkedUserId: null });
    const revokedAt = Date.now() + 1_000;
    await env.DB.prepare("insert into acceptance_events (id, event_id, submission_id, primary_submission_speaker_id, primary_speaker_id, primary_association_is_primary, type, submission_version, occurred_at) values (?, ?, ?, ?, ?, 1, 'revoked', 2, ?)")
      .bind(`revoked-${revoked.acceptanceId}`, revoked.eventId, revoked.submissionId, `submission-speaker-${sequence}`, revoked.speakerId, revokedAt)
      .run();
    await expectFailure(speakerUser, claimSpeaker({
      eventId: revoked.eventId,
      idempotencyKey: `claim-revoked-${revoked.eventId}`,
    }), "Forbidden");

    const db = drizzle(env.DB);
    for (const setup of [mismatched, revoked]) {
      const [unchanged] = await db.select().from(speakers).where(eq(speakers.id, setup.speakerId));
      expect(unchanged).toMatchObject({ userId: null, version: 1 });
      expect(await db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, setup.eventId),
        eq(idempotencyRecords.operationId, "portal.claimSpeaker"),
      ))).toHaveLength(0);
      expect(await db.select().from(domainChanges).where(and(
        eq(domainChanges.eventId, setup.eventId),
        eq(domainChanges.eventType, "portal.speaker.claimed"),
      ))).toHaveLength(0);
    }
  });

  it("rechecks current acceptance inside the guarded claim commit", async () => {
    const setup = await fixture({ linkedUserId: null });
    const revokedAt = Date.now() + 1_000;
    await expectFailure(speakerUser, claimSpeaker({
      eventId: setup.eventId,
      idempotencyKey: `claim-race-${setup.eventId}`,
    }, {
      beforeCommit: async () => {
        await env.DB.prepare("insert into acceptance_events (id, event_id, submission_id, primary_submission_speaker_id, primary_speaker_id, primary_association_is_primary, type, submission_version, occurred_at) values (?, ?, ?, ?, ?, 1, 'revoked', 2, ?)")
          .bind(`race-revoked-${setup.acceptanceId}`, setup.eventId, setup.submissionId, `submission-speaker-${sequence}`, setup.speakerId, revokedAt)
          .run();
      },
    }), "Conflict");

    const db = drizzle(env.DB);
    const [speaker] = await db.select().from(speakers).where(eq(speakers.id, setup.speakerId));
    expect(speaker).toMatchObject({ userId: null, version: 1 });
    expect(await db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, setup.eventId),
      eq(idempotencyRecords.operationId, "portal.claimSpeaker"),
    ))).toHaveLength(0);
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, setup.eventId),
      eq(domainChanges.eventType, "portal.speaker.claimed"),
    ))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(and(
      eq(auditLog.eventId, setup.eventId),
      eq(auditLog.action, "portal.speaker.claimed"),
    ))).toHaveLength(0);
  });

  it("converges concurrent same-user claims without duplicate claim evidence", async () => {
    const setup = await fixture({ linkedUserId: null });
    const [first, second] = await Promise.all([
      runEither(speakerUser, claimSpeaker({
        eventId: setup.eventId,
        idempotencyKey: `claim-concurrent-a-${setup.eventId}`,
      })),
      runEither(speakerUser, claimSpeaker({
        eventId: setup.eventId,
        idempotencyKey: `claim-concurrent-b-${setup.eventId}`,
      })),
    ]);
    expect(first._tag).toBe("Right");
    expect(second._tag).toBe("Right");
    if (first._tag === "Right") expect(first.right.provisioningStatus).toBe("claimed");
    if (second._tag === "Right") expect(second.right.provisioningStatus).toBe("claimed");

    const db = drizzle(env.DB);
    const [speaker] = await db.select().from(speakers).where(eq(speakers.id, setup.speakerId));
    expect(speaker).toMatchObject({ userId: speakerUser.userId, version: 2 });
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, setup.eventId),
      eq(domainChanges.eventType, "portal.speaker.claimed"),
    ))).toHaveLength(1);
    expect(await db.select().from(auditLog).where(and(
      eq(auditLog.eventId, setup.eventId),
      eq(auditLog.action, "portal.speaker.claimed"),
    ))).toHaveLength(1);
  });

  it("keeps an active provisioned submission when a different submission is revoked", async () => {
    const setup = await fixture();
    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      provisioningId: setup.provisioningId,
      expectedVersion: 1,
    }));
    const otherSubmissionId = `${setup.submissionId}-revoked`;
    const associationId = `${otherSubmissionId}-speaker`;
    const acceptedId = `${otherSubmissionId}-accepted`;
    const revokedId = `${otherSubmissionId}-revoked`;
    const occurredAt = Date.now() + 10_000;
    await env.DB.batch([
      env.DB.prepare("insert into submissions (id, event_id, form_id, form_version_id, title, status, submitted_at, accepted_at, version, created_at, updated_at) values (?, ?, ?, ?, 'Later revoked talk', 'accepted', ?, ?, 2, ?, ?)").bind(otherSubmissionId, setup.eventId, setup.formId, setup.formVersionId, occurredAt, occurredAt, occurredAt, occurredAt),
      env.DB.prepare("insert into submission_speakers (id, event_id, submission_id, speaker_id, is_primary, created_at) values (?, ?, ?, ?, 1, ?)").bind(associationId, setup.eventId, otherSubmissionId, setup.speakerId, occurredAt),
      env.DB.prepare("insert into acceptance_events (id, event_id, submission_id, primary_submission_speaker_id, primary_speaker_id, primary_association_is_primary, type, submission_version, occurred_at) values (?, ?, ?, ?, ?, 1, 'accepted', 1, ?)").bind(acceptedId, setup.eventId, otherSubmissionId, associationId, setup.speakerId, occurredAt),
      env.DB.prepare("insert into acceptance_events (id, event_id, submission_id, primary_submission_speaker_id, primary_speaker_id, primary_association_is_primary, type, submission_version, occurred_at) values (?, ?, ?, ?, ?, 1, 'revoked', 2, ?)").bind(revokedId, setup.eventId, otherSubmissionId, associationId, setup.speakerId, occurredAt + 1),
    ]);

    await expect(runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventSlug }))).resolves.toMatchObject({
      submission: { id: setup.submissionId },
      speaker: { id: setup.speakerId },
    });
    expect((await runAs(owner, getSpeakerDirectory({ eventId: setup.eventId }))).speakers).toHaveLength(1);
    expect((await Effect.runPromise(getPublicSpeakers({ eventSlug: setup.eventSlug }).pipe(Effect.provide(AppLayer(env))))).speakers)
      .toHaveLength(1);
  });

  it("persists completion and transitions readiness after provisioning", async () => {
    const setup = await fixture();
    const task = await runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Confirm", description: null, kind: "confirm", formId: null, dueAt: null, order: 1 }));
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("not_started");
    const completed = await runAs(speakerUser, setTaskCompletion({ eventId: setup.eventId, taskId: task.id, completed: true, data: { source: "portal" }, idempotencyKey: `complete-${task.id}` }));
    expect(completed.completed).toBe(true);
    const db = drizzle(env.DB);
    expect(await db.select().from(taskCompletions).where(and(eq(taskCompletions.eventId, setup.eventId), eq(taskCompletions.taskId, task.id)))).toHaveLength(1);
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("ready");
    const uncompleted = await runAs(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: task.id,
      completed: false,
      idempotencyKey: `uncomplete-${task.id}`,
    }));
    expect(uncompleted.completed).toBe(false);
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("not_started");
    const recompleted = await runAs(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: task.id,
      completed: true,
      data: { source: "portal-retry" },
      idempotencyKey: `recomplete-${task.id}`,
    }));
    expect(recompleted.completed).toBe(true);
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("ready");
    const completionChanges = await db
      .select({ aggregateVersion: domainChanges.aggregateVersion })
      .from(domainChanges)
      .where(and(
        eq(domainChanges.eventId, setup.eventId),
        eq(domainChanges.aggregateId, `${task.id}:${setup.speakerId}`),
        eq(domainChanges.eventType, "portal.task.completion.changed"),
      ));
    expect(completionChanges.map(({ aggregateVersion }) => aggregateVersion)).toEqual([1, 2, 3]);
  });

  it("builds an owner-only speaker chase from missing, overdue, and confirm tasks", async () => {
    const setup = await fixture();
    const missingProfile = await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Speaker profile",
      description: null,
      kind: "profile",
      formId: null,
      dueAt: null,
      order: 1,
    }));
    const employerApproval = await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Employer approval",
      description: "Confirm approval to attend.",
      kind: "confirm",
      formId: null,
      dueAt: Date.now() - 60_000,
      order: 2,
    }));
    const completeSpeakerId = `${setup.speakerId}-ready`;
    const completeSubmissionId = `${setup.submissionId}-ready`;
    const completeAssociationId = `${completeSubmissionId}-speaker`;
    const completeAcceptanceId = `${completeSubmissionId}-accepted`;
    const completeProvisioningId = `${completeSubmissionId}-provisioning`;
    const completedAt = Date.now();
    await env.DB.batch([
      env.DB.prepare("insert into submissions (id, event_id, form_id, form_version_id, title, status, submitted_at, accepted_at, version, created_at, updated_at) values (?, ?, ?, ?, 'Ready talk', 'accepted', ?, ?, 1, ?, ?)").bind(completeSubmissionId, setup.eventId, setup.formId, setup.formVersionId, completedAt, completedAt, completedAt, completedAt),
      env.DB.prepare("insert into speakers (id, event_id, user_id, display_name, links, visible, version, created_at, updated_at) values (?, ?, null, 'A Ready speaker', '[]', 0, 1, ?, ?)").bind(completeSpeakerId, setup.eventId, completedAt, completedAt),
      env.DB.prepare("insert into submission_speakers (id, event_id, submission_id, speaker_id, is_primary, created_at) values (?, ?, ?, ?, 1, ?)").bind(completeAssociationId, setup.eventId, completeSubmissionId, completeSpeakerId, completedAt),
      env.DB.prepare("insert into acceptance_events (id, event_id, submission_id, primary_submission_speaker_id, primary_speaker_id, primary_association_is_primary, type, submission_version, occurred_at) values (?, ?, ?, ?, ?, 1, 'accepted', 1, ?)").bind(completeAcceptanceId, setup.eventId, completeSubmissionId, completeAssociationId, completeSpeakerId, completedAt),
      env.DB.prepare("insert into speaker_provisioning (id, event_id, acceptance_event_id, submission_id, primary_speaker_id, status, available_at, attempt_count, version, created_at, updated_at) values (?, ?, ?, ?, ?, 'provisioned', ?, 0, 1, ?, ?)").bind(completeProvisioningId, setup.eventId, completeAcceptanceId, completeSubmissionId, completeSpeakerId, completedAt, completedAt, completedAt),
      env.DB.prepare("insert into task_completions (id, event_id, task_id, speaker_id, completed_at, data, version, created_at, updated_at) values (?, ?, ?, ?, ?, null, 1, ?, ?)").bind(`${completeSpeakerId}-${missingProfile.id}`, setup.eventId, missingProfile.id, completeSpeakerId, completedAt, completedAt, completedAt),
      env.DB.prepare("insert into task_completions (id, event_id, task_id, speaker_id, completed_at, data, version, created_at, updated_at) values (?, ?, ?, ?, ?, null, 1, ?, ?)").bind(`${completeSpeakerId}-${employerApproval.id}`, setup.eventId, employerApproval.id, completeSpeakerId, completedAt, completedAt, completedAt),
    ]);

    const dashboard = await runAs(owner, getPortalDashboard({ eventId: setup.eventId }));
    const speaker = dashboard.speakers[0]!;
    expect(dashboard.speakers.map((item) => item.speaker.id)).toEqual([setup.speakerId, completeSpeakerId]);
    expect(dashboard.totals).toMatchObject({ speakers: 2, ready: 1, needsAttention: 1, overdue: 1, tasksDone: 2, tasksTotal: 4 });
    expect(speaker.readiness).toMatchObject({
      outstandingTaskIds: [employerApproval.id, missingProfile.id],
      overdueCount: 1,
      clearestBlocker: "Overdue: Employer approval",
      recommendedNextAction: "Send a tool email about Employer approval",
    });
    expect(speaker.readiness.missingItems).toMatchObject([
      { id: employerApproval.id, overdue: true, blocker: "Overdue: Employer approval" },
      { id: missingProfile.id, overdue: false, recommendedAction: "Complete the speaker profile" },
    ]);
  });

  it("uses checklist order to choose between equally due readiness blockers", async () => {
    const setup = await fixture();
    await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Created first but ordered second",
      description: null,
      kind: "confirm",
      formId: null,
      dueAt: null,
      order: 2,
    }));
    await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Created second but ordered first",
      description: null,
      kind: "profile",
      formId: null,
      dueAt: null,
      order: 1,
    }));

    const dashboard = await runAs(owner, getPortalDashboard({ eventId: setup.eventId }));
    expect(dashboard.speakers[0]?.readiness.missingItems.map(({ name }) => name)).toEqual([
      "Created second but ordered first",
      "Created first but ordered second",
    ]);
    expect(dashboard.speakers[0]?.readiness.clearestBlocker)
      .toBe("Missing: Created second but ordered first");
  });

  it("appends only explicit organizer contact evidence and projects the latest contact", async () => {
    const setup = await fixture();
    await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Travel confirmation",
      description: null,
      kind: "confirm",
      formId: null,
      dueAt: null,
      order: 1,
    }));
    expect((await runAs(owner, getPortalDashboard({ eventId: setup.eventId }))).speakers[0]?.readiness.recommendedNextAction)
      .toBe("Send a tool email about Travel confirmation");
    const first = await runAs(owner, logSpeakerContact({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      medium: "toolEmail",
      note: "Sent the readiness reminder.",
      idempotencyKey: `contact-first-${setup.eventId}`,
    }));
    const replay = await runAs(owner, logSpeakerContact({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      medium: "toolEmail",
      note: "Sent the readiness reminder.",
      idempotencyKey: `contact-first-${setup.eventId}`,
    }));
    expect(replay).toEqual(first);
    expect(await drizzle(env.DB).select().from(speakerContacts).where(eq(speakerContacts.eventId, setup.eventId))).toHaveLength(1);
    expect((await runAs(owner, getPortalDashboard({ eventId: setup.eventId }))).speakers[0]?.readiness.recommendedNextAction)
      .toBe("Send a personal email about Travel confirmation");
    await runAs(owner, logSpeakerContact({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      medium: "personalEmail",
      note: null,
      idempotencyKey: `contact-second-${setup.eventId}`,
    }));
    expect((await runAs(owner, getPortalDashboard({ eventId: setup.eventId }))).speakers[0]?.readiness.recommendedNextAction)
      .toBe("Send a text about Travel confirmation");
    await runAs(owner, logSpeakerContact({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      medium: "text",
      note: null,
      idempotencyKey: `contact-third-${setup.eventId}`,
    }));
    expect((await runAs(owner, getPortalDashboard({ eventId: setup.eventId }))).speakers[0]?.readiness.recommendedNextAction)
      .toBe("Call about Travel confirmation");
    await runAs(owner, logSpeakerContact({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      medium: "phone",
      note: null,
      idempotencyKey: `contact-fourth-${setup.eventId}`,
    }));
    const dashboard = await runAs(owner, getPortalDashboard({ eventId: setup.eventId }));
    expect(dashboard.speakers[0]?.latestContact).toMatchObject({ medium: "phone", note: null });
    expect(dashboard.speakers[0]?.readiness.recommendedNextAction)
      .toBe("Follow up by phone or coordinate manually about Travel confirmation");
    expect(await drizzle(env.DB).select().from(domainChanges).where(and(
      eq(domainChanges.eventId, setup.eventId),
      eq(domainChanges.eventType, "portal.speaker.contact.logged"),
    ))).toHaveLength(4);
    expect(await drizzle(env.DB).select().from(auditLog).where(and(
      eq(auditLog.eventId, setup.eventId),
      eq(auditLog.action, "portal.speaker.contact.logged"),
    ))).toHaveLength(4);
  });

  it("stores a policy-validated R2 upload and links headshot and task completion", async () => {
    const setup = await fixture();
    const task = await runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Headshot", description: null, kind: "upload", formId: null, dueAt: null, order: 1 }));
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    const firstInput = { eventId: setup.eventId, taskId: task.id, purpose: "headshot", filename: "headshot.png", contentType: "image/png", contentBase64: "iVBORw0KGgo=", expectedVersion: 1, idempotencyKey: `headshot-${task.id}` } as const;
    const result = await runAs(speakerUser, uploadPortalAsset(firstInput));
    expect(result.speaker.headshotAssetId).toBe(result.asset.id);
    const replay = await runAs(speakerUser, uploadPortalAsset(firstInput));
    expect(replay.asset.id).toBe(result.asset.id);
    expect(result.task?.completed).toBe(true);
    const stored = await env.FILES.get(`portal/${setup.eventId}/${result.asset.id}`);
    expect(stored).not.toBeNull();
    expect(stored?.customMetadata).toMatchObject({
      portalPurpose: "headshot",
      speakerId: setup.speakerId,
    });
    expect(await drizzle(env.DB).select().from(assets).where(eq(assets.id, result.asset.id))).toHaveLength(1);
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).assets[0]).toMatchObject({
      id: result.asset.id,
      purpose: "headshot",
    });
    const replacement = await runAs(speakerUser, uploadPortalAsset({
      eventId: setup.eventId,
      taskId: task.id,
      purpose: "headshot",
      filename: "replacement.png",
      contentType: "image/png",
      contentBase64: "iVBORw0KGgo=",
      expectedVersion: result.speaker.version,
      idempotencyKey: `headshot-replacement-${task.id}`,
    }));
    const snapshot = await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }));
    expect(snapshot.speaker.headshotAssetId).toBe(replacement.asset.id);
    expect(snapshot.assets.filter(({ purpose }) => purpose === "headshot")).toHaveLength(1);
    expect(await env.FILES.get(`portal/${setup.eventId}/${result.asset.id}`)).not.toBeNull();
    expect(await drizzle(env.DB).select().from(assets).where(eq(assets.id, result.asset.id))).toMatchObject([{ current: false }]);
    const [completion] = await drizzle(env.DB)
      .select()
      .from(taskCompletions)
      .where(eq(taskCompletions.taskId, task.id));
    expect(completion).toMatchObject({
      data: { assetId: replacement.asset.id, purpose: "headshot" },
      version: 2,
    });
    expect(await drizzle(env.DB).select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, setup.eventId))).toHaveLength(2);
  });

  it("accepts a decoded 10 MiB upload for every asset kind", async () => {
    const setup = await fixture();
    const uploadTasks = await Promise.all([
      runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Headshot", description: null, kind: "upload", formId: null, dueAt: null, order: 1 })),
      runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Slides", description: null, kind: "upload", formId: null, dueAt: null, order: 2 })),
      runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Document", description: null, kind: "upload", formId: null, dueAt: null, order: 3 })),
    ]);
    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      provisioningId: setup.provisioningId,
      expectedVersion: 1,
    }));
    const put = vi.spyOn(env.FILES, "put").mockResolvedValue({} as R2Object);
    const contentBase64 = base64Payload(10 * 1_024 * 1_024);
    const cases = [
      {
        purpose: "headshot" as const,
        filename: "speaker.webp",
        contentType: "image/webp",
        taskId: uploadTasks[0]!.id,
        expectedVersion: 1,
      },
      {
        purpose: "slides" as const,
        filename: "session.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        taskId: uploadTasks[1]!.id,
        expectedVersion: 0,
      },
      {
        purpose: "document" as const,
        filename: "brief.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        taskId: uploadTasks[2]!.id,
        expectedVersion: 0,
      },
    ];
    try {
      for (const [index, upload] of cases.entries()) {
        const result = await runAs(speakerUser, uploadPortalAsset({
          eventId: setup.eventId,
          ...upload,
          contentBase64,
          idempotencyKey: `max-upload-${setup.eventId}-${index}`,
        }));
        expect(result.asset.size).toBe(10 * 1_024 * 1_024);
        expect(result.task?.completed).toBe(true);
      }
      expect(put).toHaveBeenCalledTimes(3);
      expect(await drizzle(env.DB).select().from(assets).where(eq(assets.eventId, setup.eventId))).toHaveLength(3);
      expect(await drizzle(env.DB).select().from(taskCompletions).where(eq(taskCompletions.eventId, setup.eventId))).toHaveLength(3);
    } finally {
      put.mockRestore();
    }
  });

  it("rejects a headshot over 10 MiB before Files.put without durable side effects", async () => {
    const setup = await fixture();
    const task = await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Upload",
      description: null,
      kind: "upload",
      formId: null,
      dueAt: null,
      order: 1,
    }));
    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      provisioningId: setup.provisioningId,
      expectedVersion: 1,
    }));
    const put = vi.spyOn(env.FILES, "put").mockResolvedValue({} as R2Object);
    const contentBase64 = base64Payload(10 * 1_024 * 1_024 + 1);
    const cases = [
      { purpose: "headshot" as const, filename: "speaker.jpg", contentType: "image/jpeg", expectedVersion: 1 },
    ];
    try {
      for (const [index, upload] of cases.entries()) {
        await expectFailure(speakerUser, uploadPortalAsset({
          eventId: setup.eventId,
          taskId: task.id,
          ...upload,
          contentBase64,
          idempotencyKey: `oversize-upload-${setup.eventId}-${index}`,
        }), "Validation");
      }
      expect(put).not.toHaveBeenCalled();
      const db = drizzle(env.DB);
      expect(await db.select().from(assets).where(eq(assets.eventId, setup.eventId))).toHaveLength(0);
      expect(await db.select().from(taskCompletions).where(eq(taskCompletions.eventId, setup.eventId))).toHaveLength(0);
      expect(await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.eventId, setup.eventId))).toHaveLength(0);
    } finally {
      put.mockRestore();
    }
  });

  it("queues Airtable-authoritative profile fields idempotently and enforces prerequisites", async () => {
    const setup = await fixture();
    const profileTask = await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Profile",
      description: null,
      kind: "profile",
      formId: null,
      dueAt: null,
      order: 1,
    }));
    const formTask = await runAs(owner, createPortalTask({
      eventId: setup.eventId,
      name: "Travel form",
      description: null,
      kind: "form",
      formId: setup.formId,
      dueAt: null,
      order: 2,
    }));
    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      provisioningId: setup.provisioningId,
      expectedVersion: 1,
    }));
    await expectFailure(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: profileTask.id,
      completed: true,
      idempotencyKey: `profile-premature-${setup.eventId}`,
    }), "Conflict");
    await expectFailure(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: formTask.id,
      completed: true,
      idempotencyKey: `form-premature-${setup.eventId}`,
    }), "Conflict");

    const db = drizzle(env.DB);
    const createdAt = new Date();
    await db.insert(integrations).values({
      id: `airtable-${setup.eventId}`,
      eventId: setup.eventId,
      kind: "airtable",
      secretRef: "secret://airtable/test",
      config: {},
      createdAt,
      updatedAt: createdAt,
    });
    const profileInput = {
      eventId: setup.eventId,
      expectedVersion: 1,
      idempotencyKey: `profile-save-${setup.eventId}`,
      displayName: "Exact speaker",
      title: "Principal Engineer",
      company: null,
      bio: "A durable speaker biography.",
      links: [{ label: "Website", url: "https://speaker.example.com" }],
    } as const;
    const syncMessages: ServerMessage[] = [];
    const updated = await runAsRecording(speakerUser, updateSpeakerProfile(profileInput), syncMessages);
    const replay = await runAs(speakerUser, updateSpeakerProfile(profileInput));
    expect(replay).toEqual(updated);
    expect(updated.pendingSyncFields).toEqual(["title", "bio"]);
    const [stored] = await db.select().from(speakers).where(eq(speakers.id, setup.speakerId));
    expect(stored).toMatchObject({
      title: null,
      bio: null,
      links: [{ label: "Website", url: "https://speaker.example.com" }],
      version: 2,
    });
    expect((await db.select().from(airtablePendingEdits).where(eq(airtablePendingEdits.entityId, setup.speakerId))).map(({ fieldKey }) => fieldKey).sort()).toEqual(["bio", "title"]);
    expect(await db.select().from(airtableOutbox).where(eq(airtableOutbox.entityId, setup.speakerId))).toHaveLength(2);
    expect(syncMessages).toEqual([{
      t: "integrations/airtable_sync",
      entityType: "speaker",
      entityId: setup.speakerId,
      state: "pending",
      fields: ["title", "bio"],
    }]);

    const completedProfile = await runAs(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: profileTask.id,
      completed: true,
      idempotencyKey: `profile-complete-${setup.eventId}`,
    }));
    const replayedProfile = await runAs(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: profileTask.id,
      completed: true,
      idempotencyKey: `profile-complete-${setup.eventId}`,
    }));
    expect(replayedProfile).toEqual(completedProfile);

    const submittedAt = new Date(Date.now() + 1_000);
    const taskSubmissionId = `task-submission-${setup.eventId}`;
    await db.batch([
      db.insert(submissions).values({
        id: taskSubmissionId,
        eventId: setup.eventId,
        formId: setup.formId,
        formVersionId: setup.formVersionId,
        title: "Travel response",
        status: "submitted",
        submittedAt,
        version: 1,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      }),
      db.insert(submissionSpeakers).values({
        id: `task-association-${setup.eventId}`,
        eventId: setup.eventId,
        submissionId: taskSubmissionId,
        speakerId: setup.speakerId,
        isPrimary: true,
        createdAt: submittedAt,
      }),
    ]);
    await expect(runAs(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: formTask.id,
      completed: true,
      idempotencyKey: `form-complete-${setup.eventId}`,
    }))).resolves.toMatchObject({ completed: true });
    expect(await db.select().from(taskCompletions).where(eq(taskCompletions.eventId, setup.eventId))).toHaveLength(2);
  });

  it("performs organizer task and resource CRUD with optimistic versions and iframe policy", async () => {
    const setup = await fixture();
    const task = await runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Confirm", description: null, kind: "confirm", formId: null, dueAt: null, order: 2 }));
    const changedTask = await runAs(owner, updatePortalTask({ eventId: setup.eventId, taskId: task.id, expectedVersion: task.version, name: "Confirm details", description: null, kind: "confirm", formId: null, dueAt: null, order: 3 }));
    const changesBeforeStaleWrite = await drizzle(env.DB)
      .select()
      .from(domainChanges)
      .where(and(
        eq(domainChanges.eventId, setup.eventId),
        eq(domainChanges.aggregateId, task.id),
      ));
    await expectFailure(owner, updatePortalTask({
      eventId: setup.eventId,
      taskId: task.id,
      expectedVersion: task.version,
      name: "Stale overwrite",
      description: null,
      kind: "confirm",
      formId: null,
      dueAt: null,
      order: 4,
    }), "Conflict");
    const changesAfterStaleWrite = await drizzle(env.DB)
      .select()
      .from(domainChanges)
      .where(and(
        eq(domainChanges.eventId, setup.eventId),
        eq(domainChanges.aggregateId, task.id),
      ));
    expect(changesAfterStaleWrite).toEqual(changesBeforeStaleWrite);
    await runAs(owner, deletePortalTask({ eventId: setup.eventId, taskId: task.id, expectedVersion: changedTask.version }));
    await expectFailure(owner, createPortalResource({ eventId: setup.eventId, slug: "unsafe", title: "Unsafe", body: null, embedUrl: "https://evil.example/embed", audience: "speakers", order: 1 }), "Validation");
    const resource = await runAs(owner, createPortalResource({ eventId: setup.eventId, slug: "guide", title: "Guide", body: null, embedUrl: "https://www.youtube.com/embed/abc", audience: "speakers", order: 1 }));
    const changedResource = await runAs(owner, updatePortalResource({ eventId: setup.eventId, resourceId: resource.id, expectedVersion: resource.version, slug: "guide", title: "Updated guide", body: "Read this", embedUrl: null, audience: "public", order: 2 }));
    await runAs(owner, deletePortalResource({ eventId: setup.eventId, resourceId: resource.id, expectedVersion: changedResource.version }));
    expect(await drizzle(env.DB).select().from(tasks).where(eq(tasks.id, task.id))).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(pages).where(eq(pages.id, resource.id))).toHaveLength(0);
  });

  it("adds, edits, filters, and imports managed speaker workflow records", async () => {
    const setup = await fixture();
    const createInput = {
      eventId: setup.eventId,
      displayName: "Manual Speaker",
      contactEmail: "manual@example.com",
      title: "Director",
      company: "Example Co",
      bio: "Original biography",
      workflowStatus: "Invited",
      visible: false,
      idempotencyKey: `manual-create-${setup.eventId}`,
    } as const;
    const created = await runAs(owner, createManagedSpeaker(createInput));
    await expect(runAs(owner, createManagedSpeaker(createInput))).resolves.toEqual(created);
    expect(created).toMatchObject({ contactEmail: "manual@example.com", workflowStatus: "Invited", visible: false, version: 1 });
    const racedCreates = await Promise.all([
      runEither(owner, createManagedSpeaker({ ...createInput, contactEmail: "RACE@example.com", idempotencyKey: `race-a-${setup.eventId}` })),
      runEither(owner, createManagedSpeaker({ ...createInput, contactEmail: "race@example.com", idempotencyKey: `race-b-${setup.eventId}` })),
    ]);
    expect(racedCreates.filter((result) => result._tag === "Right")).toHaveLength(1);
    expect(racedCreates.filter((result) => result._tag === "Left" && result.left._tag === "Conflict")).toHaveLength(1);
    const updated = await runAs(owner, updateManagedSpeaker({
      eventId: setup.eventId,
      speakerId: created.id,
      expectedVersion: created.version,
      displayName: "Manual Speaker Updated",
      contactEmail: "manual@example.com",
      title: "Executive Director",
      company: "Example Co",
      bio: "Organizer-edited biography",
      workflowStatus: "Ready",
      visible: true,
    }));
    expect(updated).toMatchObject({ displayName: "Manual Speaker Updated", bio: "Organizer-edited biography", workflowStatus: "Ready", version: 2 });
    await expectFailure(owner, updateManagedSpeaker({
      eventId: setup.eventId,
      speakerId: setup.speakerId,
      expectedVersion: 1,
      displayName: "Accepted speaker overwrite",
      contactEmail: speakerUser.email,
      title: null,
      company: null,
      bio: "This must remain authoritative.",
      workflowStatus: "Ready",
      visible: true,
    }), "Conflict");
    const db = drizzle(env.DB);
    await db.update(speakers).set({ contactEmail: "accepted-authoritative@example.com" })
      .where(and(eq(speakers.eventId, setup.eventId), eq(speakers.id, setup.speakerId)));

    const csv = [
      "name,email,title,company,bio,status,visible",
      "Manual Speaker CSV,manual@example.com,VP,Example Co,Imported biography,Confirmed,true",
      "Second Speaker,second@example.com,Engineer,Second Co,Second biography,Invited,false",
      "Accepted Override,accepted-authoritative@example.com,Director,Wrong Co,Wrong biography,Ready,true",
      "Missing Email,,Engineer,Nope,,Invited,true",
    ].join("\n");
    const input = { eventId: setup.eventId, csv, idempotencyKey: `speaker-csv-${setup.eventId}` } as const;
    const imported = await runAs(owner, importSpeakersCsv(input));
    expect(imported).toMatchObject({ createdCount: 1, updatedCount: 1, skippedCount: 2, idempotent: false });
    await expect(runAs(owner, importSpeakersCsv(input))).resolves.toMatchObject({ idempotent: true });
    const directory = await runAs(owner, getSpeakerDirectory({ eventId: setup.eventId }));
    expect(directory.speakers).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "manual", speaker: expect.objectContaining({ contactEmail: "manual@example.com", workflowStatus: "Confirmed" }) }),
      expect.objectContaining({ source: "manual", speaker: expect.objectContaining({ contactEmail: "second@example.com", workflowStatus: "Invited" }) }),
    ]));
  });

  it("commits evidence only for the winning managed-speaker mutation", async () => {
    const setup = await fixture();
    const managed = await runAs(owner, createManagedSpeaker({
      eventId: setup.eventId, displayName: "Race speaker", contactEmail: "managed-race@example.com",
      title: null, company: null, bio: null, workflowStatus: "Invited", visible: false,
      idempotencyKey: `managed-race-create-${setup.eventId}`,
    }));
    const update = (displayName: string) => updateManagedSpeaker({
      eventId: setup.eventId,
      speakerId: managed.id,
      expectedVersion: managed.version,
      displayName,
      contactEmail: "managed-race@example.com",
      title: null,
      company: null,
      bio: displayName,
      workflowStatus: "Ready",
      visible: true,
    });
    const updateRace = await Promise.all([
      runEither(owner, update("Race winner A")),
      runEither(owner, update("Race winner B")),
    ]);
    expect(updateRace.filter((result) => result._tag === "Right")).toHaveLength(1);
    expect(updateRace.filter((result) => result._tag === "Left" && result.left._tag === "Conflict")).toHaveLength(1);
    const db = drizzle(env.DB);
    expect(await db.select().from(auditLog).where(and(
      eq(auditLog.eventId, setup.eventId),
      eq(auditLog.action, "portal.speaker.managed.updated"),
      eq(auditLog.resourceId, managed.id),
    ))).toHaveLength(1);

    const [current] = await db.select().from(speakers).where(eq(speakers.id, managed.id));
    if (!current) throw new Error("Expected managed speaker after update race");
    const importKeyA = `managed-import-race-a-${setup.eventId}`;
    const importKeyB = `managed-import-race-b-${setup.eventId}`;
    const csv = (name: string) => [
      "name,email,title,company,bio,status,visible",
      `${name},managed-race@example.com,,,${name},Ready,true`,
    ].join("\n");
    const importRace = await Promise.all([
      runEither(owner, importSpeakersCsv({ eventId: setup.eventId, csv: csv("Import A"), idempotencyKey: importKeyA })),
      runEither(owner, importSpeakersCsv({ eventId: setup.eventId, csv: csv("Import B"), idempotencyKey: importKeyB })),
    ]);
    expect(importRace.filter((result) => result._tag === "Right")).toHaveLength(1);
    expect(importRace.filter((result) => result._tag === "Left" && result.left._tag === "Conflict")).toHaveLength(1);
    const losingIndex = importRace.findIndex((result) => result._tag === "Left");
    const losingInput = losingIndex === 0
      ? { eventId: setup.eventId, csv: csv("Import A"), idempotencyKey: importKeyA }
      : { eventId: setup.eventId, csv: csv("Import B"), idempotencyKey: importKeyB };
    await expectFailure(owner, importSpeakersCsv(losingInput), "Conflict");
    const importRecords = await db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, setup.eventId),
      eq(idempotencyRecords.operationId, "portal.importSpeakersCsv"),
    ));
    expect(importRecords).toHaveLength(2);
    expect(importRecords.filter((record) => record.status === "completed")).toHaveLength(1);
    expect(importRecords.filter((record) => record.status === "in_progress" && record.responseBody === null)).toHaveLength(1);
  });

  it("assigns one due task to multiple selected speakers without exposing it to others", async () => {
    const setup = await fixture();
    const selected = await runAs(owner, createManagedSpeaker({
      eventId: setup.eventId, displayName: "Selected speaker", contactEmail: "selected@example.com",
      title: null, company: null, bio: null, workflowStatus: "Invited", visible: false,
      idempotencyKey: `selected-create-${setup.eventId}`,
    }));
    const excluded = await runAs(owner, createManagedSpeaker({
      eventId: setup.eventId, displayName: "Excluded speaker", contactEmail: "excluded@example.com",
      title: null, company: null, bio: null, workflowStatus: "Invited", visible: false,
      idempotencyKey: `excluded-create-${setup.eventId}`,
    }));
    const task = await runAs(owner, createPortalTask({
      eventId: setup.eventId, name: "Selected deliverable", description: null, kind: "upload", formId: null,
      dueAt: Date.now() + 86_400_000, order: 1, speakerIds: [setup.speakerId, selected.id],
    }));
    expect(task).toMatchObject({ targetMode: "selected", speakerIds: [setup.speakerId, selected.id] });
    const listed = await runAs(owner, listPortalTasks({ eventId: setup.eventId }));
    expect(listed).toContainEqual(expect.objectContaining({ id: task.id, speakerIds: [setup.speakerId, selected.id] }));
    const directory = await runAs(owner, getSpeakerDirectory({ eventId: setup.eventId }));
    const readiness = new Map(directory.speakers.map((item) => [item.speaker.id, item.readiness]));
    expect(readiness.get(setup.speakerId)?.tasksTotal).toBe(1);
    expect(readiness.get(selected.id)?.tasksTotal).toBe(1);
    expect(readiness.get(excluded.id)?.tasksTotal).toBe(0);
    expect(await drizzle(env.DB).select().from(taskAssignments).where(eq(taskAssignments.taskId, task.id))).toHaveLength(2);

    const selectedOnly = await runAs(owner, createPortalTask({
      eventId: setup.eventId, name: "Private deliverable", description: null, kind: "upload", formId: null,
      dueAt: null, order: 2, speakerIds: [selected.id],
    }));
    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId, speakerId: setup.speakerId,
      provisioningId: setup.provisioningId, expectedVersion: 1,
    }));
    await expectFailure(speakerUser, uploadPortalAsset({
      eventId: setup.eventId, taskId: selectedOnly.id, purpose: "slides", filename: "private.pdf",
      contentType: "application/pdf", contentBase64: "QQ==", expectedVersion: 0,
      idempotencyKey: `private-upload-${setup.eventId}`,
    }), "Forbidden");
    expect(await drizzle(env.DB).select().from(assets).where(eq(assets.eventId, setup.eventId))).toHaveLength(0);
  });

  it("queues messages for accepted and directly managed portal speakers", async () => {
    const setup = await fixture();
    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId, speakerId: setup.speakerId,
      provisioningId: setup.provisioningId, expectedVersion: 1,
    }));
    const manual = await runAs(owner, createManagedSpeaker({
      eventId: setup.eventId, displayName: "Reminder speaker", contactEmail: "reminder@example.com",
      title: null, company: null, bio: null, workflowStatus: "Invited", visible: false,
      idempotencyKey: `reminder-create-${setup.eventId}`,
    }));
    const runAt = new Date(Date.now() + 1_000);
    await runAs(owner, createPortalTask({
      eventId: setup.eventId, name: "Slides", description: null, kind: "upload", formId: null,
      dueAt: runAt.getTime() - 60_000, order: 1, speakerIds: [setup.speakerId, manual.id],
    }));
    const inviteInput = {
      eventId: setup.eventId, speakerIds: [setup.speakerId, manual.id], kind: "invite", idempotencyKey: `invite-${setup.eventId}`,
    } as const;
    await expect(runAs(owner, sendSpeakerMessages(inviteInput))).resolves.toMatchObject({ queuedCount: 2, skippedCount: 0, idempotent: false });
    await expect(runAs(owner, sendSpeakerMessages(inviteInput))).resolves.toMatchObject({ queuedCount: 2, skippedCount: 0, idempotent: true });
    await expect(runAs(owner, sendSpeakerMessages({
      ...inviteInput, kind: "reminder", idempotencyKey: `manual-reminder-${setup.eventId}`,
    }))).resolves.toMatchObject({ queuedCount: 2, skippedCount: 0 });
    const automated = await Effect.runPromise(enqueueAutomatedDueTaskReminders(runAt).pipe(Effect.provide(AppLayer(env))));
    expect(automated.runDate).toBe(runAt.toISOString().slice(0, 10));
    expect(automated.queuedCount).toBeGreaterThanOrEqual(1);
    await expect(Effect.runPromise(enqueueAutomatedDueTaskReminders(runAt).pipe(Effect.provide(AppLayer(env)))))
      .resolves.toEqual({ queuedCount: 0, runDate: runAt.toISOString().slice(0, 10) });
    const db = drizzle(env.DB);
    expect((await db.select().from(mailDeliveries)).filter((delivery) => delivery.idempotencyKey.includes(`:${setup.eventId}:`))).toHaveLength(2);
    expect(await db.select().from(mailDeliverySnapshots).where(eq(mailDeliverySnapshots.eventId, setup.eventId))).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipientEmail: speakerUser.email }),
    ]));
    const snapshots = await db.select().from(mailDeliverySnapshots).where(eq(mailDeliverySnapshots.eventId, setup.eventId));
    expect(snapshots.every((snapshot) => snapshot.renderedText?.includes(`/e/${setup.eventSlug}/portal`) === true)).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.renderedText?.includes(`/e/${setup.eventSlug}/speaker`) !== true)).toBe(true);
  });

  it("retains content history, supports cross-role comments, downloads, restores, and organizer profile edits", async () => {
    const setup = await fixture();
    const scheduledAt = Date.now();
    await env.DB.batch([
      env.DB.prepare("insert into talks (id, event_id, submission_id, title, starts_at, duration_min, status, version, created_at, updated_at) values (?, ?, ?, 'Accepted talk', ?, 45, 'confirmed', 1, ?, ?)")
        .bind(`portal-talk-${setup.eventId}`, setup.eventId, setup.submissionId, scheduledAt, scheduledAt, scheduledAt),
      env.DB.prepare("insert into talk_speakers (id, event_id, talk_id, speaker_id, created_at) values (?, ?, ?, ?, ?)")
        .bind(`portal-talk-speaker-${setup.eventId}`, setup.eventId, `portal-talk-${setup.eventId}`, setup.speakerId, scheduledAt),
    ]);
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    const task = await runAs(owner, createPortalTask({
      eventId: setup.eventId, name: "Headshot", description: null, kind: "upload", formId: null, dueAt: null, order: 1,
    }));
    const first = await runAs(speakerUser, uploadPortalAsset({
      eventId: setup.eventId, taskId: task.id, purpose: "headshot", filename: "first.png", contentType: "image/png",
      contentBase64: "iVBORw0KGgo=", expectedVersion: 1, idempotencyKey: `history-first-${setup.eventId}`,
    }));
    const second = await runAs(speakerUser, uploadPortalAsset({
      eventId: setup.eventId, taskId: task.id, purpose: "headshot", filename: "second.png", contentType: "image/png",
      contentBase64: "iVBORw0KGgo=", expectedVersion: first.speaker.version, idempotencyKey: `history-second-${setup.eventId}`,
    }));
    await runAs(owner, addContentComment({
      eventId: setup.eventId, assetId: second.asset.id, body: "Organizer review", idempotencyKey: `comment-owner-${setup.eventId}`,
    }));
    await runAs(speakerUser, addContentComment({
      eventId: setup.eventId, assetId: second.asset.id, body: "Speaker response", idempotencyKey: `comment-speaker-${setup.eventId}`,
    }));
    await expectFailure(owner, addContentComment({
      eventId: setup.eventId, assetId: second.asset.id, body: "   ", idempotencyKey: `comment-blank-${setup.eventId}`,
    }), "Validation");
    const beforeRestore = await runAs(owner, getContentLibrary({ eventId: setup.eventId }));
    expect(beforeRestore.assets).toHaveLength(2);
    expect(beforeRestore.assets.find((asset) => asset.id === second.asset.id)).toMatchObject({
      current: true, version: 2, versionCount: 2, sessionTitles: ["Accepted talk"], comments: [
      expect.objectContaining({ body: "Organizer review" }), expect.objectContaining({ body: "Speaker response" }),
      ],
    });
    await expect(runAs(owner, downloadContent({ eventId: setup.eventId, assetId: first.asset.id }))).resolves.toMatchObject({
      asset: { id: first.asset.id, current: false }, contentBase64: "iVBORw0KGgo=",
    });
    const restoreInput = {
      eventId: setup.eventId,
      assetId: first.asset.id,
      expectedCurrentAssetId: second.asset.id,
      expectedCurrentVersion: second.asset.version,
      expectedSpeakerVersion: second.speaker.version,
    } as const;
    const restoreRace = await Promise.all([
      runEither(owner, restoreContentVersion({ ...restoreInput, idempotencyKey: `restore-a-${setup.eventId}` })),
      runEither(owner, restoreContentVersion({ ...restoreInput, idempotencyKey: `restore-b-${setup.eventId}` })),
    ]);
    expect(restoreRace.filter((result) => result._tag === "Right")).toHaveLength(1);
    expect(restoreRace.filter((result) => result._tag === "Left" && result.left._tag === "Conflict")).toHaveLength(1);
    const restoredResult = restoreRace.find((result) => result._tag === "Right");
    if (!restoredResult || restoredResult._tag !== "Right") throw new Error("Expected one restore winner");
    const restored = restoredResult.right;
    expect(restored).toMatchObject({ current: true, version: 3, restoredFromAssetId: first.asset.id, supersedesAssetId: second.asset.id });
    const currentProfile = (await runAs(owner, getSpeakerDirectory({ eventId: setup.eventId }))).speakers.find((item) => item.speaker.id === setup.speakerId)!.speaker;
    const managedHeadshot = await runAs(owner, uploadManagedSpeakerHeadshot({
      eventId: setup.eventId, speakerId: setup.speakerId, expectedVersion: currentProfile.version,
      filename: "organizer.webp", contentType: "image/webp", contentBase64: "UklGRg==",
      idempotencyKey: `managed-headshot-${setup.eventId}`,
    }));
    expect(managedHeadshot).toMatchObject({ current: true, purpose: "headshot", version: 4, supersedesAssetId: restored.id });
    const library = await runAs(owner, getContentLibrary({ eventId: setup.eventId }));
    expect(library.assets).toHaveLength(4);
    expect(library.assets.filter((asset) => asset.current)).toEqual([expect.objectContaining({
      id: managedHeadshot.id, versionCount: 4, sessionTitles: ["Accepted talk"],
    })]);
    expect(await env.FILES.get(`portal/${setup.eventId}/${first.asset.id}`)).not.toBeNull();
    expect(await drizzle(env.DB).select().from(assetComments).where(eq(assetComments.assetId, second.asset.id))).toHaveLength(2);
  });

  it("rejects restore when a linked task completion changes before commit", async () => {
    const setup = await fixture();
    await runAs(owner, provisionSpeaker({
      eventId: setup.eventId, speakerId: setup.speakerId,
      provisioningId: setup.provisioningId, expectedVersion: 1,
    }));
    const task = await runAs(owner, createPortalTask({
      eventId: setup.eventId, name: "Slides", description: null, kind: "upload", formId: null,
      dueAt: null, order: 1,
    }));
    const first = await runAs(speakerUser, uploadPortalAsset({
      eventId: setup.eventId, taskId: task.id, purpose: "slides", filename: "first.pdf",
      contentType: "application/pdf", contentBase64: "QQ==", expectedVersion: 0,
      idempotencyKey: `restore-completion-first-${setup.eventId}`,
    }));
    const second = await runAs(speakerUser, uploadPortalAsset({
      eventId: setup.eventId, taskId: task.id, purpose: "slides", filename: "second.pdf",
      contentType: "application/pdf", contentBase64: "Qg==", expectedVersion: first.asset.version,
      idempotencyKey: `restore-completion-second-${setup.eventId}`,
    }));
    const db = drizzle(env.DB);
    const [completion] = await db.select().from(taskCompletions).where(and(
      eq(taskCompletions.eventId, setup.eventId), eq(taskCompletions.taskId, task.id),
    ));
    if (!completion) throw new Error("Expected upload task completion");

    await expectFailure(owner, restoreContentVersion({
      eventId: setup.eventId,
      assetId: first.asset.id,
      expectedCurrentAssetId: second.asset.id,
      expectedCurrentVersion: second.asset.version,
      expectedSpeakerVersion: second.speaker.version,
      idempotencyKey: `restore-completion-race-${setup.eventId}`,
    }, {
      beforeCommit: async () => {
        await db.update(taskCompletions).set({
          data: { assetId: first.asset.id, concurrent: true },
          version: completion.version + 1,
          updatedAt: new Date(),
        }).where(and(eq(taskCompletions.eventId, setup.eventId), eq(taskCompletions.id, completion.id)));
      },
    }), "Conflict");
    expect(await db.select().from(assets).where(and(
      eq(assets.eventId, setup.eventId), eq(assets.current, true), eq(assets.speakerId, setup.speakerId),
    ))).toEqual([expect.objectContaining({ id: second.asset.id })]);
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventId, setup.eventId), eq(domainChanges.eventType, "portal.asset.version.restored"),
    ))).toHaveLength(0);
  });

  it("publishes only visible accepted provisioned public speaker fields", async () => {
    const setup = await fixture();
    const db = drizzle(env.DB);
    const integrationId = `airtable-publication-${setup.eventId}`;
    const integrationNow = new Date();
    await db.insert(integrations).values({
      id: integrationId,
      eventId: setup.eventId,
      kind: "airtable",
      secretRef: "AIRTABLE_PAT",
      config: {},
      createdAt: integrationNow,
      updatedAt: integrationNow,
    });
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    const manual = await runAs(owner, createManagedSpeaker({
      eventId: setup.eventId, displayName: "Managed keynote", contactEmail: "keynote@example.com",
      title: "Keynote", company: "Session Party", bio: "Invited outside the CFP.",
      workflowStatus: "Ready", visible: true, idempotencyKey: `public-manual-${setup.eventId}`,
    }));
    const gallery = await Effect.runPromise(getPublicSpeakers({ eventSlug: setup.eventSlug }).pipe(Effect.provide(AppLayer(env))));
    expect(gallery.event).toEqual({
      id: setup.eventId,
      slug: setup.eventSlug,
      name: `Portal event ${sequence}`,
      description: null,
      location: null,
      timezone: "UTC",
      startsAt: null,
      endsAt: null,
      bannerAssetId: null,
      accentColor: null,
    });
    expect(gallery.speakers).toEqual(expect.arrayContaining([{
      id: setup.speakerId,
      displayName: "Exact speaker",
      title: null,
      company: null,
      bio: null,
      headshotUrl: null,
      links: [],
    }, expect.objectContaining({ id: manual.id, displayName: "Managed keynote" })]));
    await runAs(owner, updateSpeakerPublication({ eventId: setup.eventId, speakerId: setup.speakerId, expectedVersion: 1, visible: false }));
    await expect(db.select().from(airtableOutbox).where(eq(airtableOutbox.integrationId, integrationId)))
      .resolves.toEqual([expect.objectContaining({
        entityType: "speaker",
        entityId: setup.speakerId,
        changedFields: { visible: false },
        outboundRevision: 1,
        status: "pending",
      })]);
    const hidden = await Effect.runPromise(getPublicSpeakers({ eventSlug: setup.eventSlug }).pipe(Effect.provide(AppLayer(env))));
    expect(hidden.speakers).toEqual([expect.objectContaining({ id: manual.id, displayName: "Managed keynote" })]);
  });
});
