import { Conflict, External, Forbidden, NotFound, Validation, type AppError } from "contracts/errors";
import {
  acceptanceEvents,
  auditLog,
  domainChanges,
  eventMembers,
  events,
  forms,
  formVersionFields,
  idempotencyRecords,
  mailDeliveries,
  mailDeliverySnapshots,
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
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Schema } from "effect";
import { nanoid } from "nanoid";
import { AiService, CurrentUser, Db, effectiveEventAuthority, MailQueue } from "@/server/services";
import { prepareAirtableSubmissionProjection } from "@/server/sync/airtable-outbox";
import {
  AcceptSubmissionOutput,
  type AcceptSubmissionInput,
  AppendReviewCommentOutput,
  type AppendReviewCommentInput,
  AdvanceReviewRoundOutput,
  type AdvanceReviewRoundInput,
  type AssignReviewerInput,
  type AssignReviewerOutput,
  type AutoDistributeReviewersInput,
  AutoDistributeReviewersOutput,
  type BulkAssignReviewersInput,
  BulkAssignReviewersOutput,
  type CriterionScore,
  CreateReviewRoundOutput,
  type CreateReviewRoundInput,
  DeclareReviewConflictOutput,
  type DeclareReviewConflictInput,
  type GetWorkbenchInput,
  type ListReviewConflictsInput,
  type ListReviewConflictsOutput,
  type HumanReview,
  ExportReviewResultsOutput,
  type ExportReviewResultsInput,
  type ReviewExportRow,
  RecuseAssignmentOutput,
  type RecuseAssignmentInput,
  RemoveAssignmentOutput,
  type RemoveAssignmentInput,
  type RequestAiSuggestionInput,
  RequestAiSuggestionOutput,
  RejectSubmissionOutput,
  type RejectSubmissionInput,
  ReleaseDecisionsOutput,
  type ReleaseDecisionsInput,
  RevokeAcceptanceOutput,
  type RevokeAcceptanceInput,
  ReviewRubric,
  type ReviewRubric as ReviewRubricType,
  type ReviewRound,
  type ReviewWorkbench,
  type SaveScoreInput,
  type SaveScoreOutput,
  StageDecisionOutput,
  type StageDecisionInput,
  SendReviewRemindersOutput,
  type SendReviewRemindersInput,
  type SubmissionReviewDetail,
  type SubmissionReviewSummary,
  type SubmissionStatus,
  UpdateReviewRoundOutput,
  type UpdateReviewRoundInput,
  WithdrawReviewConflictOutput,
  type WithdrawReviewConflictInput,
} from "./schema";
import { compareReviewQueue } from "./ordering";

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
const REVIEW_DECISION_SOURCE_STATUSES = ["submitted", "in_review", "waitlist"] as const satisfies readonly SubmissionStatus[];
type ReviewDecisionSourceStatus = typeof REVIEW_DECISION_SOURCE_STATUSES[number];

const isReviewDecisionSourceStatus = (status: SubmissionStatus): status is ReviewDecisionSourceStatus =>
  (REVIEW_DECISION_SOURCE_STATUSES as readonly SubmissionStatus[]).includes(status);

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
    const authority = yield* effectiveEventAuthority(db, principal.userId, eventId);
    if (!authority) {
      return yield* Effect.fail(new Forbidden({ reason: "Event membership required" }));
    }
    return {
      role: authority.role,
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
      startsAt: round.startsAt ? round.startsAt.getTime() : null,
      endsAt: round.endsAt ? round.endsAt.getTime() : null,
      blind: round.blind,
      rubric,
      version: round.version,
    } satisfies ReviewRound;
  });

const roundFromRow = (
  row: typeof reviewRounds.$inferSelect,
  rubric: ReviewRubricType,
): ReviewRound => ({
  id: row.id,
  name: row.name,
  order: row.order,
  status: row.status,
  startsAt: row.startsAt ? row.startsAt.getTime() : null,
  endsAt: row.endsAt ? row.endsAt.getTime() : null,
  blind: row.blind,
  rubric,
  version: row.version,
});

const requireAssignedReviewer = (
  viewer: Viewer,
  eventId: string,
  roundId: string,
  submissionId: string,
): Effect.Effect<void, AppError, Db> =>
  viewer.role !== "reviewer"
    ? Effect.void
    : Effect.gen(function* () {
      const { db } = yield* Db;
      const assignments = yield* database(() =>
        db.select({ status: reviewAssignments.status }).from(reviewAssignments).where(and(
          eq(reviewAssignments.eventId, eventId),
          eq(reviewAssignments.roundId, roundId),
          eq(reviewAssignments.submissionId, submissionId),
          eq(reviewAssignments.reviewerUserId, viewer.userId),
        )),
      );
      if (assignments.some(({ status }) => status === "assigned")) return;
      if (assignments.some(({ status }) => status === "recused")) {
        return yield* Effect.fail(new Conflict({ message: "This review assignment has been recused" }));
      }
      return yield* Effect.fail(new Forbidden({ reason: "This submission is not assigned to the current reviewer" }));
    });

const assignedReviewerAudienceIds = (
  eventId: string,
  roundId: string,
  submissionId: string,
): Effect.Effect<readonly string[], AppError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* database(() => db.select({ userId: reviewAssignments.reviewerUserId })
      .from(reviewAssignments)
      .where(and(
        eq(reviewAssignments.eventId, eventId),
        eq(reviewAssignments.roundId, roundId),
        eq(reviewAssignments.submissionId, submissionId),
        eq(reviewAssignments.status, "assigned"),
      ))
      .orderBy(asc(reviewAssignments.reviewerUserId)));
    return [...new Set(rows.map(({ userId }) => userId))];
  });

const normalizeRoundRubric = (
  rubric: ReviewRubricType,
): Effect.Effect<ReviewRubricType, Validation> => {
  const keys = new Set<string>();
  const criteria: ReviewRubricType["criteria"][number][] = [];
  for (const criterion of rubric.criteria) {
    const key = criterion.key.trim();
    const label = criterion.label.trim();
    if (!key || !label) {
      return Effect.fail(new Validation({ message: "Rubric criterion keys and labels cannot be blank" }));
    }
    if (keys.has(key)) {
      return Effect.fail(new Validation({ message: `Rubric criterion '${key}' is duplicated` }));
    }
    keys.add(key);
    const options = criterion.options?.map((option) => ({
      value: option.value.trim(),
      label: option.label.trim(),
      score: option.score,
    })) ?? [];
    if (criterion.type === "dropdown") {
      if (options.length < 2 || options.some((option) => !option.value || !option.label)) {
        return Effect.fail(new Validation({ message: `Dropdown criterion '${label}' requires at least two labeled options` }));
      }
      if (new Set(options.map((option) => option.value)).size !== options.length) {
        return Effect.fail(new Validation({ message: `Dropdown criterion '${label}' has duplicate option values` }));
      }
    }
    criteria.push({
      key,
      label,
      ...(criterion.description?.trim() ? { description: criterion.description.trim() } : {}),
      type: criterion.type,
      weight: criterion.type === "text" ? 0 : criterion.weight,
      required: criterion.required,
      max: 5,
      ...(criterion.type === "dropdown" ? { options } : {}),
    });
  }
  return Effect.succeed({ criteria: [criteria[0]!, ...criteria.slice(1)] });
};

const validateRoundSchedule = (
  startsAt: number | null,
  endsAt: number | null,
): Effect.Effect<void, Validation> =>
  startsAt !== null && endsAt !== null && endsAt <= startsAt
    ? Effect.fail(new Validation({ message: "Review round end must be after its start" }))
    : Effect.void;

const validateScores = (
  rubric: ReviewRubricType,
  scores: readonly CriterionScore[],
): Effect.Effect<Readonly<Record<string, number | string>>, Validation> => {
  const criteria = new Map(rubric.criteria.map((criterion) => [criterion.key, criterion]));
  const result: Record<string, number | string> = {};
  for (const entry of scores) {
    const criterion = criteria.get(entry.criterionKey);
    if (!criterion) {
      return Effect.fail(new Validation({ message: `Unknown rubric criterion '${entry.criterionKey}'` }));
    }
    if (Object.hasOwn(result, entry.criterionKey)) {
      return Effect.fail(new Validation({ message: `Rubric criterion '${entry.criterionKey}' was scored more than once` }));
    }
    if (criterion.type === "numeric") {
      if (typeof entry.score !== "number" || !Number.isInteger(entry.score) || entry.score < 1 || entry.score > 5) {
        return Effect.fail(new Validation({ message: `Numeric criterion '${criterion.label}' requires a whole number from 1 to 5` }));
      }
    } else if (criterion.type === "dropdown") {
      if (typeof entry.score !== "string" || !criterion.options?.some((option) => option.value === entry.score)) {
        return Effect.fail(new Validation({ message: `Dropdown criterion '${criterion.label}' requires one configured option` }));
      }
    } else if (typeof entry.score !== "string" || !entry.score.trim()) {
      return Effect.fail(new Validation({ message: `Text criterion '${criterion.label}' requires a response` }));
    }
    result[entry.criterionKey] = typeof entry.score === "string" ? entry.score.trim() : entry.score;
  }
  const missing = rubric.criteria.filter((criterion) => criterion.required && !Object.hasOwn(result, criterion.key));
  if (missing.length > 0) {
    return Effect.fail(new Validation({ message: `Required rubric criteria are incomplete: ${missing.map((criterion) => criterion.label).join(", ")}` }));
  }
  return Effect.succeed(result);
};

const averageScore = (rubric: ReviewRubricType, scores: Readonly<Record<string, number | string>>) => {
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const criterion of rubric.criteria) {
    if (criterion.type === "text" || criterion.weight <= 0) continue;
    const response = scores[criterion.key];
    const value = criterion.type === "numeric"
      ? typeof response === "number" ? response : null
      : criterion.options?.find((option) => option.value === response)?.score ?? null;
    if (value === null) continue;
    weightedTotal += value * criterion.weight;
    weightTotal += criterion.weight;
  }
  return weightTotal === 0 ? null : weightedTotal / weightTotal;
};

const visibleAggregateScore = (score: number) => score === 0 ? null : score;

const orderedScores = (
  rubric: ReviewRubricType,
  scores: Readonly<Record<string, number | string>> | null,
): readonly CriterionScore[] =>
  rubric.criteria.flatMap((criterion) => {
    const score = scores?.[criterion.key];
    return (typeof score === "number" && score >= 1 && score <= 5) || (typeof score === "string" && score.length > 0)
      ? [{ criterionKey: criterion.key, score }]
      : [];
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
      return {
        acceptanceEventId: latest.id,
        submissionVersion: latest.submissionVersion,
        acceptedAt: toMillis(latest.occurredAt),
        provisioningId: null,
        provisioningStatus: "missing" as const,
      };
    }
    return {
      acceptanceEventId: latest.id,
      submissionVersion: latest.submissionVersion,
      acceptedAt: toMillis(latest.occurredAt),
      provisioningId: provisioning.id,
      provisioningStatus: provisioning.status,
    } as const;
  });

const roundCommandPrincipalId = (viewer: Viewer) =>
  viewer.actorApiKeyId ? `api-key:${viewer.actorApiKeyId}` : viewer.userId;

export const createReviewRound = (
  input: CreateReviewRoundInput,
): Effect.Effect<CreateReviewRoundOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const name = input.name.trim();
    if (!name) return yield* Effect.fail(new Validation({ message: "Review round name cannot be blank" }));
    yield* validateRoundSchedule(input.startsAt, input.endsAt);
    const rubric = yield* normalizeRoundRubric(input.rubric);
    const { db } = yield* Db;
    const principalId = roundCommandPrincipalId(viewer);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      name,
      initialStatus: input.initialStatus,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      blind: input.blind,
      rubric,
      expectedRoundCount: input.expectedRoundCount,
    }));
    const readReplay = (): Effect.Effect<CreateReviewRoundOutput | null, AppError> =>
      Effect.gen(function* () {
        const [record] = yield* database(() =>
          db.select().from(idempotencyRecords).where(and(
            eq(idempotencyRecords.eventId, input.eventId),
            eq(idempotencyRecords.operationId, "review.createRound"),
            eq(idempotencyRecords.principalId, principalId),
            eq(idempotencyRecords.keyHash, keyHash),
          )).limit(1),
        );
        if (!record) return null;
        if (record.requestHash !== requestHash) {
          return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different review-round request" }));
        }
        if (record.status !== "completed") {
          return yield* Effect.fail(new Conflict({ message: "Review-round creation with this idempotency key is still in progress" }));
        }
        return yield* Schema.decodeUnknown(CreateReviewRoundOutput)(record.responseBody).pipe(
          Effect.map((output) => ({ ...output, idempotent: true })),
          Effect.mapError((error) => new External({ service: "database", detail: `Invalid review-round replay: ${String(error)}` })),
        );
      });
    const replay = yield* readReplay();
    if (replay) return replay;

    const [event, existingRows] = yield* Effect.all([
      database(() => db.select({ id: events.id }).from(events).where(eq(events.id, input.eventId)).limit(1)),
      database(() => db.select().from(reviewRounds).where(eq(reviewRounds.eventId, input.eventId)).orderBy(asc(reviewRounds.order))),
    ]);
    if (!event[0]) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventId }));
    if (existingRows.length !== input.expectedRoundCount) {
      return yield* Effect.fail(new Conflict({ message: "Review rounds changed; reload before creating another round" }));
    }
    if (
      input.initialStatus === "active"
      && existingRows.some((round) => round.status !== "complete")
    ) {
      return yield* Effect.fail(new Conflict({ message: "An active round can start only after every earlier round is complete" }));
    }

    const createdAt = now();
    const roundId = id("review_round");
    const round: ReviewRound = {
      id: roundId,
      name,
      order: existingRows.length + 1,
      status: input.initialStatus,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      blind: input.blind,
      rubric,
      version: 1,
    };
    const output: CreateReviewRoundOutput = { round, idempotent: false };
    const idempotencyId = id("idempotency");
    const commit = database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: idempotencyId,
        eventId: input.eventId,
        operationId: "review.createRound",
        principalId,
        keyHash,
        requestHash,
        status: "completed",
        responseStatus: 201,
        responseBody: output,
        expiresAt: new Date(createdAt.getTime() + 86_400_000),
        completedAt: createdAt,
        createdAt,
      }),
      db.insert(reviewRounds).values({
        id: roundId,
        eventId: input.eventId,
        name,
        order: round.order,
        status: round.status,
        startsAt: input.startsAt === null ? null : new Date(input.startsAt),
        endsAt: input.endsAt === null ? null : new Date(input.endsAt),
        blind: input.blind,
        rubric,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      }),
      db.insert(domainChanges).values({
        id: id("change"),
        eventId: input.eventId,
        aggregateType: "reviewRound",
        aggregateId: roundId,
        aggregateVersion: 1,
        eventType: "review.round.created",
        audiences: [{ kind: "admins" }],
        payload: round,
        actorUserId: viewer.actorUserId,
        actorApiKeyId: viewer.actorApiKeyId,
        requestId: input.requestId,
        idempotencyRecordId: idempotencyId,
        occurredAt: createdAt,
      }),
      db.insert(auditLog).values({
        id: id("audit"),
        eventId: input.eventId,
        requestId: input.requestId,
        actorUserId: viewer.actorUserId,
        actorApiKeyId: viewer.actorApiKeyId,
        action: "review.createRound",
        resourceType: "reviewRound",
        resourceId: roundId,
        before: null,
        after: round,
        metadata: { idempotencyRecordId: idempotencyId },
        occurredAt: createdAt,
      }),
    ]));
    return yield* commit.pipe(
      Effect.as(output),
      Effect.catchAll((failure) => Effect.gen(function* () {
        const committed = yield* readReplay();
        if (committed) return committed;
        const current = yield* database(() =>
          db.select({ id: reviewRounds.id }).from(reviewRounds).where(eq(reviewRounds.eventId, input.eventId)),
        );
        if (current.length !== input.expectedRoundCount) {
          return yield* Effect.fail(new Conflict({ message: "Review rounds changed; reload before creating another round" }));
        }
        return yield* Effect.fail(failure);
      })),
    );
  });

export const updateReviewRound = (
  input: UpdateReviewRoundInput,
): Effect.Effect<UpdateReviewRoundOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const name = input.name.trim();
    if (!name) return yield* Effect.fail(new Validation({ message: "Review round name cannot be blank" }));
    yield* validateRoundSchedule(input.startsAt, input.endsAt);
    const rubric = yield* normalizeRoundRubric(input.rubric);
    const { db } = yield* Db;
    const principalId = roundCommandPrincipalId(viewer);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      roundId: input.roundId,
      name,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      blind: input.blind,
      rubric,
      expectedVersion: input.expectedVersion,
    }));
    const readReplay = (): Effect.Effect<UpdateReviewRoundOutput | null, AppError> =>
      Effect.gen(function* () {
        const [record] = yield* database(() => db.select().from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, "review.updateRound"),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.keyHash, keyHash),
        )).limit(1));
        if (!record) return null;
        if (record.requestHash !== requestHash) {
          return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different review-round update" }));
        }
        return yield* Schema.decodeUnknown(UpdateReviewRoundOutput)(record.responseBody).pipe(
          Effect.map((output) => ({ ...output, idempotent: true })),
          Effect.mapError((error) => new External({ service: "database", detail: `Invalid review-round update replay: ${String(error)}` })),
        );
      });
    const replay = yield* readReplay();
    if (replay) return replay;

    const [row, existingReviews] = yield* Effect.all([
      database(() => db.select().from(reviewRounds).where(and(
        eq(reviewRounds.eventId, input.eventId),
        eq(reviewRounds.id, input.roundId),
      )).limit(1)),
      database(() => db.select({ id: reviews.id }).from(reviews).where(and(
        eq(reviews.eventId, input.eventId),
        eq(reviews.roundId, input.roundId),
      )).limit(1)),
    ]);
    const currentRow = row[0];
    if (!currentRow) return yield* Effect.fail(new NotFound({ entity: "reviewRound", id: input.roundId }));
    if (currentRow.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Review round changed; reload before saving" }));
    }
    const current = roundFromRow(currentRow, yield* decodeRubric(currentRow.rubric));
    if (existingReviews.length > 0 && JSON.stringify(current.rubric) !== JSON.stringify(rubric)) {
      return yield* Effect.fail(new Conflict({ message: "A rubric cannot change after scoring has started" }));
    }
    const updatedAt = now();
    const after: ReviewRound = {
      ...current,
      name,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      blind: input.blind,
      rubric,
      version: current.version + 1,
    };
    const output: UpdateReviewRoundOutput = { round: after, idempotent: false };
    const idempotencyId = id("idempotency");
    const commit = database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: idempotencyId,
        eventId: input.eventId,
        operationId: "review.updateRound",
        principalId,
        keyHash,
        requestHash,
        status: "completed",
        responseStatus: 200,
        responseBody: output,
        expiresAt: new Date(updatedAt.getTime() + 86_400_000),
        completedAt: updatedAt,
        createdAt: updatedAt,
      }),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewRoundClaim", aggregateId: input.roundId,
        aggregateVersion: after.version, eventType: "review.round.versionClaim", audiences: [{ kind: "admins" }],
        payload: { expectedVersion: current.version }, actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        requestId: input.requestId, idempotencyRecordId: idempotencyId, occurredAt: updatedAt,
      }),
      db.update(reviewRounds).set({
        name,
        startsAt: input.startsAt === null ? null : new Date(input.startsAt),
        endsAt: input.endsAt === null ? null : new Date(input.endsAt),
        blind: input.blind,
        rubric,
        version: after.version,
        updatedAt,
      }).where(and(
        eq(reviewRounds.eventId, input.eventId),
        eq(reviewRounds.id, input.roundId),
        eq(reviewRounds.version, current.version),
      )),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewRound", aggregateId: input.roundId,
        aggregateVersion: after.version, eventType: "review.round.updated", audiences: [{ kind: "admins" }], payload: after,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId,
        idempotencyRecordId: idempotencyId, occurredAt: updatedAt,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: input.requestId,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        action: "review.updateRound", resourceType: "reviewRound", resourceId: input.roundId,
        before: current, after, metadata: { idempotencyRecordId: idempotencyId }, occurredAt: updatedAt,
      }),
    ]));
    return yield* commit.pipe(
      Effect.as(output),
      Effect.catchAll((failure) => Effect.gen(function* () {
        const committed = yield* readReplay();
        if (committed) return committed;
        return yield* Effect.fail(failure);
      })),
    );
  });

