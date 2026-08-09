import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  AcceleventsImportRun,
  AcceleventsImportStatus,
  IntegrationConfig,
  type AcceleventsImportRun as AcceleventsImportRunType,
  type AcceleventsImportStatus as AcceleventsImportStatusType,
  type AirtableConfig,
  type IntegrationConfig as IntegrationConfigType,
} from "contracts/types";
import { Schema } from "effect";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import { acceleventsCapabilityLabel, configurationTruth } from "../presentation";
import {
  AcceleventsConfiguration,
  ConfigureAcceleventsResult,
  type AcceleventsConfiguration as AcceleventsConfigurationType,
  type ConfigureAcceleventsResult as ConfigureAcceleventsResultType,
} from "../schema";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Separator,
  Skeleton,
  Toaster,
  toast,
} from "@/ui";

export const path = "/e/:eventSlug/integrations";


function LoadingRegion({ label }: { readonly label: string }) {
  return (
    <>
      <div role="status" aria-live="polite" aria-label={label} className="space-y-5">
        <span className="sr-only">{label}</span>
        <Skeleton className="h-20 motion-reduce:animate-none" />
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-72 motion-reduce:animate-none" />
          <Skeleton className="h-72 motion-reduce:animate-none" />
        </div>
      </div>
      <Toaster />
    </>
  );
}

function ProviderHeading({
  name,
  configured,
}: {
  readonly name: string;
  readonly configured: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span>{name}</span>
      <Badge tone={configured ? "success" : "neutral"}>
        {configured ? "Configured" : "Not configured"}
      </Badge>
    </div>
  );
}

