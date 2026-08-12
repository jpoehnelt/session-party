import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Schema } from "effect";
import { EntityId } from "contracts/domain";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { Badge, Button, Card, Checkbox, EmptyState, Input, Select, Skeleton } from "@/ui";
import { ReviewerInvitations } from "@/features/events/components/ReviewerInvitations";
import type { ReviewWorkbench, SubmissionReviewDetail, SubmissionReviewSummary, SubmissionStatus } from "../schema";
import { ReviewWorkbench as ReviewWorkbenchSchema } from "../schema";
import { SubmissionReviewPane } from "../components/SubmissionReviewPane";
import { ReviewRoundSetup } from "../components/ReviewRoundSetup";
import { ReviewProgressPanel } from "../components/ReviewProgressPanel";
import { compareReviewQueue } from "../ordering";
import {
  bulkAssignReviewersRequest,
  exportReviewResultsRequest,
  sendReviewRemindersRequest,
} from "./mutations";

export const path = "/e/:eventSlug/review";
export const contentWidth = "canvas" as const;

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
  options: {
    readonly event?: EventIdentity;
    readonly signal?: AbortSignal;
    readonly search?: string;
  } = {},
): Promise<{ readonly event: EventIdentity; readonly workbench: ReviewWorkbench }> {
  let event: EventIdentity;
  try {
    event = options.event ?? await apiFetch<EventIdentity>(`/api/v1/events/${encodeURIComponent(eventSlug)}`, {
      schema: EventIdentitySchema,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ReviewLoadError("event", error);
  }

  const sourceParams = new URLSearchParams(options.search ?? "");
  const params = new URLSearchParams();
  for (const key of ["roundId", "assignedToMe", "status", "category", "order", "page", "pageSize"]) {
    const value = sourceParams.get(key);
    if (value !== null) params.set(key, value);
  }
  if (!params.has("pageSize")) params.set("pageSize", "100");
  if (selectedSubmissionId) params.set("selectedSubmissionId", selectedSubmissionId);
  const queryString = params.toString();
  const query = queryString ? `?${queryString}` : "";
  try {
    const workbench = await apiFetch<ReviewWorkbench>(
      `/api/v1/events/${encodeURIComponent(event.id)}/review${query}`,
      { schema: ReviewWorkbenchSchema, signal: options.signal },
    );
    return { event, workbench };
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ReviewLoadError("review", error);
  }
}

export function reviewSelectionSearch(currentSearch: string, submissionId: string): string {
  const params = new URLSearchParams(currentSearch);
  if (submissionId) params.set("selectedSubmissionId", submissionId);
  else params.delete("selectedSubmissionId");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function selectCachedReviewDetail(
  workbench: ReviewWorkbench,
  detail: SubmissionReviewDetail,
): ReviewWorkbench {
  const summary = workbench.queue.find((submission) => submission.id === detail.id);
  return {
    ...workbench,
    selected: summary ? { ...detail, ...summary } : detail,
  };
}

export function shouldApplyReviewRefresh(
  activeSubmissionId: string | undefined,
  refreshedSubmissionId: string,
): boolean {
  return activeSubmissionId === refreshedSubmissionId;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof Error && error.name === "AbortError")
    || (error instanceof ReviewLoadError && isAbortError(error.cause));
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
          headingLevel={1}
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
        <EmptyState headingLevel={1} title="Event not found" description="This event may have moved or been removed." />
      </div>
    );
  }

  if (error.kind === "review-not-found") {
    return (
      <div className="production-grid min-h-screen bg-canvas p-4 sm:p-6">
        <EmptyState headingLevel={1} title="Review workspace unavailable" description="Review is not available for this event." />
      </div>
    );
  }

  return (
    <div className="production-grid min-h-screen bg-canvas p-4 sm:p-6">
      <Card>
        <EmptyState
          headingLevel={1}
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
  const eventRef = useRef<EventIdentity | undefined>(undefined);
  const selectedSubmissionIdRef = useRef<string | undefined>(undefined);
  const detailCacheRef = useRef(new Map<string, SubmissionReviewDetail>());
  const detailAbortRef = useRef<AbortController | undefined>(undefined);
  const mutationRefreshAbortRef = useRef<AbortController | undefined>(undefined);
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    detailAbortRef.current?.abort();
    mutationRefreshAbortRef.current?.abort();
    detailCacheRef.current.clear();
    eventRef.current = undefined;
    selectedSubmissionIdRef.current = undefined;
    setLoadError(undefined);
    setResult(undefined);
    setDetailRequest(undefined);
    setIsDetailLoading(false);
    const selectedSubmissionId = new URLSearchParams(location.search).get("selectedSubmissionId") ?? undefined;
    void loadReviewWorkbench(eventSlug, selectedSubmissionId, { signal: controller.signal, search: locationRef.current.search })
      .then((loaded) => {
        if (!active) return;
        eventRef.current = loaded.event;
        selectedSubmissionIdRef.current = loaded.workbench.selected?.id;
        if (loaded.workbench.selected) {
          detailCacheRef.current.set(loaded.workbench.selected.id, loaded.workbench.selected);
        }
        setResult(loaded);
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) setLoadError(errorFrom(error));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [eventSlug, initialRequestVersion]);

  useEffect(() => {
    if (!detailRequest || detailRequest.eventSlug !== eventSlug) return;
    const event = eventRef.current;
    if (!event) return;
    let active = true;
    const controller = new AbortController();
    detailAbortRef.current?.abort();
    detailAbortRef.current = controller;
    setLoadError(undefined);
    setIsDetailLoading(true);
    void loadReviewWorkbench(eventSlug, detailRequest.submissionId, { event, signal: controller.signal, search: locationRef.current.search })
      .then((loaded) => {
        if (!active) return;
        const detail = loaded.workbench.selected;
        if (detail) detailCacheRef.current.set(detail.id, detail);
        if (selectedSubmissionIdRef.current === detailRequest.submissionId) setResult(loaded);
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) setLoadError(errorFrom(error));
      })
      .finally(() => {
        if (active) setIsDetailLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [detailRequest, eventSlug]);

  const requestDetail = useCallback((submissionId: string, syncUrl = true) => {
    selectedSubmissionIdRef.current = submissionId;
    mutationRefreshAbortRef.current?.abort();
    const cached = detailCacheRef.current.get(submissionId);
    if (cached) {
      setDetailRequest(undefined);
      setIsDetailLoading(false);
      setResult((current) => current && {
        ...current,
        workbench: selectCachedReviewDetail(current.workbench, cached),
      });
    } else {
      setIsDetailLoading(true);
      setDetailRequest((current) => (
        current?.eventSlug === eventSlug && current.submissionId === submissionId
          ? current
          : { eventSlug, submissionId, version: (current?.version ?? 0) + 1 }
      ));
    }
    if (syncUrl) {
      const currentLocation = locationRef.current;
      const search = reviewSelectionSearch(currentLocation.search, submissionId);
      if (search !== currentLocation.search) {
        void navigate({ pathname: currentLocation.pathname, search }, { replace: true });
      }
    }
  }, [eventSlug, navigate]);

  useEffect(() => {
    if (!result) return;
    const fromUrl = new URLSearchParams(location.search).get("selectedSubmissionId")
      ?? result.workbench.queue[0]?.id;
    if (fromUrl && fromUrl !== selectedSubmissionIdRef.current) requestDetail(fromUrl, false);
  }, [location.search, requestDetail, result]);

  const refreshSelectedDetail = useCallback(async (submissionId: string) => {
    const event = eventRef.current;
    if (!event || !submissionId) return;
    mutationRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    mutationRefreshAbortRef.current = controller;
    detailCacheRef.current.delete(submissionId);
    try {
      const loaded = await loadReviewWorkbench(eventSlug, submissionId, { event, signal: controller.signal, search: locationRef.current.search });
      const detail = loaded.workbench.selected;
      if (detail) detailCacheRef.current.set(detail.id, detail);
      if (shouldApplyReviewRefresh(selectedSubmissionIdRef.current, submissionId)) setResult(loaded);
    } catch (error) {
      if (isAbortError(error)) return;
      if (error instanceof ReviewLoadError && error.cause instanceof ApiError && error.cause.status === 404) {
        const loaded = await loadReviewWorkbench(eventSlug, undefined, { event, signal: controller.signal, search: locationRef.current.search });
        const fallbackId = loaded.workbench.selected?.id;
        selectedSubmissionIdRef.current = fallbackId;
        if (loaded.workbench.selected) detailCacheRef.current.set(loaded.workbench.selected.id, loaded.workbench.selected);
        setResult(loaded);
        const currentLocation = locationRef.current;
        const search = reviewSelectionSearch(currentLocation.search, fallbackId ?? "");
        if (search !== currentLocation.search) {
          void navigate({ pathname: currentLocation.pathname, search }, { replace: true });
        }
        return;
      }
      throw error;
    }
  }, [eventSlug, navigate]);

  const selectRound = useCallback((roundId: string) => {
    const currentLocation = locationRef.current;
    const params = new URLSearchParams(currentLocation.search);
    params.set("roundId", roundId);
    params.delete("selectedSubmissionId");
    params.delete("page");
    selectedSubmissionIdRef.current = undefined;
    detailCacheRef.current.clear();
    void navigate({ pathname: currentLocation.pathname, search: `?${params.toString()}` }, { replace: true });
    setInitialRequestVersion((version) => version + 1);
  }, [navigate]);

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
      eventSlug={eventSlug}
      workbench={result.workbench}
      isDetailLoading={isDetailLoading}
      onSelectSubmission={requestDetail}
      onSelectRound={selectRound}
      onMutationCommitted={() => refreshSelectedDetail(result.workbench.selected?.id ?? "")}
    />
  );
}

export function ReviewWorkbenchContent({
  workbench,
  eventSlug,
  isDetailLoading = false,
  onSelectSubmission,
  onSelectRound,
  onMutationCommitted = async () => undefined,
}: {
  readonly workbench: ReviewWorkbench;
  readonly eventSlug?: string;
  readonly isDetailLoading?: boolean;
  readonly onSelectSubmission: (submissionId: string) => void;
  readonly onSelectRound?: (roundId: string) => void;
  readonly onMutationCommitted?: () => Promise<void>;
}) {
  const [focusedId, setFocusedId] = useState(workbench.selected?.id ?? workbench.queue[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [status, setStatus] = useState<SubmissionStatus | "all">("all");
  const [category, setCategory] = useState("all");
  const [assignment, setAssignment] = useState<"all" | "mine" | "assigned" | "unassigned">("all");
  const [order, setOrder] = useState(workbench.order);
  const [selectedReviewerIds, setSelectedReviewerIds] = useState<ReadonlySet<string>>(new Set());
  const [assignmentStrategy, setAssignmentStrategy] = useState<"all" | "balanced">("balanced");
  const [reviewsPerSubmission, setReviewsPerSubmission] = useState(1);
  const [bulkPending, setBulkPending] = useState<"assign" | "remind" | "export">();
  const [bulkMessage, setBulkMessage] = useState<string>();
  const bulkKey = useRef(`review-bulk-${crypto.randomUUID()}`);
  const reminderKey = useRef(`review-reminders-${crypto.randomUUID()}`);
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

  const selectedReviewers = workbench.reviewers.filter((reviewer) => selectedReviewerIds.has(reviewer.userId));
  const runBulk = async (kind: NonNullable<typeof bulkPending>, run: () => Promise<string>) => {
    setBulkPending(kind);
    setBulkMessage(undefined);
    try {
      setBulkMessage(await run());
      await onMutationCommitted();
    } catch (cause) {
      setBulkMessage(cause instanceof Error ? cause.message : "The review operation could not be completed.");
    } finally {
      setBulkPending(undefined);
    }
  };

  const bulkAssign = () => {
    if (!loadedRound || visibleQueue.length === 0 || selectedReviewers.length === 0) return;
    void runBulk("assign", async () => {
      const result = await bulkAssignReviewersRequest({
        eventId: workbench.eventId,
        roundId: loadedRound.id,
        submissionIds: visibleQueue.map((submission) => submission.id) as [string, ...string[]],
        reviewerUserIds: selectedReviewers.map((reviewer) => reviewer.userId) as [string, ...string[]],
        reviewsPerSubmission: Math.min(reviewsPerSubmission, selectedReviewers.length),
        strategy: assignmentStrategy,
        idempotencyKey: bulkKey.current,
        requestId: `review-bulk-${crypto.randomUUID()}`,
      });
      bulkKey.current = `review-bulk-${crypto.randomUUID()}`;
      return `${result.createdCount} assignments created; ${result.existingCount} already existed.`;
    });
  };

  const sendReminders = () => {
    if (!loadedRound || selectedReviewers.length === 0) return;
    const audience = selectedReviewers.map((reviewer) => reviewer.name).join(", ");
    const authorized = window.confirm(
      `Queue reminder emails now to ${selectedReviewers.length} selected reviewer${selectedReviewers.length === 1 ? "" : "s"}?\n\n`
      + `Audience: ${audience}\n`
      + `Template: personalized outstanding-review count and a link to the assigned ${loadedRound.name} queue\n`
      + "Reply-to: none\nDelivery: immediately after the durable outbox commit",
    );
    if (!authorized) return;
    void runBulk("remind", async () => {
      const result = await sendReviewRemindersRequest({
        eventId: workbench.eventId,
        roundId: loadedRound.id,
        reviewerUserIds: selectedReviewers.map((reviewer) => reviewer.userId) as [string, ...string[]],
        idempotencyKey: reminderKey.current,
        requestId: `review-reminders-${crypto.randomUUID()}`,
      });
      reminderKey.current = `review-reminders-${crypto.randomUUID()}`;
      return `${result.queuedCount} reviewer reminder${result.queuedCount === 1 ? "" : "s"} queued; ${result.skippedCount} skipped.`;
    });
  };

  const exportCsv = () => {
    if (!loadedRound) return;
    void runBulk("export", async () => {
      const result = await exportReviewResultsRequest({ eventId: workbench.eventId, roundId: loadedRound.id });
      const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const criterionLabels = result.round.rubric.criteria.map((criterion) => criterion.label);
      const header = ["Submission ID", "Title", "Category", "Status", "Reviewer", "Aggregate score", ...criterionLabels, "Comment", "Completed at"];
      const lines = result.rows.map((row) => {
        const answers = new Map(row.responses.map((response) => [response.criterionKey, response.score]));
        return [
          row.submissionId,
          row.title,
          row.category,
          row.status,
          row.reviewerName,
          row.aggregateScore,
          ...result.round.rubric.criteria.map((criterion) => answers.get(criterion.key) ?? ""),
          row.comment,
          row.completedAt === null ? "" : new Date(row.completedAt).toISOString(),
        ];
      });
      const csv = [header, ...lines].map((row) => row.map(quote).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${workbench.eventName}-${result.round.name}-reviews.csv`.toLocaleLowerCase().replaceAll(/[^a-z0-9.-]+/g, "-");
      link.click();
      URL.revokeObjectURL(url);
      return `${result.rows.length} review result rows exported to CSV.`;
    });
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
          {workbench.rounds.length > 1 && onSelectRound && loadedRound && (
            <div className="mt-4 max-w-sm [&_label]:text-ink">
              <Select
                label="Review round"
                value={loadedRound.id}
                onChange={(event) => onSelectRound(event.target.value)}
              >
                {workbench.rounds.map((round) => (
                  <option key={round.id} value={round.id}>{round.name} · {round.status}</option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div className="border-l-2 border-ink/35 pl-4 text-left text-[10px] font-black uppercase tracking-[0.08em] text-ink sm:text-right">
          <p>Select proposal: ↑/↓ · Focus detail: Enter · Search: /</p>
          <p>Last updated {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: workbench.timezone }).format(workbench.lastUpdatedAt)} {workbench.timezone}</p>
        </div>
      </header>

      {(workbench.viewerRole === "owner" || workbench.viewerRole === "admin") && (
        <section className="mb-4 space-y-4" aria-label="Review operations">
          <ReviewRoundSetup
            eventId={workbench.eventId}
            rounds={workbench.rounds}
            onMutationCommitted={onMutationCommitted}
          />
          {workbench.progress ? <ReviewProgressPanel progress={workbench.progress} eventSlug={eventSlug} /> : null}
          <ReviewerInvitations eventId={workbench.eventId} />
        </section>
      )}

      {(workbench.viewerRole === "owner" || workbench.viewerRole === "admin") && loadedRound && (
        <section className="mb-5" aria-label="Reviewer pool operations">
          <Card className="[&>header]:bg-production-yellow [&>header_h3]:text-ink" title={`${loadedRound.name} / reviewer pool`}>
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.7fr)]">
              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-black">Per-reviewer completion</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setSelectedReviewerIds(new Set(workbench.reviewers.map((reviewer) => reviewer.userId)))}>Select all</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelectedReviewerIds(new Set())}>Clear</Button>
                  </div>
                </div>
                {workbench.reviewerProgress.length === 0 ? (
                  <p className="text-sm text-ink-faint">Add event members with the reviewer role to build a round pool.</p>
                ) : (
                  <ul className="divide-y-2 divide-line-strong border-2 border-line-strong bg-surface">
                    {workbench.reviewerProgress.map((progress) => (
                      <li key={progress.reviewerUserId} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <Checkbox
                          checked={selectedReviewerIds.has(progress.reviewerUserId)}
                          onChange={(event) => setSelectedReviewerIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(progress.reviewerUserId); else next.delete(progress.reviewerUserId);
                            return next;
                          })}
                          label={progress.reviewerName}
                          description={`${progress.completedCount}/${progress.assignedCount} complete · ${progress.outstandingCount} outstanding`}
                        />
                        <Badge tone={progress.outstandingCount === 0 && progress.assignedCount > 0 ? "success" : "warning"}>{progress.completionPercent.toFixed(0)}%</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-3 border-t-2 border-line-strong pt-4 xl:border-l-2 xl:border-t-0 xl:pl-5 xl:pt-0">
                <p className="text-xs leading-5 text-ink-secondary">Bulk assignment uses the current category/status/search filters: <strong>{visibleQueue.length} proposals</strong> and <strong>{selectedReviewers.length} reviewers</strong>.</p>
                <Select label="Distribution" value={assignmentStrategy} onChange={(event) => setAssignmentStrategy(event.target.value as "all" | "balanced")}>
                  <option value="balanced">Balanced rotation</option>
                  <option value="all">Every selected reviewer</option>
                </Select>
                {assignmentStrategy === "balanced" && (
                  <Input label="Reviews per proposal" type="number" min={1} max={Math.max(1, selectedReviewers.length)} value={reviewsPerSubmission} onChange={(event) => setReviewsPerSubmission(Math.max(1, Number(event.target.value)))} />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={bulkPending !== undefined || visibleQueue.length === 0 || selectedReviewers.length === 0} loading={bulkPending === "assign"} onClick={bulkAssign}>Assign filtered proposals</Button>
                  <Button variant="secondary" disabled={bulkPending !== undefined || selectedReviewers.length === 0} loading={bulkPending === "remind"} onClick={sendReminders}>Review &amp; remind selected</Button>
                  <Button variant="secondary" disabled={bulkPending !== undefined} loading={bulkPending === "export"} onClick={exportCsv}>Export CSV</Button>
                </div>
                {bulkMessage && <p role="status" className="border-2 border-line-strong bg-surface px-3 py-2 text-xs font-bold shadow-[2px_2px_0_#171714]">{bulkMessage}</p>}
              </div>
            </div>
          </Card>
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
            <option value="coverage">Coverage · fewest reviews</option><option value="decision">Decision · highest score</option><option value="decision_asc">Decision · lowest score</option>
          </Select>
        </section>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(0,1.7fr)]">
        <Card className="overflow-hidden shadow-[5px_5px_0_#171714] lg:sticky lg:top-4 [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title={<span className="flex items-center justify-between gap-3"><span>Review queue</span><span className="font-mono text-[10px] font-black tabular-nums text-ink">{queue.length === 0 ? "Empty round" : `${visibleQueue.length} shown`}</span></span>}>
          {queue.length > 0 && (
            <p className="mb-3 border-b-2 border-line-strong pb-3 text-[10px] font-bold uppercase tracking-[0.06em] leading-5 text-ink-faint">
              {order === "coverage"
                ? "Coverage: fewest human reviews first; ties use oldest submission, then stable ID."
                : order === "decision"
                  ? "Decision: highest average human score first; ties use review count, oldest submission, then stable ID."
                  : "Decision: lowest average human score first; ties use review count, oldest submission, then stable ID."}
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
          {selected ? <SubmissionReviewPane key={selected.id} eventId={workbench.eventId} eventSlug={eventSlug} submission={selected} viewerRole={workbench.viewerRole} viewerUserId={workbench.viewerUserId} reviewers={workbench.reviewers} timezone={workbench.timezone} onMutationCommitted={onMutationCommitted} /> : <Card><EmptyState title={queue.length === 0 ? "No proposal detail in this round" : "Loading selected proposal"} description={queue.length === 0 ? "When a proposal enters this round, its abstract, rubric, assignments, and evidence will appear here." : "The authoritative proposal detail is loading."} /></Card>}
        </section>
      </div>
    </div>
  );
}
