import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { useAuthenticatedAccess } from "@/client/auth-access";
import { type SubmissionStatus } from "@/features/submit/schema";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Table,
  Toaster,
  toast,
} from "@/ui";
import {
  EventOverviewMetrics,
  type EventOverviewAgendaMetrics,
  type EventOverviewMetrics as EventOverviewMetricsValue,
  type EventOutput as EventOverview,
} from "../schema";

export const path = "/e/:eventSlug";
export const contentWidth = "compact" as const;

const submissionStages = [
  "submitted",
  "in_review",
  "accepted",
  "waitlist",
  "rejected",
  "withdrawn",
] as const satisfies readonly SubmissionStatus[];

type SubmissionCounts = Record<SubmissionStatus, number>;

export interface EventOverviewData {
  readonly event: EventOverview;
  readonly submissionCounts: SubmissionCounts | null;
  readonly agenda: EventOverviewAgendaMetrics | null;
}

type EventLoadError =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly message: string };

export async function loadEventOverview(event: EventOverview): Promise<EventOverviewData> {
  const metrics = await apiFetch<EventOverviewMetricsValue>(
    `/api/v1/events/${encodeURIComponent(event.id)}/overview`,
    { schema: EventOverviewMetrics },
  );
  return {
    event,
    submissionCounts: {
      submitted: metrics.submissionCounts.submitted,
      in_review: metrics.submissionCounts.inReview,
      accepted: metrics.submissionCounts.accepted,
      rejected: metrics.submissionCounts.rejected,
      waitlist: metrics.submissionCounts.waitlist,
      withdrawn: metrics.submissionCounts.withdrawn,
    },
    agenda: metrics.agenda,
  };
}

export default function EventOverviewPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const { state: authenticatedAccess } = useAuthenticatedAccess();
  const event = authenticatedAccess.status === "signed-in"
    ? authenticatedAccess.events?.find(({ event }) => event.slug === eventSlug)?.event
    : undefined;
  const [overview, setOverview] = useState<EventOverviewData | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<EventLoadError | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setOverview(undefined);
    setLoadError(null);
    if (!event) {
      setOverview(null);
      setLoadError({ kind: "not-found" });
      return;
    }
    void loadEventOverview(event)
      .then((loaded) => {
        if (!active) return;
        setOverview(loaded);
      })
      .catch((error) => {
        if (!active) return;
        setOverview(null);
        if (error instanceof ApiError && error.status === 401) {
          setLoadError({ kind: "unauthenticated" });
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setLoadError({ kind: "not-found" });
          return;
        }
        const message = error instanceof Error ? error.message : "Could not load event";
        setLoadError({ kind: "failed", message });
        toast(message, { tone: "danger" });
      });

    return () => {
      active = false;
    };
  }, [event, eventSlug, request]);

  return (
    <>
      {overview === undefined ? (
        <Skeleton />
      ) : loadError?.kind === "unauthenticated" ? (
        <EmptyState
          headingLevel={1}
          title="Sign in to view this event"
          description="Sign in to continue to this event."
          action={
            <Button
              className="min-h-11"
              onClick={() => navigate(loginPathForLocation(location))}
            >
              Sign in
            </Button>
          }
        />
      ) : loadError?.kind === "not-found" ? (
        <EmptyState headingLevel={1} title="Event not found" description="This event may have moved or been removed." />
      ) : loadError?.kind === "failed" ? (
        <EmptyState
          headingLevel={1}
          title="Could not load event"
          description={loadError.message}
          action={
            <Button className="min-h-11" onClick={() => setRequest((current) => current + 1)}>
              Try again
            </Button>
          }
        />
      ) : overview === null ? (
        <EmptyState headingLevel={1} title="Event not found" description="This event may have moved or been removed." />
      ) : (
        <EventOverviewContent
          overview={overview}
          onRefresh={() => setRequest((current) => current + 1)}
        />
      )}
      <Toaster />
    </>
  );
}

