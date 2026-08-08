import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, Select, Skeleton } from "@/ui";
import {
  acceptedProvisionedFixture,
  aiSuggestionFixture,
  detailForFixtureSubmission,
  fixtureClock,
  fixtureReviewerId,
  reviewerDirectoryFixture,
  reviewWorkbenchFixture,
} from "../fixtures";
import type {
  CriterionScore,
  ReviewWorkbench,
  SubmissionReviewDetail,
  SubmissionReviewSummary,
  SubmissionStatus,
} from "../schema";
import { SubmissionReviewPane } from "../components/SubmissionReviewPane";

export interface ReviewWorkbenchRouteProps {
  snapshot?: ReviewWorkbench;
  currentReviewerUserId?: string;
  state?: "loading" | "ready" | "error";
  errorMessage?: string;
  resolveFixtureDetail?: (submissionId: string) => SubmissionReviewDetail | null;
}

const statusLabel: Record<SubmissionStatus, string> = {
  submitted: "Submitted",
  in_review: "In review",
  accepted: "Accepted",
  rejected: "Rejected",
  waitlist: "Waitlist",
  withdrawn: "Withdrawn",
};

const reviewStateLabel: Record<SubmissionReviewSummary["reviewState"], string> = {
  unassigned: "Unassigned",
  assigned: "Assigned",
  in_progress: "Review in progress",
  complete: "Review complete",
};

const reviewStateTone = {
  unassigned: "warning",
  assigned: "neutral",
  in_progress: "accent",
  complete: "success",
} as const;

