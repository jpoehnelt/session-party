import { ApiError, decodeApiResponse } from "@/client/api";
import { Schema } from "effect";
import {
  AdvanceReviewRoundOutput,
  AppendReviewCommentOutput,
  AssignReviewerOutput,
  BulkAssignReviewersOutput,
  CreateReviewRoundOutput,
  ExportReviewResultsOutput,
  RequestAiSuggestionOutput,
  ReleaseDecisionsOutput,
  RecuseAssignmentOutput,
  RemoveAssignmentOutput,
  RevokeAcceptanceOutput,
  SaveScoreOutput,
  StageDecisionInput,
  StageDecisionOutput,
  SendReviewRemindersOutput,
  UpdateReviewRoundOutput,
  type AdvanceReviewRoundInput,
  type AppendReviewCommentInput,
  type AssignReviewerInput,
  type BulkAssignReviewersInput,
  type CreateReviewRoundInput,
  type ExportReviewResultsInput,
  type RequestAiSuggestionInput,
  type ReleaseDecisionsInput,
  type RecuseAssignmentInput,
  type RemoveAssignmentInput,
  type RevokeAcceptanceInput,
  type SaveScoreInput,
  type SendReviewRemindersInput,
  type UpdateReviewRoundInput,
} from "../schema";

interface MutationRequest<T> {
  readonly path: string;
  readonly method: "DELETE" | "POST" | "PUT";
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  readonly schema: Schema.Schema<T, any, never>;
}

const segment = (value: string) => encodeURIComponent(value);

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => undefined) as unknown;
  if (typeof payload !== "object" || payload === null) {
    return response.statusText || `Request failed with status ${response.status}`;
  }
  if ("message" in payload && typeof payload.message === "string") return payload.message;
  if ("error" in payload && typeof payload.error === "string") return payload.error;
  if (
    "error" in payload
    && typeof payload.error === "object"
    && payload.error !== null
    && "message" in payload.error
    && typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

async function mutation<T>({
  path,
  method,
  requestId,
  idempotencyKey,
  body,
  schema,
}: MutationRequest<T>): Promise<T> {
  const headers: Record<string, string> = { "x-request-id": requestId };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(response.status, await responseMessage(response));
  return decodeApiResponse(response, schema);
}

export function assignReviewerRequest(input: AssignReviewerInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/assignments`,
    method: "POST",
    requestId: input.requestId,
    body: {
      roundId: input.roundId,
      submissionId: input.submissionId,
      reviewerUserId: input.reviewerUserId,
      expectedVersion: input.expectedVersion,
    },
    schema: AssignReviewerOutput,
  });
}

export function recuseAssignmentRequest(input: RecuseAssignmentInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/assignments/${segment(input.assignmentId)}/recusal`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: {
      expectedVersion: input.expectedVersion,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    schema: RecuseAssignmentOutput,
  });
}

export function removeAssignmentRequest(input: RemoveAssignmentInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/assignments/${segment(input.assignmentId)}`,
    method: "DELETE",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: { expectedVersion: input.expectedVersion },
    schema: RemoveAssignmentOutput,
  });
}

export function createReviewRoundRequest(input: CreateReviewRoundInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: {
      name: input.name,
      initialStatus: input.initialStatus,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      blind: input.blind,
      rubric: input.rubric,
      expectedRoundCount: input.expectedRoundCount,
    },
    schema: CreateReviewRoundOutput,
  });
}

export function updateReviewRoundRequest(input: UpdateReviewRoundInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds/${segment(input.roundId)}`,
    method: "PUT",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: {
      name: input.name,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      blind: input.blind,
      rubric: input.rubric,
      expectedVersion: input.expectedVersion,
    },
    schema: UpdateReviewRoundOutput,
  });
}

export function bulkAssignReviewersRequest(input: BulkAssignReviewersInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/assignments/bulk`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: {
      roundId: input.roundId,
      submissionIds: input.submissionIds,
      reviewerUserIds: input.reviewerUserIds,
      reviewsPerSubmission: input.reviewsPerSubmission,
      strategy: input.strategy,
    },
    schema: BulkAssignReviewersOutput,
  });
}

export function sendReviewRemindersRequest(input: SendReviewRemindersInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds/${segment(input.roundId)}/reminders`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: { reviewerUserIds: input.reviewerUserIds },
    schema: SendReviewRemindersOutput,
  });
}

export async function exportReviewResultsRequest(input: ExportReviewResultsInput) {
  const response = await fetch(
    `/api/v1/events/${segment(input.eventId)}/review/rounds/${segment(input.roundId)}/export`,
  );
  if (!response.ok) throw new ApiError(response.status, await responseMessage(response));
  return decodeApiResponse(response, ExportReviewResultsOutput);
}

export function advanceReviewRoundRequest(input: AdvanceReviewRoundInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds/${segment(input.roundId)}/advance`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: {
      expectedVersion: input.expectedVersion,
      nextRoundId: input.nextRoundId,
      expectedNextVersion: input.expectedNextVersion,
    },
    schema: AdvanceReviewRoundOutput,
  });
}

export function saveScoreRequest(input: SaveScoreInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds/${segment(input.roundId)}/submissions/${segment(input.submissionId)}/score`,
    method: "PUT",
    requestId: input.requestId,
    body: {
      expectedVersion: input.expectedVersion,
      scores: input.scores,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      ...(input.confirmedAiSuggestionId === undefined
        ? {}
        : { confirmedAiSuggestionId: input.confirmedAiSuggestionId }),
    },
    schema: SaveScoreOutput,
  });
}

export function appendReviewCommentRequest(input: AppendReviewCommentInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/submissions/${segment(input.submissionId)}/comments`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: { body: input.body },
    schema: AppendReviewCommentOutput,
  });
}

export function requestAiSuggestionRequest(input: RequestAiSuggestionInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds/${segment(input.roundId)}/submissions/${segment(input.submissionId)}/ai-suggestions`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    schema: RequestAiSuggestionOutput,
  });
}

export function revokeAcceptanceRequest(input: RevokeAcceptanceInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/submissions/${segment(input.submissionId)}/acceptance`,
    method: "DELETE",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: { expectedVersion: input.expectedVersion },
    schema: RevokeAcceptanceOutput,
  });
}

export function releaseDecisionsRequest(input: ReleaseDecisionsInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/decisions/release`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: { decisions: input.decisions },
    schema: ReleaseDecisionsOutput,
  });
}

export function stageDecisionRequest(input: StageDecisionInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/submissions/${segment(input.submissionId)}/decision`,
    method: "PUT",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: { decision: input.decision, expectedVersion: input.expectedVersion },
    schema: StageDecisionOutput,
  });
}
