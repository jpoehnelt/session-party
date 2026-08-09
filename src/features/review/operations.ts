import type { AnyOperationDef } from "contracts/operation";
import { eventAuthorization } from "contracts/principal";
import {
  AcceptSubmissionInput,
  AcceptSubmissionOutput,
  AdvanceReviewRoundInput,
  AdvanceReviewRoundOutput,
  AppendReviewCommentInput,
  AppendReviewCommentOutput,
  AssignReviewerInput,
  AssignReviewerOutput,
  CreateReviewRoundInput,
  CreateReviewRoundOutput,
  GetWorkbenchInput,
  RequestAiSuggestionInput,
  RequestAiSuggestionOutput,
  RejectSubmissionInput,
  RejectSubmissionOutput,
  RevokeAcceptanceInput,
  RevokeAcceptanceOutput,
  ReviewWorkbench,
  SaveScoreInput,
  SaveScoreOutput,
} from "./schema";
import {
  acceptSubmission,
  advanceReviewRound,
  appendReviewComment,
  assignReviewer,
  createReviewRound,
  getWorkbench,
  requestAiSuggestion,
  rejectSubmission,
  revokeAcceptance,
  saveScore,
} from "./service";

const organizerWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["reviews:write"] },
);

const acceptanceWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
);

const reviewRead = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
  { kind: "api-key", scopes: ["reviews:read"] },
);

const reviewWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
  { kind: "api-key", scopes: ["reviews:write"] },
);

const humanReviewWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
  { kind: "deny" },
);

const humanCommentWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin", "reviewer"] },
  { kind: "deny" },
);