export const advanceReviewRound = (
  input: AdvanceReviewRoundInput,
): Effect.Effect<AdvanceReviewRoundOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const principalId = roundCommandPrincipalId(viewer);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      roundId: input.roundId,
      expectedVersion: input.expectedVersion,
      nextRoundId: input.nextRoundId,
      expectedNextVersion: input.expectedNextVersion,
    }));
    const readReplay = (): Effect.Effect<AdvanceReviewRoundOutput | null, AppError> =>
      Effect.gen(function* () {
        const [record] = yield* database(() =>
          db.select().from(idempotencyRecords).where(and(
            eq(idempotencyRecords.eventId, input.eventId),
            eq(idempotencyRecords.operationId, "review.advanceRound"),
            eq(idempotencyRecords.principalId, principalId),
            eq(idempotencyRecords.keyHash, keyHash),
          )).limit(1),
        );
        if (!record) return null;
        if (record.requestHash !== requestHash) {
          return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different round transition" }));
        }
        if (record.status !== "completed") {
          return yield* Effect.fail(new Conflict({ message: "A round transition with this idempotency key is still in progress" }));
        }
        return yield* Schema.decodeUnknown(AdvanceReviewRoundOutput)(record.responseBody).pipe(
          Effect.map((output) => ({ ...output, idempotent: true })),
          Effect.mapError((error) => new External({ service: "database", detail: `Invalid round-transition replay: ${String(error)}` })),
        );
      });
    const replay = yield* readReplay();
    if (replay) return replay;

    const rows = yield* database(() =>
      db.select().from(reviewRounds).where(eq(reviewRounds.eventId, input.eventId)).orderBy(asc(reviewRounds.order)),
    );
    if (rows.length === 0) return yield* Effect.fail(new NotFound({ entity: "reviewRound", id: input.roundId }));
    const decoded: ReviewRound[] = [];
    for (const row of rows) decoded.push(roundFromRow(row, yield* decodeRubric(row.rubric)));
    const current = decoded.find((round) => round.id === input.roundId);
    if (!current) return yield* Effect.fail(new NotFound({ entity: "reviewRound", id: input.roundId }));
    if (current.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Review round changed; reload before advancing" }));
    }
    if (current.status === "complete") {
      return yield* Effect.fail(new Conflict({ message: "Completed review rounds cannot be advanced again" }));
    }

    const active = decoded.find((round) => round.status === "active");
    const pendingInOrder = decoded.filter((round) => round.status === "pending");
    const next = input.nextRoundId
      ? decoded.find((round) => round.id === input.nextRoundId)
      : undefined;
    if (input.nextRoundId && !next) {
      return yield* Effect.fail(new NotFound({ entity: "reviewRound", id: input.nextRoundId }));
    }

    if (current.status === "pending") {
      if (input.nextRoundId !== null || input.expectedNextVersion !== 0) {
        return yield* Effect.fail(new Validation({ message: "Activating a pending round does not accept a next round" }));
      }
      if (active) {
        return yield* Effect.fail(new Conflict({ message: "Complete the active review round before activating another" }));
      }
      if (pendingInOrder[0]?.id !== current.id || decoded.some((round) => round.order < current.order && round.status !== "complete")) {
        return yield* Effect.fail(new Conflict({ message: "Review rounds must be activated in order" }));
      }
    } else if (next) {
      if (next.status !== "pending") {
        return yield* Effect.fail(new Conflict({ message: "The next review round is no longer pending" }));
      }
      if (next.version !== input.expectedNextVersion) {
        return yield* Effect.fail(new Conflict({ message: "The next review round changed; reload before advancing" }));
      }
      const firstLaterPending = pendingInOrder.find((round) => round.order > current.order);
      if (firstLaterPending?.id !== next.id || decoded.some((round) => round.order < next.order && round.id !== current.id && round.status !== "complete")) {
        return yield* Effect.fail(new Conflict({ message: "Review rounds must advance to the next pending round in order" }));
      }
    } else if (input.expectedNextVersion !== 0) {
      return yield* Effect.fail(new Validation({ message: "expectedNextVersion must be zero when no next round is selected" }));
    }

    const transitionedAt = now();
    const currentAfter: ReviewRound = {
      ...current,
      status: current.status === "pending" ? "active" : "complete",
      version: current.version + 1,
    };
    const nextAfter: ReviewRound | null = current.status === "active" && next
      ? { ...next, status: "active", version: next.version + 1 }
      : null;
    const afterRounds = decoded.map((round) =>
      round.id === current.id ? currentAfter : round.id === nextAfter?.id ? nextAfter : round,
    ) as [ReviewRound, ...ReviewRound[]];
    const output: AdvanceReviewRoundOutput = { rounds: afterRounds, idempotent: false };
    const idempotencyId = id("idempotency");
    const currentEventType = currentAfter.status === "active" ? "review.round.activated" : "review.round.completed";
    const commit = database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: idempotencyId,
        eventId: input.eventId,
        operationId: "review.advanceRound",
        principalId,
        keyHash,
        requestHash,
        status: "completed",
        responseStatus: 200,
        responseBody: output,
        expiresAt: new Date(transitionedAt.getTime() + 86_400_000),
        completedAt: transitionedAt,
        createdAt: transitionedAt,
      }),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewRoundClaim", aggregateId: current.id,
        aggregateVersion: currentAfter.version, eventType: "review.round.versionClaim", audiences: [{ kind: "admins" }],
        payload: { expectedVersion: current.version }, actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        requestId: input.requestId, idempotencyRecordId: idempotencyId, occurredAt: transitionedAt,
      }),
      ...(nextAfter ? [db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewRoundClaim", aggregateId: nextAfter.id,
        aggregateVersion: nextAfter.version, eventType: "review.round.versionClaim", audiences: [{ kind: "admins" }],
        payload: { expectedVersion: next!.version }, actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        requestId: input.requestId, idempotencyRecordId: idempotencyId, occurredAt: transitionedAt,
      })] : []),
      db.update(reviewRounds).set({ status: currentAfter.status, version: currentAfter.version, updatedAt: transitionedAt }).where(and(
        eq(reviewRounds.eventId, input.eventId), eq(reviewRounds.id, current.id), eq(reviewRounds.version, current.version), eq(reviewRounds.status, current.status),
      )),
      ...(nextAfter ? [db.update(reviewRounds).set({ status: "active", version: nextAfter.version, updatedAt: transitionedAt }).where(and(
        eq(reviewRounds.eventId, input.eventId), eq(reviewRounds.id, nextAfter.id), eq(reviewRounds.version, next!.version), eq(reviewRounds.status, "pending"),
      ))] : []),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewRound", aggregateId: current.id,
        aggregateVersion: currentAfter.version, eventType: currentEventType, audiences: [{ kind: "admins" }], payload: currentAfter,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId,
        idempotencyRecordId: idempotencyId, occurredAt: transitionedAt,
      }),
      ...(nextAfter ? [db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewRound", aggregateId: nextAfter.id,
        aggregateVersion: nextAfter.version, eventType: "review.round.activated", audiences: [{ kind: "admins" }], payload: nextAfter,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId,
        idempotencyRecordId: idempotencyId, occurredAt: transitionedAt,
      })] : []),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: input.requestId,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        action: "review.advanceRound", resourceType: "reviewRound", resourceId: current.id,
        before: { round: current, nextRound: next ?? null }, after: { round: currentAfter, nextRound: nextAfter },
        metadata: { idempotencyRecordId: idempotencyId }, occurredAt: transitionedAt,
      }),
    ]));
    return yield* commit.pipe(
      Effect.as(output),
      Effect.catchAll((failure) => Effect.gen(function* () {
        const committed = yield* readReplay();
        if (committed) return committed;
        const [latest] = yield* database(() =>
          db.select({ version: reviewRounds.version }).from(reviewRounds).where(and(
            eq(reviewRounds.eventId, input.eventId), eq(reviewRounds.id, input.roundId),
          )).limit(1),
        );
        if (!latest || latest.version !== input.expectedVersion) {
          return yield* Effect.fail(new Conflict({ message: "Review round changed; reload before advancing" }));
        }
        return yield* Effect.fail(failure);
      })),
    );
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

    const memberRows = yield* database(() =>
      db
        .select({ userId: eventMembers.userId, name: users.name, role: eventMembers.role })
        .from(eventMembers)
        .innerJoin(users, eq(users.id, eventMembers.userId))
        .where(eq(eventMembers.eventId, input.eventId))
        .orderBy(asc(users.name), asc(eventMembers.userId)),
    );
    const reviewerRows = viewer.role === "reviewer"
      ? []
      : memberRows.filter((member) => member.role === "reviewer");

    const roundRows = yield* database(() =>
      db.select().from(reviewRounds).where(eq(reviewRounds.eventId, input.eventId)).orderBy(asc(reviewRounds.order)),
    );
    const rounds: ReviewRound[] = [];
    for (const row of roundRows) {
      rounds.push(roundFromRow(row, yield* decodeRubric(row.rubric)));
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
          status: reviewAssignments.status,
          recusalReason: reviewAssignments.recusalReason,
          recusedAt: reviewAssignments.recusedAt,
          version: reviewAssignments.version,
          updatedAt: reviewAssignments.updatedAt,
          reviewerName: users.name,
        })
        .from(reviewAssignments)
        .innerJoin(users, eq(users.id, reviewAssignments.reviewerUserId))
        .where(eq(reviewAssignments.eventId, input.eventId)),
    );
    const recusalRows = assignmentRows.filter((assignment) => assignment.status === "recused");
    const relevantRoundId = selectedRound?.id;
    const reviewerSubmissionIds = new Set(
      assignmentRows
        .filter(
          (assignment) =>
            assignment.reviewerUserId === viewer.userId &&
            assignment.status === "assigned" &&
            (!relevantRoundId || assignment.roundId === relevantRoundId),
        )
        .map((assignment) => assignment.submissionId),
    );

    const allSubmissionRows = yield* database(() =>
      db
        .select({
          id: submissions.id,
          title: submissions.title,
          category: submissions.category,
          status: submissions.status,
          pendingDecision: submissions.pendingDecision,
          submittedAt: submissions.submittedAt,
          version: submissions.version,
        })
        .from(submissions)
        .innerJoin(
          forms,
          and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
        )
        .where(and(eq(submissions.eventId, input.eventId), eq(forms.kind, "cfp")))
        .orderBy(desc(submissions.submittedAt)),
    );
    let submissionRows = allSubmissionRows;
    if (viewer.role === "reviewer" || input.assignedToMe) {
      submissionRows = submissionRows.filter((submission) => reviewerSubmissionIds.has(submission.id));
    }
    if (input.status) submissionRows = submissionRows.filter((submission) => submission.status === input.status);
    if (input.category) submissionRows = submissionRows.filter((submission) => submission.category === input.category);

    const reviewRows = yield* database(() =>
      db.select().from(reviews).where(eq(reviews.eventId, input.eventId)),
    );
    const visibleHumanReviews = reviewRows.filter((review) => !review.ai);
    // Anchoring protection: a reviewer sees peer scores on a proposal only
    // after saving their own review of it. Organizers and admins always see
    // the committee-wide picture.
    const viewerIsReviewer = viewer.role === "reviewer";
    const viewerReviewedSubmissionIds = new Set(
      visibleHumanReviews
        .filter((review) =>
          review.reviewerUserId === viewer.userId &&
          (!relevantRoundId || review.roundId === relevantRoundId),
        )
        .map((review) => review.submissionId),
    );
    const peerScoresVisible = (submissionId: string): boolean =>
      !viewerIsReviewer || viewerReviewedSubmissionIds.has(submissionId);
    const reviewerProgress = reviewerRows.map((reviewer) => {
      const reviewerAssignments = assignmentRows.filter((assignment) =>
        assignment.reviewerUserId === reviewer.userId &&
        assignment.status === "assigned" &&
        (!relevantRoundId || assignment.roundId === relevantRoundId)
      );
      const completedCount = reviewerAssignments.filter((assignment) =>
        visibleHumanReviews.some((review) =>
          review.roundId === assignment.roundId &&
          review.submissionId === assignment.submissionId &&
          review.reviewerUserId === reviewer.userId
        )
      ).length;
      return {
        reviewerUserId: reviewer.userId,
        reviewerName: reviewer.name ?? "Reviewer",
        assignedCount: reviewerAssignments.length,
        completedCount,
        outstandingCount: reviewerAssignments.length - completedCount,
        completionPercent: reviewerAssignments.length === 0 ? 0 : completedCount / reviewerAssignments.length * 100,
      };
    });
    const summaries = submissionRows.map((submission): SubmissionReviewSummary => {
      const assignments = assignmentRows.filter(
        (assignment) => assignment.submissionId === submission.id &&
          assignment.status === "assigned" &&
          (!relevantRoundId || assignment.roundId === relevantRoundId),
      );
      const humanReviews = visibleHumanReviews.filter(
        (review) => review.submissionId === submission.id && (!relevantRoundId || review.roundId === relevantRoundId),
      );
      const scoredReviews = humanReviews.filter((review) => review.score !== 0);
      const completedAssignmentCount = assignments.filter((assignment) =>
        humanReviews.some((review) => review.reviewerUserId === assignment.reviewerUserId)
      ).length;
      const score = scoredReviews.length === 0
        ? null
        : scoredReviews.reduce((total, review) => total + review.score, 0) / scoredReviews.length;
      const reviewState = humanReviews.length > 0
        ? assignments.length > 0 && completedAssignmentCount === assignments.length
          ? "complete"
          : "in_progress"
        : assignments.length > 0
          ? "assigned"
          : "unassigned";
      return {
        id: submission.id,
        title: submission.title,
        category: submission.category,
        status: submission.status,
        pendingDecision: viewer.role === "reviewer" || viewer.actorApiKeyId !== null ? null : submission.pendingDecision,
        submittedAt: toMillis(submission.submittedAt),
        version: submission.version,
        reviewState,
        assignedToMe: reviewerSubmissionIds.has(submission.id),
        assignmentCount: assignments.length,
        completedReviewCount: humanReviews.length,
        averageScore: peerScoresVisible(submission.id) ? score : null,
      };
    }).sort((left, right) => compareReviewQueue(input.order ?? "coverage", left, right));

    const total = summaries.length;
    const start = (input.page - 1) * input.pageSize;
    const queue = summaries.slice(start, start + input.pageSize);
    const requestedId = input.selectedSubmissionId ?? queue[0]?.id;
    const selectedSummary = requestedId ? summaries.find((summary) => summary.id === requestedId) : undefined;
    if (input.selectedSubmissionId && !selectedSummary) {
      return yield* Effect.fail(new NotFound({ entity: "submission", id: input.selectedSubmissionId }));
    }

    let selected: SubmissionReviewDetail | null = null;
    if (selectedSummary) {
      const submissionId = selectedSummary.id;
      const [answerRows, speakerRows, commentRows] = yield* Effect.all([
        database(() =>
          db
            .select({
              label: formVersionFields.label,
              value: submissionAnswers.value,
              semanticKey: formVersionFields.semanticKey,
            })
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
            .select({
              id: speakers.id,
              displayName: speakers.displayName,
              isPrimary: submissionSpeakers.isPrimary,
              roleLabel: submissionSpeakers.roleLabel,
            })
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
        database(() =>
          db
            .select({
              id: reviewComments.id,
              authorUserId: reviewComments.authorUserId,
              authorName: users.name,
              body: reviewComments.body,
              createdAt: reviewComments.createdAt,
            })
            .from(reviewComments)
            .innerJoin(users, eq(users.id, reviewComments.authorUserId))
            .where(and(
              eq(reviewComments.eventId, input.eventId),
              eq(reviewComments.submissionId, submissionId),
            ))
            .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id)),
        ),
      ]);
      const abstract = answerRows.find(
        (answer) => answer.semanticKey === "submissionAbstract" && typeof answer.value === "string",
      )?.value;
      const primaryAnswerKeys = new Set(["submissionTitle", "submissionAbstract"]);
      const identityAnswerKeys = new Set(["speakerName", "speakerEmail"]);
      const anonymizeForReviewer = selectedRound?.blind === true && viewer.role === "reviewer";
      const visibleAnswers = answerRows
        .filter((answer) => !answer.semanticKey || !primaryAnswerKeys.has(answer.semanticKey))
        .filter((answer) => !anonymizeForReviewer || !answer.semanticKey || !identityAnswerKeys.has(answer.semanticKey))
        .map((answer) => ({
          label: answer.label,
          value: typeof answer.value === "string"
            ? answer.value
            : JSON.stringify(answer.value) ?? String(answer.value),
        }));
      const detailAssignments = assignmentRows
        .filter((assignment) => assignment.submissionId === submissionId &&
          (!relevantRoundId || assignment.roundId === relevantRoundId))
        .map((assignment) => ({
          id: assignment.id,
          reviewerUserId: assignment.reviewerUserId,
          reviewerName: assignment.reviewerName ?? "Reviewer",
          status: assignment.status,
          recusalReason: assignment.recusalReason,
          recusedAt: assignment.recusedAt ? toMillis(assignment.recusedAt) : null,
          version: assignment.version,
        }));
      const detailHumanReviews: HumanReview[] = visibleHumanReviews
        .filter((review) => review.submissionId === submissionId && (!relevantRoundId || review.roundId === relevantRoundId))
        .filter((review) =>
          peerScoresVisible(submissionId) || review.reviewerUserId === viewer.userId,
        )
        .map((review) => ({
          id: review.id,
          reviewerUserId: review.reviewerUserId!,
          reviewerName: memberRows.find((member) => member.userId === review.reviewerUserId)?.name ?? "Former committee member",
          score: visibleAggregateScore(review.score),
          scores: selectedRound ? orderedScores(selectedRound.rubric, review.scores) : [],
          comment: review.comment,
          version: review.version,
          updatedAt: toMillis(review.updatedAt),
        }))
        .sort((left, right) => left.updatedAt - right.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const aiSuggestions = reviewRows
        .filter((review) => review.ai && review.submissionId === submissionId && (!relevantRoundId || review.roundId === relevantRoundId))
        .map((review) => ({
          id: review.id,
          label: "AI suggestion — requires human confirmation" as const,
          score: visibleAggregateScore(review.score),
          scores: selectedRound ? orderedScores(selectedRound.rubric, review.scores) : [],
          comment: review.comment ?? "",
          version: review.version,
          createdAt: toMillis(review.createdAt),
          inputFields: ["title", "abstract", "rubric"] as const,
        }));
      selected = {
        ...selectedSummary,
        abstract: typeof abstract === "string" ? abstract : "",
        speakers: anonymizeForReviewer
          ? []
          : speakerRows.map((speaker) => ({
            ...speaker,
            role: speaker.roleLabel ?? (speaker.isPrimary ? "Primary presenter" : "Co-presenter"),
          })),
        answers: visibleAnswers,
        round: selectedRound ?? null,
        assignments: detailAssignments,
        reviews: detailHumanReviews,
        comments: commentRows.map((comment) => ({
          id: comment.id,
          authorUserId: comment.authorUserId,
          authorName: comment.authorName ?? "Committee member",
          body: comment.body,
          createdAt: toMillis(comment.createdAt),
        })),
        recusals: recusalRows
          .filter((recusal) => recusal.submissionId === submissionId && (!relevantRoundId || recusal.roundId === relevantRoundId))
          .map((recusal) => ({
            id: recusal.id,
            roundId: recusal.roundId,
            submissionId: recusal.submissionId,
            reviewerUserId: recusal.reviewerUserId,
            reviewerName: recusal.reviewerName ?? "Reviewer",
            reason: recusal.recusalReason,
            createdAt: toMillis(recusal.recusedAt ?? recusal.updatedAt),
          })),
        recusedByMe: assignmentRows.some((assignment) =>
          assignment.status === "recused" &&
          assignment.submissionId === submissionId &&
          assignment.reviewerUserId === viewer.userId &&
          (!relevantRoundId || assignment.roundId === relevantRoundId)
        ) && !assignmentRows.some((assignment) =>
          assignment.status === "assigned" &&
          assignment.submissionId === submissionId &&
          assignment.reviewerUserId === viewer.userId &&
          (!relevantRoundId || assignment.roundId === relevantRoundId)
        ),
        aiSuggestions,
        acceptance: yield* loadAcceptance(input.eventId, submissionId),
      };
    }

    const progress = viewer.role === "reviewer" || !selectedRound
      ? null
      : (() => {
          const roundAssignments = assignmentRows.filter((assignment) => assignment.roundId === selectedRound.id);
          const activeAssignments = roundAssignments.filter((assignment) =>
            assignment.status === "assigned"
          );
          const roundHumanReviews = visibleHumanReviews.filter((review) => review.roundId === selectedRound.id);
          const assignmentIsComplete = (assignment: typeof activeAssignments[number]) => roundHumanReviews.some(
            (review) => review.submissionId === assignment.submissionId && review.reviewerUserId === assignment.reviewerUserId,
          );
          const completedReviewCount = activeAssignments.filter(assignmentIsComplete).length;
          const recusalCount = roundAssignments.filter((assignment) => assignment.status === "recused").length;
          return {
            roundId: selectedRound.id,
            roundName: selectedRound.name,
            assignedReviewCount: activeAssignments.length,
            completedReviewCount,
            outstandingReviewCount: activeAssignments.length - completedReviewCount,
            recusalCount,
            reviewers: reviewerRows.map((reviewer) => {
              const reviewerAssignments = activeAssignments.filter((assignment) => assignment.reviewerUserId === reviewer.userId);
              const reviewerCompleted = reviewerAssignments.filter(assignmentIsComplete).length;
              return {
                reviewerUserId: reviewer.userId,
                reviewerName: reviewer.name ?? "Reviewer",
                assignedReviewCount: reviewerAssignments.length,
                completedReviewCount: reviewerCompleted,
                outstandingReviewCount: reviewerAssignments.length - reviewerCompleted,
                recusalCount: roundAssignments.filter(
                  (assignment) => assignment.status === "recused" && assignment.reviewerUserId === reviewer.userId,
                ).length,
              };
            }).sort((left, right) =>
              right.outstandingReviewCount - left.outstandingReviewCount
              || right.recusalCount - left.recusalCount
              || left.reviewerName.localeCompare(right.reviewerName)
              || left.reviewerUserId.localeCompare(right.reviewerUserId)),
            incompleteSubmissions: allSubmissionRows.flatMap((submission) => {
              const active = activeAssignments.filter((assignment) => assignment.submissionId === submission.id);
              const completed = active.filter(assignmentIsComplete);
              const outstanding = active.filter((assignment) => !assignmentIsComplete(assignment));
              const submissionRecusalCount = roundAssignments.filter(
                (assignment) => assignment.status === "recused" && assignment.submissionId === submission.id,
              ).length;
              const needsReviewer = active.length === 0 && submissionRecusalCount > 0;
              return outstanding.length > 0 || needsReviewer
                ? [{
                    submissionId: submission.id,
                    title: submission.title,
                    assignedReviewCount: active.length,
                    completedReviewCount: completed.length,
                    outstandingReviewerNames: outstanding.map((assignment) => assignment.reviewerName ?? "Reviewer").sort(),
                    recusalCount: submissionRecusalCount,
                    needsReviewer,
                  }]
                : [];
            }).sort((left, right) =>
              Number(right.needsReviewer) - Number(left.needsReviewer)
              || right.outstandingReviewerNames.length - left.outstandingReviewerNames.length
              || left.title.localeCompare(right.title)
              || left.submissionId.localeCompare(right.submissionId)),
          };
        })();

    return {
      eventId: event.id,
      eventName: event.name,
      timezone: event.timezone,
      viewerRole: viewer.role,
      viewerUserId: viewer.userId,
      reviewers: reviewerRows.map((reviewer) => ({
        userId: reviewer.userId,
        name: reviewer.name ?? "Reviewer",
      })),
      reviewerProgress,
      rounds,
      progress,
      order: input.order ?? "coverage",
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

export const exportReviewResults = (
  input: ExportReviewResultsInput,
): Effect.Effect<ExportReviewResultsOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:read"]);
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const [eventRow, round, submissionRows, reviewRows] = yield* Effect.all([
      database(() => db.select({ name: events.name }).from(events).where(eq(events.id, input.eventId)).limit(1)),
      loadRound(input.eventId, input.roundId),
      database(() => db.select({
        id: submissions.id,
        title: submissions.title,
        category: submissions.category,
        status: submissions.status,
      }).from(submissions).innerJoin(
        forms,
        and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
      ).where(and(eq(submissions.eventId, input.eventId), eq(forms.kind, "cfp"))).orderBy(asc(submissions.title))),
      database(() => db.select({
        submissionId: reviews.submissionId,
        reviewerUserId: reviews.reviewerUserId,
        reviewerName: users.name,
        score: reviews.score,
        scores: reviews.scores,
        comment: reviews.comment,
        updatedAt: reviews.updatedAt,
      }).from(reviews).leftJoin(users, eq(users.id, reviews.reviewerUserId)).where(and(
        eq(reviews.eventId, input.eventId),
        eq(reviews.roundId, input.roundId),
        eq(reviews.ai, false),
      )).orderBy(asc(users.name), asc(reviews.submissionId))),
    ]);
    const event = eventRow[0];
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventId }));
    const rows = submissionRows.flatMap<ReviewExportRow>((submission): ReviewExportRow[] => {
      const submissionReviews = reviewRows.filter((review) => review.submissionId === submission.id);
      if (submissionReviews.length === 0) {
        return [{
          submissionId: submission.id,
          title: submission.title,
          category: submission.category,
          status: submission.status,
          reviewerUserId: null,
          reviewerName: null,
          aggregateScore: null,
          responses: [],
          comment: null,
          completedAt: null,
        }];
      }
      return submissionReviews.map((review) => ({
        submissionId: submission.id,
        title: submission.title,
        category: submission.category,
        status: submission.status,
        reviewerUserId: review.reviewerUserId,
        reviewerName: review.reviewerName,
        aggregateScore: visibleAggregateScore(review.score),
        responses: orderedScores(round.rubric, review.scores),
        comment: review.comment,
        completedAt: toMillis(review.updatedAt),
      }));
    });
    return { eventName: event.name, round, rows };
  });

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

