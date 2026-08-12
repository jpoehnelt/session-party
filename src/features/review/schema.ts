import { EntityId, UnixTimestampMs } from "contracts/domain";
import { Schema } from "effect";

const NonEmptyText = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_000));
const OptionalFilter = Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)));

export const SubmissionStatus = Schema.Literal(
  "submitted",
  "in_review",
  "accepted",
  "rejected",
  "waitlist",
  "withdrawn",
);
export type SubmissionStatus = typeof SubmissionStatus.Type;

export const ReviewRoundStatus = Schema.Literal("pending", "active", "complete");
export type ReviewRoundStatus = typeof ReviewRoundStatus.Type;

export const ReviewState = Schema.Literal("unassigned", "assigned", "in_progress", "complete");
export type ReviewState = typeof ReviewState.Type;

export const WorkbenchOrder = Schema.Literal("coverage", "decision", "decision_asc");
export type WorkbenchOrder = typeof WorkbenchOrder.Type;

export const ScoreValue = Schema.Int.pipe(Schema.between(1, 5));
export type ScoreValue = typeof ScoreValue.Type;

export const ReviewCriterionType = Schema.Literal("numeric", "dropdown", "text");
export type ReviewCriterionType = typeof ReviewCriterionType.Type;

export const RubricOption = Schema.Struct({
  value: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  score: ScoreValue,
});
export type RubricOption = typeof RubricOption.Type;

export const RubricCriterion = Schema.Struct({
  key: EntityId,
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  type: Schema.optionalWith(ReviewCriterionType, { default: () => "numeric" as const }),
  weight: Schema.optionalWith(Schema.Number.pipe(Schema.between(0, 100)), { default: () => 1 }),
  required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  max: Schema.optionalWith(Schema.Literal(5), { default: () => 5 as const }),
  options: Schema.optional(Schema.Array(RubricOption).pipe(Schema.maxItems(20))),
});
export type RubricCriterion = typeof RubricCriterion.Type;

export const ReviewRubric = Schema.Struct({
  criteria: Schema.NonEmptyArray(RubricCriterion),
});
export type ReviewRubric = typeof ReviewRubric.Type;

export const CriterionScore = Schema.Struct({
  criterionKey: EntityId,
  score: Schema.Union(ScoreValue, Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_000))),
});
export type CriterionScore = typeof CriterionScore.Type;

export const ReviewRound = Schema.Struct({
  id: EntityId,
  name: NonEmptyText,
  order: Schema.Int.pipe(Schema.positive()),
  status: ReviewRoundStatus,
  startsAt: Schema.NullOr(UnixTimestampMs),
  endsAt: Schema.NullOr(UnixTimestampMs),
  blind: Schema.Boolean,
  rubric: ReviewRubric,
  version: Schema.Int.pipe(Schema.positive()),
});
export type ReviewRound = typeof ReviewRound.Type;

const IdempotencyKey = Schema.String.pipe(Schema.minLength(8), Schema.maxLength(256));

