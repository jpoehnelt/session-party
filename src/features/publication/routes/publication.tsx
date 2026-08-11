import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "@/client/api";
import { copyText } from "@/client/clipboard";
import { loginPathForLocation } from "@/client/return-to";
import {
  Badge,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Toaster,
  toast,
} from "@/ui";
import { AgendaSnapshot, PublishedAgenda } from "@/features/agenda/schema";
import { EventOutput } from "@/features/events/schema";
import { PublishedSchedule } from "../components/PublishedSchedule";
import { WidgetBuilder } from "../components/PublicProgram";
import { getPublicSchedule } from "../api";

export const path = "/e/:eventSlug/publication";
export const contentWidth = "wide" as const;

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
      `/api/v1/events/${encodeURIComponent(eventSlug)}`,
      { schema: EventOutput },
    ).then(async (event) => {
      const loaded = await apiFetch(
        `/api/v1/events/${encodeURIComponent(event.id)}/agenda?view=day`,
        { schema: AgendaSnapshot },
      );
      if (!active) return;
      setStatus(loaded);
      if (loaded.publication.revision === 0) return;
      const projection = await getPublicSchedule(eventSlug, {
        eventId: loaded.eventId,
        revision: loaded.publication.revision,
      });
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
        `/api/v1/events/${encodeURIComponent(status.eventId)}/agenda/publications`,
        {
          method: "POST",
          body: {
            expectedRevision: status.publication.revision,
            expectedWorkspaceVersion: status.workspaceVersion,
            expectedEventVersion: status.eventVersion,
            idempotencyKey: `agenda-publication-${crypto.randomUUID()}`,
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

  if (status === undefined) {
    return (
      <>
        <PageHeader title="Publish the run of show" description="Loading the latest publication state." />
        <div className="grid gap-5 lg:grid-cols-[20rem_1fr]">
          <Skeleton className="min-h-80 rounded-none" />
          <Skeleton className="min-h-[30rem] rounded-none" />
        </div>
      </>
    );
  }

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
        <PageHeader title="Publication desk" description="The public run of show stops here until this is resolved." />
        <EmptyState className="min-h-72 bg-production-coral/20" {...content} />
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
  const isPublished = status.publication.revision > 0;
  const hasConflicts = status.conflicts.length > 0;
  const publicSessionCount = status.publication.talkCount;
  const publicProgramPath = `/event/${eventSlug}/sessions`;

  return (
    <>
      <PageHeader
        title="Publish the run of show"
        description={`${status.eventName} · ${status.timezone} · one trusted audience-facing revision`}
        actions={<>
          <a className="inline-flex h-12 items-center border-2 border-line-strong bg-surface px-4 text-xs font-black uppercase tracking-[0.08em] text-ink shadow-button" href={publicProgramPath} target="_blank" rel="noreferrer">Open public program ↗</a>
          <Button variant="secondary" onClick={() => void copyText(`${window.location.origin}${publicProgramPath}`).then(() => toast("Public link copied", { tone: "success" }), () => toast("Could not copy public link", { tone: "danger" }))}>Copy public link</Button>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button className="h-12 rounded-none bg-production-lime px-5 text-ink shadow-[5px_5px_0_#171714] hover:bg-production-yellow" loading={publishing} disabled={hasConflicts}>{status.publication.revision === 0 ? "Publish schedule" : "Publish new revision"}</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Publish revision {status.publication.revision + 1}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This replaces the audience-facing program with {confirmedTalkCount} confirmed {confirmedTalkCount === 1 ? "session" : "sessions"}. The current public revision has {publicSessionCount}. Later agenda edits stay backstage until another revision is published.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep backstage</AlertDialogCancel><AlertDialogAction onClick={() => void publish()}>Publish revision {status.publication.revision + 1}</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>}
      />
      <section aria-label="Publication status" className="mb-7 grid border-2 border-line-strong bg-surface shadow-card sm:grid-cols-3">
        {[
          [String(confirmedTalkCount).padStart(2, "0"), "Confirmed cues", "Current private agenda", "bg-production-sky"],
          [String(publicSessionCount).padStart(2, "0"), "Public cues", isPublished ? `Revision ${status.publication.revision}` : "Waiting for first publish", "bg-production-lime"],
          [String(status.conflicts.length).padStart(2, "0"), "Blocking conflicts", hasConflicts ? "Hold publication" : "Clear to broadcast", hasConflicts ? "bg-production-coral" : "bg-production-yellow"],
        ].map(([value, label, detail, color], index) => (
          <div className={`p-4 sm:p-5 ${color} ${index > 0 ? "border-t-2 border-line-strong sm:border-l-2 sm:border-t-0" : ""}`} key={label}>
            <p className="text-4xl font-black tracking-[-0.06em]">{value}</p>
            <p className="mt-1 text-[10px] font-black uppercase tracking-[0.14em]">{label}</p>
            <p className="mt-3 border-t-2 border-line-strong pt-2 text-xs font-bold text-ink-secondary">{detail}</p>
          </div>
        ))}
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card className="rounded-none [&>div]:p-0 [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink" title="Broadcast manifest">
            <dl className="divide-y-2 divide-line-strong text-sm">
              <div className="px-4 py-4">
                <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">Public revision</dt>
                <dd className="mt-2">
                  <Badge tone={isPublished ? "success" : "neutral"}>
                    {isPublished ? `Revision ${status.publication.revision}` : "Unpublished"}
                  </Badge>
                </dd>
              </div>
              <div className="px-4 py-4">
                <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">Last transmission</dt>
                <dd className="mt-1 font-bold leading-5 text-ink">{publishedAt}</dd>
              </div>
              <div className="px-4 py-4">
                <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">Audience clock</dt>
                <dd className="mt-1 font-bold text-ink">{status.timezone}</dd>
              </div>
            </dl>
          </Card>

          <section
            className={`border-2 border-line-strong p-4 shadow-[5px_5px_0_#171714] ${hasConflicts ? "bg-production-coral" : "bg-ink text-on-accent"}`}
            aria-live="polite"
          >
            <p className={`text-[10px] font-black uppercase tracking-[0.16em] ${hasConflicts ? "text-ink" : "text-production-lime"}`}>
              {hasConflicts ? "Publication hold" : "Immutable by design"}
            </p>
            {hasConflicts ? (
              <p className="mt-2 text-sm font-bold leading-6 text-ink">
                Resolve {status.conflicts.length} schedule {status.conflicts.length === 1 ? "conflict" : "conflicts"} before publishing.
              </p>
            ) : (
              <p className="mt-2 text-sm font-semibold leading-6 text-white/75">
                Publishing freezes a public revision. Later agenda edits stay backstage until the next publish.
              </p>
            )}
          </section>
        </div>

        <Card className="min-w-0 rounded-none [&>div]:p-4 [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink sm:[&>div]:p-5" title="Audience preview / live revision">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-2 border-line-strong bg-ink px-4 py-3 text-on-accent">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-production-sky">Public output</p>
              <p className="mt-1 text-sm font-black">{status.eventName}</p>
            </div>
            <Badge tone={isPublished ? "success" : "warning"}>{isPublished ? "On air" : "Off air"}</Badge>
          </div>
          {published ? (
            <PublishedSchedule agenda={published} compact />
          ) : (
            <EmptyState
              className="min-h-72 bg-production-yellow/20"
              title="Schedule not published"
              description="The audience embed stays off air until you publish the first immutable revision."
            />
          )}
        </Card>
      </div>
      {published ? (
        <div className="mt-8 border-t-4 border-line-strong pt-8">
          <WidgetBuilder agenda={published} />
        </div>
      ) : null}
      <Toaster />
    </>
  );
}