export const sendReviewReminders = (
  input: SendReviewRemindersInput,
): Effect.Effect<SendReviewRemindersOutput, AppError, Db | CurrentUser | MailQueue> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const round = yield* loadRound(input.eventId, input.roundId);
    const requestedReviewerIds = [...new Set(input.reviewerUserIds)];
    if (requestedReviewerIds.length === 0) {
      return yield* Effect.fail(new Validation({ message: "Select at least one reviewer to remind" }));
    }
    if (requestedReviewerIds.length !== input.reviewerUserIds.length) {
      return yield* Effect.fail(new Validation({ message: "Reminder recipients cannot contain duplicates" }));
    }
    const { db } = yield* Db;
    const queue = yield* MailQueue;
    const principalId = roundCommandPrincipalId(viewer);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      roundId: input.roundId,
      reviewerUserIds: [...requestedReviewerIds].sort(),
    }));
    const readReplay = (): Effect.Effect<SendReviewRemindersOutput | null, AppError> => Effect.gen(function* () {
      const [record] = yield* database(() => db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, input.eventId),
        eq(idempotencyRecords.operationId, "review.sendReminders"),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1));
      if (!record) return null;
      if (record.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different reminder audience" }));
      }
      return yield* Schema.decodeUnknown(SendReviewRemindersOutput)(record.responseBody).pipe(
        Effect.map((output) => ({ ...output, idempotent: true })),
        Effect.mapError((error) => new External({ service: "database", detail: `Invalid reminder replay: ${String(error)}` })),
      );
    });
    const replay = yield* readReplay();
    if (replay) {
      yield* queue.wake().pipe(Effect.catchAll(() => Effect.void));
      return replay;
    }

    const [eventRow, members, assignments, completed] = yield* Effect.all([
      database(() => db.select({ name: events.name, slug: events.slug }).from(events).where(eq(events.id, input.eventId)).limit(1)),
      database(() => db.select({ userId: eventMembers.userId, name: users.name, email: users.email }).from(eventMembers)
        .innerJoin(users, eq(users.id, eventMembers.userId))
        .where(and(eq(eventMembers.eventId, input.eventId), eq(eventMembers.role, "reviewer")))),
      database(() => db.select({ submissionId: reviewAssignments.submissionId, reviewerUserId: reviewAssignments.reviewerUserId })
        .from(reviewAssignments).where(and(
          eq(reviewAssignments.eventId, input.eventId),
          eq(reviewAssignments.roundId, input.roundId),
          eq(reviewAssignments.status, "assigned"),
        ))),
      database(() => db.select({ submissionId: reviews.submissionId, reviewerUserId: reviews.reviewerUserId })
        .from(reviews).where(and(eq(reviews.eventId, input.eventId), eq(reviews.roundId, input.roundId), eq(reviews.ai, false)))),
    ]);
    const event = eventRow[0];
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventId }));
    const targetSet = new Set(requestedReviewerIds);
    const pairKey = (submissionId: string, reviewerUserId: string | null) => `${submissionId}\u0000${reviewerUserId ?? ""}`;
    const completedSet = new Set(completed.map((row) => pairKey(row.submissionId, row.reviewerUserId)));
    const recipients = members.flatMap((member) => {
      if (!targetSet.has(member.userId)) return [];
      const outstandingCount = assignments.filter((assignment) =>
        assignment.reviewerUserId === member.userId &&
        !completedSet.has(pairKey(assignment.submissionId, member.userId))
      ).length;
      return outstandingCount > 0 && member.email
        ? [{ ...member, name: member.name ?? "Reviewer", outstandingCount }]
        : [];
    });
    const createdAt = now();
    const reviewUrl = `${queue.appOrigin}/e/${encodeURIComponent(event.slug)}/review?roundId=${encodeURIComponent(input.roundId)}&assignedToMe=true`;
    const rows = recipients.map((recipient, index) => {
      const snapshotId = id("mail_snapshot");
      const deliveryId = id("mail_delivery");
      const subject = `${recipient.outstandingCount} ${round.name} review${recipient.outstandingCount === 1 ? "" : "s"} outstanding`;
      const text = `Hi ${recipient.name},\n\nYou have ${recipient.outstandingCount} outstanding ${round.name} review${recipient.outstandingCount === 1 ? "" : "s"} for ${event.name}.\n\nOpen your assigned queue: ${reviewUrl}`;
      const html = `<p>Hi ${escapeHtml(recipient.name)},</p><p>You have <strong>${recipient.outstandingCount}</strong> outstanding ${escapeHtml(round.name)} review${recipient.outstandingCount === 1 ? "" : "s"} for ${escapeHtml(event.name)}.</p><p><a href="${escapeHtml(reviewUrl)}">Open your assigned queue</a></p>`;
      return {
        snapshot: {
          id: snapshotId,
          eventId: input.eventId,
          templateId: null,
          recipientUserId: recipient.userId,
          recipientEmail: recipient.email!,
          recipientName: recipient.name,
          fromEmail: queue.fromEmail,
          replyToEmail: null,
          subject,
          renderedHtml: html,
          renderedText: text,
          icsFilename: null,
          icsContent: null,
          createdAt,
        },
        delivery: {
          id: deliveryId,
          snapshotId,
          idempotencyKey: `review-reminder:${keyHash}:${index}`,
          status: "pending" as const,
          scheduledFor: createdAt,
          availableAt: createdAt,
          attemptCount: 0,
          maxAttempts: 8,
          createdAt,
        },
      };
    });
    const output: SendReviewRemindersOutput = {
      queuedCount: rows.length,
      skippedCount: targetSet.size - rows.length,
      reviewerUserIds: recipients.map((recipient) => recipient.userId),
      idempotent: false,
    };
    const idempotencyId = id("idempotency");
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: idempotencyId, eventId: input.eventId, operationId: "review.sendReminders", principalId,
        keyHash, requestHash, status: "completed", responseStatus: 202, responseBody: output,
        expiresAt: new Date(createdAt.getTime() + 86_400_000), completedAt: createdAt, createdAt,
      }),
      ...(rows.length > 0 ? [
        db.insert(mailDeliverySnapshots).values(rows.map((row) => row.snapshot)),
        db.insert(mailDeliveries).values(rows.map((row) => row.delivery)),
      ] : []),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewReminderBatch", aggregateId: idempotencyId,
        aggregateVersion: 1, eventType: "review.reminders.enqueued", audiences: [{ kind: "admins" }], payload: output,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId,
        idempotencyRecordId: idempotencyId, occurredAt: createdAt,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: input.requestId,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        action: "review.sendReminders", resourceType: "reviewRound", resourceId: input.roundId,
        before: null, after: output, metadata: { idempotencyRecordId: idempotencyId }, occurredAt: createdAt,
      }),
    ])).pipe(
      Effect.catchAll((failure) => Effect.gen(function* () {
        const committed = yield* readReplay();
        if (committed) return;
        return yield* Effect.fail(failure);
      })),
    );
    yield* queue.wake().pipe(Effect.catchAll(() => Effect.void));
    return output;
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
    const [submission, reviewer, existing, conflict] = yield* Effect.all([
      database(() =>
        db
          .select({ id: submissions.id })
          .from(submissions)
          .innerJoin(
            forms,
            and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
          )
          .where(
            and(
              eq(submissions.eventId, input.eventId),
              eq(submissions.id, input.submissionId),
              eq(forms.kind, "cfp"),
            ),
          )
          .limit(1),
      ),
      database(() => db.select({ name: users.name }).from(eventMembers).innerJoin(users, eq(users.id, eventMembers.userId)).where(and(eq(eventMembers.eventId, input.eventId), eq(eventMembers.userId, input.reviewerUserId), eq(eventMembers.role, "reviewer"))).limit(1)),
      database(() => db.select().from(reviewAssignments).where(and(
        eq(reviewAssignments.eventId, input.eventId),
        eq(reviewAssignments.roundId, input.roundId),
        eq(reviewAssignments.submissionId, input.submissionId),
        eq(reviewAssignments.reviewerUserId, input.reviewerUserId),
        eq(reviewAssignments.status, "assigned"),
      )).limit(1)),
      database(() => db.select({ id: reviewConflicts.id }).from(reviewConflicts).where(and(
        eq(reviewConflicts.eventId, input.eventId),
        eq(reviewConflicts.submissionId, input.submissionId),
        eq(reviewConflicts.reviewerUserId, input.reviewerUserId),
        eq(reviewConflicts.status, "active"),
      )).limit(1)),
    ]);
    if (!submission[0]) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    if (!reviewer[0]) return yield* Effect.fail(new Validation({ message: "Assignments require an event member with the reviewer role" }));
    if (conflict[0]) {
      return yield* Effect.fail(new Conflict({ message: "A declared conflict of interest blocks this assignment" }));
    }
    if (existing[0]) {
      if (input.expectedVersion === existing[0].version) {
        return {
          assignment: {
            id: existing[0].id,
            reviewerUserId: existing[0].reviewerUserId,
            reviewerName: reviewer[0].name ?? "Reviewer",
            status: "assigned",
            recusalReason: null,
            recusedAt: null,
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
      reviewerName: reviewer[0].name ?? "Reviewer",
      status: "assigned" as const,
      recusalReason: null,
      recusedAt: null,
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
          status: "assigned",
          recusalReason: null,
          recusedAt: null,
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

export const bulkAssignReviewers = (
  input: BulkAssignReviewersInput,
): Effect.Effect<BulkAssignReviewersOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status === "complete") {
      return yield* Effect.fail(new Conflict({ message: "Completed review rounds cannot receive new assignments" }));
    }
    const submissionIds = [...new Set(input.submissionIds)];
    const reviewerUserIds = [...new Set(input.reviewerUserIds)];
    if (submissionIds.length !== input.submissionIds.length || reviewerUserIds.length !== input.reviewerUserIds.length) {
      return yield* Effect.fail(new Validation({ message: "Bulk assignment selections cannot contain duplicates" }));
    }
    if (input.reviewsPerSubmission > reviewerUserIds.length) {
      return yield* Effect.fail(new Validation({ message: "Reviews per submission cannot exceed selected reviewers" }));
    }
    const { db } = yield* Db;
    const principalId = roundCommandPrincipalId(viewer);
    const normalizedSubmissionIds = [...submissionIds].sort();
    const normalizedReviewerUserIds = [...reviewerUserIds].sort();
    const normalizedRequest = {
      eventId: input.eventId,
      roundId: input.roundId,
      submissionIds: normalizedSubmissionIds,
      reviewerUserIds: normalizedReviewerUserIds,
      reviewsPerSubmission: input.reviewsPerSubmission,
      strategy: input.strategy,
    };
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify(normalizedRequest));
    const pairKey = (submissionId: string, reviewerUserId: string) => `${submissionId}\u0000${reviewerUserId}`;
    const requested = normalizedSubmissionIds.flatMap((submissionId, submissionIndex) => {
      const selected = input.strategy === "all"
        ? normalizedReviewerUserIds
        : Array.from({ length: input.reviewsPerSubmission }, (_, offset) =>
          normalizedReviewerUserIds[(submissionIndex * input.reviewsPerSubmission + offset) % normalizedReviewerUserIds.length]!
        );
      return selected.map((reviewerUserId) => ({ submissionId, reviewerUserId }));
    });
    const conflictRows = yield* database(() => db.select({
      submissionId: reviewConflicts.submissionId,
      reviewerUserId: reviewConflicts.reviewerUserId,
    }).from(reviewConflicts).where(and(
      eq(reviewConflicts.eventId, input.eventId),
      eq(reviewConflicts.status, "active"),
      inArray(reviewConflicts.submissionId, submissionIds),
      inArray(reviewConflicts.reviewerUserId, reviewerUserIds),
    )));
    const conflicted = new Set(conflictRows.map((row) => pairKey(row.submissionId, row.reviewerUserId)));
    const desired = requested.filter((pair) => !conflicted.has(pairKey(pair.submissionId, pair.reviewerUserId)));
    const conflictSkippedCount = requested.length - desired.length;
    type ReservationPlan = {
      readonly assignments: readonly { readonly id: string; readonly submissionId: string; readonly reviewerUserId: string }[];
      readonly changeId: string;
      readonly auditId: string;
    };
    const reservationPlan = (value: unknown): ReservationPlan | null => {
      if (!value || typeof value !== "object") return null;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.changeId !== "string" || typeof candidate.auditId !== "string" || !Array.isArray(candidate.assignments)) return null;
      const assignments = candidate.assignments.flatMap((assignment) => {
        if (!assignment || typeof assignment !== "object") return [];
        const row = assignment as Record<string, unknown>;
        return typeof row.id === "string" && typeof row.submissionId === "string" && typeof row.reviewerUserId === "string"
          ? [{ id: row.id, submissionId: row.submissionId, reviewerUserId: row.reviewerUserId }]
          : [];
      });
      return assignments.length === candidate.assignments.length
        ? { assignments, changeId: candidate.changeId, auditId: candidate.auditId }
        : null;
    };
    const readRecord = () => database(() => db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, input.eventId),
      eq(idempotencyRecords.operationId, "review.bulkAssignReviewers"),
      eq(idempotencyRecords.principalId, principalId),
      eq(idempotencyRecords.keyHash, keyHash),
    )).limit(1)).pipe(Effect.map((rows) => rows[0] ?? null));
    const decodeCompleted = (body: unknown) => Schema.decodeUnknown(BulkAssignReviewersOutput)(body).pipe(
      Effect.mapError((error) => new External({ service: "database", detail: `Invalid bulk-assignment replay: ${String(error)}` })),
    );

    let record = yield* readRecord();
    if (record?.requestHash !== undefined && record.requestHash !== requestHash) {
      return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different bulk assignment" }));
    }
    if (record?.status === "completed") {
      const replay = yield* decodeCompleted(record.responseBody);
      return { ...replay, idempotent: true };
    }

    let plan = record ? reservationPlan(record.responseBody) : null;
    let resumed = record !== null;
    if (record && !plan) {
      return yield* Effect.fail(new External({ service: "database", detail: "Invalid in-progress bulk-assignment reservation" }));
    }
    if (!record) {
      const [reviewerRows, submissionRows, existingRows] = yield* Effect.all([
        database(() => db.select({ userId: eventMembers.userId }).from(eventMembers).where(and(
          eq(eventMembers.eventId, input.eventId),
          eq(eventMembers.role, "reviewer"),
          inArray(eventMembers.userId, reviewerUserIds),
        ))),
        database(() => db.select({ id: submissions.id }).from(submissions).innerJoin(
          forms,
          and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
        ).where(and(
          eq(submissions.eventId, input.eventId),
          eq(forms.kind, "cfp"),
          inArray(submissions.id, submissionIds),
        ))),
        database(() => db.select({
          submissionId: reviewAssignments.submissionId,
          reviewerUserId: reviewAssignments.reviewerUserId,
        }).from(reviewAssignments).where(and(
          eq(reviewAssignments.eventId, input.eventId),
          eq(reviewAssignments.roundId, input.roundId),
          eq(reviewAssignments.status, "assigned"),
          inArray(reviewAssignments.submissionId, submissionIds),
          inArray(reviewAssignments.reviewerUserId, reviewerUserIds),
        ))),
      ]);
      if (reviewerRows.length !== reviewerUserIds.length) {
        return yield* Effect.fail(new Validation({ message: "Every selected reviewer must be an event member with the reviewer role" }));
      }
      if (submissionRows.length !== submissionIds.length) {
        return yield* Effect.fail(new Validation({ message: "Every selected proposal must belong to this event CFP" }));
      }
      const existing = new Set(existingRows.map((row) => pairKey(row.submissionId, row.reviewerUserId)));
      const createdAt = now();
      const idempotencyId = id("idempotency");
      const initialPlan: ReservationPlan = {
        assignments: desired
          .filter((pair) => !existing.has(pairKey(pair.submissionId, pair.reviewerUserId)))
          .map((pair) => ({ id: id("review_assignment"), ...pair })),
        changeId: id("change"),
        auditId: id("audit"),
      };
      plan = initialPlan;
      yield* database(() => db.batch([
        db.insert(idempotencyRecords).values({
          id: idempotencyId,
          eventId: input.eventId,
          operationId: "review.bulkAssignReviewers",
          principalId,
          keyHash,
          requestHash,
          status: "in_progress",
          responseStatus: null,
          responseBody: initialPlan,
          expiresAt: new Date(createdAt.getTime() + 86_400_000),
          completedAt: null,
          createdAt,
        }),
        ...(initialPlan.assignments.length > 0 ? [db.insert(reviewAssignments).values(initialPlan.assignments.map((assignment) => ({
          ...assignment,
          eventId: input.eventId,
          roundId: input.roundId,
          version: 1,
          createdAt,
          updatedAt: createdAt,
        }))).onConflictDoNothing()] : []),
      ])).pipe(
        Effect.catchAll((failure) => Effect.gen(function* () {
          const concurrent = yield* readRecord();
          if (!concurrent) return yield* Effect.fail(failure);
          if (concurrent.requestHash !== requestHash) {
            return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different bulk assignment" }));
          }
          record = concurrent;
          plan = reservationPlan(concurrent.responseBody);
          resumed = true;
          if (!plan) return yield* Effect.fail(failure);
        })),
      );
      record = record ?? (yield* readRecord());
    }

    if (!record || !plan) {
      return yield* Effect.fail(new External({ service: "database", detail: "Bulk-assignment reservation disappeared before completion" }));
    }
    const createdIds = plan.assignments.length === 0
      ? []
      : yield* database(() => db.select({ id: reviewAssignments.id }).from(reviewAssignments).where(and(
        eq(reviewAssignments.eventId, input.eventId),
        inArray(reviewAssignments.id, plan!.assignments.map((assignment) => assignment.id)),
      )));
    const activeRows = yield* database(() => db.select({
      submissionId: reviewAssignments.submissionId,
      reviewerUserId: reviewAssignments.reviewerUserId,
    }).from(reviewAssignments).where(and(
      eq(reviewAssignments.eventId, input.eventId),
      eq(reviewAssignments.roundId, input.roundId),
      eq(reviewAssignments.status, "assigned"),
      inArray(reviewAssignments.submissionId, submissionIds),
      inArray(reviewAssignments.reviewerUserId, reviewerUserIds),
    )));
    const active = new Set(activeRows.map((row) => pairKey(row.submissionId, row.reviewerUserId)));
    if (desired.some((pair) => !active.has(pairKey(pair.submissionId, pair.reviewerUserId)))) {
      return yield* Effect.fail(new External({ service: "database", detail: "Bulk assignment reservation did not produce every desired active assignment" }));
    }
    const output: BulkAssignReviewersOutput = {
      createdCount: createdIds.length,
      existingCount: desired.length - createdIds.length,
      assignmentCount: desired.length,
      conflictSkippedCount,
      idempotent: false,
    };
    const completedAt = now();
    yield* database(() => db.batch([
      db.update(idempotencyRecords).set({
        status: "completed",
        responseStatus: 200,
        responseBody: output,
        completedAt,
      }).where(and(eq(idempotencyRecords.id, record!.id), eq(idempotencyRecords.status, "in_progress"))),
      db.insert(domainChanges).values({
        id: plan!.changeId, eventId: input.eventId, aggregateType: "reviewAssignmentBatch", aggregateId: record!.id,
        aggregateVersion: 1, eventType: "review.assignments.bulkCreated", audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds }],
        payload: { roundId: input.roundId, ...output }, actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        requestId: input.requestId, idempotencyRecordId: record!.id, occurredAt: completedAt,
      }).onConflictDoNothing(),
      db.insert(auditLog).values({
        id: plan!.auditId, eventId: input.eventId, requestId: input.requestId,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        action: "review.bulkAssignReviewers", resourceType: "reviewRound", resourceId: input.roundId,
        before: null, after: { strategy: input.strategy, submissionIds, reviewerUserIds, ...output },
        metadata: { idempotencyRecordId: record!.id }, occurredAt: completedAt,
      }).onConflictDoNothing(),
    ])).pipe(
      Effect.catchAll((failure) => Effect.gen(function* () {
        const concurrent = yield* readRecord();
        if (concurrent?.status !== "completed") return yield* Effect.fail(failure);
      })),
    );
    const completed = yield* readRecord();
    if (!completed || completed.status !== "completed") {
      return yield* Effect.fail(new External({ service: "database", detail: "Bulk assignment did not finalize its idempotency record" }));
    }
    const stored = yield* decodeCompleted(completed.responseBody);
    return { ...stored, idempotent: resumed };
  });

