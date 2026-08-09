import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Schema } from "effect";
import { EntityId } from "contracts/domain";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { Badge, Button, Card, EmptyState, Input, Select, Skeleton } from "@/ui";
import type { ReviewWorkbench, SubmissionReviewSummary, SubmissionStatus } from "../schema";
import { ReviewWorkbench as ReviewWorkbenchSchema } from "../schema";
import { SubmissionReviewPane } from "../components/SubmissionReviewPane";
import { ReviewRoundSetup } from "../components/ReviewRoundSetup";
import { compareReviewQueue } from "../ordering";

export const path = "/e/:eventSlug/review";

const EventIdentitySchema = Schema.Struct({
  id: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  slug: Schema.String.pipe(Schema.minLength(1)),
  timezone: Schema.String.pipe(Schema.minLength(1)),
});

type EventIdentity = typeof EventIdentitySchema.Type;

export type LoadError =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "event-not-found" }
  | { readonly kind: "review-not-found" }
  | { readonly kind: "failed"; readonly message: string };

class ReviewLoadError extends Error {
  constructor(
    readonly source: "event" | "review",
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Could not load review workbench");
  }
}

export async function loadReviewWorkbench(
  eventSlug: string,
  selectedSubmissionId?: string,
): Promise<{ readonly event: EventIdentity; readonly workbench: ReviewWorkbench }> {
  let event: EventIdentity;
  try {
    event = await apiFetch<EventIdentity>(`/api/v1/events/${encodeURIComponent(eventSlug)}`, {
      schema: EventIdentitySchema,
    });
  } catch (error) {
    throw new ReviewLoadError("event", error);
  }

  const query = selectedSubmissionId
    ? `?selectedSubmissionId=${encodeURIComponent(selectedSubmissionId)}`
    : "";
  try {
    const workbench = await apiFetch<ReviewWorkbench>(
      `/api/v1/events/${encodeURIComponent(event.id)}/review${query}`,
      { schema: ReviewWorkbenchSchema },
    );
    return { event, workbench };
  } catch (error) {
    throw new ReviewLoadError("review", error);
  }
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

export function decideQueueInteraction(
  _interaction: "focus" | "open",
  submissionId: string,
  authoritativeSubmissionId: string | undefined,
  pendingSubmissionId: string | undefined,
): {
  readonly focusedSubmissionId: string;
  readonly loadSubmissionId: string | undefined;
} {
  if (submissionId === authoritativeSubmissionId || submissionId === pendingSubmissionId) {
    return { focusedSubmissionId: submissionId, loadSubmissionId: undefined };
  }
  return { focusedSubmissionId: submissionId, loadSubmissionId: submissionId };
}

export function selectVisibleFallback(
  authoritativeSubmissionId: string | undefined,
  pendingSubmissionId: string | undefined,
  visibleSubmissionIds: readonly string[],
): string | undefined {
  const fallbackSubmissionId = visibleSubmissionIds[0];
  if (!fallbackSubmissionId || visibleSubmissionIds.includes(authoritativeSubmissionId ?? "")) return undefined;
  return decideQueueInteraction(
    "open",
    fallbackSubmissionId,
    authoritativeSubmissionId,
    pendingSubmissionId,
  ).loadSubmissionId;
}

function LoadingWorkbench() {
  return (
    <div className="production-grid min-h-screen space-y-4 bg-canvas p-3 sm:p-4 lg:p-6" aria-busy="true" aria-label="Loading review workbench">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-8 w-full max-w-72 motion-reduce:animate-none" />
        <Skeleton className="h-8 w-32 motion-reduce:animate-none sm:w-36" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
        <Skeleton className="h-[38rem] motion-reduce:animate-none" />
        <Skeleton className="h-[38rem] motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Loading submissions, rounds, and assignments.</span>
    </div>
  );
}

export function errorFrom(error: unknown): LoadError {
  if (error instanceof ReviewLoadError) {
    if (error.cause instanceof ApiError && error.cause.status === 401) return { kind: "unauthenticated" };
    if (error.cause instanceof ApiError && error.cause.status === 404) {
      return { kind: error.source === "event" ? "event-not-found" : "review-not-found" };
    }
  }
  return {
    kind: "failed",
    message: error instanceof Error ? error.message : "Could not load review workbench",
  };
}

export function ReviewLoadFailure({
  error,
  onRetry,
  onSignIn,
}: {
  readonly error: LoadError;
  readonly onRetry: () => void;
  readonly onSignIn: () => void;
}) {
  if (error.kind === "unauthenticated") {
    return (
      <div className="production-grid min-h-screen bg-canvas p-4 sm:p-6">
        <EmptyState
          title="Sign in to review proposals"
          description="Sign in to continue to this event review workspace."
          action={<Button className="min-h-11" onClick={onSignIn}>Sign in</Button>}
        />
      </div>
    );
  }

  if (error.kind === "event-not-found") {
    return (
      <div className="production-grid min-h-screen bg-canvas p-4 sm:p-6">
        <EmptyState title="Event not found" description="This event may have moved or been removed." />
      </div>
    );
  }

  if (error.kind === "review-not-found") {
    return (
      <div className="production-grid min-h-screen bg-canvas p-4 sm:p-6">
        <EmptyState title="Review workspace unavailable" description="Review is not available for this event." />
      </div>
    );
  }

  return (
    <div className="production-grid min-h-screen bg-canvas p-4 sm:p-6">
      <Card>
        <EmptyState
          title="Review queue could not load"
          description={error.message}
          action={<Button className="min-h-11" onClick={onRetry}>Try again</Button>}
        />
      </Card>
    </div>
  );
}

export default function ReviewWorkbenchRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [result, setResult] = useState<{ readonly event: EventIdentity; readonly workbench: ReviewWorkbench }>();
  const [loadError, setLoadError] = useState<LoadError>();
  const [initialRequestVersion, setInitialRequestVersion] = useState(0);
  const [detailRequest, setDetailRequest] = useState<{
    readonly eventSlug: string;
    readonly submissionId: string;
    readonly version: number;
  }>();
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    setResult(undefined);
    setDetailRequest(undefined);
    setIsDetailLoading(false);
    const selectedSubmissionId = new URLSearchParams(location.search).get("selectedSubmissionId") ?? undefined;
    void loadReviewWorkbench(eventSlug, selectedSubmissionId)
      .then((loaded) => {
        if (active) setResult(loaded);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorFrom(error));
      });
    return () => { active = false; };
  }, [eventSlug, initialRequestVersion, location.search]);

  useEffect(() => {
    if (!detailRequest || detailRequest.eventSlug !== eventSlug) return;
    let active = true;
    setLoadError(undefined);
    setIsDetailLoading(true);
    void loadReviewWorkbench(eventSlug, detailRequest.submissionId)
      .then((loaded) => {
        if (active) setResult(loaded);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorFrom(error));
      })
      .finally(() => {
        if (active) setIsDetailLoading(false);
      });
    return () => { active = false; };
  }, [detailRequest, eventSlug]);

  const requestDetail = useCallback((submissionId: string) => {
    setDetailRequest((current) => (
      current?.eventSlug === eventSlug && current.submissionId === submissionId
        ? current
        : { eventSlug, submissionId, version: (current?.version ?? 0) + 1 }
    ));
  }, [eventSlug]);

  const refreshSelectedDetail = useCallback(async (submissionId: string) => {
    const loaded = await loadReviewWorkbench(eventSlug, submissionId);
    setResult(loaded);
  }, [eventSlug]);

  const retry = () => {
    if (result && detailRequest?.eventSlug === eventSlug) {
      setDetailRequest((current) => current && { ...current, version: current.version + 1 });
      return;
    }
    setInitialRequestVersion((version) => version + 1);
  };

  if (loadError) {
    return (
      <ReviewLoadFailure
        error={loadError}
        onRetry={retry}
        onSignIn={() => navigate(loginPathForLocation(location))}
      />
    );
  }
  if (!result) return <LoadingWorkbench />;

  return (
    <ReviewWorkbenchContent
      key={result.event.id}
      workbench={result.workbench}
      isDetailLoading={isDetailLoading}
      onSelectSubmission={requestDetail}
      onMutationCommitted={() => refreshSelectedDetail(result.workbench.selected?.id ?? "")}
    />
  );
}