export default function ReviewWorkbenchRoute({
  snapshot = reviewWorkbenchFixture,
  currentReviewerUserId,
  state = "ready",
  errorMessage,
  resolveFixtureDetail = detailForFixtureSubmission,
}: ReviewWorkbenchRouteProps) {
  const [queue, setQueue] = useState<readonly SubmissionReviewSummary[]>(snapshot.queue);
  const [selectedId, setSelectedId] = useState(snapshot.selected?.id ?? snapshot.queue[0]?.id ?? "");
  const [detailOverrides, setDetailOverrides] = useState<Record<string, SubmissionReviewDetail>>(
    snapshot.selected ? { [snapshot.selected.id]: snapshot.selected } : {},
  );
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [status, setStatus] = useState<SubmissionStatus | "all">("all");
  const [category, setCategory] = useState("all");
  const [assignment, setAssignment] = useState<"all" | "assigned" | "unassigned">("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const queueButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const resolvedReviewerUserId = currentReviewerUserId
    ?? (snapshot.viewerRole === "reviewer" ? fixtureReviewerId : undefined);

  const categories = useMemo(
    () => [...new Set(queue.flatMap((submission) => submission.category ? [submission.category] : []))].sort(),
    [queue],
  );

  const visibleQueue = useMemo(
    () => queue.filter((submission) => {
      if (status !== "all" && submission.status !== status) return false;
      if (category !== "all" && submission.category !== category) return false;
      if (assignment === "assigned" && submission.assignmentCount === 0) return false;
      if (assignment === "unassigned" && submission.assignmentCount > 0) return false;
      if (deferredQuery && !`${submission.title} ${submission.category ?? ""}`.toLocaleLowerCase().includes(deferredQuery)) return false;
      return true;
    }),
    [assignment, category, deferredQuery, queue, status],
  );

  useEffect(() => {
    if (visibleQueue.length === 0) {
      setSelectedId("");
    } else if (!visibleQueue.some((submission) => submission.id === selectedId)) {
      setSelectedId(visibleQueue[0]!.id);
    }
  }, [selectedId, visibleQueue]);

  const selected = selectedId
    ? detailOverrides[selectedId] ?? resolveFixtureDetail(selectedId)
    : null;
  const loadedRound = selected?.round
    ?? snapshot.rounds.find((round) => round.status === "active")
    ?? snapshot.rounds[0]
    ?? null;

  const updateSelected = (update: (current: SubmissionReviewDetail) => SubmissionReviewDetail) => {
    if (!selected) return;
    const next = update(selected);
    setDetailOverrides((current) => ({ ...current, [next.id]: next }));
    setQueue((current) => current.map((submission) => submission.id === next.id
      ? {
          ...submission,
          status: next.status,
          version: next.version,
          reviewState: next.reviewState,
          assignmentCount: next.assignmentCount,
          completedReviewCount: next.completedReviewCount,
          averageScore: next.averageScore,
        }
      : submission));
  };

  const focusQueueItem = (submissionId: string) => {
    requestAnimationFrame(() => queueButtonRefs.current.get(submissionId)?.focus());
  };

  const moveQueueFocus = (currentId: string, direction: -1 | 1) => {
    const currentIndex = visibleQueue.findIndex((submission) => submission.id === currentId);
    if (currentIndex < 0) return;
    const nextIndex = Math.min(visibleQueue.length - 1, Math.max(0, currentIndex + direction));
    const nextId = visibleQueue[nextIndex]!.id;
    setSelectedId(nextId);
    focusQueueItem(nextId);
  };

  const clearFilters = () => {
    setQuery("");
    setStatus("all");
    setCategory("all");
    setAssignment("all");
  };

  if (state === "loading") {
    return (
      <main className="space-y-4 p-3 sm:p-4 lg:p-6" aria-busy="true" aria-label="Loading review workbench">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-8 w-full max-w-72 motion-reduce:animate-none" />
          <Skeleton className="h-8 w-32 motion-reduce:animate-none sm:w-36" />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
          <Skeleton className="h-[38rem] motion-reduce:animate-none" />
          <Skeleton className="h-[38rem] motion-reduce:animate-none" />
        </div>
        <span className="sr-only">Loading submissions, rounds, and assignments.</span>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className="p-4 sm:p-6">
        <Card>
          <EmptyState
            title="Review queue could not load"
            description={errorMessage ?? "Reload the workbench. If the problem continues, check event access and the current review round."}
            action={<Button onClick={() => window.location.reload()}>Reload workbench</Button>}
          />
        </Card>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen bg-canvas p-3 sm:p-4 lg:p-6"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === "/" && !target.matches("input, textarea, select")) {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }}
    >
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-ink">Proposal review</h1>
            <Badge tone="neutral">{queue.length} in round</Badge>
            <Badge tone="accent">
              {loadedRound ? `${loadedRound.name} · ${loadedRound.status}` : "No review round"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-ink-secondary">
            Evidence-first triage for {snapshot.eventName}. Times shown in {snapshot.timezone}.
          </p>
        </div>
        <div className="text-left text-xs text-ink-faint sm:text-right">
          <p>Queue focus: ↑/↓ · Open detail: Enter · Search: /</p>
          <p>
            Fixture snapshot {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: snapshot.timezone,
            }).format(snapshot.lastUpdatedAt)} {snapshot.timezone}
          </p>
        </div>
      </header>

      {queue.length > 0 && (
        <section className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(15rem,1.5fr)_repeat(3,minmax(9rem,0.7fr))]" aria-label="Queue filters">
          <Input
            ref={searchRef}
            label="Search proposals"
            placeholder="Title or category"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select label="Status" value={status} onChange={(event) => setStatus(event.target.value as SubmissionStatus | "all")}>
            <option value="all">All statuses</option>
            {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          <Select label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
          <Select label="Assignment" value={assignment} onChange={(event) => setAssignment(event.target.value as typeof assignment)}>
            <option value="all">All assignments</option>
            <option value="assigned">Assigned</option>
            <option value="unassigned">Unassigned</option>
          </Select>
        </section>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
        <Card
          className="overflow-hidden lg:sticky lg:top-4"
          title={(
            <span className="flex items-center justify-between gap-3">
              <span>Queue</span>
              <span className="font-mono text-xs font-normal tabular-nums text-ink-faint">
                {queue.length === 0 ? "Empty round" : `${visibleQueue.length} shown`}
              </span>
            </span>
          )}
        >
          {queue.length === 0 ? (
            <EmptyState
              title="No submissions in this round"
              description={`${loadedRound?.name ?? "This round"} has no assigned or eligible proposals yet. Add proposals to the round before triage.`}
            />
          ) : visibleQueue.length === 0 ? (
            <EmptyState
              title="No proposals match these filters"
              description="Clear the current search, status, category, or assignment filters. No proposal state has changed."
              action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
            />
          ) : (
            <ol className="-mx-5 -my-4 max-h-[calc(100vh-15rem)] divide-y divide-line overflow-y-auto" aria-label="Submission review queue">
              {visibleQueue.map((submission, index) => {
                const isSelected = submission.id === selectedId;
                return (
                  <li key={submission.id}>
                    <button
                      ref={(element) => {
                        if (element) queueButtonRefs.current.set(submission.id, element);
                        else queueButtonRefs.current.delete(submission.id);
                      }}
                      type="button"
                      tabIndex={isSelected ? 0 : -1}
                      className="group grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-2 px-3 py-3 text-left outline-none transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none"
                      aria-current={isSelected ? "true" : undefined}
                      onFocus={() => setSelectedId(submission.id)}
                      onClick={() => setSelectedId(submission.id)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          moveQueueFocus(submission.id, 1);
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          moveQueueFocus(submission.id, -1);
                        } else if (event.key === "Home") {
                          event.preventDefault();
                          const firstId = visibleQueue[0]!.id;
                          setSelectedId(firstId);
                          focusQueueItem(firstId);
                        } else if (event.key === "End") {
                          event.preventDefault();
                          const lastId = visibleQueue[visibleQueue.length - 1]!.id;
                          setSelectedId(lastId);
                          focusQueueItem(lastId);
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          setSelectedId(submission.id);
                          detailRef.current?.focus();
                        }
                      }}
                    >
                      <span className="pt-0.5 font-mono text-xs tabular-nums text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">{submission.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                          <span>{submission.category ?? "Uncategorized"}</span>
                          <span aria-hidden="true">·</span>
                          <span>{statusLabel[submission.status]}</span>
                        </span>
                        <span className="mt-1.5 block">
                          <Badge tone={reviewStateTone[submission.reviewState]}>{reviewStateLabel[submission.reviewState]}</Badge>
                        </span>
                      </span>
                      <span className="pt-0.5 text-right font-mono text-sm font-semibold tabular-nums text-ink">
                        {submission.averageScore === null ? "—" : submission.averageScore.toFixed(1)}
                        <span className="block text-[10px] font-normal text-ink-faint">/ 5</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        <section
          ref={detailRef}
          tabIndex={-1}
          aria-labelledby={selected ? `proposal-heading-${selected.id}` : undefined}
          aria-label={selected ? undefined : "Proposal detail"}
          className="min-w-0 scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {selected ? (
            <SubmissionReviewPane
              submission={selected}
              viewerRole={snapshot.viewerRole}
              {...(resolvedReviewerUserId ? { currentReviewerUserId: resolvedReviewerUserId } : {})}
              timezone={snapshot.timezone}
              reviewers={reviewerDirectoryFixture}
              onAssign={(reviewerId) => {
                const reviewer = reviewerDirectoryFixture.find((candidate) => candidate.id === reviewerId);
                if (!reviewer) throw new Error("Reviewer is unavailable");
                updateSelected((current) => ({
                  ...current,
                  assignments: current.assignments.some((candidate) => candidate.reviewerUserId === reviewerId)
                    ? current.assignments
                    : [...current.assignments, {
                        id: `assignment_local_${reviewerId}`,
                        reviewerUserId: reviewer.id,
                        reviewerName: reviewer.name,
                        version: 1,
                      }],
                  assignmentCount: current.assignments.some((candidate) => candidate.reviewerUserId === reviewerId)
                    ? current.assignmentCount
                    : current.assignmentCount + 1,
                  reviewState: current.reviewState === "unassigned" ? "assigned" : current.reviewState,
                }));
              }}
              onSaveReview={({ scores, comment }) => {
                if (!resolvedReviewerUserId) throw new Error("Current reviewer identity is required");
                const reviewerName = reviewerDirectoryFixture.find((reviewer) => reviewer.id === resolvedReviewerUserId)?.name
                  ?? selected.reviews.find((review) => review.reviewerUserId === resolvedReviewerUserId)?.reviewerName
                  ?? "Current reviewer";
                const score = scores.reduce((total, entry) => total + entry.score, 0) / scores.length;
                updateSelected((current) => {
                  const existing = current.reviews.find((review) => review.reviewerUserId === resolvedReviewerUserId);
                  const nextReview = {
                    id: existing?.id ?? `review_local_${current.id}_${resolvedReviewerUserId}`,
                    reviewerUserId: resolvedReviewerUserId,
                    reviewerName,
                    score,
                    scores,
                    comment,
                    version: (existing?.version ?? 0) + 1,
                    updatedAt: fixtureClock,
                  };
                  const nextReviews = [
                    ...current.reviews.filter((review) => review.reviewerUserId !== resolvedReviewerUserId),
                    nextReview,
                  ];
                  const completedReviewCount = existing
                    ? current.completedReviewCount
                    : current.completedReviewCount + 1;
                  return {
                    ...current,
                    reviews: nextReviews,
                    completedReviewCount,
                    averageScore: nextReviews.reduce((total, review) => total + review.score, 0) / nextReviews.length,
                    reviewState: completedReviewCount >= current.assignmentCount ? "complete" : "in_progress",
                  };
                });
              }}
              onRequestAi={() => updateSelected((current) => ({
                ...current,
                aiSuggestions: current.aiSuggestions.length === 0 ? [aiSuggestionFixture] : current.aiSuggestions,
              }))}
              onAccept={() => updateSelected((current) => ({
                ...current,
                status: "accepted",
                version: current.version + 1,
                acceptance: {
                  ...acceptedProvisionedFixture,
                  acceptanceEventId: `acceptance_local_${current.id}`,
                  provisioningId: `provisioning_local_${current.id}`,
                  submissionVersion: current.version + 1,
                  acceptedAt: fixtureClock,
                  provisioningStatus: "pending",
                },
              }))}
            />
          ) : (
            <Card>
              <EmptyState
                title={queue.length === 0 ? "No proposal detail in this round" : "No filtered proposal selected"}
                description={queue.length === 0
                  ? "When a proposal enters this round, its abstract, rubric, assignments, and evidence will appear here."
                  : "Clear or adjust the queue filters, then focus a proposal row and press Enter to move into its detail."}
              />
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}
