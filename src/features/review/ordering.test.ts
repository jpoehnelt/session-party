import { describe, expect, it } from "vitest";
import type { SubmissionReviewSummary } from "./schema";
import { compareReviewQueue } from "./ordering";

const summary = (
  id: string,
  completedReviewCount: number,
  averageScore: number | null,
  submittedAt: number,
): SubmissionReviewSummary => ({
  id,
  title: id,
  category: null,
  status: "submitted",
  submittedAt,
  version: 1,
  reviewState: completedReviewCount > 0 ? "in_progress" : "unassigned",
  assignedToMe: false,
  assignmentCount: 0,
  completedReviewCount,
  averageScore,
});

describe("review queue ordering", () => {
  it("orders coverage by fewest human reviews, then oldest submission and stable ID", () => {
    const queue = [
      summary("submission_c", 1, 5, 100),
      summary("submission_b", 0, null, 50),
      summary("submission_a", 0, null, 50),
      summary("submission_d", 0, null, 200),
    ];

    expect(queue.sort((left, right) => compareReviewQueue("coverage", left, right)).map(({ id }) => id)).toEqual([
      "submission_a",
      "submission_b",
      "submission_d",
      "submission_c",
    ]);
  });

  it("orders decisions by highest human average, then review count, age, and stable ID, with unscored last", () => {
    const queue = [
      summary("submission_unscored", 0, null, 1),
      summary("submission_fewer", 1, 4.5, 20),
      summary("submission_newer", 2, 4.5, 30),
      summary("submission_b", 2, 4.5, 20),
      summary("submission_a", 2, 4.5, 20),
      summary("submission_lower", 3, 4.2, 1),
    ];

    expect(queue.sort((left, right) => compareReviewQueue("decision", left, right)).map(({ id }) => id)).toEqual([
      "submission_a",
      "submission_b",
      "submission_newer",
      "submission_fewer",
      "submission_lower",
      "submission_unscored",
    ]);
    expect(queue.sort((left, right) => compareReviewQueue("decision_asc", left, right)).map(({ id }) => id)).toEqual([
      "submission_lower",
      "submission_fewer",
      "submission_a",
      "submission_b",
      "submission_newer",
      "submission_unscored",
    ]);
  });
});
