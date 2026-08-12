import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  AcceleventsImportRun,
  AcceleventsImportStatus,
  AirtableConfig,
  IntegrationConfig,
  type AcceleventsImportRun as AcceleventsImportRunType,
  type AcceleventsImportStatus as AcceleventsImportStatusType,
  type IntegrationConfig as IntegrationConfigType,
} from "contracts/types";
import { Schema } from "effect";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { acceleventsCapabilityLabel, configurationTruth } from "../presentation";
import {
  AcceleventsConfiguration,
  AirtableSyncStatus,
  ConfigureAcceleventsResult,
  ConfigureAirtableResult,
  type AcceleventsConfiguration as AcceleventsConfigurationType,
  type AirtableSyncStatus as AirtableSyncStatusType,
  type ConfigureAcceleventsResult as ConfigureAcceleventsResultType,
  type ConfigureAirtableResult as ConfigureAirtableResultType,
} from "../schema";
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
  EmptyState,
  Input,
  Separator,
  Skeleton,
  Textarea,
  Toaster,
  toast,
} from "@/ui";

export const path = "/e/:eventSlug/integrations";
export const contentWidth = "wide" as const;


function LoadingRegion({ label }: { readonly label: string }) {
  return (
    <>
      <div role="status" aria-live="polite" aria-label={label} className="space-y-5">
        <span className="sr-only">{label}</span>
        <Skeleton className="h-36 rounded-none motion-reduce:animate-none" />
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-[34rem] rounded-none motion-reduce:animate-none" />
          <Skeleton className="h-[34rem] rounded-none motion-reduce:animate-none" />
        </div>
      </div>
      <Toaster />
    </>
  );
}

function ProviderHeading({
  cue,
  name,
  configured,
}: {
  readonly cue: string;
  readonly name: string;
  readonly configured: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex items-center gap-3">
        <span className="grid size-8 place-items-center border-2 border-line-strong bg-surface text-[10px] font-black text-ink shadow-[2px_2px_0_#171714]">
          {cue}
        </span>
        <span className="text-base tracking-[-0.025em]">{name}</span>
      </span>
      <Badge className="bg-surface" tone={configured ? "success" : "neutral"}>
        {configured ? "Configured" : "Not configured"}
      </Badge>
    </div>
  );
}

