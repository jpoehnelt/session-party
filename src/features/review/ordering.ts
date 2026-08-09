import type { SubmissionReviewSummary, WorkbenchOrder } from "./schema";

const compareStableIdentity = (
  left: SubmissionReviewSummary,
  right: SubmissionReviewSummary,
) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/**
 * Coverage puts the least-reviewed, oldest proposals first. Decision puts the
 * strongest human average first, with unscored proposals last. Stable IDs are
 * the final tie-breaker so pagination and keyboard position cannot drift.
 */
export const compareReviewQueue = (
  order: WorkbenchOrder,
  left: SubmissionReviewSummary,
  right: SubmissionReviewSummary,
): number => {
  if (order === "coverage") {
    return left.completedReviewCount - right.completedReviewCount
      || left.submittedAt - right.submittedAt
      || compareStableIdentity(left, right);
  }

  if (left.averageScore === null && right.averageScore !== null) return 1;
  if (left.averageScore !== null && right.averageScore === null) return -1;
  return (right.averageScore ?? 0) - (left.averageScore ?? 0)
    || right.completedReviewCount - left.completedReviewCount
    || left.submittedAt - right.submittedAt
    || compareStableIdentity(left, right);
};
