import { Schema } from "effect";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { parseDateTimeInTimezone } from "@/features/events/routes/event-settings";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Table,
  Tabs,
  Textarea,
  Toaster,
  toast,
  type BadgeTone,
  type TableColumn,
} from "@/ui";
import {
  AudienceSnapshot,
  CommunicationPreview,
  CommunicationTemplate,
  DeliveryHistory,
  EnqueueCommunicationResult,
  RetryDeliveryResult,
  type AudienceSnapshot as AudienceSnapshotValue,
  type CommunicationPreview as CommunicationPreviewValue,
  type CommunicationTemplate as CommunicationTemplateValue,
  type DeliveryHistory as DeliveryHistoryValue,
  type DeliveryHistoryItem,
  type EnqueueCommunicationResult as EnqueueCommunicationResultValue,
} from "../schema";

export const path = "/e/:eventSlug/comms";

type EventIdentity = Readonly<{ id: string; name: string; slug: string; timezone: string }>;
type WorkspaceTab = "templates" | "send" | "history";
type SendMode = "now" | "scheduled";
type TemplateDraft = Readonly<{
  id: string | null;
  name: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  attachIcs: boolean;
  version: number | null;
}>;

const emptyDraft: TemplateDraft = {
  id: null,
  name: "",
  subject: "",
  textBody: "",
  htmlBody: "",
  attachIcs: false,
  version: null,
};

const tabs = [
  { id: "templates", label: "Templates", panelId: "comms-templates" },
  { id: "send", label: "Audience & queue", panelId: "comms-send" },
  { id: "history", label: "Delivery history", panelId: "comms-history" },
];

const asDraft = (template: CommunicationTemplateValue): TemplateDraft => ({
  id: template.id,
  name: template.name,
  subject: template.subject,
  textBody: template.textBody,
  htmlBody: template.htmlBody,
  attachIcs: template.attachIcs,
  version: template.version,
});

const operationKey = (operation: string) => `${operation}-${crypto.randomUUID()}`;
const formatTime = (timestamp: number | null): string => timestamp === null
  ? "—"
  : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);

interface EnqueueRequestBase {
  readonly templateId: string;
  readonly recipientSpeakerIds: readonly string[];
  readonly replyToEmail: string | null;
  readonly idempotencyKey: string;
}

export const buildEnqueueRequest = (
  input: EnqueueRequestBase,
  mode: SendMode,
  scheduledWallTime: string,
  timezone: string,
  now = Date.now(),
) => {
  if (mode === "now") return { ...input, scheduledFor: null };
  const scheduledFor = parseDateTimeInTimezone(scheduledWallTime, timezone, "Scheduled delivery");
  if (scheduledFor === null) throw new Error("Choose a delivery date and time.");
  if (scheduledFor <= now) throw new Error("Scheduled delivery must be in the future.");
  return { ...input, scheduledFor };
};

interface ScheduleControlProps {
  readonly mode: SendMode;
  readonly scheduledWallTime: string;
  readonly timezone: string;
  readonly onModeChange: (mode: SendMode) => void;
  readonly onScheduledWallTimeChange: (value: string) => void;
}

export function ScheduleControl({
  mode,
  scheduledWallTime,
  timezone,
  onModeChange,
  onScheduledWallTimeChange,
}: ScheduleControlProps) {
  return (
    <div className="space-y-3">
      <Select
        label="Delivery timing"
        value={mode}
        onChange={(event_) => onModeChange(event_.target.value as SendMode)}
      >
        <option value="now">Send now</option>
        <option value="scheduled">Schedule for later</option>
      </Select>
      {mode === "scheduled" && (
        <>
          <Input
            label={`Delivery date and time (${timezone})`}
            type="datetime-local"
            step={60}
            required
            value={scheduledWallTime}
            onChange={(event_) => onScheduledWallTimeChange(event_.target.value)}
          />
          <p className="text-xs leading-relaxed text-ink-faint">
            This wall time is validated and interpreted in the event timezone: {timezone}.
          </p>
        </>
      )}
    </div>
  );
}