export const CreateReviewRoundInput = Schema.Struct({
  eventId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  initialStatus: Schema.Literal("pending", "active"),
  startsAt: Schema.NullOr(UnixTimestampMs),
  endsAt: Schema.NullOr(UnixTimestampMs),
  blind: Schema.Boolean,
  rubric: ReviewRubric,
  expectedRoundCount: Schema.Int.pipe(Schema.nonNegative()),
  idempotencyKey: IdempotencyKey,
  requestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
export type CreateReviewRoundInput = typeof CreateReviewRoundInput.Type;

export const CreateReviewRoundOutput = Schema.Struct({
  round: ReviewRound,
  idempotent: Schema.Boolean,
});
export type CreateReviewRoundOutput = typeof CreateReviewRoundOutput.Type;

export const UpdateReviewRoundInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  startsAt: Schema.NullOr(UnixTimestampMs),
  endsAt: Schema.NullOr(UnixTimestampMs),
  blind: Schema.Boolean,
  rubric: ReviewRubric,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: IdempotencyKey,
  requestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
export type UpdateReviewRoundInput = typeof UpdateReviewRoundInput.Type;

export const UpdateReviewRoundOutput = Schema.Struct({
  round: ReviewRound,
  idempotent: Schema.Boolean,
});
export type UpdateReviewRoundOutput = typeof UpdateReviewRoundOutput.Type;

export const AdvanceReviewRoundInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  nextRoundId: Schema.NullOr(EntityId),
  expectedNextVersion: Schema.Int.pipe(Schema.nonNegative()),
  idempotencyKey: IdempotencyKey,
  requestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
export type AdvanceReviewRoundInput = typeof AdvanceReviewRoundInput.Type;

export const AdvanceReviewRoundOutput = Schema.Struct({
  rounds: Schema.NonEmptyArray(ReviewRound),
  idempotent: Schema.Boolean,
});
export type AdvanceReviewRoundOutput = typeof AdvanceReviewRoundOutput.Type;

export const ReviewerAssignment = Schema.Struct({
  id: EntityId,
  reviewerUserId: EntityId,
  reviewerName: NonEmptyText,
  status: Schema.Literal("assigned", "recused"),
  recusalReason: Schema.NullOr(Schema.String.pipe(Schema.maxLength(2_000))),
  recusedAt: Schema.NullOr(UnixTimestampMs),
  version: Schema.Int.pipe(Schema.positive()),
});
export type ReviewerAssignment = typeof ReviewerAssignment.Type;

export const ReviewMember = Schema.Struct({
  userId: EntityId,
  name: NonEmptyText,
});
export type ReviewMember = typeof ReviewMember.Type;

export const ReviewerRoundProgress = Schema.Struct({
  reviewerUserId: EntityId,
  reviewerName: NonEmptyText,
  assignedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  completedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  outstandingReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  recusalCount: Schema.Int.pipe(Schema.nonNegative()),
});
export type ReviewerRoundProgress = typeof ReviewerRoundProgress.Type;

export const SubmissionRoundProgress = Schema.Struct({
  submissionId: EntityId,
  title: NonEmptyText,
  assignedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  completedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  outstandingReviewerNames: Schema.Array(NonEmptyText),
  recusalCount: Schema.Int.pipe(Schema.nonNegative()),
  needsReviewer: Schema.Boolean,
});
export type SubmissionRoundProgress = typeof SubmissionRoundProgress.Type;

export const ReviewRoundProgress = Schema.Struct({
  roundId: EntityId,
  roundName: NonEmptyText,
  assignedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  completedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  outstandingReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  recusalCount: Schema.Int.pipe(Schema.nonNegative()),
  reviewers: Schema.Array(ReviewerRoundProgress),
  incompleteSubmissions: Schema.Array(SubmissionRoundProgress),
});
export type ReviewRoundProgress = typeof ReviewRoundProgress.Type;

export const ReviewerProgress = Schema.Struct({
  reviewerUserId: EntityId,
  reviewerName: NonEmptyText,
  assignedCount: Schema.Int.pipe(Schema.nonNegative()),
  completedCount: Schema.Int.pipe(Schema.nonNegative()),
  outstandingCount: Schema.Int.pipe(Schema.nonNegative()),
  completionPercent: Schema.Number.pipe(Schema.between(0, 100)),
});
export type ReviewerProgress = typeof ReviewerProgress.Type;

export const ReviewRecusal = Schema.Struct({
  id: EntityId,
  roundId: EntityId,
  submissionId: EntityId,
  reviewerUserId: EntityId,
  reviewerName: NonEmptyText,
  reason: Schema.NullOr(Schema.String.pipe(Schema.maxLength(500))),
  createdAt: UnixTimestampMs,
});
export type ReviewRecusal = typeof ReviewRecusal.Type;

export const HumanReview = Schema.Struct({
  id: EntityId,
  reviewerUserId: EntityId,
  reviewerName: NonEmptyText,
  score: Schema.NullOr(Schema.Number.pipe(Schema.between(1, 5))),
  scores: Schema.Array(CriterionScore),
  comment: Schema.NullOr(Schema.String.pipe(Schema.maxLength(5_000))),
  version: Schema.Int.pipe(Schema.positive()),
  updatedAt: UnixTimestampMs,
});
export type HumanReview = typeof HumanReview.Type;

export const ReviewThreadComment = Schema.Struct({
  id: EntityId,
  authorUserId: EntityId,
  authorName: NonEmptyText,
  body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(5_000)),
  createdAt: UnixTimestampMs,
});
export type ReviewThreadComment = typeof ReviewThreadComment.Type;

export const AiSuggestion = Schema.Struct({
  id: EntityId,
  label: Schema.Literal("AI suggestion — requires human confirmation"),
  score: Schema.NullOr(Schema.Number.pipe(Schema.between(1, 5))),
  scores: Schema.Array(CriterionScore),
  comment: Schema.String.pipe(Schema.maxLength(5_000)),
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UnixTimestampMs,
  inputFields: Schema.Tuple(
    Schema.Literal("title"),
    Schema.Literal("abstract"),
    Schema.Literal("rubric"),
  ),
});
export type AiSuggestion = typeof AiSuggestion.Type;

export const SpeakerSummary = Schema.Struct({
  id: EntityId,
  displayName: NonEmptyText,
  isPrimary: Schema.Boolean,
  role: NonEmptyText,
});
export type SpeakerSummary = typeof SpeakerSummary.Type;

export const SubmissionAnswerSummary = Schema.Struct({
  label: NonEmptyText,
  value: Schema.String.pipe(Schema.maxLength(20_000)),
});
export type SubmissionAnswerSummary = typeof SubmissionAnswerSummary.Type;

export const AcceptanceSummary = Schema.Struct({
  acceptanceEventId: EntityId,
  submissionVersion: Schema.Int.pipe(Schema.positive()),
  acceptedAt: UnixTimestampMs,
  provisioningId: Schema.NullOr(EntityId),
  provisioningStatus: Schema.Literal(
    "missing",
    "pending",
    "claimed",
    "provisioned",
    "retry",
    "failed",
    "revoked",
  ),
});
export type AcceptanceSummary = typeof AcceptanceSummary.Type;

export const SubmissionReviewSummary = Schema.Struct({
  id: EntityId,
  title: NonEmptyText,
  category: Schema.NullOr(Schema.String),
  status: SubmissionStatus,
  submittedAt: UnixTimestampMs,
  version: Schema.Int.pipe(Schema.positive()),
  reviewState: ReviewState,
  assignedToMe: Schema.Boolean,
  assignmentCount: Schema.Int.pipe(Schema.nonNegative()),
  completedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  averageScore: Schema.NullOr(Schema.Number.pipe(Schema.between(1, 5))),
});
export type SubmissionReviewSummary = typeof SubmissionReviewSummary.Type;

export const SubmissionReviewDetail = Schema.Struct({
  ...SubmissionReviewSummary.fields,
  abstract: Schema.String.pipe(Schema.maxLength(20_000)),
  speakers: Schema.Array(SpeakerSummary),
  answers: Schema.optional(Schema.Array(SubmissionAnswerSummary)),
  round: Schema.NullOr(ReviewRound),
  assignments: Schema.Array(ReviewerAssignment),
  reviews: Schema.Array(HumanReview),
  comments: Schema.Array(ReviewThreadComment),
  recusals: Schema.Array(ReviewRecusal),
  recusedByMe: Schema.Boolean,
  aiSuggestions: Schema.Array(AiSuggestion),
  acceptance: Schema.NullOr(AcceptanceSummary),
});
export type SubmissionReviewDetail = typeof SubmissionReviewDetail.Type;

export const WorkbenchFilters = Schema.Struct({
  status: Schema.optional(SubmissionStatus),
  category: OptionalFilter,
  roundId: Schema.optional(EntityId),
  assignedToMe: Schema.optional(Schema.BooleanFromString),
  order: Schema.optional(WorkbenchOrder),
  page: Schema.optionalWith(Schema.NumberFromString.pipe(Schema.int(), Schema.positive()), {
    default: () => 1,
  }),
  pageSize: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100)),
    { default: () => 60 },
  ),
});

