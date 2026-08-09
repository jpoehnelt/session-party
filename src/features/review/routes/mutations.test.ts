import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptSubmissionRequest,
  assignReviewerRequest,
  requestAiSuggestionRequest,
  saveScoreRequest,
} from "./mutations";

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});
afterEach(() => vi.unstubAllGlobals());

describe("review mutation client", () => {
  it("maps assignment, scoring, AI, and acceptance inputs to their exact REST locations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        assignment: {
          id: "assignment_1",
          reviewerUserId: "reviewer_ada",
          reviewerName: "Ada Reviewer",
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
