import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Schema } from "effect";
import type { ApiScope } from "contracts/principal";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger, Badge, Button, Card, EmptyState, Input, PageHeader, Select, Skeleton, Table, Textarea, Toaster, toast } from "@/ui";
import {
  AddEventMemberOutput,
  CreateEventApiKeyOutput,
  EventApiKey,
  EventMember,
  EventOutput,
  RemoveEventMemberOutput,
  UpdateEventInput,
  UpdateEventMemberOutput,
  type EventMember as EventMemberRecord,
  type EventApiKey as EventApiKeyRecord,
  type EventOutput as EventMetadata,
  type UpdateEventInput as EventPatch,
} from "../schema";

export const path = "/e/:eventSlug/settings";
export const contentWidth = "compact" as const;

export type EventLoadError =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly message: string };

interface EventFormValues {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly location: string;
  readonly timezone: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly accentColor: string;
}

export function fetchEventMetadata(eventSlug: string): Promise<EventMetadata> {
  return apiFetch<EventMetadata>(`/api/v1/events/${encodeURIComponent(eventSlug)}`, { schema: EventOutput });
}

export function updateEventMetadata(eventId: string, patch: EventPatch): Promise<EventMetadata> {
  return apiFetch<EventMetadata>(`/api/v1/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: patch,
    schema: EventOutput,
  });
}

const idempotencyKey = () => crypto.randomUUID();

export function fetchEventMembers(eventId: string): Promise<readonly EventMemberRecord[]> {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/members`, { schema: Schema.Array(EventMember) });
}

export async function fetchCurrentUserId(): Promise<string> {
  const response = await apiFetch<{ readonly user?: { readonly userId?: string }; readonly userId?: string }>("/api/v1/auth/me");
  const userId = response.user?.userId ?? response.userId;
  if (!userId) throw new Error("The current session did not identify its user");
  return userId;
}

export function canManageMember(
  actorRole: EventMemberRecord["role"] | null,
  targetRole: EventMemberRecord["role"],
): boolean {
  return actorRole === "owner" || (actorRole === "admin" && targetRole === "reviewer");
}

async function addExistingMember(eventId: string, email: string, role: EventMemberRecord["role"]) {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/members`, {
    method: "POST", body: { email, role, idempotencyKey: idempotencyKey() }, schema: AddEventMemberOutput,
  });
}

async function changeMemberRole(eventId: string, member: EventMemberRecord, role: EventMemberRecord["role"]) {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/members/${encodeURIComponent(member.id)}`, {
    method: "PATCH", body: { role, expectedVersion: member.version, idempotencyKey: idempotencyKey() }, schema: UpdateEventMemberOutput,
  });
}

async function removeMember(eventId: string, member: EventMemberRecord) {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/members/${encodeURIComponent(member.id)}`, {
    method: "DELETE", body: { expectedVersion: member.version, idempotencyKey: idempotencyKey() }, schema: RemoveEventMemberOutput,
  });
}

export function fetchEventApiKeys(eventId: string): Promise<readonly EventApiKeyRecord[]> {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/api-keys`, { schema: Schema.Array(EventApiKey) });
}

export function createEventApiKey(
  eventId: string,
  input: { readonly name: string; readonly scopes: readonly [ApiScope, ...ApiScope[]]; readonly expiresAt: number },
) {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/api-keys`, {
    method: "POST", body: input, schema: CreateEventApiKeyOutput,
  });
}

export function revokeEventApiKey(eventId: string, apiKey: EventApiKeyRecord) {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/api-keys/${encodeURIComponent(apiKey.id)}`, {
    method: "DELETE", body: { expectedVersion: apiKey.version }, schema: EventApiKey,
  });
}

const allApiScopes = [
  "event:read", "event:write", "forms:read", "forms:write", "submissions:read", "submissions:write",
  "speakers:read", "speakers:write", "reviews:read", "reviews:write", "agenda:read", "agenda:write",
  "communications:read", "communications:write", "content:read", "content:write",
  "integrations:read", "integrations:write", "audit:read",
] as const satisfies readonly ApiScope[];