export const GetWorkbenchInput = Schema.Struct({
  eventId: EntityId,
  selectedSubmissionId: Schema.optional(EntityId),
  ...WorkbenchFilters.fields,
});
export type GetWorkbenchInput = typeof GetWorkbenchInput.Type;

export const WorkbenchPagination = Schema.Struct({
  page: Schema.Int.pipe(Schema.positive()),
  pageSize: Schema.Int.pipe(Schema.between(1, 100)),
  total: Schema.Int.pipe(Schema.nonNegative()),
  pageCount: Schema.Int.pipe(Schema.nonNegative()),
});

export const ReviewWorkbench = Schema.Struct({
  eventId: EntityId,
  eventName: NonEmptyText,
  timezone: NonEmptyText,
  viewerRole: Schema.Literal("owner", "admin", "reviewer"),
  viewerUserId: EntityId,
  reviewers: Schema.Array(ReviewMember),
  reviewerProgress: Schema.Array(ReviewerProgress),
  rounds: Schema.Array(ReviewRound),
  progress: Schema.optional(Schema.NullOr(ReviewRoundProgress)),
  order: WorkbenchOrder,
  queue: Schema.Array(SubmissionReviewSummary),
  selected: Schema.NullOr(SubmissionReviewDetail),
  pagination: WorkbenchPagination,
  lastUpdatedAt: UnixTimestampMs,
});
export type ReviewWorkbench = typeof ReviewWorkbench.Type;

