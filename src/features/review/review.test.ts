import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import type { Principal } from "contracts/principal";
import {
  acceptanceEvents,
  airtableOutbox,
  apiKeys,
  auditLog,
  domainChanges,
  eventMembers,
  events,
  forms,
  formVersionFields,
  formVersions,
  idempotencyRecords,
  mailDeliveries,
  mailDeliverySnapshots,
  integrations,
  reviewAssignments,
  reviewComments,
  reviewConflicts,
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
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Either, Layer, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { listAudience } from "@/features/comms/service";
import { getOwnSubmissions } from "@/features/submit/service";
import { AiService, Authorizer, authorizePrincipal, CurrentUser, Db, MailQueue } from "@/server/services";
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
import { SaveScoreInput, type SubmissionStatus } from "./schema";
import {
  acceptSubmission,
  advanceReviewRound,
  appendReviewComment,
  assignReviewer,
  autoDistributeReviewers,
  bulkAssignReviewers,
  createReviewRound,
  declareReviewConflict,
  demoAiSuggestionJson,
  exportReviewResults,
  getWorkbench,
  listReviewConflicts,
  recuseAssignment,
  rejectSubmission,
  releaseDecisions,
  removeAssignment,
  revokeAcceptance,
  requestAiSuggestion,
  saveScore,
  sendReviewReminders,
  stageDecision,
  updateReviewRound,
  withdrawReviewConflict,
} from "./service";

it("builds a substantive deterministic AI suggestion for the disposable demo event", () => {
  const parsed = JSON.parse(demoAiSuggestionJson("Taming 40-Minute CI", ["originality", "relevance"])) as {
    scores: Record<string, number>;
    comment: string;
  };
  expect(parsed.scores).toEqual({ originality: 4, relevance: 4 });
  expect(parsed.comment).toContain("CI build performance");
  expect(parsed.comment).toContain("monorepos");
  expect(parsed.comment).toContain("Human confirmation");
});

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

const reviewReadApiKey: Principal = {
  kind: "api-key",
  userId: "api-key:review-reporting",
  apiKeyId: "review_reporting",
  eventId: fixtureEventId,
  name: "Review reporting",
  scopes: ["reviews:read"],
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
let mailQueueWakeCount = 0;
const mailQueueLayer = Layer.succeed(MailQueue, {
  fromEmail: "program@example.com",
  appOrigin: "https://session-party.example",
  wake: () => Effect.sync(() => { mailQueueWakeCount += 1; }),
});
const authorizerLayer = Layer.succeed(Authorizer, { authorize: authorizePrincipal });

const runAs = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.mergeAll(dbLayer, aiLayer, mailQueueLayer, authorizerLayer, Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<A, E, never>,
  );

const runEitherAs = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.either,
      Effect.provide(Layer.mergeAll(dbLayer, aiLayer, mailQueueLayer, authorizerLayer, Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<Either.Either<A, E>, never, never>,
  );
let transitionSubmissionSequence = 0;

const seedTransitionSubmission = async (status: SubmissionStatus, version = 1) => {
  transitionSubmissionSequence += 1;
  const submissionId = `submission_transition_${transitionSubmissionSequence}`;
  const createdAt = new Date(fixtureClock - transitionSubmissionSequence * 1_000);
  await db.insert(submissions).values({
    id: submissionId,
    eventId: fixtureEventId,
    formId: "form_cfp",
    formVersionId: "form_version_01",
    title: `Transition fixture ${transitionSubmissionSequence}`,
    status,
    submittedAt: createdAt,
    acceptedAt: status === "accepted" ? createdAt : null,
    version,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(submissionSpeakers).values({
    id: `submission_speaker_transition_${transitionSubmissionSequence}`,
    eventId: fixtureEventId,
    submissionId,
    speakerId: fixturePrimarySpeakerId,
    isPrimary: true,
    createdAt,
  });
  return { submissionId, version };
};



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
      id: "field_format", eventId: fixtureEventId, formVersionId: "form_version_01", order: 2,
      type: "select", label: "Session format", required: true,
      options: ["Conference talk (30 min)", "Workshop (120 min)"], createdAt,
    },
    {
      id: "field_speaker_name", eventId: fixtureEventId, formVersionId: "form_version_01", order: 3,
      type: "text", label: "Presenter name", semanticKey: "speakerName", required: true, createdAt,
    },
    {
      id: "field_speaker_email", eventId: fixtureEventId, formVersionId: "form_version_01", order: 4,
      type: "email", label: "Presenter email", semanticKey: "speakerEmail", required: true, createdAt,
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
    id: "answer_format_05",
    eventId: fixtureEventId,
    submissionId: "submission_05",
    formVersionId: "form_version_01",
    formVersionFieldId: "field_format",
    value: "Workshop (120 min)",
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(submissionAnswers).values([
    {
      id: "answer_speaker_name_05",
      eventId: fixtureEventId,
      submissionId: "submission_05",
      formVersionId: "form_version_01",
      formVersionFieldId: "field_speaker_name",
      value: "Jordan Lee",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "answer_speaker_email_05",
      eventId: fixtureEventId,
      submissionId: "submission_05",
      formVersionId: "form_version_01",
      formVersionFieldId: "field_speaker_email",
      value: "jordan@example.com",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "answer_format_22",
      eventId: fixtureEventId,
      submissionId: "submission_22",
      formVersionId: "form_version_01",
      formVersionFieldId: "field_format",
      value: "Conference talk (30 min)",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "answer_speaker_name_22",
      eventId: fixtureEventId,
      submissionId: "submission_22",
      formVersionId: "form_version_01",
      formVersionFieldId: "field_speaker_name",
      value: "Jordan Lee",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "answer_speaker_email_22",
      eventId: fixtureEventId,
      submissionId: "submission_22",
      formVersionId: "form_version_01",
      formVersionFieldId: "field_speaker_email",
      value: "jordan@example.com",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
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
    roleLabel: index === 4 ? "Session moderator" : null,
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
      startsAt: new Date(completedRoundFixture.startsAt!),
      endsAt: new Date(completedRoundFixture.endsAt!),
      blind: completedRoundFixture.blind,
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
      startsAt: new Date(activeRoundFixture.startsAt!),
      endsAt: new Date(activeRoundFixture.endsAt!),
      blind: activeRoundFixture.blind,
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
      startsAt: new Date(pendingRoundFixture.startsAt!),
      endsAt: new Date(pendingRoundFixture.endsAt!),
      blind: pendingRoundFixture.blind,
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
      id: "assignment_reviewer_complete",
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      submissionId: "submission_22",
      reviewerUserId: fixtureReviewerId,
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
      "review.advanceRound",
      "review.appendComment",
      "review.assignReviewer",
      "review.autoDistributeReviewers",
      "review.bulkAssignReviewers",
      "review.createRound",
      "review.declareConflict",
      "review.exportResults",
      "review.getWorkbench",
      "review.listConflicts",
      "review.recuseAssignment",
      "review.releaseDecisions",
      "review.removeAssignment",
      "review.requestAiSuggestion",
      "review.revokeAcceptance",
      "review.saveScore",
      "review.sendReminders",
      "review.stageDecision",
      "review.updateRound",
      "review.withdrawConflict",
    ]);
    for (const operation of operations) {
      expect(operation.authorize.kind).toBe("event");
      expect(operation.rest).toBeDefined();
      if (operation.authorize.kind === "event" && operation.authorize.apiKey.kind === "deny") {
        expect("mcp" in operation).toBe(false);
      } else {
        expect("mcp" in operation).toBe(true);
      }
    }
    const releaseOperation = operations.find((operation) => operation.id === "review.releaseDecisions")!;
    expect(releaseOperation.emits).toEqual([
      "review.decisions.released",
      "review.submission.accepted",
      "review.submission.rejected",
      "speaker.provisioning.requested",
    ]);
    expect(ids).not.toContain("review.acceptSubmission");
    expect(ids).not.toContain("review.rejectSubmission");
    const acceptanceAuthorization = releaseOperation.authorize;
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
    const recusalAuthorization = operations.find((operation) => operation.id === "review.recuseAssignment")!.authorize;
    expect(recusalAuthorization.kind).toBe("event");
    if (recusalAuthorization.kind === "event") {
      expect(recusalAuthorization.browser).toEqual({ kind: "event-member", roles: ["reviewer"] });
      expect(recusalAuthorization.apiKey.kind).toBe("deny");
    }
    const commentAuthorization = operations.find((operation) => operation.id === "review.appendComment")!.authorize;
    expect(commentAuthorization.kind).toBe("event");
    if (commentAuthorization.kind === "event") {
      expect(commentAuthorization.browser).toEqual({ kind: "event-member", roles: ["owner", "admin", "reviewer"] });
      expect(commentAuthorization.apiKey.kind).toBe("deny");
    }
    const workbenchOperation = operations.find((operation) => operation.id === "review.getWorkbench")!;
    expect(workbenchOperation.invoke).toBe(getWorkbench);
    expect(workbenchOperation.rest).toMatchObject({ method: "get", path: "/events/:eventId/review" });
    expect("mcp" in workbenchOperation && workbenchOperation.mcp).toMatchObject({ name: "review_get_workbench" });
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
      criteria: [{ key: "clarity", label: "Clarity", type: "numeric" as const, weight: 1, required: true, max: 5 as const }] as const,
    };
    const activeInput = {
      eventId,
      name: "  Program fit  ",
      initialStatus: "active" as const,
      startsAt: null,
      endsAt: null,
      blind: false,
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

    const typedRubric = {
      criteria: [
        { key: "clarity", label: "Clarity", type: "numeric" as const, weight: 2, required: true, max: 5 as const },
        {
          key: "recommendation",
          label: "Recommendation",
          type: "dropdown" as const,
          weight: 3,
          required: true,
          max: 5 as const,
          options: [
            { value: "decline", label: "Decline", score: 1 as const },
            { value: "accept", label: "Accept", score: 5 as const },
          ],
        },
        { key: "notes", label: "Committee notes", type: "text" as const, weight: 9, required: false, max: 5 as const },
      ] as const,
    };
    const updateInput = {
      eventId,
      roundId: created.round.id,
      name: "Program fit and readiness",
      startsAt: fixtureClock,
      endsAt: fixtureClock + 86_400_000,
      blind: true,
      rubric: typedRubric,
      expectedVersion: 1,
      idempotencyKey: "round-update-typed-01",
      requestId: "request_round_update_typed",
    } as const;
    const updated = await runAs(owner, updateReviewRound(updateInput));
    const updatedReplay = await runAs(owner, updateReviewRound(updateInput));
    expect(updated).toMatchObject({
      idempotent: false,
      round: {
        name: "Program fit and readiness",
        startsAt: fixtureClock,
        endsAt: fixtureClock + 86_400_000,
        blind: true,
        version: 2,
      },
    });
    expect(updated.round.rubric.criteria[2]).toMatchObject({ type: "text", weight: 0, required: false });
    expect(updatedReplay).toEqual({ ...updated, idempotent: true });

    const invalidSchedule = await runEitherAs(owner, updateReviewRound({
      ...updateInput,
      endsAt: fixtureClock,
      expectedVersion: 2,
      idempotencyKey: "round-update-bad-dates-02",
      requestId: "request_round_update_bad_dates",
    }));
    expect(invalidSchedule._tag).toBe("Left");
    if (invalidSchedule._tag === "Left") expect(invalidSchedule.left._tag).toBe("Validation");

    const pending = await runAs(owner, createReviewRound({
      eventId,
      name: "Final selection",
      initialStatus: "pending",
      startsAt: null,
      endsAt: null,
      blind: false,
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
      startsAt: null,
      endsAt: null,
      blind: false,
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
      startsAt: null,
      endsAt: null,
      blind: false,
      rubric: { criteria: [
        { key: "clarity", label: "Clarity", type: "numeric", weight: 1, required: true, max: 5 },
        { key: "clarity", label: "Clarity again", type: "numeric", weight: 1, required: true, max: 5 },
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


  it("restricts reviewer queues and proposal access to exact active assignments", async () => {
    const organizerView = await runAs(owner, getWorkbench({ eventId: fixtureEventId, page: 1, pageSize: 60 }));
    expect(organizerView.queue).toHaveLength(60);
    expect(organizerView.order).toBe("coverage");
    expect(organizerView.queue[0]).toMatchObject({ id: "submission_60", completedReviewCount: 0 });

    const decisionView = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      order: "decision",
      page: 1,
      pageSize: 60,
    }));
    expect(decisionView.order).toBe("decision");
    expect(decisionView.queue[0]).toMatchObject({ id: "submission_05", averageScore: 2 });

    const reviewerView = await runAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      selectedSubmissionId: "submission_05",
      page: 1,
      pageSize: 60,
    }));
    expect(reviewerView.queue).toHaveLength(12);
    expect(reviewerView.selected?.assignments.map((assignment) => assignment.reviewerUserId).sort()).toEqual([
      "user_reviewer_dev",
      fixtureReviewerId,
    ].sort());
    // Anchoring protection: peer reviews and queue averages stay hidden from a
    // reviewer until they save their own review of the proposal.
    expect(reviewerView.selected?.reviews).toEqual([]);
    expect(reviewerView.queue.find((submission) => submission.id === "submission_05")?.averageScore).toBeNull();

    const unlocked = await runAs(reviewer, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_05",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 3 },
        { criterionKey: "specificity", score: 3 },
        { criterionKey: "delivery", score: 3 },
      ],
      requestId: "request_score_unlock_peer_visibility",
    }));
    const unlockedView = await runAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      selectedSubmissionId: "submission_05",
      page: 1,
      pageSize: 60,
    }));
    expect(unlockedView.selected?.reviews.map((review) => review.reviewerUserId).sort()).toEqual([
      "user_reviewer_dev",
      fixtureReviewerId,
    ].sort());
    expect(
      unlockedView.queue.find((submission) => submission.id === "submission_05")?.averageScore,
    ).not.toBeNull();
    // Restore the fixture state other tests in this file depend on.
    await db.delete(reviews).where(eq(reviews.id, unlocked.review.id));
    expect(reviewerView.selected?.speakers).toEqual([
      expect.objectContaining({ displayName: "Jordan Lee", role: "Session moderator" }),
    ]);
    expect(reviewerView.selected?.answers).toEqual([
      { label: "Session format", value: "Workshop (120 min)" },
      { label: "Presenter name", value: "Jordan Lee" },
      { label: "Presenter email", value: "jordan@example.com" },
    ]);

    const assignedToMe = await runAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      assignedToMe: true,
      page: 1,
      pageSize: 60,
    }));
    expect(assignedToMe.queue).toHaveLength(12);
    expect(assignedToMe.queue.every((submission) => submission.assignedToMe)).toBe(true);

    const unassignedSelection = await runEitherAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      selectedSubmissionId: "submission_60",
      page: 1,
      pageSize: 60,
    }));
    expect(unassignedSelection._tag).toBe("Left");
    if (unassignedSelection._tag === "Left") expect(unassignedSelection.left._tag).toBe("NotFound");

    const forbidden = await runEitherAs(speakerOnly, getWorkbench({ eventId: fixtureEventId, page: 1, pageSize: 60 }));
    expect(forbidden._tag).toBe("Left");
    if (forbidden._tag === "Left") expect(forbidden.left._tag).toBe("Forbidden");
  });

  it("marks assignment completion only when every assigned reviewer has a matching human review", async () => {
    const { submissionId } = await seedTransitionSubmission("submitted");
    const createdAt = new Date(fixtureClock);
    await db.insert(reviewAssignments).values([
      {
        id: `assignment_identity_ada_${submissionId}`,
        eventId: fixtureEventId,
        roundId: activeRoundFixture.id,
        submissionId,
        reviewerUserId: fixtureReviewerId,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: `assignment_identity_dev_${submissionId}`,
        eventId: fixtureEventId,
        roundId: activeRoundFixture.id,
        submissionId,
        reviewerUserId: "user_reviewer_dev",
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await db.insert(reviews).values([
      {
        id: `review_identity_ada_${submissionId}`,
        eventId: fixtureEventId,
        roundId: activeRoundFixture.id,
        submissionId,
        reviewerUserId: fixtureReviewerId,
        ai: false,
        score: 4,
        scores: { relevance: 4, specificity: 4, delivery: 4 },
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: `review_identity_owner_${submissionId}`,
        eventId: fixtureEventId,
        roundId: activeRoundFixture.id,
        submissionId,
        reviewerUserId: fixtureOwnerId,
        ai: false,
        score: 5,
        scores: { relevance: 5, specificity: 5, delivery: 5 },
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    const workbench = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      selectedSubmissionId: submissionId,
      page: 1,
      pageSize: 100,
    }));
    expect(workbench.selected).toMatchObject({
      id: submissionId,
      assignmentCount: 2,
      completedReviewCount: 2,
      reviewState: "in_progress",
    });
    await db.delete(reviews).where(eq(reviews.submissionId, submissionId));
    await db.delete(reviewAssignments).where(eq(reviewAssignments.submissionId, submissionId));
    await db.delete(submissionSpeakers).where(eq(submissionSpeakers.submissionId, submissionId));
    await db.delete(submissions).where(eq(submissions.id, submissionId));
  });

  it("hides presenter identities from assigned reviewers in blind rounds", async () => {
    const reviewerView = await runAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      selectedSubmissionId: "submission_22",
      page: 1,
      pageSize: 60,
    }));
    expect(reviewerView.selected?.round).toMatchObject({ id: completedRoundFixture.id, blind: true });
    expect(reviewerView.selected?.speakers).toEqual([]);
    expect(reviewerView.selected?.answers).toEqual([
      { label: "Session format", value: "Conference talk (30 min)" },
    ]);
    expect(JSON.stringify(reviewerView.selected)).not.toContain("Jordan Lee");
    expect(JSON.stringify(reviewerView.selected)).not.toContain("jordan@example.com");

    const organizerView = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      selectedSubmissionId: "submission_22",
      page: 1,
      pageSize: 60,
    }));
    expect(organizerView.selected?.speakers[0]).toMatchObject({
      displayName: "Jordan Lee",
      role: "Primary presenter",
    });
    expect(organizerView.selected?.answers).toEqual([
      { label: "Session format", value: "Conference talk (30 min)" },
      { label: "Presenter name", value: "Jordan Lee" },
      { label: "Presenter email", value: "jordan@example.com" },
    ]);

    const organizerAutomationView = await runAs(reviewReadApiKey, getWorkbench({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      selectedSubmissionId: "submission_22",
      page: 1,
      pageSize: 60,
    }));
    expect(organizerAutomationView.viewerRole).toBe("admin");
    expect(organizerAutomationView.selected?.speakers[0]?.displayName).toBe("Jordan Lee");
    expect(organizerAutomationView.selected?.answers).toContainEqual({
      label: "Presenter email",
      value: "jordan@example.com",
    });
  });

  it("appends multiple idempotent committee messages independently from scoring and broadcasts full-committee evidence", async () => {
    await db.insert(reviewAssignments).values({
      id: "assignment_comment_32",
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_32",
      reviewerUserId: fixtureReviewerId,
      createdAt: new Date(fixtureClock),
      updatedAt: new Date(fixtureClock),
    });
    const reviewRowsBefore = await db.select().from(reviews).where(and(
      eq(reviews.eventId, fixtureEventId),
      eq(reviews.submissionId, "submission_32"),
    ));
    const firstInput = {
      eventId: fixtureEventId,
      submissionId: "submission_32",
      body: "Could this become a facilitated workshop?",
      idempotencyKey: "comment-submission-32-first",
      requestId: "request_comment_32_first",
    } as const;
    const firstResults = await Promise.all([
      runAs(reviewer, appendReviewComment(firstInput)),
      runAs(reviewer, appendReviewComment(firstInput)),
    ]);
    const first = firstResults.find((result) => !result.idempotent)!;
    const replay = firstResults.find((result) => result.idempotent)!;
    const second = await runAs(reviewer, appendReviewComment({
      eventId: fixtureEventId,
      submissionId: "submission_32",
      body: "I would keep it as a talk and ask for one audience exercise.",
      idempotencyKey: "comment-submission-32-second",
      requestId: "request_comment_32_second",
    }));

    expect(first.idempotent).toBe(false);
    expect(replay).toEqual({ ...first, idempotent: true });
    expect(new Set(firstResults.map((result) => result.comment.id))).toEqual(new Set([first.comment.id]));
    expect(second.comment.id).not.toBe(first.comment.id);
    expect(first.comment).toMatchObject({
      authorUserId: fixtureReviewerId,
      authorName: "Ada Rivera",
      body: firstInput.body,
    });

    const detail = await runAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      selectedSubmissionId: "submission_32",
      page: 1,
      pageSize: 60,
    }));
    expect(detail.selected?.comments).toHaveLength(2);
    expect(detail.selected?.comments.map((comment) => comment.body).sort()).toEqual([
      firstInput.body,
      "I would keep it as a talk and ask for one audience exercise.",
    ].sort());
    expect(await db.select().from(reviews).where(and(
      eq(reviews.eventId, fixtureEventId),
      eq(reviews.submissionId, "submission_32"),
    ))).toEqual(reviewRowsBefore);

    const commentRows = await db.select().from(reviewComments).where(and(
      eq(reviewComments.eventId, fixtureEventId),
      eq(reviewComments.submissionId, "submission_32"),
    ));
    expect(commentRows).toHaveLength(2);
    const changes = (await db.select().from(domainChanges)).filter(
      (change) => change.requestId === firstInput.requestId || change.requestId === "request_comment_32_second",
    );
    const audits = (await db.select().from(auditLog)).filter(
      (audit) => audit.requestId === firstInput.requestId || audit.requestId === "request_comment_32_second",
    );
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ eventType: "review.comment.created", aggregateType: "reviewComment" });
    expect(changes[0]?.audiences).toEqual([
      { kind: "admins" },
      { kind: "reviewers", reviewerUserIds: [fixtureReviewerId] },
    ]);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ action: "review.appendComment", actorUserId: fixtureReviewerId });

    const reusedKey = await runEitherAs(reviewer, appendReviewComment({
      ...firstInput,
      body: "A different message must not reuse the same key.",
      requestId: "request_comment_32_key_reuse",
    }));
    expect(reusedKey._tag).toBe("Left");
    if (reusedKey._tag === "Left") expect(reusedKey.left._tag).toBe("Conflict");

    const blank = await runEitherAs(reviewer, appendReviewComment({
      eventId: fixtureEventId,
      submissionId: "submission_32",
      body: "   ",
      idempotencyKey: "comment-blank-denied-32",
      requestId: "request_comment_blank_denied_32",
    }));
    expect(blank._tag).toBe("Left");
    if (blank._tag === "Left") expect(blank.left._tag).toBe("Validation");

    const ownerComment = await runAs(owner, appendReviewComment({
      eventId: fixtureEventId,
      submissionId: "submission_33",
      body: "Organizer note for the committee.",
      idempotencyKey: "comment-owner-allowed-33",
      requestId: "request_comment_owner_allowed_33",
    }));
    expect(ownerComment.comment).toMatchObject({ authorUserId: fixtureOwnerId, authorName: "Morgan Chen" });

    const apiKeyAttempt = await runEitherAs(reviewApiKey, appendReviewComment({
      eventId: fixtureEventId,
      submissionId: "submission_32",
      body: "Pretend this came from a reviewer.",
      idempotencyKey: "comment-api-key-denied-32",
      requestId: "request_comment_api_key_denied_32",
    }));
    expect(apiKeyAttempt._tag).toBe("Left");
    if (apiKeyAttempt._tag === "Left") expect(apiKeyAttempt.left._tag).toBe("Forbidden");

    const speakerAttempt = await runEitherAs(speakerOnly, appendReviewComment({
      eventId: fixtureEventId,
      submissionId: "submission_32",
      body: "Pretend this came from the committee.",
      idempotencyKey: "comment-speaker-denied-32",
      requestId: "request_comment_speaker_denied_32",
    }));
    expect(speakerAttempt._tag).toBe("Left");
    if (speakerAttempt._tag === "Left") expect(speakerAttempt.left._tag).toBe("Forbidden");
    expect(await db.select().from(reviewComments).where(and(
      eq(reviewComments.eventId, fixtureEventId),
      eq(reviewComments.submissionId, "submission_32"),
    ))).toHaveLength(2);
  });

  it("keeps committee comments inside their event boundary", async () => {
    const eventId = "event_review_isolated";
    const createdAt = new Date(fixtureClock);
    await db.insert(events).values({
      id: eventId,
      slug: "review-isolated",
      name: "Isolated review",
      timezone: "UTC",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(eventMembers).values({
      id: "member_review_isolated",
      eventId,
      userId: fixtureReviewerId,
      role: "reviewer",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(forms).values({
      id: "form_review_isolated",
      eventId,
      kind: "cfp",
      name: "Isolated CFP",
      status: "closed",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(formVersions).values({
      id: "form_version_review_isolated",
      eventId,
      formId: "form_review_isolated",
      versionNumber: 1,
      name: "Isolated CFP",
      publishedAt: createdAt,
      createdAt,
    });
    await db.insert(formVersionFields).values({
      id: "field_review_isolated",
      eventId,
      formVersionId: "form_version_review_isolated",
      order: 1,
      type: "textarea",
      label: "Abstract",
      semanticKey: "submissionAbstract",
      required: true,
      createdAt,
    });
    await db.insert(submissions).values({
      id: "submission_review_isolated",
      eventId,
      formId: "form_review_isolated",
      formVersionId: "form_version_review_isolated",
      title: "Isolated proposal",
      status: "submitted",
      submittedAt: createdAt,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(submissionAnswers).values({
      id: "answer_review_isolated",
      eventId,
      submissionId: "submission_review_isolated",
      formVersionId: "form_version_review_isolated",
      formVersionFieldId: "field_review_isolated",
      value: "Event-isolated abstract",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(reviewRounds).values({
      id: "round_review_isolated",
      eventId,
      name: "Isolated round",
      order: 1,
      status: "active",
      rubric: { criteria: [{ key: "clarity", label: "Clarity", max: 5 }] },
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(reviewAssignments).values({
      id: "assignment_review_isolated",
      eventId,
      roundId: "round_review_isolated",
      submissionId: "submission_review_isolated",
      reviewerUserId: fixtureReviewerId,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(reviews).values({
      id: "review_isolated_comment",
      eventId,
      roundId: "round_review_isolated",
      submissionId: "submission_review_isolated",
      reviewerUserId: fixtureReviewerId,
      ai: false,
      score: 5,
      scores: { clarity: 5 },
      comment: "Only the isolated event committee may read this.",
      createdAt,
      updatedAt: createdAt,
    });

    await runAs(reviewer, appendReviewComment({
      eventId,
      submissionId: "submission_review_isolated",
      body: "Only this event can load this committee thread message.",
      idempotencyKey: "comment-isolated-event",
      requestId: "request_comment_isolated_event",
    }));

    const isolated = await runAs(reviewer, getWorkbench({ eventId, page: 1, pageSize: 60 }));
    const primary = await runAs(reviewer, getWorkbench({ eventId: fixtureEventId, page: 1, pageSize: 60 }));
    expect(isolated.selected?.reviews[0]?.comment).toBe("Only the isolated event committee may read this.");
    expect(isolated.selected?.comments[0]?.body).toBe("Only this event can load this committee thread message.");
    expect(JSON.stringify(primary)).not.toContain("Only the isolated event committee may read this.");
    expect(JSON.stringify(primary)).not.toContain("Only this event can load this committee thread message.");

    const crossEventSelection = await runEitherAs(reviewer, getWorkbench({
      eventId: fixtureEventId,
      selectedSubmissionId: "submission_review_isolated",
      page: 1,
      pageSize: 60,
    }));
    expect(crossEventSelection._tag).toBe("Left");
    if (crossEventSelection._tag === "Left") expect(crossEventSelection.left._tag).toBe("NotFound");
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
      idempotencyKey: "ai-task-form-01",
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

  it("derives organizer progress from active assignments and preserves recusal history through reassignment", async () => {
    const { submissionId } = await seedTransitionSubmission("submitted");
    const baseline = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      page: 1,
      pageSize: 100,
    }));
    expect(baseline.progress).not.toBeNull();
    const baselineAssigned = baseline.progress!.assignedReviewCount;
    const baselineOutstanding = baseline.progress!.outstandingReviewCount;
    const baselineRecusals = baseline.progress!.recusalCount;

    const assigned = await runAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId,
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_recusal_assign",
    }));
    expect(assigned.assignment).toMatchObject({ status: "assigned", recusalReason: null, recusedAt: null, version: 1 });
    const afterAssignment = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      selectedSubmissionId: submissionId,
      page: 1,
      pageSize: 100,
    }));
    expect(afterAssignment.progress).toMatchObject({
      assignedReviewCount: baselineAssigned + 1,
      outstandingReviewCount: baselineOutstanding + 1,
      recusalCount: baselineRecusals,
    });
    expect(afterAssignment.progress?.incompleteSubmissions).toContainEqual(expect.objectContaining({
      submissionId,
      assignedReviewCount: 1,
      completedReviewCount: 0,
      outstandingReviewerNames: ["Ada Rivera"],
      needsReviewer: false,
    }));

    const input = {
      eventId: fixtureEventId,
      assignmentId: assigned.assignment.id,
      expectedVersion: 1,
      reason: "I advised the submitter on this proposal.",
      idempotencyKey: "recusal-history-01",
      requestId: "request_recusal_history_01",
    } as const;
    const concurrentRecusals = await Promise.all([
      runAs(reviewer, recuseAssignment(input)),
      runAs(reviewer, recuseAssignment(input)),
    ]);
    expect(concurrentRecusals.map((result) => result.idempotent).sort()).toEqual([false, true]);
    const recused = concurrentRecusals.find((result) => !result.idempotent)!;
    const replayed = await runAs(reviewer, recuseAssignment(input));
    expect(recused).toMatchObject({
      assignment: {
        id: assigned.assignment.id,
        status: "recused",
        recusalReason: input.reason,
        version: 2,
      },
      idempotent: false,
    });
    expect(replayed).toEqual({ ...recused, idempotent: true });

    const scoreAfterRecusal = await runEitherAs(reviewer, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId,
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 4 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 4 },
      ],
      requestId: "request_score_after_recusal",
    }));
    expect(scoreAfterRecusal._tag).toBe("Left");
    if (scoreAfterRecusal._tag === "Left") expect(scoreAfterRecusal.left._tag).toBe("Conflict");

    const afterRecusal = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      selectedSubmissionId: submissionId,
      page: 1,
      pageSize: 100,
    }));
    expect(afterRecusal.progress).toMatchObject({
      assignedReviewCount: baselineAssigned,
      outstandingReviewCount: baselineOutstanding,
      recusalCount: baselineRecusals + 1,
    });
    expect(afterRecusal.progress?.incompleteSubmissions).toContainEqual(expect.objectContaining({
      submissionId,
      assignedReviewCount: 0,
      completedReviewCount: 0,
      recusalCount: 1,
      needsReviewer: true,
    }));
    expect(afterRecusal.selected?.assignments).toContainEqual(expect.objectContaining({
      id: assigned.assignment.id,
      status: "recused",
      recusalReason: input.reason,
      version: 2,
    }));

    const reassigned = await runAs(owner, assignReviewer({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId,
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_recusal_reassign",
    }));
    expect(reassigned.assignment.id).not.toBe(assigned.assignment.id);
    const history = await db.select().from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, fixtureEventId),
      eq(reviewAssignments.submissionId, submissionId),
      eq(reviewAssignments.reviewerUserId, fixtureReviewerId),
    ));
    expect(history.map((assignment) => assignment.status).sort()).toEqual(["assigned", "recused"]);
    expect(await db.select().from(auditLog).where(and(
      eq(auditLog.resourceType, "reviewAssignment"),
      eq(auditLog.resourceId, assigned.assignment.id),
    ))).toContainEqual(expect.objectContaining({ action: "review.recuseAssignment" }));
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.aggregateType, "reviewAssignment"),
      eq(domainChanges.aggregateId, assigned.assignment.id),
    ))).toContainEqual(expect.objectContaining({ eventType: "review.assignment.recused" }));
  });

  it("lets an organizer remove one completed assignment from the active queue without deleting its review history", async () => {
    const cleanupReviewerId = "user_reviewer_assignment_cleanup";
    const createdAt = new Date(fixtureClock);
    await db.insert(users).values({
      id: cleanupReviewerId,
      email: "cleanup-reviewer@example.com",
      name: "Sam Queue Cleanup",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(eventMembers).values({
      id: "member_reviewer_assignment_cleanup",
      eventId: fixtureEventId,
      userId: cleanupReviewerId,
      role: "reviewer",
      createdAt,
      updatedAt: createdAt,
    });
    const cleanupReviewer: Principal = {
      kind: "browser-session",
      userId: cleanupReviewerId,
      email: "cleanup-reviewer@example.com",
      name: "Sam Queue Cleanup",
      sessionId: "session_reviewer_assignment_cleanup",
      expiresAt: fixtureClock + 86_400_000,
    };
    const { submissionId: targetOneId } = await seedTransitionSubmission("submitted");
    const { submissionId: targetTwoId } = await seedTransitionSubmission("submitted");
    const { submissionId: staleId } = await seedTransitionSubmission("submitted");
    const [targetOne, targetTwo, stale] = await Promise.all([
      runAs(owner, assignReviewer({
        eventId: fixtureEventId,
        roundId: activeRoundFixture.id,
        submissionId: targetOneId,
        reviewerUserId: cleanupReviewerId,
        expectedVersion: 0,
        requestId: "request_assign_cleanup_target_one",
      })),
      runAs(owner, assignReviewer({
        eventId: fixtureEventId,
        roundId: activeRoundFixture.id,
        submissionId: targetTwoId,
        reviewerUserId: cleanupReviewerId,
        expectedVersion: 0,
        requestId: "request_assign_cleanup_target_two",
      })),
      runAs(owner, assignReviewer({
        eventId: fixtureEventId,
        roundId: activeRoundFixture.id,
        submissionId: staleId,
        reviewerUserId: cleanupReviewerId,
        expectedVersion: 0,
        requestId: "request_assign_cleanup_stale",
      })),
    ]);
    const completedReview = await runAs(cleanupReviewer, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: staleId,
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 4 },
        { criterionKey: "specificity", score: 5 },
        { criterionKey: "delivery", score: 4 },
      ],
      comment: "Historical rationale must survive queue cleanup.",
      requestId: "request_score_cleanup_stale",
    }));
    const before = await runAs(cleanupReviewer, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      assignedToMe: true,
      page: 1,
      pageSize: 100,
    }));
    expect(new Set(before.queue.map(({ id: submissionId }) => submissionId))).toEqual(
      new Set([targetOneId, targetTwoId, staleId]),
    );

    const input = {
      eventId: fixtureEventId,
      assignmentId: stale.assignment.id,
      expectedVersion: stale.assignment.version,
      idempotencyKey: "remove-stale-completed-assignment",
      requestId: "request_remove_stale_completed_assignment",
    } as const;
    const reviewerAttempt = await runEitherAs(cleanupReviewer, removeAssignment({
      ...input,
      idempotencyKey: "reviewer-cannot-remove-assignment",
      requestId: "request_reviewer_cannot_remove_assignment",
    }));
    expect(reviewerAttempt._tag).toBe("Left");
    if (reviewerAttempt._tag === "Left") expect(reviewerAttempt.left._tag).toBe("Forbidden");
    const removed = await runAs(owner, removeAssignment(input));
    const replayed = await runAs(owner, removeAssignment(input));
    expect(removed).toMatchObject({
      assignmentId: stale.assignment.id,
      roundId: activeRoundFixture.id,
      submissionId: staleId,
      reviewerUserId: cleanupReviewerId,
      preservedReviewCount: 1,
      idempotent: false,
    });
    expect(replayed).toEqual({ ...removed, idempotent: true });

    const after = await runAs(cleanupReviewer, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      assignedToMe: true,
      page: 1,
      pageSize: 100,
    }));
    expect(after.queue.map(({ id: submissionId }) => submissionId).sort()).toEqual([targetOneId, targetTwoId].sort());
    const activeRows = await db.select().from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, fixtureEventId),
      eq(reviewAssignments.reviewerUserId, cleanupReviewerId),
      eq(reviewAssignments.status, "assigned"),
    ));
    expect(activeRows.map(({ id: assignmentId }) => assignmentId).sort()).toEqual(
      [targetOne.assignment.id, targetTwo.assignment.id].sort(),
    );
    const preserved = await db.select().from(reviews).where(eq(reviews.id, completedReview.review.id));
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toMatchObject({
      submissionId: staleId,
      reviewerUserId: cleanupReviewerId,
      comment: "Historical rationale must survive queue cleanup.",
    });
    const organizerHistory = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      selectedSubmissionId: staleId,
      page: 1,
      pageSize: 100,
    }));
    expect(organizerHistory.selected?.reviews).toContainEqual(expect.objectContaining({
      id: completedReview.review.id,
      reviewerUserId: cleanupReviewerId,
      comment: "Historical rationale must survive queue cleanup.",
    }));
    expect(await db.select().from(auditLog).where(and(
      eq(auditLog.action, "review.removeAssignment"),
      eq(auditLog.resourceId, stale.assignment.id),
    ))).toContainEqual(expect.objectContaining({
      before: expect.objectContaining({
        submissionId: staleId,
        reviewerUserId: cleanupReviewerId,
        status: "assigned",
      }),
      after: null,
    }));
    expect(await db.select().from(domainChanges).where(and(
      eq(domainChanges.eventType, "review.assignment.removed"),
      eq(domainChanges.aggregateId, stale.assignment.id),
    ))).toHaveLength(1);
  });

  it("bulk-balances an independent round pool and reports per-reviewer completion", async () => {
    const input = {
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionIds: ["submission_42", "submission_40", "submission_41"] as const,
      reviewerUserIds: ["user_reviewer_dev", fixtureReviewerId] as const,
      reviewsPerSubmission: 1,
      strategy: "balanced" as const,
      idempotencyKey: "bulk-assignment-balanced-01",
      requestId: "request_bulk_assignment_balanced",
    };
    const assigned = await runAs(owner, bulkAssignReviewers(input));
    const replayed = await runAs(owner, bulkAssignReviewers({
      ...input,
      submissionIds: ["submission_40", "submission_41", "submission_42"],
      reviewerUserIds: [fixtureReviewerId, "user_reviewer_dev"],
      requestId: "request_bulk_assignment_replay",
    }));
    expect(assigned).toEqual({ createdCount: 3, existingCount: 0, assignmentCount: 3, conflictSkippedCount: 0, idempotent: false });
    expect(replayed).toEqual({ ...assigned, idempotent: true });

    const rows = await db.select().from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, fixtureEventId),
      eq(reviewAssignments.roundId, activeRoundFixture.id),
    ));
    const created = rows.filter((row) => ["submission_40", "submission_41", "submission_42"].includes(row.submissionId));
    expect(created).toHaveLength(3);
    const counts = [fixtureReviewerId, "user_reviewer_dev"].map(
      (reviewerUserId) => created.filter((row) => row.reviewerUserId === reviewerUserId).length,
    ).sort();
    expect(counts).toEqual([1, 2]);

    const workbench = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      page: 1,
      pageSize: 60,
    }));
    expect(workbench.reviewerProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewerUserId: fixtureReviewerId, outstandingCount: expect.any(Number) }),
      expect.objectContaining({ reviewerUserId: "user_reviewer_dev", outstandingCount: expect.any(Number) }),
    ]));
  });

  it("resolves overlapping bulk assignments without surfacing a database failure", async () => {
    const { submissionId } = await seedTransitionSubmission("submitted");
    const base = {
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionIds: [submissionId] as const,
      reviewerUserIds: [fixtureReviewerId] as const,
      reviewsPerSubmission: 1,
      strategy: "all" as const,
    };
    const results = await Promise.all([
      runAs(owner, bulkAssignReviewers({
        ...base,
        idempotencyKey: `bulk-overlap-a-${submissionId}`,
        requestId: `request_bulk_overlap_a_${submissionId}`,
      })),
      runAs(owner, bulkAssignReviewers({
        ...base,
        idempotencyKey: `bulk-overlap-b-${submissionId}`,
        requestId: `request_bulk_overlap_b_${submissionId}`,
      })),
    ]);
    expect(results.map(({ createdCount }) => createdCount).sort()).toEqual([0, 1]);
    expect(results.every(({ assignmentCount, idempotent }) => assignmentCount === 1 && !idempotent)).toBe(true);
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
      idempotencyKey: "ai-pending-round-01",
      requestId: "request_ai_pending",
    }));
    expect(pendingAi._tag).toBe("Left");
    if (pendingAi._tag === "Left") expect(pendingAi.left._tag).toBe("Conflict");

    const completedAi = await runEitherAs(owner, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: completedRoundFixture.id,
      submissionId: "submission_22",
      idempotencyKey: "ai-complete-round-01",
      requestId: "request_ai_complete",
    }));
    expect(completedAi._tag).toBe("Left");
    if (completedAi._tag === "Left") expect(completedAi.left._tag).toBe("Conflict");
  });

  it("requires an exact assignment before a reviewer can save complete bounded 1–5 scores", async () => {
    const decoded = Schema.decodeUnknownEither(SaveScoreInput)({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_30",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 6 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 3 },
      ],
      requestId: "request_invalid_score",
    });
    expect(decoded._tag).toBe("Left");

    const unassigned = await runEitherAs(reviewer, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_30",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 5 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 3 },
      ],
      comment: "Human-confirmed review",
      requestId: "request_unassigned_score_allowed",
    }));
    expect(unassigned._tag).toBe("Left");
    if (unassigned._tag === "Left") expect(unassigned.left._tag).toBe("Forbidden");

    await db.insert(reviewAssignments).values({
      id: "assignment_score_submission_30",
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_30",
      reviewerUserId: fixtureReviewerId,
      createdAt: new Date(fixtureClock),
      updatedAt: new Date(fixtureClock),
    });
    const saved = await runAs(reviewer, saveScore({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_30",
      expectedVersion: 0,
      scores: [
        { criterionKey: "relevance", score: 5 },
        { criterionKey: "specificity", score: 4 },
        { criterionKey: "delivery", score: 3 },
      ],
      comment: "Human-confirmed review",
      requestId: "request_assigned_score_allowed",
    }));
    expect(saved.review.score).toBe(4);
    expect(saved.submissionStatus).not.toBe("accepted");
    const [scoreChange] = await db.select().from(domainChanges).where(eq(
      domainChanges.requestId,
      "request_assigned_score_allowed",
    ));
    expect(scoreChange?.audiences).toEqual([
      { kind: "admins" },
      { kind: "reviewers", reviewerUserIds: [fixtureReviewerId] },
    ]);
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, "submission_30"));
    expect(submission?.status).toBe("submitted");
  });

  it("calculates typed scorecards with configured numeric and dropdown weights", async () => {
    const eventId = "event_typed_scorecard";
    const createdAt = new Date(fixtureClock);
    await db.insert(events).values({
      id: eventId,
      slug: "typed-scorecard",
      name: "Typed scorecard",
      timezone: "UTC",
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(eventMembers).values([
      { id: "member_typed_owner", eventId, userId: fixtureOwnerId, role: "owner", createdAt, updatedAt: createdAt },
      { id: "member_typed_reviewer", eventId, userId: fixtureReviewerId, role: "reviewer", createdAt, updatedAt: createdAt },
    ]);
    await db.insert(forms).values({ id: "form_typed", eventId, kind: "cfp", name: "Typed CFP", status: "closed", createdAt, updatedAt: createdAt });
    await db.insert(formVersions).values({ id: "form_version_typed", eventId, formId: "form_typed", versionNumber: 1, name: "Typed CFP", publishedAt: createdAt, createdAt });
    await db.insert(formVersionFields).values({
      id: "field_typed_abstract", eventId, formVersionId: "form_version_typed", order: 1,
      type: "textarea", label: "Abstract", semanticKey: "submissionAbstract", required: true, createdAt,
    });
    await db.insert(submissions).values({
      id: "submission_typed", eventId, formId: "form_typed", formVersionId: "form_version_typed",
      title: "Typed proposal", status: "submitted", submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
    });
    await db.insert(submissionAnswers).values({
      id: "answer_typed", eventId, submissionId: "submission_typed", formVersionId: "form_version_typed",
      formVersionFieldId: "field_typed_abstract", value: "Typed scorecard evidence", createdAt, updatedAt: createdAt,
    });
    await db.insert(reviewRounds).values({
      id: "round_typed", eventId, name: "Typed review", order: 1, status: "active", blind: false,
      rubric: {
        criteria: [
          { key: "clarity", label: "Clarity", type: "numeric", weight: 2, required: true, max: 5 },
          {
            key: "recommendation", label: "Recommendation", type: "dropdown", weight: 3, required: true, max: 5,
            options: [
              { value: "decline", label: "Decline", score: 1 },
              { value: "accept", label: "Accept", score: 5 },
            ],
          },
          { key: "notes", label: "Notes", type: "text", weight: 0, required: false, max: 5 },
        ],
      },
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(reviewAssignments).values({
      id: "assignment_typed", eventId, roundId: "round_typed", submissionId: "submission_typed",
      reviewerUserId: fixtureReviewerId, version: 1, createdAt, updatedAt: createdAt,
    });

    const saved = await runAs(reviewer, saveScore({
      eventId,
      roundId: "round_typed",
      submissionId: "submission_typed",
      expectedVersion: 0,
      scores: [
        { criterionKey: "clarity", score: 5 },
        { criterionKey: "recommendation", score: "decline" },
        { criterionKey: "notes", score: "Promising, but not ready." },
      ],
      requestId: "request_typed_score",
    }));
    expect(saved.review.score).toBeCloseTo(2.6);
    expect(saved.review.scores).toEqual([
      { criterionKey: "clarity", score: 5 },
      { criterionKey: "recommendation", score: "decline" },
      { criterionKey: "notes", score: "Promising, but not ready." },
    ]);

    await db.update(reviewRounds).set({
      rubric: {
        criteria: [
          { key: "notes", label: "Notes", type: "text", weight: 0, required: true, max: 5 },
        ],
      },
    }).where(eq(reviewRounds.id, "round_typed"));
    const unscored = await runAs(reviewer, saveScore({
      eventId,
      roundId: "round_typed",
      submissionId: "submission_typed",
      expectedVersion: 1,
      scores: [{ criterionKey: "notes", score: "Qualitative review only." }],
      requestId: "request_text_only_score",
    }));
    expect(unscored.review.score).toBeNull();
    const [persisted] = await db.select({ score: reviews.score }).from(reviews).where(eq(reviews.id, unscored.review.id));
    expect(persisted?.score).toBe(0);

    const workbench = await runAs(owner, getWorkbench({
      eventId,
      roundId: "round_typed",
      selectedSubmissionId: "submission_typed",
      order: "decision",
      page: 1,
      pageSize: 60,
    }));
    expect(workbench.queue[0]).toMatchObject({ id: "submission_typed", completedReviewCount: 1, averageScore: null });
    expect(workbench.selected?.reviews[0]?.score).toBeNull();

    const exported = await runAs(owner, exportReviewResults({ eventId, roundId: "round_typed" }));
    expect(exported.rows).toContainEqual(expect.objectContaining({
      submissionId: "submission_typed",
      aggregateScore: null,
      responses: [{ criterionKey: "notes", score: "Qualitative review only." }],
    }));
  });

  it("limits AI input, labels the suggestion, and never transitions submission status", async () => {
    await db.insert(reviewAssignments).values({
      id: "assignment_ai_31",
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_31",
      reviewerUserId: fixtureReviewerId,
      createdAt: new Date(fixtureClock),
      updatedAt: new Date(fixtureClock),
    });
    const result = await runAs(reviewer, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_31",
      idempotencyKey: "ai-suggestion-01",
      requestId: "request_ai_01",
    }));
    const replay = await runAs(reviewer, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_31",
      idempotencyKey: "ai-suggestion-01",
      requestId: "request_ai_replay_01",
    }));
    expect(replay).toEqual(result);
    const rateLimited = await runEitherAs(reviewer, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_31",
      idempotencyKey: "ai-suggestion-02",
      requestId: "request_ai_rate_limited_02",
    }));
    expect(rateLimited._tag).toBe("Left");
    if (rateLimited._tag === "Left") {
      expect(rateLimited.left._tag).toBe("Conflict");
      expect(rateLimited.left.message).toContain("one request per submission each minute");
    }
    expect(result.suggestion.label).toContain("requires human confirmation");
    expect(result.suggestion.inputFields).toEqual(["title", "abstract", "rubric"]);
    expect(lastAiPrompt).toContain('"title"');
    expect(lastAiPrompt).toContain('"abstract"');
    expect(lastAiPrompt).toContain('"rubric"');
    expect(lastAiPrompt).not.toContain("email");
    expect(result.submissionStatus).not.toBe("accepted");
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, "submission_31"));
    expect(submission?.status).toBe("submitted");
    const suggestionRows = await db.select().from(reviews).where(and(
      eq(reviews.eventId, fixtureEventId),
      eq(reviews.roundId, activeRoundFixture.id),
      eq(reviews.submissionId, "submission_31"),
      eq(reviews.ai, true),
    ));
    expect(suggestionRows).toHaveLength(1);
    const [change] = await db.select().from(domainChanges).where(eq(domainChanges.requestId, "request_ai_01"));
    expect(change?.audiences).toEqual([
      { kind: "admins" },
      { kind: "reviewers", reviewerUserIds: [fixtureReviewerId] },
    ]);
  });

  it("queues idempotent reminders only for reviewers with outstanding assignments", async () => {
    const deliveriesBefore = await db.select().from(mailDeliveries);
    const wakeCountBefore = mailQueueWakeCount;
    const input = {
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      reviewerUserIds: [fixtureReviewerId, "user_reviewer_dev"] as const,
      idempotencyKey: "review-reminders-active-round-01",
      requestId: "request_review_reminders_active",
    };
    const queued = await runAs(owner, sendReviewReminders(input));
    const replayed = await runAs(owner, sendReviewReminders(input));
    expect(queued).toMatchObject({
      queuedCount: 2,
      skippedCount: 0,
      reviewerUserIds: expect.arrayContaining([fixtureReviewerId, "user_reviewer_dev"]),
      idempotent: false,
    });
    expect(replayed).toEqual({ ...queued, idempotent: true });
    const deliveriesAfter = await db.select().from(mailDeliveries);
    expect(deliveriesAfter).toHaveLength(deliveriesBefore.length + queued.queuedCount);
    const snapshots = await db.select().from(mailDeliverySnapshots);
    expect(snapshots.slice(-queued.queuedCount).every((snapshot) =>
      snapshot.renderedText?.includes("outstanding") && snapshot.renderedText.includes("assigned queue")
    )).toBe(true);
    expect(mailQueueWakeCount).toBe(wakeCountBefore + 2);
  });

  it("rejects an empty reviewer reminder audience", async () => {
    const result = await runEitherAs(owner, sendReviewReminders({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      reviewerUserIds: [] as unknown as readonly [string, ...string[]],
      idempotencyKey: "review-reminders-empty-audience-01",
      requestId: "request_review_reminders_empty",
    }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("Validation");
  });

  it("exports normalized review results with criterion-level responses", async () => {
    const exported = await runAs(owner, exportReviewResults({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
    }));
    expect(exported.eventName).toBe("Fieldcraft 2026");
    expect(exported.round.id).toBe(activeRoundFixture.id);
    expect(exported.rows.length).toBeGreaterThanOrEqual(60);
    expect(exported.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        submissionId: "submission_05",
        reviewerUserId: "user_reviewer_dev",
        aggregateScore: 2,
        responses: [
          { criterionKey: "relevance", score: 2 },
          { criterionKey: "specificity", score: 2 },
          { criterionKey: "delivery", score: 2 },
        ],
      }),
    ]));
  });

  it("allows scoped API-key AI suggestions but rejects human scoring and acceptance", async () => {
    const aiResult = await runAs(reviewApiKey, requestAiSuggestion({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      submissionId: "submission_08",
      idempotencyKey: "ai-api-key-01",
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
    const { submissionId } = await seedTransitionSubmission("in_review", 2);
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
    expect(submission).toMatchObject({ status: "in_review", version: 2 });
    expect(durableAcceptance).toEqual([]);
    expect(provisioning).toEqual([]);
    expect(changes).toEqual([]);
    expect(audits).toEqual([]);
    expect(idempotencyAfter).toHaveLength(idempotencyBefore.length);
  });

  it.each(["submitted", "in_review", "waitlist"] as const)(
    "accepts a %s submission and replays the decision idempotently",
    async (sourceStatus) => {
      const { submissionId, version } = await seedTransitionSubmission(sourceStatus);
      const input = {
        eventId: fixtureEventId,
        submissionId,
        expectedVersion: version,
        idempotencyKey: `accept-from-${sourceStatus}-${submissionId}`,
        requestId: `request_accept_from_${sourceStatus}_${submissionId}`,
      } as const;

      const accepted = await runAs(owner, acceptSubmission(input));
      const replayed = await runAs(owner, acceptSubmission(input));

      expect(accepted).toMatchObject({ submissionId, submissionVersion: version + 1, status: "accepted", idempotent: false });
      expect(replayed).toEqual({ ...accepted, idempotent: true });
      const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(submission).toMatchObject({ status: "accepted", version: version + 1 });
    },
  );

  it.each(["submitted", "in_review", "waitlist"] as const)(
    "rejects a %s submission and replays the decision idempotently",
    async (sourceStatus) => {
      const { submissionId, version } = await seedTransitionSubmission(sourceStatus);
      const input = {
        eventId: fixtureEventId,
        submissionId,
        expectedVersion: version,
        idempotencyKey: `reject-from-${sourceStatus}-${submissionId}`,
        requestId: `request_reject_from_${sourceStatus}_${submissionId}`,
      } as const;

      const rejected = await runAs(owner, rejectSubmission(input));
      const replayed = await runAs(owner, rejectSubmission(input));

      expect(rejected).toEqual({
        submissionId,
        submissionVersion: version + 1,
        status: "rejected",
        idempotent: false,
      });
      expect(replayed).toEqual({ ...rejected, idempotent: true });
      const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(submission).toMatchObject({ status: "rejected", version: version + 1 });
    },
  );

  it.each(["accepted", "rejected", "withdrawn"] as const)(
    "does not accept a %s submission",
    async (sourceStatus) => {
      const { submissionId, version } = await seedTransitionSubmission(sourceStatus);
      const result = await runEitherAs(owner, acceptSubmission({
        eventId: fixtureEventId,
        submissionId,
        expectedVersion: version,
        idempotencyKey: `accept-denied-${sourceStatus}-${submissionId}`,
        requestId: `request_accept_denied_${sourceStatus}_${submissionId}`,
      }));

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left._tag).toBe("Conflict");
      const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(submission).toMatchObject({ status: sourceStatus, version });
      expect(await db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, submissionId))).toEqual([]);
    },
  );

  it.each(["accepted", "rejected", "withdrawn"] as const)(
    "does not reject a %s submission",
    async (sourceStatus) => {
      const { submissionId, version } = await seedTransitionSubmission(sourceStatus);
      const result = await runEitherAs(owner, rejectSubmission({
        eventId: fixtureEventId,
        submissionId,
        expectedVersion: version,
        idempotencyKey: `reject-denied-${sourceStatus}-${submissionId}`,
        requestId: `request_reject_denied_${sourceStatus}_${submissionId}`,
      }));

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left._tag).toBe("Conflict");
      const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(submission).toMatchObject({ status: sourceStatus, version });
      expect(await db.select().from(domainChanges).where(eq(domainChanges.requestId, `request_reject_denied_${sourceStatus}_${submissionId}`))).toEqual([]);
    },
  );

  it("rejects stale versions for both acceptance and rejection without changing status", async () => {
    const acceptance = await seedTransitionSubmission("submitted", 2);
    const rejection = await seedTransitionSubmission("waitlist", 2);

    const [acceptResult, rejectResult] = await Promise.all([
      runEitherAs(owner, acceptSubmission({
        eventId: fixtureEventId,
        submissionId: acceptance.submissionId,
        expectedVersion: 1,
        idempotencyKey: `accept-stale-${acceptance.submissionId}`,
        requestId: `request_accept_stale_${acceptance.submissionId}`,
      })),
      runEitherAs(owner, rejectSubmission({
        eventId: fixtureEventId,
        submissionId: rejection.submissionId,
        expectedVersion: 1,
        idempotencyKey: `reject-stale-${rejection.submissionId}`,
        requestId: `request_reject_stale_${rejection.submissionId}`,
      })),
    ]);

    expect(acceptResult._tag).toBe("Left");
    expect(rejectResult._tag).toBe("Left");
    if (acceptResult._tag === "Left") expect(acceptResult.left._tag).toBe("Conflict");
    if (rejectResult._tag === "Left") expect(rejectResult.left._tag).toBe("Conflict");
    const [acceptedRow] = await db.select().from(submissions).where(eq(submissions.id, acceptance.submissionId));
    const [rejectedRow] = await db.select().from(submissions).where(eq(submissions.id, rejection.submissionId));
    expect(acceptedRow).toMatchObject({ status: "submitted", version: 2 });
    expect(rejectedRow).toMatchObject({ status: "waitlist", version: 2 });
  });

  it("atomically resolves a same-version acceptance and rejection race", async () => {
    const { submissionId, version } = await seedTransitionSubmission("in_review");
    const results = await Promise.all([
      runEitherAs(owner, acceptSubmission({
        eventId: fixtureEventId,
        submissionId,
        expectedVersion: version,
        idempotencyKey: `accept-race-${submissionId}`,
        requestId: `request_accept_race_${submissionId}`,
      })),
      runEitherAs(owner, rejectSubmission({
        eventId: fixtureEventId,
        submissionId,
        expectedVersion: version,
        idempotencyKey: `reject-race-${submissionId}`,
        requestId: `request_reject_race_${submissionId}`,
      })),
    ]);

    expect(results.map((result) => result._tag).sort()).toEqual(["Left", "Right"]);
    const failure = results.find((result) => result._tag === "Left");
    if (failure?._tag === "Left") expect(failure.left._tag).toBe("Conflict");
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(["accepted", "rejected"]).toContain(submission?.status);
    expect(submission?.version).toBe(version + 1);
    const acceptance = await db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, submissionId));
    expect(acceptance).toHaveLength(submission?.status === "accepted" ? 1 : 0);
  });

  it("rejects stale acceptance and atomically creates one durable acceptance plus primary-speaker provisioning", async () => {
    const integrationId = "airtable-review-acceptance";
    const integrationNow = new Date(fixtureClock);
    await db.insert(integrations).values({
      id: integrationId,
      eventId: fixtureEventId,
      kind: "airtable",
      secretRef: "AIRTABLE_PAT",
      config: {},
      createdAt: integrationNow,
      updatedAt: integrationNow,
    });
    const stale = await runEitherAs(owner, acceptSubmission({
      eventId: fixtureEventId,
      submissionId: contentionFixture.submissionId,
      expectedVersion: contentionFixture.expectedVersion,
      idempotencyKey: "accept-contention-key",
      requestId: "request_accept_stale",
    }));
    expect(stale._tag).toBe("Left");
    if (stale._tag === "Left") expect(stale.left._tag).toBe("Conflict");
    await expect(db.select().from(airtableOutbox).where(eq(airtableOutbox.integrationId, integrationId)))
      .resolves.toHaveLength(0);

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
    await expect(db.select().from(airtableOutbox).where(eq(airtableOutbox.integrationId, integrationId)))
      .resolves.toEqual([expect.objectContaining({
        entityType: "submission",
        entityId: input.submissionId,
        changedFields: { status: "accepted" },
        outboundRevision: 1,
        status: "pending",
      })]);
  });

  it("stages an organizer-only decision without exposing or provisioning it", async () => {
    const input = {
      eventId: fixtureEventId,
      submissionId: "submission_55",
      decision: "accepted" as const,
      expectedVersion: 2,
      idempotencyKey: "stage-accept-submission-55",
      requestId: "request_stage_accept_55",
    };
    const staged = await runAs(owner, stageDecision(input));
    expect(await runAs(owner, stageDecision(input))).toEqual({ ...staged, idempotent: true });
    expect(staged).toMatchObject({ pendingDecision: "accepted", submissionVersion: 3, idempotent: false });
    const [stored] = await db.select().from(submissions).where(eq(submissions.id, input.submissionId));
    expect(stored).toMatchObject({ status: "submitted", pendingDecision: "accepted", version: 3, acceptedAt: null });
    await expect(db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, input.submissionId))).resolves.toEqual([]);
    await expect(db.select().from(speakerProvisioning).where(eq(speakerProvisioning.submissionId, input.submissionId))).resolves.toEqual([]);

    const organizerView = await runAs(owner, getWorkbench({
      eventId: fixtureEventId, selectedSubmissionId: input.submissionId, page: 1, pageSize: 100,
    }));
    expect(organizerView.selected?.pendingDecision).toBe("accepted");
    const apiView = await runAs({ ...reviewApiKey, scopes: [...reviewApiKey.scopes, "reviews:read"] }, getWorkbench({
      eventId: fixtureEventId, selectedSubmissionId: input.submissionId, page: 1, pageSize: 100,
    }));
    expect(apiView.selected?.pendingDecision).toBeNull();
    const [change] = await db.select().from(domainChanges).where(eq(domainChanges.requestId, input.requestId));
    expect(change).toMatchObject({ eventType: "review.decision.staged", audiences: [{ kind: "admins" }] });

    await expect(db.update(submissions).set({ status: "accepted", acceptedAt: new Date() }).where(eq(submissions.id, input.submissionId)))
      .rejects.toThrow(/Failed query/);
    await expect(db.select().from(submissions).where(eq(submissions.id, input.submissionId)))
      .resolves.toEqual([expect.objectContaining({ status: "submitted", pendingDecision: "accepted", version: 3 })]);

    const cleared = await runAs(owner, stageDecision({
      ...input,
      decision: null,
      expectedVersion: staged.submissionVersion,
      idempotencyKey: "clear-staged-submission-55",
      requestId: "request_clear_staged_55",
    }));
    expect(cleared).toMatchObject({ pendingDecision: null, submissionVersion: 4, idempotent: false });
    await expect(db.select().from(submissions).where(eq(submissions.id, input.submissionId)))
      .resolves.toEqual([expect.objectContaining({ status: "submitted", pendingDecision: null, version: 4 })]);

    const forbidden = await runEitherAs(reviewApiKey, stageDecision({
      ...input,
      submissionId: "submission_54",
      idempotencyKey: "stage-api-key-denied-54",
      requestId: "request_stage_api_key_denied_54",
    }));
    expect(forbidden._tag).toBe("Left");
    if (forbidden._tag === "Left") expect(forbidden.left._tag).toBe("Forbidden");
  });

  it("replays concurrent matching staged-decision keys without duplicate evidence", async () => {
    const { submissionId, version } = await seedTransitionSubmission("submitted", 1);
    const input = {
      eventId: fixtureEventId,
      submissionId,
      decision: "accepted" as const,
      expectedVersion: version,
      idempotencyKey: `concurrent-stage-${submissionId}`,
      requestId: `request_concurrent_stage_${submissionId}`,
    };
    const results = await Promise.all([
      runAs(owner, stageDecision(input)),
      runAs(owner, stageDecision(input)),
    ]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.submissionVersion))).toEqual(new Set([version + 1]));
    await expect(db.select().from(domainChanges).where(eq(domainChanges.requestId, input.requestId))).resolves.toHaveLength(1);
    await expect(db.select().from(auditLog).where(eq(auditLog.requestId, input.requestId))).resolves.toHaveLength(1);
  });

  it("atomically releases a mixed staged batch into submitter, provisioning, Airtable, and Communications projections", async () => {
    const createdAt = new Date(fixtureClock + 5_000);
    const decisionUserId = "user_decision_release";
    const decisionSpeakerId = "speaker_decision_release";
    const acceptedSubmissionId = "submission_decision_accept";
    const rejectedSubmissionId = "submission_decision_reject";
    const submitter: Principal = {
      kind: "browser-session",
      userId: decisionUserId,
      email: "decision-release@example.com",
      name: "Decision Release Speaker",
      sessionId: "session-decision-release",
      expiresAt: fixtureClock + 86_400_000,
    };
    await db.batch([
      db.insert(users).values({ id: decisionUserId, email: submitter.email!, name: submitter.name, createdAt, updatedAt: createdAt }),
      db.insert(speakers).values({ id: decisionSpeakerId, eventId: fixtureEventId, userId: decisionUserId, displayName: submitter.name!, createdAt, updatedAt: createdAt }),
      db.insert(submissions).values({
        id: acceptedSubmissionId, eventId: fixtureEventId, formId: "form_cfp", formVersionId: "form_version_01",
        title: "Release accepted proposal", status: "submitted", submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
      }),
      db.insert(submissions).values({
        id: rejectedSubmissionId, eventId: fixtureEventId, formId: "form_cfp", formVersionId: "form_version_01",
        title: "Release rejected proposal", status: "in_review", submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
      }),
      db.insert(submissionSpeakers).values({
        id: "association_decision_accept", eventId: fixtureEventId, submissionId: acceptedSubmissionId,
        speakerId: decisionSpeakerId, isPrimary: true, createdAt,
      }),
      db.insert(submissionSpeakers).values({
        id: "association_decision_reject", eventId: fixtureEventId, submissionId: rejectedSubmissionId,
        speakerId: decisionSpeakerId, isPrimary: true, createdAt,
      }),
      db.insert(integrations).values({
        id: "airtable-review-acceptance", eventId: fixtureEventId, kind: "airtable", secretRef: "AIRTABLE_PAT",
        config: {}, createdAt, updatedAt: createdAt,
      }).onConflictDoNothing(),
    ] as never);

    const stagedAccept = await runAs(owner, stageDecision({
      eventId: fixtureEventId, submissionId: acceptedSubmissionId, decision: "accepted", expectedVersion: 1,
      idempotencyKey: "stage-release-accepted", requestId: "request_stage_release_accepted",
    }));
    const stagedReject = await runAs(owner, stageDecision({
      eventId: fixtureEventId, submissionId: rejectedSubmissionId, decision: "rejected", expectedVersion: 1,
      idempotencyKey: "stage-release-rejected", requestId: "request_stage_release_rejected",
    }));
    const ownBefore = await runAs(submitter, getOwnSubmissions({ eventSlug: "fieldcraft-2026" }));
    expect(ownBefore.submissions.filter((submission) => [acceptedSubmissionId, rejectedSubmissionId].includes(submission.id)).map((submission) => submission.status).sort())
      .toEqual(["in_review", "submitted"]);
    const audienceBefore = await runAs(owner, listAudience({ eventId: fixtureEventId, page: 1, pageSize: 100 }));
    expect(audienceBefore.recipients.some((recipient) => recipient.speakerId === decisionSpeakerId)).toBe(false);
    const deliveriesBefore = await db.select().from(mailDeliveries);

    const releaseInput = {
      eventId: fixtureEventId,
      decisions: [
        { submissionId: acceptedSubmissionId, expectedVersion: stagedAccept.submissionVersion, expectedDecision: "accepted" as const },
        { submissionId: rejectedSubmissionId, expectedVersion: stagedReject.submissionVersion, expectedDecision: "rejected" as const },
      ] as const,
      idempotencyKey: "release-mixed-decision-batch",
      requestId: "request_release_mixed_decisions",
    };
    const released = await runAs(owner, releaseDecisions(releaseInput));
    expect(released).toMatchObject({ releasedCount: 2, acceptedCount: 1, rejectedCount: 1, idempotent: false });
    expect(await runAs(owner, releaseDecisions(releaseInput))).toEqual({ ...released, idempotent: true });

    const releasedRows = await db.select().from(submissions).where(and(
      eq(submissions.eventId, fixtureEventId),
      sql`${submissions.id} in (${acceptedSubmissionId}, ${rejectedSubmissionId})`,
    ));
    expect(releasedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: acceptedSubmissionId, status: "accepted", pendingDecision: null, version: 3 }),
      expect.objectContaining({ id: rejectedSubmissionId, status: "rejected", pendingDecision: null, version: 3, acceptedAt: null }),
    ]));
    await expect(db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, acceptedSubmissionId)))
      .resolves.toHaveLength(1);
    await expect(db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, rejectedSubmissionId)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(speakerProvisioning).where(eq(speakerProvisioning.submissionId, acceptedSubmissionId)))
      .resolves.toEqual([expect.objectContaining({ primarySpeakerId: decisionSpeakerId, status: "pending" })]);
    await expect(db.select().from(speakerProvisioning).where(eq(speakerProvisioning.submissionId, rejectedSubmissionId)))
      .resolves.toHaveLength(0);

    const ownAfter = await runAs(submitter, getOwnSubmissions({ eventSlug: "fieldcraft-2026" }));
    expect(ownAfter.submissions.filter((submission) => [acceptedSubmissionId, rejectedSubmissionId].includes(submission.id)).map((submission) => submission.status).sort())
      .toEqual(["accepted", "rejected"]);
    const audienceAfter = await runAs(owner, listAudience({ eventId: fixtureEventId, page: 1, pageSize: 100 }));
    expect(audienceAfter.recipients).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipientKey: `${decisionSpeakerId}:accepted`, decision: "accepted" }),
      expect.objectContaining({ recipientKey: `${decisionSpeakerId}:rejected`, decision: "rejected" }),
    ]));
    await expect(db.select().from(mailDeliveries)).resolves.toEqual(deliveriesBefore);
    await expect(db.select().from(auditLog).where(eq(auditLog.requestId, releaseInput.requestId))).resolves.toHaveLength(2);
    const changes = await db.select().from(domainChanges).where(eq(domainChanges.requestId, releaseInput.requestId));
    expect(changes.map((change) => change.eventType).sort()).toEqual([
      "review.decisions.released",
      "review.submission.accepted",
      "review.submission.rejected",
      "speaker.provisioning.requested",
    ]);
    const outbox = await db.select().from(airtableOutbox).where(and(
      eq(airtableOutbox.integrationId, "airtable-review-acceptance"),
      sql`${airtableOutbox.entityId} in (${acceptedSubmissionId}, ${rejectedSubmissionId})`,
    ));
    expect(outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: acceptedSubmissionId, changedFields: { status: "accepted" }, status: "pending" }),
      expect.objectContaining({ entityId: rejectedSubmissionId, changedFields: { status: "rejected" }, status: "pending" }),
    ]));
  });

  it("rolls back every selected decision when one staged version is stale", async () => {
    const first = await seedTransitionSubmission("submitted", 1);
    const second = await seedTransitionSubmission("waitlist", 1);
    const firstStage = await runAs(owner, stageDecision({
      eventId: fixtureEventId, submissionId: first.submissionId, decision: "accepted", expectedVersion: 1,
      idempotencyKey: `stage-atomic-${first.submissionId}`, requestId: `request_stage_atomic_${first.submissionId}`,
    }));
    const secondStage = await runAs(owner, stageDecision({
      eventId: fixtureEventId, submissionId: second.submissionId, decision: "rejected", expectedVersion: 1,
      idempotencyKey: `stage-atomic-${second.submissionId}`, requestId: `request_stage_atomic_${second.submissionId}`,
    }));
    await db.update(submissions).set({ version: secondStage.submissionVersion + 1 }).where(eq(submissions.id, second.submissionId));
    const releaseRequestId = `request_release_atomic_${first.submissionId}`;
    const failed = await runEitherAs(owner, releaseDecisions({
      eventId: fixtureEventId,
      decisions: [
        { submissionId: first.submissionId, expectedVersion: firstStage.submissionVersion, expectedDecision: "accepted" },
        { submissionId: second.submissionId, expectedVersion: secondStage.submissionVersion, expectedDecision: "rejected" },
      ],
      idempotencyKey: `release-atomic-${first.submissionId}`,
      requestId: releaseRequestId,
    }));
    expect(failed._tag).toBe("Left");
    if (failed._tag === "Left") expect(failed.left._tag).toBe("Conflict");
    await expect(db.select().from(submissions).where(eq(submissions.id, first.submissionId)))
      .resolves.toEqual([expect.objectContaining({ status: "submitted", pendingDecision: "accepted", version: firstStage.submissionVersion })]);
    await expect(db.select().from(acceptanceEvents).where(eq(acceptanceEvents.submissionId, first.submissionId))).resolves.toHaveLength(0);
    await expect(db.select().from(speakerProvisioning).where(eq(speakerProvisioning.submissionId, first.submissionId))).resolves.toHaveLength(0);
    await expect(db.select().from(domainChanges).where(eq(domainChanges.requestId, releaseRequestId))).resolves.toHaveLength(0);
    await expect(db.select().from(auditLog).where(eq(auditLog.requestId, releaseRequestId))).resolves.toHaveLength(0);
    await expect(db.select().from(idempotencyRecords).where(eq(idempotencyRecords.operationId, "review.releaseDecisions")))
      .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ responseBody: expect.objectContaining({ submissionIds: expect.arrayContaining([first.submissionId]) }) })]));
  });

  it("keeps a legacy accepted submission reviewable when its provisioning fact is missing", async () => {
    const { submissionId, version } = await seedTransitionSubmission("accepted", 2);
    const [association] = await db.select().from(submissionSpeakers).where(eq(submissionSpeakers.submissionId, submissionId));
    const acceptedAt = new Date(fixtureClock + transitionSubmissionSequence * 1_000);
    await db.insert(acceptanceEvents).values({
      id: `legacy-acceptance-${submissionId}`,
      eventId: fixtureEventId,
      submissionId,
      primarySubmissionSpeakerId: association!.id,
      primarySpeakerId: fixturePrimarySpeakerId,
      primaryAssociationIsPrimary: true,
      type: "accepted",
      submissionVersion: version,
      actorUserId: fixtureOwnerId,
      occurredAt: acceptedAt,
    });

    const workbench = await runAs(owner, getWorkbench({
      eventId: fixtureEventId,
      roundId: activeRoundFixture.id,
      selectedSubmissionId: submissionId,
      page: 1,
      pageSize: 100,
    }));

    expect(workbench.selected?.acceptance).toEqual({
      acceptanceEventId: `legacy-acceptance-${submissionId}`,
      submissionVersion: version,
      acceptedAt: acceptedAt.getTime(),
      provisioningId: null,
      provisioningStatus: "missing",
    });
  });

  it("undoes acceptance with append-only revocation evidence and revokes provisioning", async () => {
    const input = {
      eventId: fixtureEventId,
      submissionId: "submission_04",
      expectedVersion: 3,
      idempotencyKey: "revoke-submission-04",
      requestId: "request_revoke_04",
    } as const;
    const revoked = await runAs(owner, revokeAcceptance(input));
    const replayed = await runAs(owner, revokeAcceptance(input));

    expect(revoked).toMatchObject({
      submissionId: input.submissionId,
      submissionVersion: 4,
      status: "in_review",
      provisioningStatus: "revoked",
      idempotent: false,
    });
    expect(replayed).toEqual({ ...revoked, idempotent: true });

    const [submission] = await db.select().from(submissions).where(eq(submissions.id, input.submissionId));
    expect(submission).toMatchObject({ status: "in_review", version: 4, acceptedAt: null });
    const history = await db.select().from(acceptanceEvents).where(and(
      eq(acceptanceEvents.eventId, fixtureEventId),
      eq(acceptanceEvents.submissionId, input.submissionId),
    ));
    expect(history.map((event) => event.type).sort()).toEqual(["accepted", "revoked"]);
    expect(history.find((event) => event.type === "revoked")).toMatchObject({
      id: revoked.revocationEventId,
      submissionVersion: 4,
    });
    const [provisioning] = await db.select().from(speakerProvisioning).where(and(
      eq(speakerProvisioning.eventId, fixtureEventId),
      eq(speakerProvisioning.submissionId, input.submissionId),
    ));
    expect(provisioning).toMatchObject({ status: "revoked", version: 2 });
    const changes = await db.select().from(domainChanges).where(eq(domainChanges.requestId, input.requestId));
    expect(changes.map((change) => change.eventType).sort()).toEqual([
      "review.submission.acceptanceRevoked",
      "speaker.provisioning.revoked",
    ]);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.requestId, input.requestId));
    expect(audit).toMatchObject({ action: "review.revokeAcceptance" });
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

  it("does not enqueue outbound email when proposal status changes", async () => {
    const beforeSnapshots = await db.select().from(mailDeliverySnapshots);
    const beforeDeliveries = await db.select().from(mailDeliveries);

    await runAs(owner, acceptSubmission({
      eventId: fixtureEventId,
      submissionId: "submission_57",
      expectedVersion: 2,
      idempotencyKey: "accept-no-email-57",
      requestId: "request_accept_no_email_57",
    }));
    await runAs(owner, rejectSubmission({
      eventId: fixtureEventId,
      submissionId: "submission_56",
      expectedVersion: 2,
      idempotencyKey: "reject-no-email-56",
      requestId: "request_reject_no_email_56",
    }));

    expect(await db.select().from(mailDeliverySnapshots)).toHaveLength(beforeSnapshots.length);
    expect(await db.select().from(mailDeliveries)).toHaveLength(beforeDeliveries.length);
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

  it("declares a conflict of interest that recuses active assignments and blocks the pair until withdrawal", async () => {
    const eventId = "event_coi_lifecycle";
    const createdAt = new Date(fixtureClock);
    const devReviewer: Principal = {
      kind: "browser-session",
      userId: "user_reviewer_dev",
      email: "dev@example.com",
      name: "Dev Shah",
      sessionId: "session_dev",
      expiresAt: fixtureClock + 86_400_000,
    };
    await db.insert(events).values({
      id: eventId, slug: "coi-lifecycle", name: "COI lifecycle", timezone: "UTC", createdAt, updatedAt: createdAt,
    });
    await db.insert(eventMembers).values([
      { id: "member_coi_owner", eventId, userId: fixtureOwnerId, role: "owner", createdAt, updatedAt: createdAt },
      { id: "member_coi_ada", eventId, userId: fixtureReviewerId, role: "reviewer", createdAt, updatedAt: createdAt },
      { id: "member_coi_dev", eventId, userId: "user_reviewer_dev", role: "reviewer", createdAt, updatedAt: createdAt },
    ]);
    await db.insert(forms).values({
      id: "form_coi", eventId, kind: "cfp", name: "COI CFP", status: "closed", createdAt, updatedAt: createdAt,
    });
    await db.insert(formVersions).values({
      id: "form_version_coi", eventId, formId: "form_coi", versionNumber: 1, name: "COI CFP", publishedAt: createdAt, createdAt,
    });
    await db.insert(submissions).values([
      {
        id: "submission_coi_a", eventId, formId: "form_coi", formVersionId: "form_version_coi",
        title: "Colleague proposal", status: "submitted", submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
      },
      {
        id: "submission_coi_b", eventId, formId: "form_coi", formVersionId: "form_version_coi",
        title: "Unrelated proposal", status: "submitted", submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
      },
    ]);
    await db.insert(reviewRounds).values({
      id: "round_coi", eventId, name: "COI round", order: 1, status: "active",
      rubric: { criteria: [{ key: "clarity", label: "Clarity", max: 5 }] }, version: 1, createdAt, updatedAt: createdAt,
    });
    await db.insert(reviewAssignments).values({
      id: "assignment_coi_ada_a", eventId, roundId: "round_coi", submissionId: "submission_coi_a",
      reviewerUserId: fixtureReviewerId, createdAt, updatedAt: createdAt,
    });

    const declared = await runAs(reviewer, declareReviewConflict({
      eventId,
      submissionId: "submission_coi_a",
      reviewerUserId: fixtureReviewerId,
      reason: "The presenter is my direct teammate",
      idempotencyKey: "coi-declare-ada-a",
      requestId: "request_coi_declare_ada_a",
    }));
    expect(declared.created).toBe(true);
    expect(declared.idempotent).toBe(false);
    expect(declared.recusedAssignmentIds).toEqual(["assignment_coi_ada_a"]);
    expect(declared.conflict).toMatchObject({
      submissionId: "submission_coi_a",
      submissionTitle: "Colleague proposal",
      reviewerUserId: fixtureReviewerId,
      reviewerName: "Ada Rivera",
      reason: "The presenter is my direct teammate",
      status: "active",
      withdrawnAt: null,
      version: 1,
    });
    const [recused] = await db.select().from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, eventId),
      eq(reviewAssignments.id, "assignment_coi_ada_a"),
    ));
    expect(recused).toMatchObject({
      status: "recused",
      recusalReason: "The presenter is my direct teammate",
      version: 2,
    });
    const [declaredChange] = await db.select().from(domainChanges).where(eq(domainChanges.requestId, "request_coi_declare_ada_a"));
    expect(declaredChange).toMatchObject({ eventType: "review.conflict.declared", aggregateId: declared.conflict.id });

    const replayed = await runAs(reviewer, declareReviewConflict({
      eventId,
      submissionId: "submission_coi_a",
      reviewerUserId: fixtureReviewerId,
      reason: "The presenter is my direct teammate",
      idempotencyKey: "coi-declare-ada-a",
      requestId: "request_coi_declare_ada_a_retry",
    }));
    expect(replayed).toEqual({ ...declared, idempotent: true });

    const duplicate = await runAs(owner, declareReviewConflict({
      eventId,
      submissionId: "submission_coi_a",
      reviewerUserId: fixtureReviewerId,
      idempotencyKey: "coi-declare-ada-a-duplicate",
      requestId: "request_coi_declare_ada_a_duplicate",
    }));
    expect(duplicate.created).toBe(false);
    expect(duplicate.conflict.id).toBe(declared.conflict.id);
    expect(await db.select().from(reviewConflicts).where(eq(reviewConflicts.eventId, eventId))).toHaveLength(1);

    const blocked = await runEitherAs(owner, assignReviewer({
      eventId,
      roundId: "round_coi",
      submissionId: "submission_coi_a",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_coi_blocked_assign",
    }));
    expect(blocked._tag).toBe("Left");
    if (blocked._tag === "Left") expect(blocked.left._tag).toBe("Conflict");

    const bulk = await runAs(owner, bulkAssignReviewers({
      eventId,
      roundId: "round_coi",
      submissionIds: ["submission_coi_a", "submission_coi_b"] as const,
      reviewerUserIds: [fixtureReviewerId, "user_reviewer_dev"] as const,
      reviewsPerSubmission: 2,
      strategy: "all",
      idempotencyKey: "coi-bulk-assign",
      requestId: "request_coi_bulk_assign",
    }));
    expect(bulk).toEqual({
      createdCount: 3,
      existingCount: 0,
      assignmentCount: 3,
      conflictSkippedCount: 1,
      idempotent: false,
    });
    expect(await db.select().from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, eventId),
      eq(reviewAssignments.submissionId, "submission_coi_a"),
      eq(reviewAssignments.reviewerUserId, fixtureReviewerId),
      eq(reviewAssignments.status, "assigned"),
    ))).toHaveLength(0);

    const ownerList = await runAs(owner, listReviewConflicts({ eventId }));
    expect(ownerList.conflicts).toHaveLength(1);
    const adaList = await runAs(reviewer, listReviewConflicts({ eventId }));
    expect(adaList.conflicts.map((conflict) => conflict.id)).toEqual([declared.conflict.id]);
    const devList = await runAs(devReviewer, listReviewConflicts({ eventId }));
    expect(devList.conflicts).toHaveLength(0);

    const foreignWithdrawal = await runEitherAs(devReviewer, withdrawReviewConflict({
      eventId,
      conflictId: declared.conflict.id,
      expectedVersion: 1,
      idempotencyKey: "coi-withdraw-foreign",
      requestId: "request_coi_withdraw_foreign",
    }));
    expect(foreignWithdrawal._tag).toBe("Left");
    if (foreignWithdrawal._tag === "Left") expect(foreignWithdrawal.left._tag).toBe("Forbidden");

    const withdrawn = await runAs(reviewer, withdrawReviewConflict({
      eventId,
      conflictId: declared.conflict.id,
      expectedVersion: 1,
      idempotencyKey: "coi-withdraw-ada-a",
      requestId: "request_coi_withdraw_ada_a",
    }));
    expect(withdrawn.idempotent).toBe(false);
    expect(withdrawn.conflict).toMatchObject({ id: declared.conflict.id, status: "withdrawn", version: 2 });
    expect(withdrawn.conflict.withdrawnAt).not.toBeNull();
    const withdrawnReplay = await runAs(reviewer, withdrawReviewConflict({
      eventId,
      conflictId: declared.conflict.id,
      expectedVersion: 1,
      idempotencyKey: "coi-withdraw-ada-a",
      requestId: "request_coi_withdraw_ada_a_retry",
    }));
    expect(withdrawnReplay).toEqual({ ...withdrawn, idempotent: true });
    const staleWithdrawal = await runEitherAs(reviewer, withdrawReviewConflict({
      eventId,
      conflictId: declared.conflict.id,
      expectedVersion: 1,
      idempotencyKey: "coi-withdraw-ada-a-stale",
      requestId: "request_coi_withdraw_ada_a_stale",
    }));
    expect(staleWithdrawal._tag).toBe("Left");
    if (staleWithdrawal._tag === "Left") expect(staleWithdrawal.left._tag).toBe("Conflict");

    const reassigned = await runAs(owner, assignReviewer({
      eventId,
      roundId: "round_coi",
      submissionId: "submission_coi_a",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 0,
      requestId: "request_coi_reassign",
    }));
    expect(reassigned.created).toBe(true);
    expect(reassigned.assignment.status).toBe("assigned");
  });

  it("preserves completed reviews when an organizer declares a conflict on the committee's behalf", async () => {
    const eventId = "event_coi_preserve";
    const createdAt = new Date(fixtureClock);
    await db.insert(events).values({
      id: eventId, slug: "coi-preserve", name: "COI preserve", timezone: "UTC", createdAt, updatedAt: createdAt,
    });
    await db.insert(eventMembers).values([
      { id: "member_coi_preserve_owner", eventId, userId: fixtureOwnerId, role: "owner", createdAt, updatedAt: createdAt },
      { id: "member_coi_preserve_ada", eventId, userId: fixtureReviewerId, role: "reviewer", createdAt, updatedAt: createdAt },
    ]);
    await db.insert(forms).values({
      id: "form_coi_preserve", eventId, kind: "cfp", name: "COI preserve CFP", status: "closed", createdAt, updatedAt: createdAt,
    });
    await db.insert(formVersions).values({
      id: "form_version_coi_preserve", eventId, formId: "form_coi_preserve", versionNumber: 1,
      name: "COI preserve CFP", publishedAt: createdAt, createdAt,
    });
    await db.insert(submissions).values({
      id: "submission_coi_preserve", eventId, formId: "form_coi_preserve", formVersionId: "form_version_coi_preserve",
      title: "Scored proposal", status: "in_review", submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
    });
    await db.insert(reviewRounds).values({
      id: "round_coi_preserve", eventId, name: "COI preserve round", order: 1, status: "active",
      rubric: { criteria: [{ key: "clarity", label: "Clarity", max: 5 }] }, version: 1, createdAt, updatedAt: createdAt,
    });
    await db.insert(reviewAssignments).values({
      id: "assignment_coi_preserve", eventId, roundId: "round_coi_preserve", submissionId: "submission_coi_preserve",
      reviewerUserId: fixtureReviewerId, createdAt, updatedAt: createdAt,
    });
    await db.insert(reviews).values({
      id: "review_coi_preserve", eventId, roundId: "round_coi_preserve", submissionId: "submission_coi_preserve",
      reviewerUserId: fixtureReviewerId, ai: false, score: 4, scores: { clarity: 4 },
      comment: "Completed before the conflict surfaced", createdAt, updatedAt: createdAt,
    });

    const selfOnly = await runEitherAs(reviewer, declareReviewConflict({
      eventId,
      submissionId: "submission_coi_preserve",
      reviewerUserId: fixtureOwnerId,
      idempotencyKey: "coi-preserve-self-only",
      requestId: "request_coi_preserve_self_only",
    }));
    expect(selfOnly._tag).toBe("Left");
    if (selfOnly._tag === "Left") expect(selfOnly.left._tag).toBe("Forbidden");

    const nonMember = await runEitherAs(owner, declareReviewConflict({
      eventId,
      submissionId: "submission_coi_preserve",
      reviewerUserId: speakerOnly.userId,
      idempotencyKey: "coi-preserve-non-member",
      requestId: "request_coi_preserve_non_member",
    }));
    expect(nonMember._tag).toBe("Left");
    if (nonMember._tag === "Left") expect(nonMember.left._tag).toBe("Validation");

    const apiKeyDeclaration = await runEitherAs(reviewApiKey, declareReviewConflict({
      eventId: fixtureEventId,
      submissionId: "submission_05",
      reviewerUserId: fixtureReviewerId,
      idempotencyKey: "coi-preserve-api-key",
      requestId: "request_coi_preserve_api_key",
    }));
    expect(apiKeyDeclaration._tag).toBe("Left");
    if (apiKeyDeclaration._tag === "Left") expect(apiKeyDeclaration.left._tag).toBe("Forbidden");

    const declared = await runAs(owner, declareReviewConflict({
      eventId,
      submissionId: "submission_coi_preserve",
      reviewerUserId: fixtureReviewerId,
      reason: "Reported after scoring",
      idempotencyKey: "coi-preserve-declare",
      requestId: "request_coi_preserve_declare",
    }));
    expect(declared.created).toBe(true);
    expect(declared.recusedAssignmentIds).toEqual([]);
    const [assignment] = await db.select().from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, eventId),
      eq(reviewAssignments.id, "assignment_coi_preserve"),
    ));
    expect(assignment).toMatchObject({ status: "assigned", version: 1 });
    expect(await db.select().from(reviews).where(and(
      eq(reviews.eventId, eventId),
      eq(reviews.submissionId, "submission_coi_preserve"),
    ))).toHaveLength(1);

    const blocked = await runEitherAs(owner, assignReviewer({
      eventId,
      roundId: "round_coi_preserve",
      submissionId: "submission_coi_preserve",
      reviewerUserId: fixtureReviewerId,
      expectedVersion: 1,
      requestId: "request_coi_preserve_blocked",
    }));
    expect(blocked._tag).toBe("Left");
    if (blocked._tag === "Left") expect(blocked.left._tag).toBe("Conflict");

    const organizerWithdrawal = await runAs(owner, withdrawReviewConflict({
      eventId,
      conflictId: declared.conflict.id,
      expectedVersion: 1,
      idempotencyKey: "coi-preserve-withdraw",
      requestId: "request_coi_preserve_withdraw",
    }));
    expect(organizerWithdrawal.conflict.status).toBe("withdrawn");
  });

  it("routes auto-distribution around declared conflicts even without prior assignment history", async () => {
    const eventId = "event_coi_autodist";
    const createdAt = new Date(fixtureClock);
    await db.insert(events).values({
      id: eventId, slug: "coi-autodist", name: "COI auto-distribution", timezone: "UTC", createdAt, updatedAt: createdAt,
    });
    await db.insert(eventMembers).values([
      { id: "member_coi_autodist_owner", eventId, userId: fixtureOwnerId, role: "owner", createdAt, updatedAt: createdAt },
      { id: "member_coi_autodist_ada", eventId, userId: fixtureReviewerId, role: "reviewer", createdAt, updatedAt: createdAt },
      { id: "member_coi_autodist_dev", eventId, userId: "user_reviewer_dev", role: "reviewer", createdAt, updatedAt: createdAt },
    ]);
    await db.insert(forms).values({
      id: "form_coi_autodist", eventId, kind: "cfp", name: "COI autodist CFP", status: "closed", createdAt, updatedAt: createdAt,
    });
    await db.insert(formVersions).values({
      id: "form_version_coi_autodist", eventId, formId: "form_coi_autodist", versionNumber: 1,
      name: "COI autodist CFP", publishedAt: createdAt, createdAt,
    });
    await db.insert(submissions).values({
      id: "submission_coi_autodist", eventId, formId: "form_coi_autodist", formVersionId: "form_version_coi_autodist",
      title: "Conflicted proposal", status: "submitted", submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
    });
    await db.insert(reviewRounds).values({
      id: "round_coi_autodist", eventId, name: "COI autodist round", order: 1, status: "active",
      rubric: { criteria: [{ key: "clarity", label: "Clarity", max: 5 }] }, version: 1, createdAt, updatedAt: createdAt,
    });
    await db.insert(reviewConflicts).values({
      id: "conflict_coi_autodist", eventId, submissionId: "submission_coi_autodist",
      reviewerUserId: fixtureReviewerId, status: "active", version: 1, createdAt, updatedAt: createdAt,
    });

    const distributed = await runAs(owner, autoDistributeReviewers({
      eventId,
      roundId: "round_coi_autodist",
      reviewsPerSubmission: 2,
      idempotencyKey: "coi-autodist-001",
      requestId: "request_coi_autodist",
    }));
    expect(distributed).toMatchObject({
      createdCount: 1,
      satisfiedCount: 0,
      unfilled: [{ submissionId: "submission_coi_autodist", missing: 1 }],
    });
    const assignments = await db.select({ reviewerUserId: reviewAssignments.reviewerUserId })
      .from(reviewAssignments).where(and(
        eq(reviewAssignments.eventId, eventId),
        eq(reviewAssignments.submissionId, "submission_coi_autodist"),
      ));
    expect(assignments).toEqual([{ reviewerUserId: "user_reviewer_dev" }]);
  });
});