export const apiKeyPresets = {
  read: {
    label: "Read-only assistant",
    description: "Inspect the event, program, speakers, agenda, communications, content, integrations, and audit trail.",
    scopes: allApiScopes.filter((scope) => scope.endsWith(":read")) as [ApiScope, ...ApiScope[]],
  },
  agenda: {
    label: "Agenda automation",
    description: "Read event and speaker context, schedule talks, and publish the agenda.",
    scopes: ["event:read", "speakers:read", "agenda:read", "agenda:write"] as const,
  },
  onboarding: {
    label: "Speaker onboarding",
    description: "Read submissions and manage organizer-owned speaker onboarding workflows.",
    scopes: ["event:read", "submissions:read", "speakers:read", "speakers:write", "content:read"] as const,
  },
  full: {
    label: "Full organizer automation",
    description: "Grant every available event API scope. Use only for a trusted integration that needs the entire workflow.",
    scopes: allApiScopes,
  },
} as const;

type ApiKeyPreset = keyof typeof apiKeyPresets;

const copyText = async (value: string, label: string) => {
  await navigator.clipboard.writeText(value);
  toast(`${label} copied.`, { tone: "success" });
};

export interface ApiAccessPanelProps {
  readonly eventId: string;
  readonly initialApiKeys?: readonly EventApiKeyRecord[];
}

