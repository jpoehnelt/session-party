interface SpeakerLinksProps {
  readonly eventSlug?: string;
  readonly speakerIds: readonly string[];
  readonly speakerNames: readonly string[];
  readonly className?: string;
  readonly emptyLabel?: string;
}

export function SpeakerLinks({
  eventSlug,
  speakerIds,
  speakerNames,
  className,
  emptyLabel = "Speakers TBA",
}: SpeakerLinksProps) {
  if (speakerNames.length === 0) return <span className={className}>{emptyLabel}</span>;

  return (
    <span className={className}>
      {speakerNames.map((name, index) => {
        const speakerId = speakerIds[index];
        const content = eventSlug && speakerId ? (
          <a
            className="underline decoration-2 underline-offset-2 hover:text-accent"
            href={`/e/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}`}
            onClick={(event) => event.stopPropagation()}
          >
            {name}
          </a>
        ) : name;
        return <span key={`${speakerId ?? name}:${index}`}>{index > 0 && ", "}{content}</span>;
      })}
    </span>
  );
}
