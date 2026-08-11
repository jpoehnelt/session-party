export function organizerReviewSubmissionPath(eventSlug: string, submissionId: string): string {
  return `/e/${encodeURIComponent(eventSlug)}/review?selectedSubmissionId=${encodeURIComponent(submissionId)}`;
}
