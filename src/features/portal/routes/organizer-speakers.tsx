import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Avatar, Badge, Button, Card, Checkbox, Input, Select, Textarea, Toaster, toast } from "@/ui";
import type { CreateManagedSpeakerInput, SendSpeakerMessagesInput, SpeakerDirectory, SpeakerDirectoryItem, UpdateManagedSpeakerInput } from "../schema";
import { createManagedSpeaker, getSpeakerDirectory, importSpeakersCsv, provisionSpeaker, reviewSpeakerProfile, sendSpeakerMessages, updateManagedSpeaker, updateSpeakerPublication, uploadManagedSpeakerHeadshot } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import { organizerAgendaTalkPath } from "@/features/agenda/links";
import {
  ProductionHeader,
  ProductionSectionLabel,
  ProductionStats,
  productionButtonClass,
} from "../components/production-ui";

export const path = "/e/:eventSlug/speakers";
export const contentWidth = "wide" as const;

const SPEAKERS_PER_PAGE = 25;
const COLLAPSED_TASK_COUNT = 3;

type SpeakerDirectoryFilter = "all" | "needs_attention" | "ready" | "unprovisioned" | "hidden";

export function filterSpeakerDirectory(
  speakers: readonly SpeakerDirectoryItem[],
  query: string,
  filter: SpeakerDirectoryFilter,
  workflowStatus = "all",
): readonly SpeakerDirectoryItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return speakers.filter((item) => {
    const matchesFilter = filter === "all"
      || (filter === "needs_attention" && item.readiness.state !== "ready")
      || (filter === "ready" && item.readiness.state === "ready")
      || (filter === "unprovisioned" && item.provisioningStatus !== "provisioned")
      || (filter === "hidden" && !item.speaker.visible);
    if (!matchesFilter || (workflowStatus !== "all" && item.speaker.workflowStatus !== workflowStatus)) return false;
    if (!normalizedQuery) return true;
    return [
      item.speaker.displayName,
      item.speaker.title,
      item.speaker.company,
      item.speaker.contactEmail,
      item.speaker.workflowStatus,
      item.submission?.title,
      item.submission?.category,
      ...item.sessions.map((session) => session.title),
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
}

function managedSpeakerInput(eventId: string, form: HTMLFormElement): Omit<CreateManagedSpeakerInput, "idempotencyKey"> {
  const values = new FormData(form);
  const nullable = (name: string) => String(values.get(name) ?? "").trim() || null;
  return {
    eventId,
    displayName: String(values.get("displayName") ?? "").trim(),
    contactEmail: String(values.get("contactEmail") ?? "").trim(),
    title: nullable("title"),
    company: nullable("company"),
    bio: nullable("bio"),
    workflowStatus: String(values.get("workflowStatus") ?? "Invited").trim(),
    visible: values.get("visible") === "on",
  };
}

const fileBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};

const readinessTone = (item: SpeakerDirectoryItem) => item.readiness.state === "ready"
  ? "success" as const
  : item.readiness.overdueCount > 0
    ? "danger" as const
    : item.readiness.state === "in_progress"
      ? "accent" as const
      : "warning" as const;

const readinessLabel = (item: SpeakerDirectoryItem) => item.readiness.state === "ready"
  ? "Ready"
  : item.readiness.overdueCount > 0
    ? `${item.readiness.overdueCount} overdue`
    : `${item.readiness.outstandingTaskIds.length} open`;

function ReadinessMeter({ item, compact = false }: { readonly item: SpeakerDirectoryItem; readonly compact?: boolean }) {
  const percent = item.readiness.tasksTotal === 0
    ? 100
    : Math.round((item.readiness.tasksDone / item.readiness.tasksTotal) * 100);
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <Badge tone={readinessTone(item)}>{readinessLabel(item)}</Badge>
        <span className="shrink-0 text-[11px] font-black tabular-nums text-ink-faint">
          {item.readiness.tasksDone}/{item.readiness.tasksTotal}
        </span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden border border-[#171714] bg-[#ece8dc]"
        role="progressbar"
        aria-label="Speaker tasks complete"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={`h-full ${item.readiness.state === "ready" ? "bg-success" : item.readiness.overdueCount > 0 ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {!compact && item.readiness.recommendedNextAction ? (
        <p className="mt-2 truncate text-xs font-bold text-ink-secondary">
          Next: {item.readiness.recommendedNextAction}
        </p>
      ) : null}
    </div>
  );
}

export default function OrganizerSpeakersRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getSpeakerDirectory(eventSlug), eventSlug);
  const [busySpeakerId, setBusySpeakerId] = useState<string | null>(null);

  if (state.status === "loading") return <RouteLoading label="Loading speaker directory" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;

  async function mutate(speakerId: string, action: () => Promise<unknown>, success: string) {
    setBusySpeakerId(speakerId);
    try {
      await action();
      toast(success, { tone: "success" });
      retry();
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Speaker could not be updated", { tone: "danger" });
      return false;
    } finally {
      setBusySpeakerId(null);
    }
  }

  return (
    <>
      <OrganizerSpeakersContent
        directory={state.data}
        busySpeakerId={busySpeakerId}
        onProvision={(item) => {
          const provisioningId = item.provisioningId;
          if (provisioningId === null) return;
          return mutate(
            item.speaker.id,
            () => provisionSpeaker(state.data.event.id, {
              eventId: state.data.event.id,
              speakerId: item.speaker.id,
              provisioningId,
              expectedVersion: item.provisioningVersion,
            }),
            "Speaker provisioned",
          );
        }}
        onVisibility={(item, visible) =>
          mutate(
            item.speaker.id,
            () => updateSpeakerPublication(state.data.event.id, {
              eventId: state.data.event.id,
              speakerId: item.speaker.id,
              expectedVersion: item.speaker.version,
              visible,
            }),
            visible ? "Speaker published" : "Speaker hidden",
          )
        }
        onCreate={(form) => mutate("new", () => createManagedSpeaker(state.data.event.id, {
          ...managedSpeakerInput(state.data.event.id, form),
          idempotencyKey: crypto.randomUUID(),
        }), "Speaker added")}
        onUpdate={(item, form) => mutate(item.speaker.id, () => updateManagedSpeaker(state.data.event.id, {
          ...managedSpeakerInput(state.data.event.id, form),
          speakerId: item.speaker.id,
          expectedVersion: item.speaker.version,
        } satisfies UpdateManagedSpeakerInput), "Speaker updated")}
        onImportCsv={(csv) => mutate("csv", () => importSpeakersCsv(state.data.event.id, {
          eventId: state.data.event.id,
          csv,
          idempotencyKey: crypto.randomUUID(),
        }), "Speaker CSV imported")}
        onMessage={(speakerIds, kind) => {
          const recipients = state.data.speakers
            .filter((item) => speakerIds.includes(item.speaker.id))
            .map((item) => item.speaker.displayName)
            .join(", ");
          const authorized = window.confirm(
            `Queue ${kind === "invite" ? "portal invitation" : "outstanding-task reminder"} emails now?\n\n`
            + `Audience: ${recipients}\n`
            + `Template: personalized ${kind === "invite" ? "portal access link" : "task count, next due task, and portal link"}\n`
            + "Reply-to: none\nDelivery: immediately after the durable outbox commit",
          );
          if (!authorized) return;
          return mutate("messages", () => sendSpeakerMessages(state.data.event.id, {
            eventId: state.data.event.id,
            speakerIds: speakerIds as SendSpeakerMessagesInput["speakerIds"],
            kind,
            idempotencyKey: crypto.randomUUID(),
          }), kind === "invite" ? "Invitations queued" : "Reminders queued");
        }}
        onUploadHeadshot={(item, file) => mutate(item.speaker.id, async () => uploadManagedSpeakerHeadshot(state.data.event.id, {
          eventId: state.data.event.id,
          speakerId: item.speaker.id,
          expectedVersion: item.speaker.version,
          filename: file.name,
          contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
          contentBase64: await fileBase64(file),
          idempotencyKey: crypto.randomUUID(),
        }), "Headshot updated")}
        onReview={(item, decision) => {
          const note = decision === "changes_requested"
            ? window.prompt("What should the speaker change?")
            : null;
          if (decision === "changes_requested" && !note?.trim()) return;
          return mutate(item.speaker.id, () => reviewSpeakerProfile({
            eventId: state.data.event.id,
            speakerId: item.speaker.id,
            expectedVersion: item.speaker.version,
            decision,
            note,
          }), decision === "approved" ? "Event profile approved" : "Profile changes requested");
        }}
      />
      <Toaster />
    </>
  );
}

export function OrganizerSpeakersContent({
  directory,
  busySpeakerId = null,
  onProvision,
  onVisibility,
  onCreate,
  onUpdate,
  onImportCsv,
  onMessage,
  onUploadHeadshot,
  onReview,
}: {
  readonly directory: SpeakerDirectory;
  readonly busySpeakerId?: string | null;
  readonly onProvision: (speaker: SpeakerDirectoryItem) => void;
  readonly onVisibility: (speaker: SpeakerDirectoryItem, visible: boolean) => void;
  readonly onCreate?: (form: HTMLFormElement) => boolean | Promise<boolean>;
  readonly onUpdate?: (speaker: SpeakerDirectoryItem, form: HTMLFormElement) => void;
  readonly onImportCsv?: (csv: string) => void;
  readonly onMessage?: (speakerIds: readonly string[], kind: "invite" | "reminder") => void;
  readonly onUploadHeadshot?: (speaker: SpeakerDirectoryItem, file: File) => void;
  readonly onReview?: (speaker: SpeakerDirectoryItem, decision: "approved" | "changes_requested") => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SpeakerDirectoryFilter>("all");
  const [workflowStatus, setWorkflowStatus] = useState("all");
  const [selectedSpeakerIds, setSelectedSpeakerIds] = useState<readonly string[]>([]);
  const [focusedSpeakerId, setFocusedSpeakerId] = useState<string | null>(null);
  const [expandedTaskSpeakerId, setExpandedTaskSpeakerId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const readyCount = directory.speakers.filter((item) => item.readiness.state === "ready").length;
  const provisionedCount = directory.speakers.filter((item) => item.provisioningStatus === "provisioned").length;
  const visibleCount = directory.speakers.filter((item) => item.speaker.visible).length;
  const filteredSpeakers = useMemo(
    () => filterSpeakerDirectory(directory.speakers, query, filter, workflowStatus),
    [directory.speakers, filter, query, workflowStatus],
  );
  const workflowStatuses = [...new Set(directory.speakers.map((item) => item.speaker.workflowStatus))].sort();
  const pageCount = Math.max(1, Math.ceil(filteredSpeakers.length / SPEAKERS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * SPEAKERS_PER_PAGE;
  const visibleSpeakers = filteredSpeakers.slice(pageStart, pageStart + SPEAKERS_PER_PAGE);
  const focusedSpeaker = visibleSpeakers.find((item) => item.speaker.id === focusedSpeakerId)
    ?? visibleSpeakers[0]
    ?? null;
  const focusedTasksExpanded = focusedSpeaker !== null && expandedTaskSpeakerId === focusedSpeaker.speaker.id;
  const focusedMissingItems = focusedSpeaker?.readiness.missingItems ?? [];
  const shownMissingItems = focusedTasksExpanded
    ? focusedMissingItems
    : focusedMissingItems.slice(0, COLLAPSED_TASK_COUNT);
  return (
    <div className="space-y-8">
      <ProductionHeader
        eyebrow="Organizer control room / Cast"
        title="Speakers"
        description={`Production directory for ${directory.event.name}. Readiness is derived from completed event tasks.`}
        accent="coral"
        actions={
          <span className="border-2 border-[#171714] bg-[#ff714f] px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] shadow-[3px_3px_0_#171714]">
            {directory.speakers.length} speakers on call
          </span>
        }
      />
      <ProductionStats
        stats={[
          { label: "Speakers", value: directory.speakers.length, tone: "paper" },
          { label: "Provisioned", value: provisionedCount, tone: "sky" },
          { label: "Ready", value: readyCount, tone: "lime" },
          { label: "Public", value: visibleCount, tone: "purple" },
        ]}
      />
      {onCreate || onImportCsv ? (
        <details className="group border-2 border-[#171714] bg-[#fffdf7] shadow-[4px_4px_0_#171714]">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-xs font-black uppercase tracking-[0.12em] marker:content-none">
            Add or import speakers
            <span aria-hidden="true" className="text-lg leading-none transition-transform group-open:rotate-45">+</span>
          </summary>
          <div className="grid gap-5 border-t-2 border-[#171714] p-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          {onCreate ? (
            <Card title="Add speaker directly">
              <form className="space-y-4" onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                if (await onCreate(form)) form.reset();
              }}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input name="displayName" label="Display name" required />
                  <Input name="contactEmail" type="email" label="Contact email" required />
                  <Input name="title" label="Title" />
                  <Input name="company" label="Company" />
                  <Input name="workflowStatus" label="Workflow status" defaultValue="Invited" required />
                  <Checkbox name="visible" label="Visible when published" defaultChecked />
                </div>
                <Textarea name="bio" label="Biography" />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={busySpeakerId === "new"}>Add speaker</Button>
                  <Button type="reset" variant="ghost" disabled={busySpeakerId === "new"}>Reset</Button>
                </div>
              </form>
            </Card>
          ) : null}
          {onImportCsv ? (
            <Card title="CSV import">
              <p className="mb-4 text-sm text-ink-muted">Headers: name, email, title, company, bio, status, visible. Matching emails are updated.</p>
              <Input
                type="file"
                label="Speaker CSV"
                accept=".csv,text/csv"
                disabled={busySpeakerId === "csv"}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void file.text().then(onImportCsv);
                }}
              />
            </Card>
          ) : null}
          </div>
        </details>
      ) : null}
      <section aria-label="Speaker production directory">
        <ProductionSectionLabel>Speaker production directory</ProductionSectionLabel>
        <div className="mb-4 grid gap-3 border-2 border-[#171714] bg-[#fffdf7] p-4 shadow-[4px_4px_0_#171714] sm:grid-cols-[minmax(0,1fr)_14rem_14rem]">
          <Input
            type="search"
            label="Search speakers"
            placeholder="Name, company, session, or category"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(1);
            }}
          />
          <Select
            label="Show"
            value={filter}
            onChange={(event) => {
              setFilter(event.currentTarget.value as SpeakerDirectoryFilter);
              setPage(1);
            }}
          >
            <option value="all">All speakers</option>
            <option value="needs_attention">Needs attention</option>
            <option value="ready">Ready</option>
            <option value="unprovisioned">Not provisioned</option>
            <option value="hidden">Hidden from gallery</option>
          </Select>
          <Select
            label="Workflow status"
            value={workflowStatus}
            onChange={(event) => {
              setWorkflowStatus(event.currentTarget.value);
              setPage(1);
            }}
          >
            <option value="all">All statuses</option>
            {workflowStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </Select>
        </div>
        {onMessage ? (
          <div className="mb-4 flex flex-wrap items-center gap-3 border-2 border-[#171714] bg-[#dff7ff] p-3">
            <strong className="text-xs uppercase tracking-wide">{selectedSpeakerIds.length} selected</strong>
            <Button size="sm" variant="secondary" disabled={selectedSpeakerIds.length === 0 || busySpeakerId === "messages"} onClick={() => onMessage(selectedSpeakerIds, "invite")}>Send invites</Button>
            <Button size="sm" variant="secondary" disabled={selectedSpeakerIds.length === 0 || busySpeakerId === "messages"} onClick={() => onMessage(selectedSpeakerIds, "reminder")}>Remind outstanding</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedSpeakerIds(visibleSpeakers.map((item) => item.speaker.id))}>Select page</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedSpeakerIds([])}>Clear</Button>
          </div>
        ) : null}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-[#4f4a40]">
          <p role="status">
            {filteredSpeakers.length === 0
              ? "No matching speakers"
              : `${pageStart + 1}–${Math.min(pageStart + SPEAKERS_PER_PAGE, filteredSpeakers.length)} of ${filteredSpeakers.length} matching speakers`}
          </p>
          {query.trim() || filter !== "all" || workflowStatus !== "all" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery("");
                setFilter("all");
                setWorkflowStatus("all");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.8fr)]">
          <div className="overflow-hidden border-2 border-[#171714] bg-[#fffdf7] shadow-[6px_6px_0_#171714]" aria-label="Speaker roster">
            <div className="hidden grid-cols-[2rem_minmax(13rem,1.35fr)_minmax(11rem,0.85fr)_9rem] gap-3 border-b-2 border-[#171714] bg-[#171714] px-3 py-3 text-[10px] font-black uppercase tracking-[0.12em] text-white lg:grid">
              <span aria-hidden="true" />
              <span>Speaker</span>
              <span>Readiness</span>
              <span>Stage</span>
            </div>
            {visibleSpeakers.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-ink-faint">Accepted speakers will appear after provisioning begins.</p>
            ) : visibleSpeakers.map((item) => {
              const isFocused = focusedSpeaker?.speaker.id === item.speaker.id;
              const nextTask = item.readiness.missingItems[0];
              return (
                <div
                  key={item.speaker.id}
                  className={`grid grid-cols-[2rem_minmax(0,1fr)] border-b-2 border-[#171714]/20 last:border-b-0 ${isFocused ? "bg-[#dff7ff]" : "hover:bg-[#ece8dc]"}`}
                >
                  <div className="flex items-center justify-center px-2 py-3">
                    <Checkbox
                      className="[&_label]:sr-only"
                      label={`Select ${item.speaker.displayName}`}
                      checked={selectedSpeakerIds.includes(item.speaker.id)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelectedSpeakerIds((selected) => checked
                          ? [...selected, item.speaker.id]
                          : selected.filter((id) => id !== item.speaker.id));
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    aria-pressed={isFocused}
                    aria-label={`Inspect ${item.speaker.displayName}`}
                    className="relative grid min-w-0 gap-2 px-2 py-3 pr-10 text-left outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-accent lg:grid-cols-[minmax(13rem,1.35fr)_minmax(11rem,0.85fr)_9rem] lg:items-center lg:gap-3"
                    onClick={() => setFocusedSpeakerId(item.speaker.id)}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar name={item.speaker.displayName} size="md" />
                      <span className="min-w-0">
                        <span className="block truncate font-black text-ink">{item.speaker.displayName}</span>
                        <span className="block truncate text-xs text-ink-faint">
                          {[item.speaker.title, item.speaker.company].filter(Boolean).join(" · ") || "Profile pending"}
                        </span>
                        <span className="mt-1 block truncate text-xs font-semibold text-ink-secondary">
                          {item.submission?.title ?? item.sessions[0]?.title ?? "No session linked"}
                        </span>
                      </span>
                    </span>
                    <span className="min-w-0">
                      <ReadinessMeter item={item} compact />
                      {nextTask ? <span className="mt-1.5 block truncate text-xs font-semibold text-ink-secondary">Next: {nextTask.name}</span> : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 lg:block lg:space-y-1.5">
                      <Badge tone={item.readiness.state === "ready" ? "success" : "neutral"}>{item.speaker.workflowStatus}</Badge>
                      <span className="block text-[11px] font-bold text-ink-faint">{item.speaker.visible ? "Public" : "Hidden"}</span>
                    </span>
                    <span aria-hidden="true" className="absolute right-3 top-3 text-xl font-black text-ink lg:top-1/2 lg:-translate-y-1/2">→</span>
                  </button>
                </div>
              );
            })}
          </div>

          {focusedSpeakerId !== null ? (
            <button
              type="button"
              className="fixed inset-0 z-40 bg-[#171714]/65 xl:hidden"
              aria-label="Close speaker inspector"
              onClick={() => setFocusedSpeakerId(null)}
            />
          ) : null}
          <aside
            className={`border-2 border-[#171714] bg-[#fffdf7] shadow-[6px_6px_0_#7857ff] ${focusedSpeakerId === null ? "hidden xl:block" : "fixed inset-x-3 bottom-3 top-20 z-50 overflow-y-auto xl:sticky xl:inset-auto xl:top-5 xl:z-auto xl:max-h-[calc(100dvh-2.5rem)]"}`}
            aria-label="Speaker readiness inspector"
          >
            {focusedSpeaker ? (
              <>
                <div className="border-b-2 border-[#171714] bg-[#171714] p-4 text-white">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/60">Readiness inspector</p>
                    <Button size="sm" variant="ghost" className="text-white xl:hidden" onClick={() => setFocusedSpeakerId(null)}>Close</Button>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <Avatar name={focusedSpeaker.speaker.displayName} size="lg" />
                    <div className="min-w-0">
                      <a className="block truncate text-lg font-black underline decoration-2 underline-offset-4" href={`/e/${encodeURIComponent(directory.event.slug)}/speakers/${encodeURIComponent(focusedSpeaker.speaker.id)}`}>{focusedSpeaker.speaker.displayName}</a>
                      <p className="truncate text-xs font-semibold text-white/65">
                        {[focusedSpeaker.speaker.title, focusedSpeaker.speaker.company].filter(Boolean).join(" · ") || "Profile pending"}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-5 p-4 sm:p-5">
                  <section aria-label="Speaker readiness">
                    <ReadinessMeter item={focusedSpeaker} />
                    {focusedSpeaker.readiness.clearestBlocker ? (
                      <div className="mt-3 border-l-4 border-danger bg-danger/10 px-3 py-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.1em] text-danger">Current blocker</p>
                        <p className="mt-1 text-sm font-bold text-ink">{focusedSpeaker.readiness.clearestBlocker}</p>
                      </div>
                    ) : null}
                  </section>

                  <section className="border-t-2 border-[#171714] pt-4" aria-labelledby="focused-speaker-tasks">
                    <div className="flex items-center justify-between gap-3">
                      <h3 id="focused-speaker-tasks" className="text-xs font-black uppercase tracking-[0.12em] text-ink">Open tasks</h3>
                      <span className="text-xs font-black tabular-nums text-ink-faint">{focusedMissingItems.length}</span>
                    </div>
                    {shownMissingItems.length > 0 ? (
                      <ol className="mt-3 space-y-2">
                        {shownMissingItems.map((task, index) => (
                          <li key={task.id} className={`border-2 border-[#171714] p-3 ${index === 0 ? "bg-[#fff0a8] shadow-[3px_3px_0_#171714]" : "bg-white"}`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-black text-ink">{task.name}</p>
                                <p className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                                  {task.kind}{task.dueAt ? ` · Due ${new Date(task.dueAt).toLocaleDateString()}` : ""}
                                </p>
                              </div>
                              {task.overdue ? <Badge tone="danger">Overdue</Badge> : index === 0 ? <Badge tone="warning">Next</Badge> : null}
                            </div>
                            {index === 0 && task.recommendedAction ? <p className="mt-2 text-xs font-semibold leading-5 text-ink-secondary">{task.recommendedAction}</p> : null}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <div className="mt-3 border-2 border-success bg-success/10 p-4 text-sm font-black text-ink">All speaker tasks are complete.</div>
                    )}
                    {focusedMissingItems.length > COLLAPSED_TASK_COUNT ? (
                      <Button
                        className="mt-3 w-full"
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpandedTaskSpeakerId(focusedTasksExpanded ? null : focusedSpeaker.speaker.id)}
                      >
                        {focusedTasksExpanded ? "Show fewer tasks" : `Show ${focusedMissingItems.length - COLLAPSED_TASK_COUNT} more tasks`}
                      </Button>
                    ) : null}
                  </section>

                  <section className="border-t-2 border-[#171714] pt-4">
                    <h3 className="text-xs font-black uppercase tracking-[0.12em] text-ink">Session & profile</h3>
                    <div className="mt-3 space-y-3 text-sm">
                      {focusedSpeaker.submission ? (
                        <Link className="block font-black text-ink underline decoration-2 underline-offset-4 hover:text-accent-deep" to={`/e/${encodeURIComponent(directory.event.slug)}/review?selectedSubmissionId=${encodeURIComponent(focusedSpeaker.submission.id)}`}>
                          {focusedSpeaker.submission.title}
                        </Link>
                      ) : focusedSpeaker.sessions.length > 0 ? (
                        <ul className="space-y-2">{focusedSpeaker.sessions.map((session) => <li key={session.id}><a className="font-black underline decoration-2 underline-offset-3 hover:text-accent-deep" href={organizerAgendaTalkPath(directory.event.slug, session.id)}>{session.title}</a>{session.startsAt ? <span className="block text-xs text-ink-faint">{new Date(session.startsAt).toLocaleString()}</span> : null}</li>)}</ul>
                      ) : <p className="text-ink-faint">No session linked</p>}
                      <div className="flex flex-wrap gap-2">
                        <Badge tone={focusedSpeaker.speaker.profileReviewStatus === "approved" ? "success" : focusedSpeaker.speaker.profileReviewStatus === "changes_requested" ? "danger" : "neutral"}>
                          Profile {focusedSpeaker.speaker.profileReviewStatus.replace("_", " ")}
                        </Badge>
                        {focusedSpeaker.source === "manual" ? <Badge tone="neutral">Direct</Badge> : focusedSpeaker.provisioningStatus === "provisioned" ? <Badge tone="success">Provisioned</Badge> : focusedSpeaker.provisioningStatus === "failed" ? <Badge tone="danger">Failed</Badge> : <Badge tone="warning">Not provisioned</Badge>}
                      </div>
                      <Checkbox
                        label={focusedSpeaker.speaker.visible ? "Visible in public gallery" : "Hidden from public gallery"}
                        checked={focusedSpeaker.speaker.visible}
                        disabled={busySpeakerId === focusedSpeaker.speaker.id || focusedSpeaker.provisioningStatus !== "provisioned" || focusedSpeaker.speaker.profileReviewStatus !== "approved"}
                        onChange={(event) => onVisibility(focusedSpeaker, event.currentTarget.checked)}
                      />
                    </div>
                  </section>

                  <section className="border-t-2 border-[#171714] pt-4">
                    <h3 className="text-xs font-black uppercase tracking-[0.12em] text-ink">Actions</h3>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {focusedSpeaker.source !== "manual" && focusedSpeaker.provisioningStatus !== "provisioned" && focusedSpeaker.provisioningStatus !== "failed" ? (
                        <Button size="sm" variant="secondary" className={productionButtonClass} loading={busySpeakerId === focusedSpeaker.speaker.id} onClick={() => onProvision(focusedSpeaker)}>Provision</Button>
                      ) : null}
                      {onReview && focusedSpeaker.speaker.profileReviewStatus === "in_review" ? (
                        <>
                          <Button size="sm" loading={busySpeakerId === focusedSpeaker.speaker.id} onClick={() => onReview(focusedSpeaker, "approved")}>Approve profile</Button>
                          <Button size="sm" variant="secondary" disabled={busySpeakerId === focusedSpeaker.speaker.id} onClick={() => onReview(focusedSpeaker, "changes_requested")}>Request changes</Button>
                        </>
                      ) : null}
                    </div>
                    {onUpdate && focusedSpeaker.source === "manual" ? (
                      <details className="mt-3 border-2 border-[#171714] bg-white">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-black uppercase tracking-[0.08em]">Edit profile</summary>
                        <form className="space-y-3 border-t-2 border-[#171714] p-3" onSubmit={(event) => { event.preventDefault(); onUpdate(focusedSpeaker, event.currentTarget); }}>
                          <Input name="displayName" label="Name" defaultValue={focusedSpeaker.speaker.displayName} required />
                          <Input name="contactEmail" type="email" label="Contact email" defaultValue={focusedSpeaker.speaker.contactEmail ?? ""} required />
                          <Input name="title" label="Title" defaultValue={focusedSpeaker.speaker.title ?? ""} />
                          <Input name="company" label="Company" defaultValue={focusedSpeaker.speaker.company ?? ""} />
                          <Input name="workflowStatus" label="Workflow status" defaultValue={focusedSpeaker.speaker.workflowStatus} required />
                          <Textarea name="bio" label="Biography" defaultValue={focusedSpeaker.speaker.bio ?? ""} />
                          {onUploadHeadshot ? <Input type="file" accept="image/jpeg,image/png,image/webp" label="Replace headshot" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onUploadHeadshot(focusedSpeaker, file); }} /> : null}
                          <Checkbox name="visible" label="Publicly visible" defaultChecked={focusedSpeaker.speaker.visible} />
                          <Button size="sm" type="submit" loading={busySpeakerId === focusedSpeaker.speaker.id}>Save speaker</Button>
                        </form>
                      </details>
                    ) : focusedSpeaker.source === "accepted" ? (
                      <p className="mt-3 text-xs leading-5 text-ink-faint">Profile details are managed by this accepted speaker in their portal.</p>
                    ) : null}
                  </section>
                </div>
              </>
            ) : (
              <p className="p-8 text-center text-sm text-ink-faint">Select a speaker to inspect readiness.</p>
            )}
          </aside>
        </div>
        {pageCount > 1 ? (
          <nav className="mt-5 flex items-center justify-between gap-4" aria-label="Speaker directory pages">
            <Button
              variant="secondary"
              className={productionButtonClass}
              disabled={currentPage === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </Button>
            <p className="text-xs font-black uppercase tracking-[0.12em] text-[#171714]">
              Page {currentPage} of {pageCount}
            </p>
            <Button
              variant="secondary"
              className={productionButtonClass}
              disabled={currentPage === pageCount}
              onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