const deliveryLabel = (delivery: DeliveryHistoryItem): { readonly label: string; readonly tone: BadgeTone } => {
  if (delivery.mode === "localCapture" && delivery.status === "sent") return { label: "Captured locally", tone: "accent" };
  if (delivery.status === "sent") return { label: "Sent via Cloudflare Email", tone: "success" };
  if (delivery.status === "dead_letter") return { label: "Needs retry", tone: "danger" };
  if (delivery.status === "retry") return { label: "Retry scheduled", tone: "warning" };
  if (delivery.status === "claimed") return { label: "Worker claimed", tone: "warning" };
  if (delivery.status === "cancelled") return { label: "Cancelled", tone: "neutral" };
  return { label: "Queued durably", tone: "neutral" };
};

function LoadingRegion() {
  return (
    <>
      <div aria-label="Loading communications" role="status" className="space-y-4">
        <Skeleton className="h-20 motion-reduce:animate-none" />
        <Skeleton className="h-72 motion-reduce:animate-none" />
      </div>
      <Toaster />
    </>
  );
}

export default function CommunicationsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventIdentity | null | undefined>(undefined);
  const [eventError, setEventError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setEvent(undefined);
    setEventError(null);
    void apiFetch<EventIdentity>(`/api/v1/events/${encodeURIComponent(eventSlug)}`)
      .then((value) => { if (active) setEvent(value); })
      .catch((error) => {
        if (!active) return;
        const unauthorized = error instanceof ApiError && error.status === 401;
        const notFound = error instanceof ApiError && error.status === 404;
        setEventError(unauthorized ? "unauthenticated" : notFound ? null : error instanceof Error ? error.message : "Could not load event");
        setEvent(null);
      });
    return () => { active = false; };
  }, [eventSlug, request]);

  if (event === undefined) return <LoadingRegion />;
  if (event === null) {
    const unauthorized = eventError === "unauthenticated";
    return (
      <>
        <EmptyState
          title={unauthorized ? "Sign in to manage communications" : eventError ? "Could not load event" : "Event not found"}
          description={unauthorized ? "Use an organizer account to continue." : eventError ?? "The event may have moved or been removed."}
          action={
            <Button onClick={() => unauthorized ? navigate(loginPathForLocation(location)) : setRequest((value) => value + 1)}>
              {unauthorized ? "Sign in" : "Try again"}
            </Button>
          }
        />
        <Toaster />
      </>
    );
  }
  return <CommunicationsWorkspace key={event.id} event={event} />;
}

