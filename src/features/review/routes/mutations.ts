import { ApiError } from "@/client/api";
import { Schema } from "effect";
import {
  AcceptSubmissionOutput,
  AdvanceReviewRoundOutput,
  AssignReviewerOutput,
  CreateReviewRoundOutput,
  RequestAiSuggestionOutput,
  SaveScoreOutput,
  type AcceptSubmissionInput,
  type AdvanceReviewRoundInput,
  type AssignReviewerInput,
  type CreateReviewRoundInput,
  type RequestAiSuggestionInput,
  type SaveScoreInput,
} from "../schema";

interface MutationRequest<T> {
  readonly path: string;
  readonly method: "POST" | "PUT";
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
  return Schema.decodeUnknownSync(schema)(await response.json());
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

export function createReviewRoundRequest(input: CreateReviewRoundInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: {
      name: input.name,
      initialStatus: input.initialStatus,
      rubric: input.rubric,
      expectedRoundCount: input.expectedRoundCount,
    },
    schema: CreateReviewRoundOutput,
  });
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

export function requestAiSuggestionRequest(input: RequestAiSuggestionInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/rounds/${segment(input.roundId)}/submissions/${segment(input.submissionId)}/ai-suggestions`,
    method: "POST",
    requestId: input.requestId,
    schema: RequestAiSuggestionOutput,
  });
}

export function acceptSubmissionRequest(input: AcceptSubmissionInput) {
  return mutation({
    path: `/api/v1/events/${segment(input.eventId)}/review/submissions/${segment(input.submissionId)}/acceptance`,
    method: "POST",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    body: { expectedVersion: input.expectedVersion },
    schema: AcceptSubmissionOutput,
  });
}
