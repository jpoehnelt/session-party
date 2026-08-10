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
  reviewAssignments,
  reviewComments,
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
  type CriterionScore,
  CreateReviewRoundOutput,
  type CreateReviewRoundInput,
  type GetWorkbenchInput,
  type HumanReview,
  type RequestAiSuggestionInput,
  type RequestAiSuggestionOutput,
  RejectSubmissionOutput,
  type RejectSubmissionInput,
  RevokeAcceptanceOutput,
  type RevokeAcceptanceInput,
  ReviewRubric,
  type ReviewRubric as ReviewRubricType,
  type ReviewRound,
  type ReviewWorkbench,
  type SaveScoreInput,
  type SaveScoreOutput,
  type SubmissionReviewDetail,
  type SubmissionReviewSummary,
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

const roundFromRow = (
  row: typeof reviewRounds.$inferSelect,
  rubric: ReviewRubricType,
): ReviewRound => ({
  id: row.id,
  name: row.name,
  order: row.order,
  status: row.status,
  rubric,
  version: row.version,
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
    criteria.push({
      key,
      label,
      ...(criterion.description?.trim() ? { description: criterion.description.trim() } : {}),
      max: 5,
    });
  }
  return Effect.succeed({ criteria: [criteria[0]!, ...criteria.slice(1)] });
};

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
    const rubric = yield* normalizeRoundRubric(input.rubric);
    const { db } = yield* Db;
    const principalId = roundCommandPrincipalId(viewer);
    const keyHash = yield* sha256(input.idempotencyKey);
    const requestHash = yield* sha256(JSON.stringify({
      eventId: input.eventId,
      name,
      initialStatus: input.initialStatus,
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
      db
        .select({
          id: submissions.id,
          title: submissions.title,
          category: submissions.category,
          status: submissions.status,
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
    if (input.assignedToMe) {
      submissionRows = submissionRows.filter((submission) => reviewerSubmissionIds.has(submission.id));
    }
    if (input.status) submissionRows = submissionRows.filter((submission) => submission.status === input.status);
    if (input.category) submissionRows = submissionRows.filter((submission) => submission.category === input.category);

    const reviewRows = yield* database(() =>
      db.select().from(reviews).where(eq(reviews.eventId, input.eventId)),
    );
    const visibleHumanReviews = reviewRows.filter((review) => !review.ai);
    const summaries = submissionRows.map((submission): SubmissionReviewSummary => {
      const assignments = assignmentRows.filter(
        (assignment) => assignment.submissionId === submission.id && (!relevantRoundId || assignment.roundId === relevantRoundId),
      );
      const humanReviews = visibleHumanReviews.filter(
        (review) => review.submissionId === submission.id && (!relevantRoundId || review.roundId === relevantRoundId),
      );
      const score = humanReviews.length === 0
        ? null
        : humanReviews.reduce((total, review) => total + review.score, 0) / humanReviews.length;
      const reviewState = humanReviews.length > 0
        ? assignments.length > 0 && humanReviews.length >= assignments.length
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
        submittedAt: toMillis(submission.submittedAt),
        version: submission.version,
        reviewState,
        assignedToMe: reviewerSubmissionIds.has(submission.id),
        assignmentCount: assignments.length,
        completedReviewCount: humanReviews.length,
        averageScore: score,
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
            .select({ value: submissionAnswers.value, semanticKey: formVersionFields.semanticKey })
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
      const detailAssignments = assignmentRows
        .filter((assignment) => assignment.submissionId === submissionId && (!relevantRoundId || assignment.roundId === relevantRoundId))
        .map((assignment) => ({
          id: assignment.id,
          reviewerUserId: assignment.reviewerUserId,
          reviewerName: assignment.reviewerName ?? "Reviewer",
          version: assignment.version,
        }));
      const detailHumanReviews: HumanReview[] = visibleHumanReviews
        .filter((review) => review.submissionId === submissionId && (!relevantRoundId || review.roundId === relevantRoundId))
        .map((review) => ({
          id: review.id,
          reviewerUserId: review.reviewerUserId!,
          reviewerName: memberRows.find((member) => member.userId === review.reviewerUserId)?.name ?? "Former committee member",
          score: review.score,
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
        comments: commentRows.map((comment) => ({
          id: comment.id,
          authorUserId: comment.authorUserId,
          authorName: comment.authorName ?? "Committee member",
          body: comment.body,
          createdAt: toMillis(comment.createdAt),
        })),
        aiSuggestions,
        acceptance: yield* loadAcceptance(input.eventId, submissionId),
      };
    }

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
      rounds,
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
            reviewerName: reviewer[0].name ?? "Reviewer",
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
      return yield* Effect.fail(new Forbidden({ reason: "Human scores require a browser-session event committee member" }));
    }
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status !== "active") {
      return yield* Effect.fail(new Conflict({ message: "Human scoring is available only while the review round is active" }));
    }
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
    const score = averageScore(scoreRecord);
    const [reviewerName, committeeReviewers] = yield* Effect.all([
      database(() => db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId)).limit(1)),
      database(() => db.select({ userId: eventMembers.userId }).from(eventMembers).where(and(
        eq(eventMembers.eventId, input.eventId),
        eq(eventMembers.role, "reviewer"),
      ))),
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
      ? db.update(reviews).set({ score, scores: scoreRecord, comment: input.comment ?? null, version, updatedAt: savedAt }).where(and(eq(reviews.id, reviewId), eq(reviews.version, input.expectedVersion)))
      : db.insert(reviews).values({ id: reviewId, eventId: input.eventId, roundId: input.roundId, submissionId: input.submissionId, reviewerUserId: viewer.userId, ai: false, score, scores: scoreRecord, comment: input.comment ?? null, version, createdAt: savedAt, updatedAt: savedAt });
    yield* database(() =>
      db.batch([
        writeReview,
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "review", aggregateId: reviewId,
          aggregateVersion: version, eventType: "review.score.saved",
          audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: committeeReviewers.map((member) => member.userId) }],
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

    const [authorRows, committeeReviewerRows] = yield* Effect.all([
      database(() => db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId)).limit(1)),
      database(() => db.select({ userId: eventMembers.userId }).from(eventMembers).where(and(
        eq(eventMembers.eventId, input.eventId),
        eq(eventMembers.role, "reviewer"),
      )).orderBy(asc(eventMembers.userId))),
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
          { kind: "reviewers", reviewerUserIds: committeeReviewerRows.map((member) => member.userId) },
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

export const requestAiSuggestion = (
  input: RequestAiSuggestionInput,
): Effect.Effect<RequestAiSuggestionOutput, AppError, Db | CurrentUser | AiService> =>
  Effect.gen(function* () {
    const viewer = yield* requireEventAccess(input.eventId, ["reviews:write"]);
    const round = yield* loadRound(input.eventId, input.roundId);
    if (round.status !== "active") {
      return yield* Effect.fail(new Conflict({ message: "AI suggestions are available only while the review round is active" }));
    }
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
    const committeeReviewerIds = yield* database(() =>
      db.select({ reviewerUserId: eventMembers.userId }).from(eventMembers).where(and(
        eq(eventMembers.eventId, input.eventId),
        eq(eventMembers.role, "reviewer"),
      )),
    );
    yield* database(() =>
      db.batch([
        db.insert(reviews).values({ id: suggestionId, eventId: input.eventId, roundId: input.roundId, submissionId: input.submissionId, reviewerUserId: null, ai: true, score, scores: scoreRecord, comment: response.comment, version: 1, createdAt, updatedAt: createdAt }),
        db.insert(domainChanges).values({
          id: id("change"), eventId: input.eventId, aggregateType: "reviewAiSuggestion", aggregateId: suggestionId,
          aggregateVersion: 1, eventType: "review.aiSuggestion.created",
          audiences: [{ kind: "admins" }, { kind: "reviewers", reviewerUserIds: committeeReviewerIds.map((row) => row.reviewerUserId) }],
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
    if (submission.status === "accepted") {
      return yield* Effect.fail(new Conflict({ message: "Submission is already accepted" }));
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
            db.select({ version: submissions.version }).from(submissions).where(and(
              eq(submissions.eventId, input.eventId),
              eq(submissions.id, input.submissionId),
            )).limit(1),
          );
          if (!currentSubmission || currentSubmission.version !== input.expectedVersion) {
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
      db.update(submissions).set({ status: "in_review", acceptedAt: null, version: nextVersion, updatedAt: revokedAt }).where(and(
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
    if (submission.status === "accepted") {
      return yield* Effect.fail(new Conflict({ message: "Accepted submissions must be revoked before they can be rejected" }));
    }
    if (submission.status === "rejected") {
      return yield* Effect.fail(new Conflict({ message: "Submission is already rejected" }));
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
      db.update(submissions).set({ status: "rejected", acceptedAt: null, version: nextVersion, updatedAt: rejectedAt }).where(and(
        eq(submissions.eventId, input.eventId), eq(submissions.id, input.submissionId),
        eq(submissions.version, input.expectedVersion), sql`${submissions.status} <> 'accepted'`,
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