const acceptSubmissionOperation = {
  id: "review.acceptSubmission",
  kind: "command",
  input: AcceptSubmissionInput,
  output: AcceptSubmissionOutput,
  authorize: acceptanceWrite,
  invoke: acceptSubmission,
  rest: {
    method: "post",
    path: "/events/:eventId/review/submissions/:submissionId/acceptance",
    input: {
      path: ["eventId", "submissionId"],
      headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" },
      body: ["expectedVersion"],
    },
    summary: "Accept a submission and request primary-speaker provisioning",
    successStatus: 200,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["review.submission.accepted", "speaker.provisioning.requested"],
} as const satisfies AnyOperationDef;

const advanceRoundOperation = {
  id: "review.advanceRound",
  kind: "command",
  input: AdvanceReviewRoundInput,
  output: AdvanceReviewRoundOutput,
  authorize: organizerWrite,
  invoke: advanceReviewRound,
  rest: {
    method: "post",
    path: "/events/:eventId/review/rounds/:roundId/advance",
    input: {
      path: ["eventId", "roundId"],
      headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" },
      body: ["expectedVersion", "nextRoundId", "expectedNextVersion"],
    },
    summary: "Activate or safely advance an ordered review round",
    successStatus: 200,
  },
  mcp: {
    name: "review_advance_round",
    description: "Activate the first pending round, or atomically complete the active round and optionally activate its next pending round.",
  },
  party: { intentType: "review/advanceRound" },
  idempotency: "required",
  concurrency: "required",
  emits: ["review.round.completed", "review.round.activated"],
} as const satisfies AnyOperationDef;

const appendCommentOperation = {
  id: "review.appendComment",
  kind: "command",
  input: AppendReviewCommentInput,
  output: AppendReviewCommentOutput,
  authorize: humanCommentWrite,
  invoke: appendReviewComment,
  rest: {
    method: "post",
    path: "/events/:eventId/review/submissions/:submissionId/comments",
    input: {
      path: ["eventId", "submissionId"],
      headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" },
      body: ["body"],
    },
    summary: "Append a human message to the event-private review committee thread",
    successStatus: 201,
  },
  party: { intentType: "review/appendComment" },
  idempotency: "required",
  concurrency: "none",
  emits: ["review.comment.created"],
} as const satisfies AnyOperationDef;

const assignReviewerOperation = {
  id: "review.assignReviewer",
  kind: "command",
  input: AssignReviewerInput,
  output: AssignReviewerOutput,
  authorize: organizerWrite,
  invoke: assignReviewer,
  rest: {
    method: "post",
    path: "/events/:eventId/review/assignments",
    input: {
      path: ["eventId"],
      headers: { requestId: "x-request-id" },
      body: ["roundId", "submissionId", "reviewerUserId", "expectedVersion"],
    },
    summary: "Assign a reviewer to a submission round",
    successStatus: 201,
  },
  mcp: {
    name: "review_assign_reviewer",
    description: "Assign an event reviewer to one submission in a review round.",
  },
  party: { intentType: "review/assignReviewer" },
  idempotency: "none",
  concurrency: "required",
  emits: ["review.assignment.created"],
} as const satisfies AnyOperationDef;

const createRoundOperation = {
  id: "review.createRound",
  kind: "command",
  input: CreateReviewRoundInput,
  output: CreateReviewRoundOutput,
  authorize: organizerWrite,
  invoke: createReviewRound,
  rest: {
    method: "post",
    path: "/events/:eventId/review/rounds",
    input: {
      path: ["eventId"],
      headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" },
      body: ["name", "initialStatus", "rubric", "expectedRoundCount"],
    },
    summary: "Create an ordered pending or active review round",
    successStatus: 201,
  },
  mcp: {
    name: "review_create_round",
    description: "Create a validated review round against the authoritative round count, optionally starting it when no earlier round remains open.",
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["review.round.created"],
} as const satisfies AnyOperationDef;

const getWorkbenchOperation = {
  id: "review.getWorkbench",
  kind: "query",
  input: GetWorkbenchInput,
  output: ReviewWorkbench,
  authorize: reviewRead,
  invoke: getWorkbench,
  rest: {
    method: "get",
    path: "/events/:eventId/review",
    input: {
      path: ["eventId"],
      query: ["selectedSubmissionId", "status", "category", "roundId", "assignedToMe", "order", "page", "pageSize"],
    },
    summary: "Load the role-filtered review workbench",
    successStatus: 200,
  },
  mcp: {
    name: "review_get_workbench",
    description: "List the event-authorized review queue and selected proposal detail, optionally filtered to the caller's assignments and ordered for coverage or decisions.",
  },
  idempotency: "none",
  concurrency: "none",
  emits: [],
} as const satisfies AnyOperationDef;

const requestAiSuggestionOperation = {
  id: "review.requestAiSuggestion",
  kind: "command",
  input: RequestAiSuggestionInput,
  output: RequestAiSuggestionOutput,
  authorize: reviewWrite,
  invoke: requestAiSuggestion,
  rest: {
    method: "post",
    path: "/events/:eventId/review/rounds/:roundId/submissions/:submissionId/ai-suggestions",
    input: {
      path: ["eventId", "roundId", "submissionId"],
      headers: { requestId: "x-request-id" },
      body: [],
    },
    summary: "Request a non-authoritative AI review suggestion",
    successStatus: 201,
  },
  mcp: {
    name: "review_request_ai_suggestion",
    description: "Generate a labeled, non-authoritative suggestion from title, abstract, and rubric only; no status transition occurs.",
  },
  party: { intentType: "review/requestAiSuggestion" },
  idempotency: "none",
  concurrency: "none",
  emits: ["review.aiSuggestion.created"],
} as const satisfies AnyOperationDef;

const rejectSubmissionOperation = {
  id: "review.rejectSubmission",
  kind: "command",
  input: RejectSubmissionInput,
  output: RejectSubmissionOutput,
  authorize: acceptanceWrite,
  invoke: rejectSubmission,
  rest: {
    method: "post",
    path: "/events/:eventId/review/submissions/:submissionId/rejection",
    input: {
      path: ["eventId", "submissionId"],
      headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" },
      body: ["expectedVersion"],
    },
    summary: "Reject a submission at its current version",
    successStatus: 200,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["review.submission.rejected"],
} as const satisfies AnyOperationDef;

const revokeAcceptanceOperation = {
  id: "review.revokeAcceptance",
  kind: "command",
  input: RevokeAcceptanceInput,
  output: RevokeAcceptanceOutput,
  authorize: acceptanceWrite,
  invoke: revokeAcceptance,
  rest: {
    method: "delete",
    path: "/events/:eventId/review/submissions/:submissionId/acceptance",
    input: {
      path: ["eventId", "submissionId"],
      headers: { idempotencyKey: "idempotency-key", requestId: "x-request-id" },
      body: ["expectedVersion"],
    },
    summary: "Revoke a submission acceptance and cancel its provisioning state",
    successStatus: 200,
  },
  idempotency: "required",
  concurrency: "required",
  emits: ["review.submission.acceptanceRevoked", "speaker.provisioning.revoked"],
} as const satisfies AnyOperationDef;

const saveScoreOperation = {
  id: "review.saveScore",
  kind: "command",
  input: SaveScoreInput,
  output: SaveScoreOutput,
  authorize: humanReviewWrite,
  invoke: saveScore,
  rest: {
    method: "put",
    path: "/events/:eventId/review/rounds/:roundId/submissions/:submissionId/score",
    input: {
      path: ["eventId", "roundId", "submissionId"],
      headers: { requestId: "x-request-id" },
      body: ["expectedVersion", "scores", "comment", "confirmedAiSuggestionId"],
    },
    summary: "Save a human-confirmed rubric score",
    successStatus: 200,
  },
  party: { intentType: "review/saveScore" },
  idempotency: "none",
  concurrency: "required",
  emits: ["review.score.saved"],
} as const satisfies AnyOperationDef;

/** Bytewise operation-id order; registry generation must preserve this sequence. */
export const operations = [
  acceptSubmissionOperation,
  advanceRoundOperation,
  appendCommentOperation,
  assignReviewerOperation,
  createRoundOperation,
  getWorkbenchOperation,
  rejectSubmissionOperation,
  requestAiSuggestionOperation,
  revokeAcceptanceOperation,
  saveScoreOperation,
] as const satisfies readonly AnyOperationDef[];
