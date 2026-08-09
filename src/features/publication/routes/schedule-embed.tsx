import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { PublishedAgenda } from "@/features/agenda/schema";
import { Button, PageHeader, Skeleton } from "@/ui";
import { PublishedSchedule } from "../components/PublishedSchedule";
import { getPublicSchedule, PublicationApiError } from "../api";

export const path = "/embed/:eventSlug/schedule";
export const layout = "bare";

export type ScheduleLoadError =
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

export function scheduleLoadError(caught: unknown): ScheduleLoadError {
  if (caught instanceof PublicationApiError && caught.status === 404) {
    return { kind: "unavailable" };
  }
  return {
    kind: "failed",
    message: caught instanceof Error ? caught.message : "Could not load this schedule",
  };
}

export interface ScheduleEmbedContentProps {
  readonly agenda: PublishedAgenda | null | undefined;
  readonly error: ScheduleLoadError | null;
  readonly onRetry: () => void;
}

export function ScheduleEmbedContent({
  agenda,
  error,
  onRetry,
}: ScheduleEmbedContentProps) {
  if (agenda === undefined) {
    return (
      <>
        <PageHeader title="Event schedule" description="Loading the latest published schedule." />
        <Skeleton className="min-h-72" />
      </>
    );
  }
  if (error?.kind === "unavailable" || (agenda === null && error === null)) {
    return (
      <PageHeader
        title="Schedule not published"
        description="This event's schedule is unavailable until the organizer publishes it."
      />
    );
  }
  if (error?.kind === "failed") {
    return (
      <PageHeader
        title="Could not load the schedule"
        description={error.message}
        actions={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }
  if (agenda === null) {
    return null;
  }
  return (
    <>
      <PageHeader
        title={agenda.eventName}
        description={`${agenda.location ?? "Online"} · ${agenda.timezone}`}
      />
      <PublishedSchedule agenda={agenda} />
      <p className="mt-8 text-xs text-ink-faint">
        Schedule revision {agenda.revision} · Published {new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: agenda.timezone,
        }).format(agenda.publishedAt)}
      </p>
    </>
  );
}

export default function ScheduleEmbedPage() {
  const { eventSlug = "" } = useParams();
  const [agenda, setAgenda] = useState<PublishedAgenda | null | undefined>(undefined);
  const [error, setError] = useState<ScheduleLoadError | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setAgenda(undefined);
    setError(null);
    void getPublicSchedule(eventSlug).then((loaded) => {
      if (active) setAgenda(loaded);
    }).catch((caught: unknown) => {
      if (!active) return;
      setAgenda(null);
      setError(scheduleLoadError(caught));
    });
    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  return (
    <main className="min-h-dvh bg-surface px-3 py-6 text-ink sm:px-8 sm:py-12">
      <div className="mx-auto w-full max-w-4xl">
        <ScheduleEmbedContent
          agenda={agenda}
          error={error}
          onRetry={() => setRequest((current) => current + 1)}
        />
      </div>
    </main>
  );
}
