import { Avatar } from "./Avatar";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { cx } from "./cx";

export interface SpeakerGalleryLink {
  label: string;
  url: string;
}

export interface SpeakerGalleryItem {
  id: string;
  displayName: string;
  title?: string;
  company?: string;
  bio?: string;
  headshotUrl?: string;
  links?: readonly SpeakerGalleryLink[];
  profileUrl?: string;
}

export interface SpeakerGalleryProps {
  speakers: readonly SpeakerGalleryItem[];
  mode?: "grid" | "compact";
  onSelect?: (speaker: SpeakerGalleryItem) => void;
  className?: string;
}

export function SpeakerGallery({
  speakers,
  mode = "grid",
  onSelect,
  className,
}: SpeakerGalleryProps) {
  if (speakers.length === 0) {
    return <EmptyState title="No speakers published" description="Public speakers will appear here after they are ready." />;
  }
  return (
    <ul className={cx(mode === "grid" ? "grid gap-6 sm:grid-cols-2 lg:grid-cols-3" : "space-y-4", className)}>
      {speakers.map((speaker) => (
        <li key={speaker.id} className="transition-transform hover:-translate-y-1">
          <Card className="h-full border-line-strong">
            {onSelect ? <button
              type="button"
              onClick={() => onSelect(speaker)}
              className="w-full rounded-control text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <div className="flex items-start gap-3">
                <Avatar name={speaker.displayName} src={speaker.headshotUrl} size="lg" />
                <div className="min-w-0">
                  <h3 className="text-lg font-black tracking-[-0.025em] text-ink">{speaker.displayName}</h3>
                  {(speaker.title || speaker.company) && (
                    <p className="text-sm text-ink-secondary">{[speaker.title, speaker.company].filter(Boolean).join(" at ")}</p>
                  )}
                </div>
              </div>
              {mode === "grid" && speaker.bio && (
                <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-ink-secondary">{speaker.bio}</p>
              )}
            </button> : <div>
              <div className="flex items-start gap-3">
                <Avatar name={speaker.displayName} src={speaker.headshotUrl} size="lg" />
                <div className="min-w-0">
                  <h3 className="text-lg font-black tracking-[-0.025em] text-ink">
                    {speaker.profileUrl ? <a className="underline decoration-2 underline-offset-3 hover:text-accent-deep" href={speaker.profileUrl}>{speaker.displayName}</a> : speaker.displayName}
                  </h3>
                  {(speaker.title || speaker.company) && (
                    <p className="text-sm text-ink-secondary">{[speaker.title, speaker.company].filter(Boolean).join(" at ")}</p>
                  )}
                </div>
              </div>
              {mode === "grid" && speaker.bio && (
                <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-ink-secondary">{speaker.bio}</p>
              )}
            </div>}
            {speaker.links && speaker.links.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {speaker.links.map((link) => (
                  <a key={`${link.label}-${link.url}`} href={link.url} className="text-sm font-medium text-accent-deep underline-offset-2 hover:underline">
                    {link.label}
                  </a>
                ))}
              </div>
            )}
            {speaker.profileUrl && (
              <a href={speaker.profileUrl} className="mt-3 inline-flex text-sm font-black text-accent-deep underline decoration-2 underline-offset-4">
                Full speaker profile
              </a>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}

export interface ScheduleListItem {
  id: string;
  title: string;
  url?: string;
  description?: string;
  track?: string;
  room?: string;
  startsAt: string;
  durationMin: number;
  speakerNames: readonly string[];
  speakers?: readonly { id: string; name: string; url?: string }[];
  speakerProfiles?: readonly { name: string; slug: string }[];
}

export interface ScheduleListProps {
  timezone: string;
  talks: readonly ScheduleListItem[];
  empty?: string;
  className?: string;
  includedFields?: readonly ("title" | "time" | "room" | "track" | "speakers" | "description")[];
}

const formatTime = (value: string, timezone: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export function ScheduleList({
  timezone,
  talks,
  empty = "No sessions published",
  className,
  includedFields = ["title", "time", "room", "track", "speakers", "description"],
}: ScheduleListProps) {
  if (talks.length === 0) {
    return <EmptyState title={empty} description="Published sessions will appear here." />;
  }
  const ordered = [...talks].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const visible = new Set(includedFields);
  return (
    <ol className={cx("divide-y-2 divide-line-strong rounded-card border-2 border-line-strong bg-surface shadow-card", className)}>
      {ordered.map((talk) => (
        <li key={talk.id} className={`grid gap-0 ${visible.has("time") ? "sm:grid-cols-[10rem_minmax(0,1fr)]" : "grid-cols-1"}`}>
          {visible.has("time") && <div className="border-b-2 border-line-strong bg-ink px-4 py-4 text-on-accent sm:border-b-0 sm:border-r-2">
            <time dateTime={talk.startsAt} className="text-sm font-black uppercase text-production-lime">{formatTime(talk.startsAt, timezone)}</time>
            <p className="mt-1 text-[10px] font-black uppercase tracking-[0.08em] text-white/55">{talk.durationMin} min · {timezone}</p>
          </div>}
          <div className="min-w-0 px-4 py-4">
            {visible.has("title") && (
              <h3 className="text-lg font-black tracking-[-0.025em] text-ink">
                {talk.url ? <a className="underline decoration-2 underline-offset-3 hover:text-accent-deep" href={talk.url}>{talk.title}</a> : talk.title}
              </h3>
            )}
            {visible.has("speakers") && (
              <p className="mt-1 text-sm text-ink-secondary">
                {(talk.speakers ?? talk.speakerNames.map((name, index) => {
                  const profile = talk.speakerProfiles?.find((candidate) => candidate.name === name);
                  return { id: `${name}-${index}`, name, ...(profile ? { url: `/speakers/${encodeURIComponent(profile.slug)}` } : {}) };
                })).map((speaker, index) => {
                  return <span key={speaker.id}>{index > 0 ? ", " : ""}{speaker.url ? <a className="font-bold underline decoration-1 underline-offset-2 hover:text-accent-deep" href={speaker.url}>{speaker.name}</a> : speaker.name}</span>;
                })}
              </p>
            )}
            {((visible.has("room") && talk.room) || (visible.has("track") && talk.track)) && (
              <p className="mt-1 text-xs text-ink-secondary">{[
                visible.has("room") ? talk.room : null,
                visible.has("track") ? talk.track : null,
              ].filter(Boolean).join(" · ")}</p>
            )}
            {visible.has("description") && talk.description && <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{talk.description}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
