import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import {
  acceptanceEvents,
  apiKeys,
  auditLog,
  domainChanges,
  eventMembers,
  events,
  forms,
  formVersionFields,
  formVersions,
  idempotencyRecords,
  reviewAssignments,
  reviewRounds,
  reviews,
  speakers,
  speakerProvisioning,
  submissionAnswers,
  submissionSpeakers,
  submissions,
  users,
} from "contracts/schema";
import * as dbSchema from "contracts/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Either, Layer, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { AiService, CurrentUser, Db } from "@/server/services";
import {
  activeRoundFixture,
  completedRoundFixture,
  pendingRoundFixture,
  contentionFixture,
  fixtureClock,
  fixtureEventId,
  fixtureOwnerId,
  fixturePrimarySpeakerId,
  fixtureReviewerId,
  submissionQueueFixture,
} from "./fixtures";
import { operations } from "./operations";
import { SaveScoreInput } from "./schema";
import {
  acceptSubmission,
  advanceReviewRound,
  assignReviewer,
  createReviewRound,
  getWorkbench,
  rejectSubmission,
  requestAiSuggestion,
  saveScore,
} from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };

function hasTestMigrations(value: Cloudflare.Env): value is TestEnv {
  return "TEST_MIGRATIONS" in value;
}

const owner: Principal = {
  kind: "browser-session",
  userId: fixtureOwnerId,
  email: "morgan@example.com",
  name: "Morgan Chen",
  sessionId: "session_owner",
  expiresAt: fixtureClock + 86_400_000,
};

const reviewer: Principal = {
  kind: "browser-session",
  userId: fixtureReviewerId,
  email: "ada@example.com",
  name: "Ada Rivera",
  sessionId: "session_reviewer",
  expiresAt: fixtureClock + 86_400_000,
};

const speakerOnly: Principal = {
  kind: "browser-session",
  userId: "user_speaker_only",
  email: "speaker@example.com",
  name: "Speaker Only",
  sessionId: "session_speaker",
  expiresAt: fixtureClock + 86_400_000,
};

const reviewApiKey: Principal = {
  kind: "api-key",
  userId: "api-key:review-automation",
  apiKeyId: "review_automation",
  eventId: fixtureEventId,
  name: "Review automation",
  scopes: ["reviews:write", "submissions:write", "speakers:write"],
  expiresAt: fixtureClock + 86_400_000,
};

const db = drizzle(env.DB, { schema: dbSchema });
const dbLayer = Layer.succeed(Db, { db });
let lastAiPrompt = "";
const aiLayer = Layer.succeed(AiService, {
  reviewText: (prompt: string) => {
    lastAiPrompt = prompt;
    return Effect.succeed(JSON.stringify({
      scores: { relevance: 5, specificity: 4, delivery: 3 },
      comment: "Specific and relevant; confirm the timing evidence before saving.",
    }));
  },
});

const runAs = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.mergeAll(dbLayer, aiLayer, Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<A, E, never>,
  );