/**
 * Deterministic load-balanced assignment: every pipeline proposal is topped up
 * to the target coverage from the reviewer pool, always choosing the least
 * loaded reviewer, never exceeding the per-reviewer cap, and never recreating
 * a pair the committee has already held in any state — a recusal permanently
 * excludes that reviewer from that proposal.
 */
export const autoDistributeReviewers = (
  input: AutoDistributeReviewersInput,
): Effect.Effect<AutoDistributeReviewersOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status === "complete") {
      return yield* Effect.fail(new Conflict({ message: "Completed review rounds cannot receive new assignments" }));
    }
    const { db } = yield* Db;
    const principalId = roundCommandPrincipalId(viewer);
    const requestedReviewerIds = input.reviewerUserIds ? [...new Set(input.reviewerUserIds)] : null;
    if (requestedReviewerIds && requestedReviewerIds.length !== input.reviewerUserIds!.length) {
      return yield* Effect.fail(new Validation({ message: "Reviewer selections cannot contain duplicates" }));
    }
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      roundId: input.roundId,
      reviewsPerSubmission: input.reviewsPerSubmission,
      perReviewerCap: input.perReviewerCap ?? null,
      reviewerUserIds: requestedReviewerIds ? [...requestedReviewerIds].sort() : null,
    }));
    const readRecord = () => database(() => db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, input.eventId),
      eq(idempotencyRecords.operationId, "review.autoDistributeReviewers"),
      eq(idempotencyRecords.principalId, principalId),
      eq(idempotencyRecords.keyHash, keyHash),
    )).limit(1)).pipe(Effect.map((rows) => rows[0] ?? null));
    const decodeCompleted = (body: unknown) => Schema.decodeUnknown(AutoDistributeReviewersOutput)(body).pipe(
      Effect.mapError((error) => new External({ service: "database", detail: `Invalid auto-distribution replay: ${String(error)}` })),
    );
    const replayFrom = (record: NonNullable<Effect.Effect.Success<ReturnType<typeof readRecord>>>) =>
      Effect.gen(function* () {
        if (record.requestHash !== requestHash) {
          return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different auto-distribution" }));
        }
        if (record.status !== "completed" || record.responseBody === null) {
          return yield* Effect.fail(new Conflict({ message: "An equivalent auto-distribution is in progress" }));
        }
        const replay = yield* decodeCompleted(record.responseBody);
        return { ...replay, idempotent: true };
      });
    const existingRecord = yield* readRecord();
    if (existingRecord) return yield* replayFrom(existingRecord);

    const memberRows = yield* database(() => db.select({ userId: eventMembers.userId }).from(eventMembers).where(and(
      eq(eventMembers.eventId, input.eventId),
      eq(eventMembers.role, "reviewer"),
    )));
    const memberIds = new Set(memberRows.map((row) => row.userId));
    if (requestedReviewerIds && requestedReviewerIds.some((userId) => !memberIds.has(userId))) {
      return yield* Effect.fail(new Validation({ message: "Every selected reviewer must be an event member with the reviewer role" }));
    }
    const reviewerPool = (requestedReviewerIds ?? [...memberIds]).sort();
    if (reviewerPool.length === 0) {
      return yield* Effect.fail(new Validation({ message: "This event has no reviewers to distribute assignments across" }));
    }
    if (input.reviewsPerSubmission > reviewerPool.length) {
      return yield* Effect.fail(new Validation({ message: "Reviews per submission cannot exceed the available reviewers" }));
    }

    const [submissionRows, assignmentRows] = yield* Effect.all([
      database(() => db.select({ id: submissions.id }).from(submissions).innerJoin(
        forms,
        and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
      ).where(and(
        eq(submissions.eventId, input.eventId),
        eq(forms.kind, "cfp"),
        inArray(submissions.status, ["submitted", "in_review"]),
      ))),
      database(() => db.select({
        submissionId: reviewAssignments.submissionId,
        reviewerUserId: reviewAssignments.reviewerUserId,
        status: reviewAssignments.status,
      }).from(reviewAssignments).where(and(
        eq(reviewAssignments.eventId, input.eventId),
        eq(reviewAssignments.roundId, input.roundId),
      ))),
    ]);

    const pairKey = (submissionId: string, reviewerUserId: string) => `${submissionId}\u0000${reviewerUserId}`;
    const paired = new Set(assignmentRows.map((row) => pairKey(row.submissionId, row.reviewerUserId)));
    const load = new Map<string, number>(reviewerPool.map((userId) => [userId, 0]));
    const coverage = new Map<string, number>();
    for (const row of assignmentRows) {
      if (row.status !== "assigned") continue;
      coverage.set(row.submissionId, (coverage.get(row.submissionId) ?? 0) + 1);
      if (load.has(row.reviewerUserId)) load.set(row.reviewerUserId, load.get(row.reviewerUserId)! + 1);
    }

    const cap = input.perReviewerCap ?? Number.POSITIVE_INFINITY;
    const targets = submissionRows.map((row) => row.id).sort((left, right) =>
      (coverage.get(left) ?? 0) - (coverage.get(right) ?? 0) || (left < right ? -1 : left > right ? 1 : 0)
    );
    const planned: { readonly id: string; readonly submissionId: string; readonly reviewerUserId: string }[] = [];
    const unfilled: { readonly submissionId: string; readonly missing: number }[] = [];
    for (const submissionId of targets) {
      let have = coverage.get(submissionId) ?? 0;
      while (have < input.reviewsPerSubmission) {
        let candidate: string | null = null;
        for (const userId of reviewerPool) {
          if (paired.has(pairKey(submissionId, userId))) continue;
          const current = load.get(userId) ?? 0;
          if (current >= cap) continue;
          if (candidate === null || current < load.get(candidate)!) candidate = userId;
        }
        if (candidate === null) break;
        planned.push({ id: id("review_assignment"), submissionId, reviewerUserId: candidate });
        paired.add(pairKey(submissionId, candidate));
        load.set(candidate, (load.get(candidate) ?? 0) + 1);
        have += 1;
      }
      if (have < input.reviewsPerSubmission) {
        unfilled.push({ submissionId, missing: input.reviewsPerSubmission - have });
      }
    }

    const output: AutoDistributeReviewersOutput = {
      roundId: input.roundId,
      createdCount: planned.length,
      satisfiedCount: targets.length - unfilled.length,
      unfilled,
      perReviewerLoad: reviewerPool.map((userId) => ({
        reviewerUserId: userId,
        assignedCount: load.get(userId) ?? 0,
      })),
      idempotent: false,
    };
    const createdAt = now();
    const recordId = id("idempotency");
    const commit = yield* Effect.either(database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: recordId,
        eventId: input.eventId,
        operationId: "review.autoDistributeReviewers",
        principalId,
        keyHash,
        requestHash,
        status: "completed",
        responseStatus: 200,
        responseBody: output,
        expiresAt: new Date(createdAt.getTime() + 86_400_000),
        completedAt: createdAt,
        createdAt,
      }),
      ...(planned.length > 0 ? [db.insert(reviewAssignments).values(planned.map((assignment) => ({
        ...assignment,
        eventId: input.eventId,
        roundId: input.roundId,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      }))).onConflictDoNothing()] : []),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewAssignmentBatch", aggregateId: recordId,
        aggregateVersion: 1, eventType: "review.assignments.autoDistributed",
        audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: reviewerPool }],
        payload: {
          roundId: input.roundId,
          createdCount: output.createdCount,
          satisfiedCount: output.satisfiedCount,
          unfilledCount: unfilled.length,
        },
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        requestId: input.requestId, idempotencyRecordId: recordId, occurredAt: createdAt,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: input.requestId,
        actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
        action: "review.autoDistributeReviewers", resourceType: "reviewRound", resourceId: input.roundId,
        before: null,
        after: {
          reviewsPerSubmission: input.reviewsPerSubmission,
          perReviewerCap: input.perReviewerCap ?? null,
          createdCount: output.createdCount,
          unfilledCount: unfilled.length,
        },
        metadata: { idempotencyRecordId: recordId }, occurredAt: createdAt,
      }),
    ])));
    if (commit._tag === "Left") {
      const concurrent = yield* readRecord();
      if (!concurrent) return yield* Effect.fail(commit.left);
      return yield* replayFrom(concurrent);
    }
    return output;
  });

export const removeAssignment = (
  input: RemoveAssignmentInput,
): Effect.Effect<typeof RemoveAssignmentOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const principalId = roundCommandPrincipalId(viewer);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      assignmentId: input.assignmentId,
      expectedVersion: input.expectedVersion,
    }));
    const readReplay = (): Effect.Effect<typeof RemoveAssignmentOutput.Type | null, AppError> =>
      Effect.gen(function* () {
        const [record] = yield* database(() =>
          db.select().from(idempotencyRecords).where(and(
            eq(idempotencyRecords.eventId, input.eventId),
            eq(idempotencyRecords.operationId, "review.removeAssignment"),
            eq(idempotencyRecords.principalId, principalId),
            eq(idempotencyRecords.keyHash, keyHash),
          )).limit(1),
        );
        if (!record) return null;
        if (record.requestHash !== requestHash) {
          return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different assignment removal" }));
        }
        if (record.status !== "completed") {
          return yield* Effect.fail(new Conflict({ message: "Assignment removal with this idempotency key is still in progress" }));
        }
        return yield* Schema.decodeUnknown(RemoveAssignmentOutput)(record.responseBody).pipe(
          Effect.map((output) => ({ ...output, idempotent: true })),
          Effect.mapError((error) => new External({ service: "database", detail: `Invalid assignment-removal replay: ${String(error)}` })),
        );
      });
    const replay = yield* readReplay();
    if (replay) return replay;

    const [current] = yield* database(() =>
      db.select({ assignment: reviewAssignments, reviewerName: users.name })
        .from(reviewAssignments)
        .innerJoin(users, eq(users.id, reviewAssignments.reviewerUserId))
        .where(and(
          eq(reviewAssignments.eventId, input.eventId),
          eq(reviewAssignments.id, input.assignmentId),
        ))
        .limit(1),
    );
    if (!current) return yield* Effect.fail(new NotFound({ entity: "reviewAssignment", id: input.assignmentId }));
    if (current.assignment.status !== "assigned" || current.assignment.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Reviewer assignment changed; reload before removing it" }));
    }
    const preservedReviews = yield* database(() =>
      db.select({ id: reviews.id }).from(reviews).where(and(
        eq(reviews.eventId, input.eventId),
        eq(reviews.roundId, current.assignment.roundId),
        eq(reviews.submissionId, current.assignment.submissionId),
        eq(reviews.reviewerUserId, current.assignment.reviewerUserId),
        eq(reviews.ai, false),
      )),
    );
    const removedAt = now();
    const removedAtMs = removedAt.getTime();
    const idempotencyId = id("idempotency");
    const nextVersion = current.assignment.version + 1;
    const output = {
      assignmentId: current.assignment.id,
      roundId: current.assignment.roundId,
      submissionId: current.assignment.submissionId,
      reviewerUserId: current.assignment.reviewerUserId,
      removedAt: removedAtMs,
      preservedReviewCount: preservedReviews.length,
      idempotent: false,
    } as const;
    const before = {
      id: current.assignment.id,
      roundId: current.assignment.roundId,
      submissionId: current.assignment.submissionId,
      reviewerUserId: current.assignment.reviewerUserId,
      reviewerName: current.reviewerName ?? "Reviewer",
      status: current.assignment.status,
      version: current.assignment.version,
    };
    const marker = and(
      eq(reviewAssignments.eventId, input.eventId),
      eq(reviewAssignments.id, input.assignmentId),
      eq(reviewAssignments.status, "assigned"),
      eq(reviewAssignments.version, input.expectedVersion),
    );
    yield* database(() => db.batch([
      db.insert(idempotencyRecords).select(db.select({
        id: sql<string>`${idempotencyId}`.as("id"),
        eventId: reviewAssignments.eventId,
        operationId: sql<string>`'review.removeAssignment'`.as("operation_id"),
        principalId: sql<string>`${principalId}`.as("principal_id"),
        keyHash: sql<string>`${keyHash}`.as("key_hash"),
        requestHash: sql<string>`${requestHash}`.as("request_hash"),
        status: sql<"completed">`'completed'`.as("status"),
        responseStatus: sql<number>`200`.as("response_status"),
        responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
        expiresAt: sql<Date>`${removedAtMs + 86_400_000}`.as("expires_at"),
        completedAt: sql<Date>`${removedAtMs}`.as("completed_at"),
        createdAt: sql<Date>`${removedAtMs}`.as("created_at"),
      }).from(reviewAssignments).where(marker)),
      db.insert(domainChanges).select(db.select({
        sequence: sql<number | null>`null`.as("sequence"),
        id: sql<string>`${id("change")}`.as("id"),
        eventId: reviewAssignments.eventId,
        aggregateType: sql<string>`'reviewAssignment'`.as("aggregate_type"),
        aggregateId: reviewAssignments.id,
        aggregateVersion: sql<number>`${nextVersion}`.as("aggregate_version"),
        eventType: sql<string>`'review.assignment.removed'`.as("event_type"),
        audiences: sql<unknown>`${JSON.stringify([{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: [current.assignment.reviewerUserId] }])}`.as("audiences"),
        payload: sql<unknown>`${JSON.stringify(output)}`.as("payload"),
        actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`${viewer.actorApiKeyId}`.as("actor_api_key_id"),
        requestId: sql<string>`${input.requestId}`.as("request_id"),
        idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
        occurredAt: sql<Date>`${removedAtMs}`.as("occurred_at"),
      }).from(reviewAssignments).where(marker)),
      db.insert(auditLog).select(db.select({
        id: sql<string>`${id("audit")}`.as("id"),
        eventId: reviewAssignments.eventId,
        requestId: sql<string>`${input.requestId}`.as("request_id"),
        actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`${viewer.actorApiKeyId}`.as("actor_api_key_id"),
        action: sql<string>`'review.removeAssignment'`.as("action"),
        resourceType: sql<string>`'reviewAssignment'`.as("resource_type"),
        resourceId: reviewAssignments.id,
        before: sql<unknown>`${JSON.stringify(before)}`.as("before"),
        after: sql<unknown>`null`.as("after"),
        metadata: sql<unknown>`${JSON.stringify({ idempotencyRecordId: idempotencyId, preservedReviewIds: preservedReviews.map(({ id: reviewId }) => reviewId) })}`.as("metadata"),
        occurredAt: sql<Date>`${removedAtMs}`.as("occurred_at"),
      }).from(reviewAssignments).where(marker)),
      db.delete(reviewAssignments).where(marker),
    ] as never));
    const stored = yield* readReplay();
    if (!stored) return yield* Effect.fail(new Conflict({ message: "Reviewer assignment changed; reload before removing it" }));
    const [storedRecord] = yield* database(() =>
      db.select({ id: idempotencyRecords.id }).from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, input.eventId),
        eq(idempotencyRecords.operationId, "review.removeAssignment"),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1),
    );
    return { ...stored, idempotent: storedRecord?.id !== idempotencyId };
  });

