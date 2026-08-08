import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import {
  acceptanceEvents,
  auditLog,
  domainChanges,
  eventMembers,
  events,
  formVersionFields,
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
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { AiService, CurrentUser, Db } from "@/server/services";
import {
  AcceptSubmissionOutput,
  type AcceptSubmissionInput,
  type AssignReviewerInput,
  type AssignReviewerOutput,
  type CriterionScore,
  type GetWorkbenchInput,
  type HumanReview,
  type RequestAiSuggestionInput,
  type RequestAiSuggestionOutput,
  ReviewRubric,
  type ReviewRubric as ReviewRubricType,
  type ReviewRound,
  type ReviewWorkbench,
  type SaveScoreInput,
  type SaveScoreOutput,
  type SubmissionReviewDetail,
  type SubmissionReviewSummary,
} from "./schema";

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new External({
        service: "database",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const now = () => new Date();
const id = (prefix: string) => `${prefix}_${nanoid()}`;
const toMillis = (value: Date | number) => value instanceof Date ? value.getTime() : value;

const AiResponse = Schema.Struct({
  scores: Schema.Record({
    key: Schema.String.pipe(Schema.minLength(1)),
    value: Schema.Int.pipe(Schema.between(1, 5)),
  }),
  comment: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(5_000)),
});

type Viewer = {
  readonly role: "owner" | "admin" | "reviewer";
  readonly userId: string;
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
};

const hasScopes = (granted: readonly string[], required: readonly string[]) =>
  required.every((scope) => granted.some((candidate) => candidate === scope));

const requireEventAccess = (
  eventId: string,
  requiredScopes: readonly string[],
): Effect.Effect<Viewer, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    if (principal.kind === "api-key") {
      if (principal.eventId !== eventId || !hasScopes(principal.scopes, requiredScopes)) {
        return yield* Effect.fail(new Forbidden({ reason: "API key is not authorized for this event operation" }));
      }
      return {
        role: "admin" as const,
        userId: principal.userId,
        actorUserId: null,
        actorApiKeyId: principal.apiKeyId,
      };
    }

    const { db } = yield* Db;
    const [membership] = yield* database(() =>
      db
        .select({ role: eventMembers.role })
        .from(eventMembers)
        .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, principal.userId)))
        .limit(1),
    );
    if (!membership) {
      return yield* Effect.fail(new Forbidden({ reason: "Event membership required" }));
    }
    return {
      role: membership.role,
      userId: principal.userId,
      actorUserId: principal.userId,
      actorApiKeyId: null,
    };
  });

const requireOrganizer = (viewer: Viewer): Effect.Effect<void, Forbidden> =>
  viewer.role === "reviewer"
    ? Effect.fail(new Forbidden({ reason: "Owner or admin role required" }))
    : Effect.void;

