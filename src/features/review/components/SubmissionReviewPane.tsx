import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Checkbox, Select, Textarea } from "@/ui";
import type {
  AiSuggestion,
  CriterionScore,
  HumanReview,
  SubmissionReviewDetail,
} from "../schema";
import { RubricScorecard } from "./RubricScorecard";

export interface ReviewerOption {
  readonly id: string;
  readonly name: string;
  readonly assignmentCount: number;
}

export interface SubmissionReviewPaneProps {
  submission: SubmissionReviewDetail;
  viewerRole: "owner" | "admin" | "reviewer";
  currentReviewerUserId?: string;
  timezone: string;
  reviewers: readonly ReviewerOption[];
  onAssign: (reviewerId: string) => Promise<void> | void;
  onSaveReview: (input: {
    scores: readonly CriterionScore[];
    comment: string;
    confirmedAiSuggestionId?: string;
  }) => Promise<void> | void;
  onRequestAi: () => Promise<void> | void;
  onAccept: () => Promise<void> | void;
}

type AsyncState = "idle" | "saving" | "saved" | "error";

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
  review: HumanReview;
  submission: SubmissionReviewDetail;
  isCurrentReviewer: boolean;
}) {
  const scoreByCriterion: Record<string, number> = {};
  for (const entry of review.scores) scoreByCriterion[entry.criterionKey] = entry.score;
  return (
    <Card title={`${isCurrentReviewer ? "Your review" : review.reviewerName} · read-only evidence`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <Badge tone="neutral">Human review · version {review.version}</Badge>
        <span className="font-mono text-sm font-semibold tabular-nums text-ink">
          {review.score.toFixed(1)} / 5
        </span>
      </div>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {submission.round?.rubric.criteria.map((criterion) => (
          <div key={criterion.key} className="rounded-control border border-line bg-surface-muted px-3 py-2">
            <dt className="text-xs text-ink-faint">{criterion.label}</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-ink">
              {scoreByCriterion[criterion.key] ?? "—"} / 5
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">Private rationale</p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">
          {review.comment || "No private rationale supplied."}
        </p>
      </div>
    </Card>
  );
}

export function SubmissionReviewPane({
  submission,
  viewerRole,
  currentReviewerUserId,
  timezone,
  reviewers,
  onAssign,
  onSaveReview,
  onRequestAi,
  onAccept,
}: SubmissionReviewPaneProps) {
  const currentReview = currentReviewerUserId
    ? submission.reviews.find((review) => review.reviewerUserId === currentReviewerUserId)
    : undefined;
  const [scores, setScores] = useState<readonly CriterionScore[]>(currentReview?.scores ?? []);
  const [comment, setComment] = useState(currentReview?.comment ?? "");
  const [confirmedAiSuggestionId, setConfirmedAiSuggestionId] = useState<string>();
  const [assignmentId, setAssignmentId] = useState("");
  const [assignmentState, setAssignmentState] = useState<AsyncState>("idle");
  const [saveState, setSaveState] = useState<AsyncState>("idle");
  const [aiState, setAiState] = useState<AsyncState>("idle");
  const [acceptState, setAcceptState] = useState<AsyncState>("idle");
  const [acceptConfirmed, setAcceptConfirmed] = useState(false);

  useEffect(() => {
    const nextReview = currentReviewerUserId
      ? submission.reviews.find((review) => review.reviewerUserId === currentReviewerUserId)
      : undefined;
    setScores(nextReview?.scores ?? []);
    setComment(nextReview?.comment ?? "");
    setConfirmedAiSuggestionId(undefined);
    setAssignmentId("");
    setAssignmentState("idle");
    setSaveState("idle");
    setAiState("idle");
    setAcceptState("idle");
    setAcceptConfirmed(false);
  }, [currentReviewerUserId, submission.id, submission.reviews]);

  const rubric = submission.round?.rubric;
  const scoresComplete = useMemo(
    () => rubric?.criteria.every((criterion) => scores.some((entry) => entry.criterionKey === criterion.key)) ?? false,
    [rubric, scores],
  );
  const isOrganizer = viewerRole === "owner" || viewerRole === "admin";
  const roundStatus = submission.round?.status;
  const roundActive = roundStatus === "active";
  const roundComplete = roundStatus === "complete";
  const canAssign = roundStatus === "pending" || roundActive;
  const assignedCurrentReviewer = currentReviewerUserId !== undefined && submission.assignments.some(
    (assignment) => assignment.reviewerUserId === currentReviewerUserId,
  );
  const canEditCurrentReview = Boolean(rubric && roundActive && assignedCurrentReviewer);
  const canRequestAi = Boolean(rubric && roundActive && (isOrganizer || assignedCurrentReviewer));
  const evidenceReviews = canEditCurrentReview
    ? submission.reviews.filter((review) => review.reviewerUserId !== currentReviewerUserId)
    : submission.reviews;
  const selectedReviewerName = reviewers.find((reviewer) => reviewer.id === assignmentId)?.name;

  const useAiDraft = (suggestion: AiSuggestion) => {
    setScores(suggestion.scores);
    setComment(suggestion.comment);
    setConfirmedAiSuggestionId(suggestion.id);
    setSaveState("idle");
  };

  const run = async (setState: (state: AsyncState) => void, action: () => Promise<void> | void) => {
    setState("saving");
    try {
      await action();
      setState("saved");
    } catch {
      setState("error");
    }
  };

  return (
    <article className="space-y-4" aria-label={`Review ${submission.title}`}>
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone[submission.status]}>{statusLabel[submission.status]}</Badge>
          <Badge tone="neutral">{submission.category ?? "Uncategorized"}</Badge>
          <span className="text-xs text-ink-faint">Version {submission.version}</span>
        </div>
        <h2 className="mt-3 max-w-4xl text-2xl font-semibold leading-tight tracking-tight text-ink">
          {submission.title}
        </h2>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-secondary">
          <span>
            {submission.speakers.map((speaker) => `${speaker.displayName}${speaker.isPrimary ? " (primary)" : ""}`).join(", ")}
          </span>
          <span>
            Submitted {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: timezone,
            }).format(submission.submittedAt)} {timezone}
          </span>
        </div>
      </header>

      <Card title="Proposal">
        <p className="max-w-4xl whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{submission.abstract}</p>
      </Card>

      {isOrganizer && (
        <Card title="Reviewer assignment">
          <div className="grid gap-3 lg:grid-cols-[minmax(15rem,1fr)_auto] lg:items-end">
            <Select
              label="Assign another reviewer"
              value={assignmentId}
              disabled={!canAssign}
              onChange={(event) => {
                setAssignmentId(event.target.value);
                setAssignmentState("idle");
              }}
            >
              <option value="">Choose reviewer</option>
              {reviewers.map((reviewer) => (
                <option key={reviewer.id} value={reviewer.id}>
                  {reviewer.name} · {reviewer.assignmentCount} assigned
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              disabled={!assignmentId || !canAssign}
              loading={assignmentState === "saving"}
              onClick={() => run(setAssignmentState, () => onAssign(assignmentId))}
            >
              Assign reviewer
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-faint" role="status" aria-live="polite">
            {!canAssign
              ? roundComplete
                ? "Round complete · assignments are locked."
                : "Assignments require a pending or active review round."
              : assignmentState === "saving"
                ? `Assigning ${selectedReviewerName ?? "reviewer"}…`
                : assignmentState === "saved"
                  ? `${selectedReviewerName ?? "Reviewer"} assigned to this round.`
                  : assignmentState === "error"
                    ? "Reviewer was not assigned. Reload the round and retry."
                    : "Assignments are available while the round is pending or active."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Current reviewers">
            {submission.assignments.length === 0 ? (
              <span className="text-sm text-ink-faint">No reviewers assigned in this round.</span>
            ) : submission.assignments.map((assignment) => (
              <Badge key={assignment.id} tone="accent">Assigned · {assignment.reviewerName}</Badge>
            ))}
          </div>
        </Card>
      )}

      {rubric && canEditCurrentReview && (
        <Card
          title={`${submission.round?.name ?? "Review"} · active · your review`}
          footer={(
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-ink-faint" role="status" aria-live="polite">
                {saveState === "saving"
                  ? "Saving your human review…"
                  : saveState === "saved"
                    ? "Your human review was saved. Submission status did not change."
                    : saveState === "error"
                      ? "Your review was not saved. Reload the current version and retry."
                      : confirmedAiSuggestionId
                        ? "AI draft applied locally. Save to confirm it as your human review."
                        : "Editable only by the currently assigned reviewer."}
              </p>
              <Button
                disabled={!scoresComplete}
                loading={saveState === "saving"}
                onClick={() => run(setSaveState, () => onSaveReview({
                  scores,
                  comment,
                  ...(confirmedAiSuggestionId ? { confirmedAiSuggestionId } : {}),
                }))}
              >
                Save my review
              </Button>
            </div>
          )}
        >
          <RubricScorecard
            rubric={rubric}
            scores={scores}
            onChange={(next) => {
              setScores(next);
              setConfirmedAiSuggestionId(undefined);
              setSaveState("idle");
            }}
            sourceLabel={confirmedAiSuggestionId ? "AI draft" : "Human review"}
          />
          <Textarea
            className="mt-5"
            label="My private rationale"
            hint="Visible to organizers; never shown to speakers or public viewers."
            rows={4}
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
              setSaveState("idle");
            }}
          />
        </Card>
      )}

      {rubric && !canEditCurrentReview && (
        <Card title={`${submission.round?.name ?? "Review"} · ${roundStatus ?? "unavailable"}`}>
          <p className="text-sm text-ink-secondary">
            {roundStatus === "pending"
              ? "Scoring opens when this round becomes active. Assignments may be prepared now."
              : roundComplete
                ? "This round is complete. All human reviews are read-only evidence."
                : currentReviewerUserId
                  ? "You are not assigned to this submission in the active round, so its rubric is read-only."
                  : "Select an assigned reviewer identity before creating a human review. Existing evidence remains read-only."}
          </p>
        </Card>
      )}

      {evidenceReviews.map((review) => (
        <ReadOnlyReviewEvidence
          key={review.id}
          review={review}
          submission={submission}
          isCurrentReviewer={review.reviewerUserId === currentReviewerUserId}
        />
      ))}

      {submission.aiSuggestions.map((suggestion) => (
        <Card key={suggestion.id} title="AI suggestion · non-authoritative">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <Badge tone="warning">AI · human confirmation required</Badge>
              <p className="mt-3 text-sm leading-6 text-ink-secondary">{suggestion.comment}</p>
              <p className="mt-2 text-xs text-ink-faint">
                Input limited to: title, abstract, rubric. Suggested average {suggestion.score.toFixed(1)} / 5.
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={!canEditCurrentReview}
              onClick={() => useAiDraft(suggestion)}
            >
              Use as my draft
            </Button>
          </div>
          {!canEditCurrentReview && (
            <p className="mt-2 text-xs text-ink-faint">Only the currently assigned reviewer can apply this suggestion to an editable draft.</p>
          )}
        </Card>
      ))}

      {rubric && submission.aiSuggestions.length === 0 && canRequestAi && (
        <Card title="Optional AI assist">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-2xl text-sm text-ink-secondary">
              Sends title, abstract, and rubric only. The result is labeled, cannot change status, and requires human confirmation.
            </p>
            <Button
              variant="secondary"
              loading={aiState === "saving"}
              onClick={() => run(setAiState, onRequestAi)}
            >
              Request AI suggestion
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-faint" role="status" aria-live="polite">
            {aiState === "saved" ? "Suggestion ready for human review." : aiState === "error" ? "Suggestion failed. No review or status changed." : "Optional and non-authoritative"}
          </p>
        </Card>
      )}

      {isOrganizer && (
        <Card title="Acceptance decision">
          {submission.acceptance ? (
            <div className="space-y-2">
              <Badge tone="success">Accepted · provisioning {submission.acceptance.provisioningStatus}</Badge>
              <p className="text-sm text-ink-secondary">
                Durable acceptance {submission.acceptance.acceptanceEventId} at submission version {submission.acceptance.submissionVersion}.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="max-w-3xl text-sm leading-6 text-ink-secondary">
                Acceptance records this proposal version and creates the primary-speaker provisioning fact used by portal and agenda. AI suggestions cannot perform this action.
              </p>
              <Checkbox
                label={`Confirm acceptance of version ${submission.version}`}
                description="This changes proposal status to Accepted and starts primary-speaker provisioning."
                checked={acceptConfirmed}
                onChange={(event) => setAcceptConfirmed(event.target.checked)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!acceptConfirmed || submission.status === "accepted"}
                  loading={acceptState === "saving"}
                  onClick={() => run(setAcceptState, onAccept)}
                >
                  Accept &amp; provision primary speaker
                </Button>
                <span className="text-xs text-ink-faint" role="status" aria-live="polite">
                  {acceptState === "saved"
                    ? "Accepted. Provisioning fact created."
                    : acceptState === "error"
                      ? "Acceptance was not recorded. Reload before retrying."
                      : "Versioned and idempotent"}
                </span>
              </div>
            </div>
          )}
        </Card>
      )}
    </article>
  );
}