function MappingTable({ configuration }: { readonly configuration: AirtableConfig }) {
  const tables = [
    { number: "01", entity: "Speakers", accent: "bg-surface-muted", configuration: configuration.tables.speakers },
    { number: "02", entity: "Submissions", accent: "bg-surface-muted", configuration: configuration.tables.submissions },
    { number: "03", entity: "Talks", accent: "bg-surface-muted", configuration: configuration.tables.talks },
  ] as const;

  return (
    <div className="space-y-5">
      <dl className="grid border-2 border-line-strong bg-surface text-sm sm:grid-cols-2">
        <div className="border-b-2 border-line-strong sm:border-b-0 sm:border-r-2">
          <dt className="bg-ink px-3 py-2 text-[9px] font-black uppercase tracking-[0.16em] text-production-sky">Destination base</dt>
          <dd className="break-all px-3 py-3 font-mono text-xs font-bold text-ink">{configuration.baseId}</dd>
        </div>
        <div>
          <dt className="bg-ink px-3 py-2 text-[9px] font-black uppercase tracking-[0.16em] text-production-lime">Mapping origin</dt>
          <dd className="break-all px-3 py-3 font-mono text-xs font-bold text-ink">{configuration.origin}</dd>
        </div>
      </dl>
      <div className="border-2 border-line-strong shadow-[4px_4px_0_#171714]">
        {tables.map(({ number, entity, accent, configuration: table }, tableIndex) => (
          <section
            className={tableIndex > 0 ? "border-t-2 border-line-strong" : undefined}
            key={entity}
            aria-labelledby={`airtable-${entity.toLowerCase()}`}
          >
            <div className={`grid grid-cols-[3.5rem_minmax(0,1fr)] border-b-2 border-line-strong ${accent}`}>
              <span className="grid place-items-center border-r-2 border-line-strong text-lg font-black tracking-[-0.04em]" aria-hidden="true">{number}</span>
              <div className="min-w-0 px-3 py-2.5">
                <h4 id={`airtable-${entity.toLowerCase()}`} className="text-sm font-black uppercase tracking-[0.1em] text-ink">
                  {entity}
                </h4>
                <code className="block truncate text-[10px] font-bold text-ink/70" title={table.tableId}>{table.tableId}</code>
              </div>
            </div>
            <dl className="grid bg-surface sm:grid-cols-2">
              {Object.entries(table.fields).map(([key, fieldId]) => (
                <div key={key} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line px-3 py-2 text-xs odd:bg-surface-muted sm:even:border-l sm:even:border-line sm:odd:bg-surface">
                  <dt className="capitalize font-semibold text-ink-secondary">
                    {key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}
                  </dt>
                  <dd className="max-w-[55%] truncate font-mono text-[10px] font-bold text-ink" title={fieldId}>{fieldId}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

function AirtableConfigEditor({
  eventSlug,
  status,
  onConfigured,
}: {
  readonly eventSlug: string;
  readonly status: AirtableSyncStatusType;
  readonly onConfigured: (result: ConfigureAirtableResultType) => void;
}) {
  const initial = status.configuration?.config ?? {
    kind: "airtable",
    baseId: "apphFjgebe5pq9gez",
    origin: "session-party",
    tables: {
      speakers: {
        tableId: "",
        fields: {
          sessionPartyId: "",
          spRevision: "",
          spHash: "",
          spOrigin: "",
          displayName: "",
          jobTitle: "",
          company: "",
          bio: "",
          visibility: "",
        },
      },
      submissions: {
        tableId: "",
        fields: {
          sessionPartyId: "",
          spRevision: "",
          spHash: "",
          spOrigin: "",
          title: "",
          abstract: "",
          category: "",
          status: "",
          submittedAt: "",
          speakerLinks: "",
        },
      },
      talks: {
        tableId: "",
        fields: {
          sessionPartyId: "",
          spRevision: "",
          spHash: "",
          spOrigin: "",
          title: "",
          description: "",
          track: "",
          room: "",
          startsAt: "",
          durationMin: "",
          status: "",
          speakerLinks: "",
          submissionLink: "",
        },
      },
    },
  };
  const [mapping, setMapping] = useState(() => JSON.stringify(initial, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (saving) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(mapping);
    } catch {
      setError("Mapping must be valid JSON");
      return;
    }
    const decoded = Schema.decodeUnknownEither(AirtableConfig)(parsed);
    if (decoded._tag === "Left") {
      setError("Mapping must include all three tables and their required physical field IDs");
      return;
    }
    setSaving(true);
    setError(null);
    void apiFetch<ConfigureAirtableResultType>(
      `/api/v1/events/${encodeURIComponent(eventSlug)}/integrations/airtable/configuration`,
      {
        method: "PUT",
        body: {
          config: decoded.right,
          expectedVersion: status.configuration?.version ?? 0,
          idempotencyKey: crypto.randomUUID(),
        },
        schema: ConfigureAirtableResult,
      },
    ).then((result) => {
      onConfigured(result);
      toast("Airtable mapping saved and sync lane woken", { tone: "success" });
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Could not save Airtable mapping";
      setError(message);
      toast(message, { tone: "danger" });
    }).finally(() => setSaving(false));
  };

  return (
    <section className="space-y-3" aria-labelledby="airtable-configuration">
      <h4 id="airtable-configuration" className="text-sm font-semibold text-ink">Configuration</h4>
      <p className="text-xs leading-relaxed text-ink-secondary">
        Map logical fields to Airtable <code>tbl…</code> and <code>fld…</code> IDs. The PAT stays in the Worker secret and is never accepted here.
      </p>
      <Textarea
        label="Airtable mapping JSON"
        rows={14}
        value={mapping}
        onChange={(event) => setMapping(event.target.value)}
        error={error ?? undefined}
        spellCheck={false}
        className="font-mono text-xs"
        disabled={saving}
      />
      <Button onClick={save} loading={saving}>
        {status.configuration ? "Save Airtable mapping" : "Configure Airtable"}
      </Button>
    </section>
  );
}

function AcceleventsConfigEditor({
  eventSlug,
  configuration,
  onConfigured,
}: {
  readonly eventSlug: string;
  readonly configuration: AcceleventsConfigurationType | null;
  readonly onConfigured: (result: ConfigureAcceleventsResultType) => void;
}) {
  const [source, setSource] = useState<"fixture" | "live">(configuration?.source ?? "fixture");
  const [accelEventId, setAccelEventId] = useState(configuration?.config.accelEventId ?? "fixture-event");
  const [eventUrl, setEventUrl] = useState(configuration?.config.eventUrl ?? "fixture-event");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectSource = (next: "fixture" | "live") => {
    setSource(next);
    if (next === "fixture") {
      setAccelEventId("fixture-event");
      setEventUrl("fixture-event");
    }
  };

  const save = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    void apiFetch<ConfigureAcceleventsResultType>(
      `/api/v1/events/${encodeURIComponent(eventSlug)}/integrations/accelevents/configuration`,
      {
        method: "PUT",
        body: {
          source,
          accelEventId,
          eventUrl,
          expectedVersion: configuration?.version ?? 0,
          idempotencyKey: crypto.randomUUID(),
        },
        schema: ConfigureAcceleventsResult,
      },
    ).then((result) => {
      onConfigured(result);
      toast(source === "fixture" ? "Fixture import configured" : "Live Accelevents mapping saved", { tone: "success" });
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Could not save Accelevents configuration";
      setError(message);
      toast(message, { tone: "danger" });
    }).finally(() => setSaving(false));
  };

  return (
    <section className="space-y-4" aria-labelledby="accelevents-configuration">
      <div className="border-l-4 border-production-coral pl-3">
        <p className="text-[9px] font-black uppercase tracking-[0.16em] text-ink-faint">Input rail / source control</p>
        <h4 id="accelevents-configuration" className="mt-0.5 text-xl font-black tracking-[-0.035em] text-ink">Configuration</h4>
      </div>
      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Accelevents source">
        <Button
          className={`h-auto min-h-16 justify-start rounded-none px-4 py-3 text-left ${source === "fixture" ? "bg-production-lime text-ink hover:bg-production-lime" : ""}`}
          variant="secondary"
          onClick={() => selectSource("fixture")}
          disabled={saving}
          aria-pressed={source === "fixture"}
        >
          <span className="text-lg" aria-hidden="true">01</span>
          <span><span className="block">Demo fixture</span><span className="mt-0.5 block text-[9px] opacity-65">No provider call</span></span>
        </Button>
        <Button
          className={`h-auto min-h-16 justify-start rounded-none px-4 py-3 text-left ${source === "live" ? "bg-production-sky text-ink hover:bg-production-sky" : ""}`}
          variant="secondary"
          onClick={() => selectSource("live")}
          disabled={saving}
          aria-pressed={source === "live"}
        >
          <span className="text-lg" aria-hidden="true">02</span>
          <span><span className="block">Live event</span><span className="mt-0.5 block text-[9px] opacity-65">Server-held token</span></span>
        </Button>
      </div>
      {source === "fixture" ? (
        <Alert tone="warning">
          <AlertTitle>Deterministic demo data</AlertTitle>
          <AlertDescription>This imports labeled fixture speakers and talks. It does not call Accelevents.</AlertDescription>
        </Alert>
      ) : (
        <div className="border-2 border-line-strong bg-production-sky/35 px-4 py-3 shadow-[3px_3px_0_#171714]">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-ink">Credential boundary</p>
          <p className="mt-1 text-xs font-semibold leading-relaxed text-ink-secondary">
            The live adapter uses the server-held <code>ACCELEVENTS_API_TOKEN</code>; this form never accepts or exposes credentials.
          </p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Accelevents event ID" value={accelEventId} onChange={(event) => setAccelEventId(event.target.value)} disabled={source === "fixture" || saving} />
        <Input label="Event URL key" value={eventUrl} onChange={(event) => setEventUrl(event.target.value)} disabled={source === "fixture" || saving} />
      </div>
      {error && <p className="border-l-4 border-danger pl-3 text-xs font-bold text-danger" role="alert">{error}</p>}
      <Button className="rounded-none" onClick={save} loading={saving}>
        {configuration ? "Save configuration" : "Configure Accelevents"}
      </Button>
    </section>
  );
}

function IntegrationsWorkspace({
  eventSlug,
  configurations,
  status,
  running,
  runResult,
  runError,
  configuration,
  airtableStatus,
  refreshingAirtable,
  onReload,
  onRun,
  onRefreshAirtable,
  onConfigured,
  onAirtableConfigured,
}: {
  readonly eventSlug: string;
  readonly configurations: readonly IntegrationConfigType[];
  readonly status: AcceleventsImportStatusType;
  readonly running: boolean;
  readonly runResult: AcceleventsImportRunType | null;
  readonly runError: string | null;
  readonly configuration: AcceleventsConfigurationType | null;
  readonly airtableStatus: AirtableSyncStatusType;
  readonly refreshingAirtable: boolean;
  readonly onReload: () => void;
  readonly onRun: () => void;
  readonly onRefreshAirtable: () => void;
  readonly onConfigured: (result: ConfigureAcceleventsResultType) => void;
  readonly onAirtableConfigured: (result: ConfigureAirtableResultType) => void;
}) {
  const truth = useMemo(() => configurationTruth(configurations), [configurations]);
  const airtable = configurations.find(
    (configuration): configuration is AirtableConfig => configuration.kind === "airtable",
  ) ?? airtableStatus.configuration?.config;
  const accelevents = status.config;
  const capability = acceleventsCapabilityLabel(status);
  const canRun = status.configured && status.capability.state === "ready";
  const latest = runResult ?? status.latestRun;
  const configuredCount = Number(truth.airtable) + Number(status.configured);

  return (
    <div className="relative -mx-4 -my-6 min-h-full overflow-hidden bg-canvas px-4 py-6 text-ink sm:-mx-6 sm:-my-8 sm:px-6 sm:py-8 lg:-mx-8 lg:-my-10 lg:px-8 lg:py-10">
      <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(#b9b1a1_1px,transparent_1px),linear-gradient(90deg,#b9b1a1_1px,transparent_1px)] [background-size:44px_44px]" aria-hidden="true" />

      <div className="relative">
        <header className="grid gap-5 border-[3px] border-line-strong bg-ink px-5 py-6 text-on-ink shadow-[8px_8px_0_#7857ff] sm:px-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-production-lime">External feeds / patch bay</p>
            <h1 className="text-4xl font-black leading-[0.88] tracking-[-0.055em] sm:text-6xl">Integrations</h1>
            <p className="mt-4 max-w-2xl text-sm font-semibold leading-relaxed text-on-ink/70 sm:text-[15px]">
              Bring external event data into the same production board without losing delivery truth.
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center lg:flex-col lg:items-end">
            <div className="border-2 border-on-accent bg-production-lime px-3 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-ink shadow-[4px_4px_0_#fffdf7]">
              {configuredCount} / 2 feeds patched
            </div>
            <Button className="border-on-accent bg-surface text-ink shadow-[4px_4px_0_#7857ff]" variant="secondary" onClick={onReload}>
              Reload status
            </Button>
          </div>
        </header>

        <dl className="mt-7 grid border-2 border-line-strong bg-surface shadow-[5px_5px_0_#171714] sm:grid-cols-3">
          {[
            ["01", "Airtable map", truth.airtable ? "Validated" : "Not configured", "bg-surface-muted"],
            ["02", "Accelevents adapter", capability, "bg-surface-muted"],
            ["03", "Latest import", latest?.status ?? "No completed run", "bg-surface-muted"],
          ].map(([number, label, value, color], index) => (
            <div className={`grid grid-cols-[3rem_1fr] ${color} ${index > 0 ? "border-t-2 border-line-strong sm:border-l-2 sm:border-t-0" : ""}`} key={label}>
              <dt className="grid place-items-center border-r-2 border-line-strong text-base font-black" aria-label={`Status ${number}`}>{number}</dt>
              <dd className="min-w-0 px-3 py-3">
                <span className="block text-[9px] font-black uppercase tracking-[0.13em] text-ink/65">{label}</span>
                <span className="mt-0.5 block truncate text-sm font-black capitalize tracking-[-0.015em] text-ink" title={value}>{value}</span>
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)]">
          <Card
            className="h-fit rounded-none shadow-[7px_7px_0_#171714] [&>div]:p-4 [&>header]:bg-surface-muted [&>header]:px-4 [&>header]:py-3 [&>header]:text-ink [&>header_h3]:text-ink sm:[&>div]:p-5"
            title={<ProviderHeading cue="A1" name="Airtable" configured={truth.airtable} />}
            footer={
              <div className="flex gap-3">
                <span className="mt-0.5 size-2.5 shrink-0 bg-production-lime" aria-hidden="true" />
                <p className="text-xs font-semibold leading-relaxed text-ink-secondary">
                  Credentials are held by secret reference and are never returned here.
                </p>
              </div>
            }
          >
            <div className="space-y-5">
              <dl className="grid border-2 border-line-strong bg-surface text-sm sm:grid-cols-2">
                <div className="border-b-2 border-line-strong sm:border-b-0 sm:border-r-2">
                  <dt className="bg-ink px-3 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-production-lime">Adapter</dt>
                  <dd className="px-3 py-2.5">
                    <Badge tone={airtableStatus.capability.state === "ready" ? airtableStatus.capability.mode === "live" ? "success" : "warning" : "danger"}>
                      {airtableStatus.capability.state === "ready"
                        ? airtableStatus.capability.mode === "live" ? "Live" : "Deterministic fake"
                        : "Unavailable"}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="bg-ink px-3 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-production-sky">Last confirmed</dt>
                  <dd className="px-3 py-3 text-xs font-semibold text-ink-secondary">
                    {airtableStatus.lastSyncedAt
                      ? new Date(airtableStatus.lastSyncedAt).toLocaleString()
                      : "Not synced yet"}
                  </dd>
                </div>
              </dl>
              {airtableStatus.capability.reason && (
                <Alert tone="warning">
                  <AlertTitle>Airtable unavailable</AlertTitle>
                  <AlertDescription>{airtableStatus.capability.reason}</AlertDescription>
                </Alert>
              )}
              {airtableStatus.lastError && (
                <Alert tone="danger">
                  <AlertTitle>Latest sync error</AlertTitle>
                  <AlertDescription>{airtableStatus.lastError}</AlertDescription>
                </Alert>
              )}
              {airtable ? (
                <>
                  <MappingTable configuration={airtable} />
                  <dl className="grid grid-cols-2 border-2 border-line-strong text-xs sm:grid-cols-3">
                    {[
                      ["Pending", airtableStatus.counts.pending],
                      ["Retrying", airtableStatus.counts.retrying],
                      ["Blocked", airtableStatus.counts.blocked],
                      ["Dead letters", airtableStatus.counts.deadLetters],
                      ["Pending edits", airtableStatus.counts.pendingEdits],
                      ["Conflicts", airtableStatus.counts.conflicts],
                    ].map(([label, value], index) => (
                      <div className={`px-2.5 py-3 ${index > 1 ? "border-t-2" : ""} ${index % 2 === 1 ? "border-l-2 sm:border-l-0" : ""} ${index % 3 !== 0 ? "sm:border-l-2" : ""}`} key={label}>
                        <dt className="text-[8px] font-black uppercase tracking-[0.1em] text-ink">{label}</dt>
                        <dd className="mt-1 text-lg font-black tracking-[-0.04em] text-ink">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <Button
                    variant="secondary"
                    onClick={onRefreshAirtable}
                    loading={refreshingAirtable}
                    disabled={airtableStatus.capability.state !== "ready"}
                  >
                    Refresh from Airtable
                  </Button>
                </>
              ) : (
                <EmptyState
                  title="Airtable is not configured"
                  description="No validated Airtable field map exists for this event."
                />
              )}
              <Separator />
              <AirtableConfigEditor
                key={`${airtableStatus.configuration?.version ?? 0}:${airtableStatus.configuration?.config.baseId ?? "new"}`}
                eventSlug={eventSlug}
                status={airtableStatus}
                onConfigured={onAirtableConfigured}
              />
            </div>
          </Card>

          <Card
          className="h-fit rounded-none shadow-[7px_7px_0_#171714] [&>div]:p-4 [&>header]:bg-surface-muted [&>header]:px-4 [&>header]:py-3 [&>header]:text-ink [&>header_h3]:text-ink sm:[&>div]:p-5"
          title={<ProviderHeading cue="A2" name="Accelevents" configured={status.configured} />}
          footer={
            <div className="flex gap-3">
              <span className="mt-0.5 size-2.5 shrink-0 bg-production-coral" aria-hidden="true" />
              <p className="text-xs font-semibold leading-relaxed text-ink-secondary">
                Live, fixture, and unavailable states come from the server runtime—not saved IDs.
              </p>
            </div>
          }
        >
          {accelevents ? (
            <div className="space-y-5">
              <dl className="grid border-2 border-line-strong bg-surface text-sm sm:grid-cols-[minmax(0,1fr)_7rem]">
                <div className="border-b-2 border-line-strong sm:border-b-0 sm:border-r-2">
                  <dt className="bg-ink px-3 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-production-coral">Event patch</dt>
                  <dd className="break-all px-3 py-3 font-mono text-xs font-bold text-ink">{accelevents.accelEventId}</dd>
                </div>
                <div>
                  <dt className="bg-ink px-3 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-production-lime">Adapter</dt>
                  <dd className="px-3 py-2.5">
                    <Badge tone={capability === "Live" ? "success" : capability === "Fixture" ? "warning" : "neutral"}>
                      {capability}
                    </Badge>
                  </dd>
                </div>
              </dl>

              {status.capability.state === "unavailable" && (
                <Alert tone="warning">
                  <AlertTitle>Import unavailable</AlertTitle>
                  <AlertDescription>
                    {status.capability.reason ?? "The server cannot run this integration."}
                  </AlertDescription>
                </Alert>
              )}

              <div className={`grid gap-3 border-2 border-line-strong p-3 shadow-[4px_4px_0_#171714] sm:grid-cols-[auto_1fr] sm:items-center ${canRun ? "bg-production-lime" : "bg-surface-muted"}`}>
                <AlertDialog>
                  <AlertDialogTrigger asChild><Button className="rounded-none bg-ink text-on-ink" loading={running} disabled={!canRun}>Import now</Button></AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Import the {capability.toLowerCase()} Accelevents feed?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Event {accelevents.accelEventId} will import every speaker and talk returned by the {capability.toLowerCase()} adapter. Matching external IDs are updated idempotently; new records are added. Result counts appear after the run.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={onRun}>Run import</AlertDialogAction></AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <span role="status" aria-live="polite" className="text-xs font-black uppercase tracking-[0.08em] text-ink-secondary">
                  {running ? "Import in progress…" : canRun ? "Ready to import" : "Import is not available"}
                </span>
              </div>

              {runError && (
                <Alert tone="danger">
                  <AlertTitle>Import failed</AlertTitle>
                  <AlertDescription>{runError}</AlertDescription>
                </Alert>
              )}

              {latest && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-[0.14em] text-ink-faint">Run report</p>
                        <h4 className="text-lg font-black tracking-[-0.025em] text-ink">Latest import</h4>
                      </div>
                      <Badge tone={latest.status === "succeeded" ? "success" : latest.status === "partial" ? "warning" : "danger"}>
                        {latest.status}
                      </Badge>
                    </div>
                    <dl className="grid grid-cols-2 border-2 border-line-strong text-xs sm:grid-cols-5">
                      {[
                        ["Created", latest.counts.created, "bg-production-lime"],
                        ["Updated", latest.counts.updated, "bg-production-sky"],
                        ["Unchanged", latest.counts.unchanged, "bg-surface-muted"],
                        ["Failed", latest.counts.failed, latest.counts.failed > 0 ? "bg-production-coral" : "bg-surface"],
                        ["Mode", latest.mode, "bg-production-yellow"],
                      ].map(([label, value, color], index) => (
                        <div className={`px-2.5 py-3 ${color} ${index > 0 ? "border-l-0 sm:border-l-2" : ""} ${index > 1 ? "border-t-2 sm:border-t-0" : ""} ${index % 2 === 1 ? "border-l-2" : ""}`} key={label}>
                          <dt className="text-[8px] font-black uppercase tracking-[0.1em] text-ink">{label}</dt>
                          <dd className="mt-1 text-lg font-black capitalize tracking-[-0.04em] text-ink">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    {latest.errorDetail && <p className="border-l-4 border-danger pl-3 text-xs font-bold text-danger">{latest.errorDetail}</p>}
                  </div>
                </>
              )}
              <Separator />
              <AcceleventsConfigEditor
                key={`${configuration?.version ?? 0}:${configuration?.source ?? "none"}`}
                eventSlug={eventSlug}
                configuration={configuration}
                onConfigured={onConfigured}
              />
            </div>
          ) : (
            <AcceleventsConfigEditor
              key="new"
              eventSlug={eventSlug}
              configuration={configuration}
              onConfigured={onConfigured}
            />
          )}
          </Card>
        </div>
      </div>
      <Toaster />
    </div>
  );
}

export default function IntegrationsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [configurations, setConfigurations] = useState<readonly IntegrationConfigType[] | null | undefined>(undefined);
  const [status, setStatus] = useState<AcceleventsImportStatusType | null | undefined>(undefined);
  const [configuration, setConfiguration] = useState<AcceleventsConfigurationType | null | undefined>(undefined);
  const [airtableStatus, setAirtableStatus] = useState<AirtableSyncStatusType | null | undefined>(undefined);
  const [runResult, setRunResult] = useState<AcceleventsImportRunType | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [refreshingAirtable, setRefreshingAirtable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const reload = useCallback(() => setRequest((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setConfigurations(undefined);
    setStatus(undefined);
    setConfiguration(undefined);
    setAirtableStatus(undefined);
    setRunResult(null);
    setRunError(null);
    setError(null);
    const eventPath = `/api/v1/events/${encodeURIComponent(eventSlug)}/integrations`;
    void Promise.all([
      apiFetch<readonly IntegrationConfigType[]>(
        `${eventPath}/configurations`,
        { schema: Schema.Array(IntegrationConfig) },
      ),
      apiFetch<AcceleventsImportStatusType>(
        `${eventPath}/accelevents/status`,
        { schema: AcceleventsImportStatus },
      ),
      apiFetch<AcceleventsConfigurationType | null>(
        `${eventPath}/accelevents/configuration`,
        { schema: Schema.NullOr(AcceleventsConfiguration) },
      ),
      apiFetch<AirtableSyncStatusType>(
        `${eventPath}/airtable/status`,
        { schema: AirtableSyncStatus },
      ),
    ])
      .then(([loadedConfigurations, loadedStatus, loadedConfiguration, loadedAirtableStatus]) => {
        if (!active) return;
        setConfigurations(loadedConfigurations);
        setStatus(loadedStatus);
        setConfiguration(loadedConfiguration);
        setAirtableStatus(loadedAirtableStatus);
        if (loadedAirtableStatus.configured && loadedAirtableStatus.capability.state === "ready") {
          void apiFetch(
            `${eventPath}/airtable/refreshes`,
            { method: "POST", body: { entityTypes: ["speaker", "submission", "talk"] } },
          ).catch((cause) => {
            console.warn("Could not request the on-load Airtable refresh", cause);
          });
        }
      })
      .catch((cause) => {
        if (!active) return;
        const unauthenticated = cause instanceof ApiError && cause.status === 401;
        const notFound = cause instanceof ApiError && cause.status === 404;
        const message = cause instanceof Error ? cause.message : "Could not load integrations";
        setError(unauthenticated ? "unauthenticated" : notFound ? null : message);
        setConfigurations(null);
        setStatus(null);
        setConfiguration(null);
        setAirtableStatus(null);
        if (!unauthenticated && !notFound) toast(message, { tone: "danger" });
      });
    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  const runImport = useCallback(() => {
    if (running || !status?.configured || status.capability.state !== "ready") return;
    setRunning(true);
    setRunError(null);
    void apiFetch<AcceleventsImportRunType>(
      `/api/v1/events/${encodeURIComponent(eventSlug)}/integrations/accelevents/imports`,
      {
        method: "POST",
        body: { idempotencyKey: crypto.randomUUID() },
        schema: AcceleventsImportRun,
      },
    )
      .then((result) => {
        setRunResult(result);
        if (result.status === "succeeded") {
          toast("Accelevents import completed", { tone: "success" });
        } else {
          const message = result.errorDetail ?? "Accelevents import did not fully complete";
          setRunError(message);
          toast(message, { tone: result.status === "partial" ? "warning" : "danger" });
        }
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : "Could not run Accelevents import";
        setRunError(message);
        toast(message, { tone: "danger" });
      })
      .finally(() => setRunning(false));
  }, [eventSlug, running, status]);

  const refreshAirtable = useCallback(() => {
    if (refreshingAirtable || !airtableStatus?.configured) return;
    setRefreshingAirtable(true);
    void apiFetch(
      `/api/v1/events/${encodeURIComponent(eventSlug)}/integrations/airtable/refreshes`,
      { method: "POST", body: { entityTypes: ["speaker", "submission", "talk"] } },
    ).then(() => {
      toast("Airtable refresh requested", { tone: "success" });
      window.setTimeout(reload, 500);
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Could not request Airtable refresh";
      toast(message, { tone: "danger" });
    }).finally(() => setRefreshingAirtable(false));
  }, [airtableStatus, eventSlug, refreshingAirtable, reload]);

  if (configurations === undefined || status === undefined || configuration === undefined || airtableStatus === undefined) {
    return <LoadingRegion label="Loading integration configuration" />;
  }

  if (configurations === null || status === null || airtableStatus === null) {
    if (error === "unauthenticated") {
      return (
        <>
          <EmptyState
            headingLevel={1}
            title="Sign in to view integrations"
            description="Sign in with organizer access to view this event's provider configuration."
            action={<Button onClick={() => navigate(loginPathForLocation(location))}>Sign in</Button>}
          />
          <Toaster />
        </>
      );
    }
    return (
      <>
        <EmptyState
          headingLevel={1}
          title={error ? "Integrations could not be loaded" : "Event not found"}
          description={error ?? "The event may have moved or been removed."}
          action={error ? <Button onClick={reload}>Try again</Button> : undefined}
        />
        <Toaster />
      </>
    );
  }

  return (
    <IntegrationsWorkspace
      eventSlug={eventSlug}
      configurations={configurations}
      status={status}
      configuration={configuration}
      airtableStatus={airtableStatus}
      refreshingAirtable={refreshingAirtable}
      running={running}
      runResult={runResult}
      runError={runError}
      onReload={reload}
      onRun={runImport}
      onRefreshAirtable={refreshAirtable}
      onConfigured={(result) => {
        setConfiguration(result.configuration);
        reload();
      }}
      onAirtableConfigured={(result) => {
        setAirtableStatus((current) => current ? {
          ...current,
          configured: true,
          configuration: result.configuration,
        } : current);
        reload();
      }}
    />
  );
}
