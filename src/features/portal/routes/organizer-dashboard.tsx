import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router";
import { Badge, EmptyState, Table } from "@/ui";
import { useEventRoom } from "@/client/socket";
import type { PortalDashboard } from "../schema";
import { getPortalDashboard } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import {
  ProductionHeader,
  ProductionSectionLabel,
  ProductionStats,
  productionTableClass,
} from "../components/production-ui";

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
    <div className="space-y-8">
      <ProductionHeader
        eyebrow="Organizer control room / Readiness"
        title="Speaker readiness"
        description={`A compact production check for ${dashboard.event.name}. Every count comes from the current task definitions and persisted completions.`}
        accent="lime"
        actions={
          <span className="border-2 border-[#171714] bg-[#caff4a] px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] shadow-[3px_3px_0_#171714]">
            Live production state
          </span>
        }
      />
      <ProductionStats
        stats={[
          { label: "Speakers", value: dashboard.totals.speakers, tone: "paper" },
          { label: "Ready", value: dashboard.totals.ready, tone: "lime" },
          { label: "Tasks complete", value: dashboard.totals.tasksDone, tone: "sky" },
          { label: "Tasks assigned", value: dashboard.totals.tasksTotal, tone: "coral" },
        ]}
      />
      <section aria-label="Speaker production matrix">
        <ProductionSectionLabel>Speaker production matrix</ProductionSectionLabel>
        {dashboard.speakers.length === 0 ? (
          <div className="border-2 border-[#171714] bg-[#fffdf7] p-6 shadow-[6px_6px_0_#171714]">
            <EmptyState title="No speakers to track" description="Provision an accepted speaker to begin tracking production readiness." />
          </div>
        ) : (
          <div className={productionTableClass}>
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
                        className={`h-2 flex-1 ${index < item.readiness.tasksDone ? "bg-[#7857ff]" : "bg-[#d8d1c3]"}`}
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
          </div>
        )}
      </section>
    </div>
  );
}