function CommunicationsWorkspace({ event }: { readonly event: EventIdentity }) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("templates");
  const [templates, setTemplates] = useState<readonly CommunicationTemplateValue[] | undefined>(undefined);
  const [audience, setAudience] = useState<AudienceSnapshotValue | undefined>(undefined);
  const [history, setHistory] = useState<DeliveryHistoryValue | undefined>(undefined);
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft);
  const [preview, setPreview] = useState<CommunicationPreviewValue | null>(null);
  const [previewSpeakerId, setPreviewSpeakerId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedSpeakers, setSelectedSpeakers] = useState<ReadonlySet<string>>(new Set());
  const [replyToEmail, setReplyToEmail] = useState("");
  const [sendMode, setSendMode] = useState<SendMode>("now");
  const [scheduledWallTime, setScheduledWallTime] = useState("");
  const [busy, setBusy] = useState<"save" | "preview" | "enqueue" | `retry:${string}` | null>(null);
  const [queueResult, setQueueResult] = useState<EnqueueCommunicationResultValue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const loadWorkspace = useCallback(async () => {
    const root = `/api/v1/events/${encodeURIComponent(event.id)}/comms`;
    const [nextTemplates, nextAudience, nextHistory] = await Promise.all([
      apiFetch(`${root}/templates`, { schema: Schema.Array(CommunicationTemplate) }),
      apiFetch(`${root}/audience`, { schema: AudienceSnapshot }),
      apiFetch(`${root}/deliveries`, { schema: DeliveryHistory }),
    ]);
    setTemplates(nextTemplates);
    setAudience(nextAudience);
    setHistory(nextHistory);
    setSelectedTemplateId((current) => current || nextTemplates[0]?.id || "");
    setDraft((current) => current.id || current.name || current.subject || current.textBody || current.htmlBody
      ? current
      : nextTemplates[0] ? asDraft(nextTemplates[0]) : emptyDraft);
    setLoadError(null);
  }, [event.id]);

  useEffect(() => {
    let active = true;
    void loadWorkspace().catch((error) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "Could not load communications";
      setLoadError(message);
      setTemplates([]);
      setAudience({ eventId: event.id, recipients: [], eligibleCount: 0, dependency: "acceptedSpeakers" });
      setHistory({ eventId: event.id, deliveries: [], localCaptureCount: 0 });
      toast(message, { tone: "danger" });
    });
    return () => { active = false; };
  }, [loadWorkspace, refresh, event.id]);

  const eligibleRecipients = audience?.recipients.filter((recipient) => recipient.eligibility === "eligible") ?? [];
  const selectedTemplate = templates?.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedCount = [...selectedSpeakers].filter((speakerId) => eligibleRecipients.some((recipient) => recipient.speakerId === speakerId)).length;

  const saveTemplate = async (event_: FormEvent) => {
    event_.preventDefault();
    setBusy("save");
    try {
      const root = `/api/v1/events/${encodeURIComponent(event.id)}/comms/templates`;
      const saved = draft.id && draft.version
        ? await apiFetch(`${root}/${encodeURIComponent(draft.id)}`, {
            method: "PUT",
            body: {
              name: draft.name,
              subject: draft.subject,
              textBody: draft.textBody,
              htmlBody: draft.htmlBody,
              attachIcs: draft.attachIcs,
              expectedVersion: draft.version,
              idempotencyKey: operationKey("update-template"),
            },
            schema: CommunicationTemplate,
          })
        : await apiFetch(root, {
            method: "POST",
            body: {
              name: draft.name,
              subject: draft.subject,
              textBody: draft.textBody,
              htmlBody: draft.htmlBody,
              attachIcs: draft.attachIcs,
              idempotencyKey: operationKey("create-template"),
            },
            schema: CommunicationTemplate,
          });
      setTemplates((current) => current
        ? [...current.filter((template) => template.id !== saved.id), saved].sort((left, right) => left.name.localeCompare(right.name))
        : [saved]);
      setDraft(asDraft(saved));
      setSelectedTemplateId(saved.id);
      toast(draft.id ? "Template saved" : "Template created", { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Template save failed", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const renderPreview = async () => {
    setBusy("preview");
    try {
      const value = await apiFetch(`/api/v1/events/${encodeURIComponent(event.id)}/comms/preview`, {
        method: "POST",
        body: {
          subject: draft.subject,
          textBody: draft.textBody,
          htmlBody: draft.htmlBody,
          attachIcs: draft.attachIcs,
          speakerId: previewSpeakerId || null,
        },
        schema: CommunicationPreview,
      });
      setPreview(value);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Preview failed", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const enqueue = async () => {
    if (!selectedTemplate || selectedCount === 0) return;
    setBusy("enqueue");
    try {
      const request = buildEnqueueRequest(
        {
          templateId: selectedTemplate.id,
          recipientSpeakerIds: [...selectedSpeakers],
          replyToEmail: replyToEmail.trim() || null,
          idempotencyKey: operationKey("enqueue-communications"),
        },
        sendMode,
        scheduledWallTime,
        event.timezone,
      );
      const result = await apiFetch(`/api/v1/events/${encodeURIComponent(event.id)}/comms/deliveries`, {
        method: "POST",
        body: request,
        schema: EnqueueCommunicationResult,
      });
      setQueueResult(result);
      setSelectedSpeakers(new Set());
      setRefresh((value) => value + 1);
      toast(`${result.deliveries.length} ${result.deliveries.length === 1 ? "delivery" : "deliveries"} queued durably`, { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Delivery enqueue failed", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const retry = async (delivery: DeliveryHistoryItem) => {
    setBusy(`retry:${delivery.id}`);
    try {
      await apiFetch(`/api/v1/events/${encodeURIComponent(event.id)}/comms/deliveries/${encodeURIComponent(delivery.id)}/retry`, {
        method: "POST",
        body: { idempotencyKey: operationKey("retry-delivery") },
        schema: RetryDeliveryResult,
      });
      setRefresh((value) => value + 1);
      toast("Retry queued from the immutable snapshot", { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Retry failed", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const deliveryColumns = useMemo<TableColumn<DeliveryHistoryItem>[]>(() => [
    {
      key: "recipient",
      header: "Recipient",
      render: (delivery) => (
        <div>
          <p className="font-medium text-ink">{delivery.recipientName ?? delivery.recipientEmail}</p>
          <p className="text-xs text-ink-faint">{delivery.recipientEmail}</p>
        </div>
      ),
    },
    { key: "subject", header: "Message", render: (delivery) => <span className="line-clamp-2 max-w-sm">{delivery.subject}</span> },
    {
      key: "status",
      header: "Delivery truth",
      render: (delivery) => {
        const badge = deliveryLabel(delivery);
        return (
          <div className="space-y-1">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <p className="text-xs text-ink-faint">{delivery.attemptCount}/{delivery.maxAttempts} attempts</p>
          </div>
        );
      },
    },
    { key: "createdAt", header: "Queued", render: (delivery) => formatTime(delivery.createdAt) },
    {
      key: "action",
      header: "",
      render: (delivery) => delivery.canRetry ? (
        <Button size="sm" variant="secondary" loading={busy === `retry:${delivery.id}`} onClick={() => void retry(delivery)}>
          Retry snapshot
        </Button>
      ) : null,
    },
  ], [busy]);

  if (templates === undefined || audience === undefined || history === undefined) return <LoadingRegion />;

  return (
    <>
      <PageHeader
        title="Speaker communications"
        description={`Prepare accepted-speaker messages for ${event.name}, confirm the exact audience, and inspect durable delivery evidence.`}
        actions={<Badge tone={history.localCaptureCount > 0 ? "accent" : "neutral"}>{history.localCaptureCount} local captures</Badge>}
      />
      <Tabs tabs={tabs} active={activeTab} onChange={(value) => setActiveTab(value as WorkspaceTab)} className="mb-6" />

      {loadError && (
        <Alert tone="danger" className="mb-6">
          <AlertTitle>Communications data is unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {activeTab === "templates" && (
        <div id="comms-templates" role="tabpanel" aria-labelledby="comms-templates-tab" className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Card
            title="Templates"
            footer={<Button variant="secondary" className="w-full" onClick={() => { setDraft(emptyDraft); setPreview(null); }}>New template</Button>}
          >
            {templates.length === 0 ? (
              <p className="text-sm text-ink-faint">Create the first reusable message.</p>
            ) : (
              <div className="space-y-1">
                {templates.map((template) => (
                  <Button
                    key={template.id}
                    variant={draft.id === template.id ? "secondary" : "ghost"}
                    className="h-auto w-full justify-start px-3 py-2 text-left whitespace-normal"
                    onClick={() => { setDraft(asDraft(template)); setPreview(null); }}
                  >
                    <span>
                      <span className="block text-sm font-medium">{template.name}</span>
                      <span className="block text-xs font-normal text-ink-faint">Version {template.version}{template.attachIcs ? " · ICS gated" : ""}</span>
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </Card>

          <div className="space-y-6">
            <Card title={draft.id ? `Edit ${draft.name || "template"}` : "New template"}>
              <form className="space-y-4" onSubmit={(event_) => void saveTemplate(event_)}>
                <Input label="Template name" value={draft.name} maxLength={120} onChange={(event_) => setDraft({ ...draft, name: event_.target.value })} required />
                <Input
                  label="Subject"
                  value={draft.subject}
                  maxLength={240}
                  hint="Merge contract: {{speaker.name}}, {{speaker.email}}, {{event.name}}, {{event.location}}, {{event.dates}}, {{talk.title}}, {{talk.time}}, {{talk.room}}, {{portal.url}}"
                  onChange={(event_) => setDraft({ ...draft, subject: event_.target.value })}
                  required
                />
                <Textarea
                  label="Plain-text message"
                  value={draft.textBody}
                  rows={8}
                  maxLength={20_000}
                  hint="Personalized independently and stored immutably with each delivery."
                  onChange={(event_) => setDraft({ ...draft, textBody: event_.target.value })}
                  required
                />
                <Textarea
                  label="HTML message"
                  value={draft.htmlBody}
                  rows={10}
                  maxLength={20_000}
                  hint="Template markup is retained; merge values are HTML-escaped before the snapshot is committed."
                  onChange={(event_) => setDraft({ ...draft, htmlBody: event_.target.value })}
                  required
                />
                <Checkbox
                  checked={draft.attachIcs}
                  onChange={(event_) => setDraft({ ...draft, attachIcs: event_.target.checked })}
                  label="Attach schedule invite"
                  description="Uses the selected speaker's confirmed agenda talks and rooms; enqueue rejects missing agenda data."
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={busy === "save"}>{draft.id ? "Save changes" : "Create template"}</Button>
                  <Button type="button" variant="secondary" loading={busy === "preview"} disabled={!draft.subject.trim() || !draft.textBody.trim() || !draft.htmlBody.trim()} onClick={() => void renderPreview()}>
                    Preview locally
                  </Button>
                  <Select
                    aria-label="Preview recipient"
                    className="min-w-52"
                    value={previewSpeakerId}
                    onChange={(event_) => setPreviewSpeakerId(event_.target.value)}
                  >
                    <option value="">Labeled sample data</option>
                    {eligibleRecipients.map((recipient) => <option key={recipient.speakerId} value={recipient.speakerId}>{recipient.name}</option>)}
                  </Select>
                </div>
              </form>
            </Card>

            {preview && (
              <Card title="Local preview" footer={<span className="text-xs text-ink-faint">{preview.note}</span>}>
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">Not sent</Badge>
                    <Badge tone={preview.mode === "acceptedSpeaker" ? "success" : "neutral"}>
                      {preview.mode === "acceptedSpeaker" ? "Accepted-speaker data" : "Sample data"}
                    </Badge>
                    {preview.icsStatus === "available" && <Badge tone="success">Confirmed agenda attached</Badge>}
                    {preview.icsStatus === "unavailableAgenda" && <Badge tone="warning">ICS unavailable without a confirmed agenda</Badge>}
                    {preview.unavailableVariables.length > 0 && (
                      <Badge tone="warning">{preview.unavailableVariables.join(", ")} unavailable</Badge>
                    )}
                  </div>
                  <div className="rounded-card border border-line bg-surface-muted p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">To</p>
                    <p className="mt-1 text-sm text-ink">{preview.recipientName} &lt;{preview.recipientEmail}&gt;</p>
                    <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">Subject</p>
                    <p className="mt-1 font-medium text-ink">{preview.subject}</p>
                  </div>
                  <div className="whitespace-pre-wrap rounded-card border border-line bg-surface p-5 text-sm leading-7 text-ink-secondary">{preview.text}</div>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {activeTab === "send" && (
        <div id="comms-send" role="tabpanel" aria-labelledby="comms-send-tab" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card title="Accepted-speaker audience">
            {audience.recipients.length === 0 ? (
              <EmptyState title="No accepted speakers yet" description="Audience selection activates from the append-only acceptance contract." />
            ) : (
              <div className="divide-y divide-line">
                {audience.recipients.map((recipient) => (
                  <div key={recipient.speakerId} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <Checkbox
                      checked={selectedSpeakers.has(recipient.speakerId)}
                      disabled={recipient.eligibility !== "eligible"}
                      onChange={(event_) => {
                        const next = new Set(selectedSpeakers);
                        if (event_.target.checked) next.add(recipient.speakerId); else next.delete(recipient.speakerId);
                        setSelectedSpeakers(next);
                      }}
                      label={recipient.name}
                      description={recipient.email ?? "No account email; not eligible for delivery"}
                    />
                    <div className="max-w-xs text-right">
                      <Badge tone={recipient.eligibility === "eligible" ? "success" : "warning"}>
                        {recipient.eligibility === "eligible" ? "Ready" : "Missing email"}
                      </Badge>
                      <p className="mt-1 text-xs text-ink-faint">{recipient.sessionTitles.join(" · ")}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="space-y-6">
            <Card title="Queue exact snapshots">
              <div className="space-y-4">
                <Select label="Template" value={selectedTemplateId} onChange={(event_) => setSelectedTemplateId(event_.target.value)}>
                  <option value="">Select a template</option>
                  {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </Select>
                <Input
                  label="Reply-to"
                  type="email"
                  placeholder="team@example.com"
                  value={replyToEmail}
                  onChange={(event_) => setReplyToEmail(event_.target.value)}
                />
                <ScheduleControl
                  mode={sendMode}
                  scheduledWallTime={scheduledWallTime}
                  timezone={event.timezone}
                  onModeChange={setSendMode}
                  onScheduledWallTimeChange={setScheduledWallTime}
                />
                {selectedTemplate?.attachIcs && (
                  <Alert tone="neutral">
                    <AlertTitle>Calendar attachment enabled</AlertTitle>
                    <AlertDescription>Each selected speaker receives exact confirmed talk times and rooms; recipients without confirmed agenda data are rejected.</AlertDescription>
                  </Alert>
                )}
                <div className="rounded-card border border-line bg-surface-muted p-4">
                  <p className="text-2xl font-semibold tracking-tight text-ink">{selectedCount}</p>
                  <p className="text-sm text-ink-secondary">confirmed recipients</p>
                </div>
                <Button
                  className="w-full"
                  loading={busy === "enqueue"}
                  disabled={!selectedTemplate || selectedCount === 0 || (sendMode === "scheduled" && scheduledWallTime === "")}
                  onClick={() => void enqueue()}
                >
                  {sendMode === "scheduled" ? "Schedule immutable deliveries" : "Queue immutable deliveries"}
                </Button>
                <p className="text-xs leading-relaxed text-ink-faint">
                  Queueing commits immutable snapshots and outbox rows, then requests canonical Scheduler dispatch. Status remains deferred until worker evidence is recorded.
                </p>
              </div>
            </Card>

            {queueResult && (
              <Alert tone="success">
                <AlertTitle>{queueResult.deliveries.length} deliveries persisted</AlertTitle>
                <AlertDescription>
                  Snapshot content and recipient selection are immutable. Scheduler wake was requested after commit; status is deferred, not sent.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      )}

      {activeTab === "history" && (
        <div id="comms-history" role="tabpanel" aria-labelledby="comms-history-tab" className="space-y-5">
          {history.localCaptureCount > 0 && (
            <Alert tone="neutral">
              <AlertTitle>Local mail capture is active for recorded deliveries</AlertTitle>
              <AlertDescription>
                “Captured locally” is test evidence only. It is not presented as live Cloudflare Email delivery.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-ink-secondary">Snapshot, provider, attempt, and dead-letter evidence from the durable mail tables.</p>
            <Button variant="secondary" size="sm" onClick={() => setRefresh((value) => value + 1)}>Refresh history</Button>
          </div>
          <Table
            columns={deliveryColumns}
            rows={[...history.deliveries]}
            rowKey={(delivery) => delivery.id}
            empty="No communication deliveries have been queued."
          />
        </div>
      )}
      <Toaster />
    </>
  );
}
