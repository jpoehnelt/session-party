import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Badge, Button, Checkbox, EmptyState, Select, Table, Textarea, Toaster, toast } from "@/ui";
import { useEventRoom } from "@/client/socket";
import type { PortalDashboard, SpeakerContactMedium, SpeakerDirectoryItem } from "../schema";
import { getPortalDashboard, logSpeakerContact } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import {
  ProductionHeader,
  ProductionSectionLabel,
  ProductionStats,
  productionTableClass,
} from "../components/production-ui";

export const path = "/e/:eventSlug/dashboard";
export const contentWidth = "canvas" as const;

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
  const [busySpeakerId, setBusySpeakerId] = useState<string | null>(null);
  const refresh = useCallback(() => {
    const generation = latestRefresh.current + 1;
    latestRefresh.current = generation;
    void getPortalDashboard(eventSlug).then((next) => {
      if (latestRefresh.current === generation) setDashboard(next);
    }).catch(() => undefined);
  }, [eventSlug]);
  useEventRoom(dashboard.event.id, (message) => {
    if (message.t === "dashboard/progress") refresh();
  }, {
    onReconnect: refresh,
  });
  async function recordContact(speakerId: string, medium: SpeakerContactMedium, note: string) {
    setBusySpeakerId(speakerId);
    try {
      await logSpeakerContact(dashboard.event.id, {
        eventId: dashboard.event.id,
        speakerId,
        medium,
        note: note.trim() || null,
        idempotencyKey: crypto.randomUUID(),
      });
      toast("Contact logged", { tone: "success" });
      refresh();
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Contact could not be logged", { tone: "danger" });
      return false;
    } finally {
      setBusySpeakerId(null);
    }
  }
  return <><OrganizerDashboardContent dashboard={dashboard} busySpeakerId={busySpeakerId} onLogContact={recordContact} /><Toaster /></>;
}

export function OrganizerDashboardContent({
  dashboard,
  busySpeakerId = null,
  onLogContact = () => false,
}: {
  readonly dashboard: PortalDashboard;
  readonly busySpeakerId?: string | null;
  readonly onLogContact?: (speakerId: string, medium: SpeakerContactMedium, note: string) => boolean | Promise<boolean>;
}) {
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  const speakers = useMemo(
    () => needsAttentionOnly
      ? dashboard.speakers.filter((item) => item.readiness.missingItems.length > 0)
      : dashboard.speakers,
    [dashboard.speakers, needsAttentionOnly],
  );
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
          { label: "Needs attention", value: dashboard.totals.needsAttention, tone: "coral" },
          { label: "Overdue", value: dashboard.totals.overdue, tone: "purple" },
        ]}
      />
      <section aria-label="Speaker production matrix">
        <ProductionSectionLabel>Speaker production matrix</ProductionSectionLabel>
        {dashboard.speakers.length === 0 ? (
          <div className="border-2 border-[#171714] bg-[#fffdf7] p-6 shadow-[6px_6px_0_#171714]">
            <EmptyState title="No speakers to track" description="Provision an accepted speaker to begin tracking production readiness." />
          </div>
        ) : (
          <>
            <Checkbox
              label={`Needs attention only (${dashboard.totals.needsAttention})`}
              checked={needsAttentionOnly}
              onChange={(event) => setNeedsAttentionOnly(event.currentTarget.checked)}
            />
            <div className={productionTableClass}>
            <Table
              rows={[...speakers]}
              rowKey={(item) => item.speaker.id}
              empty="Every speaker is currently ready."
              columns={[
            {
              key: "speaker",
              header: "Speaker",
              render: (item) => (
                <div>
                  <a className="font-semibold text-ink underline decoration-2 underline-offset-3" href={`/e/${encodeURIComponent(dashboard.event.slug)}/speakers/${encodeURIComponent(item.speaker.id)}`}>{item.speaker.displayName}</a>
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
                  <div
                    className="mt-2 flex gap-1"
                    role="progressbar"
                    aria-label="Tasks complete"
                    aria-valuemin={0}
                    aria-valuemax={item.readiness.tasksTotal}
                    aria-valuenow={item.readiness.tasksDone}
                  >
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
              key: "blocker",
              header: "Clearest blocker",
              render: (item) => item.readiness.clearestBlocker === null ? (
                <span className="text-success">None</span>
              ) : (
                <div>
                  <p className={item.readiness.overdueCount > 0 ? "font-medium text-danger" : "font-medium text-ink"}>
                    {item.readiness.clearestBlocker}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">{item.readiness.missingItems.length} missing</p>
                </div>
              ),
            },
            {
              key: "next_action",
              header: "Recommended next action",
              render: (item) => item.readiness.recommendedNextAction ?? <span className="text-success">No action needed</span>,
            },
            {
              key: "due",
              header: "Due",
              render: (item) => {
                const next = item.readiness.missingItems[0];
                if (!next?.dueAt) return <span className="text-ink-faint">No due date</span>;
                return <span className={next.overdue ? "font-medium text-danger" : "text-ink"}>
                  {next.overdue ? "Overdue " : "Due "}{new Date(next.dueAt).toLocaleDateString()}
                </span>;
              },
            },
            {
              key: "last_contact",
              header: "Last contact",
              render: (item) => item.latestContact ? (
                <div>
                  <p className="font-medium text-ink">{contactMediumLabel(item.latestContact.medium)}</p>
                  <p className="text-xs text-ink-faint">{new Date(item.latestContact.contactedAt).toLocaleDateString()}</p>
                  {item.latestContact.note && <p className="mt-1 text-xs text-ink-faint">{item.latestContact.note}</p>}
                </div>
              ) : <span className="text-ink-faint">Not logged</span>,
            },
            {
              key: "contact_action",
              header: "Contact",
              render: (item) => <ContactLogForm item={item} busy={busySpeakerId === item.speaker.id} onLogContact={onLogContact} />,
            },
            ]}
          />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function contactMediumLabel(medium: SpeakerContactMedium): string {
  return { toolEmail: "Tool email", personalEmail: "Personal email", text: "Text", phone: "Phone" }[medium];
}

function ContactLogForm({
  item,
  busy,
  onLogContact,
}: {
  readonly item: SpeakerDirectoryItem;
  readonly busy: boolean;
  readonly onLogContact: (speakerId: string, medium: SpeakerContactMedium, note: string) => boolean | Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const saved = await onLogContact(
      item.speaker.id,
      String(values.get("medium")) as SpeakerContactMedium,
      String(values.get("note") ?? ""),
    );
    if (saved) setOpen(false);
  }
  if (!open) return <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Log contact</Button>;
  return (
    <form className="min-w-52 space-y-2" onSubmit={submit}>
      <Select name="medium" label="Medium" defaultValue="toolEmail">
        <option value="toolEmail">Tool email</option>
        <option value="personalEmail">Personal email</option>
        <option value="text">Text</option>
        <option value="phone">Phone</option>
      </Select>
      <Textarea name="note" label="Note (optional)" />
      <div className="flex gap-2">
        <Button size="sm" type="submit" loading={busy}>Save contact</Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