const RequestId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const ExpectedVersion = Schema.Int.pipe(Schema.nonNegative());

export const AssignReviewerInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
  submissionId: EntityId,
  reviewerUserId: EntityId,
  expectedVersion: ExpectedVersion,
  requestId: RequestId,
});
export type AssignReviewerInput = typeof AssignReviewerInput.Type;

export const AssignReviewerOutput = Schema.Struct({
  assignment: ReviewerAssignment,
  created: Schema.Boolean,
});
export type AssignReviewerOutput = typeof AssignReviewerOutput.Type;

export const RecuseAssignmentInput = Schema.Struct({
  eventId: EntityId,
  assignmentId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  reason: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  idempotencyKey: IdempotencyKey,
  requestId: RequestId,
});
export type RecuseAssignmentInput = typeof RecuseAssignmentInput.Type;

export const RecuseAssignmentOutput = Schema.Struct({
  assignment: ReviewerAssignment,
  idempotent: Schema.Boolean,
});
export type RecuseAssignmentOutput = typeof RecuseAssignmentOutput.Type;

export const BulkAssignReviewersInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
  submissionIds: Schema.NonEmptyArray(EntityId).pipe(Schema.maxItems(100)),
  reviewerUserIds: Schema.NonEmptyArray(EntityId).pipe(Schema.maxItems(50)),
  reviewsPerSubmission: Schema.Int.pipe(Schema.between(1, 50)),
  strategy: Schema.Literal("all", "balanced"),
  idempotencyKey: IdempotencyKey,
  requestId: RequestId,
});
export type BulkAssignReviewersInput = typeof BulkAssignReviewersInput.Type;

export const BulkAssignReviewersOutput = Schema.Struct({
  createdCount: Schema.Int.pipe(Schema.nonNegative()),
  existingCount: Schema.Int.pipe(Schema.nonNegative()),
  assignmentCount: Schema.Int.pipe(Schema.nonNegative()),
  idempotent: Schema.Boolean,
});
export type BulkAssignReviewersOutput = typeof BulkAssignReviewersOutput.Type;

export const SendReviewRemindersInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
  reviewerUserIds: Schema.NonEmptyArray(EntityId).pipe(Schema.maxItems(50)),
  idempotencyKey: IdempotencyKey,
  requestId: RequestId,
});
export type SendReviewRemindersInput = typeof SendReviewRemindersInput.Type;

export const SendReviewRemindersOutput = Schema.Struct({
  queuedCount: Schema.Int.pipe(Schema.nonNegative()),
  skippedCount: Schema.Int.pipe(Schema.nonNegative()),
  reviewerUserIds: Schema.Array(EntityId),
  idempotent: Schema.Boolean,
});
export type SendReviewRemindersOutput = typeof SendReviewRemindersOutput.Type;

