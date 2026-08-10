import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Schema } from "effect";
import { ApiError, apiFetch } from "@/client/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Toaster,
  toast,
} from "@/ui";
import { EventAccess, EventOutput } from "../schema";

export type EventSummary = typeof EventOutput.Type;
export type EventAccessSummary = typeof EventAccess.Type;

export const path = "/events";
export const contentWidth = "standard" as const;

type EventPhase = "live" | "planning" | "needs-dates" | "complete";

const PHASE_PRESENTATION: Record<EventPhase, { label: string; tone: "neutral" | "success" | "warning" | "accent" }> = {
  live: { label: "Live now", tone: "success" },
  planning: { label: "In production", tone: "accent" },
  "needs-dates": { label: "Needs dates", tone: "warning" },
  complete: { label: "Complete", tone: "neutral" },
};

const EVENT_TONES = [
  "[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink",
  "[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink",
  "[&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink",
] as const;

const PRODUCTION_LANES = [
  { index: "01", label: "Forms & CFP", description: "Collect and route proposals", segment: "forms", tone: "bg-surface-muted" },
  { index: "02", label: "Review", description: "Score and select the program", segment: "review", tone: "bg-surface-muted" },
  { index: "03", label: "Speakers", description: "Track onboarding readiness", segment: "speakers", tone: "bg-surface-muted" },
  { index: "04", label: "Agenda", description: "Build the conflict-free run of show", segment: "agenda", tone: "bg-surface-muted" },
] as const;

export function eventPhase(event: EventSummary, now = new Date()): EventPhase {
  if (event.startsAt && event.startsAt <= now && (!event.endsAt || event.endsAt >= now)) {
    return "live";
  }
  if (event.endsAt && event.endsAt < now) return "complete";
  return event.startsAt ? "planning" : "needs-dates";
}

export function prioritizeEvents(events: readonly EventSummary[], now = new Date()): EventSummary[] {
  const rank = (event: EventSummary) => {
    const phase = eventPhase(event, now);
    if (phase === "live") return [0, event.startsAt?.getTime() ?? 0] as const;
    if (phase === "planning") return [1, event.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER] as const;
    if (phase === "needs-dates") return [2, -event.updatedAt.getTime()] as const;
    return [3, -(event.endsAt?.getTime() ?? 0)] as const;
  };

  return [...events].sort((left, right) => {
    const [leftGroup, leftDate] = rank(left);
    const [rightGroup, rightDate] = rank(right);
    return leftGroup - rightGroup || leftDate - rightDate || left.name.localeCompare(right.name);
  });
}

export function eventAccessDestinations(access: EventAccessSummary) {
  const base = `/e/${access.event.slug}`;
  return [
    ...(access.memberRole === "owner" || access.memberRole === "admin"
      ? [{ label: "Organizer dashboard", role: "Organizer", to: `${base}/dashboard` }]
      : []),
    ...(access.memberRole === "reviewer"
      ? [{ label: "Review workbench", role: "Reviewer", to: `${base}/review` }]
      : []),
    ...(access.speakerPortal
      ? [{ label: "Speaker portal", role: "Speaker", to: `${base}/portal` }]
      : []),
  ] as const;
}

export function formatEventDates(event: Pick<EventSummary, "startsAt" | "endsAt" | "timezone">): string {
  if (!event.startsAt) return "Dates not set";
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: event.timezone,
  });
  if (!event.endsAt) return formatter.format(event.startsAt);

  const dayKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: event.timezone,
  });
  if (dayKey.format(event.startsAt) === dayKey.format(event.endsAt)) {
    return formatter.format(event.startsAt);
  }
  return `${formatter.format(event.startsAt)} — ${formatter.format(event.endsAt)}`;
}