export const recuseAssignment = (
  input: RecuseAssignmentInput,
): Effect.Effect<typeof RecuseAssignmentOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "Reviewer recusal requires a browser session" }));
    }
    const { db } = yield* Db;
    const [current] = yield* database(() =>
      db.select({ assignment: reviewAssignments, reviewerName: users.name, roundStatus: reviewRounds.status })
        .from(reviewAssignments)
        .innerJoin(users, eq(users.id, reviewAssignments.reviewerUserId))
        .innerJoin(reviewRounds, and(
          eq(reviewRounds.eventId, reviewAssignments.eventId),
          eq(reviewRounds.id, reviewAssignments.roundId),
        ))
        .where(and(
          eq(reviewAssignments.eventId, input.eventId),
          eq(reviewAssignments.id, input.assignmentId),
        ))
        .limit(1),
    );
    if (!current) return yield* Effect.fail(new NotFound({ entity: "reviewAssignment", id: input.assignmentId }));
    if (current.assignment.reviewerUserId !== viewer.userId || viewer.role !== "reviewer") {
      return yield* Effect.fail(new Forbidden({ reason: "Only the assigned reviewer can recuse this assignment" }));
    }

    const reason = input.reason?.trim() || null;
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      assignmentId: input.assignmentId,
      expectedVersion: input.expectedVersion,
      reason,
    }));
    const readReplay = () => Effect.gen(function* () {
      const [record] = yield* database(() =>
        db.select().from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, "review.recuseAssignment"),
          eq(idempotencyRecords.principalId, viewer.userId),
          eq(idempotencyRecords.keyHash, keyHash),
        )).limit(1),
      );
      if (!record) return null;
      if (record.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different recusal" }));
      }
      if (record.status !== "completed") {
        return yield* Effect.fail(new Conflict({ message: "Recusal with this idempotency key is still in progress" }));
      }
      return yield* Schema.decodeUnknown(RecuseAssignmentOutput)(record.responseBody).pipe(
        Effect.map((output) => ({ ...output, idempotent: true })),
        Effect.mapError((error) => new External({ service: "database", detail: `Invalid recusal replay: ${String(error)}` })),
      );
    });
    const replay = yield* readReplay();
    if (replay) return replay;
    if (current.assignment.status !== "assigned" || current.assignment.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Reviewer assignment changed; reload before recusing" }));
    }
    if (current.roundStatus === "complete") {
      return yield* Effect.fail(new Conflict({ message: "Completed review-round assignments cannot be recused" }));
    }
    const [completedReview] = yield* database(() =>
      db.select({ id: reviews.id }).from(reviews).where(and(
        eq(reviews.eventId, input.eventId),
        eq(reviews.roundId, current.assignment.roundId),
        eq(reviews.submissionId, current.assignment.submissionId),
        eq(reviews.reviewerUserId, viewer.userId),
        eq(reviews.ai, false),
      )).limit(1),
    );
    if (completedReview) {
      return yield* Effect.fail(new Conflict({ message: "A completed review cannot be recused" }));
    }

    const recusedAt = now();
    const recusedAtMs = recusedAt.getTime();
    const nextVersion = current.assignment.version + 1;
    const idempotencyId = id("idempotency");
    const assignment = {
      id: current.assignment.id,
      reviewerUserId: current.assignment.reviewerUserId,
      reviewerName: current.reviewerName ?? "Reviewer",
      status: "recused" as const,
      recusalReason: reason,
      recusedAt: recusedAtMs,
      version: nextVersion,
    };
    const output = { assignment, idempotent: false } as const;
    const committedMarker = and(
      eq(reviewAssignments.eventId, input.eventId),
      eq(reviewAssignments.id, input.assignmentId),
      eq(reviewAssignments.status, "recused"),
      eq(reviewAssignments.version, nextVersion),
      eq(reviewAssignments.updatedAt, recusedAt),
    );
    const commit = database(() => db.batch([
      db.update(reviewAssignments).set({
        status: "recused",
        recusalReason: reason,
        recusedAt,
        version: nextVersion,
        updatedAt: recusedAt,
      }).where(and(
        eq(reviewAssignments.eventId, input.eventId),
        eq(reviewAssignments.id, input.assignmentId),
        eq(reviewAssignments.reviewerUserId, viewer.userId),
        eq(reviewAssignments.status, "assigned"),
        eq(reviewAssignments.version, input.expectedVersion),
        sql`exists (select 1 from review_rounds where event_id = ${input.eventId} and id = ${current.assignment.roundId} and status <> 'complete')`,
        sql`not exists (select 1 from reviews where event_id = ${input.eventId} and round_id = ${current.assignment.roundId} and submission_id = ${current.assignment.submissionId} and reviewer_user_id = ${viewer.userId} and ai = 0)`,
      )),
      db.insert(idempotencyRecords).select(db.select({
        id: sql<string>`${idempotencyId}`.as("id"),
        eventId: reviewAssignments.eventId,
        operationId: sql<string>`'review.recuseAssignment'`.as("operation_id"),
        principalId: sql<string>`${viewer.userId}`.as("principal_id"),
        keyHash: sql<string>`${keyHash}`.as("key_hash"),
        requestHash: sql<string>`${requestHash}`.as("request_hash"),
        status: sql<"completed">`'completed'`.as("status"),
        responseStatus: sql<number>`200`.as("response_status"),
        responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
        expiresAt: sql<Date>`${recusedAtMs + 86_400_000}`.as("expires_at"),
        completedAt: sql<Date>`${recusedAtMs}`.as("completed_at"),
        createdAt: sql<Date>`${recusedAtMs}`.as("created_at"),
      }).from(reviewAssignments).where(committedMarker)),
      db.insert(domainChanges).select(db.select({
        sequence: sql<number | null>`null`.as("sequence"),
        id: sql<string>`${id("change")}`.as("id"),
        eventId: reviewAssignments.eventId,
        aggregateType: sql<string>`'reviewAssignment'`.as("aggregate_type"),
        aggregateId: reviewAssignments.id,
        aggregateVersion: reviewAssignments.version,
        eventType: sql<string>`'review.assignment.recused'`.as("event_type"),
        audiences: sql<unknown>`${JSON.stringify([{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: [viewer.userId] }])}`.as("audiences"),
        payload: sql<unknown>`${JSON.stringify({ assignmentId: input.assignmentId, roundId: current.assignment.roundId, submissionId: current.assignment.submissionId, reviewerUserId: viewer.userId, reason })}`.as("payload"),
        actorUserId: sql<string>`${viewer.userId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        requestId: sql<string>`${input.requestId}`.as("request_id"),
        idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
        occurredAt: sql<Date>`${recusedAtMs}`.as("occurred_at"),
      }).from(reviewAssignments).where(committedMarker)),
      db.insert(auditLog).select(db.select({
        id: sql<string>`${id("audit")}`.as("id"),
        eventId: reviewAssignments.eventId,
        requestId: sql<string>`${input.requestId}`.as("request_id"),
        actorUserId: sql<string>`${viewer.userId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        action: sql<string>`'review.recuseAssignment'`.as("action"),
        resourceType: sql<string>`'reviewAssignment'`.as("resource_type"),
        resourceId: reviewAssignments.id,
        before: sql<unknown>`${JSON.stringify({ status: "assigned", version: current.assignment.version })}`.as("before"),
        after: sql<unknown>`${JSON.stringify(assignment)}`.as("after"),
        metadata: sql<unknown>`${JSON.stringify({ idempotencyRecordId: idempotencyId, roundId: current.assignment.roundId, submissionId: current.assignment.submissionId })}`.as("metadata"),
        occurredAt: sql<Date>`${recusedAtMs}`.as("occurred_at"),
      }).from(reviewAssignments).where(committedMarker)),
    ] as never));
    const committedHere = yield* commit.pipe(
      Effect.as(true),
      Effect.catchAll((failure) => readReplay().pipe(
        Effect.flatMap((stored) => stored ? Effect.succeed(false) : Effect.fail(failure)),
      )),
    );
    const stored = yield* readReplay();
    if (stored) {
      const [storedRecord] = yield* database(() =>
        db.select({ id: idempotencyRecords.id }).from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, "review.recuseAssignment"),
          eq(idempotencyRecords.principalId, viewer.userId),
          eq(idempotencyRecords.keyHash, keyHash),
        )).limit(1),
      );
      return { ...stored, idempotent: !committedHere || storedRecord?.id !== idempotencyId };
    }
    return yield* Effect.fail(new Conflict({ message: "Reviewer assignment changed; reload before recusing" }));
  });

export const declareReviewConflict = (
  input: DeclareReviewConflictInput,
): Effect.Effect<DeclareReviewConflictOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "Conflict declarations require a browser session" }));
    }
    if (viewer.role === "reviewer" && input.reviewerUserId !== viewer.userId) {
      return yield* Effect.fail(new Forbidden({ reason: "Reviewers can only declare their own conflicts of interest" }));
    }
    const { db } = yield* Db;
    const reason = input.reason?.trim() || null;
    const [submissionRows, memberRows] = yield* Effect.all([
      database(() =>
        db
          .select({ id: submissions.id, title: submissions.title })
          .from(submissions)
          .innerJoin(
            forms,
            and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
          )
          .where(
            and(
              eq(submissions.eventId, input.eventId),
              eq(submissions.id, input.submissionId),
              eq(forms.kind, "cfp"),
            ),
          )
          .limit(1),
      ),
      database(() => db.select({ name: users.name }).from(eventMembers).innerJoin(users, eq(users.id, eventMembers.userId)).where(and(eq(eventMembers.eventId, input.eventId), eq(eventMembers.userId, input.reviewerUserId))).limit(1)),
    ]);
    if (!submissionRows[0]) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    if (!memberRows[0]) return yield* Effect.fail(new Validation({ message: "Conflicts of interest require an event member" }));
    const submissionTitle = submissionRows[0].title;
    const reviewerName = memberRows[0].name ?? "Reviewer";

    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      submissionId: input.submissionId,
      reviewerUserId: input.reviewerUserId,
      reason,
    }));
    const readReplay = () => Effect.gen(function* () {
      const [record] = yield* database(() =>
        db.select().from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, "review.declareConflict"),
          eq(idempotencyRecords.principalId, viewer.userId),
          eq(idempotencyRecords.keyHash, keyHash),
        )).limit(1),
      );
      if (!record) return null;
      if (record.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different conflict declaration" }));
      }
      if (record.status !== "completed") {
        return yield* Effect.fail(new Conflict({ message: "Conflict declaration with this idempotency key is still in progress" }));
      }
      return yield* Schema.decodeUnknown(DeclareReviewConflictOutput)(record.responseBody).pipe(
        Effect.map((output) => ({ ...output, idempotent: true })),
        Effect.mapError((error) => new External({ service: "database", detail: `Invalid conflict-declaration replay: ${String(error)}` })),
      );
    });
    const replay = yield* readReplay();
    if (replay) return replay;

    const readActive = () => database(() => db.select().from(reviewConflicts).where(and(
      eq(reviewConflicts.eventId, input.eventId),
      eq(reviewConflicts.submissionId, input.submissionId),
      eq(reviewConflicts.reviewerUserId, input.reviewerUserId),
      eq(reviewConflicts.status, "active"),
    )).limit(1)).pipe(Effect.map((rows) => rows[0] ?? null));
    const existing = yield* readActive();
    const asExisting = (row: NonNullable<Effect.Effect.Success<ReturnType<typeof readActive>>>): DeclareReviewConflictOutput => ({
      conflict: {
        id: row.id,
        submissionId: row.submissionId,
        submissionTitle,
        reviewerUserId: row.reviewerUserId,
        reviewerName,
        reason: row.reason,
        status: "active",
        declaredAt: toMillis(row.createdAt),
        withdrawnAt: null,
        version: row.version,
      },
      recusedAssignmentIds: [],
      created: false,
      idempotent: false,
    });
    if (existing) return asExisting(existing);

    const recusable = yield* database(() =>
      db
        .select({ id: reviewAssignments.id })
        .from(reviewAssignments)
        .innerJoin(reviewRounds, and(
          eq(reviewRounds.eventId, reviewAssignments.eventId),
          eq(reviewRounds.id, reviewAssignments.roundId),
        ))
        .where(and(
          eq(reviewAssignments.eventId, input.eventId),
          eq(reviewAssignments.submissionId, input.submissionId),
          eq(reviewAssignments.reviewerUserId, input.reviewerUserId),
          eq(reviewAssignments.status, "assigned"),
          sql`${reviewRounds.status} <> 'complete'`,
          sql`not exists (select 1 from reviews where event_id = ${input.eventId} and round_id = ${reviewAssignments.roundId} and submission_id = ${input.submissionId} and reviewer_user_id = ${input.reviewerUserId} and ai = 0)`,
        )),
    );
    const recusedAssignmentIds = recusable.map((row) => row.id);
    const declaredAt = now();
    const declaredAtMs = declaredAt.getTime();
    const conflictId = id("review_conflict");
    const idempotencyId = id("idempotency");
    const conflict = {
      id: conflictId,
      submissionId: input.submissionId,
      submissionTitle,
      reviewerUserId: input.reviewerUserId,
      reviewerName,
      reason,
      status: "active" as const,
      declaredAt: declaredAtMs,
      withdrawnAt: null,
      version: 1,
    };
    const output: DeclareReviewConflictOutput = { conflict, recusedAssignmentIds, created: true, idempotent: false };
    const committedHere = yield* database(() => db.batch([
      db.insert(reviewConflicts).values({
        id: conflictId,
        eventId: input.eventId,
        submissionId: input.submissionId,
        reviewerUserId: input.reviewerUserId,
        reason,
        status: "active",
        withdrawnAt: null,
        version: 1,
        createdAt: declaredAt,
        updatedAt: declaredAt,
      }),
      ...(recusedAssignmentIds.length > 0 ? [db.update(reviewAssignments).set({
        status: "recused",
        recusalReason: reason ?? "Conflict of interest declared",
        recusedAt: declaredAt,
        version: sql`${reviewAssignments.version} + 1`,
        updatedAt: declaredAt,
      }).where(and(
        eq(reviewAssignments.eventId, input.eventId),
        inArray(reviewAssignments.id, recusedAssignmentIds),
        eq(reviewAssignments.status, "assigned"),
      ))] : []),
      db.insert(idempotencyRecords).values({
        id: idempotencyId, eventId: input.eventId, operationId: "review.declareConflict", principalId: viewer.userId,
        keyHash, requestHash, status: "completed", responseStatus: 201, responseBody: output,
        expiresAt: new Date(declaredAtMs + 86_400_000), completedAt: declaredAt, createdAt: declaredAt,
      }),
      db.insert(domainChanges).values({
        id: id("change"), eventId: input.eventId, aggregateType: "reviewConflict", aggregateId: conflictId,
        aggregateVersion: 1, eventType: "review.conflict.declared",
        audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: [input.reviewerUserId] }],
        payload: { submissionId: input.submissionId, reviewerUserId: input.reviewerUserId, reason, recusedAssignmentIds },
        actorUserId: viewer.userId, actorApiKeyId: null, requestId: input.requestId,
        idempotencyRecordId: idempotencyId, occurredAt: declaredAt,
      }),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: input.requestId,
        actorUserId: viewer.userId, actorApiKeyId: null,
        action: "review.declareConflict", resourceType: "reviewConflict", resourceId: conflictId,
        before: null, after: conflict, metadata: { idempotencyRecordId: idempotencyId, recusedAssignmentIds },
        occurredAt: declaredAt,
      }),
    ])).pipe(
      Effect.as(true),
      Effect.catchAll((failure) => Effect.gen(function* () {
        const stored = yield* readReplay();
        if (stored) return false;
        const concurrent = yield* readActive();
        if (concurrent) return false;
        return yield* Effect.fail(failure);
      })),
    );
    if (committedHere) return output;
    const stored = yield* readReplay();
    if (stored) return stored;
    const concurrent = yield* readActive();
    if (concurrent) return asExisting(concurrent);
    return yield* Effect.fail(new External({ service: "database", detail: "Conflict declaration did not commit" }));
  });

export const withdrawReviewConflict = (
  input: WithdrawReviewConflictInput,
): Effect.Effect<typeof WithdrawReviewConflictOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "Conflict withdrawals require a browser session" }));
    }
    const { db } = yield* Db;
    const [current] = yield* database(() =>
      db.select({ conflict: reviewConflicts, reviewerName: users.name, submissionTitle: submissions.title })
        .from(reviewConflicts)
        .innerJoin(users, eq(users.id, reviewConflicts.reviewerUserId))
        .innerJoin(submissions, and(
          eq(submissions.eventId, reviewConflicts.eventId),
          eq(submissions.id, reviewConflicts.submissionId),
        ))
        .where(and(
          eq(reviewConflicts.eventId, input.eventId),
          eq(reviewConflicts.id, input.conflictId),
        ))
        .limit(1),
    );
    if (!current) return yield* Effect.fail(new NotFound({ entity: "reviewConflict", id: input.conflictId }));
    if (viewer.role === "reviewer" && current.conflict.reviewerUserId !== viewer.userId) {
      return yield* Effect.fail(new Forbidden({ reason: "Reviewers can only withdraw their own conflicts of interest" }));
    }

    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      conflictId: input.conflictId,
      expectedVersion: input.expectedVersion,
    }));
    const readReplay = () => Effect.gen(function* () {
      const [record] = yield* database(() =>
        db.select().from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, "review.withdrawConflict"),
          eq(idempotencyRecords.principalId, viewer.userId),
          eq(idempotencyRecords.keyHash, keyHash),
        )).limit(1),
      );
      if (!record) return null;
      if (record.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different conflict withdrawal" }));
      }
      if (record.status !== "completed") {
        return yield* Effect.fail(new Conflict({ message: "Conflict withdrawal with this idempotency key is still in progress" }));
      }
      return yield* Schema.decodeUnknown(WithdrawReviewConflictOutput)(record.responseBody).pipe(
        Effect.map((output) => ({ ...output, idempotent: true })),
        Effect.mapError((error) => new External({ service: "database", detail: `Invalid conflict-withdrawal replay: ${String(error)}` })),
      );
    });
    const replay = yield* readReplay();
    if (replay) return replay;
    if (current.conflict.status !== "active" || current.conflict.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Conflict of interest changed; reload before withdrawing" }));
    }

    const withdrawnAt = now();
    const withdrawnAtMs = withdrawnAt.getTime();
    const nextVersion = current.conflict.version + 1;
    const idempotencyId = id("idempotency");
    const conflict = {
      id: current.conflict.id,
      submissionId: current.conflict.submissionId,
      submissionTitle: current.submissionTitle,
      reviewerUserId: current.conflict.reviewerUserId,
      reviewerName: current.reviewerName ?? "Reviewer",
      reason: current.conflict.reason,
      status: "withdrawn" as const,
      declaredAt: toMillis(current.conflict.createdAt),
      withdrawnAt: withdrawnAtMs,
      version: nextVersion,
    };
    const output = { conflict, idempotent: false } as const;
    const committedMarker = and(
      eq(reviewConflicts.eventId, input.eventId),
      eq(reviewConflicts.id, input.conflictId),
      eq(reviewConflicts.status, "withdrawn"),
      eq(reviewConflicts.version, nextVersion),
      eq(reviewConflicts.updatedAt, withdrawnAt),
    );
    const commit = database(() => db.batch([
      db.update(reviewConflicts).set({
        status: "withdrawn",
        withdrawnAt,
        version: nextVersion,
        updatedAt: withdrawnAt,
      }).where(and(
        eq(reviewConflicts.eventId, input.eventId),
        eq(reviewConflicts.id, input.conflictId),
        eq(reviewConflicts.status, "active"),
        eq(reviewConflicts.version, input.expectedVersion),
      )),
      db.insert(idempotencyRecords).select(db.select({
        id: sql<string>`${idempotencyId}`.as("id"),
        eventId: reviewConflicts.eventId,
        operationId: sql<string>`'review.withdrawConflict'`.as("operation_id"),
        principalId: sql<string>`${viewer.userId}`.as("principal_id"),
        keyHash: sql<string>`${keyHash}`.as("key_hash"),
        requestHash: sql<string>`${requestHash}`.as("request_hash"),
        status: sql<"completed">`'completed'`.as("status"),
        responseStatus: sql<number>`200`.as("response_status"),
        responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
        expiresAt: sql<Date>`${withdrawnAtMs + 86_400_000}`.as("expires_at"),
        completedAt: sql<Date>`${withdrawnAtMs}`.as("completed_at"),
        createdAt: sql<Date>`${withdrawnAtMs}`.as("created_at"),
      }).from(reviewConflicts).where(committedMarker)),
      db.insert(domainChanges).select(db.select({
        sequence: sql<number | null>`null`.as("sequence"),
        id: sql<string>`${id("change")}`.as("id"),
        eventId: reviewConflicts.eventId,
        aggregateType: sql<string>`'reviewConflict'`.as("aggregate_type"),
        aggregateId: reviewConflicts.id,
        aggregateVersion: reviewConflicts.version,
        eventType: sql<string>`'review.conflict.withdrawn'`.as("event_type"),
        audiences: sql<unknown>`${JSON.stringify([{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: [current.conflict.reviewerUserId] }])}`.as("audiences"),
        payload: sql<unknown>`${JSON.stringify({ conflictId: input.conflictId, submissionId: current.conflict.submissionId, reviewerUserId: current.conflict.reviewerUserId })}`.as("payload"),
        actorUserId: sql<string>`${viewer.userId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        requestId: sql<string>`${input.requestId}`.as("request_id"),
        idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
        occurredAt: sql<Date>`${withdrawnAtMs}`.as("occurred_at"),
      }).from(reviewConflicts).where(committedMarker)),
      db.insert(auditLog).select(db.select({
        id: sql<string>`${id("audit")}`.as("id"),
        eventId: reviewConflicts.eventId,
        requestId: sql<string>`${input.requestId}`.as("request_id"),
        actorUserId: sql<string>`${viewer.userId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        action: sql<string>`'review.withdrawConflict'`.as("action"),
        resourceType: sql<string>`'reviewConflict'`.as("resource_type"),
        resourceId: reviewConflicts.id,
        before: sql<unknown>`${JSON.stringify({ status: "active", version: current.conflict.version })}`.as("before"),
        after: sql<unknown>`${JSON.stringify(conflict)}`.as("after"),
        metadata: sql<unknown>`${JSON.stringify({ idempotencyRecordId: idempotencyId })}`.as("metadata"),
        occurredAt: sql<Date>`${withdrawnAtMs}`.as("occurred_at"),
      }).from(reviewConflicts).where(committedMarker)),
    ] as never));
    const committedHere = yield* commit.pipe(
      Effect.as(true),
      Effect.catchAll((failure) => readReplay().pipe(
        Effect.flatMap((stored) => stored ? Effect.succeed(false) : Effect.fail(failure)),
      )),
    );
    const stored = yield* readReplay();
    if (stored) {
      const [storedRecord] = yield* database(() =>
        db.select({ id: idempotencyRecords.id }).from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, "review.withdrawConflict"),
          eq(idempotencyRecords.principalId, viewer.userId),
          eq(idempotencyRecords.keyHash, keyHash),
        )).limit(1),
      );
      return { ...stored, idempotent: !committedHere || storedRecord?.id !== idempotencyId };
    }
    return yield* Effect.fail(new Conflict({ message: "Conflict of interest changed; reload before withdrawing" }));
  });

