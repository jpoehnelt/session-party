import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { IntegrationConfig, type AirtableConfig, type IntegrationConfig as IntegrationConfigType } from "contracts/types";
import { Schema } from "effect";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Separator,
  Skeleton,
  Toaster,
  toast,
} from "@/ui";

export const path = "/e/:eventSlug/integrations";

const EventIdentity = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
type EventIdentity = typeof EventIdentity.Type;

export const configurationTruth = (configurations: readonly IntegrationConfigType[]) => ({
  airtable: configurations.some((configuration) => configuration.kind === "airtable"),
  accelevents: configurations.some((configuration) => configuration.kind === "accelevents"),
});


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

function IntegrationsWorkspace({
  event,
  configurations,
  onReload,
}: {
  readonly event: EventIdentity;
  readonly configurations: readonly IntegrationConfigType[];
  readonly onReload: () => void;
}) {
  const truth = useMemo(() => configurationTruth(configurations), [configurations]);
  const airtable = configurations.find(
    (configuration): configuration is AirtableConfig => configuration.kind === "airtable",
  );
  const accelevents = configurations.find(
    (configuration) => configuration.kind === "accelevents",
  );

  return (
    <>
      <PageHeader
        title="Integrations"
        description={`Provider configuration for ${event.name}. Saved configuration is not treated as proof of live connectivity.`}
        actions={<Button variant="secondary" onClick={onReload}>Reload configuration</Button>}
      />

      <Alert tone="warning" className="mb-5">
        <AlertTitle>Runtime sync status is not available</AlertTitle>
        <AlertDescription>
          The frozen runtime does not expose an Airtable or Accelevents adapter mode, sync lane, freshness result, or retry contract. This page therefore does not label fixtures as live or offer actions that cannot be confirmed.
        </AlertDescription>
      </Alert>

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
          title={<ProviderHeading name="Accelevents" configured={truth.accelevents} />}
          footer={
            <p className="text-xs leading-relaxed text-ink-faint">
              Adapter mode and connectivity are not inferred from saved event IDs.
            </p>
          }
        >
          {accelevents ? (
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Event ID</dt>
                <dd className="mt-1 break-all font-mono text-xs text-ink">{accelevents.accelEventId}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">Connectivity</dt>
                <dd className="mt-1 text-ink-secondary">Not observed</dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              title="Accelevents is not configured"
              description="No validated Accelevents event mapping exists for this event."
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
  const [event, setEvent] = useState<EventIdentity | null | undefined>(undefined);
  const [configurations, setConfigurations] = useState<readonly IntegrationConfigType[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);

  const reload = useCallback(() => setRequest((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setEvent(undefined);
    setConfigurations(undefined);
    setError(null);
    void apiFetch<EventIdentity>(`/api/v1/events/${encodeURIComponent(eventSlug)}`, {
      schema: EventIdentity,
    })
      .then(async (loadedEvent) => ({
        event: loadedEvent,
        configurations: await apiFetch<readonly IntegrationConfigType[]>(
          `/api/v1/events/${encodeURIComponent(loadedEvent.id)}/integrations/configurations`,
          { schema: Schema.Array(IntegrationConfig) },
        ),
      }))
      .then((loaded) => {
        if (!active) return;
        setEvent(loaded.event);
        setConfigurations(loaded.configurations);
      })
      .catch((cause) => {
        if (!active) return;
        const unauthenticated = cause instanceof ApiError && cause.status === 401;
        const notFound = cause instanceof ApiError && cause.status === 404;
        const message = cause instanceof Error ? cause.message : "Could not load integrations";
        setError(unauthenticated ? "unauthenticated" : notFound ? null : message);
        setEvent(null);
        setConfigurations(null);
        if (!unauthenticated && !notFound) toast(message, { tone: "danger" });
      });
    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  if (event === undefined || configurations === undefined) {
    return <LoadingRegion label="Loading integration configuration" />;
  }

  if (event === null || configurations === null) {
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
      key={`${event.id}-${request}`}
      event={event}
      configurations={configurations}
      onReload={reload}
    />
  );
}
