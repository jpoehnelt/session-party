import { Badge, Card } from "@/ui";
import type { HumanReview, SubmissionReviewDetail } from "../schema";

export interface SubmissionReviewPaneProps {
  readonly submission: SubmissionReviewDetail;
  readonly viewerRole: "owner" | "admin" | "reviewer";
  readonly currentReviewerUserId?: string;
  readonly timezone: string;
}

const statusTone = {
  submitted: "neutral",
  in_review: "accent",
  accepted: "success",
  rejected: "danger",
  waitlist: "warning",
  withdrawn: "neutral",
} as const;

const statusLabel = {
  submitted: "Submitted",
  in_review: "In review",
  accepted: "Accepted",
  rejected: "Rejected",
  waitlist: "Waitlist",
  withdrawn: "Withdrawn",
} as const;

function ReadOnlyReviewEvidence({
  review,
  submission,
  isCurrentReviewer,
}: {
  readonly review: HumanReview;
  readonly submission: SubmissionReviewDetail;
  readonly isCurrentReviewer: boolean;
}) {
  const scoreByCriterion: Record<string, number> = {};
  for (const entry of review.scores) scoreByCriterion[entry.criterionKey] = entry.score;
  return (
    <Card title={`${isCurrentReviewer ? "Your review" : review.reviewerName} · read-only evidence`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <Badge tone="neutral">Human review · version {review.version}</Badge>
        <span className="font-mono text-sm font-semibold tabular-nums text-ink">{review.score.toFixed(1)} / 5</span>
      </div>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {submission.round?.rubric.criteria.map((criterion) => (
          <div key={criterion.key} className="rounded-control border border-line bg-surface-muted px-3 py-2">
            <dt className="text-xs text-ink-faint">{criterion.label}</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-ink">{scoreByCriterion[criterion.key] ?? "—"} / 5</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">Private rationale</p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{review.comment || "No private rationale supplied."}</p>
      </div>
    </Card>
  );
}

export function SubmissionReviewPane({ submission, currentReviewerUserId, timezone }: SubmissionReviewPaneProps) {
  const roundStatus = submission.round?.status;
  return (
    <article className="space-y-4" aria-label={`Review ${submission.title}`}>
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone[submission.status]}>{statusLabel[submission.status]}</Badge>
          <Badge tone="neutral">{submission.category ?? "Uncategorized"}</Badge>
          <span className="text-xs text-ink-faint">Version {submission.version}</span>
        </div>
        <h2 id={`proposal-heading-${submission.id}`} className="mt-3 max-w-4xl text-2xl font-semibold leading-tight tracking-tight text-ink">{submission.title}</h2>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-secondary">
          <span>{submission.speakers.map((speaker) => `${speaker.displayName}${speaker.isPrimary ? " (primary)" : ""}`).join(", ")}</span>
          <span>Submitted {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(submission.submittedAt)} {timezone}</span>
        </div>
      </header>

      <Card title="Proposal"><p className="max-w-4xl whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{submission.abstract}</p></Card>

      <Card title="Reviewer assignments">
        {submission.assignments.length === 0 ? (
          <p className="text-sm text-ink-faint">No reviewers are assigned in this round.</p>
        ) : (
          <div className="flex flex-wrap gap-2" aria-label="Current reviewers">
            {submission.assignments.map((assignment) => <Badge key={assignment.id} tone="accent">Assigned · {assignment.reviewerName}</Badge>)}
          </div>
        )}
      </Card>

      {submission.round && (
        <Card title={`${submission.round.name} · ${roundStatus}`}>
          <p className="text-sm text-ink-secondary">Review controls are unavailable until the authenticated reviewer identity and mutation request metadata are available from the API.</p>
        </Card>
      )}

      {submission.reviews.map((review) => <ReadOnlyReviewEvidence key={review.id} review={review} submission={submission} isCurrentReviewer={review.reviewerUserId === currentReviewerUserId} />)}

      {submission.aiSuggestions.map((suggestion) => (
        <Card key={suggestion.id} title="AI suggestion · non-authoritative">
          <Badge tone="warning">AI · human confirmation required</Badge>
          <p className="mt-3 text-sm leading-6 text-ink-secondary">{suggestion.comment}</p>
          <p className="mt-2 text-xs text-ink-faint">Input limited to: title, abstract, rubric. Suggested average {suggestion.score.toFixed(1)} / 5.</p>
        </Card>
      ))}

      {submission.acceptance && (
        <Card title="Acceptance decision">
          <Badge tone="success">Accepted · provisioning {submission.acceptance.provisioningStatus}</Badge>
          <p className="mt-2 text-sm text-ink-secondary">Durable acceptance {submission.acceptance.acceptanceEventId} at submission version {submission.acceptance.submissionVersion}.</p>
        </Card>
      )}
    </article>
  );
}