describe("deterministic reviewer auto-distribution", () => {
  it("tops up coverage with load balancing, caps, and standing recusal exclusion", async () => {
    const createdAt = new Date();
    const eventId = "autodist-event";
    const roundId = "autodist-round";
    const reviewers = ["autodist-rev-a", "autodist-rev-b", "autodist-rev-c"] as const;
    await db.insert(users).values(reviewers.map((userId) => ({
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
      createdAt,
      updatedAt: createdAt,
    }))).onConflictDoNothing();
    await db.insert(events).values({
      id: eventId, slug: eventId, name: "Auto distribution", createdAt, updatedAt: createdAt,
    });
    await db.insert(eventMembers).values([
      { id: "autodist-member-owner", eventId, userId: owner.userId, role: "owner", createdAt, updatedAt: createdAt },
      ...reviewers.map((userId) => ({
        id: `autodist-member-${userId}`, eventId, userId, role: "reviewer" as const, createdAt, updatedAt: createdAt,
      })),
    ]);
    await db.insert(forms).values({
      id: "autodist-form", eventId, kind: "cfp", name: "Auto CFP", status: "closed", createdAt, updatedAt: createdAt,
    });
    await db.insert(formVersions).values({
      id: "autodist-form-v1", eventId, formId: "autodist-form", versionNumber: 1,
      name: "Auto CFP", publishedAt: createdAt, createdAt,
    });
    await db.insert(reviewRounds).values({
      id: roundId, eventId, name: "Auto round", order: 1, status: "active",
      startsAt: createdAt, endsAt: new Date(createdAt.getTime() + 86_400_000),
      blind: false, rubric: activeRoundFixture.rubric, version: 1, createdAt, updatedAt: createdAt,
    });
    const submissionIds = ["autodist-sub-1", "autodist-sub-2", "autodist-sub-3", "autodist-sub-4"];
    await db.insert(submissions).values([
      ...submissionIds.map((id) => ({
        id, eventId, formId: "autodist-form", formVersionId: "autodist-form-v1",
        title: id, status: "submitted" as const, submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
      })),
      {
        id: "autodist-sub-accepted", eventId, formId: "autodist-form", formVersionId: "autodist-form-v1",
        title: "Accepted stays out", status: "accepted" as const, submittedAt: createdAt,
        acceptedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
      },
    ]);
    await db.insert(reviewAssignments).values([
      {
        id: "autodist-existing", eventId, roundId, submissionId: "autodist-sub-1",
        reviewerUserId: "autodist-rev-a", createdAt, updatedAt: createdAt,
      },
      {
        id: "autodist-recused", eventId, roundId, submissionId: "autodist-sub-1",
        reviewerUserId: "autodist-rev-b", status: "recused", recusalReason: "Same employer",
        recusedAt: createdAt, createdAt, updatedAt: createdAt,
      },
    ]);

    const input = {
      eventId,
      roundId,
      reviewsPerSubmission: 2,
      perReviewerCap: 4,
      idempotencyKey: "autodist-command-001",
      requestId: "request-autodist-001",
    } as const;
    const result = await runAs(owner, autoDistributeReviewers(input));
    expect(result).toMatchObject({
      roundId,
      createdCount: 7,
      satisfiedCount: 4,
      unfilled: [],
      idempotent: false,
    });
    expect(result.perReviewerLoad).toEqual([
      { reviewerUserId: "autodist-rev-a", assignedCount: 3 },
      { reviewerUserId: "autodist-rev-b", assignedCount: 2 },
      { reviewerUserId: "autodist-rev-c", assignedCount: 3 },
    ]);

    const rows = await db.select().from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, eventId),
      eq(reviewAssignments.roundId, roundId),
    ));
    expect(rows.filter((row) => row.status === "assigned")).toHaveLength(8);
    // The recused pair is never recreated; the remaining slot went to rev-c.
    const subOne = rows.filter((row) => row.submissionId === "autodist-sub-1");
    expect(subOne.filter((row) => row.status === "assigned").map((row) => row.reviewerUserId).sort())
      .toEqual(["autodist-rev-a", "autodist-rev-c"]);
    expect(rows.filter((row) => row.submissionId === "autodist-sub-accepted")).toHaveLength(0);

    const replay = await runAs(owner, autoDistributeReviewers(input));
    expect(replay).toMatchObject({ createdCount: 7, idempotent: true });

    const conflicting = await runEitherAs(owner, autoDistributeReviewers({
      ...input,
      reviewsPerSubmission: 3,
    }));
    expect(conflicting._tag).toBe("Left");
    if (Either.isLeft(conflicting)) expect(conflicting.left._tag).toBe("Conflict");

    const secondPass = await runAs(owner, autoDistributeReviewers({
      ...input,
      idempotencyKey: "autodist-command-002",
      requestId: "request-autodist-002",
    }));
    expect(secondPass).toMatchObject({ createdCount: 0, satisfiedCount: 4, idempotent: false });
  });

  it("reports unfilled coverage when the cap starves the pool", async () => {
    const createdAt = new Date();
    const eventId = "autodist-cap-event";
    const roundId = "autodist-cap-round";
    await db.insert(users).values({
      id: "autodist-rev-solo", email: "autodist-rev-solo@example.com", name: "Solo",
      createdAt, updatedAt: createdAt,
    }).onConflictDoNothing();
    await db.insert(events).values({
      id: eventId, slug: eventId, name: "Cap starvation", createdAt, updatedAt: createdAt,
    });
    await db.insert(eventMembers).values([
      { id: "autodist-cap-owner", eventId, userId: owner.userId, role: "owner", createdAt, updatedAt: createdAt },
      { id: "autodist-cap-solo", eventId, userId: "autodist-rev-solo", role: "reviewer", createdAt, updatedAt: createdAt },
    ]);
    await db.insert(forms).values({
      id: "autodist-cap-form", eventId, kind: "cfp", name: "Cap CFP", status: "closed", createdAt, updatedAt: createdAt,
    });
    await db.insert(formVersions).values({
      id: "autodist-cap-form-v1", eventId, formId: "autodist-cap-form", versionNumber: 1,
      name: "Cap CFP", publishedAt: createdAt, createdAt,
    });
    await db.insert(reviewRounds).values({
      id: roundId, eventId, name: "Cap round", order: 1, status: "active",
      startsAt: createdAt, endsAt: new Date(createdAt.getTime() + 86_400_000),
      blind: false, rubric: activeRoundFixture.rubric, version: 1, createdAt, updatedAt: createdAt,
    });
    await db.insert(submissions).values(["autodist-cap-sub-1", "autodist-cap-sub-2"].map((id) => ({
      id, eventId, formId: "autodist-cap-form", formVersionId: "autodist-cap-form-v1",
      title: id, status: "submitted" as const, submittedAt: createdAt, version: 1, createdAt, updatedAt: createdAt,
    })));

    const starved = await runAs(owner, autoDistributeReviewers({
      eventId,
      roundId,
      reviewsPerSubmission: 1,
      perReviewerCap: 1,
      idempotencyKey: "autodist-cap-command-001",
      requestId: "request-autodist-cap-001",
    }));
    expect(starved).toMatchObject({ createdCount: 1, satisfiedCount: 1 });
    expect(starved.unfilled).toEqual([{ submissionId: "autodist-cap-sub-2", missing: 1 }]);
    expect(starved.perReviewerLoad).toEqual([{ reviewerUserId: "autodist-rev-solo", assignedCount: 1 }]);

    const impossible = await runEitherAs(owner, autoDistributeReviewers({
      eventId,
      roundId,
      reviewsPerSubmission: 2,
      idempotencyKey: "autodist-cap-command-002",
      requestId: "request-autodist-cap-002",
    }));
    expect(impossible._tag).toBe("Left");
    if (Either.isLeft(impossible)) expect(impossible.left._tag).toBe("Validation");
  });
});