export function ApiAccessPanel({ eventId, initialApiKeys }: ApiAccessPanelProps) {
  const [apiKeys, setApiKeys] = useState<readonly EventApiKeyRecord[] | null>(initialApiKeys ?? null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<ApiKeyPreset>("read");
  const [lifetimeDays, setLifetimeDays] = useState("90");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ readonly apiKey: EventApiKeyRecord; readonly secret: string } | null>(null);

  const refresh = () => {
    setApiKeys(null);
    void fetchEventApiKeys(eventId).then(setApiKeys).catch((cause) => {
      setApiKeys([]);
      setError(cause instanceof Error ? cause.message : "Could not load API keys");
    });
  };

  useEffect(() => {
    if (initialApiKeys === undefined) refresh();
  }, [eventId]);

  const handleCreate = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    setError(null);
    setCreated(null);
    setCreating(true);
    try {
      const selected = apiKeyPresets[preset];
      const result = await createEventApiKey(eventId, {
        name,
        scopes: [...selected.scopes] as [ApiScope, ...ApiScope[]],
        expiresAt: Date.now() + Number(lifetimeDays) * 24 * 60 * 60_000,
      });
      setName("");
      setCreated(result);
      setApiKeys((current) => [result.apiKey, ...(current ?? [])]);
      toast("API key created. Copy the secret now.", { tone: "success" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not create API key";
      setError(message);
      toast(message, { tone: "danger" });
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (apiKey: EventApiKeyRecord) => {
    setError(null);
    setRevokingId(apiKey.id);
    try {
      const revoked = await revokeEventApiKey(eventId, apiKey);
      setApiKeys((current) => current?.map((item) => item.id === revoked.id ? revoked : item) ?? [revoked]);
      if (created?.apiKey.id === revoked.id) setCreated(null);
      toast("API key revoked.", { tone: "success" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not revoke API key";
      setError(message);
      toast(message, { tone: "danger" });
      refresh();
    } finally {
      setRevokingId(null);
    }
  };

  const origin = typeof window === "undefined" ? "https://sessionparty.example" : window.location.origin;
  const endpoint = `${origin}/mcp`;
  const clientConfig = created ? JSON.stringify({
    mcpServers: {
      "session-party": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${created.secret}` } },
    },
  }, null, 2) : "";

  return (
    <Card className="[&>header]:bg-production-lime [&>header_h3]:text-ink" title="MCP & API access">
      <p className="text-sm text-ink-secondary">
        Connect trusted organizer automation to this event. Every key is event-bound, expiring, and limited to the selected scopes; speaker self-service stays in the browser portal.
      </p>
      <div className="mt-4 border-2 border-line-strong bg-surface-muted p-4">
        <p className="text-[11px] font-black uppercase tracking-[0.08em]">MCP endpoint</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto bg-surface px-3 py-2 text-xs" tabIndex={0}>{endpoint}</code>
          <Button type="button" size="sm" variant="secondary" onClick={() => void copyText(endpoint, "Endpoint")}>Copy endpoint</Button>
        </div>
      </div>

      <form className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,1fr)_10rem_auto] lg:items-end" onSubmit={handleCreate}>
        <Input label="Key name" required maxLength={120} value={name} placeholder="Production assistant" onChange={(change) => setName(change.target.value)} />
        <Select label="Access preset" value={preset} onChange={(change) => setPreset(change.target.value as ApiKeyPreset)}>
          {Object.entries(apiKeyPresets).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
        </Select>
        <Select label="Expires in" value={lifetimeDays} onChange={(change) => setLifetimeDays(change.target.value)}>
          <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option>
        </Select>
        <Button type="submit" loading={creating} className="min-h-11">Create key</Button>
      </form>
      <p className="mt-2 text-xs text-ink-faint">{apiKeyPresets[preset].description}</p>
      <div className="mt-2 flex flex-wrap gap-1" aria-label="Selected API scopes">
        {apiKeyPresets[preset].scopes.map((scope) => <Badge key={scope}>{scope}</Badge>)}
      </div>
      {error ? <p role="alert" className="mt-4 text-sm font-bold text-danger">{error}</p> : null}

      {created ? (
        <div className="mt-5 border-2 border-line-strong bg-warning-soft p-4 shadow-[4px_4px_0_#171714]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="font-black">Copy this secret now</p><p className="text-sm text-ink-secondary">It will not be shown again after you dismiss or leave this page.</p></div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreated(null)}>Dismiss</Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto bg-surface px-3 py-2 text-xs" data-testid="api-key-secret" tabIndex={0}>{created.secret}</code>
            <Button type="button" size="sm" variant="secondary" onClick={() => void copyText(created.secret, "Secret")}>Copy secret</Button>
          </div>
          <p className="mt-4 text-[11px] font-black uppercase tracking-[0.08em]">Client configuration</p>
          <pre className="mt-2 max-h-64 overflow-auto bg-[#171714] p-3 text-xs text-white"><code>{clientConfig}</code></pre>
          <Button type="button" size="sm" className="mt-3" onClick={() => void copyText(clientConfig, "Client configuration")}>Copy configuration</Button>
        </div>
      ) : null}

      <div className="mt-6">
        <h4 className="text-sm font-black">Event keys</h4>
        {apiKeys === null ? <div className="mt-3"><Skeleton className="h-28" /></div> : (
          <div className="mt-3">
            <Table
              columns={[
                { key: "name", header: "Key", render: (key: EventApiKeyRecord) => <span>{key.name}<span className="block text-xs text-ink-faint">Created {key.createdAt.toLocaleDateString()}</span></span> },
                { key: "scopes", header: "Scopes", render: (key: EventApiKeyRecord) => <span className="text-xs">{key.scopes.join(", ")}</span> },
                { key: "status", header: "Status", render: (key: EventApiKeyRecord) => <Badge>{key.revokedAt ? "Revoked" : key.expiresAt.getTime() <= Date.now() ? "Expired" : "Active"}</Badge> },
                { key: "expires", header: "Expires", render: (key: EventApiKeyRecord) => key.expiresAt.toLocaleDateString() },
                { key: "actions", header: "Manage", render: (key: EventApiKeyRecord) => key.revokedAt ? null : <Button type="button" size="sm" variant="ghost" loading={revokingId === key.id} onClick={() => void handleRevoke(key)}>Revoke</Button> },
              ]}
              rows={[...apiKeys]}
              rowKey={(key) => key.id}
              empty="No API keys yet. Create a least-privilege key when an organizer integration needs one."
            />
          </div>
        )}
      </div>
    </Card>
  );
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function wallTimeParts(value: Date, timezone: string): WallTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
    millisecond: part("fractionalSecond"),
  };
}

function serializedWallTime(parts: WallTime): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.millisecond, 3)}`;
}

export function formatDateTimeForTimezone(value: Date | null, timezone: string): string {
  return value === null ? "" : serializedWallTime(wallTimeParts(value, timezone));
}

export function parseDateTimeInTimezone(value: string, timezone: string, label: string): number | null {
  if (value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) throw new Error(`${label} must be a valid date and time.`);
  const requested: WallTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
  };
  const wallTimeAsUtc = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
    requested.millisecond,
  );
  const normalized = new Date(wallTimeAsUtc);
  if (
    normalized.getUTCFullYear() !== requested.year ||
    normalized.getUTCMonth() + 1 !== requested.month ||
    normalized.getUTCDate() !== requested.day ||
    normalized.getUTCHours() !== requested.hour ||
    normalized.getUTCMinutes() !== requested.minute ||
    normalized.getUTCSeconds() !== requested.second
  ) {
    throw new Error(`${label} must be a valid date and time.`);
  }

  let instant = wallTimeAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = new Date(instant);
    const zoned = wallTimeParts(candidate, timezone);
    const candidateWithoutMilliseconds = Math.trunc(candidate.getTime() / 1000) * 1000;
    const offset =
      Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second) -
      candidateWithoutMilliseconds;
    instant = wallTimeAsUtc - offset;
  }

  if (serializedWallTime(wallTimeParts(new Date(instant), timezone)) !== serializedWallTime(requested)) {
    throw new Error(`${label} does not exist in ${timezone} because of a timezone transition.`);
  }
  return instant;
}

export function buildEventPatch(values: EventFormValues, originalEvent?: EventMetadata): EventPatch {
  const timezone = values.timezone.trim();
  const dateValue = (value: string, original: Date | null, label: string) => {
    if (
      originalEvent &&
      original &&
      timezone === originalEvent.timezone &&
      value === formatDateTimeForTimezone(original, originalEvent.timezone)
    ) {
      return original.getTime();
    }
    return parseDateTimeInTimezone(value, timezone, label);
  };
  const patch = {
    expectedVersion: originalEvent?.version ?? 1,
    name: values.name.trim(),
    slug: values.slug,
    description: values.description === "" ? null : values.description,
    location: values.location === "" ? null : values.location,
    timezone,
    startsAt: dateValue(values.startsAt, originalEvent?.startsAt ?? null, "Start"),
    endsAt: dateValue(values.endsAt, originalEvent?.endsAt ?? null, "End"),
    accentColor: values.accentColor === "" ? null : values.accentColor,
  };

  if (patch.startsAt !== null && patch.endsAt !== null && patch.endsAt < patch.startsAt) {
    throw new Error("End must be at or after start.");
  }

  try {
    return Schema.decodeUnknownSync(UpdateEventInput)(patch);
  } catch {
    throw new Error("Enter a name, a valid lowercase slug, and a timezone before saving.");
  }
}

function valuesFromEvent(event: EventMetadata): EventFormValues {
  return {
    name: event.name,
    slug: event.slug,
    description: event.description ?? "",
    location: event.location ?? "",
    timezone: event.timezone,
    startsAt: formatDateTimeForTimezone(event.startsAt, event.timezone),
    endsAt: formatDateTimeForTimezone(event.endsAt, event.timezone),
    accentColor: event.accentColor ?? "",
  };
}

function LoadingRegion() {
  return (
    <>
      <div role="status" aria-live="polite" aria-label="Loading event settings">
        <span className="sr-only">Loading event settings</span>
        <div className="space-y-5">
          <Skeleton className="h-20 motion-reduce:animate-none" />
          <Skeleton className="h-[38rem] motion-reduce:animate-none" />
        </div>
      </div>
      <Toaster />
    </>
  );
}

export interface EventSettingsPageProps {
  /** Seeds server-rendered route states in focused tests; production starts in loading. */
  readonly initialEvent?: EventMetadata | null;
  readonly initialLoadError?: EventLoadError | null;
  readonly initialSaveError?: string | null;
}

export default function EventSettingsPage({
  initialEvent,
  initialLoadError = null,
  initialSaveError = null,
}: EventSettingsPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventMetadata | null | undefined>(initialEvent);
  const [loadError, setLoadError] = useState<EventLoadError | null>(initialLoadError);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setEvent(undefined);
    setLoadError(null);
    void fetchEventMetadata(eventSlug)
      .then((loaded) => {
        if (!active) return;
        setEvent(loaded);
      })
      .catch((error) => {
        if (!active) return;
        setEvent(null);
        if (error instanceof ApiError && error.status === 401) {
          setLoadError({ kind: "unauthenticated" });
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setLoadError({ kind: "not-found" });
          return;
        }
        const message = error instanceof Error ? error.message : "Could not load event settings";
        setLoadError({ kind: "failed", message });
        toast(message, { tone: "danger" });
      });

    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  if (event === undefined) return <LoadingRegion />;

  if (event === null) {
    if (loadError?.kind === "unauthenticated") {
      return (
        <>
          <EmptyState
            headingLevel={1}
            title="Sign in to manage this event"
            description="Sign in to continue to this event's settings."
            action={
              <Button className="min-h-11" onClick={() => navigate(loginPathForLocation(location))}>
                Sign in
              </Button>
            }
          />
          <Toaster />
        </>
      );
    }

    const failed = loadError?.kind === "failed";
    return (
      <>
        <EmptyState
          headingLevel={1}
          title={failed ? "Could not load event settings" : "Event not found"}
          description={failed ? loadError.message : "The event may have moved or been removed."}
          action={
            failed ? (
              <Button className="min-h-11" onClick={() => setRequest((current) => current + 1)}>
                Try again
              </Button>
            ) : undefined
          }
        />
        <Toaster />
      </>
    );
  }

  const handleUnauthenticated = () => {
    setEvent(null);
    setLoadError({ kind: "unauthenticated" });
  };

  const handleSaved = (updated: EventMetadata) => {
    setEvent(updated);
    if (updated.slug !== eventSlug) {
      navigate(`/e/${encodeURIComponent(updated.slug)}/settings`, { replace: true });
    }
  };

  return (
    <>
      <PageHeader title="Event settings" description={`Manage persisted metadata for ${event.name}.`} />
      <EventSettingsForm
        key={`${event.id}:${event.version}`}
        event={event}
        initialSaveError={initialSaveError}
        onSaved={handleSaved}
        onUnauthenticated={handleUnauthenticated}
      />
      <Toaster />
    </>
  );
}

export interface EventSettingsFormProps {
  readonly event: EventMetadata;
  readonly initialSaveError?: string | null;
  readonly onSaved?: (event: EventMetadata) => void;
  readonly onUnauthenticated?: () => void;
}

export function EventSettingsForm({
  event,
  initialSaveError = null,
  onSaved,
  onUnauthenticated,
}: EventSettingsFormProps) {
  const [values, setValues] = useState<EventFormValues>(() => valuesFromEvent(event));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(initialSaveError);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [members, setMembers] = useState<readonly EventMemberRecord[] | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<EventMemberRecord["role"]>("reviewer");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberSaving, setMemberSaving] = useState(false);
  const [pendingRoles, setPendingRoles] = useState<Record<string, EventMemberRecord["role"]>>({});
  const [memberMutationId, setMemberMutationId] = useState<string | null>(null);

  const refreshMembers = () => {
    setMembers(null);
    void Promise.all([fetchEventMembers(event.id), fetchCurrentUserId()]).then(([nextMembers, userId]) => {
      setActorUserId(userId);
      setMembers(nextMembers);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Could not load event members";
      setMemberError(message);
      setActorUserId(null);
      setMembers([]);
    });
  };

  useEffect(() => { refreshMembers(); }, [event.id]);

  const setValue = (field: keyof EventFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    setSaveError(null);
    setSavedMessage(null);

    let patch: EventPatch;
    try {
      patch = buildEventPatch(values, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Check the event metadata and try again.";
      setSaveError(message);
      return;
    }

    setSaving(true);
    try {
      const updated = await updateEventMetadata(event.id, patch);
      setSavedMessage("Event settings saved.");
      toast("Event settings saved.", { tone: "success" });
      onSaved?.(updated);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && onUnauthenticated) {
        onUnauthenticated();
        return;
      }
      const message = error instanceof Error ? error.message : "Could not save event settings";
      setSaveError(message);
      toast(message, { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const handleMemberSubmit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    setMemberError(null);
    setMemberSaving(true);
    try {
      const result = await addExistingMember(event.id, memberEmail, memberRole);
      setMemberEmail("");
      setMembers((current) => current ? [...current.filter((member) => member.id !== result.member.id), result.member] : [result.member]);
      toast(result.created ? "Event member added." : "That account is already a member.", { tone: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add event member";
      setMemberError(message);
      toast(message, { tone: "danger" });
    } finally {
      setMemberSaving(false);
    }
  };

  const handleRoleChange = async (member: EventMemberRecord, role: EventMemberRecord["role"]) => {
    setMemberError(null);
    setMemberMutationId(member.id);
    try {
      const result = await changeMemberRole(event.id, member, role);
      setMembers((current) => current?.map((item) => item.id === result.member.id ? result.member : item) ?? [result.member]);
      setPendingRoles((current) => { const next = { ...current }; delete next[member.id]; return next; });
      toast("Member role updated.", { tone: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not change member role";
      setMemberError(message);
      toast(message, { tone: "danger" });
      refreshMembers();
    } finally {
      setMemberMutationId(null);
    }
  };

  const handleRemove = async (member: EventMemberRecord) => {
    setMemberError(null);
    setMemberMutationId(member.id);
    try {
      await removeMember(event.id, member);
      setMembers((current) => current?.filter((item) => item.id !== member.id) ?? []);
      toast("Event member removed.", { tone: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not remove event member";
      setMemberError(message);
      toast(message, { tone: "danger" });
      refreshMembers();
    } finally {
      setMemberMutationId(null);
    }
  };

  const actorRole = members?.find((member) => member.userId === actorUserId)?.role ?? null;
  const ownerCount = members?.filter((member) => member.role === "owner").length ?? 0;

  return (
    <div className="space-y-6">
    <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Event metadata">
      <form className="space-y-6" onSubmit={handleSubmit} aria-describedby={saveError ? "event-settings-error" : undefined}>
        {saveError ? (
          <div id="event-settings-error" role="alert" className="rounded-control border-2 border-line-strong bg-danger-soft px-3 py-2 text-sm font-bold text-danger shadow-[3px_3px_0_#171714]">
            {saveError}
          </div>
        ) : null}
        {savedMessage ? (
          <p role="status" aria-live="polite" className="border-2 border-line-strong bg-success-soft px-3 py-2 text-sm font-bold text-ink shadow-[3px_3px_0_#171714]">
            {savedMessage}
          </p>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          <Input label="Event name" value={values.name} required maxLength={200} onChange={(change) => setValue("name", change.target.value)} />
          <Input
            label="Event slug"
            value={values.slug}
            required
            minLength={2}
            maxLength={80}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            hint="Lowercase letters, numbers, and single hyphens."
            onChange={(change) => setValue("slug", change.target.value)}
          />
        </div>

        <Textarea label="Description" value={values.description} onChange={(change) => setValue("description", change.target.value)} />

        <div className="grid gap-5 md:grid-cols-2">
          <Input label="Location" value={values.location} onChange={(change) => setValue("location", change.target.value)} />
          <Input label="Timezone" value={values.timezone} required placeholder="America/Los_Angeles" onChange={(change) => setValue("timezone", change.target.value)} />
          <Input label="Starts at" type="datetime-local" step="0.001" value={values.startsAt} onChange={(change) => setValue("startsAt", change.target.value)} />
          <Input label="Ends at" type="datetime-local" step="0.001" value={values.endsAt} onChange={(change) => setValue("endsAt", change.target.value)} />
          <Input
            label="Accent color"
            value={values.accentColor}
            placeholder="#2563eb"
            hint="Optional event accent value."
            onChange={(change) => setValue("accentColor", change.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} className="min-h-11">
            Save settings
          </Button>
        </div>
      </form>
    </Card>
    <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Event members">
      <p className="mb-4 text-sm text-ink-secondary">Add people who have already signed in. This does not send an invitation email.</p>
      <form className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end" onSubmit={handleMemberSubmit}>
        <Input
          label="Existing account email"
          type="email"
          required
          value={memberEmail}
          placeholder="reviewer@example.com"
          hint="The person must have authenticated with SessionParty first."
          onChange={(change) => setMemberEmail(change.target.value)}
        />
        <Select label="Role" value={memberRole} onChange={(change) => setMemberRole(change.target.value as EventMemberRecord["role"])}>
          <option value="reviewer">Reviewer</option>
          {actorRole === "owner" ? <option value="admin">Admin</option> : null}
          {actorRole === "owner" ? <option value="owner">Owner</option> : null}
        </Select>
        <Button type="submit" loading={memberSaving} className="min-h-11">Add member</Button>
      </form>
      {memberError ? <p role="alert" className="mt-4 text-sm text-danger">{memberError}</p> : null}
      {members === null ? (
        <div className="mt-5"><Skeleton className="h-36" /></div>
      ) : (
        <div className="mt-5">
          <Table
            columns={[
              { key: "person", header: "Person", render: (member: EventMemberRecord) => <span>{member.name ?? member.email}<span className="block text-xs text-ink-faint">{member.email}</span></span> },
              { key: "role", header: "Role", render: (member: EventMemberRecord) => <Badge>{member.role}</Badge> },
              { key: "actions", header: "Manage", render: (member: EventMemberRecord) => {
                const manageable = canManageMember(actorRole, member.role);
                const lastOwner = member.role === "owner" && ownerCount <= 1;
                if (!manageable) return <span className="text-xs text-ink-secondary">Owner access required</span>;
                return (
                  <div className="flex min-w-56 items-end gap-2">
                    {actorRole === "owner" ? (
                      <>
                        <Select aria-label={`Role for ${member.email}`} value={pendingRoles[member.id] ?? member.role} onChange={(change) => setPendingRoles((current) => ({ ...current, [member.id]: change.target.value as EventMemberRecord["role"] }))}>
                          <option value="reviewer" disabled={lastOwner}>Reviewer</option><option value="admin" disabled={lastOwner}>Admin</option><option value="owner">Owner</option>
                        </Select>
                        <AlertDialog>
                          <AlertDialogTrigger asChild><Button type="button" size="sm" disabled={!pendingRoles[member.id] || pendingRoles[member.id] === member.role} loading={memberMutationId === member.id}>Change role</Button></AlertDialogTrigger>
                          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Change {member.name ?? member.email} to {pendingRoles[member.id]}?</AlertDialogTitle><AlertDialogDescription>This changes {member.email} from {member.role} to {pendingRoles[member.id]}. Their event permissions change immediately.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep current role</AlertDialogCancel><AlertDialogAction onClick={() => void handleRoleChange(member, pendingRoles[member.id] ?? member.role)}>Change role</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
                        </AlertDialog>
                      </>
                    ) : null}
                    <AlertDialog>
                      <AlertDialogTrigger asChild><Button type="button" size="sm" variant="ghost" disabled={lastOwner} title={lastOwner ? "An event must retain at least one owner" : undefined} loading={memberMutationId === member.id}>Remove</Button></AlertDialogTrigger>
                      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {member.name ?? member.email}?</AlertDialogTitle><AlertDialogDescription>{member.email} will lose their {member.role} access to this event immediately.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep member</AlertDialogCancel><AlertDialogAction onClick={() => void handleRemove(member)}>Remove member</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
                    </AlertDialog>
                  </div>
                );
              } },
            ]}
            rows={[...members]}
            rowKey={(member) => member.id}
            empty="No additional members yet."
          />
        </div>
      )}
    </Card>
    <ApiAccessPanel eventId={event.id} />
    </div>
  );
}
