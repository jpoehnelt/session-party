import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";
import type { AppError } from "contracts/errors";
import type { BrowserSessionPrincipal } from "contracts/principal";
import {
  assets,
  domainChanges,
  pages,
  taskCompletions,
  tasks,
} from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Authorizer,
  AppLayer,
  type CurrentUser,
  CurrentUser as CurrentUserTag,
  type Db,
  type Files,
  type Rooms,
} from "@/server/services";
import { operations } from "./operations";
import {
  createPortalResource,
  createPortalTask,
  deletePortalResource,
  deletePortalTask,
  getPortalSnapshot,
  getSpeakerDirectory,
  getPublicSpeakers,
  provisionSpeaker,
  setTaskCompletion,
  updatePortalResource,
  updatePortalTask,
  updateSpeakerPublication,
  uploadPortalAsset,
} from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };
type PortalRequirements = Authorizer | CurrentUser | Db | Files | Rooms;

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

const expectFailure = async (
  user: BrowserSessionPrincipal,
  effect: Effect.Effect<unknown, AppError, PortalRequirements>,
  tag: AppError["_tag"],
) => {
  const result = await runEither(user, effect);
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left._tag).toBe(tag);
};

const fixture = async () => {
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
    env.DB.prepare("insert into submissions (id, event_id, form_id, form_version_id, title, status, submitted_at, accepted_at, version, created_at, updated_at) values (?, ?, ?, ?, 'Accepted talk', 'accepted', ?, ?, 1, ?, ?)").bind(submissionId, eventId, formId, formVersionId, now, now, now, now),
    env.DB.prepare("insert into speakers (id, event_id, user_id, display_name, links, visible, version, created_at, updated_at) values (?, ?, ?, 'Exact speaker', '[]', 1, 1, ?, ?)").bind(speakerId, eventId, speakerUser.userId, now, now),
    env.DB.prepare("insert into submission_speakers (id, event_id, submission_id, speaker_id, is_primary, created_at) values (?, ?, ?, ?, 1, ?)").bind(`submission-speaker-${suffix}`, eventId, submissionId, speakerId, now),
    env.DB.prepare("insert into acceptance_events (id, event_id, submission_id, primary_submission_speaker_id, primary_speaker_id, primary_association_is_primary, type, submission_version, occurred_at) values (?, ?, ?, ?, ?, 1, 'accepted', 1, ?)").bind(acceptanceId, eventId, submissionId, `submission-speaker-${suffix}`, speakerId, now),
    env.DB.prepare("insert into speaker_provisioning (id, event_id, acceptance_event_id, submission_id, primary_speaker_id, status, available_at, attempt_count, version, created_at, updated_at) values (?, ?, ?, ?, ?, 'pending', ?, 0, 1, ?, ?)").bind(provisioningId, eventId, acceptanceId, submissionId, speakerId, now, now, now),
  ]);
  return { eventId, eventSlug, formId, formVersionId, submissionId, speakerId, provisioningId };
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
      .every(({ authorize }) => authorize.kind === "event" || authorize.kind === "public"))
      .toBe(true);
    expect(operations.find(({ id }) => id === "portal.getSnapshot")).toMatchObject({
      authorize: { kind: "browser-session" },
      rest: { path: "/events/:eventId/portal" },
    });
    expect(operations.find(({ id }) => id === "portal.getPublicSpeakers")).toMatchObject({
      authorize: { kind: "public" },
      rest: { path: "/public/events/:eventSlug/speakers" },
      mcp: { name: "portal_get_public_speakers" },
    });
  });

  it("requires organizer membership and the exact provisioned speaker browser session", async () => {
    const setup = await fixture();
    await expectFailure(otherUser, createPortalTask({ eventId: setup.eventId, name: "Bio", description: null, kind: "profile", formId: null, dueAt: null, order: 1 }), "Forbidden");
    await expectFailure(reviewer, getSpeakerDirectory({ eventId: setup.eventId }), "Forbidden");
    await expectFailure(speakerUser, getPortalSnapshot({ eventId: setup.eventId }), "Forbidden");
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    await expectFailure(otherUser, getPortalSnapshot({ eventId: setup.eventId }), "Forbidden");
    await expect(runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).resolves.toMatchObject({ provisioningStatus: "provisioned", speaker: { id: setup.speakerId } });
    await expect(runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventSlug }))).resolves.toMatchObject({
      event: { id: setup.eventId, slug: setup.eventSlug },
      speaker: { id: setup.speakerId },
    });
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
    const task = await runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Profile", description: null, kind: "profile", formId: null, dueAt: null, order: 1 }));
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("not_started");
    const completed = await runAs(speakerUser, setTaskCompletion({ eventId: setup.eventId, taskId: task.id, completed: true, data: { source: "portal" } }));
    expect(completed.completed).toBe(true);
    const db = drizzle(env.DB);
    expect(await db.select().from(taskCompletions).where(and(eq(taskCompletions.eventId, setup.eventId), eq(taskCompletions.taskId, task.id)))).toHaveLength(1);
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("ready");
    const uncompleted = await runAs(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: task.id,
      completed: false,
    }));
    expect(uncompleted.completed).toBe(false);
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("not_started");
    const recompleted = await runAs(speakerUser, setTaskCompletion({
      eventId: setup.eventId,
      taskId: task.id,
      completed: true,
      data: { source: "portal-retry" },
    }));
    expect(recompleted.completed).toBe(true);
    expect((await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }))).readiness.state).toBe("ready");
    const completionChanges = await db
      .select({ aggregateVersion: domainChanges.aggregateVersion })
      .from(domainChanges)
      .where(and(
        eq(domainChanges.eventId, setup.eventId),
        eq(domainChanges.aggregateId, `${task.id}:${setup.speakerId}`),
      ));
    expect(completionChanges.map(({ aggregateVersion }) => aggregateVersion)).toEqual([1, 2, 3]);
  });

  it("stores a policy-validated R2 upload and links headshot and task completion", async () => {
    const setup = await fixture();
    const task = await runAs(owner, createPortalTask({ eventId: setup.eventId, name: "Headshot", description: null, kind: "upload", formId: null, dueAt: null, order: 1 }));
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
    const result = await runAs(speakerUser, uploadPortalAsset({ eventId: setup.eventId, taskId: task.id, purpose: "headshot", filename: "headshot.png", contentType: "image/png", contentBase64: "iVBORw0KGgo=" }));
    expect(result.speaker.headshotAssetId).toBe(result.asset.id);
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
      purpose: "headshot",
      filename: "replacement.png",
      contentType: "image/png",
      contentBase64: "iVBORw0KGgo=",
    }));
    const snapshot = await runAs(speakerUser, getPortalSnapshot({ eventId: setup.eventId }));
    expect(snapshot.speaker.headshotAssetId).toBe(replacement.asset.id);
    expect(snapshot.assets.filter(({ purpose }) => purpose === "headshot")).toHaveLength(2);
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

  it("publishes only visible accepted provisioned public speaker fields", async () => {
    const setup = await fixture();
    await runAs(owner, provisionSpeaker({ eventId: setup.eventId, speakerId: setup.speakerId, provisioningId: setup.provisioningId, expectedVersion: 1 }));
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
    expect(gallery.speakers).toEqual([{
      id: setup.speakerId,
      displayName: "Exact speaker",
      title: null,
      company: null,
      bio: null,
      headshotUrl: null,
      links: [],
    }]);
    await runAs(owner, updateSpeakerPublication({ eventId: setup.eventId, speakerId: setup.speakerId, expectedVersion: 1, visible: false }));
    const hidden = await Effect.runPromise(getPublicSpeakers({ eventSlug: setup.eventSlug }).pipe(Effect.provide(AppLayer(env))));
    expect(hidden.speakers).toEqual([]);
  });
});
