import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptSubmissionRequest,
  advanceReviewRoundRequest,
  appendReviewCommentRequest,
  assignReviewerRequest,
  createReviewRoundRequest,
  rejectSubmissionRequest,
  recuseAssignmentRequest,
  removeAssignmentRequest,
  revokeAcceptanceRequest,
  requestAiSuggestionRequest,
  saveScoreRequest,
} from "./mutations";

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});
afterEach(() => vi.unstubAllGlobals());

describe("review mutation client", () => {
  it("deletes one assignment with version and idempotency evidence", async () => {
    const output = {
      assignmentId: "assignment_stale",
      roundId: "round_one",
      submissionId: "submission_stale",
      reviewerUserId: "reviewer_sam",
      removedAt: 1_700_000_000_000,
      preservedReviewCount: 1,
      idempotent: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(output));
    vi.stubGlobal("fetch", fetchMock);

    await expect(removeAssignmentRequest({
      eventId: "event_one",
      assignmentId: "assignment_stale",
      expectedVersion: 2,
      idempotencyKey: "remove-assignment-stale",
      requestId: "request-remove-assignment",
    })).resolves.toEqual(output);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/events/event_one/review/assignments/assignment_stale",
      {
        method: "DELETE",
        headers: {
          "x-request-id": "request-remove-assignment",
          "idempotency-key": "remove-assignment-stale",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 2 }),
      },
    );
  });

  it("posts append-only committee messages with required idempotency", async () => {
    const output = {
      comment: {
        id: "review_comment_1",
        authorUserId: "reviewer_ada",
        authorName: "Ada Reviewer",
        body: "Could we ask for a concrete example?",
        createdAt: 1_700_000_000_000,
      },
      idempotent: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(output, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendReviewCommentRequest({
      eventId: "event_one",
      submissionId: "submission_one",
      body: output.comment.body,
      idempotencyKey: "comment-key-1",
      requestId: "request-comment",
    })).resolves.toEqual(output);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/events/event_one/review/submissions/submission_one/comments",
      {
        method: "POST",
        headers: {
          "x-request-id": "request-comment",
          "idempotency-key": "comment-key-1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: output.comment.body }),
      },
    );
  });

  it("maps round creation and advancement to idempotent versioned REST requests", async () => {
    const round = {
      id: "round_one",
      name: "Program fit",
      order: 1,
      status: "active" as const,
      startsAt: null,
      endsAt: null,
      blind: false,
      rubric: { criteria: [{ key: "clarity", label: "Clarity", type: "numeric" as const, weight: 1, required: true, max: 5 as const }] as const },
      version: 1,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ round, idempotent: false }, 201))
      .mockResolvedValueOnce(jsonResponse({
        rounds: [
          { ...round, status: "complete", version: 2 },
          { ...round, id: "round_two", name: "Final", order: 2, status: "active", version: 2 },
        ],
        idempotent: false,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await createReviewRoundRequest({
      eventId: "event_one",
      name: round.name,
      initialStatus: "active",
      startsAt: null,
      endsAt: null,
      blind: false,
      rubric: round.rubric,
      expectedRoundCount: 0,
      idempotencyKey: "round-create-key-1",
      requestId: "request-round-create",
    });
    await advanceReviewRoundRequest({
      eventId: "event_one",
      roundId: round.id,
      expectedVersion: 1,
      nextRoundId: "round_two",
      expectedNextVersion: 1,
      idempotencyKey: "round-advance-key-1",
      requestId: "request-round-advance",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/events/event_one/review/rounds", {
      method: "POST",
      headers: {
        "x-request-id": "request-round-create",
        "idempotency-key": "round-create-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Program fit",
        initialStatus: "active",
        startsAt: null,
        endsAt: null,
        blind: false,
        rubric: round.rubric,
        expectedRoundCount: 0,
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/events/event_one/review/rounds/round_one/advance", {
      method: "POST",
      headers: {
        "x-request-id": "request-round-advance",
        "idempotency-key": "round-advance-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expectedVersion: 1,
        nextRoundId: "round_two",
        expectedNextVersion: 1,
      }),
    });
  });

  it("maps assignment, scoring, AI, and decisions to their exact REST locations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        assignment: {
          id: "assignment_1",
          reviewerUserId: "reviewer_ada",
          reviewerName: "Ada Reviewer",
          status: "assigned",
          recusalReason: null,
          recusedAt: null,
          version: 1,
        },
        created: true,
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        review: {
          id: "review_1",
          reviewerUserId: "reviewer_ada",
          reviewerName: "Ada Reviewer",
          score: 4,
          scores: [{ criterionKey: "clarity", score: 4 }],
          comment: "Clear and useful.",
          version: 2,
          updatedAt: 1_700_000_000_000,
        },
        submissionStatus: "in_review",
      }))
      .mockResolvedValueOnce(jsonResponse({
        suggestion: {
          id: "review_ai_1",
          label: "AI suggestion — requires human confirmation",
          score: 3,
          scores: [{ criterionKey: "clarity", score: 3 }],
          comment: "AI draft.",
          version: 1,
          createdAt: 1_700_000_000_000,
          inputFields: ["title", "abstract", "rubric"],
        },
        submissionStatus: "in_review",
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        acceptanceEventId: "acceptance_1",
        provisioningId: "provisioning_1",
        submissionId: "submission_one",
        primarySpeakerId: "speaker_1",
        submissionVersion: 4,
        status: "accepted",
        provisioningStatus: "pending",
        idempotent: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        submissionId: "submission_two",
        submissionVersion: 5,
        status: "rejected",
        idempotent: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        revocationEventId: "acceptance_revoked_1",
        submissionId: "submission_one",
        submissionVersion: 5,
        status: "in_review",
        provisioningStatus: "revoked",
        idempotent: false,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await assignReviewerRequest({
      eventId: "event_one",
      roundId: "round_one",
      submissionId: "submission_one",
      reviewerUserId: "reviewer_ada",
      expectedVersion: 0,
      requestId: "request-assign",
    });
    await saveScoreRequest({
      eventId: "event_one",
      roundId: "round_one",
      submissionId: "submission_one",
      expectedVersion: 1,
      scores: [{ criterionKey: "clarity", score: 4 }],
      comment: "Clear and useful.",
      confirmedAiSuggestionId: "review_ai_1",
      requestId: "request-score",
    });
    await requestAiSuggestionRequest({
      eventId: "event_one",
      roundId: "round_one",
      submissionId: "submission_one",
      requestId: "request-ai",
    });
    await acceptSubmissionRequest({
      eventId: "event_one",
      submissionId: "submission_one",
      expectedVersion: 3,
      idempotencyKey: "acceptance-key-1",
      requestId: "request-accept",
    });
    await rejectSubmissionRequest({
      eventId: "event_one",
      submissionId: "submission_two",
      expectedVersion: 4,
      idempotencyKey: "rejection-key-2",
      requestId: "request-reject",
    });
    await revokeAcceptanceRequest({
      eventId: "event_one",
      submissionId: "submission_one",
      expectedVersion: 4,
      idempotencyKey: "revocation-key-1",
      requestId: "request-revoke",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/events/event_one/review/assignments", {
      method: "POST",
      headers: { "x-request-id": "request-assign", "Content-Type": "application/json" },
      body: JSON.stringify({
        roundId: "round_one",
        submissionId: "submission_one",
        reviewerUserId: "reviewer_ada",
        expectedVersion: 0,
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/events/event_one/review/rounds/round_one/submissions/submission_one/score", {
      method: "PUT",
      headers: { "x-request-id": "request-score", "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        scores: [{ criterionKey: "clarity", score: 4 }],
        comment: "Clear and useful.",
        confirmedAiSuggestionId: "review_ai_1",
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/events/event_one/review/rounds/round_one/submissions/submission_one/ai-suggestions", {
      method: "POST",
      headers: { "x-request-id": "request-ai" },
      body: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/events/event_one/review/submissions/submission_one/acceptance", {
      method: "POST",
      headers: {
        "x-request-id": "request-accept",
        "idempotency-key": "acceptance-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/v1/events/event_one/review/submissions/submission_two/rejection", {
      method: "POST",
      headers: {
        "x-request-id": "request-reject",
        "idempotency-key": "rejection-key-2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedVersion: 4 }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/v1/events/event_one/review/submissions/submission_one/acceptance", {
      method: "DELETE",
      headers: {
        "x-request-id": "request-revoke",
        "idempotency-key": "revocation-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedVersion: 4 }),
    });
  });

  it("posts a versioned, idempotent recusal with an optional reason", async () => {
    const output = {
      assignment: {
        id: "assignment_1",
        reviewerUserId: "reviewer_ada",
        reviewerName: "Ada Reviewer",
        status: "recused" as const,
        recusalReason: "Conflict with the submitter",
        recusedAt: 1_700_000_000_000,
        version: 2,
      },
      idempotent: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(output));
    vi.stubGlobal("fetch", fetchMock);

    await expect(recuseAssignmentRequest({
      eventId: "event_one",
      assignmentId: "assignment_1",
      expectedVersion: 1,
      reason: "Conflict with the submitter",
      idempotencyKey: "recusal-key-1",
      requestId: "request-recusal",
    })).resolves.toEqual(output);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/events/event_one/review/assignments/assignment_1/recusal",
      {
        method: "POST",
        headers: {
          "x-request-id": "request-recusal",
          "idempotency-key": "recusal-key-1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 1, reason: "Conflict with the submitter" }),
      },
    );
  });

  it("surfaces the safe mutation error returned by the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: "conflict",
      message: "Review changed; reload before saving",
    }, 409)));

    await expect(saveScoreRequest({
      eventId: "event_one",
      roundId: "round_one",
      submissionId: "submission_one",
      expectedVersion: 1,
      scores: [{ criterionKey: "clarity", score: 4 }],
      requestId: "request-score",
    })).rejects.toThrow("Review changed; reload before saving");
  });
});
