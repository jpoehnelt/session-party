import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { apiFetch } from "@/client/api";
import {
  Badge,
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

export default function EventOverviewPage() {
  const { eventSlug = "" } = useParams();
  const [event, setEvent] = useState<EventOverview | null | undefined>(undefined);

  useEffect(() => {
    void apiFetch<EventOverview>(`/api/v1/events/${encodeURIComponent(eventSlug)}`)
      .then(setEvent)
      .catch((error) => {
        setEvent(null);
        toast(error instanceof Error ? error.message : "Could not load event", { tone: "danger" });
      });
  }, [eventSlug]);

  return (
    <>
      {event === undefined ? (
        <Skeleton />
      ) : event === null ? (
        <EmptyState title="Event not found" description="This event may have moved or been removed." />
      ) : (
        <>
          <PageHeader title={event.name} description={event.description || "Event overview"} />
          <Card title="Event details">
            <Table
              columns={[
                { key: "label", header: "Detail" },
                { key: "value", header: "Value", render: (row) => row.value },
              ]}
              rows={[
                { label: "Location", value: event.location || "Not set" },
                { label: "Timezone", value: event.timezone },
                { label: "Status", value: <Badge>Planning</Badge> },
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

