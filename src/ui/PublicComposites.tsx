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
    <ul className={cx(mode === "grid" ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" : "space-y-3", className)}>
      {speakers.map((speaker) => (
        <li key={speaker.id}>
          <Card className="h-full">
            <button
              type="button"
              disabled={onSelect == null}
              onClick={() => onSelect?.(speaker)}
              className="w-full rounded-control text-left outline-none enabled:focus-visible:ring-2 enabled:focus-visible:ring-accent/40 disabled:cursor-default"
            >
              <div className="flex items-start gap-3">
                <Avatar name={speaker.displayName} src={speaker.headshotUrl} size="lg" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink">{speaker.displayName}</h3>
                  {(speaker.title || speaker.company) && (
                    <p className="text-sm text-ink-secondary">{[speaker.title, speaker.company].filter(Boolean).join(" at ")}</p>
                  )}
                </div>
              </div>
              {mode === "grid" && speaker.bio && (
                <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-ink-secondary">{speaker.bio}</p>
              )}
            </button>
            {speaker.links && speaker.links.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {speaker.links.map((link) => (
                  <a key={`${link.label}-${link.url}`} href={link.url} className="text-sm font-medium text-accent-deep underline-offset-2 hover:underline">
                    {link.label}
                  </a>
                ))}
              </div>
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
  description?: string;
  track?: string;
  room?: string;
  startsAt: string;
  durationMin: number;
  speakerNames: readonly string[];
}

export interface ScheduleListProps {
  timezone: string;
  talks: readonly ScheduleListItem[];
  empty?: string;
  className?: string;
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
}: ScheduleListProps) {
  if (talks.length === 0) {
    return <EmptyState title={empty} description="Published sessions will appear here." />;
  }
  const ordered = [...talks].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  return (
    <ol className={cx("divide-y divide-line rounded-card border border-line bg-surface", className)}>
      {ordered.map((talk) => (
        <li key={talk.id} className="grid gap-2 px-4 py-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-5">
          <div>
            <time dateTime={talk.startsAt} className="text-sm font-semibold text-ink">{formatTime(talk.startsAt, timezone)}</time>
            <p className="text-xs text-ink-faint">{talk.durationMin} min · {timezone}</p>
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-ink">{talk.title}</h3>
            <p className="mt-1 text-sm text-ink-secondary">{talk.speakerNames.join(", ")}</p>
            {(talk.room || talk.track) && (
              <p className="mt-1 text-xs text-ink-faint">{[talk.room, talk.track].filter(Boolean).join(" · ")}</p>
            )}
            {talk.description && <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{talk.description}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