const runEitherAs = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.either,
      Effect.provide(Layer.mergeAll(dbLayer, aiLayer, Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<Either.Either<A, E>, never, never>,
  );



beforeAll(async () => {
  if (!hasTestMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);

  const createdAt = new Date(fixtureClock - 30 * 86_400_000);
  await db.insert(users).values([
    { id: fixtureOwnerId, email: owner.email!, name: owner.name, createdAt, updatedAt: createdAt },
    { id: fixtureReviewerId, email: reviewer.email!, name: reviewer.name, createdAt, updatedAt: createdAt },
    { id: "user_reviewer_dev", email: "dev@example.com", name: "Dev Shah", createdAt, updatedAt: createdAt },
    { id: speakerOnly.userId, email: speakerOnly.email!, name: speakerOnly.name, createdAt, updatedAt: createdAt },
  ]);
  await db.insert(events).values({
    id: fixtureEventId,
    slug: "fieldcraft-2026",
    name: "Fieldcraft 2026",
    timezone: "America/Los_Angeles",
    createdAt,
    updatedAt: new Date(fixtureClock),
  });
  await db.insert(eventMembers).values([
    { id: "member_owner", eventId: fixtureEventId, userId: fixtureOwnerId, role: "owner", createdAt, updatedAt: createdAt },
    { id: "member_reviewer_ada", eventId: fixtureEventId, userId: fixtureReviewerId, role: "reviewer", createdAt, updatedAt: createdAt },
    { id: "member_reviewer_dev", eventId: fixtureEventId, userId: "user_reviewer_dev", role: "reviewer", createdAt, updatedAt: createdAt },
  ]);
  await db.insert(apiKeys).values({
    id: reviewApiKey.apiKeyId,
    eventId: fixtureEventId,
    name: reviewApiKey.name,
    keyHash: "a".repeat(64),
    scopes: reviewApiKey.scopes,
    expiresAt: new Date(reviewApiKey.expiresAt),
    createdBy: fixtureOwnerId,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(forms).values([
    {
      id: "form_cfp", eventId: fixtureEventId, kind: "cfp", name: "Main CFP", status: "closed", createdAt, updatedAt: createdAt,
    },
    {
      id: "form_task", eventId: fixtureEventId, kind: "task", name: "Accepted speaker logistics", status: "open", createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(formVersions).values([
    {
      id: "form_version_01", eventId: fixtureEventId, formId: "form_cfp", versionNumber: 1,
      name: "Main CFP", publishedAt: createdAt, createdAt,
    },
    {
      id: "form_version_task", eventId: fixtureEventId, formId: "form_task", versionNumber: 1,
      name: "Accepted speaker logistics", publishedAt: createdAt, createdAt,
    },
  ]);
  await db.insert(formVersionFields).values([
    {
      id: "field_abstract", eventId: fixtureEventId, formVersionId: "form_version_01", order: 1,
      type: "textarea", label: "Proposal summary", semanticKey: "submissionAbstract", required: true, createdAt,
    },
    {
      id: "field_task_notes", eventId: fixtureEventId, formVersionId: "form_version_task", order: 1,
      type: "textarea", label: "Logistics notes", required: true, createdAt,
    },
  ]);
  await db.insert(speakers).values({
    id: fixturePrimarySpeakerId,
    eventId: fixtureEventId,
    userId: speakerOnly.userId,
    displayName: "Jordan Lee",
    createdAt,
    updatedAt: createdAt,
  });

  const submissionSeeds = submissionQueueFixture.map((submission) => ({
    id: submission.id,
    eventId: fixtureEventId,
    formId: "form_cfp",
    formVersionId: "form_version_01",
    title: submission.title,
    category: submission.category,
    status: submission.status,
    submittedAt: new Date(submission.submittedAt),
    acceptedAt: submission.status === "accepted" ? new Date(fixtureClock - 86_400_000) : null,
    version: submission.version,
    createdAt: new Date(submission.submittedAt),
    updatedAt: new Date(submission.submittedAt),
  }));
  for (const seed of submissionSeeds) await db.insert(submissions).values(seed);
  await db.insert(submissions).values({
    id: "submission_task_form",
    eventId: fixtureEventId,
    formId: "form_task",
    formVersionId: "form_version_task",
    title: "Accepted speaker logistics",
    status: "submitted",
    submittedAt: createdAt,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const answerSeeds = submissionQueueFixture.map((submission, index) => ({
    id: `answer_${String(index + 1).padStart(2, "0")}`,
    eventId: fixtureEventId,
    submissionId: submission.id,
    formVersionId: "form_version_01",
    formVersionFieldId: "field_abstract",
    value: `Abstract evidence for ${submission.title}.`,
    createdAt,
    updatedAt: createdAt,
  }));
  for (const seed of answerSeeds) await db.insert(submissionAnswers).values(seed);
  await db.insert(submissionAnswers).values({
    id: "answer_task_form",
    eventId: fixtureEventId,
    submissionId: "submission_task_form",
    formVersionId: "form_version_task",
    formVersionFieldId: "field_task_notes",
    value: "Task-form answer that must never enter CFP review.",
    createdAt,
    updatedAt: createdAt,
  });
  const speakerLinkSeeds = submissionQueueFixture.map((submission, index) => ({
    id: `submission_speaker_${String(index + 1).padStart(2, "0")}`,
    eventId: fixtureEventId,
    submissionId: submission.id,
    speakerId: fixturePrimarySpeakerId,
    isPrimary: true,
    createdAt,
  }));
  for (const seed of speakerLinkSeeds) await db.insert(submissionSpeakers).values(seed);
  await db.insert(submissionSpeakers).values({
    id: "submission_speaker_task",
    eventId: fixtureEventId,
    submissionId: "submission_task_form",
    speakerId: fixturePrimarySpeakerId,
    isPrimary: true,
    createdAt,
  });
  await db.insert(reviewRounds).values([
    {
      id: completedRoundFixture.id,
      eventId: fixtureEventId,
      name: completedRoundFixture.name,
      order: completedRoundFixture.order,
      status: completedRoundFixture.status,
      rubric: completedRoundFixture.rubric,
      version: completedRoundFixture.version,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: activeRoundFixture.id,
      eventId: fixtureEventId,
      name: activeRoundFixture.name,
      order: activeRoundFixture.order,
      status: activeRoundFixture.status,
      rubric: activeRoundFixture.rubric,
      version: activeRoundFixture.version,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: pendingRoundFixture.id,
      eventId: fixtureEventId,
      name: pendingRoundFixture.name,
      order: pendingRoundFixture.order,
      status: pendingRoundFixture.status,
      rubric: pendingRoundFixture.rubric,
      version: pendingRoundFixture.version,
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  const assignmentSeeds = [
    ...submissionQueueFixture.slice(1, 13).map((submission, index) => ({
      id: `assignment_ada_${String(index + 1).padStart(2, "0")}`,
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: submission.id,
      reviewerUserId: fixtureReviewerId,
      createdAt,
      updatedAt: createdAt,
    })),
    {
      id: "assignment_dev_private",
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_05",
      reviewerUserId: "user_reviewer_dev",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "assignment_owner_complete",
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      submissionId: "submission_22",
      reviewerUserId: fixtureOwnerId,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "assignment_task_legacy",
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_task_form",
      reviewerUserId: fixtureReviewerId,
      createdAt,
      updatedAt: createdAt,
    },
  ];
  for (const seed of assignmentSeeds) await db.insert(reviewAssignments).values(seed);
  await db.insert(reviews).values([
    {
      id: "review_dev_private",
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_05",
      reviewerUserId: "user_reviewer_dev",
      ai: false,
      score: 2,
      scores: { relevance: 2, specificity: 2, delivery: 2 },
      comment: "Dev private comment",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "review_ai_seeded",
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_07",
      reviewerUserId: null,
      ai: true,
      score: 4,
      scores: { relevance: 5, specificity: 4, delivery: 3 },
      comment: "Seeded non-authoritative suggestion",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(acceptanceEvents).values({
    id: "acceptance_seeded",
    eventId: fixtureEventId,
    submissionId: "submission_01",
    primarySubmissionSpeakerId: "submission_speaker_01",
    primarySpeakerId: fixturePrimarySpeakerId,
    type: "accepted",
    submissionVersion: 5,
    actorUserId: fixtureOwnerId,
    occurredAt: new Date(fixtureClock - 86_400_000),
  });
  await db.insert(speakerProvisioning).values({
    id: "provisioning_seeded",
    eventId: fixtureEventId,
    acceptanceEventId: "acceptance_seeded",
    submissionId: "submission_01",
    primarySpeakerId: fixturePrimarySpeakerId,
    status: "provisioned",
    availableAt: new Date(fixtureClock - 86_400_000),
    provisionedAt: new Date(fixtureClock - 80_000_000),
    createdAt,
    updatedAt: createdAt,
  });
});

describe("review and acceptance slice", () => {
  it("publishes bytewise-stable canonical review operations with event authorization", () => {
    const ids = operations.map((operation) => operation.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual([
      "review.acceptSubmission",
      "review.advanceRound",
      "review.assignReviewer",
      "review.createRound",
      "review.getWorkbench",
      "review.rejectSubmission",
      "review.requestAiSuggestion",
      "review.saveScore",
    ]);
    for (const operation of operations) {
      expect(operation.authorize.kind).toBe("event");
      expect(operation.rest).toBeDefined();
      expect(operation.mcp).toBeDefined();
    }
    expect(operations[0].emits).toEqual(["review.submission.accepted", "speaker.provisioning.requested"]);
    const acceptanceAuthorization = operations[0].authorize;
    expect(acceptanceAuthorization.kind).toBe("event");
    if (acceptanceAuthorization.kind === "event") expect(acceptanceAuthorization.apiKey.kind).toBe("deny");
    const aiAuthorization = operations.find((operation) => operation.id === "review.requestAiSuggestion")!.authorize;
    expect(aiAuthorization.kind).toBe("event");
    if (aiAuthorization.kind === "event") {
      expect(aiAuthorization.apiKey).toEqual({ kind: "api-key", scopes: ["reviews:write"] });
    }
    const scoreAuthorization = operations.find((operation) => operation.id === "review.saveScore")!.authorize;
    expect(scoreAuthorization.kind).toBe("event");
    if (scoreAuthorization.kind === "event") expect(scoreAuthorization.apiKey.kind).toBe("deny");
  });

  it("creates pending or active rounds with validated rubrics, authoritative counts, and replay", async () => {
    const eventId = "event_round_create";
    const createdAt = new Date(fixtureClock);
    await db.insert(events).values({
      id: eventId,
      slug: "round-create",
      name: "Round creation",
      timezone: "UTC",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(eventMembers).values({
      id: "member_round_create_owner",
      eventId,
      userId: fixtureOwnerId,
      role: "owner",
      createdAt,
      updatedAt: createdAt,
    });
    const rubric = {
      criteria: [{ key: "clarity", label: "Clarity", max: 5 as const }] as const,
    };
    const activeInput = {
      eventId,
      name: "  Program fit  ",
      initialStatus: "active" as const,
      rubric,
      expectedRoundCount: 0,
      idempotencyKey: "round-create-active-01",
      requestId: "request_round_create_active",
    };
    const created = await runAs(owner, createReviewRound(activeInput));
    const replayed = await runAs(owner, createReviewRound(activeInput));
    expect(created).toMatchObject({
      idempotent: false,
      round: { name: "Program fit", order: 1, status: "active", version: 1 },
    });
    expect(replayed).toEqual({ ...created, idempotent: true });

    const pending = await runAs(owner, createReviewRound({
      eventId,
      name: "Final selection",
      initialStatus: "pending",
      rubric,
      expectedRoundCount: 1,
      idempotencyKey: "round-create-pending-02",
      requestId: "request_round_create_pending",
    }));
    expect(pending.round).toMatchObject({ order: 2, status: "pending", version: 1 });

    const staleCount = await runEitherAs(owner, createReviewRound({
      eventId,
      name: "Stale round",
      initialStatus: "pending",
      rubric,
      expectedRoundCount: 1,
      idempotencyKey: "round-create-stale-03",
      requestId: "request_round_create_stale",
    }));
    expect(staleCount._tag).toBe("Left");
    if (staleCount._tag === "Left") expect(staleCount.left._tag).toBe("Conflict");

    const duplicateRubric = await runEitherAs(owner, createReviewRound({
      eventId,
      name: "Bad rubric",
      initialStatus: "pending",
      rubric: { criteria: [
        { key: "clarity", label: "Clarity", max: 5 },
        { key: "clarity", label: "Clarity again", max: 5 },
      ] },
      expectedRoundCount: 2,
      idempotencyKey: "round-create-invalid-04",
      requestId: "request_round_create_invalid",
    }));
    expect(duplicateRubric._tag).toBe("Left");
    if (duplicateRubric._tag === "Left") expect(duplicateRubric.left._tag).toBe("Validation");

    const persisted = await db.select().from(reviewRounds).where(eq(reviewRounds.eventId, eventId));
    expect(persisted).toHaveLength(2);
    expect(persisted.filter((round) => round.status === "active")).toHaveLength(1);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "review.createRound")))).toHaveLength(2);
  });

  it("atomically completes the active round and advances only to the next authoritative version", async () => {
    const eventId = "event_round_advance";
    const createdAt = new Date(fixtureClock);
    await db.insert(events).values({
      id: eventId,
      slug: "round-advance",
      name: "Round advancement",
      timezone: "UTC",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(eventMembers).values({
      id: "member_round_advance_owner",
      eventId,
      userId: fixtureOwnerId,
      role: "owner",
      createdAt,
      updatedAt: createdAt,
    });
    const rubric = { criteria: [{ key: "clarity", label: "Clarity", max: 5 as const }] };
    await db.insert(reviewRounds).values([
      { id: "round_advance_complete", eventId, name: "Screen", order: 1, status: "complete", rubric, version: 2, createdAt, updatedAt: createdAt },
      { id: "round_advance_active", eventId, name: "Fit", order: 2, status: "active", rubric, version: 4, createdAt, updatedAt: createdAt },
      { id: "round_advance_next", eventId, name: "Final", order: 3, status: "pending", rubric, version: 1, createdAt, updatedAt: createdAt },
      { id: "round_advance_later", eventId, name: "Reserve", order: 4, status: "pending", rubric, version: 1, createdAt, updatedAt: createdAt },
    ]);
    const input = {
      eventId,
      roundId: "round_advance_active",
      expectedVersion: 4,
      nextRoundId: "round_advance_next",
      expectedNextVersion: 1,
      idempotencyKey: "round-advance-atomic-01",
      requestId: "request_round_advance",
    } as const;
    const advanced = await runAs(owner, advanceReviewRound(input));
    const replayed = await runAs(owner, advanceReviewRound(input));
    expect(advanced.idempotent).toBe(false);
    expect(replayed).toEqual({ ...advanced, idempotent: true });
    expect(advanced.rounds.map(({ id, status, version }) => ({ id, status, version }))).toEqual([
      { id: "round_advance_complete", status: "complete", version: 2 },
      { id: "round_advance_active", status: "complete", version: 5 },
      { id: "round_advance_next", status: "active", version: 2 },
      { id: "round_advance_later", status: "pending", version: 1 },
    ]);

    const stale = await runEitherAs(owner, advanceReviewRound({
      ...input,
      idempotencyKey: "round-advance-stale-02",
      requestId: "request_round_advance_stale",
    }));
    expect(stale._tag).toBe("Left");
    if (stale._tag === "Left") expect(stale.left._tag).toBe("Conflict");

    const [skipEvent] = await db.insert(events).values({
      id: "event_round_skip",
      slug: "round-skip",
      name: "Round skip",
      timezone: "UTC",
      createdAt,
      updatedAt: createdAt,
    }).returning();
    await db.insert(eventMembers).values({
      id: "member_round_skip_owner", eventId: skipEvent!.id, userId: fixtureOwnerId, role: "owner", createdAt, updatedAt: createdAt,
    });
    await db.insert(reviewRounds).values([
      { id: "round_skip_active", eventId: skipEvent!.id, name: "First", order: 1, status: "active", rubric, version: 1, createdAt, updatedAt: createdAt },
      { id: "round_skip_next", eventId: skipEvent!.id, name: "Second", order: 2, status: "pending", rubric, version: 1, createdAt, updatedAt: createdAt },
      { id: "round_skip_target", eventId: skipEvent!.id, name: "Third", order: 3, status: "pending", rubric, version: 1, createdAt, updatedAt: createdAt },
    ]);
    const skipped = await runEitherAs(owner, advanceReviewRound({
      eventId: skipEvent!.id,
      roundId: "round_skip_active",
      expectedVersion: 1,
      nextRoundId: "round_skip_target",
      expectedNextVersion: 1,
      idempotencyKey: "round-advance-skip-03",
      requestId: "request_round_advance_skip",
    }));
    expect(skipped._tag).toBe("Left");
    if (skipped._tag === "Left") expect(skipped.left._tag).toBe("Conflict");

    const persisted = await db.select().from(reviewRounds).where(eq(reviewRounds.eventId, eventId));
    expect(persisted.filter((round) => round.status === "active").map((round) => round.id)).toEqual(["round_advance_next"]);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "review.advanceRound")))).toHaveLength(1);
  });


  it("returns all 60 proposals to organizers but only assigned proposals and private review data to reviewers", async () => {
    const organizerView = await runAs(owner, getWorkbench({ eventId: fixtureEventId, page: 1, pageSize: 60 }));
    expect(organizerView.queue).toHaveLength(60);

    const reviewerView = await runAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      selectedSubmissionId: "submission_05",
      page: 1,
      pageSize: 60,
    }));
    expect(reviewerView.queue).toHaveLength(12);
    expect(reviewerView.selected?.assignments.map((assignment) => assignment.reviewerUserId)).toEqual([fixtureReviewerId]);
    expect(reviewerView.selected?.reviews).toEqual([]);
    expect(JSON.stringify(reviewerView)).not.toContain("Dev private comment");
    const unassignedRound = await runAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      page: 1,
      pageSize: 60,
    }));
    expect(unassignedRound.queue).toEqual([]);

    const forbidden = await runEitherAs(speakerOnly, getWorkbench({ eventId: fixtureEventId, page: 1, pageSize: 60 }));
    expect(forbidden._tag).toBe("Left");
    if (forbidden._tag === "Left") expect(forbidden.left._tag).toBe("Forbidden");
  });

  it("excludes task-form submissions and rejects every review mutation for them", async () => {
    const organizerView = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      page: 1,
      pageSize: 60,
    }));
    expect(organizerView.queue.map((submission) => submission.id)).not.toContain("submission_task_form");
    expect(organizerView.pagination.total).toBe(60);
    const selectedTaskForm = await runEitherAs(owner, getWorkbench({
      eventId: fixtureEventId,
      selectedSubmissionId: "submission_task_form",
      page: 1,
      pageSize: 60,
    }));
    expect(selectedTaskForm._tag).toBe("Left");
    if (selectedTaskForm._tag === "Left") expect(selectedTaskForm.left._tag).toBe("NotFound");

    const assignment = await runEitherAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_task_form",
      reviewerUserId: "user_reviewer_dev",
      expectedVersion: 0,
      requestId: "request_assign_task_form",
    }));
    const score = await runEitherAs(reviewer, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_task_form",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 4 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 4 },
      ],
      requestId: "request_score_task_form",
    }));
    const aiSuggestion = await runEitherAs(owner, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_task_form",
      requestId: "request_ai_task_form",
    }));
    const acceptance = await runEitherAs(owner, acceptSubmission({
      eventId: fixtureEventId,
      submissionId: "submission_task_form",
      expectedVersion: 1,
      idempotencyKey: "accept-task-form",
      requestId: "request_accept_task_form",
    }));
    const rejection = await runEitherAs(owner, rejectSubmission({
      eventId: fixtureEventId,
      submissionId: "submission_task_form",
      expectedVersion: 1,
      idempotencyKey: "reject-task-form",
      requestId: "request_reject_task_form",
    }));

    for (const result of [assignment, score, aiSuggestion, acceptance, rejection]) {
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left._tag).toBe("NotFound");
    }
    expect(await db.select().from(reviews).where(eq(reviews.submissionId, "submission_task_form"))).toEqual([]);
    expect(await db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, "submission_task_form"))).toEqual([]);
    const taskAssignments = await db.select().from(reviewAssignments).where(eq(reviewAssignments.submissionId, "submission_task_form"));
    expect(taskAssignments.map((row) => row.id)).toEqual(["assignment_task_legacy"]);
    const [taskSubmission] = await db.select().from(submissions).where(eq(submissions.id, "submission_task_form"));
    expect(taskSubmission).toMatchObject({ status: "submitted", version: 1, acceptedAt: null });
  });

  it("assigns reviewers with version contention and records admin-only change evidence", async () => {
    const first = await runAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_20",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_assign_01",
    }));
    expect(first.created).toBe(true);
    const repeated = await runAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_20",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 1,
      requestId: "request_assign_02",
    }));
    expect(repeated).toMatchObject({ created: false, assignment: { id: first.assignment.id, version: 1 } });
    const stale = await runEitherAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_20",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_assign_stale",
    }));
    expect(stale._tag).toBe("Left");
    if (stale._tag === "Left") expect(stale.left._tag).toBe("Conflict");
  });

  it("allows pending assignments but limits scoring and AI suggestions to active rounds", async () => {
    const pendingAssignment = await runAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: pendingRoundFixture.id,
      submissionId: "submission_21",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_assign_pending",
    }));
    expect(pendingAssignment.created).toBe(true);

    const completedAssignment = await runEitherAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      submissionId: "submission_23",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_assign_complete",
    }));
    expect(completedAssignment._tag).toBe("Left");
    if (completedAssignment._tag === "Left") expect(completedAssignment.left._tag).toBe("Conflict");

    const pendingScore = await runEitherAs(reviewer, saveScore({
      eventId: fixtureEventId,
      roundId: pendingRoundFixture.id,
      submissionId: "submission_21",
      expectedVersion: 0,
      scores: [
        { criterionKey: "program_balance", score: 4 },
        { criterionKey: "readiness", score: 4 },
      ],
      requestId: "request_score_pending",
    }));
    expect(pendingScore._tag).toBe("Left");
    if (pendingScore._tag === "Left") expect(pendingScore.left._tag).toBe("Conflict");

    const completedScore = await runEitherAs(owner, saveScore({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      submissionId: "submission_22",
      expectedVersion: 0,
      scores: [
        { criterionKey: "clarity", score: 4 },
        { criterionKey: "originality", score: 4 },
      ],
      requestId: "request_score_complete",
    }));
    expect(completedScore._tag).toBe("Left");
    if (completedScore._tag === "Left") expect(completedScore.left._tag).toBe("Conflict");

    const pendingAi = await runEitherAs(reviewer, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: pendingRoundFixture.id,
      submissionId: "submission_21",
      requestId: "request_ai_pending",
    }));
    expect(pendingAi._tag).toBe("Left");
    if (pendingAi._tag === "Left") expect(pendingAi.left._tag).toBe("Conflict");

    const completedAi = await runEitherAs(owner, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      submissionId: "submission_22",
      requestId: "request_ai_complete",
    }));
    expect(completedAi._tag).toBe("Left");
    if (completedAi._tag === "Left") expect(completedAi.left._tag).toBe("Conflict");
  });

  it("enforces complete bounded 1–5 human scoring without changing submission status", async () => {
    const decoded = Schema.decodeUnknownEither(SaveScoreInput)({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_05",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 6 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 3 },
      ],
      requestId: "request_invalid_score",
    });
    expect(decoded._tag).toBe("Left");

    const saved = await runAs(reviewer, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_05",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 5 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 3 },
      ],
      comment: "Human-confirmed review",
      requestId: "request_score_01",
    }));
    expect(saved.review.score).toBe(4);
    expect(saved.submissionStatus).not.toBe("accepted");
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, "submission_05"));
    expect(submission?.status).toBe("in_review");
  });

  it("limits AI input, labels the suggestion, and never transitions submission status", async () => {
    const result = await runAs(reviewer, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_06",
      requestId: "request_ai_01",
    }));
    expect(result.suggestion.label).toContain("requires human confirmation");
    expect(result.suggestion.inputFields).toEqual(["title", "abstract", "rubric"]);
    expect(lastAiPrompt).toContain('"title"');
    expect(lastAiPrompt).toContain('"abstract"');
    expect(lastAiPrompt).toContain('"rubric"');
    expect(lastAiPrompt).not.toContain("email");
    expect(result.submissionStatus).not.toBe("accepted");
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, "submission_06"));
    expect(submission?.status).toBe("submitted");
  });

  it("allows scoped API-key AI suggestions but rejects human scoring and acceptance", async () => {
    const aiResult = await runAs(reviewApiKey, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_08",
      requestId: "request_api_ai",
    }));
    const [aiRow] = await db.select().from(reviews).where(eq(reviews.id, aiResult.suggestion.id));
    expect(aiRow).toMatchObject({ ai: true, reviewerUserId: null });

    const scoreResult = await runEitherAs(reviewApiKey, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_08",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 4 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 4 },
      ],
      requestId: "request_api_score",
    }));
    expect(scoreResult._tag).toBe("Left");
    if (scoreResult._tag === "Left") expect(scoreResult.left._tag).toBe("Forbidden");

    const acceptanceResult = await runEitherAs(reviewApiKey, acceptSubmission({
      eventId: fixtureEventId,
      submissionId: "submission_24",
      expectedVersion: 2,
      idempotencyKey: "api-acceptance-denied",
      requestId: "request_api_accept",
    }));
    expect(acceptanceResult._tag).toBe("Left");
    if (acceptanceResult._tag === "Left") expect(acceptanceResult.left._tag).toBe("Forbidden");
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, "submission_24"));
    expect(submission?.status).not.toBe("accepted");
  });

  it("replays concurrent matching acceptance keys without duplicate durable evidence", async () => {
    const input = {
      eventId: fixtureEventId,
      submissionId: "submission_25",
      expectedVersion: 2,
      idempotencyKey: "concurrent-same-key-25",
      requestId: "request_concurrent_same_25",
    } as const;
    const results = await Promise.all([
      runAs(owner, acceptSubmission(input)),
      runAs(owner, acceptSubmission(input)),
    ]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.acceptanceEventId)).size).toBe(1);

    const durableAcceptance = await db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, input.submissionId));
    const provisioning = await db.select().from(speakerProvisioning).where(eq(speakerProvisioning.submissionId, input.submissionId));
    const changes = await db.select().from(domainChanges).where(eq(domainChanges.requestId, input.requestId));
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.resourceType, "submission"), eq(auditLog.resourceId, input.submissionId)));
    const allIdempotency = await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.operationId, "review.acceptSubmission"));
    const matchingIdempotency = allIdempotency.filter((record) => {
      const response = record.responseBody;
      return response !== null
        && typeof response === "object"
        && "submissionId" in response
        && response.submissionId === input.submissionId;
    });
    expect(durableAcceptance).toHaveLength(1);
    expect(provisioning).toHaveLength(1);
    expect(changes).toHaveLength(2);
    expect(audits).toHaveLength(1);
    expect(matchingIdempotency).toHaveLength(1);
  });

  it("resolves concurrent different acceptance keys with one winner and one stale CAS conflict", async () => {
    const first = {
      eventId: fixtureEventId,
      submissionId: "submission_26",
      expectedVersion: 2,
      idempotencyKey: "concurrent-key-a-26",
      requestId: "request_concurrent_a_26",
    } as const;
    const second = {
      ...first,
      idempotencyKey: "concurrent-key-b-26",
      requestId: "request_concurrent_b_26",
    } as const;
    const results = await Promise.all([
      runEitherAs(owner, acceptSubmission(first)),
      runEitherAs(owner, acceptSubmission(second)),
    ]);
    expect(results.map((result) => result._tag).sort()).toEqual(["Left", "Right"]);
    const failure = results.find((result) => result._tag === "Left");
    if (failure?._tag === "Left") expect(failure.left._tag).toBe("Conflict");

    const durableAcceptance = await db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, first.submissionId));
    const provisioning = await db.select().from(speakerProvisioning).where(eq(speakerProvisioning.submissionId, first.submissionId));
    const allChanges = await db.select().from(domainChanges);
    const changes = allChanges.filter((change) => change.requestId === first.requestId || change.requestId === second.requestId);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.resourceType, "submission"), eq(auditLog.resourceId, first.submissionId)));
    const allIdempotency = await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.operationId, "review.acceptSubmission"));
    const matchingIdempotency = allIdempotency.filter((record) => {
      const response = record.responseBody;
      return response !== null
        && typeof response === "object"
        && "submissionId" in response
        && response.submissionId === first.submissionId;
    });
    expect(durableAcceptance).toHaveLength(1);
    expect(provisioning).toHaveLength(1);
    expect(changes).toHaveLength(2);
    expect(audits).toHaveLength(1);
    expect(matchingIdempotency).toHaveLength(1);
  });

  it("rethrows an unrelated acceptance batch failure when the submission CAS remains current", async () => {
    const submissionId = "submission_27";
    const requestId = "request_unrelated_batch_27";
    await db.insert(domainChanges).values({
      id: "change_collision_27",
      eventId: fixtureEventId,
      aggregateType: "submission",
      aggregateId: submissionId,
      aggregateVersion: 3,
      eventType: "review.submission.accepted",
      audiences: [{ kind: "admins" }],
      payload: { fixture: "preexisting evidence collision" },
      actorUserId: fixtureOwnerId,
      actorApiKeyId: null,
      requestId: "request_fixture_collision_27",
      idempotencyRecordId: null,
      occurredAt: new Date(fixtureClock - 1_000),
    });
    const idempotencyBefore = await db.select().from(idempotencyRecords);

    const result = await runEitherAs(owner, acceptSubmission({
      eventId: fixtureEventId,
      submissionId,
      expectedVersion: 2,
      idempotencyKey: "unrelated-batch-failure-27",
      requestId,
    }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("External");

    const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    const durableAcceptance = await db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, submissionId));
    const provisioning = await db.select().from(speakerProvisioning).where(eq(speakerProvisioning.submissionId, submissionId));
    const changes = await db.select().from(domainChanges).where(eq(domainChanges.requestId, requestId));
    const audits = await db.select().from(auditLog).where(eq(auditLog.requestId, requestId));
    const idempotencyAfter = await db.select().from(idempotencyRecords);
    expect(submission).toMatchObject({ status: "rejected", version: 2 });
    expect(durableAcceptance).toEqual([]);
    expect(provisioning).toEqual([]);
    expect(changes).toEqual([]);
    expect(audits).toEqual([]);
    expect(idempotencyAfter).toHaveLength(idempotencyBefore.length);
  });

  it("rejects stale acceptance and atomically creates one durable acceptance plus primary-speaker provisioning", async () => {
    const stale = await runEitherAs(owner, acceptSubmission({
      eventId: fixtureEventId,
      submissionId: contentionFixture.submissionId,
      expectedVersion: contentionFixture.expectedVersion,
      idempotencyKey: "accept-contention-key",
      requestId: "request_accept_stale",
    }));
    expect(stale._tag).toBe("Left");
    if (stale._tag === "Left") expect(stale.left._tag).toBe("Conflict");

    const input = {
      eventId: fixtureEventId,
      submissionId: "submission_04",
      expectedVersion: 2,
      idempotencyKey: "accept-submission-04",
      requestId: "request_accept_04",
    } as const;
    const accepted = await runAs(owner, acceptSubmission(input));
    const replayed = await runAs(owner, acceptSubmission(input));
    expect(accepted).toMatchObject({ status: "accepted", provisioningStatus: "pending", submissionVersion: 3, idempotent: false });
    expect(replayed).toEqual({ ...accepted, idempotent: true });

    const [submission] = await db.select().from(submissions).where(eq(submissions.id, input.submissionId));
    expect(submission).toMatchObject({ status: "accepted", version: 3 });
    const durableAcceptance = await db.select().from(acceptanceEvents).where(and(eq(acceptanceEvents.eventId, fixtureEventId), eq(acceptanceEvents.submissionId, input.submissionId)));
    const provisioning = await db.select().from(speakerProvisioning).where(and(eq(speakerProvisioning.eventId, fixtureEventId), eq(speakerProvisioning.submissionId, input.submissionId)));
    const changes = await db.select().from(domainChanges).where(and(eq(domainChanges.eventId, fixtureEventId), eq(domainChanges.requestId, input.requestId)));
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventId, fixtureEventId), eq(auditLog.requestId, input.requestId)));
    const allIdempotency = await db.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.eventId, fixtureEventId), eq(idempotencyRecords.operationId, "review.acceptSubmission")));
    const idempotency = allIdempotency.filter((record) => {
      const response = record.responseBody;
      return response !== null
        && typeof response === "object"
        && "submissionId" in response
        && response.submissionId === input.submissionId;
    });
    expect(durableAcceptance).toHaveLength(1);
    expect(provisioning).toHaveLength(1);
    expect(provisioning[0]).toMatchObject({ acceptanceEventId: durableAcceptance[0]!.id, primarySpeakerId: fixturePrimarySpeakerId, status: "pending" });
    expect(changes.map((change) => change.eventType).sort()).toEqual(["review.submission.accepted", "speaker.provisioning.requested"]);
    expect(audits).toHaveLength(1);
    expect(idempotency).toHaveLength(1);
    expect(idempotency[0]?.status).toBe("completed");
  });

  it("records a versioned rejection, publishes speaker-visible evidence, and replays idempotently", async () => {
    const input = {
      eventId: fixtureEventId,
      submissionId: "submission_59",
      expectedVersion: 2,
      idempotencyKey: "reject-submission-59",
      requestId: "request_reject_59",
    } as const;
    const rejected = await runAs(owner, rejectSubmission(input));
    const replayed = await runAs(owner, rejectSubmission(input));
    expect(rejected).toEqual({
      submissionId: input.submissionId,
      submissionVersion: 3,
      status: "rejected",
      idempotent: false,
    });
    expect(replayed).toEqual({ ...rejected, idempotent: true });
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, input.submissionId));
    expect(submission).toMatchObject({ status: "rejected", version: 3, acceptedAt: null });
    const [change] = await db.select().from(domainChanges).where(eq(domainChanges.requestId, input.requestId));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.requestId, input.requestId));
    expect(change).toMatchObject({ eventType: "review.submission.rejected", aggregateVersion: 3 });
    expect(change?.audiences).toEqual([
      { kind: "admins" },
      { kind: "speaker", speakerIds: [fixturePrimarySpeakerId] },
    ]);
    expect(audit).toMatchObject({ action: "review.rejectSubmission" });
  });

  it("collapses concurrent rejection retries into one decision", async () => {
    const input = {
      eventId: fixtureEventId,
      submissionId: "submission_58",
      expectedVersion: 2,
      idempotencyKey: "reject-concurrent-submission-58",
      requestId: "request_reject_concurrent_58",
    } as const;
    const results = await Promise.all([
      runAs(owner, rejectSubmission(input)),
      runAs(owner, rejectSubmission(input)),
    ]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.submissionVersion))).toEqual(new Set([3]));
    expect(await db.select().from(domainChanges).where(eq(domainChanges.requestId, input.requestId))).toHaveLength(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.requestId, input.requestId))).toHaveLength(1);
  });
});