export const ReviewExportRow = Schema.Struct({
  submissionId: EntityId,
  title: NonEmptyText,
  category: Schema.NullOr(Schema.String),
  status: SubmissionStatus,
  reviewerUserId: Schema.NullOr(EntityId),
  reviewerName: Schema.NullOr(NonEmptyText),
  aggregateScore: Schema.NullOr(Schema.Number.pipe(Schema.between(1, 5))),
  responses: Schema.Array(CriterionScore),
  comment: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(UnixTimestampMs),
});
export type ReviewExportRow = typeof ReviewExportRow.Type;

export const ExportReviewResultsInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
});
export type ExportReviewResultsInput = typeof ExportReviewResultsInput.Type;

export const ExportReviewResultsOutput = Schema.Struct({
  eventName: NonEmptyText,
  round: ReviewRound,
  rows: Schema.Array(ReviewExportRow),
});
export type ExportReviewResultsOutput = typeof ExportReviewResultsOutput.Type;

export const SaveScoreInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
  submissionId: EntityId,
  expectedVersion: ExpectedVersion,
  scores: Schema.NonEmptyArray(CriterionScore),
  comment: Schema.optional(Schema.String.pipe(Schema.maxLength(5_000))),
  confirmedAiSuggestionId: Schema.optional(EntityId),
  requestId: RequestId,
});
export type SaveScoreInput = typeof SaveScoreInput.Type;

export const SaveScoreOutput = Schema.Struct({
  review: HumanReview,
  submissionStatus: SubmissionStatus,
});
export type SaveScoreOutput = typeof SaveScoreOutput.Type;

export const AppendReviewCommentInput = Schema.Struct({
  eventId: EntityId,
  submissionId: EntityId,
  body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(5_000)),
  idempotencyKey: IdempotencyKey,
  requestId: RequestId,
});
export type AppendReviewCommentInput = typeof AppendReviewCommentInput.Type;

export const AppendReviewCommentOutput = Schema.Struct({
  comment: ReviewThreadComment,
  idempotent: Schema.Boolean,
});
export type AppendReviewCommentOutput = typeof AppendReviewCommentOutput.Type;

export const RequestAiSuggestionInput = Schema.Struct({
  eventId: EntityId,
  roundId: EntityId,
  submissionId: EntityId,
  requestId: RequestId,
});
export type RequestAiSuggestionInput = typeof RequestAiSuggestionInput.Type;

export const RequestAiSuggestionOutput = Schema.Struct({
  suggestion: AiSuggestion,
  submissionStatus: SubmissionStatus,
});
export type RequestAiSuggestionOutput = typeof RequestAiSuggestionOutput.Type;

export const AcceptSubmissionInput = Schema.Struct({
  eventId: EntityId,
  submissionId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(256)),
  requestId: RequestId,
});
export type AcceptSubmissionInput = typeof AcceptSubmissionInput.Type;

export const AcceptSubmissionOutput = Schema.Struct({
  acceptanceEventId: EntityId,
  provisioningId: EntityId,
  submissionId: EntityId,
  primarySpeakerId: EntityId,
  submissionVersion: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("accepted"),
  provisioningStatus: Schema.Literal("pending"),
  idempotent: Schema.Boolean,
});
export type AcceptSubmissionOutput = typeof AcceptSubmissionOutput.Type;

export const RevokeAcceptanceInput = Schema.Struct({
  eventId: EntityId,
  submissionId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(256)),
  requestId: RequestId,
});
export type RevokeAcceptanceInput = typeof RevokeAcceptanceInput.Type;

export const RevokeAcceptanceOutput = Schema.Struct({
  revocationEventId: EntityId,
  submissionId: EntityId,
  submissionVersion: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("in_review"),
  provisioningStatus: Schema.Literal("revoked"),
  idempotent: Schema.Boolean,
});
export type RevokeAcceptanceOutput = typeof RevokeAcceptanceOutput.Type;

export const RejectSubmissionInput = Schema.Struct({
  eventId: EntityId,
  submissionId: EntityId,
  expectedVersion: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(256)),
  requestId: RequestId,
});
export type RejectSubmissionInput = typeof RejectSubmissionInput.Type;

export const RejectSubmissionOutput = Schema.Struct({
  submissionId: EntityId,
  submissionVersion: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("rejected"),
  idempotent: Schema.Boolean,
});
export type RejectSubmissionOutput = typeof RejectSubmissionOutput.Type;