function MappingTable({ configuration }: { readonly configuration: AirtableConfig }) {
  const tables = [
    { entity: "Speakers", configuration: configuration.tables.speakers },
    { entity: "Submissions", configuration: configuration.tables.submissions },
    { entity: "Talks", configuration: configuration.tables.talks },
  ] as const;

  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Base</dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink">{configuration.baseId}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Origin</dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink">{configuration.origin}</dd>
        </div>
      </dl>
      <Separator />
      <div className="space-y-5">
        {tables.map(({ entity, configuration: table }) => (
          <section key={entity} aria-labelledby={`airtable-${entity.toLowerCase()}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 id={`airtable-${entity.toLowerCase()}`} className="text-sm font-semibold text-ink">
                {entity}
              </h4>
              <code className="break-all text-xs text-ink-faint">{table.tableId}</code>
            </div>
            <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {Object.entries(table.fields).map(([key, fieldId]) => (
                <div key={key} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line-subtle py-1.5 text-xs">
                  <dt className="capitalize text-ink-secondary">
                    {key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}
                  </dt>
                  <dd className="max-w-[55%] truncate font-mono text-ink" title={fieldId}>{fieldId}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
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
    <section className="space-y-3" aria-labelledby="accelevents-configuration">
      <h4 id="accelevents-configuration" className="text-sm font-semibold text-ink">Configuration</h4>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Accelevents source">
        <Button variant={source === "fixture" ? "primary" : "secondary"} onClick={() => selectSource("fixture")} disabled={saving}>
          Demo fixture
        </Button>
        <Button variant={source === "live" ? "primary" : "secondary"} onClick={() => selectSource("live")} disabled={saving}>
          Live event
        </Button>
      </div>
      {source === "fixture" ? (
        <Alert tone="warning">
          <AlertTitle>Deterministic demo data</AlertTitle>
          <AlertDescription>This imports labeled fixture speakers and talks. It does not call Accelevents.</AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs leading-relaxed text-ink-secondary">
          The live adapter uses the server-held <code>ACCELEVENTS_API_TOKEN</code>; this form never accepts or exposes credentials.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Accelevents event ID" value={accelEventId} onChange={(event) => setAccelEventId(event.target.value)} disabled={source === "fixture" || saving} />
        <Input label="Event URL key" value={eventUrl} onChange={(event) => setEventUrl(event.target.value)} disabled={source === "fixture" || saving} />
      </div>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <Button onClick={save} loading={saving}>
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
  onReload,
  onRun,
  onConfigured,
}: {
  readonly eventSlug: string;
  readonly configurations: readonly IntegrationConfigType[];
  readonly status: AcceleventsImportStatusType;
  readonly running: boolean;
  readonly runResult: AcceleventsImportRunType | null;
  readonly runError: string | null;
  readonly configuration: AcceleventsConfigurationType | null;
  readonly onReload: () => void;
  readonly onRun: () => void;
  readonly onConfigured: (result: ConfigureAcceleventsResultType) => void;
}) {
  const truth = useMemo(() => configurationTruth(configurations), [configurations]);
  const airtable = configurations.find(
    (configuration): configuration is AirtableConfig => configuration.kind === "airtable",
  );
  const accelevents = status.config;
  const capability = acceleventsCapabilityLabel(status);
  const canRun = status.configured && status.capability.state === "ready";
  const latest = runResult ?? status.latestRun;

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Provider configuration and server-observed import state for this event."
        actions={<Button variant="secondary" onClick={onReload}>Reload status</Button>}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title={<ProviderHeading name="Airtable" configured={truth.airtable} />}
          footer={
            <p className="text-xs leading-relaxed text-ink-faint">
              Credentials are held by secret reference and are never returned here.
            </p>
          }
        >
          {airtable ? (
            <MappingTable configuration={airtable} />
          ) : (
            <EmptyState
              title="Airtable is not configured"
              description="No validated Airtable field map exists for this event."
            />
          )}
        </Card>

        <Card
          title={<ProviderHeading name="Accelevents" configured={status.configured} />}
          footer={
            <p className="text-xs leading-relaxed text-ink-faint">
              Live, fixture, and unavailable states come from the server runtime—not saved IDs.
            </p>
          }
        >
          {accelevents ? (
            <div className="space-y-5">
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Event ID</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-ink">{accelevents.accelEventId}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Adapter</dt>
                  <dd className="mt-1">
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

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={onRun} loading={running} disabled={!canRun}>
                  Import now
                </Button>
                <span role="status" aria-live="polite" className="text-xs text-ink-secondary">
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
                      <h4 className="text-sm font-semibold text-ink">Latest import</h4>
                      <Badge tone={latest.status === "succeeded" ? "success" : latest.status === "partial" ? "warning" : "danger"}>
                        {latest.status}
                      </Badge>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                      <div><dt className="text-ink-faint">Created</dt><dd className="mt-1 font-semibold text-ink">{latest.counts.created}</dd></div>
                      <div><dt className="text-ink-faint">Updated</dt><dd className="mt-1 font-semibold text-ink">{latest.counts.updated}</dd></div>
                      <div><dt className="text-ink-faint">Unchanged</dt><dd className="mt-1 font-semibold text-ink">{latest.counts.unchanged}</dd></div>
                      <div><dt className="text-ink-faint">Failed</dt><dd className="mt-1 font-semibold text-ink">{latest.counts.failed}</dd></div>
                      <div><dt className="text-ink-faint">Mode</dt><dd className="mt-1 font-semibold capitalize text-ink">{latest.mode}</dd></div>
                    </dl>
                    {latest.errorDetail && <p className="text-xs text-danger">{latest.errorDetail}</p>}
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
      <Toaster />
    </>
  );
}

export default function IntegrationsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [configurations, setConfigurations] = useState<readonly IntegrationConfigType[] | null | undefined>(undefined);
  const [status, setStatus] = useState<AcceleventsImportStatusType | null | undefined>(undefined);
  const [configuration, setConfiguration] = useState<AcceleventsConfigurationType | null | undefined>(undefined);
  const [runResult, setRunResult] = useState<AcceleventsImportRunType | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const reload = useCallback(() => setRequest((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setConfigurations(undefined);
    setStatus(undefined);
    setConfiguration(undefined);
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
    ])
      .then(([loadedConfigurations, loadedStatus, loadedConfiguration]) => {
        if (!active) return;
        setConfigurations(loadedConfigurations);
        setStatus(loadedStatus);
        setConfiguration(loadedConfiguration);
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

  if (configurations === undefined || status === undefined || configuration === undefined) {
    return <LoadingRegion label="Loading integration configuration" />;
  }

  if (configurations === null || status === null) {
    if (error === "unauthenticated") {
      return (
        <>
          <EmptyState
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
      running={running}
      runResult={runResult}
      runError={runError}
      onReload={reload}
      onRun={runImport}
      onConfigured={(result) => {
        setConfiguration(result.configuration);
        reload();
      }}
    />
  );
}