const decodeRubric = (value: unknown): Effect.Effect<ReviewRubricType, External> =>
  Schema.decodeUnknown(ReviewRubric)(value).pipe(
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid review rubric: ${String(error)}` })),
  );

const loadRound = (eventId: string, roundId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [round] = yield* database(() =>
      db
        .select()
        .from(reviewRounds)
        .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.id, roundId)))
        .limit(1),
    );
    if (!round) return yield* Effect.fail(new NotFound({ entity: "reviewRound", id: roundId }));
    const rubric = yield* decodeRubric(round.rubric);
    return {
      id: round.id,
      name: round.name,
      order: round.order,
      status: round.status,
      rubric,
      version: round.version,
    } satisfies ReviewRound;
  });

const validateScores = (
  rubric: ReviewRubricType,
  scores: readonly CriterionScore[],
): Effect.Effect<Readonly<Record<string, number>>, Validation> => {
  const expected = new Set(rubric.criteria.map((criterion) => criterion.key));
  const result: Record<string, number> = {};
  for (const entry of scores) {
    if (!expected.has(entry.criterionKey)) {
      return Effect.fail(new Validation({ message: `Unknown rubric criterion '${entry.criterionKey}'` }));
    }
    if (result[entry.criterionKey] !== undefined) {
      return Effect.fail(new Validation({ message: `Rubric criterion '${entry.criterionKey}' was scored more than once` }));
    }
    if (!Number.isInteger(entry.score) || entry.score < 1 || entry.score > 5) {
      return Effect.fail(new Validation({ message: "Rubric scores must be whole numbers from 1 to 5" }));
    }
    result[entry.criterionKey] = entry.score;
  }
  if (Object.keys(result).length !== expected.size) {
    return Effect.fail(new Validation({ message: "Every rubric criterion requires a score" }));
  }
  return Effect.succeed(result);
};

const averageScore = (scores: Readonly<Record<string, number>>) => {
  const values = Object.values(scores);
  return values.reduce((total, value) => total + value, 0) / values.length;
};

const orderedScores = (
  rubric: ReviewRubricType,
  scores: Readonly<Record<string, number>> | null,
): readonly CriterionScore[] =>
  rubric.criteria.flatMap((criterion) => {
    const score = scores?.[criterion.key];
    return typeof score === "number" && score >= 1 && score <= 5
      ? [{ criterionKey: criterion.key, score: score as CriterionScore["score"] }]
      : [];
  });

const reviewerCanSeeSubmission = (
  eventId: string,
  roundId: string,
  submissionId: string,
  reviewerUserId: string,
) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [assignment] = yield* database(() =>
      db
        .select({ id: reviewAssignments.id })
        .from(reviewAssignments)
        .where(
          and(
            eq(reviewAssignments.eventId, eventId),
            eq(reviewAssignments.roundId, roundId),
            eq(reviewAssignments.submissionId, submissionId),
            eq(reviewAssignments.reviewerUserId, reviewerUserId),
          ),
        )
        .limit(1),
    );
    if (!assignment) {
      return yield* Effect.fail(new Forbidden({ reason: "Reviewers may access assigned submissions only" }));
    }
  });

const loadAcceptance = (eventId: string, submissionId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const history = yield* database(() =>
      db
        .select()
        .from(acceptanceEvents)
        .where(and(eq(acceptanceEvents.eventId, eventId), eq(acceptanceEvents.submissionId, submissionId)))
        .orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id)),
    );
    const latest = history[0];
    if (!latest || latest.type !== "accepted") return null;
    const [provisioning] = yield* database(() =>
      db
        .select()
        .from(speakerProvisioning)
        .where(
          and(
            eq(speakerProvisioning.eventId, eventId),
            eq(speakerProvisioning.acceptanceEventId, latest.id),
          ),
        )
        .limit(1),
    );
    if (!provisioning) {
      return yield* Effect.fail(
        new External({ service: "database", detail: `Acceptance '${latest.id}' has no provisioning fact` }),
      );
    }
    return {
      acceptanceEventId: latest.id,
      submissionVersion: latest.submissionVersion,
      acceptedAt: toMillis(latest.occurredAt),
      provisioningId: provisioning.id,
      provisioningStatus: provisioning.status,
    } as const;
  });

export const getWorkbench = (
  input: GetWorkbenchInput,
): Effect.Effect<ReviewWorkbench, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:read"]);
    const { db } = yield* Db;
    const [event] = yield* database(() =>
      db.select({ id: events.id, name: events.name, timezone: events.timezone, updatedAt: events.updatedAt })
        .from(events)
        .where(eq(events.id, input.eventId))
        .limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventId }));

    const roundRows = yield* database(() =>
      db.select().from(reviewRounds).where(eq(reviewRounds.eventId, input.eventId)).orderBy(asc(reviewRounds.order)),
    );
    const rounds: ReviewRound[] = [];
    for (const row of roundRows) {
      rounds.push({
        id: row.id,
        name: row.name,
        order: row.order,
        status: row.status,
        rubric: yield* decodeRubric(row.rubric),
        version: row.version,
      });
    }
    const selectedRound = input.roundId
      ? rounds.find((round) => round.id === input.roundId)
      : rounds.find((round) => round.status === "active") ?? rounds[0];
    if (input.roundId && !selectedRound) {
      return yield* Effect.fail(new NotFound({ entity: "reviewRound", id: input.roundId }));
    }

    const assignmentRows = yield* database(() =>
      db
        .select({
          id: reviewAssignments.id,
          roundId: reviewAssignments.roundId,
          submissionId: reviewAssignments.submissionId,
          reviewerUserId: reviewAssignments.reviewerUserId,
          version: reviewAssignments.version,
          reviewerName: users.name,
        })
        .from(reviewAssignments)
        .innerJoin(users, eq(users.id, reviewAssignments.reviewerUserId))
        .where(eq(reviewAssignments.eventId, input.eventId)),
    );
    const relevantRoundId = selectedRound?.id;
    const visibleAssignments = viewer.role === "reviewer"
      ? assignmentRows.filter((assignment) => assignment.reviewerUserId === viewer.userId)
      : assignmentRows;
    const reviewerSubmissionIds = new Set(
      assignmentRows
        .filter(
          (assignment) =>
            assignment.reviewerUserId === viewer.userId &&
            (!relevantRoundId || assignment.roundId === relevantRoundId),
        )
        .map((assignment) => assignment.submissionId),
    );

    let submissionRows = yield* database(() =>
      db.select().from(submissions).where(eq(submissions.eventId, input.eventId)).orderBy(desc(submissions.submittedAt)),
    );
    if (viewer.role === "reviewer") {
      submissionRows = submissionRows.filter((submission) => reviewerSubmissionIds.has(submission.id));
    }
    if (input.assignedToMe) {
      submissionRows = submissionRows.filter((submission) => reviewerSubmissionIds.has(submission.id));
    }
    if (input.status) submissionRows = submissionRows.filter((submission) => submission.status === input.status);
    if (input.category) submissionRows = submissionRows.filter((submission) => submission.category === input.category);

    const reviewRows = yield* database(() =>
      db.select().from(reviews).where(eq(reviews.eventId, input.eventId)),
    );
    const visibleHumanReviews = reviewRows.filter(
      (review) => !review.ai && (viewer.role !== "reviewer" || review.reviewerUserId === viewer.userId),
    );
    const summaries = submissionRows.map((submission): SubmissionReviewSummary => {
      const assignments = visibleAssignments.filter(
        (assignment) => assignment.submissionId === submission.id && (!relevantRoundId || assignment.roundId === relevantRoundId),
      );
      const humanReviews = visibleHumanReviews.filter(
        (review) => review.submissionId === submission.id && (!relevantRoundId || review.roundId === relevantRoundId),
      );
      const score = humanReviews.length === 0
        ? null
        : humanReviews.reduce((total, review) => total + review.score, 0) / humanReviews.length;
      const reviewState = assignments.length === 0
        ? "unassigned"
        : humanReviews.length >= assignments.length
          ? "complete"
          : humanReviews.length > 0
            ? "in_progress"
            : "assigned";
      return {
        id: submission.id,
        title: submission.title,
        category: submission.category,
        status: submission.status,
        submittedAt: toMillis(submission.submittedAt),
        version: submission.version,
        reviewState,
        assignmentCount: assignments.length,
        completedReviewCount: humanReviews.length,
        averageScore: score,
      };
    });

    const total = summaries.length;
    const start = (input.page - 1) * input.pageSize;
    const queue = summaries.slice(start, start + input.pageSize);
    const requestedId = input.selectedSubmissionId ?? queue[0]?.id;
    const selectedSummary = requestedId ? summaries.find((summary) => summary.id === requestedId) : undefined;
    if (input.selectedSubmissionId && !selectedSummary) {
      if (viewer.role === "reviewer") {
        return yield* Effect.fail(new Forbidden({ reason: "Reviewers may access assigned submissions only" }));
      }
      return yield* Effect.fail(new NotFound({ entity: "submission", id: input.selectedSubmissionId }));
    }

    let selected: SubmissionReviewDetail | null = null;
    if (selectedSummary) {
      const submissionId = selectedSummary.id;
      const [answerRows, speakerRows] = yield* Effect.all([
        database(() =>
          db
            .select({ value: submissionAnswers.value, label: formVersionFields.label })
            .from(submissionAnswers)
            .innerJoin(formVersionFields, eq(formVersionFields.id, submissionAnswers.formVersionFieldId))
            .where(
              and(
                eq(submissionAnswers.eventId, input.eventId),
                eq(submissionAnswers.submissionId, submissionId),
              ),
            )
            .orderBy(asc(formVersionFields.order)),
        ),
        database(() =>
          db
            .select({ id: speakers.id, displayName: speakers.displayName, isPrimary: submissionSpeakers.isPrimary })
            .from(submissionSpeakers)
            .innerJoin(speakers, eq(speakers.id, submissionSpeakers.speakerId))
            .where(
              and(
                eq(submissionSpeakers.eventId, input.eventId),
                eq(submissionSpeakers.submissionId, submissionId),
              ),
            )
            .orderBy(desc(submissionSpeakers.isPrimary), asc(speakers.displayName)),
        ),
      ]);
      const abstract = answerRows.find(
        (answer) => answer.label.trim().toLocaleLowerCase() === "abstract" && typeof answer.value === "string",
      )?.value;
      const detailAssignments = visibleAssignments
        .filter((assignment) => assignment.submissionId === submissionId && (!relevantRoundId || assignment.roundId === relevantRoundId))
        .map((assignment) => ({
          id: assignment.id,
          reviewerUserId: assignment.reviewerUserId,
          reviewerName: assignment.reviewerName,
          version: assignment.version,
        }));
      const detailHumanReviews: HumanReview[] = visibleHumanReviews
        .filter((review) => review.submissionId === submissionId && (!relevantRoundId || review.roundId === relevantRoundId))
        .map((review) => ({
          id: review.id,
          reviewerUserId: review.reviewerUserId!,
          reviewerName: assignmentRows.find((assignment) => assignment.reviewerUserId === review.reviewerUserId)?.reviewerName ?? "Reviewer",
          score: review.score,
          scores: selectedRound ? orderedScores(selectedRound.rubric, review.scores) : [],
          comment: review.comment,
          version: review.version,
          updatedAt: toMillis(review.updatedAt),
        }));
      const aiSuggestions = reviewRows
        .filter((review) => review.ai && review.submissionId === submissionId && (!relevantRoundId || review.roundId === relevantRoundId))
        .map((review) => ({
          id: review.id,
          label: "AI suggestion — requires human confirmation" as const,
          score: review.score,
          scores: selectedRound ? orderedScores(selectedRound.rubric, review.scores) : [],
          comment: review.comment ?? "",
          version: review.version,
          createdAt: toMillis(review.createdAt),
          inputFields: ["title", "abstract", "rubric"] as const,
        }));
      selected = {
        ...selectedSummary,
        abstract: typeof abstract === "string" ? abstract : "",
        speakers: speakerRows,
        round: selectedRound ?? null,
        assignments: detailAssignments,
        reviews: detailHumanReviews,
        aiSuggestions,
        acceptance: yield* loadAcceptance(input.eventId, submissionId),
      };
    }

    return {
      eventId: event.id,
      eventName: event.name,
      timezone: event.timezone,
      viewerRole: viewer.role,
      rounds,
      queue,
      selected,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total,
        pageCount: total === 0 ? 0 : Math.ceil(total / input.pageSize),
      },
      lastUpdatedAt: toMillis(event.updatedAt),
    };
  });

export const assignReviewer = (
  input: AssignReviewerInput,
): Effect.Effect<AssignReviewerOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status === "complete") {
      return yield* Effect.fail(new Conflict({ message: "Completed review rounds cannot receive new assignments" }));
    }
    const [submission, reviewer, existing] = yield* Effect.all([
      database(() => db.select({ id: submissions.id }).from(submissions).where(and(eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId))).limit(1)),
      database(() => db.select({ name: users.name }).from(eventMembers).innerJoin(users, eq(users.id, eventMembers.userId)).where(and(eq(eventMembers.eventId, input.eventId), eq(eventMembers.userId, input.reviewerUserId), eq(eventMembers.role, "reviewer"))).limit(1)),
      database(() => db.select().from(reviewAssignments).where(and(eq(reviewAssignments.eventId, input.eventId), eq(reviewAssignments.roundId, input.roundId), eq(reviewAssignments.submissionId, input.submissionId), eq(reviewAssignments.reviewerUserId, input.reviewerUserId))).limit(1)),
    ]);
    if (!submission[0]) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    if (!reviewer[0]) return yield* Effect.fail(new Validation({ message: "Assignments require an event member with the reviewer role" }));
    if (existing[0]) {
      if (input.expectedVersion === existing[0].version) {
        return {
          assignment: {
            id: existing[0].id,
            reviewerUserId: existing[0].reviewerUserId,
            reviewerName: reviewer[0].name,
            version: existing[0].version,
          },
          created: false,
        };
      }
      return yield* Effect.fail(new Conflict({ message: "Reviewer assignment changed; reload before assigning" }));
    }
    if (input.expectedVersion !== 0) {
      return yield* Effect.fail(new Conflict({ message: "Reviewer assignment no longer exists at the expected version" }));
    }

    const createdAt = now();
    const assignmentId = id("review_assignment");
    const assignment = {
      id: assignmentId,
      reviewerUserId: input.reviewerUserId,
      reviewerName: reviewer[0].name,
      version: 1,
    };
    yield* database(() =>
      db.batch([
        db.insert(reviewAssignments).values({
          id: assignmentId,
          eventId: input.eventId,
          roundId: input.roundId,
          submissionId: input.submissionId,
          reviewerUserId: input.reviewerUserId,
          version: 1,
          createdAt,
          updatedAt: createdAt,
        }),
        db.insert(domainChanges).values({
          id: id("change"),
          eventId: input.eventId,
          aggregateType: "reviewAssignment",
          aggregateId: assignmentId,
          aggregateVersion: 1,
          eventType: "review.assignment.created",
          audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: [input.reviewerUserId] }],
          payload: { submissionId: input.submissionId, roundId: input.roundId, reviewerUserId: input.reviewerUserId },
          actorUserId: viewer.actorUserId,
          actorApiKeyId: viewer.actorApiKeyId,
          requestId: input.requestId,
          occurredAt: createdAt,
        }),
        db.insert(auditLog).values({
          id: id("audit"),
          eventId: input.eventId,
          requestId: input.requestId,
          actorUserId: viewer.actorUserId,
          actorApiKeyId: viewer.actorApiKeyId,
          action: "review.assignReviewer",
          resourceType: "reviewAssignment",
          resourceId: assignmentId,
          before: null,
          after: assignment,
          occurredAt: createdAt,
        }),
      ]),
    );
    return { assignment, created: true };
  });

export const saveScore = (
  input: SaveScoreInput,
): Effect.Effect<SaveScoreOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "Human scores require an assigned browser-session reviewer" }));
    }
    yield* reviewerCanSeeSubmission(input.eventId, input.roundId, input.submissionId, viewer.userId);
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status !== "active") {
      return yield* Effect.fail(new Conflict({ message: "Human scoring is available only while the review round is active" }));
    }
    const scoreRecord = yield* validateScores(round.rubric, input.scores);
    const { db } = yield* Db;
    const [submission] = yield* database(() =>
      db.select({ status: submissions.status }).from(submissions).where(and(eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId))).limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    const [existing] = yield* database(() =>
      db.select().from(reviews).where(and(eq(reviews.eventId, input.eventId), eq(reviews.roundId, input.roundId), eq(reviews.submissionId, input.submissionId), eq(reviews.reviewerUserId, viewer.userId), eq(reviews.ai, false))).limit(1),
    );
    if (existing ? existing.version !== input.expectedVersion : input.expectedVersion !== 0) {
      return yield* Effect.fail(new Conflict({ message: "Review changed; reload before saving" }));
    }
    if (input.confirmedAiSuggestionId) {
      const [suggestion] = yield* database(() =>
        db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.eventId, input.eventId), eq(reviews.id, input.confirmedAiSuggestionId!), eq(reviews.roundId, input.roundId), eq(reviews.submissionId, input.submissionId), eq(reviews.ai, true))).limit(1),
      );
      if (!suggestion) return yield* Effect.fail(new Validation({ message: "AI suggestion does not belong to this submission and round" }));
    }

    const savedAt = now();
    const reviewId = existing?.id ?? id("review");
    const version = (existing?.version ?? 0) + 1;
    const score = averageScore(scoreRecord);
    const reviewerName = yield* database(() => db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId)).limit(1));
    const review: HumanReview = {
      id: reviewId,
      reviewerUserId: viewer.userId,
      reviewerName: reviewerName[0]?.name ?? "Reviewer",
      score,
      scores: input.scores,
      comment: input.comment ?? null,
      version,
      updatedAt: savedAt.getTime(),
    };
    const writeReview = existing
      ? db.update(reviews).set({ score, scores: scoreRecord, comment: input.comment ?? null, version, updatedAt: savedAt }).where(and(eq(reviews.id, reviewId), eq(reviews.version, input.expectedVersion)))
      : db.insert(reviews).values({ id: reviewId, eventId: input.eventId, roundId: input.roundId, submissionId: input.submissionId, reviewerUserId: viewer.userId, ai: false, score, scores: scoreRecord, comment: input.comment ?? null, version, createdAt: savedAt, updatedAt: savedAt });
    yield* database(() =>
      db.batch([
        writeReview,
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "review", aggregateId: reviewId,
          aggregateVersion: version, eventType: "review.score.saved",
          audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: [viewer.userId] }],
          payload: { submissionId: input.submissionId, roundId: input.roundId, score },
          actorUserId: viewer.actorUserId, requestId: input.requestId, occurredAt: savedAt,
        }),
        db.insert(auditLog).values({
          id: id("audit"), eventId: input.eventId, requestId: input.requestId,
          actorUserId: viewer.actorUserId, action: "review.saveScore", resourceType: "review", resourceId: reviewId,
          before: existing ? { score: existing.score, scores: existing.scores, comment: existing.comment, version: existing.version } : null,
          after: { score, scores: scoreRecord, comment: input.comment ?? null, version, confirmedAiSuggestionId: input.confirmedAiSuggestionId ?? null },
          occurredAt: savedAt,
        }),
      ]),
    );
    return { review, submissionStatus: submission.status };
  });

export const requestAiSuggestion = (
  input: RequestAiSuggestionInput,
): Effect.Effect<RequestAiSuggestionOutput, AppError, Db | CurrentUser | AiService> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    if (viewer.role === "reviewer") {
      yield* reviewerCanSeeSubmission(input.eventId, input.roundId, input.submissionId, viewer.userId);
    }
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status !== "active") {
      return yield* Effect.fail(new Conflict({ message: "AI suggestions are available only while the review round is active" }));
    }
    const { db } = yield* Db;
    const [submission] = yield* database(() =>
      db.select({ title: submissions.title, status: submissions.status }).from(submissions).where(and(eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId))).limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    const answerRows = yield* database(() =>
      db.select({ value: submissionAnswers.value, label: formVersionFields.label }).from(submissionAnswers)
        .innerJoin(formVersionFields, eq(formVersionFields.id, submissionAnswers.formVersionFieldId))
        .where(and(eq(submissionAnswers.eventId, input.eventId), eq(submissionAnswers.submissionId, input.submissionId)))
        .orderBy(asc(formVersionFields.order)),
    );
    const abstract = answerRows.find((answer) => answer.label.trim().toLocaleLowerCase() === "abstract" && typeof answer.value === "string")?.value;
    if (typeof abstract !== "string" || abstract.length === 0) {
      return yield* Effect.fail(new Validation({ message: "AI review requires the published Abstract answer" }));
    }
    const ai = yield* AiService;
    const prompt = JSON.stringify({
      instruction: "Return JSON only: {scores: Record<criterionKey, integer 1-5>, comment: string}. Do not decide acceptance.",
      title: submission.title,
      abstract,
      rubric: round.rubric,
    });
    const responseText = yield* ai.reviewText(prompt);
    const response = yield* Effect.try({
      try: () => JSON.parse(responseText) as unknown,
      catch: (error) => new External({ service: "ai", detail: `Invalid JSON: ${String(error)}` }),
    }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(AiResponse)(value)),
      Effect.mapError((error) => error instanceof External ? error : new External({ service: "ai", detail: `Invalid suggestion: ${String(error)}` })),
    );
    const scoreEntries = round.rubric.criteria.map((criterion) => ({
      criterionKey: criterion.key,
      score: response.scores[criterion.key] as CriterionScore["score"],
    }));
    const scoreRecord = yield* validateScores(round.rubric, scoreEntries);
    const createdAt = now();
    const suggestionId = id("review_ai");
    const score = averageScore(scoreRecord);
    const assignedReviewerIds = yield* database(() =>
      db.select({ reviewerUserId: reviewAssignments.reviewerUserId }).from(reviewAssignments).where(and(eq(reviewAssignments.eventId, input.eventId), eq(reviewAssignments.roundId, input.roundId), eq(reviewAssignments.submissionId, input.submissionId))),
    );
    yield* database(() =>
      db.batch([
        db.insert(reviews).values({ id: suggestionId, eventId: input.eventId, roundId: input.roundId, submissionId: input.submissionId, reviewerUserId: null, ai: true, score, scores: scoreRecord, comment: response.comment, version: 1, createdAt, updatedAt: createdAt }),
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "reviewAiSuggestion", aggregateId: suggestionId,
          aggregateVersion: 1, eventType: "review.aiSuggestion.created",
          audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: assignedReviewerIds.map((row) => row.reviewerUserId) }],
          payload: { submissionId: input.submissionId, roundId: input.roundId, inputFields: ["title", "abstract", "rubric"] },
          actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId, occurredAt: createdAt,
        }),
        db.insert(auditLog).values({
          id: id("audit"), eventId: input.eventId, requestId: input.requestId,
          actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
          action: "review.requestAiSuggestion", resourceType: "reviewAiSuggestion", resourceId: suggestionId,
          before: null, after: { submissionId: input.submissionId, roundId: input.roundId, inputFields: ["title", "abstract", "rubric"] }, occurredAt: createdAt,
        }),
      ]),
    );
    return {
      suggestion: {
        id: suggestionId,
        label: "AI suggestion — requires human confirmation",
        score,
        scores: scoreEntries,
        comment: response.comment,
        version: 1,
        createdAt: createdAt.getTime(),
        inputFields: ["title", "abstract", "rubric"],
      },
      submissionStatus: submission.status,
    };
  });

const sha256 = (value: string): Effect.Effect<string, External> =>
  Effect.tryPromise({
    try: async () => {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (error) => new External({ service: "crypto", detail: String(error) }),
  });

const readIdempotentAcceptance = (value: unknown) =>
  Schema.decodeUnknown(AcceptSubmissionOutput)(value).pipe(
    Effect.map((output) => ({ ...output, idempotent: true })),
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid idempotency response: ${String(error)}` })),
  );

