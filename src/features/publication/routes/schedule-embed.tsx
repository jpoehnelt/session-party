import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { Button, EmptyState, PageHeader, Skeleton } from "@/ui";
import { PublishedAgenda } from "@/features/agenda/schema";
import { PublishedSchedule } from "../components/PublishedSchedule";

export const path = "/embed/:eventSlug/schedule";
export const layout = "bare";

type ScheduleLoadError =
  | { readonly kind: "unpublished" }
  | { readonly kind: "failed"; readonly message: string };

export default function ScheduleEmbedPage() {
  const { eventSlug = "" } = useParams();
  const [agenda, setAgenda] = useState<PublishedAgenda | null | undefined>(undefined);
  const [error, setError] = useState<ScheduleLoadError | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setAgenda(undefined);
    setError(null);
    void apiFetch(
      `/api/v1/publication/${encodeURIComponent(eventSlug)}/schedule`,
      { schema: PublishedAgenda },
    ).then((loaded) => {
      if (active) setAgenda(loaded);
    }).catch((caught: unknown) => {
      if (!active) return;
      setAgenda(null);
      if (caught instanceof ApiError && caught.status === 404) {
        setError({ kind: "unpublished" });
        return;
      }
      setError({
        kind: "failed",
        message: caught instanceof Error ? caught.message : "Could not load this schedule",
      });
    });
    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  return (
    <main className="min-h-screen bg-surface px-4 py-8 text-ink sm:px-8 sm:py-12">
      <div className="mx-auto max-w-4xl">
        {agenda === undefined ? (
          <Skeleton className="min-h-72" />
        ) : error?.kind === "unpublished" ? (
          <EmptyState
            title="Schedule not published"
            description="This event's schedule is still private. Check back after the organizer publishes it."
          />
        ) : error?.kind === "failed" ? (
          <EmptyState
            title="Could not load the schedule"
            description={error.message}
            action={<Button onClick={() => setRequest((current) => current + 1)}>Try again</Button>}
          />
        ) : agenda === null ? (
          <EmptyState title="Schedule not published" description="This event's schedule is still private." />
        ) : (
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
        )}
      </div>
    </main>
  );
}
