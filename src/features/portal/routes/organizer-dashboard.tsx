import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router";
import { Badge, EmptyState, PageHeader, Table } from "@/ui";
import { useEventRoom } from "@/client/socket";
import type { PortalDashboard } from "../schema";
import { getPortalDashboard } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";

export const path = "/e/:eventSlug/dashboard";

export default function OrganizerDashboardRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getPortalDashboard(eventSlug), eventSlug);
  if (state.status === "loading") return <RouteLoading label="Loading readiness dashboard" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;
  return <LiveOrganizerDashboard key={state.data.event.id} eventSlug={eventSlug} initial={state.data} />;
}

function LiveOrganizerDashboard({
  eventSlug,
  initial,
}: {
  readonly eventSlug: string;
  readonly initial: PortalDashboard;
}) {
  const [dashboard, setDashboard] = useState(initial);
  const latestRefresh = useRef(0);
  const refresh = useCallback(() => {
    const generation = latestRefresh.current + 1;
    latestRefresh.current = generation;
    void getPortalDashboard(eventSlug).then((next) => {
      if (latestRefresh.current === generation) setDashboard(next);
    }).catch(() => undefined);
  }, [eventSlug]);
  useEventRoom(dashboard.event.id, (message) => {
    if (message.t === "dashboard/progress") refresh();
  });
  return <OrganizerDashboardContent dashboard={dashboard} />;
}

export function OrganizerDashboardContent({ dashboard }: { readonly dashboard: PortalDashboard }) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Speaker readiness"
        description={`A compact production check for ${dashboard.event.name}. Every count comes from the current task definitions and persisted completions.`}
      />
      <dl className="grid gap-3 border-y border-line py-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Speakers</dt>
          <dd className="mt-1 text-lg font-semibold text-ink">{dashboard.totals.speakers}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Ready</dt>
          <dd className="mt-1 text-lg font-semibold text-success">{dashboard.totals.ready}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Tasks complete</dt>
          <dd className="mt-1 text-lg font-semibold text-ink">{dashboard.totals.tasksDone}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Tasks assigned</dt>
          <dd className="mt-1 text-lg font-semibold text-ink">{dashboard.totals.tasksTotal}</dd>
        </div>
      </dl>
      {dashboard.speakers.length === 0 ? (
        <EmptyState title="No speakers to track" description="Provision an accepted speaker to begin tracking production readiness." />
      ) : (
        <Table
          rows={[...dashboard.speakers]}
          rowKey={(item) => item.speaker.id}
          columns={[
            {
              key: "speaker",
              header: "Speaker",
              render: (item) => (
                <div>
                  <p className="font-semibold text-ink">{item.speaker.displayName}</p>
                  <p className="text-xs text-ink-faint">{item.submission?.title ?? "No accepted session linked"}</p>
                </div>
              ),
            },
            {
              key: "state",
              header: "State",
              render: (item) => (
                <Badge tone={item.readiness.state === "ready" ? "success" : item.readiness.state === "in_progress" ? "accent" : "warning"}>
                  {item.readiness.state.replace("_", " ")}
                </Badge>
              ),
            },
            {
              key: "progress",
              header: "Checklist",
              render: (item) => (
                <div className="min-w-32">
                  <p className="font-medium text-ink">{item.readiness.tasksDone} / {item.readiness.tasksTotal}</p>
                  <div className="mt-2 flex gap-1" aria-label={`${item.readiness.tasksDone} of ${item.readiness.tasksTotal} tasks complete`}>
                    {Array.from({ length: item.readiness.tasksTotal }, (_, index) => (
                      <span
                        key={index}
                        aria-hidden="true"
                        className={`h-2 flex-1 rounded-full ${index < item.readiness.tasksDone ? "bg-success" : "bg-line-strong"}`}
                      />
                    ))}
                  </div>
                </div>
              ),
            },
            {
              key: "outstanding",
              header: "Outstanding",
              render: (item) => item.readiness.outstandingTaskIds.length === 0 ? (
                <span className="text-success">None</span>
              ) : (
                <span>{item.readiness.outstandingTaskIds.length} remaining</span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
