import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Select, Textarea } from "@/ui";
import {
  acceptSubmissionRequest,
  appendReviewCommentRequest,
  assignReviewerRequest,
  recuseAssignmentRequest,
  removeAssignmentRequest,
  rejectSubmissionRequest,
  revokeAcceptanceRequest,
  requestAiSuggestionRequest,
  saveScoreRequest,
} from "../routes/mutations";
import type {
  CriterionScore,
  HumanReview,
  ReviewerAssignment,
  ReviewMember,
  SubmissionReviewDetail,
} from "../schema";
import { RubricScorecard } from "./RubricScorecard";

export interface SubmissionReviewPaneProps {
  readonly eventId: string;
  readonly eventSlug?: string;
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

export interface SubmissionDecisionKeys {
  readonly lifecycleIdentity: string;
  readonly acceptance: string;
  readonly rejection: string;
  readonly revocation: string;
}

export const submissionDecisionLifecycleIdentity = (
  submission: Pick<SubmissionReviewDetail, "id" | "version" | "status" | "acceptance">,
): string => JSON.stringify([
  submission.id,
  submission.version,
  submission.status,
  submission.acceptance?.acceptanceEventId ?? null,
]);

export const decisionKeysForSubmission = (
  lifecycleIdentity: string,
  current?: SubmissionDecisionKeys,
): SubmissionDecisionKeys =>
  current?.lifecycleIdentity === lifecycleIdentity
    ? current
    : {
        lifecycleIdentity,
        acceptance: `review-accept-${crypto.randomUUID()}`,
        rejection: `review-reject-${crypto.randomUUID()}`,
        revocation: `review-revoke-${crypto.randomUUID()}`,
      };

function ScoreRationales({
  reviews,
  submission,
  viewerUserId,
  timezone,
}: {
  readonly reviews: readonly HumanReview[];
  readonly submission: SubmissionReviewDetail;
  readonly viewerUserId: string;
  readonly timezone: string;
}) {
  return (
    <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Score rationales">
      <p className="text-sm leading-6 text-ink-secondary">
        Rationale attached to each reviewer’s rubric score. These remain distinct from the append-only committee thread.
      </p>
      {reviews.length === 0 ? (
        <p className="mt-4 text-sm text-ink-faint">No human score rationales yet.</p>
      ) : (
        <ol className="mt-4 divide-y-2 divide-line-strong border-y-2 border-line-strong" aria-label="Human score rationales">
          {reviews.map((review) => {
            const scoreByCriterion: Record<string, number | string> = {};
            for (const entry of review.scores) scoreByCriterion[entry.criterionKey] = entry.score;
            const author = review.reviewerUserId === viewerUserId ? `You · ${review.reviewerName}` : review.reviewerName;
            return (
              <li key={review.id} className="py-4">
                <article aria-label={`${author} human review`}>
                  <header className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-black text-ink">{author}</p>
                      <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                        {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(review.updatedAt)} {timezone} · version {review.version}
                      </p>
                    </div>
                    <Badge tone="neutral">Human · {review.score === null ? "Unscored" : `${review.score.toFixed(1)} / 5`}</Badge>
                  </header>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">
                    {review.comment || "No written comment supplied."}
                  </p>
                  <dl className="mt-3 flex flex-wrap gap-2">
                    {submission.round?.rubric.criteria.map((criterion) => {
                      const value = scoreByCriterion[criterion.key];
                      const rendered = value === undefined
                        ? "—"
                        : criterion.type === "text"
                          ? String(value)
                          : criterion.type === "dropdown"
                            ? (() => {
                                const option = criterion.options?.find((candidate) => candidate.value === value);
                                return option ? `${option.label} (${option.score} / 5)` : "—";
                              })()
                            : `${value} / 5`;
                      return (
                        <div key={criterion.key} className="rounded-control border-2 border-line-strong bg-surface-muted px-2.5 py-1.5">
                          <dt className="inline text-[10px] font-black uppercase tracking-[0.06em] text-ink-faint">{criterion.label}: </dt>
                          <dd className="inline font-mono text-xs font-black tabular-nums text-ink">{rendered}</dd>
                        </div>
                      );
                    })}
                  </dl>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

export function SubmissionReviewPane({
  eventId,
  eventSlug,
  submission,
  viewerRole,
  viewerUserId,
  reviewers,
  timezone,
  onMutationCommitted,
}: SubmissionReviewPaneProps) {
  const round = submission.round;
  const organizer = viewerRole === "owner" || viewerRole === "admin";
  const currentReview = submission.reviews.find((review) => review.reviewerUserId === viewerUserId);
  const currentAssignment = submission.assignments.find(
    (assignment) => assignment.reviewerUserId === viewerUserId && assignment.status === "assigned",
  );
  const recusedWithoutReassignment = submission.assignments.some(
    (assignment) => assignment.reviewerUserId === viewerUserId && assignment.status === "recused",
  ) && !currentAssignment;
  const hasReviewAccess = organizer || (!submission.recusedByMe && !recusedWithoutReassignment);
  const canScore = round?.status === "active" && hasReviewAccess;
  const canRequestAi = round?.status === "active" && hasReviewAccess;
  const primarySpeaker = submission.speakers.find((speaker) => speaker.isPrimary);
  const [selectedReviewerUserId, setSelectedReviewerUserId] = useState("");
  const [scores, setScores] = useState<readonly CriterionScore[]>(currentReview?.scores ?? []);
  const [comment, setComment] = useState(currentReview?.comment ?? "");
  const [threadBody, setThreadBody] = useState("");
  const [recusalReason, setRecusalReason] = useState("");
  const [confirmedAiSuggestionId, setConfirmedAiSuggestionId] = useState<string>();
  const [pendingOperation, setPendingOperation] = useState<"assign" | "remove" | "recuse" | "score" | "comment" | "ai" | "accept" | "revoke" | "reject">();
  const [mutationError, setMutationError] = useState<string>();
  const decisionKeysRef = useRef<SubmissionDecisionKeys | undefined>(undefined);
  const decisionKeys = decisionKeysForSubmission(
    submissionDecisionLifecycleIdentity(submission),
    decisionKeysRef.current,
  );
  decisionKeysRef.current = decisionKeys;
  const commentKey = useRef(`review-comment-${crypto.randomUUID()}`);
  const recusalKey = useRef(`review-recusal-${crypto.randomUUID()}`);
  const removalKeys = useRef(new Map<string, string>());

  useEffect(() => {
    setScores(currentReview?.scores ?? []);
    setComment(currentReview?.comment ?? "");
    setConfirmedAiSuggestionId(undefined);
    setMutationError(undefined);
  }, [currentReview?.version, submission.id, round?.id]);

  useEffect(() => {
    setThreadBody("");
    setRecusalReason("");
    commentKey.current = `review-comment-${crypto.randomUUID()}`;
    recusalKey.current = `review-recusal-${crypto.randomUUID()}`;
    removalKeys.current.clear();
  }, [submission.id]);

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
      (assignment) => assignment.reviewerUserId === selectedReviewerUserId && assignment.status === "assigned",
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

  const recuse = () => {
    if (!currentAssignment) return;
    void runMutation("recuse", async () => {
      await recuseAssignmentRequest({
        eventId,
        assignmentId: currentAssignment.id,
        expectedVersion: currentAssignment.version,
        ...(recusalReason.trim() ? { reason: recusalReason.trim() } : {}),
        idempotencyKey: recusalKey.current,
        requestId: operationRequestId("review-recusal"),
      });
      recusalKey.current = `review-recusal-${crypto.randomUUID()}`;
      setRecusalReason("");
    });
  };

  const removeAssignment = (assignment: ReviewerAssignment) => {
    if (!organizer) return;
    if (!window.confirm(`Remove ${assignment.reviewerName} from this reviewer queue? Any saved review and its audit history will remain available.`)) return;
    const idempotencyKey = removalKeys.current.get(assignment.id)
      ?? `review-remove-assignment-${crypto.randomUUID()}`;
    removalKeys.current.set(assignment.id, idempotencyKey);
    void runMutation("remove", async () => {
      await removeAssignmentRequest({
        eventId,
        assignmentId: assignment.id,
        expectedVersion: assignment.version,
        idempotencyKey,
        requestId: operationRequestId("review-remove-assignment"),
      });
      removalKeys.current.delete(assignment.id);
    });
  };

  const saveReview = () => {
    if (!round || !canScore || !allCriteriaScored) return;
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

  const appendComment = () => {
    const body = threadBody.trim();
    if (!body) return;
    void runMutation("comment", async () => {
      await appendReviewCommentRequest({
        eventId,
        submissionId: submission.id,
        body,
        idempotencyKey: commentKey.current,
        requestId: operationRequestId("review-comment"),
      });
      setThreadBody("");
      commentKey.current = `review-comment-${crypto.randomUUID()}`;
    });
  };

  const acceptSubmission = () => {
    if (!organizer || submission.acceptance || submission.status === "rejected" || !primarySpeaker) return;
    void runMutation("accept", () => acceptSubmissionRequest({
      eventId,
      submissionId: submission.id,
      expectedVersion: submission.version,
      idempotencyKey: decisionKeys.acceptance,
      requestId: operationRequestId("review-accept"),
    }));
  };

  const rejectSubmission = () => {
    if (!organizer || submission.acceptance || submission.status === "rejected") return;
    void runMutation("reject", () => rejectSubmissionRequest({
      eventId,
      submissionId: submission.id,
      expectedVersion: submission.version,
      idempotencyKey: decisionKeys.rejection,
      requestId: operationRequestId("review-reject"),
    }));
  };

  const revokeAcceptance = () => {
    if (!organizer || !submission.acceptance) return;
    if (!window.confirm("Undo this acceptance? The proposal will return to review and speaker provisioning will be revoked. No email will be sent.")) return;
    void runMutation("revoke", () => revokeAcceptanceRequest({
      eventId,
      submissionId: submission.id,
      expectedVersion: submission.version,
      idempotencyKey: decisionKeys.revocation,
      requestId: operationRequestId("review-revoke"),
    }));
  };

  const allCriteriaScored = Boolean(
    round && scores.length > 0 && round.rubric.criteria.every(
      (criterion) => !criterion.required || scores.some((score) => score.criterionKey === criterion.key),
    ),
  );

  return (
    <article className="space-y-4" aria-label={`Review ${submission.title}`}>
      <header className="border-[3px] border-line-strong bg-accent p-5 text-ink shadow-[6px_6px_0_#171714]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone[submission.status]}>{statusLabel[submission.status]}</Badge>
          <Badge tone="neutral">{submission.category ?? "Uncategorized"}</Badge>
          <span className="text-[10px] font-black uppercase tracking-[0.08em] text-ink">Version {submission.version}</span>
        </div>
        <h2 id={`proposal-heading-${submission.id}`} className="mt-3 max-w-4xl text-3xl font-black leading-tight tracking-[-0.045em] text-ink">{submission.title}</h2>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-ink">
          <span>
            {round?.blind && submission.speakers.length === 0
              ? "Presenter identities hidden for blind review"
              : submission.speakers.map((speaker, index) => (
                <span key={speaker.id}>
                  {index > 0 && ", "}
                  {eventSlug ? (
                    <a className="underline decoration-2 underline-offset-3" href={`/e/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speaker.id)}`}>
                      {speaker.displayName}
                    </a>
                  ) : speaker.displayName}
                  {` (${speaker.role})`}
                </span>
              ))}
          </span>
          <span>Submitted {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(submission.submittedAt)} {timezone}</span>
        </div>
      </header>

      {mutationError && (
        <div role="alert" className="rounded-control border-2 border-line-strong bg-danger-soft px-4 py-3 text-sm font-bold text-danger shadow-[3px_3px_0_#171714]">
          {mutationError}
        </div>
      )}

      <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Proposal brief"><p className="max-w-4xl whitespace-pre-wrap text-sm font-medium leading-6 text-ink-secondary">{submission.abstract}</p></Card>

      {(submission.answers ?? []).length > 0 && (
        <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Proposal responses">
          <dl className="grid gap-4 md:grid-cols-2" aria-label="Configured proposal responses">
            {(submission.answers ?? []).map((answer, index) => (
              <div key={`${answer.label}-${index}`} className="border-l-4 border-line-strong pl-3">
                <dt className="text-[10px] font-black uppercase tracking-[0.06em] text-ink-faint">{answer.label}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm font-semibold leading-6 text-ink-secondary">{answer.value || "—"}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Committee thread">
        <p className="text-sm leading-6 text-ink-secondary">
          Append-only discussion private to this event’s owners, admins, and reviewers. Speakers and API keys cannot author as a human committee member.
        </p>
        {submission.comments.length === 0 ? (
          <p className="mt-4 text-sm text-ink-faint">No committee messages yet.</p>
        ) : (
          <ol className="mt-4 divide-y-2 divide-line-strong border-y-2 border-line-strong" aria-label="Committee thread messages">
            {submission.comments.map((threadComment) => {
              const author = threadComment.authorUserId === viewerUserId
                ? `You · ${threadComment.authorName}`
                : threadComment.authorName;
              return (
                <li key={threadComment.id} className="py-4">
                  <article aria-label={`${author} committee message`}>
                    <header className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-black text-ink">{author}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                        {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(threadComment.createdAt)} {timezone}
                      </p>
                    </header>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{threadComment.body}</p>
                  </article>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-4 border-t-2 border-line-strong pt-4">
          <Textarea
            label="Add committee message"
            hint="Independent from scoring. Messages are append-only and visible only to this event’s review committee."
            maxLength={5_000}
            rows={3}
            value={threadBody}
            disabled={pendingOperation !== undefined}
            onChange={(event) => setThreadBody(event.target.value)}
          />
          <Button
            className="mt-3"
            disabled={!threadBody.trim() || pendingOperation !== undefined}
            loading={pendingOperation === "comment"}
            onClick={appendComment}
          >
            Post message
          </Button>
        </div>
      </Card>

      <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Reviewer assignments">
        <p className="mb-3 text-sm text-ink-secondary">Reviewers can open and score only proposals assigned to them. Owners and admins retain committee-wide access, and recusal preserves the assignment history.</p>
        {submission.assignments.length === 0 ? (
          <p className="text-sm text-ink-faint">No reviewers are assigned in this round.</p>
        ) : (
          <ul className="space-y-2" aria-label="Reviewer assignment history">
            {submission.assignments.map((assignment) => (
              <li key={assignment.id} className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
                <Badge tone={assignment.status === "assigned" ? "accent" : "warning"}>
                  {assignment.status === "assigned" ? "Assigned" : "Recused"} · {assignment.reviewerName}
                </Badge>
                {assignment.status === "recused" ? (
                  <span>
                    {assignment.recusalReason || "No reason provided"}
                    {assignment.recusedAt ? ` · ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(assignment.recusedAt)} ${timezone}` : ""}
                  </span>
                ) : null}
                {organizer && assignment.status === "assigned" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={pendingOperation === "remove"}
                    disabled={pendingOperation !== undefined}
                    onClick={() => removeAssignment(assignment)}
                  >
                    Remove from reviewer queue
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {viewerRole === "reviewer" && currentAssignment && !currentReview ? (
          <div className="mt-4 border-t-2 border-line-strong pt-4">
            <Textarea
              label="Recusal reason (optional)"
              hint="Recusal remains in assignment history and alerts organizers that coverage may need replacing."
              maxLength={2_000}
              rows={3}
              value={recusalReason}
              disabled={pendingOperation !== undefined}
              onChange={(event) => setRecusalReason(event.target.value)}
            />
            <Button
              className="mt-3"
              variant="secondary"
              loading={pendingOperation === "recuse"}
              disabled={pendingOperation !== undefined}
              onClick={recuse}
            >
              Recuse from this submission
            </Button>
          </div>
        ) : null}
        {submission.recusals.length > 0 && (
          <div className="mt-3 space-y-2 border-t-2 border-line-strong pt-3" aria-label="Reviewer recusals">
            {submission.recusals.map((recusal) => (
              <p key={recusal.id} className="text-sm text-ink-secondary">
                <span className="font-black text-ink">{recusal.reviewerName}</span> recused
                {recusal.reason ? ` · ${recusal.reason}` : ""}
              </p>
            ))}
          </div>
        )}
        {organizer && round && (
          <div className="mt-4 grid gap-2 border-t-2 border-line-strong pt-4 sm:grid-cols-[minmax(14rem,1fr)_auto] sm:items-end">
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
                  (assignment) => assignment.reviewerUserId === reviewer.userId && assignment.status === "assigned",
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
        <Card className="[&>header]:bg-production-lime [&>header_h3]:text-ink" title={`${round.name} · ${round.status}`}>
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
                hint="Visible to this event’s review committee. AI text remains a draft until you save it."
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
            <div className={`${canScore ? "mt-5 border-t-2 border-line-strong pt-4" : ""} flex flex-wrap items-center justify-between gap-3`}>
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

      <ScoreRationales
        reviews={submission.reviews}
        submission={submission}
        viewerUserId={viewerUserId}
        timezone={timezone}
      />

      {submission.aiSuggestions.map((suggestion) => (
        <Card className="[&>header]:bg-warning-soft [&>header_h3]:text-ink" key={suggestion.id} title="AI suggestion · non-authoritative">
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
          <p className="mt-2 text-xs text-ink-faint">
            Input limited to: title, abstract, rubric. Suggested average {suggestion.score === null ? "unscored" : `${suggestion.score.toFixed(1)} / 5`}.
          </p>
        </Card>
      ))}

      {submission.acceptance ? (
        <Card className="[&>header]:bg-production-lime [&>header_h3]:text-ink" title="Acceptance decision">
          <Badge tone={submission.acceptance.provisioningStatus === "missing" ? "warning" : "success"}>
            Accepted · provisioning {submission.acceptance.provisioningStatus}
          </Badge>
          {submission.acceptance.provisioningStatus === "missing" ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              This legacy acceptance is missing its speaker provisioning record. The acceptance remains visible; repair provisioning before changing it.
            </p>
          ) : null}
          <p className="mt-2 text-sm text-ink-secondary">Acceptance is recorded in the audit history. No email was sent.</p>
          {organizer && (
            <div className="mt-4">
              <Button
                variant="danger"
                disabled={pendingOperation !== undefined || submission.acceptance.provisioningStatus === "missing"}
                loading={pendingOperation === "revoke"}
                onClick={revokeAcceptance}
              >
                Undo acceptance
              </Button>
            </div>
          )}
        </Card>
      ) : submission.status === "rejected" ? (
        <Card title="Proposal decision">
          <Badge tone="danger">Rejected</Badge>
          <p className="mt-2 text-sm text-ink-secondary">This decision is visible to the submitting account in its proposal dashboard.</p>
        </Card>
      ) : organizer ? (
        <Card className="[&>header]:bg-production-lime [&>header_h3]:text-ink" title="Acceptance decision">
          <p className="text-sm text-ink-secondary">
            Accepting records this exact proposal version and requests portal provisioning for {primarySpeaker?.displayName ?? "the primary speaker"}.
          </p>
          <p className="mt-2 text-sm text-ink-secondary">Accepting or rejecting updates the proposal dashboard only. No email is sent.</p>
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
