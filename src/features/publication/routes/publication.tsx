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
  Toaster,
  toast,
} from "@/ui";
import { AgendaSnapshot, PublishedAgenda } from "@/features/agenda/schema";
import { PublishedSchedule } from "../components/PublishedSchedule";

export const path = "/e/:eventSlug/publication";

type PublicationLoadError =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly message: string };


export default function PublicationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { eventSlug = "" } = useParams();
  const [status, setStatus] = useState<AgendaSnapshot | null | undefined>(undefined);
  const [published, setPublished] = useState<PublishedAgenda | null>(null);
  const [loadError, setLoadError] = useState<PublicationLoadError | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus(undefined);
    setPublished(null);
    setLoadError(null);
    void apiFetch(
      `/api/v1/publication/${encodeURIComponent(eventSlug)}/status`,
      { schema: AgendaSnapshot },
    ).then(async (loaded) => {
      if (!active) return;
      setStatus(loaded);
      if (loaded.publication.revision === 0) return;
      const projection = await apiFetch(
        `/api/v1/publication/${encodeURIComponent(eventSlug)}/schedule`,
        { schema: PublishedAgenda },
      );
      if (active) setPublished(projection);
    }).catch((caught: unknown) => {
      if (!active) return;
      setStatus(null);
      if (caught instanceof ApiError && caught.status === 401) {
        setLoadError({ kind: "unauthenticated" });
        return;
      }
      if (caught instanceof ApiError && caught.status === 403) {
        setLoadError({ kind: "forbidden" });
        return;
      }
      if (caught instanceof ApiError && caught.status === 404) {
        setLoadError({ kind: "not-found" });
        return;
      }
      const message = caught instanceof Error ? caught.message : "Could not load publication status";
      setLoadError({ kind: "failed", message });
      toast(message, { tone: "danger" });
    });
    return () => {
      active = false;
    };
  }, [eventSlug, request]);

  const publish = async () => {
    if (!status) return;
    setPublishing(true);
    try {
      const projection = await apiFetch(
        `/api/v1/events/${encodeURIComponent(status.eventId)}/publication/schedule`,
        {
          method: "POST",
          body: {
            expectedRevision: status.publication.revision,
            expectedWorkspaceVersion: status.workspaceVersion,
            expectedEventVersion: status.eventVersion,
            idempotencyKey: `publication-schedule-${crypto.randomUUID()}`,
          },
          schema: PublishedAgenda,
        },
      );
      setPublished(projection);
      toast(`Schedule revision ${projection.revision} published`, { tone: "success" });
      setRequest((current) => current + 1);
    } catch (caught: unknown) {
      toast(caught instanceof Error ? caught.message : "Could not publish the schedule", { tone: "danger" });
    } finally {
      setPublishing(false);
    }
  };

  if (status === undefined) return <Skeleton className="min-h-72" />;

  if (loadError) {
    const content = loadError.kind === "unauthenticated"
      ? {
          title: "Sign in to manage publication",
          description: "Sign in with an organizer account to preview or publish this schedule.",
          action: <Button onClick={() => navigate(loginPathForLocation(location))}>Sign in</Button>,
        }
      : loadError.kind === "forbidden"
        ? {
            title: "Organizer access required",
            description: "Only event owners and admins can preview or publish the schedule.",
            action: undefined,
          }
        : loadError.kind === "not-found"
          ? {
              title: "Event not found",
              description: "This event may have moved or been removed.",
              action: undefined,
            }
          : {
              title: "Could not load publication",
              description: loadError.message,
              action: <Button onClick={() => setRequest((current) => current + 1)}>Try again</Button>,
            };
    return (
      <>
        <EmptyState {...content} />
        <Toaster />
      </>
    );
  }

  if (status === null) {
    return <EmptyState title="Could not load publication" description="Try loading this event again." />;
  }

  const confirmedTalkCount = status.talks.filter(
    ({ startsAt, status: talkStatus }) => talkStatus === "confirmed" && startsAt !== null,
  ).length;
  const publishedAt = status.publication.publishedAt === null
    ? "Not published"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: status.timezone,
      }).format(status.publication.publishedAt);

  return (
    <>
      <PageHeader
        title="Publication"
        description={`${status.eventName} · ${status.timezone}`}
        actions={
          <Button
            loading={publishing}
            disabled={status.conflicts.length > 0}
            onClick={() => void publish()}
          >
            {status.publication.revision === 0 ? "Publish schedule" : "Publish new revision"}
          </Button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <Card title="Schedule status">
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-ink-faint">Public revision</dt>
              <dd className="mt-1">
                <Badge tone={status.publication.revision > 0 ? "success" : "neutral"}>
                  {status.publication.revision > 0 ? `Revision ${status.publication.revision}` : "Unpublished"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">Published</dt>
              <dd className="mt-1 font-medium text-ink">{publishedAt}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Current agenda</dt>
              <dd className="mt-1 font-medium text-ink">{confirmedTalkCount} confirmed sessions</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Public projection</dt>
              <dd className="mt-1 font-medium text-ink">{status.publication.talkCount} sessions</dd>
            </div>
          </dl>
          {status.conflicts.length > 0 ? (
            <p className="mt-5 text-sm text-danger">
              Resolve {status.conflicts.length} schedule {status.conflicts.length === 1 ? "conflict" : "conflicts"} before publishing.
            </p>
          ) : (
            <p className="mt-5 text-xs leading-5 text-ink-faint">
              Publishing creates an immutable public revision. Later agenda edits stay private until you publish again.
            </p>
          )}
        </Card>
        <Card title="Public schedule preview">
          {published ? (
            <PublishedSchedule agenda={published} compact />
          ) : (
            <EmptyState
              title="Schedule not published"
              description="The public embed stays empty until you publish the first revision."
            />
          )}
        </Card>
      </div>
      <Toaster />
    </>
  );
}