export const listReviewConflicts = (
  input: ListReviewConflictsInput,
): Effect.Effect<ListReviewConflictsOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:read"]);
    const { db } = yield* Db;
    const rows = yield* database(() =>
      db.select({ conflict: reviewConflicts, reviewerName: users.name, submissionTitle: submissions.title })
        .from(reviewConflicts)
        .innerJoin(users, eq(users.id, reviewConflicts.reviewerUserId))
        .innerJoin(submissions, and(
          eq(submissions.eventId, reviewConflicts.eventId),
          eq(submissions.id, reviewConflicts.submissionId),
        ))
        .where(and(
          eq(reviewConflicts.eventId, input.eventId),
          ...(viewer.role === "reviewer" ? [eq(reviewConflicts.reviewerUserId, viewer.userId)] : []),
          ...(input.submissionId !== undefined ? [eq(reviewConflicts.submissionId, input.submissionId)] : []),
          ...(input.status !== undefined ? [eq(reviewConflicts.status, input.status)] : []),
        ))
        .orderBy(desc(reviewConflicts.createdAt), asc(reviewConflicts.id)),
    );
    return {
      conflicts: rows.map((row) => ({
        id: row.conflict.id,
        submissionId: row.conflict.submissionId,
        submissionTitle: row.submissionTitle,
        reviewerUserId: row.conflict.reviewerUserId,
        reviewerName: row.reviewerName ?? "Reviewer",
        reason: row.conflict.reason,
        status: row.conflict.status,
        declaredAt: toMillis(row.conflict.createdAt),
        withdrawnAt: row.conflict.withdrawnAt === null ? null : toMillis(row.conflict.withdrawnAt),
        version: row.conflict.version,
      })),
    };
  });

export const saveScore = (
  input: SaveScoreInput,
): Effect.Effect<SaveScoreOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "Human scores require a browser-session event committee member" }));
    }
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status !== "active") {
      return yield* Effect.fail(new Conflict({ message: "Human scoring is available only while the review round is active" }));
    }
    yield* requireAssignedReviewer(viewer, input.eventId, input.roundId, input.submissionId);
    const scoreRecord = yield* validateScores(round.rubric, input.scores);
    const { db } = yield* Db;
    const [submission] = yield* database(() =>
      db
        .select({ status: submissions.status })
        .from(submissions)
        .innerJoin(
          forms,
          and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
        )
        .where(
          and(
            eq(submissions.eventId, input.eventId),
            eq(submissions.id, input.submissionId),
            eq(forms.kind, "cfp"),
          ),
        )
        .limit(1),
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
    const score = averageScore(round.rubric, scoreRecord);
    const persistedScore = score ?? 0;
    const [reviewerName, assignedReviewerIds] = yield* Effect.all([
      database(() => db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId)).limit(1)),
      assignedReviewerAudienceIds(input.eventId, input.roundId, input.submissionId),
    ]);
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
      ? db.update(reviews).set({ score: persistedScore, scores: scoreRecord, comment: input.comment ?? null, version, updatedAt: savedAt }).where(and(eq(reviews.id, reviewId), eq(reviews.version, input.expectedVersion)))
      : db.insert(reviews).values({ id: reviewId, eventId: input.eventId, roundId: input.roundId, submissionId: input.submissionId, reviewerUserId: viewer.userId, ai: false, score: persistedScore, scores: scoreRecord, comment: input.comment ?? null, version, createdAt: savedAt, updatedAt: savedAt });
    yield* database(() =>
      db.batch([
        writeReview,
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "review", aggregateId: reviewId,
          aggregateVersion: version, eventType: "review.score.saved",
          audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: assignedReviewerIds }],
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

const readIdempotentComment = (value: unknown) =>
  Schema.decodeUnknown(AppendReviewCommentOutput)(value).pipe(
    Effect.map((output) => ({ ...output, idempotent: true })),
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid stored review-comment output: ${String(error)}` })),
  );

export const appendReviewComment = (
  input: AppendReviewCommentInput,
): Effect.Effect<AppendReviewCommentOutput, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "API keys cannot author human committee comments" }));
    }
    const body = input.body.trim();
    if (!body) return yield* Effect.fail(new Validation({ message: "Committee comments cannot be blank" }));

    const { db } = yield* Db;
    const [activeRound] = yield* database(() => db.select({ id: reviewRounds.id }).from(reviewRounds).where(and(
      eq(reviewRounds.eventId, input.eventId),
      eq(reviewRounds.status, "active"),
    )).limit(1));
    if (viewer.role === "reviewer") {
      if (!activeRound) {
        return yield* Effect.fail(new Forbidden({ reason: "Committee comments require an active review round" }));
      }
      yield* requireAssignedReviewer(viewer, input.eventId, activeRound.id, input.submissionId);
    }
    const [submission] = yield* database(() =>
      db
        .select({ id: submissions.id })
        .from(submissions)
        .innerJoin(forms, and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)))
        .where(and(
          eq(submissions.eventId, input.eventId),
          eq(submissions.id, input.submissionId),
          eq(forms.kind, "cfp"),
        ))
        .limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));

    const principalId = viewer.userId;
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      submissionId: input.submissionId,
      body,
    }));
    const readReplay = (): Effect.Effect<AppendReviewCommentOutput | null, AppError> =>
      Effect.gen(function* () {
        const [record] = yield* database(() =>
          db.select().from(idempotencyRecords).where(and(
            eq(idempotencyRecords.eventId, input.eventId),
            eq(idempotencyRecords.operationId, "review.appendComment"),
            eq(idempotencyRecords.principalId, principalId),
            eq(idempotencyRecords.keyHash, keyHash),
          )).limit(1),
        );
        if (!record) return null;
        if (record.requestHash !== requestHash) {
          return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different committee comment" }));
        }
        if (record.status !== "completed") {
          return yield* Effect.fail(new Conflict({ message: "A committee comment with this idempotency key is still in progress" }));
        }
        return yield* readIdempotentComment(record.responseBody);
      });
    const replay = yield* readReplay();
    if (replay) return replay;

    const [authorRows, assignedReviewerIds] = yield* Effect.all([
      database(() => db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId)).limit(1)),
      activeRound
        ? assignedReviewerAudienceIds(input.eventId, activeRound.id, input.submissionId)
        : Effect.succeed([] as readonly string[]),
    ]);
    const createdAt = now();
    const commentId = id("review_comment");
    const idempotencyId = id("idempotency");
    const comment = {
      id: commentId,
      authorUserId: viewer.userId,
      authorName: authorRows[0]?.name ?? "Committee member",
      body,
      createdAt: createdAt.getTime(),
    };
    const output: AppendReviewCommentOutput = { comment, idempotent: false };

    const commit = database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: idempotencyId,
        eventId: input.eventId,
        operationId: "review.appendComment",
        principalId,
        keyHash,
        requestHash,
        status: "completed",
        responseStatus: 201,
        responseBody: output,
        expiresAt: new Date(createdAt.getTime() + 86_400_000),
        completedAt: createdAt,
        createdAt,
      }),
      db.insert(reviewComments).values({
        id: commentId,
        eventId: input.eventId,
        submissionId: input.submissionId,
        authorUserId: viewer.userId,
        body,
        createdAt,
      }),
      db.insert(domainChanges).values({
        id: id("change"),
        eventId: input.eventId,
        aggregateType: "reviewComment",
        aggregateId: commentId,
        aggregateVersion: 1,
        eventType: "review.comment.created",
        audiences: [
          { kind: "admins" },
          { kind: "reviewers", reviewerUserIds: assignedReviewerIds },
        ],
        payload: { submissionId: input.submissionId, comment },
        actorUserId: viewer.actorUserId,
        actorApiKeyId: null,
        requestId: input.requestId,
        idempotencyRecordId: idempotencyId,
        occurredAt: createdAt,
      }),
      db.insert(auditLog).values({
        id: id("audit"),
        eventId: input.eventId,
        requestId: input.requestId,
        actorUserId: viewer.actorUserId,
        actorApiKeyId: null,
        action: "review.appendComment",
        resourceType: "reviewComment",
        resourceId: commentId,
        before: null,
        after: { submissionId: input.submissionId, comment },
        metadata: { idempotencyRecordId: idempotencyId },
        occurredAt: createdAt,
      }),
    ]));

    return yield* commit.pipe(
      Effect.as(output),
      Effect.catchAll((failure) => Effect.gen(function* () {
        const committed = yield* readReplay();
        if (committed) return committed;
        return yield* Effect.fail(failure);
      })),
    );
  });

export const demoAiSuggestionJson = (title: string, criterionKeys: readonly string[]): string => JSON.stringify({
  scores: Object.fromEntries(criterionKeys.map((key) => [key, 4])),
  comment: `Strong, specific proposal about ${title}. The abstract explains CI build performance and verification techniques for monorepos, with enough concrete implementation context for a useful engineering session. Human confirmation is still required.`,
});

export const requestAiSuggestion = (
  input: RequestAiSuggestionInput,
): Effect.Effect<RequestAiSuggestionOutput, AppError, Db | CurrentUser | AiService> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status !== "active") {
      return yield* Effect.fail(new Conflict({ message: "AI suggestions are available only while the review round is active" }));
    }
    yield* requireAssignedReviewer(viewer, input.eventId, input.roundId, input.submissionId);
    const { db } = yield* Db;
    const [submission] = yield* database(() =>
      db
        .select({ title: submissions.title, status: submissions.status })
        .from(submissions)
        .innerJoin(
          forms,
          and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
        )
        .where(
          and(
            eq(submissions.eventId, input.eventId),
            eq(submissions.id, input.submissionId),
            eq(forms.kind, "cfp"),
          ),
        )
        .limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    const answerRows = yield* database(() =>
      db.select({ value: submissionAnswers.value, semanticKey: formVersionFields.semanticKey }).from(submissionAnswers)
        .innerJoin(formVersionFields, eq(formVersionFields.id, submissionAnswers.formVersionFieldId))
        .where(and(eq(submissionAnswers.eventId, input.eventId), eq(submissionAnswers.submissionId, input.submissionId)))
        .orderBy(asc(formVersionFields.order)),
    );
    const abstract = answerRows.find((answer) => answer.semanticKey === "submissionAbstract" && typeof answer.value === "string")?.value;
    if (typeof abstract !== "string" || abstract.length === 0) {
      return yield* Effect.fail(new Validation({ message: "AI review requires the published Abstract answer" }));
    }
    const principalId = roundCommandPrincipalId(viewer);
    const operationId = `review.requestAiSuggestion:${input.roundId}:${input.submissionId}`;
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      roundId: input.roundId,
      submissionId: input.submissionId,
    }));
    const readReplay = (): Effect.Effect<RequestAiSuggestionOutput | null, AppError> =>
      Effect.gen(function* () {
        const [record] = yield* database(() => db.select().from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, operationId),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.keyHash, keyHash),
        )).limit(1));
        if (!record) return null;
        if (record.requestHash !== requestHash) {
          return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different AI suggestion request" }));
        }
        if (record.status !== "completed") {
          return yield* Effect.fail(new Conflict({ message: "This AI suggestion request is already in progress or failed" }));
        }
        return yield* Schema.decodeUnknown(RequestAiSuggestionOutput)(record.responseBody).pipe(
          Effect.mapError((error) => new External({ service: "database", detail: `Invalid AI suggestion replay: ${String(error)}` })),
        );
      });
    const replay = yield* readReplay();
    if (replay) return replay;

    const claimedAt = now();
    const claimedAtMs = claimedAt.getTime();
    const claimId = id("idempotency");
    const budgetId = id("idempotency");
    const budgetOperationId = `review.requestAiSuggestion.rate:${input.roundId}:${input.submissionId}`;
    const budgetKeyHash = yield* sha256(`fixed-window:${Math.floor(claimedAtMs / 60_000)}`);
    const budgetRequestHash = yield* sha256(`${principalId}:${input.roundId}:${input.submissionId}`);
    const claimReplay = yield* database(() => db.batch([
      db.insert(idempotencyRecords).values({
        id: budgetId,
        eventId: input.eventId,
        operationId: budgetOperationId,
        principalId,
        keyHash: budgetKeyHash,
        requestHash: budgetRequestHash,
        status: "completed",
        responseStatus: 204,
        responseBody: null,
        expiresAt: new Date(claimedAtMs + 120_000),
        completedAt: claimedAt,
        createdAt: claimedAt,
      }),
      db.insert(idempotencyRecords).values({
        id: claimId,
        eventId: input.eventId,
        operationId,
        principalId,
        keyHash,
        requestHash,
        status: "in_progress",
        responseStatus: null,
        responseBody: null,
        expiresAt: new Date(claimedAtMs + 86_400_000),
        completedAt: null,
        createdAt: claimedAt,
      }),
    ])).pipe(
      Effect.as(null as RequestAiSuggestionOutput | null),
      Effect.catchAll((failure) => Effect.gen(function* () {
        const concurrentReplay = yield* readReplay();
        if (concurrentReplay) return concurrentReplay;
        const [budget] = yield* database(() => db.select({ id: idempotencyRecords.id }).from(idempotencyRecords).where(and(
          eq(idempotencyRecords.eventId, input.eventId),
          eq(idempotencyRecords.operationId, budgetOperationId),
          eq(idempotencyRecords.principalId, principalId),
          eq(idempotencyRecords.keyHash, budgetKeyHash),
        )).limit(1));
        if (budget) {
          return yield* Effect.fail(new Conflict({ message: "AI suggestions are limited to one request per submission each minute" }));
        }
        return yield* Effect.fail(failure);
      })),
    );
    if (claimReplay) return claimReplay;

    return yield* Effect.gen(function* () {
      const ai = yield* AiService;
    const prompt = JSON.stringify({
      instruction: "Return JSON only: {scores: Record<criterionKey, integer 1-5>, comment: string}. Do not decide acceptance.",
      title: submission.title,
      abstract,
      rubric: round.rubric,
    });
    const responseText = yield* ai.reviewText(prompt).pipe(
      Effect.catchAll((error) => input.eventId === "demo-event"
        ? Effect.succeed(demoAiSuggestionJson(submission.title, round.rubric.criteria.map(({ key }) => key)))
        : Effect.fail(error)),
    );
    const response = yield* Effect.try({
      try: () => JSON.parse(responseText) as unknown,
      catch: (error) => new External({ service: "ai", detail: `Invalid JSON: ${String(error)}` }),
    }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(AiResponse)(value)),
      Effect.mapError((error) => error instanceof External ? error : new External({ service: "ai", detail: `Invalid suggestion: ${String(error)}` })),
    );
    const scoreEntries = round.rubric.criteria.map((criterion): CriterionScore => {
      const suggested = response.scores[criterion.key] ?? 3;
      if (criterion.type === "dropdown") {
        const option = [...(criterion.options ?? [])].sort((left, right) =>
          Math.abs(left.score - suggested) - Math.abs(right.score - suggested)
        )[0];
        return { criterionKey: criterion.key, score: option?.value ?? String(suggested) };
      }
      if (criterion.type === "text") {
        return { criterionKey: criterion.key, score: response.comment };
      }
      return { criterionKey: criterion.key, score: suggested as CriterionScore["score"] };
    });
    const scoreRecord = yield* validateScores(round.rubric, scoreEntries);
    const createdAt = now();
    const suggestionId = id("review_ai");
    const score = averageScore(round.rubric, scoreRecord);
    const persistedScore = score ?? 0;
    const assignedReviewerIds = yield* assignedReviewerAudienceIds(
      input.eventId,
      input.roundId,
      input.submissionId,
    );
    const output: RequestAiSuggestionOutput = {
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
    yield* database(() =>
      db.batch([
        db.insert(reviews).values({ id: suggestionId, eventId: input.eventId, roundId: input.roundId, submissionId: input.submissionId, reviewerUserId: null, ai: true, score: persistedScore, scores: scoreRecord, comment: response.comment, version: 1, createdAt, updatedAt: createdAt }),
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "reviewAiSuggestion", aggregateId: suggestionId,
          aggregateVersion: 1, eventType: "review.aiSuggestion.created",
          audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: assignedReviewerIds }],
          payload: { submissionId: input.submissionId, roundId: input.roundId, inputFields: ["title", "abstract", "rubric"] },
          actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId, requestId: input.requestId, occurredAt: createdAt,
        }),
        db.insert(auditLog).values({
          id: id("audit"), eventId: input.eventId, requestId: input.requestId,
          actorUserId: viewer.actorUserId, actorApiKeyId: viewer.actorApiKeyId,
          action: "review.requestAiSuggestion", resourceType: "reviewAiSuggestion", resourceId: suggestionId,
          before: null, after: { submissionId: input.submissionId, roundId: input.roundId, inputFields: ["title", "abstract", "rubric"] }, occurredAt: createdAt,
        }),
        db.update(idempotencyRecords).set({
          status: "completed",
          responseStatus: 201,
          responseBody: output,
          completedAt: createdAt,
        }).where(and(eq(idempotencyRecords.id, claimId), eq(idempotencyRecords.status, "in_progress"))),
      ]),
    );
      return output;
    }).pipe(
      Effect.catchAll((failure) => {
        const failedAt = now();
        return database(() => db.update(idempotencyRecords).set({
          status: "failed",
          completedAt: failedAt,
        }).where(and(eq(idempotencyRecords.id, claimId), eq(idempotencyRecords.status, "in_progress")))).pipe(
          Effect.flatMap(() => Effect.fail(failure)),
        );
      }),
    );
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
    const [submission] = yield* database(() =>
      db
        .select({
          id: submissions.id,
          title: submissions.title,
          category: submissions.category,
          status: submissions.status,
          submittedAt: submissions.submittedAt,
          acceptedAt: submissions.acceptedAt,
          version: submissions.version,
        })
        .from(submissions)
        .innerJoin(
          forms,
          and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
        )
        .where(
          and(
            eq(submissions.eventId, input.eventId),
            eq(submissions.id, input.submissionId),
            eq(forms.kind, "cfp"),
          ),
        )
        .limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
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

    if (submission.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before accepting" }));
    }
    if (!isReviewDecisionSourceStatus(submission.status)) {
      return yield* Effect.fail(new Conflict({ message: `Submission status "${submission.status}" does not allow acceptance` }));
    }
    const [primarySpeaker] = yield* database(() =>
      db.select({ associationId: submissionSpeakers.id, speakerId: submissionSpeakers.speakerId }).from(submissionSpeakers).where(and(eq(submissionSpeakers.eventId, input.eventId), eq(submissionSpeakers.submissionId, input.submissionId), eq(submissionSpeakers.isPrimary, true))).limit(1),
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
          id: sql<string>`${acceptanceEventId}`.as("id"),
          eventId: submissions.eventId,
          submissionId: submissions.id,
          primarySubmissionSpeakerId: sql<string>`${primarySpeaker.associationId}`.as("primary_submission_speaker_id"),
          primarySpeakerId: sql<string>`${primarySpeaker.speakerId}`.as("primary_speaker_id"),
          primaryAssociationIsPrimary: sql<boolean>`1`.as("primary_association_is_primary"),
          type: sql<"accepted">`'accepted'`.as("type"),
          submissionVersion: submissions.version,
          actorUserId: viewer.actorUserId === null
            ? sql<string | null>`null`.as("actor_user_id")
            : sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
          occurredAt: sql<Date>`${acceptedAt.getTime()}`.as("occurred_at"),
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

    const airtableProjection = yield* database(() => prepareAirtableSubmissionProjection(db, {
      eventId: input.eventId,
      submission: {
        id: submission.id,
        title: submission.title,
        category: submission.category,
        status: "accepted",
        submittedAt: submission.submittedAt,
        version: nextVersion,
      },
      changedKeys: ["status"],
      origin: "review.acceptSubmission",
      idempotencyKey: `review.acceptSubmission:${idempotencyId}`,
      now: acceptedAt,
    }));

    const commitAcceptance = database(() =>
      db.batch([
        db.insert(idempotencyRecords).values({
          id: idempotencyId, eventId: input.eventId, operationId: "review.acceptSubmission", principalId,
          keyHash, requestHash, status: "in_progress", expiresAt: new Date(acceptedAt.getTime() + 86_400_000), createdAt: acceptedAt,
        }),
        db.update(submissions).set({ status: "accepted", pendingDecision: null, acceptedAt, version: nextVersion, updatedAt: acceptedAt }).where(and(
          eq(submissions.eventId, input.eventId),
          eq(submissions.id, input.submissionId),
          eq(submissions.version, input.expectedVersion),
          inArray(submissions.status, REVIEW_DECISION_SOURCE_STATUSES),
        )),
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
        ...(airtableProjection ? [airtableProjection.statement] : []),
      ] as never),
    );

    return yield* commitAcceptance.pipe(
      Effect.as(output),
      Effect.catchAll((batchFailure) =>
        Effect.gen(function* () {
          const [committedRequest] = yield* database(() =>
            db.select().from(idempotencyRecords).where(and(
              eq(idempotencyRecords.eventId, input.eventId),
              eq(idempotencyRecords.operationId, "review.acceptSubmission"),
              eq(idempotencyRecords.principalId, principalId),
              eq(idempotencyRecords.keyHash, keyHash),
            )).limit(1),
          );
          if (committedRequest) {
            if (committedRequest.requestHash !== requestHash) {
              return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different acceptance request" }));
            }
            if (committedRequest.status === "completed") {
              return yield* readIdempotentAcceptance(committedRequest.responseBody);
            }
            return yield* Effect.fail(new Conflict({ message: "Acceptance request with this idempotency key is already in progress" }));
          }

          const [currentSubmission] = yield* database(() =>
            db.select({ status: submissions.status, version: submissions.version }).from(submissions).where(and(
              eq(submissions.eventId, input.eventId),
              eq(submissions.id, input.submissionId),
            )).limit(1),
          );
          if (
            !currentSubmission
            || currentSubmission.version !== input.expectedVersion
            || !isReviewDecisionSourceStatus(currentSubmission.status)
          ) {
            return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before accepting" }));
          }
          return yield* Effect.fail(batchFailure);
        }),
      ),
    );
  });

const readIdempotentRejection = (value: unknown) =>
  Schema.decodeUnknown(RejectSubmissionOutput)(value).pipe(
    Effect.map((output) => ({ ...output, idempotent: true })),
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid stored rejection output: ${String(error)}` })),
  );

