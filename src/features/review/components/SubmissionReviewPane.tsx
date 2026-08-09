import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Select, Textarea } from "@/ui";
import {
  acceptSubmissionRequest,
  assignReviewerRequest,
  rejectSubmissionRequest,
  requestAiSuggestionRequest,
  saveScoreRequest,
} from "../routes/mutations";
import type {
  CriterionScore,
  HumanReview,
  ReviewMember,
  SubmissionReviewDetail,
} from "../schema";
import { RubricScorecard } from "./RubricScorecard";

export interface SubmissionReviewPaneProps {
  readonly eventId: string;
  readonly submission: SubmissionReviewDetail;
  readonly viewerRole: "owner" | "admin" | "reviewer";
  readonly viewerUserId: string;
  readonly reviewers: readonly ReviewMember[];
  readonly timezone: string;
  readonly onMutationCommitted: () => Promise<void>;
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

const operationRequestId = (operation: string) => `${operation}-${crypto.randomUUID()}`;

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

export function SubmissionReviewPane({
  eventId,
  submission,
  viewerRole,
  viewerUserId,
  reviewers,
  timezone,
  onMutationCommitted,
}: SubmissionReviewPaneProps) {
  const round = submission.round;
  const organizer = viewerRole === "owner" || viewerRole === "admin";
  const currentAssignment = submission.assignments.find(
    (assignment) => assignment.reviewerUserId === viewerUserId,
  );
  const currentReview = submission.reviews.find((review) => review.reviewerUserId === viewerUserId);
  const canScore = Boolean(round?.status === "active" && currentAssignment);
  const canRequestAi = Boolean(round?.status === "active" && (organizer || currentAssignment));
  const primarySpeaker = submission.speakers.find((speaker) => speaker.isPrimary);
  const [selectedReviewerUserId, setSelectedReviewerUserId] = useState("");
  const [scores, setScores] = useState<readonly CriterionScore[]>(currentReview?.scores ?? []);
  const [comment, setComment] = useState(currentReview?.comment ?? "");
  const [confirmedAiSuggestionId, setConfirmedAiSuggestionId] = useState<string>();
  const [pendingOperation, setPendingOperation] = useState<"assign" | "score" | "ai" | "accept" | "reject">();
  const [mutationError, setMutationError] = useState<string>();
  const acceptanceKey = useRef(`review-accept-${crypto.randomUUID()}`);
  const rejectionKey = useRef(`review-reject-${crypto.randomUUID()}`);

  useEffect(() => {
    setScores(currentReview?.scores ?? []);
    setComment(currentReview?.comment ?? "");
    setConfirmedAiSuggestionId(undefined);
    setMutationError(undefined);
  }, [currentReview?.version, submission.id, round?.id]);

  const runMutation = async (
    operation: NonNullable<typeof pendingOperation>,
    commit: () => Promise<unknown>,
  ) => {
    setPendingOperation(operation);
    setMutationError(undefined);
    let committed = false;
    try {
      await commit();
      committed = true;
      await onMutationCommitted();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The review change could not be completed.";
      setMutationError(committed ? `The change was saved, but the latest review data could not load: ${message}` : message);
    } finally {
      setPendingOperation(undefined);
    }
  };

  const assignSelectedReviewer = () => {
    if (!round || !selectedReviewerUserId) return;
    const existingAssignment = submission.assignments.find(
      (assignment) => assignment.reviewerUserId === selectedReviewerUserId,
    );
    void runMutation("assign", () => assignReviewerRequest({
      eventId,
      roundId: round.id,
      submissionId: submission.id,
      reviewerUserId: selectedReviewerUserId,
      expectedVersion: existingAssignment?.version ?? 0,
      requestId: operationRequestId("review-assign"),
    }));
  };

  const saveReview = () => {
    if (!round || !canScore || scores.length !== round.rubric.criteria.length) return;
    const completeScores = scores as readonly [CriterionScore, ...CriterionScore[]];
    void runMutation("score", () => saveScoreRequest({
      eventId,
      roundId: round.id,
      submissionId: submission.id,
      expectedVersion: currentReview?.version ?? 0,
      scores: completeScores,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ...(confirmedAiSuggestionId ? { confirmedAiSuggestionId } : {}),
      requestId: operationRequestId("review-score"),
    }));
  };

  const requestAi = () => {
    if (!round || !canRequestAi) return;
    void runMutation("ai", () => requestAiSuggestionRequest({
      eventId,
      roundId: round.id,
      submissionId: submission.id,
      requestId: operationRequestId("review-ai"),
    }));
  };

  const acceptSubmission = () => {
    if (!organizer || submission.acceptance || submission.status === "rejected" || !primarySpeaker) return;
    void runMutation("accept", () => acceptSubmissionRequest({
      eventId,
      submissionId: submission.id,
      expectedVersion: submission.version,
      idempotencyKey: acceptanceKey.current,
      requestId: operationRequestId("review-accept"),
    }));
  };

  const rejectSubmission = () => {
    if (!organizer || submission.acceptance || submission.status === "rejected") return;
    void runMutation("reject", () => rejectSubmissionRequest({
      eventId,
      submissionId: submission.id,
      expectedVersion: submission.version,
      idempotencyKey: rejectionKey.current,
      requestId: operationRequestId("review-reject"),
    }));
  };

  const allCriteriaScored = Boolean(
    round && round.rubric.criteria.every(
      (criterion) => scores.some((score) => score.criterionKey === criterion.key),
    ),
  );

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

      {mutationError && (
        <div role="alert" className="rounded-control border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
          {mutationError}
        </div>
      )}

      <Card title="Proposal"><p className="max-w-4xl whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{submission.abstract}</p></Card>

      <Card title="Reviewer assignments">
        {submission.assignments.length === 0 ? (
          <p className="text-sm text-ink-faint">No reviewers are assigned in this round.</p>
        ) : (
          <div className="flex flex-wrap gap-2" aria-label="Current reviewers">
            {submission.assignments.map((assignment) => <Badge key={assignment.id} tone="accent">Assigned · {assignment.reviewerName}</Badge>)}
          </div>
        )}
        {organizer && round && (
          <div className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[minmax(14rem,1fr)_auto] sm:items-end">
            <Select
              label="Assign reviewer"
              value={selectedReviewerUserId}
              disabled={round.status === "complete" || pendingOperation !== undefined || reviewers.length === 0}
              hint={reviewers.length === 0 ? "Add an event member with the reviewer role first." : undefined}
              onChange={(event) => setSelectedReviewerUserId(event.target.value)}
            >
              <option value="">Choose reviewer</option>
              {reviewers.map((reviewer) => {
                const assigned = submission.assignments.some(
                  (assignment) => assignment.reviewerUserId === reviewer.userId,
                );
                return <option key={reviewer.userId} value={reviewer.userId}>{reviewer.name}{assigned ? " · assigned" : ""}</option>;
              })}
            </Select>
            <Button
              variant="secondary"
              disabled={!selectedReviewerUserId || round.status === "complete" || pendingOperation !== undefined}
              loading={pendingOperation === "assign"}
              onClick={assignSelectedReviewer}
            >
              Assign reviewer
            </Button>
          </div>
        )}
      </Card>

      {round && (canScore || canRequestAi) && (
        <Card title={`${round.name} · ${round.status}`}>
          {canScore && (
            <div className="space-y-4">
              <RubricScorecard
                rubric={round.rubric}
                scores={scores}
                onChange={setScores}
                disabled={pendingOperation !== undefined}
                sourceLabel={confirmedAiSuggestionId ? "AI draft" : "Human review"}
              />
              <Textarea
                label="Private rationale"
                hint="Visible to event organizers and you. AI text remains a draft until you save it."
                maxLength={5_000}
                rows={5}
                value={comment}
                disabled={pendingOperation !== undefined}
                onChange={(event) => setComment(event.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!allCriteriaScored || pendingOperation !== undefined}
                  loading={pendingOperation === "score"}
                  onClick={saveReview}
                >
                  Save my review
                </Button>
                <span className="text-xs text-ink-faint">
                  {currentReview ? `Updates review version ${currentReview.version}.` : "Creates your human review."}
                </span>
              </div>
            </div>
          )}
          {canRequestAi && (
            <div className={`${canScore ? "mt-5 border-t border-line pt-4" : ""} flex flex-wrap items-center justify-between gap-3`}>
              <p className="max-w-2xl text-sm text-ink-secondary">AI assistance uses only the proposal title, abstract, and rubric. It cannot accept a proposal or count as a human review.</p>
              <Button
                variant="secondary"
                disabled={pendingOperation !== undefined}
                loading={pendingOperation === "ai"}
                onClick={requestAi}
              >
                Request AI suggestion
              </Button>
            </div>
          )}
        </Card>
      )}

      {submission.reviews
        .filter((review) => !canScore || review.reviewerUserId !== viewerUserId)
        .map((review) => <ReadOnlyReviewEvidence key={review.id} review={review} submission={submission} isCurrentReviewer={review.reviewerUserId === viewerUserId} />)}

      {submission.aiSuggestions.map((suggestion) => (
        <Card key={suggestion.id} title="AI suggestion · non-authoritative">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Badge tone="warning">AI · human confirmation required</Badge>
            {canScore && (
              <Button
                size="sm"
                variant="secondary"
                disabled={pendingOperation !== undefined}
                onClick={() => {
                  setScores(suggestion.scores);
                  setComment(suggestion.comment);
                  setConfirmedAiSuggestionId(suggestion.id);
                }}
              >
                Use as draft
              </Button>
            )}
          </div>
          <p className="mt-3 text-sm leading-6 text-ink-secondary">{suggestion.comment}</p>
          <p className="mt-2 text-xs text-ink-faint">Input limited to: title, abstract, rubric. Suggested average {suggestion.score.toFixed(1)} / 5.</p>
        </Card>
      ))}

      {submission.acceptance ? (
        <Card title="Acceptance decision">
          <Badge tone="success">Accepted · provisioning {submission.acceptance.provisioningStatus}</Badge>
          <p className="mt-2 text-sm text-ink-secondary">Durable acceptance {submission.acceptance.acceptanceEventId} at submission version {submission.acceptance.submissionVersion}.</p>
        </Card>
      ) : submission.status === "rejected" ? (
        <Card title="Proposal decision">
          <Badge tone="danger">Rejected</Badge>
          <p className="mt-2 text-sm text-ink-secondary">This decision is visible to the submitting account in its proposal dashboard.</p>
        </Card>
      ) : organizer ? (
        <Card title="Acceptance decision">
          <p className="text-sm text-ink-secondary">
            Accepting records this exact proposal version and requests portal provisioning for {primarySpeaker?.displayName ?? "the primary speaker"}.
          </p>
          {!primarySpeaker && <p role="alert" className="mt-2 text-sm text-danger">A primary speaker is required before acceptance.</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={!primarySpeaker || pendingOperation !== undefined}
              loading={pendingOperation === "accept"}
              onClick={acceptSubmission}
            >
              Accept &amp; provision primary speaker
            </Button>
            <Button
              variant="danger"
              disabled={pendingOperation !== undefined}
              loading={pendingOperation === "reject"}
              onClick={rejectSubmission}
            >
              Reject proposal
            </Button>
          </div>
        </Card>
      ) : null}
    </article>
  );
}
