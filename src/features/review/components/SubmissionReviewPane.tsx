import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Checkbox, Select, Textarea } from "@/ui";
import type {
  AiSuggestion,
  CriterionScore,
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

export function SubmissionReviewPane({
  submission,
  viewerRole,
  timezone,
  reviewers,
  onAssign,
  onSaveReview,
  onRequestAi,
  onAccept,
}: SubmissionReviewPaneProps) {
  const humanReview = submission.reviews[0];
  const [scores, setScores] = useState<readonly CriterionScore[]>(humanReview?.scores ?? []);
  const [comment, setComment] = useState(humanReview?.comment ?? "");
  const [confirmedAiSuggestionId, setConfirmedAiSuggestionId] = useState<string>();
  const [assignmentId, setAssignmentId] = useState("");
  const [saveState, setSaveState] = useState<AsyncState>("idle");
  const [aiState, setAiState] = useState<AsyncState>("idle");
  const [acceptState, setAcceptState] = useState<AsyncState>("idle");
  const [acceptConfirmed, setAcceptConfirmed] = useState(false);

  useEffect(() => {
    const nextReview = submission.reviews[0];
    setScores(nextReview?.scores ?? []);
    setComment(nextReview?.comment ?? "");
    setConfirmedAiSuggestionId(undefined);
    setAssignmentId("");
    setSaveState("idle");
    setAiState("idle");
    setAcceptState("idle");
    setAcceptConfirmed(false);
  }, [submission.id, submission.reviews]);

  const rubric = submission.round?.rubric;
  const scoresComplete = useMemo(
    () => rubric?.criteria.every((criterion) => scores.some((entry) => entry.criterionKey === criterion.key)) ?? false,
    [rubric, scores],
  );
  const isOrganizer = viewerRole === "owner" || viewerRole === "admin";
  const roundLocked = submission.round?.status === "complete";

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
              onChange={(event) => setAssignmentId(event.target.value)}
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
              disabled={!assignmentId || saveState === "saving"}
              onClick={() => run(setSaveState, () => onAssign(assignmentId))}
            >
              Assign reviewer
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Current reviewers">
            {submission.assignments.length === 0 ? (
              <span className="text-sm text-ink-faint">No reviewers assigned.</span>
            ) : submission.assignments.map((assignment) => (
              <Badge key={assignment.id} tone="accent">Assigned · {assignment.reviewerName}</Badge>
            ))}
          </div>
        </Card>
      )}

      {rubric && (
        <Card
          title={`${submission.round?.name ?? "Review"} · ${submission.round?.status ?? "pending"}`}
          footer={(
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-ink-faint" role="status" aria-live="polite">
                {roundLocked
                  ? "Round complete · scores are read-only."
                  : saveState === "saving"
                    ? "Saving human review…"
                    : saveState === "saved"
                      ? "Human review saved. Submission status did not change."
                      : saveState === "error"
                        ? "Review was not saved. Retry after checking the connection and version."
                        : confirmedAiSuggestionId
                          ? "AI draft applied locally. Save to confirm it as a human review."
                          : "Private to organizers and the assigned reviewer."}
              </p>
              <Button
                disabled={!scoresComplete || roundLocked}
                loading={saveState === "saving"}
                onClick={() => run(setSaveState, () => onSaveReview({
                  scores,
                  comment,
                  ...(confirmedAiSuggestionId ? { confirmedAiSuggestionId } : {}),
                }))}
              >
                Save human review
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
            disabled={roundLocked}
            sourceLabel={confirmedAiSuggestionId ? "AI draft" : "Human review"}
          />
          <Textarea
            className="mt-5"
            label="Private reviewer comment"
            hint="Never shown to speakers or public viewers."
            rows={4}
            value={comment}
            disabled={roundLocked}
            onChange={(event) => {
              setComment(event.target.value);
              setSaveState("idle");
            }}
          />
        </Card>
      )}

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
            <Button variant="secondary" disabled={roundLocked} onClick={() => useAiDraft(suggestion)}>
              Use as draft
            </Button>
          </div>
        </Card>
      ))}

      {rubric && submission.aiSuggestions.length === 0 && !roundLocked && (
        <Card title="Optional AI assist">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-2xl text-sm text-ink-secondary">
              Sends title, abstract, and rubric only. The result is labeled, cannot change status, and must be saved by a human.
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
            {aiState === "saved" ? "Suggestion ready for human review." : aiState === "error" ? "Suggestion failed. No review or status changed." : "Optional"}
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
                Acceptance is explicit. It records this proposal version and creates the primary-speaker provisioning fact used by portal and agenda. AI suggestions cannot perform this action.
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
