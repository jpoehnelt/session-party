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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
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
export const contentWidth = "canvas" as const;

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
  { id: "templates", label: "01 / Templates", panelId: "comms-templates" },
  { id: "send", label: "02 / Audience & queue", panelId: "comms-send" },
  { id: "history", label: "03 / Delivery history", panelId: "comms-history" },
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

export const buildMailtoDraft = (
  preview: Pick<CommunicationPreviewValue, "recipientEmail" | "subject" | "text">,
): string =>
  `mailto:${encodeURIComponent(preview.recipientEmail)}?subject=${encodeURIComponent(preview.subject)}&body=${encodeURIComponent(preview.text)}`;

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
    <fieldset className="space-y-3 border-2 border-line-strong bg-surface-muted p-4 shadow-[3px_3px_0_#171714]">
      <legend className="border-2 border-line-strong bg-production-yellow px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-ink">
        Dispatch window
      </legend>
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
    </fieldset>
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
  const [automatedDeliveryConfirmed, setAutomatedDeliveryConfirmed] = useState(false);
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
      setAutomatedDeliveryConfirmed(false);
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
          <p className="font-black tracking-[-0.015em] text-ink">{delivery.recipientName ?? delivery.recipientEmail}</p>
          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-ink-faint">{delivery.recipientEmail}</p>
        </div>
      ),
    },
    { key: "subject", header: "Message", render: (delivery) => <span className="line-clamp-2 max-w-sm font-bold text-ink">{delivery.subject}</span> },
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

  const retryCount = history.deliveries.filter((delivery) => delivery.canRetry).length;
  const sentCount = history.deliveries.filter((delivery) => delivery.status === "sent").length;
  const movingCount = history.deliveries.filter((delivery) => ["queued", "claimed", "retry"].includes(delivery.status)).length;

  return (
    <div className="relative -mx-4 -my-6 min-h-full overflow-hidden bg-canvas px-4 py-6 text-ink sm:-mx-6 sm:-my-8 sm:px-6 sm:py-8 lg:-mx-8 lg:-my-10 lg:px-8 lg:py-10">
      <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(#b9b1a1_1px,transparent_1px),linear-gradient(90deg,#b9b1a1_1px,transparent_1px)] [background-size:36px_36px]" aria-hidden="true" />
      <div className="relative">
      <PageHeader
        title={(
          <>
            <span className="mb-3 block text-[11px] font-black uppercase tracking-[0.2em] text-production-lime">Outbound / cue desk</span>
            <span className="block">Speaker communications</span>
          </>
        )}
        description={`Draft human outreach for ${event.name}, or explicitly authorize automated delivery after reviewing the exact audience.`}
        className="border-[3px] border-line-strong bg-ink p-5 text-on-accent shadow-[7px_7px_0_#7857ff] sm:p-7 [&_h1]:text-4xl [&_h1]:font-black [&_h1]:uppercase [&_h1]:leading-[0.88] [&_h1]:tracking-[-0.055em] [&_h1]:text-on-accent sm:[&_h1]:text-5xl [&_p]:mt-4 [&_p]:max-w-2xl [&_p]:font-semibold [&_p]:text-on-accent/70"
        actions={(
          <div className="border-2 border-line-strong bg-production-lime px-4 py-3 text-ink shadow-[4px_4px_0_#fffdf7]">
            <p className="text-3xl font-black leading-none tracking-[-0.06em]">{eligibleRecipients.length}</p>
            <p className="mt-1 text-[9px] font-black uppercase tracking-[0.14em]">Speakers on comms</p>
            <p className="mt-2 text-[9px] font-black uppercase tracking-[0.12em] opacity-70">{history.localCaptureCount} local captures</p>
          </div>
        )}
      />

      <dl className="-mt-3 mb-8 ml-3 grid max-w-4xl grid-cols-2 border-2 border-line-strong bg-surface shadow-[5px_5px_0_#171714] md:grid-cols-4" aria-label="Communications production totals">
        {[
          [String(templates.length).padStart(2, "0"), "Message templates", "bg-surface-muted"],
          [String(eligibleRecipients.length).padStart(2, "0"), "Audience ready", "bg-surface-muted"],
          [String(history.deliveries.length).padStart(2, "0"), "Delivery records", "bg-surface-muted"],
          [String(retryCount).padStart(2, "0"), "Needs a retry", retryCount > 0 ? "bg-production-yellow" : "bg-surface-muted"],
        ].map(([value, label, color], index) => (
          <div className={`px-4 py-3 ${color} ${index % 2 > 0 ? "border-l-2 border-line-strong" : ""} ${index >= 2 ? "border-t-2 border-line-strong md:border-t-0" : ""} ${index === 2 ? "md:border-l-2" : ""}`} key={label}>
            <dd className="text-2xl font-black leading-none tracking-[-0.055em] sm:text-3xl">{value}</dd>
            <dt className="mt-1.5 text-[9px] font-black uppercase tracking-[0.13em]">{label}</dt>
          </div>
        ))}
      </dl>

      <Tabs tabs={tabs} active={activeTab} onChange={(value) => setActiveTab(value as WorkspaceTab)} className="mb-7 max-w-3xl" />

      {loadError && (
        <Alert tone="danger" className="mb-6">
          <AlertTitle>Communications data is unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {activeTab === "templates" && (
        <div id="comms-templates" role="tabpanel" aria-labelledby="comms-templates-tab" className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Card
            className="h-fit rounded-none [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink"
            title="Template roll"
            footer={<Button variant="secondary" className="w-full rounded-none bg-production-lime" onClick={() => { setDraft(emptyDraft); setPreview(null); }}>+ New template</Button>}
          >
            {templates.length === 0 ? (
              <p className="text-sm text-ink-faint">Create the first reusable message.</p>
            ) : (
              <div className="space-y-3">
                {templates.map((template, index) => (
                  <Button
                    key={template.id}
                    variant="ghost"
                    aria-current={draft.id === template.id ? "page" : undefined}
                    className={`h-auto w-full justify-start whitespace-normal rounded-none border-2 border-line-strong px-3 py-3 text-left shadow-[3px_3px_0_#171714] ${draft.id === template.id ? "bg-accent text-ink hover:bg-accent-hover hover:text-ink" : "bg-canvas hover:bg-production-lime"}`}
                    onClick={() => { setDraft(asDraft(template)); setPreview(null); }}
                  >
                    <span className="grid w-full grid-cols-[2rem_minmax(0,1fr)] gap-2">
                      <span className={`text-[10px] font-black tracking-[0.1em] ${draft.id === template.id ? "text-ink" : "text-accent-deep"}`}>{String(index + 1).padStart(2, "0")}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-black tracking-[-0.015em]">{template.name}</span>
                        <span className={`mt-1 block text-[10px] font-bold uppercase tracking-[0.08em] ${draft.id === template.id ? "text-ink" : "text-ink-faint"}`}>V{template.version}{template.attachIcs ? " · Calendar ready" : " · Message only"}</span>
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </Card>

          <div className="space-y-6">
            <Card className="rounded-none [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title={draft.id ? `Edit / ${draft.name || "template"}` : "New message master"}>
              <form className="space-y-4" onSubmit={(event_) => void saveTemplate(event_)}>
                <div className="grid gap-4 md:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
                  <Input label="Template name" value={draft.name} maxLength={120} onChange={(event_) => setDraft({ ...draft, name: event_.target.value })} required />
                  <Input
                    label="Subject line"
                    value={draft.subject}
                    maxLength={240}
                    onChange={(event_) => setDraft({ ...draft, subject: event_.target.value })}
                    required
                  />
                </div>
                <div className="border-l-4 border-production-coral bg-surface-muted px-4 py-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink">Available merge cues</p>
                  <p className="mt-1 break-words text-xs font-semibold leading-relaxed text-ink-faint">{"{{speaker.name}}, {{speaker.email}}, {{event.name}}, {{event.location}}, {{event.dates}}, {{talk.title}}, {{talk.time}}, {{talk.room}}, {{portal.url}}"}</p>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Textarea
                    label="Plain-text message"
                    value={draft.textBody}
                    rows={12}
                    maxLength={20_000}
                    hint="Personalized independently and stored immutably with each delivery."
                    onChange={(event_) => setDraft({ ...draft, textBody: event_.target.value })}
                    required
                  />
                  <Textarea
                    label="HTML message"
                    value={draft.htmlBody}
                    rows={12}
                    maxLength={20_000}
                    hint="Markup is retained; merge values are escaped before the snapshot is committed."
                    onChange={(event_) => setDraft({ ...draft, htmlBody: event_.target.value })}
                    required
                  />
                </div>
                <div className="border-2 border-line-strong bg-production-yellow p-4 shadow-[3px_3px_0_#171714]">
                  <Checkbox
                    checked={draft.attachIcs}
                    onChange={(event_) => setDraft({ ...draft, attachIcs: event_.target.checked })}
                    label="Attach schedule invite"
                    description="Uses the selected speaker's confirmed agenda talks and rooms; enqueue rejects missing agenda data."
                  />
                </div>
                <div className="flex flex-wrap items-end gap-3 border-t-2 border-line-strong pt-5">
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
              <Card className="rounded-none [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Local proof / not sent" footer={<span className="text-xs font-semibold text-ink-faint">{preview.note}</span>}>
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
                  <div className="grid border-2 border-line-strong bg-surface-muted sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <p className="border-b-2 border-line-strong bg-production-sky px-4 py-3 text-[10px] font-black uppercase tracking-[0.12em] text-ink sm:border-b-0 sm:border-r-2">To / recipient</p>
                    <p className="border-b-2 border-line-strong px-4 py-3 text-sm font-bold text-ink sm:col-start-2">{preview.recipientName} &lt;{preview.recipientEmail}&gt;</p>
                    <p className="border-b-2 border-line-strong bg-production-lime px-4 py-3 text-[10px] font-black uppercase tracking-[0.12em] text-ink sm:border-b-0 sm:border-r-2">Subject</p>
                    <p className="px-4 py-3 font-black tracking-[-0.015em] text-ink">{preview.subject}</p>
                  </div>
                  <div className="whitespace-pre-wrap border-2 border-line-strong bg-surface p-5 text-sm font-medium leading-7 text-ink-secondary shadow-[4px_4px_0_#171714]">{preview.text}</div>
                  {preview.mode === "acceptedSpeaker" && (
                    <div className="space-y-3 border-2 border-line-strong bg-surface-muted p-4 shadow-[4px_4px_0_#171714]">
                      <div>
                        <p className="text-sm font-semibold text-ink">Assisted chase</p>
                        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                          Open this personalized draft in your own mail app. Nothing is sent by Session Party.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          onClick={() => window.location.assign(buildMailtoDraft(preview))}
                        >
                          Open in my mail app
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            void navigator.clipboard.writeText(`Subject: ${preview.subject}\n\n${preview.text}`).then(
                              () => toast("Draft copied", { tone: "success" }),
                              () => toast("Draft could not be copied", { tone: "danger" }),
                            );
                          }}
                        >
                          Copy draft
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {activeTab === "send" && (
        <div id="comms-send" role="tabpanel" aria-labelledby="comms-send-tab" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card className="rounded-none [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Audience manifest / accepted speakers">
            {audience.recipients.length === 0 ? (
              <EmptyState title="No accepted speakers yet" description="Audience selection activates from the append-only acceptance contract." />
            ) : (
              <div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-2 border-line-strong bg-ink p-3 text-on-accent">
                  <p className="text-[10px] font-black uppercase tracking-[0.14em]">{selectedCount} selected / {eligibleRecipients.length} ready</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setSelectedSpeakers(new Set(eligibleRecipients.map((recipient) => recipient.speakerId)))}>Select ready</Button>
                    <Button size="sm" variant="ghost" className="text-on-accent hover:bg-on-accent/15 hover:text-on-accent" disabled={selectedCount === 0} onClick={() => setSelectedSpeakers(new Set())}>Clear</Button>
                  </div>
                </div>
                <div className="divide-y-2 divide-line-strong border-2 border-line-strong">
                {audience.recipients.map((recipient, index) => (
                  <div key={recipient.speakerId} className="grid gap-3 bg-surface px-4 py-4 transition-colors hover:bg-production-sky/25 sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(8rem,0.6fr)] sm:items-start">
                    <span className="text-xs font-black tracking-[0.12em] text-accent-deep" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
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
                    <div className="ml-[3.25rem] sm:ml-0 sm:text-right">
                      <Badge tone={recipient.eligibility === "eligible" ? "success" : "warning"}>
                        {recipient.eligibility === "eligible" ? "Ready" : "Missing email"}
                      </Badge>
                      <p className="mt-1 text-xs text-ink-faint">{recipient.sessionTitles.join(" · ")}</p>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            )}
          </Card>

          <div className="space-y-6 xl:sticky xl:top-4 xl:self-start">
            <Card className="rounded-none [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Automated delivery (opt in)">
              <div className="space-y-4">
                <Alert tone="neutral">
                  <AlertTitle>Decisions do not send messages</AlertTitle>
                  <AlertDescription>
                    Acceptance and rejection remain internal until an organizer deliberately authorizes this exact audience and template.
                  </AlertDescription>
                </Alert>
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
                <div className="grid grid-cols-[1fr_auto] border-2 border-line-strong bg-production-lime shadow-[4px_4px_0_#171714]">
                  <div className="p-4">
                    <p className="text-[10px] font-black uppercase tracking-[0.13em] text-ink-secondary">Confirmed recipients</p>
                    <p className="mt-2 text-xs font-bold text-ink-secondary">Immutable, personalized snapshots</p>
                  </div>
                  <p className="grid min-w-20 place-items-center border-l-2 border-line-strong px-4 text-5xl font-black tracking-[-0.07em] text-ink">{selectedCount}</p>
                </div>
                <Checkbox
                  checked={automatedDeliveryConfirmed}
                  onChange={(event_) => setAutomatedDeliveryConfirmed(event_.target.checked)}
                  label="Authorize Session Party to send"
                  description="I reviewed the selected template, recipients, reply-to address, and delivery time."
                />
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button className="w-full" loading={busy === "enqueue"} disabled={!automatedDeliveryConfirmed || !selectedTemplate || selectedCount === 0 || (sendMode === "scheduled" && scheduledWallTime === "")}>
                      {sendMode === "scheduled" ? "Schedule immutable deliveries" : "Queue immutable deliveries"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{sendMode === "scheduled" ? "Schedule" : "Queue"} {selectedCount} deliveries?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This creates immutable, personalized snapshots for {selectedCount} selected {selectedCount === 1 ? "recipient" : "recipients"} using “{selectedTemplate?.name}”. {sendMode === "scheduled" ? `Dispatch is scheduled for ${scheduledWallTime} in ${event.timezone}.` : "Scheduler dispatch is requested immediately after the outbox commit."}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Review recipients</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void enqueue()}>{sendMode === "scheduled" ? "Schedule deliveries" : "Queue deliveries"}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
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
          <dl className="grid grid-cols-3 border-2 border-line-strong bg-surface shadow-[4px_4px_0_#171714]" aria-label="Delivery status totals">
            {[
              [String(sentCount).padStart(2, "0"), "Sent / captured", "bg-surface-muted"],
              [String(movingCount).padStart(2, "0"), "In motion", "bg-surface-muted"],
              [String(retryCount).padStart(2, "0"), "Action needed", "bg-production-coral"],
            ].map(([value, label, color], index) => (
              <div className={`p-4 ${color} ${index > 0 ? "border-l-2 border-line-strong" : ""}`} key={label}>
                <dd className="text-3xl font-black leading-none tracking-[-0.055em]">{value}</dd>
                <dt className="mt-1.5 text-[9px] font-black uppercase tracking-[0.12em]">{label}</dt>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-4 border-2 border-line-strong bg-ink p-4 text-on-accent shadow-[4px_4px_0_#7857ff] sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-production-lime">Durable evidence log</p>
              <p className="mt-1 text-sm font-semibold text-on-accent/70">Snapshot, provider, attempt, and dead-letter truth from the mail tables.</p>
            </div>
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
      </div>
    </div>
  );
}