export function slugifyEventName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function setupState(event: EventSummary) {
  const fields = [event.description, event.location, event.startsAt, event.endsAt, event.accentColor];
  const complete = fields.filter(Boolean).length;
  const base = `/e/${event.slug}`;

  if (!event.startsAt || !event.endsAt) {
    return {
      complete,
      label: "Set the run dates",
      description: "Dates unlock schedule and communications timing.",
      to: `${base}/settings`,
    };
  }
  if (!event.location) {
    return {
      complete,
      label: "Add the venue",
      description: "Give speakers and organizers a shared destination.",
      to: `${base}/settings`,
    };
  }
  if (!event.description) {
    return {
      complete,
      label: "Write the event brief",
      description: "A clear brief keeps forms, reviews, and publishing aligned.",
      to: `${base}/settings`,
    };
  }
  return {
    complete,
    label: "Shape the program",
    description: "Open the CFP, review proposals, and build the agenda.",
    to: `${base}/forms`,
  };
}

function PhaseBadge({ event, now }: { event: EventSummary; now: Date }) {
  const presentation = PHASE_PRESENTATION[eventPhase(event, now)];
  return <Badge tone={presentation.tone}>{presentation.label}</Badge>;
}

export function EventsWorkspace({ access, now = new Date() }: { access: readonly EventAccessSummary[]; now?: Date }) {
  const orderedAccess = useMemo(() => {
    const eventOrder = prioritizeEvents(access.map(({ event }) => event), now);
    const rankById = new Map(eventOrder.map((event, index) => [event.id, index]));
    return [...access].sort((left, right) =>
      (rankById.get(left.event.id) ?? Number.MAX_SAFE_INTEGER) -
      (rankById.get(right.event.id) ?? Number.MAX_SAFE_INTEGER));
  }, [access, now]);
  const featuredAccess = orderedAccess[0];
  if (!featuredAccess) return null;

  const featured = featuredAccess.event;
  const otherAccess = orderedAccess.slice(1);
  const setup = setupState(featured);
  const setupPercent = `${Math.round((setup.complete / 5) * 100)}%`;
  const featuredBase = `/e/${featured.slug}`;
  const featuredDestinations = eventAccessDestinations(featuredAccess);
  const featuredOrganizer = featuredAccess.memberRole === "owner" || featuredAccess.memberRole === "admin";

  return (
    <div className="space-y-10">
      <section aria-labelledby="featured-event-heading">
        <div className="mb-3 flex items-center justify-between gap-4">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-ink-secondary">
            Active workspace
          </p>
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">
            {String(1).padStart(2, "0")} / {String(access.length).padStart(2, "0")}
          </p>
        </div>
        <Card
          className="overflow-hidden [&>div]:p-0 [&>header]:bg-surface-muted [&>header]:text-ink [&>header_h3]:text-ink"
          title={(
            <span className="flex items-center justify-between gap-4">
              <span>Featured event</span>
              <span className="font-semibold normal-case tracking-normal opacity-70">
                Updated {featured.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            </span>
          )}
        >
          <div className="grid lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.7fr)]">
            <div className="p-6 sm:p-8 lg:p-10">
              <div className="flex flex-wrap items-center gap-2">
                <PhaseBadge event={featured} now={now} />
                <Badge>{featured.timezone.replaceAll("_", " ")}</Badge>
                {featuredDestinations.map(({ role }) => <Badge key={role} tone="accent">{role}</Badge>)}
              </div>
              <h2 id="featured-event-heading" className="mt-6 max-w-3xl text-4xl font-black leading-[0.94] tracking-[-0.055em] sm:text-6xl">
                {featured.name}
              </h2>
              <p className="mt-5 max-w-2xl text-base font-semibold leading-7 text-ink-secondary sm:text-lg">
                {featured.description || "This workspace is ready for its production brief."}
              </p>

              <dl className="mt-8 grid border-y-2 border-line-strong sm:grid-cols-2">
                <div className="border-b-2 border-line-strong py-4 sm:border-b-0 sm:border-r-2 sm:pr-5">
                  <dt className="text-[10px] font-black uppercase tracking-[0.13em] text-ink-faint">Run dates</dt>
                  <dd className="mt-1 text-sm font-black text-ink">{formatEventDates(featured)}</dd>
                </div>
                <div className="py-4 sm:pl-5">
                  <dt className="text-[10px] font-black uppercase tracking-[0.13em] text-ink-faint">Location</dt>
                  <dd className="mt-1 text-sm font-black text-ink">{featured.location || "Venue not set"}</dd>
                </div>
              </dl>

              <div className="mt-8 flex flex-wrap gap-3">
                {featuredDestinations.map(({ label, role, to }, index) => (
                  <Link
                    className={`inline-flex min-h-11 items-center border-2 border-line-strong px-4 py-2 text-xs font-black uppercase tracking-[0.08em] text-ink shadow-button transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-3 ${index === 0 ? "bg-accent hover:bg-accent-hover" : "bg-surface hover:bg-production-sky"}`}
                    key={role}
                    to={to}
                  >
                    {label} →
                  </Link>
                ))}
              </div>
            </div>

            {featuredOrganizer ? (
              <aside className="border-t-2 border-line-strong bg-ink p-6 text-on-accent lg:border-l-2 lg:border-t-0 lg:p-8">
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/55">Event setup</p>
                <div className="mt-3 flex items-end justify-between gap-4">
                  <p className="text-4xl font-black tracking-[-0.05em]">{setup.complete}/5</p>
                  <p className="pb-1 text-[10px] font-black uppercase tracking-[0.1em] text-white/55">details ready</p>
                </div>
                <div className="mt-4 h-3 border-2 border-white bg-white/15" aria-label={`${setup.complete} of 5 event details ready`}>
                  <div className="h-full bg-production-lime" style={{ width: setupPercent }} />
                </div>

                <div className="mt-8 border-2 border-white/35 p-5">
                  <p className="text-[10px] font-black uppercase tracking-[0.14em] text-production-yellow">Next cue</p>
                  <h3 className="mt-3 text-xl font-black leading-tight">{setup.label}</h3>
                  <p className="mt-2 text-sm font-semibold leading-6 text-white/65">{setup.description}</p>
                  <Link className="mt-5 inline-block text-xs font-black uppercase tracking-[0.1em] text-production-lime underline decoration-2 underline-offset-4" to={setup.to}>
                    Take the next step →
                  </Link>
                </div>
              </aside>
            ) : (
              <aside className="border-t-2 border-line-strong bg-ink p-6 text-on-accent lg:border-l-2 lg:border-t-0 lg:p-8">
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/55">Your event access</p>
                <p className="mt-4 text-3xl font-black tracking-[-0.05em]">Choose your workspace.</p>
                <p className="mt-3 text-sm font-semibold leading-6 text-white/65">Each destination checks this account’s current event relationship.</p>
              </aside>
            )}
          </div>

          {featuredOrganizer && (
            <div className="grid border-t-2 border-line-strong sm:grid-cols-2 xl:grid-cols-4">
              {PRODUCTION_LANES.map((lane) => (
                <Link
                  className="group flex min-h-28 items-start gap-4 border-b-2 border-line-strong p-5 text-inherit transition-colors hover:bg-surface-muted sm:[&:nth-child(odd)]:border-r-2 xl:border-b-0 xl:border-r-2 xl:last:border-r-0"
                  key={lane.segment}
                  to={`${featuredBase}/${lane.segment}`}
                >
                  <span className={`grid size-9 shrink-0 place-items-center border-2 border-line-strong text-[10px] font-black ${lane.tone}`}>
                    {lane.index}
                  </span>
                  <span>
                    <span className="block text-xs font-black uppercase tracking-[0.08em] group-hover:text-accent-deep">{lane.label} →</span>
                    <span className="mt-1.5 block text-xs font-semibold leading-5 text-ink-secondary">{lane.description}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </section>

      {otherAccess.length > 0 && (
        <section aria-labelledby="other-events-heading">
          <div className="mb-4 flex items-end justify-between gap-4 border-b-2 border-line-strong pb-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-accent-deep">All workspaces</p>
              <h2 id="other-events-heading" className="mt-1 text-2xl font-black tracking-[-0.035em]">Other events</h2>
            </div>
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-faint">{otherAccess.length} more</p>
          </div>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {otherAccess.map((eventAccess, index) => {
              const event = eventAccess.event;
              return (
                <Card className={`h-full ${EVENT_TONES[index % EVENT_TONES.length]}`} key={event.id} title={event.name}>
                  <div className="flex flex-wrap items-center gap-2">
                    <PhaseBadge event={event} now={now} />
                    <span className="text-[10px] font-black uppercase tracking-[0.08em] text-ink-faint">{formatEventDates(event)}</span>
                  </div>
                  <p className="mt-4 min-h-12 text-sm font-semibold leading-6 text-ink-secondary">
                    {event.description || event.location || "Ready for its production brief."}
                  </p>
                  <div className="mt-5 flex flex-wrap gap-3 border-t-2 border-line-strong pt-3">
                    {eventAccessDestinations(eventAccess).map(({ label, role, to }) => (
                      <Link className="text-[10px] font-black uppercase tracking-[0.12em] text-accent-deep underline decoration-2 underline-offset-4" key={role} to={to}>
                        {label} →
                      </Link>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

export function fetchEvents(): Promise<readonly EventSummary[]> {
  return apiFetch("/api/v1/events", { schema: Schema.Array(EventOutput) });
}

export function fetchEventAccess(): Promise<readonly EventAccessSummary[]> {
  return apiFetch("/api/v1/me/events", { schema: Schema.Array(EventAccess) });
}

export default function EventsHome() {
  const [access, setAccess] = useState<readonly EventAccessSummary[] | null>(null);
  const navigate = useNavigate();
  const [loadError, setLoadError] = useState<"unauthenticated" | "failed" | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetchEventAccess()
      .then((loadedAccess) => {
        setAccess(loadedAccess);
        setLoadError(null);
      })
      .catch((error) => {
        const unauthenticated = error instanceof ApiError && error.status === 401;
        setLoadError(unauthenticated ? "unauthenticated" : "failed");
        if (!unauthenticated) {
          toast(error instanceof Error ? error.message : "Could not load events", { tone: "danger" });
        }
      });
  }, []);

  const create = async () => {
    setSaving(true);
    try {
      const event = await apiFetch<EventSummary>("/api/v1/events", {
        method: "POST",
        body: { name, slug },
        schema: EventOutput,
      });
      setOpen(false);
      setName("");
      setSlug("");
      setSlugEdited(false);
      toast("Event created", { tone: "success" });
      navigate(`/e/${event.slug}/settings`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not create event", { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const onNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugifyEventName(value));
  };

  return (
    <>
      <PageHeader
        title="Event control room"
        description="Your production workspaces, the next cue for each event, and a direct route into the work."
        actions={
          access !== null && loadError === null ? (
            <Button onClick={() => setOpen(true)}>Create event</Button>
          ) : undefined
        }
      />
      {loadError === "unauthenticated" ? (
        <EmptyState
          title="Sign in to start planning"
          description="Sign in, then create your first event to begin building the program."
          action={<Button className="min-h-11" onClick={() => navigate("/login")}>Sign in</Button>}
        />
      ) : loadError === "failed" ? (
        <EmptyState
          title="Events could not be loaded"
          description="Refresh the page to try again. Your event data has not been changed."
        />
      ) : access === null ? (
        <Skeleton />
      ) : access.length === 0 ? (
        <EmptyState
          title="Create your first event"
          description="Start with the basics, then invite your team and speakers."
          action={<Button onClick={() => setOpen(true)}>Create event</Button>}
        />
      ) : (
        <EventsWorkspace access={access} />
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Create an event">
        <div className="space-y-4">
          <Input label="Event name" value={name} onChange={(event) => onNameChange(event.target.value)} />
          <Input
            label="Slug"
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
          />
          <p className="text-xs font-semibold leading-5 text-ink-secondary">
            This becomes the event URL. You can change it later in settings.
          </p>
          <Button className="w-full" disabled={saving || !name.trim() || slug.length < 2} loading={saving} onClick={() => void create()}>
            Create event and continue
          </Button>
        </div>
      </Modal>
      <Toaster />
    </>
  );
}