export function EventOverviewContent({
  overview,
  onRefresh = () => undefined,
  now = new Date(),
}: {
  readonly overview: EventOverviewData;
  readonly onRefresh?: () => void;
  readonly now?: Date;
}) {
  const { event, submissionCounts, agenda } = overview;
  const phase = eventPhase(event, now);
  const proposalTotal = submissionCounts === null
    ? null
    : submissionStages.reduce((total, status) => total + submissionCounts[status], 0);
  const scheduledTalks = agenda === null
    ? null
    : agenda.scheduledTalkCount;
  const needsPlacement = agenda === null
    ? null
    : agenda.backlogCount + agenda.unplacedTalkCount;
  const metricsUnavailable = submissionCounts === null || agenda === null;

  return (
    <div className="space-y-8">
      <PageHeader
        title={event.name}
        description={event.description || "Your live production overview."}
        actions={<Badge tone={phase.tone}>{phase.label}</Badge>}
      />

      {metricsUnavailable ? (
        <Alert tone="warning">
          <AlertTitle>Some live metrics are unavailable</AlertTitle>
          <AlertDescription>
            <p>The event details are current, but one or more production summaries could not be loaded.</p>
            <Button className="mt-3" size="sm" variant="secondary" onClick={onRefresh}>
              Refresh metrics
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Event statistics" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Proposals" value={proposalTotal} />
        <StatCard label="Accepted" value={submissionCounts?.accepted ?? null} />
        <StatCard label="Scheduled" value={scheduledTalks} />
        <StatCard
          label="Conflicts"
          value={agenda?.conflictCount ?? null}
          tone={(agenda?.conflictCount ?? 0) > 0 ? "danger" : "success"}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <SubmissionPipeline counts={submissionCounts} total={proposalTotal} eventSlug={event.slug} />
        <ScheduleHealth
          agenda={agenda}
          scheduledTalks={scheduledTalks}
          needsPlacement={needsPlacement}
          eventSlug={event.slug}
        />
      </div>

      <Card
        className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink"
        title="Production brief"
      >
        <Table
          columns={[
            { key: "label", header: "Detail" },
            { key: "value", header: "Value", render: (row) => row.value },
          ]}
          rows={[
            { label: "Dates", value: formatEventDates(event) },
            { label: "Location", value: event.location || "Not set" },
            { label: "Timezone", value: event.timezone },
            { label: "Status", value: <Badge tone={phase.tone}>{phase.label}</Badge> },
          ]}
          rowKey={(row) => row.label}
        />
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = "accent",
}: {
  readonly label: string;
  readonly value: number | null;
  readonly tone?: "accent" | "success" | "danger";
}) {
  const toneClass = {
    accent: "bg-accent",
    success: "bg-success-soft",
    danger: "bg-danger-soft",
  }[tone];
  return (
    <Card className="relative overflow-hidden">
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-2 ${toneClass}`} />
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-ink-faint">{label}</p>
      <p className="mt-2 text-4xl font-black tracking-[-0.06em] text-ink">{value ?? "—"}</p>
    </Card>
  );
}

const stagePresentation: Record<SubmissionStatus, { readonly label: string; readonly color: string }> = {
  submitted: { label: "Submitted", color: "bg-production-sky" },
  in_review: { label: "In review", color: "bg-accent" },
  accepted: { label: "Accepted", color: "bg-production-lime" },
  waitlist: { label: "Waitlisted", color: "bg-warning-soft" },
  rejected: { label: "Rejected", color: "bg-production-coral" },
  withdrawn: { label: "Withdrawn", color: "bg-surface-muted" },
};

function SubmissionPipeline({
  counts,
  total,
  eventSlug,
}: {
  readonly counts: SubmissionCounts | null;
  readonly total: number | null;
  readonly eventSlug: string;
}) {
  return (
    <Card
      title="Submission pipeline"
      footer={<OverviewLink to={`/e/${eventSlug}/review`}>Open review workbench</OverviewLink>}
    >
      {counts === null || total === null ? (
        <p className="py-8 text-center text-sm font-semibold text-ink-secondary">Pipeline metrics unavailable.</p>
      ) : total === 0 ? (
        <EmptyState
          title="No proposals yet"
          description="Published CFP responses will appear here as they move through review."
        />
      ) : (
        <div
          className="space-y-4"
          aria-label={`Submission pipeline: ${submissionStages.map((status) => `${stagePresentation[status].label} ${counts[status]}`).join(", ")}`}
        >
          {submissionStages.map((status) => {
            const stage = stagePresentation[status];
            const count = counts[status];
            return (
              <Link
                aria-label={`${stage.label}: ${count}. Open the review workbench filtered to ${stage.label.toLocaleLowerCase()}.`}
                className="group block rounded-control outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                key={status}
                to={`/e/${eventSlug}/review?status=${encodeURIComponent(status)}`}
              >
                <div className="mb-1.5 flex items-center justify-between gap-4 text-xs font-black uppercase tracking-[0.08em]">
                  <span className="underline-offset-4 group-hover:underline">{stage.label}</span>
                  <span className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none">{count} →</span>
                </div>
                <div className="h-3 overflow-hidden border-2 border-line-strong bg-surface-muted">
                  <div
                    aria-hidden="true"
                    className={`h-full ${stage.color}`}
                    style={{ width: `${(count / total) * 100}%` }}
                  />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ScheduleHealth({
  agenda,
  scheduledTalks,
  needsPlacement,
  eventSlug,
}: {
  readonly agenda: EventOverviewAgendaMetrics | null;
  readonly scheduledTalks: number | null;
  readonly needsPlacement: number | null;
  readonly eventSlug: string;
}) {
  const programTotal = agenda === null ? 0 : agenda.activeTalkCount + agenda.backlogCount;
  const progress = programTotal === 0 || scheduledTalks === null ? 0 : (scheduledTalks / programTotal) * 100;

  return (
    <Card
      title="Schedule health"
      footer={<OverviewLink to={`/e/${eventSlug}/agenda`}>Open agenda</OverviewLink>}
    >
      {agenda === null || scheduledTalks === null || needsPlacement === null ? (
        <p className="py-8 text-center text-sm font-semibold text-ink-secondary">Schedule metrics unavailable.</p>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="flex items-end justify-between gap-4">
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">Program placed</p>
              <p className="text-sm font-black text-ink">{scheduledTalks} / {programTotal}</p>
            </div>
            <div
              className="mt-2 h-5 border-2 border-line-strong bg-surface-muted"
              role="progressbar"
              aria-label="Program placed"
              aria-valuemin={0}
              aria-valuemax={programTotal}
              aria-valuenow={scheduledTalks}
            >
              <div aria-hidden="true" className="h-full bg-production-lime" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <ScheduleRow
            label="Needs placement"
            value={needsPlacement}
            attention={needsPlacement > 0}
            to={`/e/${eventSlug}/agenda?view=list&filter=needs-placement`}
          />
          <ScheduleRow
            label="Conflicts"
            value={agenda.conflictCount}
            attention={agenda.conflictCount > 0}
            to={`/e/${eventSlug}/agenda?view=list&filter=conflicts`}
          />
          <ScheduleRow
            label="Published sessions"
            value={agenda.publishedTalkCount}
            to={`/e/${eventSlug}/agenda?view=list&filter=published`}
          />
          {needsPlacement === 0 && agenda.conflictCount === 0 ? (
            <Alert tone="success" role="status">
              <AlertTitle>Schedule is clear</AlertTitle>
              <AlertDescription>No placement blockers or conflicts are currently reported.</AlertDescription>
            </Alert>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function ScheduleRow({
  label,
  value,
  attention = false,
  to,
}: {
  readonly label: string;
  readonly value: number;
  readonly attention?: boolean;
  readonly to: string;
}) {
  return (
    <Link
      aria-label={`${label}: ${value}. Open the filtered agenda.`}
      className="group flex items-center justify-between gap-4 border-t-2 border-line pt-3 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      to={to}
    >
      <span className="text-sm font-semibold text-ink-secondary underline-offset-4 group-hover:text-ink group-hover:underline">{label}</span>
      <span className="flex items-center gap-2">
        <Badge tone={attention ? "warning" : "neutral"}>{value}</Badge>
        <span aria-hidden="true" className="text-sm font-black transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none">→</span>
      </span>
    </Link>
  );
}

function OverviewLink({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <Link
      className="text-xs font-black uppercase tracking-[0.08em] text-ink underline decoration-2 underline-offset-4 hover:text-accent-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      to={to}
    >
      {children} →
    </Link>
  );
}

export function formatEventDates(event: Pick<EventOverview, "startsAt" | "endsAt" | "timezone">): string {
  if (event.startsAt === null) return "Dates not set";
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: event.timezone,
  });
  if (event.endsAt === null) return formatter.format(event.startsAt);
  const start = formatter.format(event.startsAt);
  const end = formatter.format(event.endsAt);
  return start === end ? start : `${start} — ${end}`;
}

export function eventPhase(
  event: Pick<EventOverview, "startsAt" | "endsAt">,
  now: Date,
): { readonly label: "Planning" | "Live" | "Complete"; readonly tone: "accent" | "success" | "neutral" } {
  if (event.startsAt !== null && now < event.startsAt) return { label: "Planning", tone: "accent" };
  if (event.startsAt !== null && (event.endsAt === null || now <= event.endsAt)) {
    return { label: "Live", tone: "success" };
  }
  if (event.endsAt !== null && now > event.endsAt) return { label: "Complete", tone: "neutral" };
  return { label: "Planning", tone: "accent" };
}
