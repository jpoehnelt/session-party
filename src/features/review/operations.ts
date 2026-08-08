import type { AnyOperationDef } from "contracts/operation";
import { eventAuthorization } from "contracts/principal";
import {
  AcceptSubmissionInput,
  AcceptSubmissionOutput,
  AssignReviewerInput,
  AssignReviewerOutput,
  GetWorkbenchInput,
  RequestAiSuggestionInput,
  RequestAiSuggestionOutput,
  ReviewWorkbench,
  SaveScoreInput,
  SaveScoreOutput,
} from "./schema";
import {
  acceptSubmission,
  assignReviewer,
  getWorkbench,
  requestAiSuggestion,
  saveScore,
} from "./service";

const organizerWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["reviews:write"] },
);

const acceptanceWrite = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "api-key", scopes: ["reviews:write", "submissions:write", "speakers:write"] },
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
  mcp: {
    name: "review_accept_submission",
    description: "Explicitly accept one version of a submission and create its durable primary-speaker provisioning fact.",
  },
  party: { intentType: "review/accept_submission" },
  idempotency: "required",
  concurrency: "required",
  emits: ["review.submission.accepted", "speaker.provisioning.requested"],
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
  party: { intentType: "review/assign_reviewer" },
  idempotency: "none",
  concurrency: "required",
  emits: ["review.assignment.created"],
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
      query: ["selectedSubmissionId", "status", "category", "roundId", "assignedToMe", "page", "pageSize"],
    },
    summary: "Load the role-filtered review workbench",
    successStatus: 200,
  },
  mcp: {
    name: "review_get_workbench",
    description: "List the review queue and selected proposal detail, filtered to the caller's event authority and assignments.",
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
  party: { intentType: "review/request_ai_suggestion" },
  idempotency: "none",
  concurrency: "none",
  emits: ["review.aiSuggestion.created"],
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
  mcp: {
    name: "review_save_score",
    description: "Save the assigned reviewer's bounded 1–5 rubric scores and private comment.",
  },
  party: { intentType: "review/save_score" },
  idempotency: "none",
  concurrency: "required",
  emits: ["review.score.saved"],
} as const satisfies AnyOperationDef;

/** Bytewise operation-id order; registry generation must preserve this sequence. */
export const operations = [
  acceptSubmissionOperation,
  assignReviewerOperation,
  getWorkbenchOperation,
  requestAiSuggestionOperation,
  saveScoreOperation,
] as const satisfies readonly AnyOperationDef[];