export function ReviewWorkbenchContent({
  workbench,
  isDetailLoading = false,
  onSelectSubmission,
  onMutationCommitted = async () => undefined,
}: {
  readonly workbench: ReviewWorkbench;
  readonly isDetailLoading?: boolean;
  readonly onSelectSubmission: (submissionId: string) => void;
  readonly onMutationCommitted?: () => Promise<void>;
}) {
  const [focusedId, setFocusedId] = useState(workbench.selected?.id ?? workbench.queue[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [status, setStatus] = useState<SubmissionStatus | "all">("all");
  const [category, setCategory] = useState("all");
  const [assignment, setAssignment] = useState<"all" | "mine" | "assigned" | "unassigned">("all");
  const [order, setOrder] = useState(workbench.order);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const queueButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingSelectionRef = useRef<string | undefined>(undefined);

  const queue = workbench.queue;
  const authoritativeSelectedId = workbench.selected?.id;
  const selected = isDetailLoading ? null : workbench.selected ?? null;
  const loadedRound = workbench.selected?.round
    ?? workbench.rounds.find((round) => round.status === "active")
    ?? workbench.rounds[0]
    ?? null;

  const categories = useMemo(
    () => [...new Set(queue.flatMap((submission) => submission.category ? [submission.category] : []))].sort(),
    [queue],
  );
  const visibleQueue = useMemo(
    () => queue
      .filter((submission) => {
        if (status !== "all" && submission.status !== status) return false;
        if (category !== "all" && submission.category !== category) return false;
        if (assignment === "mine" && !submission.assignedToMe) return false;
        if (assignment === "assigned" && submission.assignmentCount === 0) return false;
        if (assignment === "unassigned" && submission.assignmentCount > 0) return false;
        if (deferredQuery && !`${submission.title} ${submission.category ?? ""}`.toLocaleLowerCase().includes(deferredQuery)) return false;
        return true;
      })
      .sort((left, right) => compareReviewQueue(order, left, right)),
    [assignment, category, deferredQuery, order, queue, status],
  );

  useEffect(() => {
    setFocusedId((currentFocusedId) => {
      if (queue.some((submission) => submission.id === currentFocusedId)) return currentFocusedId;
      return authoritativeSelectedId ?? queue[0]?.id ?? "";
    });
  }, [authoritativeSelectedId, queue]);

  useEffect(() => {
    if (pendingSelectionRef.current === authoritativeSelectedId) pendingSelectionRef.current = undefined;
  }, [authoritativeSelectedId]);

  useEffect(() => {
    const fallbackSubmissionId = selectVisibleFallback(
      authoritativeSelectedId,
      pendingSelectionRef.current,
      visibleQueue.map((submission) => submission.id),
    );
    if (fallbackSubmissionId) {
      pendingSelectionRef.current = fallbackSubmissionId;
      setFocusedId(fallbackSubmissionId);
      onSelectSubmission(fallbackSubmissionId);
      return;
    }

    setFocusedId((currentFocusedId) => {
      if (visibleQueue.some((submission) => submission.id === currentFocusedId)) return currentFocusedId;
      if (authoritativeSelectedId && visibleQueue.some((submission) => submission.id === authoritativeSelectedId)) {
        return authoritativeSelectedId;
      }
      return visibleQueue[0]?.id ?? "";
    });
  }, [authoritativeSelectedId, onSelectSubmission, visibleQueue]);

  const focusSubmission = (submissionId: string) => {
    const decision = decideQueueInteraction(
      "focus",
      submissionId,
      authoritativeSelectedId,
      pendingSelectionRef.current,
    );
    setFocusedId(decision.focusedSubmissionId);
    if (!decision.loadSubmissionId) return;
    pendingSelectionRef.current = decision.loadSubmissionId;
    onSelectSubmission(decision.loadSubmissionId);
  };
  const openSubmission = (submissionId: string) => {
    const decision = decideQueueInteraction(
      "open",
      submissionId,
      authoritativeSelectedId,
      pendingSelectionRef.current,
    );
    setFocusedId(decision.focusedSubmissionId);
    if (!decision.loadSubmissionId) return;
    pendingSelectionRef.current = decision.loadSubmissionId;
    onSelectSubmission(decision.loadSubmissionId);
  };
  const focusQueueItem = (submissionId: string) => {
    requestAnimationFrame(() => queueButtonRefs.current.get(submissionId)?.focus());
  };
  const moveQueueFocus = (currentId: string, direction: -1 | 1) => {
    const currentIndex = visibleQueue.findIndex((submission) => submission.id === currentId);
    if (currentIndex < 0) return;
    const nextId = visibleQueue[Math.min(visibleQueue.length - 1, Math.max(0, currentIndex + direction))]!.id;
    focusSubmission(nextId);
    focusQueueItem(nextId);
  };
  const clearFilters = () => {
    setQuery("");
    setStatus("all");
    setCategory("all");
    setAssignment("all");
    setOrder("coverage");
  };

  return (
    <div
      className="production-grid min-h-screen bg-canvas p-3 sm:p-4 lg:p-6"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === "/" && !target.matches("input, textarea, select")) {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }}
    >
      <header className="mb-6 flex flex-wrap items-end justify-between gap-5 border-[3px] border-line-strong bg-accent p-5 text-ink shadow-[7px_7px_0_#171714] sm:p-6">
        <div>
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-ink">Review desk / evidence queue</p>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-4xl font-black leading-none tracking-[-0.055em] text-ink sm:text-5xl">Proposal review</h1>
            <Badge tone="neutral">{queue.length} in round</Badge>
            <Badge tone="accent">{loadedRound ? `${loadedRound.name} · ${loadedRound.status}` : "No review round"}</Badge>
          </div>
          <p className="mt-3 text-sm font-semibold text-ink">Evidence-first triage for {workbench.eventName}. Times shown in {workbench.timezone}.</p>
        </div>
        <div className="border-l-2 border-ink/35 pl-4 text-left text-[10px] font-black uppercase tracking-[0.08em] text-ink sm:text-right">
          <p>Select proposal: ↑/↓ · Focus detail: Enter · Search: /</p>
          <p>Last updated {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: workbench.timezone }).format(workbench.lastUpdatedAt)} {workbench.timezone}</p>
        </div>
      </header>

      {(workbench.viewerRole === "owner" || workbench.viewerRole === "admin") && (
        <section className="mb-4" aria-label="Review round setup">
          <ReviewRoundSetup
            eventId={workbench.eventId}
            rounds={workbench.rounds}
            onMutationCommitted={onMutationCommitted}
          />
        </section>
      )}

      {queue.length > 0 && (
        <section className="mb-6 grid gap-3 border-2 border-line-strong bg-surface p-4 shadow-[4px_4px_0_#171714] sm:grid-cols-2 xl:grid-cols-[minmax(15rem,1.5fr)_repeat(4,minmax(9rem,0.7fr))]" aria-label="Queue filters">
          <Input ref={searchRef} label="Search proposals" placeholder="Title or category" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Select label="Status" value={status} onChange={(event) => setStatus(event.target.value as SubmissionStatus | "all")}>
            <option value="all">All statuses</option>
            {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          <Select label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
          <Select label="Assignment" value={assignment} onChange={(event) => setAssignment(event.target.value as typeof assignment)}>
            <option value="all">All proposals</option><option value="mine">Assigned to me</option><option value="assigned">Any assignment</option><option value="unassigned">No assignment</option>
          </Select>
          <Select label="Order" value={order} onChange={(event) => setOrder(event.target.value as typeof order)}>
            <option value="coverage">Coverage · fewest reviews</option><option value="decision">Decision · highest score</option>
          </Select>
        </section>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
        <Card className="overflow-hidden shadow-[5px_5px_0_#171714] lg:sticky lg:top-4 [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title={<span className="flex items-center justify-between gap-3"><span>Review queue</span><span className="font-mono text-[10px] font-black tabular-nums text-ink">{queue.length === 0 ? "Empty round" : `${visibleQueue.length} shown`}</span></span>}>
          {queue.length > 0 && (
            <p className="mb-3 border-b-2 border-line-strong pb-3 text-[10px] font-bold uppercase tracking-[0.06em] leading-5 text-ink-faint">
              {order === "coverage"
                ? "Coverage: fewest human reviews first; ties use oldest submission, then stable ID."
                : "Decision: highest average human score first; ties use review count, oldest submission, then stable ID."}
            </p>
          )}
          {queue.length === 0 ? (
            <EmptyState title="No submissions in this round" description={`${loadedRound?.name ?? "This round"} has no assigned or eligible proposals yet. Add proposals to the round before triage.`} />
          ) : visibleQueue.length === 0 ? (
            <EmptyState title="No proposals match these filters" description="Clear the current search, status, category, or assignment filters. No proposal state has changed." action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>} />
          ) : (
            <ol className="-mx-5 -my-4 max-h-[calc(100vh-15rem)] divide-y-2 divide-line-strong overflow-y-auto" aria-label="Submission review queue">
              {visibleQueue.map((submission, index) => {
                const isSelected = submission.id === focusedId;
                return (
                  <li key={submission.id}>
                    <button
                      ref={(element) => {
                        if (element) queueButtonRefs.current.set(submission.id, element);
                        else queueButtonRefs.current.delete(submission.id);
                      }}
                      type="button"
                      tabIndex={isSelected ? 0 : -1}
                      className="group grid w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-production-sky/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent aria-[current=true]:bg-production-lime motion-reduce:transition-none"
                      aria-current={isSelected ? "true" : undefined}
                      onFocus={() => focusSubmission(submission.id)}
                      onClick={() => openSubmission(submission.id)}
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
                          focusSubmission(firstId);
                          focusQueueItem(firstId);
                        } else if (event.key === "End") {
                          event.preventDefault();
                          const lastId = visibleQueue[visibleQueue.length - 1]!.id;
                          focusSubmission(lastId);
                          focusQueueItem(lastId);
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          openSubmission(submission.id);
                          detailRef.current?.focus();
                        }
                      }}
                    >
                      <span className="grid size-8 place-items-center border-2 border-line-strong bg-ink font-mono text-[10px] font-black tabular-nums text-production-lime">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-black text-ink">{submission.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                          <span>{submission.category ?? "Uncategorized"}</span>
                          <span aria-hidden="true">·</span>
                          <span>{statusLabel[submission.status]}</span>
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge tone={reviewStateTone[submission.reviewState]}>{reviewStateLabel[submission.reviewState]}</Badge>
                          <span className="text-[10px] font-bold uppercase tracking-[0.04em] text-ink-faint">
                            {submission.completedReviewCount} human {submission.completedReviewCount === 1 ? "review" : "reviews"}
                          </span>
                          {submission.assignedToMe && <Badge tone="neutral">Assigned to me</Badge>}
                        </span>
                      </span>
                      <span className="pt-0.5 text-right font-mono text-base font-black tabular-nums text-ink">
                        {submission.averageScore === null ? "—" : submission.averageScore.toFixed(1)}
                        <span className="block text-[9px] font-black uppercase tracking-[0.08em] text-ink-faint">/ 5</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        <section ref={detailRef} tabIndex={-1} aria-labelledby={selected ? `proposal-heading-${selected.id}` : undefined} aria-label={selected ? undefined : "Proposal detail"} className="min-w-0 scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {selected ? <SubmissionReviewPane eventId={workbench.eventId} submission={selected} viewerRole={workbench.viewerRole} viewerUserId={workbench.viewerUserId} reviewers={workbench.reviewers} timezone={workbench.timezone} onMutationCommitted={onMutationCommitted} /> : <Card><EmptyState title={queue.length === 0 ? "No proposal detail in this round" : "Loading selected proposal"} description={queue.length === 0 ? "When a proposal enters this round, its abstract, rubric, assignments, and evidence will appear here." : "The authoritative proposal detail is loading."} /></Card>}
        </section>
      </div>
    </div>
  );
}
