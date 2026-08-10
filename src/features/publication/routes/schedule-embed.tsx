import { useEffect, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import type { PublishedAgenda } from "@/features/agenda/schema";
import { Button, PageHeader, Skeleton } from "@/ui";
import { PublishedSchedule } from "../components/PublishedSchedule";
import { getPublicSchedule, PublicationApiError } from "../api";
import {
  DEFAULT_EMBED_DESIGN,
  embedDesignFromSearch,
  embedDesignStyle,
  embedTypographyClass,
  type EmbedDesign,
} from "../embed-design";

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
  readonly design?: EmbedDesign;
}

function ScheduleMasthead({ label, design }: { readonly label: string; readonly design: EmbedDesign }) {
  return (
    <header className={`mb-8 flex flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-5 ${
      design.aesthetic === "bold"
        ? "border-2 border-line-strong bg-ink text-on-accent shadow-[5px_5px_0_var(--color-accent)]"
        : design.aesthetic === "minimal"
          ? "rounded-xl border border-line bg-surface text-ink shadow-none"
          : "border-y border-line-strong bg-transparent text-ink shadow-none"
    }`}>
      <div className="flex items-center gap-3">
        <span className={`grid size-9 place-items-center bg-accent text-[10px] font-black tracking-[-0.04em] text-on-accent ${
          design.aesthetic === "bold" ? "border-2 border-on-accent" : design.aesthetic === "minimal" ? "rounded-full" : "border border-line-strong"
        }`}>
          SP
        </span>
        <div>
          <p className="text-sm font-black tracking-[-0.025em]">Session Party</p>
          <p className={`text-[9px] font-bold uppercase tracking-[0.16em] ${design.aesthetic === "bold" ? "text-white/55" : "text-ink-secondary"}`}>Public program feed</p>
        </div>
      </div>
      <p className={`bg-accent px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-on-accent ${
        design.aesthetic === "bold" ? "border-2 border-on-accent" : design.aesthetic === "minimal" ? "rounded-full" : "border border-line-strong"
      }`}>
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
  design,
}: {
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly action?: ReactNode;
  readonly design: EmbedDesign;
}) {
  return (
    <>
      <ScheduleMasthead label={label} design={design} />
      <section className={`grid min-h-[24rem] bg-surface md:grid-cols-[minmax(0,1fr)_12rem] ${
        design.aesthetic === "bold"
          ? "border-2 border-line-strong shadow-[8px_8px_0_#171714]"
          : design.aesthetic === "minimal"
            ? "rounded-2xl border border-line shadow-none"
            : "border-y border-line-strong bg-transparent shadow-none"
      }`}>
        <div className="flex flex-col items-start justify-center p-6 sm:p-10">
          <p className={`mb-4 inline-block bg-accent-soft px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] ${
            design.aesthetic === "bold" ? "border-2 border-line-strong shadow-[3px_3px_0_#171714]" : design.aesthetic === "minimal" ? "rounded-full" : "border border-line-strong"
          }`}>
            Audience notice
          </p>
          <PageHeader className="mb-0 w-full border-b-0 pb-0" title={title} description={description} actions={action} />
        </div>
        <div className={`hidden border-l border-line-strong md:flex md:items-end md:p-5 ${design.aesthetic === "bold" ? "border-l-2 bg-accent" : "bg-surface-muted"}`} aria-hidden="true">
          <span className="text-7xl font-black leading-none tracking-[-0.08em] text-ink/25">SP</span>
        </div>
      </section>
    </>
  );
}

