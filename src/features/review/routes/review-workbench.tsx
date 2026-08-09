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
  interaction: "focus" | "open",
  submissionId: string,
  authoritativeSubmissionId: string | undefined,
  pendingSubmissionId: string | undefined,
): {
  readonly focusedSubmissionId: string;
  readonly loadSubmissionId: string | undefined;
} {
  if (interaction === "focus") return { focusedSubmissionId: submissionId, loadSubmissionId: undefined };
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
    <section className="space-y-4 p-3 sm:p-4 lg:p-6" aria-busy="true" aria-labelledby="review-workbench-heading">
      <h1 id="review-workbench-heading" className="sr-only">Proposal review</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-8 w-full max-w-72 motion-reduce:animate-none" />
        <Skeleton className="h-8 w-32 motion-reduce:animate-none sm:w-36" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
        <Skeleton className="h-[38rem] motion-reduce:animate-none" />
        <Skeleton className="h-[38rem] motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Loading submissions, rounds, and assignments.</span>
    </section>
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
  const content = error.kind === "unauthenticated"
    ? {
        title: "Sign in to review proposals",
        description: "Sign in to continue to this event review workspace.",
        action: <Button className="min-h-11" onClick={onSignIn}>Sign in</Button>,
      }
    : error.kind === "event-not-found"
      ? {
          title: "Event not found",
          description: "This event may have moved or been removed.",
          action: undefined,
        }
      : error.kind === "review-not-found"
        ? {
            title: "Review workspace unavailable",
            description: "Review is not available for this event.",
            action: undefined,
          }
        : {
            title: "Review queue could not load",
            description: error.message,
            action: <Button className="min-h-11" onClick={onRetry}>Try again</Button>,
          };

  const state = (
    <div className="flex flex-col items-start py-10 text-left sm:items-center sm:text-center">
      <h1 className="text-base font-semibold text-ink">{content.title}</h1>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-ink-faint">{content.description}</p>
      {content.action != null && <div className="mt-5">{content.action}</div>}
    </div>
  );

  return (
    <section className="p-4 sm:p-6">
      {error.kind === "failed" ? <Card>{state}</Card> : state}
    </section>
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
    void loadReviewWorkbench(eventSlug)
      .then((loaded) => {
        if (active) setResult(loaded);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorFrom(error));
      });
    return () => { active = false; };
  }, [eventSlug, initialRequestVersion]);

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
    />
  );
}

export function ReviewWorkbenchContent({
  workbench,
  isDetailLoading = false,
  onSelectSubmission,
}: {
  readonly workbench: ReviewWorkbench;
  readonly isDetailLoading?: boolean;
  readonly onSelectSubmission: (submissionId: string) => void;
}) {
  const [focusedId, setFocusedId] = useState(workbench.selected?.id ?? workbench.queue[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [status, setStatus] = useState<SubmissionStatus | "all">("all");
  const [category, setCategory] = useState("all");
  const [assignment, setAssignment] = useState<"all" | "assigned" | "unassigned">("all");
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
  };

  return (
    <div
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
            <Badge tone="accent">{loadedRound ? `${loadedRound.name} · ${loadedRound.status}` : "No review round"}</Badge>
          </div>
          <p className="mt-1 text-sm text-ink-secondary">Evidence-first triage for {workbench.eventName}. Times shown in {workbench.timezone}.</p>
        </div>
        <div className="text-left text-xs text-ink-faint sm:text-right">
          <p>Queue focus: ↑/↓ · Open detail: Enter · Search: /</p>
          <p>Last updated {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: workbench.timezone }).format(workbench.lastUpdatedAt)} {workbench.timezone}</p>
        </div>
      </header>

      {queue.length > 0 && (
        <section className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(15rem,1.5fr)_repeat(3,minmax(9rem,0.7fr))]" aria-label="Queue filters">
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
            <option value="all">All assignments</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option>
          </Select>
        </section>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
        <Card className="overflow-hidden lg:sticky lg:top-4" title={<span className="flex items-center justify-between gap-3"><span>Queue</span><span className="font-mono text-xs font-normal tabular-nums text-ink-faint">{queue.length === 0 ? "Empty round" : `${visibleQueue.length} shown`}</span></span>}>
          {queue.length === 0 ? (
            <EmptyState title="No submissions in this round" description={`${loadedRound?.name ?? "This round"} has no assigned or eligible proposals yet. Add proposals to the round before triage.`} />
          ) : visibleQueue.length === 0 ? (
            <EmptyState title="No proposals match these filters" description="Clear the current search, status, category, or assignment filters. No proposal state has changed." action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>} />
          ) : (
            <ol className="-mx-5 -my-4 max-h-[calc(100vh-15rem)] divide-y divide-line overflow-y-auto" aria-label="Submission review queue">
              {visibleQueue.map((submission, index) => {
                const isSelected = submission.id === focusedId;
                return <li key={submission.id}><button ref={(element) => { if (element) queueButtonRefs.current.set(submission.id, element); else queueButtonRefs.current.delete(submission.id); }} type="button" tabIndex={isSelected ? 0 : -1} className="group grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-2 px-3 py-3 text-left outline-none transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none" aria-current={isSelected ? "true" : undefined} onFocus={() => focusSubmission(submission.id)} onClick={() => openSubmission(submission.id)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); moveQueueFocus(submission.id, 1); } else if (event.key === "ArrowUp") { event.preventDefault(); moveQueueFocus(submission.id, -1); } else if (event.key === "Home") { event.preventDefault(); const firstId = visibleQueue[0]!.id; focusSubmission(firstId); focusQueueItem(firstId); } else if (event.key === "End") { event.preventDefault(); const lastId = visibleQueue[visibleQueue.length - 1]!.id; focusSubmission(lastId); focusQueueItem(lastId); } else if (event.key === "Enter") { event.preventDefault(); openSubmission(submission.id); detailRef.current?.focus(); } }}>
                  <span className="pt-0.5 font-mono text-xs tabular-nums text-ink-faint">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{submission.title}</span><span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint"><span>{submission.category ?? "Uncategorized"}</span><span aria-hidden="true">·</span><span>{statusLabel[submission.status]}</span></span><span className="mt-1.5 block"><Badge tone={reviewStateTone[submission.reviewState]}>{reviewStateLabel[submission.reviewState]}</Badge></span></span><span className="pt-0.5 text-right font-mono text-sm font-semibold tabular-nums text-ink">{submission.averageScore === null ? "—" : submission.averageScore.toFixed(1)}<span className="block text-[10px] font-normal text-ink-faint">/ 5</span></span>
                </button></li>;
              })}
            </ol>
          )}
        </Card>

        <section ref={detailRef} tabIndex={-1} aria-labelledby={selected ? `proposal-heading-${selected.id}` : undefined} aria-label={selected ? undefined : "Proposal detail"} className="min-w-0 scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {selected ? <SubmissionReviewPane submission={selected} viewerRole={workbench.viewerRole} timezone={workbench.timezone} /> : <Card><EmptyState title={queue.length === 0 ? "No proposal detail in this round" : "Loading selected proposal"} description={queue.length === 0 ? "When a proposal enters this round, its abstract, rubric, assignments, and evidence will appear here." : "The authoritative proposal detail is loading."} /></Card>}
        </section>
      </div>
    </div>
  );
}
