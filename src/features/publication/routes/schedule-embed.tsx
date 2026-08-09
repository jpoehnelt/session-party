import { useEffect, useState, type ReactNode } from "react";
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

function ScheduleMasthead({ label }: { readonly label: string }) {
  return (
    <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-2 border-line-strong bg-ink px-4 py-3 text-on-accent shadow-[5px_5px_0_#7857ff] sm:px-5">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center border-2 border-on-accent bg-production-lime text-[10px] font-black tracking-[-0.04em] text-ink">
          SP
        </span>
        <div>
          <p className="text-sm font-black tracking-[-0.025em]">Session Party</p>
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/55">Public program feed</p>
        </div>
      </div>
      <p className="border-2 border-on-accent bg-production-coral px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-ink">
        {label}
      </p>
    </header>
  );
}

function EmbedState({
  title,
  description,
  label,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly action?: ReactNode;
}) {
  return (
    <>
      <ScheduleMasthead label={label} />
      <section className="grid min-h-[24rem] border-2 border-line-strong bg-surface shadow-[8px_8px_0_#171714] md:grid-cols-[minmax(0,1fr)_12rem]">
        <div className="flex flex-col items-start justify-center p-6 sm:p-10">
          <p className="mb-4 inline-block border-2 border-line-strong bg-production-yellow px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] shadow-[3px_3px_0_#171714]">
            Audience notice
          </p>
          <PageHeader className="mb-0 w-full border-b-0 pb-0" title={title} description={description} actions={action} />
        </div>
        <div className="hidden border-l-2 border-line-strong bg-production-coral md:flex md:items-end md:p-5" aria-hidden="true">
          <span className="text-7xl font-black leading-none tracking-[-0.08em] text-ink/25">SP</span>
        </div>
      </section>
    </>
  );
}

export function ScheduleEmbedContent({
  agenda,
  error,
  onRetry,
}: ScheduleEmbedContentProps) {
  if (agenda === undefined) {
    return (
      <>
        <ScheduleMasthead label="Tuning feed" />
        <div className="grid gap-5 md:grid-cols-[1fr_16rem]">
          <Skeleton className="min-h-80 rounded-none" />
          <Skeleton className="min-h-80 rounded-none bg-production-sky/30" />
        </div>
      </>
    );
  }
  if (error?.kind === "unavailable" || (agenda === null && error === null)) {
    return (
      <EmbedState
        label="Off air"
        title="Schedule not published"
        description="This event's schedule is unavailable until the organizer publishes it."
      />
    );
  }
  if (error?.kind === "failed") {
    return (
      <EmbedState
        label="Signal lost"
        title="Could not load the schedule"
        description={error.message}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }
  if (agenda === null) {
    return null;
  }
  return (
    <>
      <ScheduleMasthead label="Schedule live" />
      <section className="mb-10 grid border-2 border-line-strong bg-surface shadow-[8px_8px_0_#171714] lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="p-5 sm:p-8 lg:p-10">
          <p className="inline-block -rotate-1 border-2 border-line-strong bg-production-coral px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] shadow-[4px_4px_0_#171714]">
            The public run of show
          </p>
          <h1 className="mt-7 max-w-3xl text-[clamp(3rem,9vw,6.5rem)] font-black leading-[0.82] tracking-[-0.07em] text-ink">
            {agenda.eventName}
          </h1>
          <p className="mt-7 max-w-2xl border-l-4 border-accent pl-4 text-base font-bold leading-7 text-ink-secondary sm:text-lg">
            Every session, room, and speaker in the latest published program.
          </p>
        </div>
        <dl className="grid border-t-2 border-line-strong lg:border-l-2 lg:border-t-0">
          {[
            ["Venue", agenda.location ?? "Online", "bg-production-sky"],
            ["Audience clock", agenda.timezone, "bg-production-lime"],
            ["Live revision", String(agenda.revision).padStart(2, "0"), "bg-production-yellow"],
          ].map(([term, detail, color], index) => (
            <div className={`flex flex-col justify-center px-5 py-5 ${color} ${index > 0 ? "border-t-2 border-line-strong" : ""}`} key={term}>
              <dt className="text-[10px] font-black uppercase tracking-[0.14em] text-ink-faint">{term}</dt>
              <dd className="mt-1 break-words text-lg font-black tracking-[-0.025em] text-ink">{detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="published-program-heading">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-line-strong pb-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-accent-deep">Now showing</p>
            <h2 id="published-program-heading" className="mt-1 text-3xl font-black tracking-[-0.045em] sm:text-4xl">Published program</h2>
          </div>
          <p className="border-2 border-line-strong bg-production-lime px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] shadow-[3px_3px_0_#171714]">
            {agenda.talks.length} {agenda.talks.length === 1 ? "session" : "sessions"}
          </p>
        </div>
        <PublishedSchedule agenda={agenda} />
      </section>

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-4 border-2 border-line-strong bg-ink px-4 py-4 text-on-accent sm:px-5">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/55">Session Party · Audience feed</p>
        <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/70">
          Schedule revision {agenda.revision} · Published {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: agenda.timezone,
          }).format(agenda.publishedAt)}
        </p>
      </footer>
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
    <main className="production-grid min-h-dvh bg-canvas px-3 py-5 text-ink sm:px-8 sm:py-8 lg:px-10 lg:py-10">
      <div className="mx-auto w-full max-w-6xl">
        <ScheduleEmbedContent
          agenda={agenda}
          error={error}
          onRetry={() => setRequest((current) => current + 1)}
        />
      </div>
    </main>
  );
}