function ScheduleEmbedBody({
  agenda,
  error,
  onRetry,
  design,
}: ScheduleEmbedContentProps & { readonly design: EmbedDesign }) {
  if (agenda === undefined) {
    return (
      <>
        <ScheduleMasthead label="Tuning feed" design={design} />
        <div className="grid gap-5 md:grid-cols-[1fr_16rem]">
          <Skeleton className={`min-h-80 ${design.aesthetic === "minimal" ? "rounded-2xl" : "rounded-none"}`} />
          <Skeleton className={`min-h-80 bg-accent-soft ${design.aesthetic === "minimal" ? "rounded-2xl" : "rounded-none"}`} />
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
        design={design}
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
        design={design}
      />
    );
  }
  if (agenda === null) {
    return null;
  }
  return (
    <>
      <ScheduleMasthead label="Schedule live" design={design} />
      <section className={`mb-10 grid bg-surface lg:grid-cols-[minmax(0,1fr)_18rem] ${
        design.aesthetic === "bold"
          ? "border-2 border-line-strong shadow-[8px_8px_0_#171714]"
          : design.aesthetic === "minimal"
            ? "overflow-hidden rounded-2xl border border-line shadow-none"
            : "border-y border-line-strong bg-transparent shadow-none"
      }`}>
        <div className="p-5 sm:p-8 lg:p-10">
          <p className={`inline-block bg-accent px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] text-on-accent ${
            design.aesthetic === "bold"
              ? "-rotate-1 border-2 border-line-strong shadow-[4px_4px_0_#171714]"
              : design.aesthetic === "minimal"
                ? "rounded-full shadow-none"
                : "border border-line-strong shadow-none"
          }`}>
            The public run of show
          </p>
          <h1 className={`mt-7 max-w-3xl text-ink ${
            design.aesthetic === "editorial"
              ? "text-[clamp(3rem,8vw,6rem)] font-medium leading-[0.92] tracking-[-0.045em]"
              : "text-[clamp(3rem,9vw,6.5rem)] font-black leading-[0.82] tracking-[-0.07em]"
          }`}>
            {agenda.eventName}
          </h1>
          <p className="mt-7 max-w-2xl border-l-4 border-accent pl-4 text-base font-bold leading-7 text-ink-secondary sm:text-lg">
            Every session, room, and speaker in the latest published program.
          </p>
        </div>
        <dl className={`grid border-line-strong lg:border-t-0 ${design.aesthetic === "bold" ? "border-t-2 lg:border-l-2" : "border-t lg:border-l"}`}>
          {[
            ["Venue", agenda.location ?? "Online", "bg-production-sky"],
            ["Audience clock", agenda.timezone, "bg-production-lime"],
            ["Live revision", String(agenda.revision).padStart(2, "0"), "bg-production-yellow"],
          ].map(([term, detail, color], index) => (
            <div className={`flex flex-col justify-center px-5 py-5 ${design.aesthetic === "bold" ? color : "bg-surface-muted"} ${index > 0 ? `${design.aesthetic === "bold" ? "border-t-2" : "border-t"} border-line-strong` : ""}`} key={term}>
              <dt className={`text-[10px] font-black uppercase tracking-[0.14em] ${design.aesthetic === "bold" ? "text-ink" : "text-ink-secondary"}`}>{term}</dt>
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
          <p className={`bg-accent-soft px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] ${
            design.aesthetic === "bold" ? "border-2 border-line-strong shadow-[3px_3px_0_#171714]" : design.aesthetic === "minimal" ? "rounded-full" : "border border-line-strong"
          }`}>
            {agenda.talks.length} {agenda.talks.length === 1 ? "session" : "sessions"}
          </p>
        </div>
        <PublishedSchedule agenda={agenda} aesthetic={design.aesthetic} />
      </section>

      <footer className={`mt-12 flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-5 ${
        design.aesthetic === "bold" ? "border-2 border-line-strong bg-ink text-on-accent" : "border-t border-line-strong bg-transparent text-ink"
      }`}>
        <p className={`text-[10px] font-black uppercase tracking-[0.14em] ${design.aesthetic === "bold" ? "text-white/55" : "text-ink-secondary"}`}>Session Party · Audience feed</p>
        <p className={`text-[10px] font-bold uppercase tracking-[0.1em] ${design.aesthetic === "bold" ? "text-white/70" : "text-ink-secondary"}`}>
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

export function ScheduleEmbedContent({
  design = DEFAULT_EMBED_DESIGN,
  ...props
}: ScheduleEmbedContentProps) {
  return (
    <div
      className={embedTypographyClass(design.aesthetic)}
      data-embed-aesthetic={design.aesthetic}
      style={embedDesignStyle(design)}
    >
      <ScheduleEmbedBody {...props} design={design} />
    </div>
  );
}

export default function ScheduleEmbedPage() {
  const { eventSlug = "" } = useParams();
  const [searchParams] = useSearchParams();
  const design = embedDesignFromSearch(searchParams);
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
    <main
      className={`${design.aesthetic === "bold" ? "production-grid" : ""} min-h-dvh bg-canvas px-3 py-5 text-ink sm:px-8 sm:py-8 lg:px-10 lg:py-10 ${embedTypographyClass(design.aesthetic)}`}
      data-embed-aesthetic={design.aesthetic}
      style={embedDesignStyle(design)}
    >
      <div className="mx-auto w-full max-w-6xl">
        <ScheduleEmbedContent
          agenda={agenda}
          error={error}
          onRetry={() => setRequest((current) => current + 1)}
          design={design}
        />
      </div>
    </main>
  );
}