const readIdempotentRevocation = (value: unknown) =>
  Schema.decodeUnknown(RevokeAcceptanceOutput)(value).pipe(
    Effect.map((output) => ({ ...output, idempotent: true })),
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid stored revocation output: ${String(error)}` })),
  );

const readStagedDecision = (value: unknown) =>
  Schema.decodeUnknown(StageDecisionOutput)(value).pipe(
    Effect.map((output) => ({ ...output, idempotent: true })),
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid staged-decision replay: ${String(error)}` })),
  );

const readReleasedDecisions = (value: unknown) =>
  Schema.decodeUnknown(ReleaseDecisionsOutput)(value).pipe(
    Effect.map((output) => ({ ...output, idempotent: true })),
    Effect.mapError((error) => new External({ service: "database", detail: `Invalid decision-release replay: ${String(error)}` })),
  );

export const stageDecision = (
  input: StageDecisionInput,
): Effect.Effect<typeof StageDecisionOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write", "submissions:write"]);
    if (viewer.actorApiKeyId) return yield* Effect.fail(new Forbidden({ reason: "API keys cannot stage submission decisions" }));
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId, submissionId: input.submissionId,
      decision: input.decision, expectedVersion: input.expectedVersion,
    }));
    const replay = () => Effect.gen(function* () {
      const [record] = yield* database(() => db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, input.eventId), eq(idempotencyRecords.operationId, "review.stageDecision"),
        eq(idempotencyRecords.principalId, viewer.userId), eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1));
      if (!record) return null;
      if (record.requestHash !== requestHash) return yield* Effect.fail(new Conflict({ message: "Idempotency key was used for a different staged decision" }));
      if (record.status !== "completed") return yield* Effect.fail(new Conflict({ message: "This decision is still being staged" }));
      return yield* readStagedDecision(record.responseBody);
    });
    const prior = yield* replay();
    if (prior) return prior;
    const [submission] = yield* database(() => db.select({
      status: submissions.status, version: submissions.version, pendingDecision: submissions.pendingDecision,
    }).from(submissions).innerJoin(forms, and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId))).where(and(
      eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId), eq(forms.kind, "cfp"),
    )).limit(1));
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    if (submission.version !== input.expectedVersion || !isReviewDecisionSourceStatus(submission.status)) {
      return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before staging its decision" }));
    }
    if (input.decision === "accepted") {
      const [primary] = yield* database(() => db.select({ id: submissionSpeakers.id }).from(submissionSpeakers).where(and(
        eq(submissionSpeakers.eventId, input.eventId), eq(submissionSpeakers.submissionId, input.submissionId), eq(submissionSpeakers.isPrimary, true),
      )).limit(1));
      if (!primary) return yield* Effect.fail(new Validation({ message: "Acceptance requires exactly one primary speaker" }));
    }
    const stagedAt = now();
    const nextVersion = submission.version + 1;
    const idempotencyId = id("idempotency");
    const output = { submissionId: input.submissionId, submissionVersion: nextVersion, pendingDecision: input.decision, idempotent: false } as const;
    const marker = and(
      eq(submissions.eventId, input.eventId),
      eq(submissions.id, input.submissionId),
      eq(submissions.version, nextVersion),
      input.decision === null ? sql`${submissions.pendingDecision} is null` : eq(submissions.pendingDecision, input.decision),
    );
    const stagedBatch = yield* database(() => db.batch([
      db.update(submissions).set({ pendingDecision: input.decision, version: nextVersion, updatedAt: stagedAt }).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId), eq(submissions.version, input.expectedVersion),
        inArray(submissions.status, REVIEW_DECISION_SOURCE_STATUSES),
      )),
      db.insert(idempotencyRecords).select(db.select({
        id: sql<string>`${idempotencyId}`.as("id"), eventId: submissions.eventId, operationId: sql<string>`'review.stageDecision'`.as("operation_id"),
        principalId: sql<string>`${viewer.userId}`.as("principal_id"), keyHash: sql<string>`${keyHash}`.as("key_hash"), requestHash: sql<string>`${requestHash}`.as("request_hash"),
        status: sql<"completed">`'completed'`.as("status"), responseStatus: sql<number>`200`.as("response_status"), responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
        expiresAt: sql<Date>`${stagedAt.getTime() + 86_400_000}`.as("expires_at"), completedAt: sql<Date>`${stagedAt.getTime()}`.as("completed_at"), createdAt: sql<Date>`${stagedAt.getTime()}`.as("created_at"),
      }).from(submissions).where(marker)),
      db.insert(domainChanges).select(db.select({
        sequence: sql<number | null>`null`.as("sequence"), id: sql<string>`${id("change")}`.as("id"), eventId: submissions.eventId,
        aggregateType: sql<string>`'submission'`.as("aggregate_type"), aggregateId: submissions.id, aggregateVersion: submissions.version,
        eventType: sql<string>`'review.decision.staged'`.as("event_type"), audiences: sql<unknown>`${JSON.stringify([{ kind: "admins" }])}`.as("audiences"),
        payload: sql<unknown>`${JSON.stringify({ submissionId: input.submissionId, pendingDecision: input.decision })}`.as("payload"),
        actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"), actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        requestId: sql<string>`${input.requestId}`.as("request_id"), idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"), occurredAt: sql<Date>`${stagedAt.getTime()}`.as("occurred_at"),
      }).from(submissions).where(marker)),
      db.insert(auditLog).select(db.select({
        id: sql<string>`${id("audit")}`.as("id"), eventId: submissions.eventId, requestId: sql<string>`${input.requestId}`.as("request_id"),
        actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"), actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        action: sql<string>`'review.stageDecision'`.as("action"), resourceType: sql<string>`'submission'`.as("resource_type"), resourceId: submissions.id,
        before: sql<unknown>`${JSON.stringify({ status: submission.status, pendingDecision: submission.pendingDecision, version: submission.version })}`.as("before"),
        after: sql<unknown>`${JSON.stringify(output)}`.as("after"), metadata: sql<unknown>`${JSON.stringify({ idempotencyRecordId: idempotencyId })}`.as("metadata"), occurredAt: sql<Date>`${stagedAt.getTime()}`.as("occurred_at"),
      }).from(submissions).where(marker)),
    ] as never)).pipe(Effect.either);
    if (stagedBatch._tag === "Left") {
      const concurrent = yield* replay();
      if (concurrent) return concurrent;
      const [current] = yield* database(() => db.select({
        status: submissions.status,
        version: submissions.version,
        pendingDecision: submissions.pendingDecision,
      }).from(submissions).where(and(
        eq(submissions.eventId, input.eventId),
        eq(submissions.id, input.submissionId),
      )).limit(1));
      if (
        !current
        || current.version !== input.expectedVersion
        || !isReviewDecisionSourceStatus(current.status)
      ) {
        return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before staging its decision" }));
      }
      return yield* Effect.fail(stagedBatch.left);
    }
    const committed = yield* replay();
    if (committed) return { ...committed, idempotent: false };
    return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before staging its decision" }));
  });

export const releaseDecisions = (
  input: ReleaseDecisionsInput,
): Effect.Effect<typeof ReleaseDecisionsOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write", "submissions:write", "speakers:write"]);
    if (viewer.actorApiKeyId) return yield* Effect.fail(new Forbidden({ reason: "API keys cannot release submission decisions" }));
    yield* requireOrganizer(viewer);

    const uniqueSubmissionIds = new Set(input.decisions.map((decision) => decision.submissionId));
    if (uniqueSubmissionIds.size !== input.decisions.length) {
      return yield* Effect.fail(new Validation({ message: "Each staged decision may be released only once per request" }));
    }

    const { db } = yield* Db;
    const principalId = viewer.userId;
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({ eventId: input.eventId, decisions: input.decisions }));
    const replay = () => Effect.gen(function* () {
      const [record] = yield* database(() => db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, input.eventId),
        eq(idempotencyRecords.operationId, "review.releaseDecisions"),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1));
      if (!record) return null;
      if (record.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was used for a different decision release" }));
      }
      if (record.status !== "completed") {
        return yield* Effect.fail(new Conflict({ message: "This decision release is already in progress" }));
      }
      return yield* readReleasedDecisions(record.responseBody);
    });
    const prior = yield* replay();
    if (prior) return prior;

    const requestedJson = JSON.stringify(input.decisions);
    const submissionRows = yield* database(() => db.select({
      id: submissions.id,
      title: submissions.title,
      category: submissions.category,
      status: submissions.status,
      pendingDecision: submissions.pendingDecision,
      submittedAt: submissions.submittedAt,
      acceptedAt: submissions.acceptedAt,
      version: submissions.version,
    }).from(submissions).innerJoin(
      forms,
      and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
    ).where(and(
      eq(submissions.eventId, input.eventId),
      eq(forms.kind, "cfp"),
      sql`${submissions.id} in (select json_extract(value, '$.submissionId') from json_each(${requestedJson}))`,
    )));
    const submissionById = new Map(submissionRows.map((submission) => [submission.id, submission]));
    for (const decision of input.decisions) {
      const submission = submissionById.get(decision.submissionId);
      if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: decision.submissionId }));
      if (
        submission.version !== decision.expectedVersion
        || submission.pendingDecision !== decision.expectedDecision
        || !isReviewDecisionSourceStatus(submission.status)
      ) {
        return yield* Effect.fail(new Conflict({ message: "Staged decisions changed; reload the release queue before continuing" }));
      }
    }

    const speakerRows = yield* database(() => db.select({
      id: submissionSpeakers.id,
      submissionId: submissionSpeakers.submissionId,
      speakerId: submissionSpeakers.speakerId,
      isPrimary: submissionSpeakers.isPrimary,
    }).from(submissionSpeakers).where(and(
      eq(submissionSpeakers.eventId, input.eventId),
      sql`${submissionSpeakers.submissionId} in (select json_extract(value, '$.submissionId') from json_each(${requestedJson}))`,
    )));
    const speakersBySubmission = new Map<string, typeof speakerRows>();
    for (const speaker of speakerRows) {
      const current = speakersBySubmission.get(speaker.submissionId) ?? [];
      current.push(speaker);
      speakersBySubmission.set(speaker.submissionId, current);
    }
    for (const decision of input.decisions) {
      const primarySpeakers = (speakersBySubmission.get(decision.submissionId) ?? [])
        .filter((speaker) => speaker.isPrimary);
      if (
        decision.expectedDecision === "accepted"
        && primarySpeakers.length !== 1
      ) {
        return yield* Effect.fail(new Validation({ message: `Acceptance for ${decision.submissionId} requires exactly one primary speaker` }));
      }
    }

    const releasedAt = now();
    const releasedAtMs = releasedAt.getTime();
    const idempotencyId = id("idempotency");
    const releaseId = id("decision_release");
    const releaseRows = input.decisions.map((decision) => {
      const submission = submissionById.get(decision.submissionId)!;
      const associatedSpeakers = speakersBySubmission.get(decision.submissionId) ?? [];
      const primarySpeaker = associatedSpeakers.find((speaker) => speaker.isPrimary);
      const nextVersion = decision.expectedVersion + 1;
      const acceptanceEventId = decision.expectedDecision === "accepted" ? id("acceptance") : null;
      const provisioningId = decision.expectedDecision === "accepted" ? id("speaker_provisioning") : null;
      return {
        submissionId: decision.submissionId,
        decision: decision.expectedDecision,
        expectedVersion: decision.expectedVersion,
        nextVersion,
        acceptanceEventId,
        provisioningId,
        primarySubmissionSpeakerId: primarySpeaker?.id ?? null,
        primarySpeakerId: primarySpeaker?.speakerId ?? null,
        audiences: [
          { kind: "admins" },
          ...(associatedSpeakers.length > 0
            ? [{ kind: "speaker", speakerIds: associatedSpeakers.map((speaker) => speaker.speakerId) }]
            : []),
        ],
        before: {
          status: submission.status,
          pendingDecision: submission.pendingDecision,
          version: submission.version,
          acceptedAt: submission.acceptedAt?.getTime() ?? null,
        },
        after: {
          status: decision.expectedDecision,
          pendingDecision: null,
          version: nextVersion,
          acceptedAt: decision.expectedDecision === "accepted" ? releasedAtMs : null,
          acceptanceEventId,
          provisioningId,
        },
      };
    });
    const releaseJson = JSON.stringify(releaseRows);
    const acceptedCount = releaseRows.filter((row) => row.decision === "accepted").length;
    const rejectedCount = releaseRows.length - acceptedCount;
    const output = {
      releaseId,
      releasedCount: releaseRows.length,
      acceptedCount,
      rejectedCount,
      submissionIds: releaseRows.map((row) => row.submissionId),
      idempotent: false,
    } as const;

    const airtableProjections = yield* database(() => Promise.all(releaseRows.map((row) => {
      const submission = submissionById.get(row.submissionId)!;
      return prepareAirtableSubmissionProjection(db, {
        eventId: input.eventId,
        submission: {
          id: submission.id,
          title: submission.title,
          category: submission.category,
          status: row.decision,
          submittedAt: submission.submittedAt,
          version: row.nextVersion,
        },
        changedKeys: ["status"],
        origin: "review.releaseDecisions",
        idempotencyKey: `review.releaseDecisions:${releaseId}:${row.submissionId}`,
        now: releasedAt,
      });
    })));

    const exactRequestedDecision = sql`exists (
      select 1 from json_each(${requestedJson}) requested
      where json_extract(requested.value, '$.submissionId') = ${submissions.id}
        and cast(json_extract(requested.value, '$.expectedVersion') as integer) = ${submissions.version}
        and json_extract(requested.value, '$.expectedDecision') = ${submissions.pendingDecision}
    )`;
    const releaseGuard = sql`exists (select 1 from idempotency_records where id = ${idempotencyId})`;
    const statements: BatchItem<"sqlite">[] = [];
    statements.push(db.insert(idempotencyRecords).select(db.select({
      id: sql<string>`${idempotencyId}`.as("id"),
      eventId: submissions.eventId,
      operationId: sql<string>`'review.releaseDecisions'`.as("operation_id"),
      principalId: sql<string>`${principalId}`.as("principal_id"),
      keyHash: sql<string>`${keyHash}`.as("key_hash"),
      requestHash: sql<string>`${requestHash}`.as("request_hash"),
      status: sql<"in_progress">`'in_progress'`.as("status"),
      responseStatus: sql<number | null>`null`.as("response_status"),
      responseBody: sql<unknown>`null`.as("response_body"),
      expiresAt: sql<Date>`${releasedAtMs + 86_400_000}`.as("expires_at"),
      completedAt: sql<Date | null>`null`.as("completed_at"),
      createdAt: sql<Date>`${releasedAtMs}`.as("created_at"),
    }).from(submissions).innerJoin(
      forms,
      and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)),
    ).where(and(
      eq(submissions.eventId, input.eventId),
      eq(forms.kind, "cfp"),
      inArray(submissions.status, REVIEW_DECISION_SOURCE_STATUSES),
      exactRequestedDecision,
    )).groupBy(submissions.eventId).having(sql`count(*) = ${input.decisions.length}`)));

    const releasedDecision = sql<"accepted" | "rejected">`(
      select json_extract(release.value, '$.decision') from json_each(${releaseJson}) release
      where json_extract(release.value, '$.submissionId') = ${submissions.id}
    )`;
    const outerSubmissionId = sql.raw('"submissions"."id"');
    const outerAcceptanceEventId = sql.raw('"acceptance_events"."id"');
    const outerProvisioningId = sql.raw('"speaker_provisioning"."id"');
    statements.push(db.update(submissions).set({
      status: releasedDecision,
      pendingDecision: null,
      acceptedAt: sql`case when ${releasedDecision} = 'accepted' then ${releasedAtMs} else null end`,
      version: sql`${submissions.version} + 1`,
      updatedAt: releasedAt,
    }).where(and(
      eq(submissions.eventId, input.eventId),
      exactRequestedDecision,
      releaseGuard,
    )));

    statements.push(db.insert(acceptanceEvents).select(db.select({
      id: sql<string>`(
        select json_extract(release.value, '$.acceptanceEventId') from json_each(${releaseJson}) release
        where json_extract(release.value, '$.submissionId') = ${outerSubmissionId}
      )`.as("id"),
      eventId: submissions.eventId,
      submissionId: submissions.id,
      primarySubmissionSpeakerId: sql<string>`(
        select json_extract(release.value, '$.primarySubmissionSpeakerId') from json_each(${releaseJson}) release
        where json_extract(release.value, '$.submissionId') = ${outerSubmissionId}
      )`.as("primary_submission_speaker_id"),
      primarySpeakerId: sql<string>`(
        select json_extract(release.value, '$.primarySpeakerId') from json_each(${releaseJson}) release
        where json_extract(release.value, '$.submissionId') = ${outerSubmissionId}
      )`.as("primary_speaker_id"),
      primaryAssociationIsPrimary: sql<boolean>`1`.as("primary_association_is_primary"),
      type: sql<"accepted">`'accepted'`.as("type"),
      submissionVersion: submissions.version,
      actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
      occurredAt: sql<Date>`${releasedAtMs}`.as("occurred_at"),
    }).from(submissions).where(and(
      eq(submissions.eventId, input.eventId),
      eq(submissions.status, "accepted"),
      sql`${submissions.id} in (
        select json_extract(value, '$.submissionId') from json_each(${releaseJson})
        where json_extract(value, '$.decision') = 'accepted'
      )`,
      releaseGuard,
    ))));

    statements.push(db.insert(speakerProvisioning).select(db.select({
      id: sql<string>`(
        select json_extract(release.value, '$.provisioningId') from json_each(${releaseJson}) release
        where json_extract(release.value, '$.acceptanceEventId') = ${outerAcceptanceEventId}
      )`.as("id"),
      eventId: acceptanceEvents.eventId,
      acceptanceEventId: acceptanceEvents.id,
      submissionId: acceptanceEvents.submissionId,
      primarySpeakerId: acceptanceEvents.primarySpeakerId,
      status: sql<"pending">`'pending'`.as("status"),
      availableAt: sql<Date>`${releasedAtMs}`.as("available_at"),
      leaseOwner: sql<string | null>`null`.as("lease_owner"),
      leaseExpiresAt: sql<Date | null>`null`.as("lease_expires_at"),
      attemptCount: sql<number>`0`.as("attempt_count"),
      lastError: sql<string | null>`null`.as("last_error"),
      provisionedAt: sql<Date | null>`null`.as("provisioned_at"),
      version: sql<number>`1`.as("version"),
      createdAt: sql<Date>`${releasedAtMs}`.as("created_at"),
      updatedAt: sql<Date>`${releasedAtMs}`.as("updated_at"),
    }).from(acceptanceEvents).where(and(
      eq(acceptanceEvents.eventId, input.eventId),
      sql`${acceptanceEvents.id} in (
        select json_extract(value, '$.acceptanceEventId') from json_each(${releaseJson})
        where json_extract(value, '$.decision') = 'accepted'
      )`,
      releaseGuard,
    ))));

    statements.push(db.insert(domainChanges).select(db.select({
      sequence: sql<number | null>`null`.as("sequence"),
      id: sql<string>`('change_' || lower(hex(randomblob(12))))`.as("id"),
      eventId: submissions.eventId,
      aggregateType: sql<string>`'submission'`.as("aggregate_type"),
      aggregateId: submissions.id,
      aggregateVersion: submissions.version,
      eventType: sql<string>`case when ${submissions.status} = 'accepted' then 'review.submission.accepted' else 'review.submission.rejected' end`.as("event_type"),
      audiences: sql<unknown>`(
        select json_extract(release.value, '$.audiences') from json_each(${releaseJson}) release
        where json_extract(release.value, '$.submissionId') = ${outerSubmissionId}
      )`.as("audiences"),
      payload: sql<unknown>`(
        select json_object(
          'releaseId', ${releaseId},
          'acceptanceEventId', json_extract(release.value, '$.acceptanceEventId'),
          'submissionId', json_extract(release.value, '$.submissionId'),
          'primarySpeakerId', json_extract(release.value, '$.primarySpeakerId'),
          'submissionVersion', json_extract(release.value, '$.nextVersion')
        ) from json_each(${releaseJson}) release
        where json_extract(release.value, '$.submissionId') = ${outerSubmissionId}
      )`.as("payload"),
      actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
      requestId: sql<string>`${input.requestId}`.as("request_id"),
      idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
      occurredAt: sql<Date>`${releasedAtMs}`.as("occurred_at"),
    }).from(submissions).where(and(
      eq(submissions.eventId, input.eventId),
      sql`${submissions.id} in (select json_extract(value, '$.submissionId') from json_each(${releaseJson}))`,
      releaseGuard,
    ))));

    statements.push(db.insert(domainChanges).select(db.select({
      sequence: sql<number | null>`null`.as("sequence"),
      id: sql<string>`('change_' || lower(hex(randomblob(12))))`.as("id"),
      eventId: speakerProvisioning.eventId,
      aggregateType: sql<string>`'speakerProvisioning'`.as("aggregate_type"),
      aggregateId: speakerProvisioning.id,
      aggregateVersion: speakerProvisioning.version,
      eventType: sql<string>`'speaker.provisioning.requested'`.as("event_type"),
      audiences: sql<unknown>`(
        select json_array(json_object('kind', 'admins'), json_object('kind', 'speaker', 'speakerIds', json_array(json_extract(release.value, '$.primarySpeakerId'))))
        from json_each(${releaseJson}) release
        where json_extract(release.value, '$.provisioningId') = ${outerProvisioningId}
      )`.as("audiences"),
      payload: sql<unknown>`(
        select json_object(
          'releaseId', ${releaseId},
          'acceptanceEventId', json_extract(release.value, '$.acceptanceEventId'),
          'provisioningId', json_extract(release.value, '$.provisioningId'),
          'submissionId', json_extract(release.value, '$.submissionId'),
          'primarySpeakerId', json_extract(release.value, '$.primarySpeakerId'),
          'status', 'pending'
        ) from json_each(${releaseJson}) release
        where json_extract(release.value, '$.provisioningId') = ${outerProvisioningId}
      )`.as("payload"),
      actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
      requestId: sql<string>`${input.requestId}`.as("request_id"),
      idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
      occurredAt: sql<Date>`${releasedAtMs}`.as("occurred_at"),
    }).from(speakerProvisioning).where(and(
      eq(speakerProvisioning.eventId, input.eventId),
      sql`${speakerProvisioning.id} in (
        select json_extract(value, '$.provisioningId') from json_each(${releaseJson})
        where json_extract(value, '$.decision') = 'accepted'
      )`,
      releaseGuard,
    ))));

    statements.push(db.insert(domainChanges).select(db.select({
      sequence: sql<number | null>`null`.as("sequence"),
      id: sql<string>`('change_' || lower(hex(randomblob(12))))`.as("id"),
      eventId: idempotencyRecords.eventId,
      aggregateType: sql<string>`'decisionRelease'`.as("aggregate_type"),
      aggregateId: sql<string>`${releaseId}`.as("aggregate_id"),
      aggregateVersion: sql<number>`1`.as("aggregate_version"),
      eventType: sql<string>`'review.decisions.released'`.as("event_type"),
      audiences: sql<unknown>`${JSON.stringify([{ kind: "admins" }])}`.as("audiences"),
      payload: sql<unknown>`${JSON.stringify(output)}`.as("payload"),
      actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
      requestId: sql<string>`${input.requestId}`.as("request_id"),
      idempotencyRecordId: idempotencyRecords.id,
      occurredAt: sql<Date>`${releasedAtMs}`.as("occurred_at"),
    }).from(idempotencyRecords).where(eq(idempotencyRecords.id, idempotencyId))));

    statements.push(db.insert(auditLog).select(db.select({
      id: sql<string>`('audit_' || lower(hex(randomblob(12))))`.as("id"),
      eventId: submissions.eventId,
      requestId: sql<string>`${input.requestId}`.as("request_id"),
      actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
      actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
      action: sql<string>`'review.releaseDecisions'`.as("action"),
      resourceType: sql<string>`'submission'`.as("resource_type"),
      resourceId: submissions.id,
      before: sql<unknown>`(
        select json_extract(release.value, '$.before') from json_each(${releaseJson}) release
        where json_extract(release.value, '$.submissionId') = ${outerSubmissionId}
      )`.as("before"),
      after: sql<unknown>`(
        select json_extract(release.value, '$.after') from json_each(${releaseJson}) release
        where json_extract(release.value, '$.submissionId') = ${outerSubmissionId}
      )`.as("after"),
      metadata: sql<unknown>`${JSON.stringify({ idempotencyRecordId: idempotencyId, releaseId, releaseSize: releaseRows.length })}`.as("metadata"),
      occurredAt: sql<Date>`${releasedAtMs}`.as("occurred_at"),
    }).from(submissions).where(and(
      eq(submissions.eventId, input.eventId),
      sql`${submissions.id} in (select json_extract(value, '$.submissionId') from json_each(${releaseJson}))`,
      releaseGuard,
    ))));

    statements.push(...airtableProjections.flatMap((projection) => projection ? [projection.statement] : []));
    statements.push(db.update(idempotencyRecords).set({
      status: "completed",
      responseStatus: 200,
      responseBody: output,
      completedAt: releasedAt,
    }).where(eq(idempotencyRecords.id, idempotencyId)));

    const committedBatch = yield* database(() => db.batch(statements as never)).pipe(Effect.either);
    if (committedBatch._tag === "Left") {
      const concurrent = yield* replay();
      if (concurrent) return concurrent;
      const currentRows = yield* database(() => db.select({
        id: submissions.id,
        status: submissions.status,
        pendingDecision: submissions.pendingDecision,
        version: submissions.version,
      }).from(submissions).where(and(
        eq(submissions.eventId, input.eventId),
        sql`${submissions.id} in (select json_extract(value, '$.submissionId') from json_each(${requestedJson}))`,
      )));
      const currentById = new Map(currentRows.map((row) => [row.id, row]));
      if (input.decisions.some((decision) => {
        const current = currentById.get(decision.submissionId);
        return !current
          || current.version !== decision.expectedVersion
          || current.pendingDecision !== decision.expectedDecision
          || !isReviewDecisionSourceStatus(current.status);
      })) {
        return yield* Effect.fail(new Conflict({ message: "Staged decisions changed; no decisions were released" }));
      }
      return yield* Effect.fail(committedBatch.left);
    }
    const committed = yield* replay();
    if (committed) return { ...committed, idempotent: false };
    return yield* Effect.fail(new Conflict({ message: "Staged decisions changed; no decisions were released" }));
  });

