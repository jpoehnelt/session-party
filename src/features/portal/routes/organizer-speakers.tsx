import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Avatar, Badge, Button, Card, Checkbox, Input, ReadinessThread, Select, Table, Textarea, Toaster, toast } from "@/ui";
import type { CreateManagedSpeakerInput, SendSpeakerMessagesInput, SpeakerDirectory, SpeakerDirectoryItem, UpdateManagedSpeakerInput } from "../schema";
import { createManagedSpeaker, getSpeakerDirectory, importSpeakersCsv, provisionSpeaker, reviewSpeakerProfile, sendSpeakerMessages, updateManagedSpeaker, updateSpeakerPublication, uploadManagedSpeakerHeadshot } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import { organizerAgendaTalkPath } from "@/features/agenda/links";
import {
  ProductionHeader,
  ProductionSectionLabel,
  ProductionStats,
  productionButtonClass,
  productionTableClass,
} from "../components/production-ui";

export const path = "/e/:eventSlug/speakers";
export const contentWidth = "wide" as const;

const SPEAKERS_PER_PAGE = 25;

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
        <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
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
        <div className={productionTableClass}>
          <Table
            rows={[...visibleSpeakers]}
            rowKey={(item) => item.speaker.id}
            empty="Accepted speakers will appear after provisioning begins."
            columns={[
          {
            key: "select",
            header: "Select",
            render: (item) => (
              <Checkbox
                label={`Select ${item.speaker.displayName}`}
                checked={selectedSpeakerIds.includes(item.speaker.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelectedSpeakerIds((selected) => checked
                    ? [...selected, item.speaker.id]
                    : selected.filter((id) => id !== item.speaker.id));
                }}
              />
            ),
          },
          {
            key: "speaker",
            header: "Speaker",
            render: (item) => (
              <div className="flex min-w-48 items-center gap-3">
                <Avatar name={item.speaker.displayName} size="md" />
                <div className="min-w-0">
                  <a className="inline-flex min-h-6 items-center truncate font-semibold text-ink underline decoration-2 underline-offset-3 hover:text-accent-deep" href={`/e/${encodeURIComponent(directory.event.slug)}/speakers/${encodeURIComponent(item.speaker.id)}`}>{item.speaker.displayName}</a>
                  <p className="truncate text-xs text-ink-faint">
                    {[item.speaker.title, item.speaker.company].filter(Boolean).join(" · ") || "Profile pending"}
                  </p>
                </div>
              </div>
            ),
          },
          {
            key: "session",
            header: "Accepted session",
            render: (item) => item.submission ? (
              <div className="max-w-64">
                <Link
                  className="font-black text-ink underline decoration-2 underline-offset-4 hover:text-accent-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  to={`/e/${encodeURIComponent(directory.event.slug)}/review?selectedSubmissionId=${encodeURIComponent(item.submission.id)}`}
                >
                  {item.submission.title}
                </Link>
                {item.submission.category && <p className="text-xs text-ink-faint">{item.submission.category}</p>}
              </div>
            ) : item.sessions.length > 0 ? (
              <ul className="space-y-1 text-sm">{item.sessions.map((session) => <li key={session.id}><a className="font-bold underline decoration-2 underline-offset-3 hover:text-accent-deep" href={organizerAgendaTalkPath(directory.event.slug, session.id)}>{session.title}</a>{session.startsAt ? ` · ${new Date(session.startsAt).toLocaleString()}` : ""}</li>)}</ul>
            ) : <span className="text-ink-faint">Not linked</span>,
          },
          {
            key: "workflow",
            header: "Workflow",
            render: (item) => <Badge tone={item.readiness.state === "ready" ? "success" : "neutral"}>{item.speaker.workflowStatus}</Badge>,
          },
          {
            key: "readiness",
            header: "Readiness",
            render: (item) => (
              <div className="min-w-52">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <Badge tone={item.readiness.state === "ready" ? "success" : item.readiness.state === "in_progress" ? "accent" : "warning"}>
                    {item.readiness.state.replace("_", " ")}
                  </Badge>
                  <span className="text-xs text-ink-faint">{item.readiness.tasksDone}/{item.readiness.tasksTotal}</span>
                </div>
                <ReadinessThread
                  compact
                  currentId={item.readiness.nextTaskId ?? undefined}
                  className="[&_li>span]:rounded-none [&_li>span]:border-[#171714]"
                  items={item.readiness.outstandingTaskIds.map((id, index) => ({
                    id,
                    label: `Outstanding task ${index + 1}`,
                    state: "pending" as const,
                  }))}
                />
              </div>
            ),
          },
          {
            key: "publication",
            header: "Public gallery",
            render: (item) => (
              <div className="space-y-2">
                <Badge tone={item.speaker.profileReviewStatus === "approved" ? "success" : item.speaker.profileReviewStatus === "changes_requested" ? "danger" : "neutral"}>
                  {item.speaker.profileReviewStatus.replace("_", " ")}
                </Badge>
                <Checkbox
                  label={item.speaker.visible ? "Visible" : "Hidden"}
                  checked={item.speaker.visible}
                  disabled={busySpeakerId === item.speaker.id || item.provisioningStatus !== "provisioned" || item.speaker.profileReviewStatus !== "approved"}
                  onChange={(event) => onVisibility(item, event.currentTarget.checked)}
                />
              </div>
            ),
          },
          {
            key: "action",
            header: "Provisioning",
            render: (item) => (
              <div className="space-y-2">
                {item.source === "manual" ? <Badge tone="neutral">Direct</Badge> : item.provisioningStatus === "provisioned" ? (
                  <Badge tone="success">Provisioned</Badge>
                ) : item.provisioningStatus === "failed" ? (
                  <Badge tone="danger">Failed</Badge>
                ) : (
                  <Button size="sm" variant="secondary" className={productionButtonClass} loading={busySpeakerId === item.speaker.id} onClick={() => onProvision(item)}>Provision</Button>
                )}
                {onReview && item.speaker.profileReviewStatus === "in_review" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" loading={busySpeakerId === item.speaker.id} onClick={() => onReview(item, "approved")}>Approve profile</Button>
                    <Button size="sm" variant="secondary" disabled={busySpeakerId === item.speaker.id} onClick={() => onReview(item, "changes_requested")}>Request changes</Button>
                  </div>
                ) : null}
                {onUpdate && item.source === "manual" ? (
                  <details>
                    <summary className="cursor-pointer text-xs font-bold underline">Edit profile</summary>
                    <form className="mt-3 min-w-72 space-y-3" onSubmit={(event) => { event.preventDefault(); onUpdate(item, event.currentTarget); }}>
                      <Input name="displayName" label="Name" defaultValue={item.speaker.displayName} required />
                      <Input name="contactEmail" type="email" label="Contact email" defaultValue={item.speaker.contactEmail ?? ""} required />
                      <Input name="title" label="Title" defaultValue={item.speaker.title ?? ""} />
                      <Input name="company" label="Company" defaultValue={item.speaker.company ?? ""} />
                      <Input name="workflowStatus" label="Workflow status" defaultValue={item.speaker.workflowStatus} required />
                      <Textarea name="bio" label="Biography" defaultValue={item.speaker.bio ?? ""} />
                      {onUploadHeadshot ? <Input type="file" accept="image/jpeg,image/png,image/webp" label="Replace headshot" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onUploadHeadshot(item, file); }} /> : null}
                      <Checkbox name="visible" label="Publicly visible" defaultChecked={item.speaker.visible} />
                      <Button size="sm" type="submit" loading={busySpeakerId === item.speaker.id}>Save speaker</Button>
                    </form>
                  </details>
                ) : item.source === "accepted" ? (
                  <p className="max-w-48 text-xs text-ink-faint">Profile details are managed by this accepted speaker in their portal.</p>
                ) : null}
              </div>
            ),
          },
            ]}
          />
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
