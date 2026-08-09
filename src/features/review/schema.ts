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

export const ScoreValue = Schema.Int.pipe(Schema.between(1, 5));
export type ScoreValue = typeof ScoreValue.Type;

export const RubricCriterion = Schema.Struct({
  key: EntityId,
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  max: Schema.Literal(5),
});
export type RubricCriterion = typeof RubricCriterion.Type;

export const ReviewRubric = Schema.Struct({
  criteria: Schema.NonEmptyArray(RubricCriterion),
});
export type ReviewRubric = typeof ReviewRubric.Type;

export const CriterionScore = Schema.Struct({
  criterionKey: EntityId,
  score: ScoreValue,
});
export type CriterionScore = typeof CriterionScore.Type;

export const ReviewRound = Schema.Struct({
  id: EntityId,
  name: NonEmptyText,
  order: Schema.Int.pipe(Schema.positive()),
  status: ReviewRoundStatus,
  rubric: ReviewRubric,
  version: Schema.Int.pipe(Schema.positive()),
});
export type ReviewRound = typeof ReviewRound.Type;

export const ReviewerAssignment = Schema.Struct({
  id: EntityId,
  reviewerUserId: EntityId,
  reviewerName: NonEmptyText,
  version: Schema.Int.pipe(Schema.positive()),
});
export type ReviewerAssignment = typeof ReviewerAssignment.Type;

export const HumanReview = Schema.Struct({
  id: EntityId,
  reviewerUserId: EntityId,
  reviewerName: NonEmptyText,
  score: Schema.Number.pipe(Schema.between(1, 5)),
  scores: Schema.Array(CriterionScore),
  comment: Schema.NullOr(Schema.String.pipe(Schema.maxLength(5_000))),
  version: Schema.Int.pipe(Schema.positive()),
  updatedAt: UnixTimestampMs,
});
export type HumanReview = typeof HumanReview.Type;

export const AiSuggestion = Schema.Struct({
  id: EntityId,
  label: Schema.Literal("AI suggestion — requires human confirmation"),
  score: Schema.Number.pipe(Schema.between(1, 5)),
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
});
export type SpeakerSummary = typeof SpeakerSummary.Type;

export const AcceptanceSummary = Schema.Struct({
  acceptanceEventId: EntityId,
  submissionVersion: Schema.Int.pipe(Schema.positive()),
  acceptedAt: UnixTimestampMs,
  provisioningId: EntityId,
  provisioningStatus: Schema.Literal(
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
  assignmentCount: Schema.Int.pipe(Schema.nonNegative()),
  completedReviewCount: Schema.Int.pipe(Schema.nonNegative()),
  averageScore: Schema.NullOr(Schema.Number.pipe(Schema.between(1, 5))),
});
export type SubmissionReviewSummary = typeof SubmissionReviewSummary.Type;

export const SubmissionReviewDetail = Schema.Struct({
  ...SubmissionReviewSummary.fields,
  abstract: Schema.String.pipe(Schema.maxLength(20_000)),
  speakers: Schema.Array(SpeakerSummary),
  round: Schema.NullOr(ReviewRound),
  assignments: Schema.Array(ReviewerAssignment),
  reviews: Schema.Array(HumanReview),
  aiSuggestions: Schema.Array(AiSuggestion),
  acceptance: Schema.NullOr(AcceptanceSummary),
});
export type SubmissionReviewDetail = typeof SubmissionReviewDetail.Type;

export const WorkbenchFilters = Schema.Struct({
  status: Schema.optional(SubmissionStatus),
  category: OptionalFilter,
  roundId: Schema.optional(EntityId),
  assignedToMe: Schema.optional(Schema.BooleanFromString),
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
  rounds: Schema.Array(ReviewRound),
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
