import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import {
  airtableOutbox,
  airtablePendingEdits,
  acceptanceEvents,
  assets,
  events,
  formVersions,
  forms,
  integrations,
  pages,
  rooms,
  speakers,
  submissionSpeakers,
  submissions,
  taskCompletions,
  tasks,
  talks,
  tracks,
  users,
} from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AppLayer, CurrentUser, Db, Files } from "@/server/services";
import { operations } from "./operations";
import {
  completePortalTask,
  getPortal,
  getPortalAsset,
  safePortalEmbed,
  updatePortalProfile,
  uploadPortalAsset,
} from "./service";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const hasMigrations = (value: Cloudflare.Env): value is TestEnv => "TEST_MIGRATIONS" in value;
const NOW = Date.UTC(2026, 7, 9, 16, 0, 0);

const speakerPrincipal = (userId: string): Principal => ({
  kind: "browser-session",
  userId,
  email: `${userId}@example.com`,
  name: "Ada Rivera",
  sessionId: `session-${userId}`,
  expiresAt: NOW + 86_400_000,
});

const runAs = <A, E>(principal: Principal, effect: Effect.Effect<A, E, Db | CurrentUser | Files>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const runEither = <A, E>(principal: Principal, effect: Effect.Effect<A, E, Db | CurrentUser | Files>) =>
  Effect.runPromise(effect.pipe(
    Effect.either,
    Effect.provide(Layer.merge(AppLayer(env), Layer.succeed(CurrentUser, principal))),
  ));

const seedPortal = async (name: string) => {
  const db = drizzle(env.DB);
  const id = (suffix: string) => `${name}-${suffix}`;
  const now = new Date(NOW);
  const eventId = id("event");
  const userId = id("speaker-user");
  const otherUserId = id("other-user");
  const speakerId = id("speaker");
  const coSpeakerId = id("co-speaker");
  const cfpFormId = id("cfp-form");
  const cfpVersionId = id("cfp-v1");
  const taskFormId = id("task-form");
  const taskVersionId = id("task-v1");
  const submissionId = id("accepted-submission");
  const primaryAssociationId = id("primary-association");
  const uploadTaskId = id("upload-task");
  const profileTaskId = id("profile-task");
  const formTaskId = id("form-task");
  const confirmTaskId = id("confirm-task");

  await db.batch([
    db.insert(users).values([
      { id: userId, email: `${userId}@example.com`, name: "Ada Rivera", createdAt: now, updatedAt: now },
      { id: otherUserId, email: `${otherUserId}@example.com`, name: "Mallory", createdAt: now, updatedAt: now },
    ]),
    db.insert(events).values({ id: eventId, slug: id("summit"), name: "Practical Systems Summit", timezone: "America/Los_Angeles", location: "Oakland, CA", startsAt: new Date(NOW + 30 * 86_400_000), endsAt: new Date(NOW + 31 * 86_400_000), createdAt: now, updatedAt: now }),
    db.insert(forms).values([
      { id: cfpFormId, eventId, kind: "cfp", name: "Call for proposals", status: "open", createdAt: now, updatedAt: now },
      { id: taskFormId, eventId, kind: "task", name: "Travel details", status: "open", createdAt: now, updatedAt: now },
    ]),
    db.insert(formVersions).values([
      { id: cfpVersionId, eventId, formId: cfpFormId, versionNumber: 1, name: "Call for proposals", publishedAt: now, createdAt: now },
      { id: taskVersionId, eventId, formId: taskFormId, versionNumber: 1, name: "Travel details", publishedAt: now, createdAt: now },
    ]),
    db.insert(submissions).values({ id: submissionId, eventId, formId: cfpFormId, formVersionId: cfpVersionId, title: "Effects without ceremony", category: "Architecture", status: "accepted", submittedAt: now, acceptedAt: now, version: 2, createdAt: now, updatedAt: now }),
    db.insert(speakers).values([
      { id: speakerId, eventId, userId, displayName: "Ada Rivera", title: "Staff Engineer", company: "Harbor Labs", bio: null, links: [], visible: true, createdAt: now, updatedAt: now },
      { id: coSpeakerId, eventId, userId: null, displayName: "Lin Okafor", title: "Private title", company: "Private company", bio: "Private biography", links: [{ label: "Private", url: "https://private.example.com" }], visible: false, createdAt: now, updatedAt: now },
    ]),
    db.insert(submissionSpeakers).values([
      { id: primaryAssociationId, eventId, submissionId, speakerId, isPrimary: true, createdAt: now },
      { id: id("co-association"), eventId, submissionId, speakerId: coSpeakerId, isPrimary: false, createdAt: now },
    ]),
    db.insert(acceptanceEvents).values({ id: id("acceptance"), eventId, submissionId, primarySubmissionSpeakerId: primaryAssociationId, primarySpeakerId: speakerId, primaryAssociationIsPrimary: true, type: "accepted", submissionVersion: 2, actorUserId: null, occurredAt: now }),
    db.insert(tracks).values({ id: id("track"), eventId, name: "Systems", order: 1, createdAt: now, updatedAt: now }),
    db.insert(rooms).values({ id: id("room"), eventId, name: "Harbor stage", order: 1, createdAt: now, updatedAt: now }),
    db.insert(talks).values({ id: id("talk"), eventId, submissionId, title: "Effects without ceremony", description: "A practical session", trackId: id("track"), roomId: id("room"), startsAt: new Date(NOW + 30 * 86_400_000 + 3_600_000), durationMin: 45, status: "confirmed", createdAt: now, updatedAt: now }),
    db.insert(tasks).values([
      { id: profileTaskId, eventId, name: "Finish your profile", description: "Add the bio hosts will read.", kind: "profile", dueAt: new Date(NOW + 10 * 86_400_000), order: 1, createdAt: now, updatedAt: now },
      { id: formTaskId, eventId, name: "Travel details", description: "Share arrival details.", kind: "form", formId: taskFormId, dueAt: new Date(NOW + 12 * 86_400_000), order: 2, createdAt: now, updatedAt: now },
      { id: uploadTaskId, eventId, name: "Upload slides", description: "Send the final deck.", kind: "upload", order: 3, createdAt: now, updatedAt: now },
      { id: confirmTaskId, eventId, name: "Confirm attendance", kind: "confirm", order: 4, createdAt: now, updatedAt: now },
    ]),
    db.insert(pages).values([
      { id: id("safe-page"), eventId, slug: "venue", title: "Venue guide", body: "Use the speaker entrance on 10th Street.", htmlEmbed: '<iframe src="https://docs.google.com/presentation/d/abc/preview" onload="alert(1)"></iframe>', audience: "speakers", order: 1, createdAt: now, updatedAt: now },
      { id: id("unsafe-page"), eventId, slug: "unsafe", title: "Unsafe", body: null, htmlEmbed: '<iframe src="https://evil.example.com/embed"><script>alert(1)</script></iframe>', audience: "speakers", order: 2, createdAt: now, updatedAt: now },
    ]),
  ]);

  return {
    db,
    ids: { eventId, userId, otherUserId, speakerId, submissionId, taskFormId, taskVersionId, uploadTaskId, profileTaskId, formTaskId, confirmTaskId },
    eventSlug: id("summit"),
    principal: speakerPrincipal(userId),
  };
};

beforeAll(async () => {
  if (!hasMigrations(env)) throw new Error("TEST_MIGRATIONS binding is required");
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("speaker portal accepted journey", () => {
  it("shows only accepted-speaker context, co-speaker names, tasks, and safe resources", async () => {
    const seeded = await seedPortal("portal-read");
    const portal = await runAs(seeded.principal, getPortal({ eventSlug: seeded.eventSlug }));

    expect(portal.event.name).toBe("Practical Systems Summit");
    expect(portal.submissions).toHaveLength(1);
    expect(portal.submissions[0]).toMatchObject({
      title: "Effects without ceremony",
      coSpeakers: [
        { displayName: "Ada Rivera", isPrimary: true },
        { displayName: "Lin Okafor", isPrimary: false },
      ],
      talks: [{ roomName: "Harbor stage", trackName: "Systems", status: "confirmed" }],
    });
    expect(JSON.stringify(portal.submissions)).not.toContain("Private biography");
    expect(JSON.stringify(portal.submissions)).not.toContain("Private company");
    expect(portal.tasks.map(({ name }) => name)).toEqual(["Finish your profile", "Travel details", "Upload slides", "Confirm attendance"]);
    expect(portal.tasks.find(({ id }) => id === seeded.ids.profileTaskId)?.prerequisite.satisfied).toBe(false);
    expect(portal.pages[0]?.embed?.src).toBe("https://docs.google.com/presentation/d/abc/preview");
    expect(portal.pages[1]?.embed).toBeNull();
  });

  it("updates a profile idempotently and enforces task prerequisites", async () => {
    const seeded = await seedPortal("portal-mutate");
    const profileInput = {
      eventSlug: seeded.eventSlug,
      displayName: "Ada Rivera",
      title: "Principal Engineer",
      company: "Harbor Labs",
      bio: "Ada builds reliable systems for public-interest teams.",
      links: [{ label: "Website", url: "https://ada.example.com" }],
      expectedVersion: 1,
      idempotencyKey: "portal-profile-save-001",
    } as const;
    const saved = await runAs(seeded.principal, updatePortalProfile(profileInput));
    const replayed = await runAs(seeded.principal, updatePortalProfile(profileInput));
    expect(saved).toMatchObject({ profileVersion: 2, idempotent: false });
    expect(replayed).toMatchObject({ profileVersion: 2, idempotent: true });

    const profileTask = await runAs(seeded.principal, completePortalTask({ eventSlug: seeded.eventSlug, taskId: seeded.ids.profileTaskId, expectedVersion: 0, idempotencyKey: "portal-profile-task-001" }));
    expect(profileTask.taskCompletionVersion).toBe(1);
    const profileReplay = await runAs(seeded.principal, completePortalTask({ eventSlug: seeded.eventSlug, taskId: seeded.ids.profileTaskId, expectedVersion: 0, idempotencyKey: "portal-profile-task-001" }));
    expect(profileReplay.idempotent).toBe(true);

    const prematureForm = await runEither(seeded.principal, completePortalTask({ eventSlug: seeded.eventSlug, taskId: seeded.ids.formTaskId, expectedVersion: 0, idempotencyKey: "portal-form-task-before" }));
    expect(prematureForm._tag).toBe("Left");
    if (prematureForm._tag === "Left") expect(prematureForm.left._tag).toBe("Conflict");

    const now = new Date(NOW + 1_000);
    const taskSubmissionId = "portal-mutate-task-submission";
    await seeded.db.batch([
      seeded.db.insert(submissions).values({ id: taskSubmissionId, eventId: seeded.ids.eventId, formId: seeded.ids.taskFormId, formVersionId: seeded.ids.taskVersionId, title: "Travel details response", status: "withdrawn", submittedAt: now, version: 1, createdAt: now, updatedAt: now }),
      seeded.db.insert(submissionSpeakers).values({ id: "portal-mutate-task-association", eventId: seeded.ids.eventId, submissionId: taskSubmissionId, speakerId: seeded.ids.speakerId, isPrimary: true, createdAt: now }),
    ]);
    const withdrawnPortal = await runAs(seeded.principal, getPortal({ eventSlug: seeded.eventSlug }));
    expect(withdrawnPortal.tasks.find(({ id }) => id === seeded.ids.formTaskId)?.prerequisite.satisfied).toBe(false);
    const withdrawnForm = await runEither(seeded.principal, completePortalTask({ eventSlug: seeded.eventSlug, taskId: seeded.ids.formTaskId, expectedVersion: 0, idempotencyKey: "portal-form-task-withdrawn" }));
    expect(withdrawnForm._tag).toBe("Left");
    if (withdrawnForm._tag === "Left") expect(withdrawnForm.left._tag).toBe("Conflict");
    await seeded.db.update(submissions).set({ status: "submitted", version: 2, updatedAt: new Date(NOW + 2_000) }).where(eq(submissions.id, taskSubmissionId));
    const completedForm = await runAs(seeded.principal, completePortalTask({ eventSlug: seeded.eventSlug, taskId: seeded.ids.formTaskId, expectedVersion: 0, idempotencyKey: "portal-form-task-after-1" }));
    expect(completedForm.taskCompletionVersion).toBe(1);
  });
  it("allows only one concurrent mutation at the same speaker version", async () => {
    const seeded = await seedPortal("portal-profile-race");
    const [first, second] = await Promise.all([
      runEither(seeded.principal, updatePortalProfile({
        eventSlug: seeded.eventSlug,
        displayName: "Ada First",
        bio: "First concurrent biography.",
        expectedVersion: 1,
        idempotencyKey: "portal-profile-race-first",
      })),
      runEither(seeded.principal, updatePortalProfile({
        eventSlug: seeded.eventSlug,
        displayName: "Ada Second",
        bio: "Second concurrent biography.",
        expectedVersion: 1,
        idempotencyKey: "portal-profile-race-second",
      })),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter(({ _tag }) => _tag === "Right")).toHaveLength(1);
    const rejected = outcomes.find(({ _tag }) => _tag === "Left");
    expect(rejected?._tag).toBe("Left");
    if (rejected?._tag === "Left") expect(rejected.left._tag).toBe("Conflict");
    const [stored] = await seeded.db.select().from(speakers).where(eq(speakers.id, seeded.ids.speakerId));
    expect(stored?.version).toBe(2);
    expect(["Ada First", "Ada Second"]).toContain(stored?.displayName);
  });
  it("queues Airtable-authoritative fields while applying local links and projected task readiness", async () => {
    const seeded = await seedPortal("portal-airtable");
    const now = new Date(NOW);
    await seeded.db.insert(integrations).values({
      id: "portal-airtable-integration",
      eventId: seeded.ids.eventId,
      kind: "airtable",
      secretRef: "secret://airtable/test",
      config: {},
      createdAt: now,
      updatedAt: now,
    });
    const result = await runAs(seeded.principal, updatePortalProfile({
      eventSlug: seeded.eventSlug,
      displayName: "Ada Rivera",
      title: "Principal Engineer",
      company: "Harbor Labs",
      bio: "A pending speaker-authored biography.",
      links: [{ label: "Website", url: "https://ada.example.com" }],
      expectedVersion: 1,
      idempotencyKey: "portal-airtable-profile-001",
    }));
    expect(result.profileVersion).toBe(2);
    const [stored] = await seeded.db.select().from(speakers).where(eq(speakers.id, seeded.ids.speakerId));
    expect(stored).toMatchObject({ title: "Staff Engineer", bio: null, links: [{ label: "Website", url: "https://ada.example.com" }], version: 2 });
    const pending = await seeded.db.select().from(airtablePendingEdits).where(eq(airtablePendingEdits.entityId, seeded.ids.speakerId));
    expect(pending.map(({ fieldKey }) => fieldKey).sort()).toEqual(["bio", "title"]);
    const outbox = await seeded.db.select().from(airtableOutbox).where(eq(airtableOutbox.entityId, seeded.ids.speakerId));
    expect(outbox).toHaveLength(2);
    expect(outbox.map(({ outboundRevision }) => outboundRevision).sort()).toEqual([1, 2]);
    const portal = await runAs(seeded.principal, getPortal({ eventSlug: seeded.eventSlug }));
    expect(portal.profile).toMatchObject({ title: "Principal Engineer", bio: "A pending speaker-authored biography.", pendingSyncFields: ["title", "bio"] });
    expect(portal.tasks.find(({ id }) => id === seeded.ids.profileTaskId)?.prerequisite.satisfied).toBe(true);
    const completed = await runAs(seeded.principal, completePortalTask({
      eventSlug: seeded.eventSlug,
      taskId: seeded.ids.profileTaskId,
      expectedVersion: 0,
      idempotencyKey: "portal-airtable-profile-task",
    }));
    expect(completed.taskCompletionVersion).toBe(1);
  });



  it("stores and replaces real R2 assets linked to the speaker and upload task", async () => {
    const seeded = await seedPortal("portal-assets");
    const first = await runAs(seeded.principal, uploadPortalAsset({
      eventSlug: seeded.eventSlug,
      taskId: seeded.ids.uploadTaskId,
      purpose: "slides",
      filename: "session.pdf",
      contentType: "application/pdf",
      contentBase64: btoa("first deck"),
      expectedVersion: 0,
      idempotencyKey: "portal-slides-upload-001",
    }));
    expect(first).toMatchObject({ taskId: seeded.ids.uploadTaskId, taskCompletionVersion: 1, idempotent: false });
    const replay = await runAs(seeded.principal, uploadPortalAsset({
      eventSlug: seeded.eventSlug,
      taskId: seeded.ids.uploadTaskId,
      purpose: "slides",
      filename: "session.pdf",
      contentType: "application/pdf",
      contentBase64: btoa("first deck"),
      expectedVersion: 0,
      idempotencyKey: "portal-slides-upload-001",
    }));
    expect(replay).toMatchObject({ assetId: first.assetId, idempotent: true });

    const content = await runAs(seeded.principal, getPortalAsset({ eventSlug: seeded.eventSlug, assetId: first.assetId! }));
    expect(atob(content.contentBase64)).toBe("first deck");
    const replacement = await runAs(seeded.principal, uploadPortalAsset({
      eventSlug: seeded.eventSlug,
      taskId: seeded.ids.uploadTaskId,
      purpose: "slides",
      filename: "session-final.pdf",
      contentType: "application/pdf",
      contentBase64: btoa("final deck"),
      expectedVersion: 1,
      idempotencyKey: "portal-slides-upload-002",
    }));
    expect(replacement).toMatchObject({ taskCompletionVersion: 2 });
    const portal = await runAs(seeded.principal, getPortal({ eventSlug: seeded.eventSlug }));
    expect(portal.tasks.find(({ id }) => id === seeded.ids.uploadTaskId)?.completion?.asset?.filename).toBe("session-final.pdf");
    expect(await seeded.db.select().from(assets).where(and(eq(assets.eventId, seeded.ids.eventId), eq(assets.id, first.assetId!)))).toHaveLength(0);
    expect(await seeded.db.select().from(taskCompletions).where(eq(taskCompletions.taskId, seeded.ids.uploadTaskId))).toMatchObject([{ version: 2 }]);
  });

  it("rejects non-speakers, manual upload completion, and unsafe embeds", async () => {
    const seeded = await seedPortal("portal-denied");
    const denied = await runEither(speakerPrincipal(seeded.ids.otherUserId), getPortal({ eventSlug: seeded.eventSlug }));
    expect(denied._tag).toBe("Left");
    if (denied._tag === "Left") expect(denied.left._tag).toBe("Forbidden");

    const manualUpload = await runEither(seeded.principal, completePortalTask({ eventSlug: seeded.eventSlug, taskId: seeded.ids.uploadTaskId, expectedVersion: 0, idempotencyKey: "portal-manual-upload-001" }));
    expect(manualUpload._tag).toBe("Left");
    if (manualUpload._tag === "Left") expect(manualUpload.left._tag).toBe("Conflict");
    expect(safePortalEmbed('<img src=x onerror="alert(1)">', "Unsafe")).toBeNull();
    expect(safePortalEmbed('<iframe src="javascript:alert(1)"></iframe>', "Unsafe")).toBeNull();
  });

  it("declares the portal route and MCP operations without transport-side business logic", () => {
    expect(operations.map(({ id }) => id)).toEqual([
      "portal.completeTask",
      "portal.get",
      "portal.getAsset",
      "portal.updateProfile",
      "portal.uploadAsset",
    ]);
    expect(operations.filter((operation) => "mcp" in operation).map((operation) => operation.id)).toEqual([
      "portal.completeTask",
      "portal.get",
      "portal.updateProfile",
      "portal.uploadAsset",
    ]);
  });
});
