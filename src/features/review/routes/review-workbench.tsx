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
  const [roundId, setRoundId] = useState(
    snapshot.rounds.find((round) => round.status === "active")?.id ?? snapshot.rounds[0]?.id ?? "",
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);

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
    if (visibleQueue.length > 0 && !visibleQueue.some((submission) => submission.id === selectedId)) {
      setSelectedId(visibleQueue[0]!.id);
    }
  }, [selectedId, visibleQueue]);

  const selected = selectedId
    ? detailOverrides[selectedId] ?? resolveFixtureDetail(selectedId)
    : null;

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

  const moveSelection = (direction: -1 | 1) => {
    if (visibleQueue.length === 0) return;
    const currentIndex = visibleQueue.findIndex((submission) => submission.id === selectedId);
    const nextIndex = currentIndex < 0
      ? 0
      : Math.min(visibleQueue.length - 1, Math.max(0, currentIndex + direction));
    setSelectedId(visibleQueue[nextIndex]!.id);
  };

  if (state === "loading") {
    return (
      <main className="space-y-4 p-4 lg:p-6" aria-busy="true" aria-label="Loading review workbench">
        <div className="flex items-center justify-between"><Skeleton className="h-8 w-72" /><Skeleton className="h-8 w-36" /></div>
        <div className="grid gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
          <Skeleton className="h-[38rem]" />
          <Skeleton className="h-[38rem]" />
        </div>
        <span className="sr-only">Loading submissions, rounds, and assignments.</span>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className="p-6">
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
        const editing = target.matches("input, textarea, select, button");
        if (event.key === "/" && !editing) {
          event.preventDefault();
          searchRef.current?.focus();
        } else if (!editing && event.key === "ArrowDown") {
          event.preventDefault();
          moveSelection(1);
        } else if (!editing && event.key === "ArrowUp") {
          event.preventDefault();
          moveSelection(-1);
        } else if (!editing && event.key === "Enter") {
          detailRef.current?.focus();
        }
      }}
    >
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-ink">Proposal review</h1>
            <Badge tone="neutral">{queue.length} submissions</Badge>
            <Badge tone="accent">
              {snapshot.rounds.find((round) => round.id === roundId)?.name ?? "No round"} · {snapshot.rounds.find((round) => round.id === roundId)?.status ?? "pending"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-ink-secondary">
            Evidence-first triage for {snapshot.eventName}. Times shown in {snapshot.timezone}.
          </p>
        </div>
        <div className="text-right text-xs text-ink-faint">
          <p>List: ↑/↓ · Detail: Enter · Search: /</p>
          <p>
            Fixture snapshot {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: snapshot.timezone,
            }).format(snapshot.lastUpdatedAt)} {snapshot.timezone}
          </p>
        </div>
      </header>

      <section className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(15rem,1.5fr)_repeat(4,minmax(9rem,0.7fr))]" aria-label="Queue filters">
        <Input
          ref={searchRef}
          label="Search proposals"
          placeholder="Title or category"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select label="Round" value={roundId} onChange={(event) => setRoundId(event.target.value)}>
          {snapshot.rounds.map((round) => <option key={round.id} value={round.id}>{round.name} · {round.status}</option>)}
        </Select>
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

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
        <Card
          className="overflow-hidden lg:sticky lg:top-4"
          title={(
            <span className="flex items-center justify-between gap-3">
              <span>Queue</span>
              <span className="font-mono text-xs font-normal tabular-nums text-ink-faint">
                {visibleQueue.length} shown
              </span>
            </span>
          )}
        >
          {visibleQueue.length === 0 ? (
            <EmptyState
              title="No proposals match"
              description="Clear a filter or choose another round. No proposal state has changed."
              action={<Button variant="secondary" onClick={() => { setQuery(""); setStatus("all"); setCategory("all"); setAssignment("all"); }}>Clear filters</Button>}
            />
          ) : (
            <ol className="-mx-5 -my-4 max-h-[calc(100vh-15rem)] divide-y divide-line overflow-y-auto" aria-label="Submission review queue">
              {visibleQueue.map((submission, index) => {
                const isSelected = submission.id === selectedId;
                return (
                  <li key={submission.id}>
                    <button
                      type="button"
                      className="group grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-2 px-3 py-3 text-left outline-none transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none"
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => setSelectedId(submission.id)}
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

        <section ref={detailRef} tabIndex={-1} className="min-w-0 scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {selected ? (
            <SubmissionReviewPane
              submission={selected}
              viewerRole={snapshot.viewerRole}
              timezone={snapshot.timezone}
              reviewers={reviewerDirectoryFixture}
              onAssign={(reviewerId) => {
                const reviewer = reviewerDirectoryFixture.find((candidate) => candidate.id === reviewerId);
                if (!reviewer) throw new Error("Reviewer is unavailable");
                updateSelected((current) => ({
                  ...current,
                  assignments: current.assignments.some((assignment) => assignment.reviewerUserId === reviewerId)
                    ? current.assignments
                    : [...current.assignments, {
                        id: `assignment_local_${reviewerId}`,
                        reviewerUserId: reviewer.id,
                        reviewerName: reviewer.name,
                        version: 1,
                      }],
                  assignmentCount: current.assignments.some((assignment) => assignment.reviewerUserId === reviewerId)
                    ? current.assignmentCount
                    : current.assignmentCount + 1,
                  reviewState: current.reviewState === "unassigned" ? "assigned" : current.reviewState,
                }));
              }}
              onSaveReview={({ scores, comment }) => {
                const score = scores.reduce((total, entry) => total + entry.score, 0) / scores.length;
                updateSelected((current) => {
                  const existing = current.reviews.find((review) => review.reviewerUserId === fixtureReviewerId);
                  const nextReview = {
                    id: existing?.id ?? `review_local_${current.id}`,
                    reviewerUserId: fixtureReviewerId,
                    reviewerName: "Ada Rivera",
                    score,
                    scores,
                    comment,
                    version: (existing?.version ?? 0) + 1,
                    updatedAt: fixtureClock,
                  };
                  return {
                    ...current,
                    reviews: [...current.reviews.filter((review) => review.reviewerUserId !== fixtureReviewerId), nextReview],
                    completedReviewCount: existing ? current.completedReviewCount : current.completedReviewCount + 1,
                    averageScore: score,
                    reviewState: "complete",
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
                title="Select a proposal"
                description="Choose a queue row to inspect its abstract, assignments, rubric evidence, and acceptance state."
              />
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}
