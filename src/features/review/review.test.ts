import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import {
  acceptanceEvents,
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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { beforeAll, describe, expect, it } from "vitest";
import { AiService, CurrentUser, Db, type CurrentUserValue } from "@/server/services";
import {
  activeRoundFixture,
  completedRoundFixture,
  pendingRoundFixture,
  contentionFixture,
  emptyReviewFixture,
  fixtureClock,
  fixtureEventId,
  fixtureOwnerId,
  fixturePrimarySpeakerId,
  fixtureReviewerId,
  submissionQueueFixture,
  reviewWorkbenchFixture,
} from "./fixtures";
import { operations } from "./operations";
import ReviewWorkbenchRoute from "./routes/review-workbench";
import { SaveScoreInput } from "./schema";
import {
  acceptSubmission,
  assignReviewer,
  getWorkbench,
  requestAiSuggestion,
  saveScore,
} from "./service";

type TestEnv = Cloudflare.Env & { readonly TEST_MIGRATIONS: readonly D1Migration[] };

function hasTestMigrations(value: Cloudflare.Env): value is TestEnv {
  return "TEST_MIGRATIONS" in value;
}

const owner: CurrentUserValue = {
  kind: "browser-session",
  userId: fixtureOwnerId,
  email: "morgan@example.com",
  name: "Morgan Chen",
  sessionId: "session_owner",
  expiresAt: fixtureClock + 86_400_000,
};

const reviewer: CurrentUserValue = {
  kind: "browser-session",
  userId: fixtureReviewerId,
  email: "ada@example.com",
  name: "Ada Rivera",
  sessionId: "session_reviewer",
  expiresAt: fixtureClock + 86_400_000,
};

const speakerOnly: CurrentUserValue = {
  kind: "browser-session",
  userId: "user_speaker_only",
  email: "speaker@example.com",
  name: "Speaker Only",
  sessionId: "session_speaker",
  expiresAt: fixtureClock + 86_400_000,
};

const reviewApiKey: CurrentUserValue = {
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

const runAs = <A, E, R>(principal: CurrentUserValue, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.mergeAll(dbLayer, aiLayer, Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<A, E, never>,
  );

const runEitherAs = <A, E, R>(principal: CurrentUserValue, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.either,
      Effect.provide(Layer.mergeAll(dbLayer, aiLayer, Layer.succeed(CurrentUser, principal))),
    ) as Effect.Effect<Either.Either<A, E>, never, never>,
  );

/**
 * BaselineGreen has not yet replaced the prototype migration. The focused
 * fixture upgrades only its ephemeral test database to the frozen table shape.
 */
const applyFrozenReviewFixtureSchema = async () => {
  const statements = [
    "alter table users add column version integer not null default 1",
    "alter table events add column version integer not null default 1",
    "alter table event_members add column version integer not null default 1",
    "alter table forms add column version integer not null default 1",
    "alter table speakers add column version integer not null default 1",
    "alter table submissions add column form_version_id text not null default 'form_version_01'",
    "alter table submissions add column accepted_at integer",
    "alter table submissions add column version integer not null default 1",
    "alter table review_rounds add column version integer not null default 1",
    `alter table review_assignments add column event_id text not null default '${fixtureEventId}'`,
    "alter table review_assignments add column version integer not null default 1",
    `alter table reviews add column event_id text not null default '${fixtureEventId}'`,
    "alter table reviews add column version integer not null default 1",
    `alter table submission_speakers add column event_id text not null default '${fixtureEventId}'`,
    "alter table submission_speakers add column created_at integer not null default 0",
    "drop index submission_answers_submission",
    "drop table submission_answers",
    `create table form_versions (
      id text primary key not null,
      event_id text not null,
      form_id text not null,
      version_number integer not null,
      name text not null,
      description text,
      published_at integer not null,
      retired_at integer,
      created_at integer not null
    )`,
    `create table form_version_fields (
      id text primary key not null,
      event_id text not null,
      form_version_id text not null,
      source_field_id text,
      "order" integer not null,
      type text not null,
      label text not null,
      help_text text,
      required integer not null,
      options text,
      logic text,
      routing text,
      created_at integer not null
    )`,
    `create table submission_answers (
      id text primary key not null,
      event_id text not null,
      submission_id text not null,
      form_version_field_id text not null,
      value text not null,
      version integer not null default 1,
      created_at integer not null,
      updated_at integer not null
    )`,
    "create index submission_answers_submission on submission_answers(event_id, submission_id)",
    `create table acceptance_events (
      id text primary key not null,
      event_id text not null,
      submission_id text not null,
      primary_speaker_id text not null,
      type text not null,
      submission_version integer not null,
      actor_user_id text,
      occurred_at integer not null
    )`,
    "create unique index acceptance_events_submission_version_unique on acceptance_events(event_id, submission_id, submission_version)",
    `create table speaker_provisioning (
      id text primary key not null,
      event_id text not null,
      acceptance_event_id text not null,
      submission_id text not null,
      primary_speaker_id text not null,
      status text not null default 'pending',
      available_at integer not null,
      lease_owner text,
      lease_expires_at integer,
      attempt_count integer not null default 0,
      last_error text,
      provisioned_at integer,
      version integer not null default 1,
      created_at integer not null,
      updated_at integer not null,
      foreign key (acceptance_event_id) references acceptance_events(id)
    )`,
    "create unique index speaker_provisioning_acceptance_unique on speaker_provisioning(event_id, acceptance_event_id)",
    `create table idempotency_records (
      id text primary key not null,
      event_id text not null,
      operation_id text not null,
      principal_id text not null,
      key_hash text not null,
      request_hash text not null,
      status text not null default 'in_progress',
      response_status integer,
      response_body text,
      expires_at integer not null,
      completed_at integer,
      created_at integer not null
    )`,
    "create unique index idempotency_key_unique on idempotency_records(event_id, operation_id, principal_id, key_hash)",
    `create table domain_changes (
      sequence integer primary key autoincrement,
      id text not null unique,
      event_id text not null,
      aggregate_type text not null,
      aggregate_id text not null,
      aggregate_version integer not null,
      event_type text not null,
      audiences text not null,
      payload text not null,
      actor_user_id text,
      actor_api_key_id text,
      request_id text not null,
      idempotency_record_id text,
      occurred_at integer not null
    )`,
    "create unique index domain_changes_aggregate_version_unique on domain_changes(event_id, aggregate_type, aggregate_id, aggregate_version, event_type)",
    `create table audit_log (
      id text primary key not null,
      event_id text not null,
      request_id text not null,
      actor_user_id text,
      actor_api_key_id text,
      action text not null,
      resource_type text not null,
      resource_id text not null,
      before text,
      after text,
      metadata text,
      occurred_at integer not null
    )`,
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
};


beforeAll(async () => {
  if (!hasTestMigrations(env)) throw new Error("TEST_MIGRATIONS test binding is unavailable");
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
  await applyFrozenReviewFixtureSchema();

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
  await db.insert(forms).values({
    id: "form_cfp", eventId: fixtureEventId, kind: "cfp", name: "Main CFP", status: "closed", createdAt, updatedAt: createdAt,
  });
  await db.insert(formVersions).values({
    id: "form_version_01", eventId: fixtureEventId, formId: "form_cfp", versionNumber: 1,
    name: "Main CFP", publishedAt: createdAt, createdAt,
  });
  await db.insert(formVersionFields).values({
    id: "field_abstract", eventId: fixtureEventId, formVersionId: "form_version_01", order: 1,
    type: "textarea", label: "Abstract", required: true, createdAt,
  });
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
  const answerSeeds = submissionQueueFixture.map((submission, index) => ({
    id: `answer_${String(index + 1).padStart(2, "0")}`,
    eventId: fixtureEventId,
    submissionId: submission.id,
    formVersionFieldId: "field_abstract",
    value: `Abstract evidence for ${submission.title}.`,
    createdAt,
    updatedAt: createdAt,
  }));
  for (const seed of answerSeeds) await db.insert(submissionAnswers).values(seed);
  const speakerLinkSeeds = submissionQueueFixture.map((submission, index) => ({
    id: `submission_speaker_${String(index + 1).padStart(2, "0")}`,
    eventId: fixtureEventId,
    submissionId: submission.id,
    speakerId: fixturePrimarySpeakerId,
    isPrimary: true,
    createdAt,
  }));
  for (const seed of speakerLinkSeeds) await db.insert(submissionSpeakers).values(seed);
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
      "review.assignReviewer",
      "review.getWorkbench",
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
    const aiAuthorization = operations[3].authorize;
    expect(aiAuthorization.kind).toBe("event");
    if (aiAuthorization.kind === "event") {
      expect(aiAuthorization.apiKey).toEqual({ kind: "api-key", scopes: ["reviews:write"] });
    }
    const scoreAuthorization = operations[4].authorize;
    expect(scoreAuthorization.kind).toBe("event");
    if (scoreAuthorization.kind === "event") expect(scoreAuthorization.apiKey.kind).toBe("deny");
  });

  it("renders organizer evidence read-only and distinguishes a truly empty round", () => {
    const organizerMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute));
    expect(organizerMarkup).toContain("Ada Rivera · read-only evidence");
    expect(organizerMarkup).not.toContain("Save my review");
    expect(organizerMarkup).not.toContain(">Round</label>");

    const reviewerMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute, {
      snapshot: { ...reviewWorkbenchFixture, viewerRole: "reviewer" },
    }));
    expect(reviewerMarkup).toContain("Save my review");

    const emptyMarkup = renderToStaticMarkup(createElement(ReviewWorkbenchRoute, {
      snapshot: emptyReviewFixture,
    }));
    expect(emptyMarkup).toContain("No submissions in this round");
    expect(emptyMarkup).not.toContain("Clear filters");
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
    const idempotency = await db.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.eventId, fixtureEventId), eq(idempotencyRecords.operationId, "review.acceptSubmission")));
    expect(durableAcceptance).toHaveLength(1);
    expect(provisioning).toHaveLength(1);
    expect(provisioning[0]).toMatchObject({ acceptanceEventId: durableAcceptance[0]!.id, primarySpeakerId: fixturePrimarySpeakerId, status: "pending" });
    expect(changes.map((change) => change.eventType).sort()).toEqual(["review.submission.accepted", "speaker.provisioning.requested"]);
    expect(audits).toHaveLength(1);
    expect(idempotency).toHaveLength(1);
    expect(idempotency[0]?.status).toBe("completed");
  });
});
