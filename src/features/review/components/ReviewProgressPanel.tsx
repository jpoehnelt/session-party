import { Badge, Card, EmptyState, Table } from "@/ui";
import type {
  ReviewRoundProgress,
  ReviewerRoundProgress,
  SubmissionRoundProgress,
} from "../schema";

export function ReviewProgressPanel({ progress }: { readonly progress: ReviewRoundProgress }) {
  const percent = progress.assignedReviewCount === 0
    ? 0
    : Math.round((progress.completedReviewCount / progress.assignedReviewCount) * 100);

  return (
    <Card className="[&>header]:bg-production-lime [&>header_h3]:text-ink" title={`${progress.roundName} · review progress`}>
      <div className="grid gap-3 sm:grid-cols-4" aria-label="Round review totals">
        <div className="border-2 border-line-strong bg-surface-muted p-3">
          <p className="font-mono text-2xl font-black tabular-nums">{progress.completedReviewCount} / {progress.assignedReviewCount}</p>
          <p className="text-[10px] font-black uppercase tracking-[0.08em] text-ink-faint">assigned reviews complete</p>
        </div>
        <div className="border-2 border-line-strong bg-surface-muted p-3">
          <p className="font-mono text-2xl font-black tabular-nums">{percent}%</p>
          <p className="text-[10px] font-black uppercase tracking-[0.08em] text-ink-faint">round coverage</p>
        </div>
        <div className="border-2 border-line-strong bg-surface-muted p-3">
          <p className="font-mono text-2xl font-black tabular-nums">{progress.outstandingReviewCount}</p>
          <p className="text-[10px] font-black uppercase tracking-[0.08em] text-ink-faint">reviews outstanding</p>
        </div>
        <div className="border-2 border-line-strong bg-surface-muted p-3">
          <p className="font-mono text-2xl font-black tabular-nums">{progress.recusalCount}</p>
          <p className="text-[10px] font-black uppercase tracking-[0.08em] text-ink-faint">recusals recorded</p>
        </div>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <section aria-labelledby="reviewer-progress-heading">
          <h3 id="reviewer-progress-heading" className="mb-3 text-sm font-black uppercase tracking-[0.08em]">Per reviewer</h3>
          <Table
            columns={[
              { key: "reviewer", header: "Reviewer", render: (reviewer: ReviewerRoundProgress) => reviewer.reviewerName },
              { key: "complete", header: "Complete", render: (reviewer: ReviewerRoundProgress) => `${reviewer.completedReviewCount} / ${reviewer.assignedReviewCount}` },
              { key: "outstanding", header: "Open", render: (reviewer: ReviewerRoundProgress) => reviewer.outstandingReviewCount > 0 ? <Badge tone="warning">{reviewer.outstandingReviewCount}</Badge> : <Badge tone="success">0</Badge> },
              { key: "recusals", header: "Recused", render: (reviewer: ReviewerRoundProgress) => reviewer.recusalCount },
            ]}
            rows={[...progress.reviewers]}
            rowKey={(reviewer) => reviewer.reviewerUserId}
            empty="No event reviewers yet."
          />
        </section>

        <section aria-labelledby="review-bottlenecks-heading">
          <h3 id="review-bottlenecks-heading" className="mb-3 text-sm font-black uppercase tracking-[0.08em]">Coverage bottlenecks</h3>
          {progress.incompleteSubmissions.length === 0 ? (
            <EmptyState title="No assignment bottlenecks" description="Every active assignment in this round has a matching human review." />
          ) : (
            <Table
              columns={[
                { key: "submission", header: "Submission", render: (submission: SubmissionRoundProgress) => <span className="font-bold">{submission.title}</span> },
                { key: "coverage", header: "Coverage", render: (submission: SubmissionRoundProgress) => `${submission.completedReviewCount} / ${submission.assignedReviewCount}` },
                { key: "blocker", header: "Blocker", render: (submission: SubmissionRoundProgress) => submission.needsReviewer
                  ? <Badge tone="danger">Needs reviewer</Badge>
                  : <span className="text-xs text-ink-secondary">{submission.outstandingReviewerNames.join(", ")}</span> },
              ]}
              rows={[...progress.incompleteSubmissions]}
              rowKey={(submission) => submission.submissionId}
              empty="No incomplete assigned reviews."
            />
          )}
        </section>
      </div>
    </Card>
  );
}