export const acceptSubmission = (
  input: AcceptSubmissionInput,
): Effect.Effect<typeof AcceptSubmissionOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write", "submissions:write", "speakers:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "API keys cannot accept submissions" }));
    }
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({ eventId: input.eventId, submissionId: input.submissionId, expectedVersion: input.expectedVersion }));
    const principalId = viewer.actorApiKeyId ? `api-key:${viewer.actorApiKeyId}` : viewer.userId;
    const [existingIdempotency] = yield* database(() =>
      db.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.eventId, input.eventId), eq(idempotencyRecords.operationId, "review.acceptSubmission"), eq(idempotencyRecords.principalId, principalId), eq(idempotencyRecords.keyHash, keyHash))).limit(1),
    );
    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different acceptance request" }));
      }
      if (existingIdempotency.status === "completed") return yield* readIdempotentAcceptance(existingIdempotency.responseBody);
      return yield* Effect.fail(new Conflict({ message: "Acceptance request with this idempotency key is already in progress" }));
    }

    const [submission] = yield* database(() =>
      db.select().from(submissions).where(and(eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId))).limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    if (submission.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before accepting" }));
    }
    if (submission.status === "accepted") {
      return yield* Effect.fail(new Conflict({ message: "Submission is already accepted" }));
    }
    const [primarySpeaker] = yield* database(() =>
      db.select({ speakerId: submissionSpeakers.speakerId }).from(submissionSpeakers).where(and(eq(submissionSpeakers.eventId, input.eventId), eq(submissionSpeakers.submissionId, input.submissionId), eq(submissionSpeakers.isPrimary, true))).limit(1),
    );
    if (!primarySpeaker) {
      return yield* Effect.fail(new Validation({ message: "Acceptance requires exactly one primary speaker" }));
    }

    const acceptedAt = now();
    const nextVersion = submission.version + 1;
    const acceptanceEventId = id("acceptance");
    const provisioningId = id("speaker_provisioning");
    const idempotencyId = id("idempotency");
    const output = {
      acceptanceEventId,
      provisioningId,
      submissionId: submission.id,
      primarySpeakerId: primarySpeaker.speakerId,
      submissionVersion: nextVersion,
      status: "accepted" as const,
      provisioningStatus: "pending" as const,
      idempotent: false,
    };

    const insertAcceptance = db.insert(acceptanceEvents).select(
      db
        .select({
          id: sql<string>`${acceptanceEventId}`,
          eventId: submissions.eventId,
          submissionId: submissions.id,
          primarySpeakerId: sql<string>`${primarySpeaker.speakerId}`,
          type: sql<"accepted">`'accepted'`,
          submissionVersion: submissions.version,
          actorUserId: viewer.actorUserId === null
            ? sql<string | null>`null`
            : sql<string | null>`${viewer.actorUserId}`,
          occurredAt: sql<Date>`${acceptedAt.getTime()}`,
        })
        .from(submissions)
        .where(
          and(
            eq(submissions.eventId, input.eventId),
            eq(submissions.id, input.submissionId),
            eq(submissions.version, nextVersion),
            eq(submissions.status, "accepted"),
          ),
        ),
    );

    yield* database(() =>
      db.batch([
        db.insert(idempotencyRecords).values({
          id: idempotencyId, eventId: input.eventId, operationId: "review.acceptSubmission", principalId,
          keyHash, requestHash, status: "in_progress", expiresAt: new Date(acceptedAt.getTime() + 86_400_000), createdAt: acceptedAt,
        }),
        db.update(submissions).set({ status: "accepted", acceptedAt, version: nextVersion, updatedAt: acceptedAt }).where(and(eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId), eq(submissions.version, input.expectedVersion))),
        insertAcceptance,
        db.insert(speakerProvisioning).values({ id: provisioningId, eventId: input.eventId, acceptanceEventId, submissionId: input.submissionId, primarySpeakerId: primarySpeaker.speakerId, status: "pending", availableAt: acceptedAt, attemptCount: 0, version: 1, createdAt: acceptedAt, updatedAt: acceptedAt }),
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "submission", aggregateId: input.submissionId,
          aggregateVersion: nextVersion, eventType: "review.submission.accepted",
          audiences: [{ kind: "admins" }, { kind: "speaker", speakerIds: [primarySpeaker.speakerId] }],
          payload: { acceptanceEventId, submissionId: input.submissionId, primarySpeakerId: primarySpeaker.speakerId, submissionVersion: nextVersion },
          actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId, idempotencyRecordId: idempotencyId, occurredAt: acceptedAt,
        }),
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "speakerProvisioning", aggregateId: provisioningId,
          aggregateVersion: 1, eventType: "speaker.provisioning.requested",
          audiences: [{ kind: "admins" }, { kind: "speaker", speakerIds: [primarySpeaker.speakerId] }],
          payload: { acceptanceEventId, provisioningId, submissionId: input.submissionId, primarySpeakerId: primarySpeaker.speakerId, status: "pending" },
          actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId, idempotencyRecordId: idempotencyId, occurredAt: acceptedAt,
        }),
        db.insert(auditLog).values({
          id: id("audit"), eventId: input.eventId, requestId: input.requestId,
          actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
          action: "review.acceptSubmission", resourceType: "submission", resourceId: input.submissionId,
          before: { status: submission.status, version: submission.version, acceptedAt: submission.acceptedAt?.getTime() ?? null },
          after: { status: "accepted", version: nextVersion, acceptedAt: acceptedAt.getTime(), acceptanceEventId, provisioningId },
          metadata: { idempotencyRecordId: idempotencyId }, occurredAt: acceptedAt,
        }),
        db.update(idempotencyRecords).set({ status: "completed", responseStatus: 200, responseBody: output, completedAt: acceptedAt }).where(eq(idempotencyRecords.id, idempotencyId)),
      ]),
    );
    return output;
  });
