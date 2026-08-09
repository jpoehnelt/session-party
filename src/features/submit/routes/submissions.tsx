import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { fetchEventIdentity, fetchFormSummaries, type EventIdentity } from "@/features/forms/routes/forms";
import type { FormSummary } from "@/features/forms/schema";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  Table,
  Toaster,
  toast,
  type TableColumn,
} from "@/ui";
import {
  SubmissionPage,
  type SubmissionPage as SubmissionPageValue,
  type SubmissionStatus,
  type SubmissionSummary,
} from "../schema";

export const path = "/e/:eventSlug/submissions";

const statusTone = (status: SubmissionStatus): "neutral" | "accent" | "success" | "warning" | "danger" => {
  switch (status) {
    case "submitted": return "neutral";
    case "in_review": return "accent";
    case "accepted": return "success";
    case "waitlist": return "warning";
    case "rejected":
    case "withdrawn": return "danger";
  }
};

export function fetchSubmissionPage(
  eventId: string,
  filters: { readonly status?: string; readonly formId?: string; readonly category?: string; readonly page: number },
): Promise<SubmissionPageValue> {
  const query = new URLSearchParams({ page: String(filters.page), pageSize: "25" });
  if (filters.status) query.set("status", filters.status);
  if (filters.formId) query.set("formId", filters.formId);
  if (filters.category) query.set("category", filters.category);
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/submissions?${query.toString()}`, {
    schema: SubmissionPage,
  });
}
export async function fetchSubmissionQueue(
  eventId: string,
  filters: { readonly status?: string; readonly formId?: string; readonly category?: string; readonly page: number },
): Promise<{
  readonly page: SubmissionPageValue;
  readonly forms: readonly FormSummary[];
}> {
  const [page, forms] = await Promise.all([
    fetchSubmissionPage(eventId, filters),
    fetchFormSummaries(eventId).catch((error) => {
      if (error instanceof ApiError && error.status === 403) return [];
      throw error;
    }),
  ]);
  return { page, forms };
}


const columns = (eventSlug: string): TableColumn<SubmissionSummary>[] => [
  {
    key: "title",
    header: "Submission",
    render: (row) => (
      <div>
        <Link
          className="font-black tracking-[-0.015em] text-ink underline decoration-2 underline-offset-4 hover:text-accent-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          to={`/e/${eventSlug}/review?selectedSubmissionId=${encodeURIComponent(row.id)}`}
        >
          {row.title}
        </Link>
        <p className="mt-1 text-[10px] font-black uppercase tracking-[0.08em] text-ink-faint">{row.primarySpeakerName ?? "No primary speaker"}</p>
      </div>
    ),
  },
  { key: "formName", header: "Form" },
  { key: "category", header: "Category", render: (row) => row.category ?? "Unrouted" },
  {
    key: "status",
    header: "State",
    render: (row) => <Badge tone={statusTone(row.status)}>{row.status.replace("_", " ")}</Badge>,
  },
  {
    key: "submittedAt",
    header: "Submitted",
    render: (row) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(row.submittedAt),
  },
];

export interface SubmissionsPageProps {
  readonly initialEvent?: EventIdentity | null;
  readonly initialPage?: SubmissionPageValue | null;
  readonly initialForms?: readonly FormSummary[];
}

export default function SubmissionsPage({ initialEvent, initialPage, initialForms }: SubmissionsPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventIdentity | null | undefined>(initialEvent);
  const [eventError, setEventError] = useState<string | null>(null);
  const [page, setPage] = useState<SubmissionPageValue | null | undefined>(initialPage);
  const [forms, setForms] = useState<readonly FormSummary[]>(initialForms ?? []);
  const [categories, setCategories] = useState<readonly string[]>(initialPage?.categories ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [formId, setFormId] = useState("");
  const [category, setCategory] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [request, setRequest] = useState(0);

  const handleUnauthenticated = useCallback(() => {
    setEventError("unauthenticated");
    setEvent(null);
  }, []);

  useEffect(() => {
    if (initialEvent !== undefined) return;
    let active = true;
    setEvent(undefined);
    void fetchEventIdentity(eventSlug).then(
      (loaded) => {
        if (active) setEvent(loaded);
      },
      (error) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) setEventError("unauthenticated");
        else setEventError(error instanceof Error ? error.message : "Could not load event");
        setEvent(null);
      },
    );
    return () => {
      active = false;
    };
  }, [eventSlug, initialEvent]);

  useEffect(() => {
    if (!event) return;
    let active = true;
    setPage(undefined);
    setLoadError(null);
    void fetchSubmissionQueue(event.id, {
      status: status || undefined,
      formId: formId || undefined,
      category: category || undefined,
      page: pageNumber,
    }).then(
      ({ page: loadedPage, forms: loadedForms }) => {
        if (!active) return;
        setPage(loadedPage);
        setForms(loadedForms);
        setCategories(loadedPage.categories);
      },
      (error) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          handleUnauthenticated();
          return;
        }
        const message = error instanceof Error ? error.message : "Could not load submissions";
        setLoadError(message);
        setPage(null);
        toast(message, { tone: "danger" });
      },
    );
    return () => {
      active = false;
    };
  }, [category, event, formId, handleUnauthenticated, pageNumber, request, status]);

  const visibleRouted = page?.results.filter((submission) => submission.category != null).length ?? 0;

  if (event === undefined) {
    return <div role="status" aria-busy="true" aria-label="Loading submission board"><Skeleton className="h-24" /><Skeleton className="mt-5 h-[28rem]" /><Toaster /></div>;
  }
  if (event === null) {
    const unauthenticated = eventError === "unauthenticated";
    return (
      <>
        <EmptyState
          title={unauthenticated ? "Sign in to view submissions" : "Event unavailable"}
          description={unauthenticated ? "Organizer access is required for the submission queue." : eventError ?? "The event may have moved."}
          action={unauthenticated ? <Button onClick={() => navigate(loginPathForLocation(location))}>Sign in</Button> : undefined}
        />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Submission board"
        description={`Run the live proposal queue for ${event.name}. Filter the intake, track routing, and keep every review moving.`}
        actions={<Badge tone="accent">Live queue</Badge>}
      />
      {page && (
        <section className="mb-6 grid border-2 border-line-strong bg-surface shadow-card sm:grid-cols-3" aria-label="Submission queue summary">
          {[
            [String(page.pagination.total), "Queue total", "bg-production-lime"],
            [String(page.results.length), "On this page", "bg-production-sky"],
            [String(visibleRouted), "Routed here", "bg-production-coral"],
          ].map(([value, label, color], index) => (
            <div className={`px-5 py-4 ${color} ${index > 0 ? "border-t-2 border-line-strong sm:border-l-2 sm:border-t-0" : ""}`} key={label}>
              <p className="text-3xl font-black leading-none tracking-[-0.055em]">{value}</p>
              <p className="mt-2 text-[10px] font-black uppercase tracking-[0.13em]">{label}</p>
            </div>
          ))}
        </section>
      )}
      <Card className="mb-6 [&>header]:bg-accent" title="Queue controls">
        <div className="grid gap-4 md:grid-cols-3 md:items-end">
          <Select
            label="State"
            value={status}
            onChange={(changeEvent) => {
              setStatus(changeEvent.currentTarget.value);
              setPageNumber(1);
            }}
          >
            <option value="">All states</option>
            <option value="submitted">Submitted</option>
            <option value="in_review">In review</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="waitlist">Waitlist</option>
            <option value="withdrawn">Withdrawn</option>
          </Select>
          <Select
            label="Form"
            value={formId}
            onChange={(changeEvent) => {
              setFormId(changeEvent.currentTarget.value);
              setPageNumber(1);
            }}
          >
            <option value="">All forms</option>
            {forms.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}
          </Select>
          <Select
            label="Category"
            value={category}
            onChange={(changeEvent) => {
              setCategory(changeEvent.currentTarget.value);
              setPageNumber(1);
            }}
          >
            <option value="">All categories</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
        </div>
      </Card>
      {page === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading submissions"><Skeleton className="h-[28rem]" /></div>
      ) : page === null ? (
        <Card>
          <EmptyState
            title="Submissions could not be loaded"
            description={loadError ?? "Retry after the event connection is restored."}
            action={<Button onClick={() => setRequest((value) => value + 1)}>Retry</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-line-strong bg-ink px-4 py-3 text-on-accent">
            <p className="text-[10px] font-black uppercase tracking-[0.15em]">Current intake</p>
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-white/55">
              Page {page.pagination.page} · newest first
            </p>
          </div>
          <Table
            columns={columns(eventSlug)}
            rows={[...page.results]}
            rowKey={(row) => row.id}
            empty="No submissions match these filters."
          />
          <div className="flex flex-col gap-4 border-t-2 border-line-strong pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-black uppercase tracking-[0.08em] text-ink-faint">
              {page.pagination.total} submission{page.pagination.total === 1 ? "" : "s"} · page {page.pagination.page} of {Math.max(1, page.pagination.pageCount)}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}>Previous</Button>
              <Button variant="secondary" disabled={page.pagination.pageCount === 0 || pageNumber >= page.pagination.pageCount} onClick={() => setPageNumber((value) => value + 1)}>Next</Button>
            </div>
          </div>
        </div>
      )}
      <Toaster />
    </>
  );
}