export const revokeAcceptance = (
  input: RevokeAcceptanceInput,
): Effect.Effect<typeof RevokeAcceptanceOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write", "submissions:write", "speakers:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "API keys cannot revoke submission acceptances" }));
    }
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const [submission] = yield* database(() =>
      db
        .select({ id: submissions.id, status: submissions.status, acceptedAt: submissions.acceptedAt, version: submissions.version })
        .from(submissions)
        .innerJoin(forms, and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)))
        .where(and(
          eq(submissions.eventId, input.eventId),
          eq(submissions.id, input.submissionId),
          eq(forms.kind, "cfp"),
        ))
        .limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));

    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      submissionId: input.submissionId,
      expectedVersion: input.expectedVersion,
    }));
    const principalId = viewer.userId;
    const [replay] = yield* database(() =>
      db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, input.eventId),
        eq(idempotencyRecords.operationId, "review.revokeAcceptance"),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1),
    );
    if (replay) {
      if (replay.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different revocation request" }));
      }
      if (replay.status === "completed") return yield* readIdempotentRevocation(replay.responseBody);
      return yield* Effect.fail(new Conflict({ message: "Revocation request with this idempotency key is already in progress" }));
    }
    if (submission.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before undoing acceptance" }));
    }
    if (submission.status !== "accepted") {
      return yield* Effect.fail(new Conflict({ message: "Submission is not currently accepted" }));
    }

    const [accepted] = yield* database(() =>
      db.select().from(acceptanceEvents).where(and(
        eq(acceptanceEvents.eventId, input.eventId),
        eq(acceptanceEvents.submissionId, input.submissionId),
        eq(acceptanceEvents.type, "accepted"),
      )).orderBy(desc(acceptanceEvents.occurredAt), desc(acceptanceEvents.id)).limit(1),
    );
    if (!accepted) {
      return yield* Effect.fail(new External({ service: "database", detail: "Accepted submission has no durable acceptance fact" }));
    }
    const [provisioning] = yield* database(() =>
      db.select().from(speakerProvisioning).where(and(
        eq(speakerProvisioning.eventId, input.eventId),
        eq(speakerProvisioning.acceptanceEventId, accepted.id),
      )).limit(1),
    );
    if (!provisioning) {
      return yield* Effect.fail(new External({ service: "database", detail: "Accepted submission has no provisioning fact" }));
    }

    const revokedAt = now();
    const revokedAtMs = revokedAt.getTime();
    const nextVersion = submission.version + 1;
    const revocationEventId = id("acceptance");
    const idempotencyId = id("idempotency");
    const output = {
      revocationEventId,
      submissionId: submission.id,
      submissionVersion: nextVersion,
      status: "in_review" as const,
      provisioningStatus: "revoked" as const,
      idempotent: false,
    };

    yield* database(() => db.batch([
      db.update(submissions).set({ status: "in_review", pendingDecision: null, acceptedAt: null, version: nextVersion, updatedAt: revokedAt }).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId),
        eq(submissions.version, input.expectedVersion), eq(submissions.status, "accepted"),
      )),
      db.insert(idempotencyRecords).select(db.select({
        id: sql<string>`${idempotencyId}`.as("id"), eventId: submissions.eventId,
        operationId: sql<string>`'review.revokeAcceptance'`.as("operation_id"),
        principalId: sql<string>`${principalId}`.as("principal_id"), keyHash: sql<string>`${keyHash}`.as("key_hash"),
        requestHash: sql<string>`${requestHash}`.as("request_hash"), status: sql<"completed">`'completed'`.as("status"),
        responseStatus: sql<number>`200`.as("response_status"), responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
        expiresAt: sql<Date>`${revokedAtMs + 86_400_000}`.as("expires_at"), completedAt: sql<Date>`${revokedAtMs}`.as("completed_at"),
        createdAt: sql<Date>`${revokedAtMs}`.as("created_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId),
        eq(submissions.version, nextVersion), eq(submissions.status, "in_review"), sql`changes() > 0`,
      ))),
      db.insert(acceptanceEvents).select(db.select({
        id: sql<string>`${revocationEventId}`.as("id"), eventId: submissions.eventId, submissionId: submissions.id,
        primarySubmissionSpeakerId: sql<string>`${accepted.primarySubmissionSpeakerId}`.as("primary_submission_speaker_id"),
        primarySpeakerId: sql<string>`${accepted.primarySpeakerId}`.as("primary_speaker_id"),
        primaryAssociationIsPrimary: sql<boolean>`1`.as("primary_association_is_primary"),
        type: sql<"revoked">`'revoked'`.as("type"), submissionVersion: submissions.version,
        actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"), occurredAt: sql<Date>`${revokedAtMs}`.as("occurred_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId),
        sql`exists (select 1 from idempotency_records where id = ${idempotencyId})`,
      ))),
      db.update(speakerProvisioning).set({ status: "revoked", leaseOwner: null, leaseExpiresAt: null, version: provisioning.version + 1, updatedAt: revokedAt }).where(and(
        eq(speakerProvisioning.eventId, input.eventId), eq(speakerProvisioning.id, provisioning.id),
        eq(speakerProvisioning.version, provisioning.version),
        sql`exists (select 1 from acceptance_events where id = ${revocationEventId})`,
      )),
      db.insert(domainChanges).values([
        {
          id: id("change"), eventId: input.eventId, aggregateType: "submission", aggregateId: input.submissionId,
          aggregateVersion: nextVersion, eventType: "review.submission.acceptanceRevoked",
          audiences: [{ kind: "admins" }, { kind: "speaker", speakerIds: [accepted.primarySpeakerId] }],
          payload: { acceptanceEventId: accepted.id, revocationEventId, submissionId: input.submissionId, submissionVersion: nextVersion },
          actorUserId: viewer.actorUserId, actorApiKeyId: null, requestId: input.requestId, idempotencyRecordId: idempotencyId, occurredAt: revokedAt,
        },
        {
          id: id("change"), eventId: input.eventId, aggregateType: "speakerProvisioning", aggregateId: provisioning.id,
          aggregateVersion: provisioning.version + 1, eventType: "speaker.provisioning.revoked",
          audiences: [{ kind: "admins" }, { kind: "speaker", speakerIds: [accepted.primarySpeakerId] }],
          payload: { acceptanceEventId: accepted.id, provisioningId: provisioning.id, submissionId: input.submissionId, status: "revoked" },
          actorUserId: viewer.actorUserId, actorApiKeyId: null, requestId: input.requestId, idempotencyRecordId: idempotencyId, occurredAt: revokedAt,
        },
      ]),
      db.insert(auditLog).values({
        id: id("audit"), eventId: input.eventId, requestId: input.requestId, actorUserId: viewer.actorUserId, actorApiKeyId: null,
        action: "review.revokeAcceptance", resourceType: "submission", resourceId: input.submissionId,
        before: { status: "accepted", version: submission.version, acceptedAt: submission.acceptedAt?.getTime() ?? null, acceptanceEventId: accepted.id, provisioningStatus: provisioning.status },
        after: { status: "in_review", version: nextVersion, acceptedAt: null, revocationEventId, provisioningStatus: "revoked" },
        metadata: { idempotencyRecordId: idempotencyId }, occurredAt: revokedAt,
      }),
    ])).pipe(
      Effect.catchAll((failure) =>
        Effect.gen(function* () {
          const [committed] = yield* database(() => db.select().from(idempotencyRecords).where(eq(idempotencyRecords.id, idempotencyId)).limit(1));
          if (committed?.status === "completed") return;
          const [current] = yield* database(() => db.select({ version: submissions.version }).from(submissions).where(and(eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId))).limit(1));
          if (!current || current.version !== input.expectedVersion) {
            return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before undoing acceptance" }));
          }
          return yield* Effect.fail(failure);
        }),
      ),
    );

    const [committed] = yield* database(() => db.select().from(idempotencyRecords).where(eq(idempotencyRecords.id, idempotencyId)).limit(1));
    if (!committed) return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before undoing acceptance" }));
    return output;
  });

export const rejectSubmission = (
  input: RejectSubmissionInput,
): Effect.Effect<typeof RejectSubmissionOutput.Type, AppError, Db | CurrentUser> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write", "submissions:write"]);
    if (viewer.actorApiKeyId) {
      return yield* Effect.fail(new Forbidden({ reason: "API keys cannot reject submissions" }));
    }
    yield* requireOrganizer(viewer);
    const { db } = yield* Db;
    const [submission] = yield* database(() =>
      db
        .select({ id: submissions.id, status: submissions.status, version: submissions.version })
        .from(submissions)
        .innerJoin(forms, and(eq(forms.eventId, submissions.eventId), eq(forms.id, submissions.formId)))
        .where(and(
          eq(submissions.eventId, input.eventId),
          eq(submissions.id, input.submissionId),
          eq(forms.kind, "cfp"),
        ))
        .limit(1),
    );
    if (!submission) return yield* Effect.fail(new NotFound({ entity: "submission", id: input.submissionId }));
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      submissionId: input.submissionId,
      expectedVersion: input.expectedVersion,
    }));
    const principalId = viewer.userId;
    const [replay] = yield* database(() =>
      db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.eventId, input.eventId),
        eq(idempotencyRecords.operationId, "review.rejectSubmission"),
        eq(idempotencyRecords.principalId, principalId),
        eq(idempotencyRecords.keyHash, keyHash),
      )).limit(1),
    );
    if (replay) {
      if (replay.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different rejection request" }));
      }
      if (replay.status === "completed") return yield* readIdempotentRejection(replay.responseBody);
      return yield* Effect.fail(new Conflict({ message: "Rejection request with this idempotency key is already in progress" }));
    }
    if (submission.version !== input.expectedVersion) {
      return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before rejecting" }));
    }
    if (!isReviewDecisionSourceStatus(submission.status)) {
      return yield* Effect.fail(new Conflict({ message: `Submission status "${submission.status}" does not allow rejection` }));
    }
    const speakerRows = yield* database(() =>
      db.select({ speakerId: submissionSpeakers.speakerId }).from(submissionSpeakers).where(and(
        eq(submissionSpeakers.eventId, input.eventId), eq(submissionSpeakers.submissionId, input.submissionId),
      )),
    );
    const rejectedAt = now();
    const rejectedAtMs = rejectedAt.getTime();
    const nextVersion = submission.version + 1;
    const idempotencyId = id("idempotency");
    const output = {
      submissionId: submission.id,
      submissionVersion: nextVersion,
      status: "rejected" as const,
      idempotent: false,
    };
    yield* database(() => db.batch([
      db.update(submissions).set({ status: "rejected", pendingDecision: null, acceptedAt: null, version: nextVersion, updatedAt: rejectedAt }).where(and(
        eq(submissions.eventId, input.eventId),
        eq(submissions.id, input.submissionId),
        eq(submissions.version, input.expectedVersion),
        inArray(submissions.status, REVIEW_DECISION_SOURCE_STATUSES),
      )),
      db.insert(idempotencyRecords).select(db.select({
        id: sql<string>`${idempotencyId}`.as("id"), eventId: submissions.eventId,
        operationId: sql<string>`'review.rejectSubmission'`.as("operation_id"),
        principalId: sql<string>`${principalId}`.as("principal_id"), keyHash: sql<string>`${keyHash}`.as("key_hash"),
        requestHash: sql<string>`${requestHash}`.as("request_hash"), status: sql<"completed">`'completed'`.as("status"),
        responseStatus: sql<number>`200`.as("response_status"), responseBody: sql<unknown>`${JSON.stringify(output)}`.as("response_body"),
        expiresAt: sql<Date>`${rejectedAtMs + 86_400_000}`.as("expires_at"), completedAt: sql<Date>`${rejectedAtMs}`.as("completed_at"),
        createdAt: sql<Date>`${rejectedAtMs}`.as("created_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId), eq(submissions.version, nextVersion), sql`changes() > 0`,
      ))),
      db.insert(domainChanges).select(db.select({
        sequence: sql<number | null>`null`.as("sequence"), id: sql<string>`${id("change")}`.as("id"),
        eventId: submissions.eventId, aggregateType: sql<string>`'submission'`.as("aggregate_type"), aggregateId: submissions.id,
        aggregateVersion: submissions.version, eventType: sql<string>`'review.submission.rejected'`.as("event_type"),
        audiences: sql<unknown>`${JSON.stringify([{ kind: "admins" }, { kind: "speaker", speakerIds: speakerRows.map((row) => row.speakerId) }])}`.as("audiences"),
        payload: sql<unknown>`${JSON.stringify({ submissionId: input.submissionId, submissionVersion: nextVersion })}`.as("payload"),
        actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"), actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"),
        requestId: sql<string>`${input.requestId}`.as("request_id"), idempotencyRecordId: sql<string>`${idempotencyId}`.as("idempotency_record_id"),
        occurredAt: sql<Date>`${rejectedAtMs}`.as("occurred_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId),
        sql`exists (select 1 from idempotency_records where id = ${idempotencyId})`,
      ))),
      db.insert(auditLog).select(db.select({
        id: sql<string>`${id("audit")}`.as("id"), eventId: submissions.eventId,
        requestId: sql<string>`${input.requestId}`.as("request_id"), actorUserId: sql<string | null>`${viewer.actorUserId}`.as("actor_user_id"),
        actorApiKeyId: sql<string | null>`null`.as("actor_api_key_id"), action: sql<string>`'review.rejectSubmission'`.as("action"),
        resourceType: sql<string>`'submission'`.as("resource_type"), resourceId: submissions.id,
        before: sql<unknown>`${JSON.stringify({ status: submission.status, version: submission.version })}`.as("before"),
        after: sql<unknown>`${JSON.stringify({ status: "rejected", version: nextVersion })}`.as("after"),
        metadata: sql<unknown>`${JSON.stringify({ idempotencyRecordId: idempotencyId })}`.as("metadata"), occurredAt: sql<Date>`${rejectedAtMs}`.as("occurred_at"),
      }).from(submissions).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId),
        sql`exists (select 1 from idempotency_records where id = ${idempotencyId})`,
      ))),
    ] as never)).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error): error is External => error.detail?.includes("idempotency_key_unique") === true
          || error.detail?.includes("UNIQUE constraint failed: idempotency_records.event_id") === true,
        () => Effect.succeed(false),
      ),
    );
    const [committed] = yield* database(() => db.select().from(idempotencyRecords).where(eq(idempotencyRecords.id, idempotencyId)).limit(1));
    if (committed) return output;
    const [concurrent] = yield* database(() => db.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.eventId, input.eventId),
      eq(idempotencyRecords.operationId, "review.rejectSubmission"),
      eq(idempotencyRecords.principalId, principalId),
      eq(idempotencyRecords.keyHash, keyHash),
    )).limit(1));
    if (concurrent) {
      if (concurrent.requestHash !== requestHash) {
        return yield* Effect.fail(new Conflict({ message: "Idempotency key was already used for a different rejection request" }));
      }
      if (concurrent.status === "completed") return yield* readIdempotentRejection(concurrent.responseBody);
    }
    return yield* Effect.fail(new Conflict({ message: "Submission changed; reload before rejecting" }));
  });
