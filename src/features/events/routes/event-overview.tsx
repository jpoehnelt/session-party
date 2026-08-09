import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { loginPathForLocation } from "@/client/return-to";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Table,
  Toaster,
  toast,
} from "@/ui";

interface EventOverview {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  location: string | null;
  timezone: string;
}

export const path = "/e/:eventSlug";

type EventLoadError =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly message: string };

export default function EventOverviewPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventOverview | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<EventLoadError | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setEvent(undefined);
    setLoadError(null);
    void apiFetch<EventOverview>(`/api/v1/events/${encodeURIComponent(eventSlug)}`)
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
        const message = error instanceof Error ? error.message : "Could not load event";
        setLoadError({ kind: "failed", message });
        toast(message, { tone: "danger" });
      });

    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  return (
    <>
      {event === undefined ? (
        <Skeleton />
      ) : loadError?.kind === "unauthenticated" ? (
        <EmptyState
          title="Sign in to view this event"
          description="Sign in to continue to this event."
          action={
            <Button
              className="min-h-11"
              onClick={() => navigate(loginPathForLocation(location))}
            >
              Sign in
            </Button>
          }
        />
      ) : loadError?.kind === "not-found" ? (
        <EmptyState title="Event not found" description="This event may have moved or been removed." />
      ) : loadError?.kind === "failed" ? (
        <EmptyState
          title="Could not load event"
          description={loadError.message}
          action={
            <Button className="min-h-11" onClick={() => setRequest((current) => current + 1)}>
              Try again
            </Button>
          }
        />
      ) : event === null ? (
        <EmptyState title="Event not found" description="This event may have moved or been removed." />
      ) : (
        <>
          <PageHeader title={event.name} description={event.description || "Your live production overview."} />
          <Card className="[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Production brief">
            <Table
              columns={[
                { key: "label", header: "Detail" },
                { key: "value", header: "Value", render: (row) => row.value },
              ]}
              rows={[
                { label: "Location", value: event.location || "Not set" },
                { label: "Timezone", value: event.timezone },
                { label: "Status", value: <Badge tone="accent">Planning</Badge> },
              ]}
              rowKey={(row) => row.label}
            />
          </Card>
        </>
      )}
      <Toaster />
    </>
  );
}
