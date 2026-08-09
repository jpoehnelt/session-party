import { Badge, Card, EmptyState } from "@/ui";
import type { PublishedAgenda, PublicAgendaTalk } from "@/features/agenda/schema";

export interface PublishedScheduleProps {
  readonly agenda: PublishedAgenda;
  readonly compact?: boolean;
}

const dayKey = (startsAt: number, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).format(startsAt);

export function PublishedSchedule({ agenda, compact = false }: PublishedScheduleProps) {
  if (agenda.talks.length === 0) {
    return (
      <EmptyState
        title="Schedule coming soon"
        description="This schedule is published, but no sessions have been added to it yet."
      />
    );
  }

  const day = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    timeZone: agenda.timezone,
    weekday: "long",
  });
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: agenda.timezone,
  });
  const talksByDay = new Map<string, PublicAgendaTalk[]>();
  for (const talk of agenda.talks) {
    const key = dayKey(talk.startsAt, agenda.timezone);
    const talks = talksByDay.get(key) ?? [];
    talks.push(talk);
    talksByDay.set(key, talks);
  }

  return (
    <div className={compact ? "space-y-5" : "space-y-8"}>
      {[...talksByDay.entries()].map(([key, talks]) => (
        <section key={key} aria-labelledby={`schedule-day-${key}`}>
          <div className="mb-3 flex items-center gap-3">
            <h2 id={`schedule-day-${key}`} className="text-lg font-semibold text-ink">
              {day.format(talks[0]!.startsAt)}
            </h2>
            <span className="h-px flex-1 bg-line" aria-hidden="true" />
          </div>
          <div className="space-y-3 border-l-2 border-accent pl-4 sm:pl-6">
            {talks.map((talk) => (
              <Card key={talk.id} className="relative overflow-visible">
                <div className="grid gap-3 sm:grid-cols-[7rem_1fr]">
                  <div>
                    <p className="font-mono text-sm font-semibold text-accent">
                      {time.format(talk.startsAt)}
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">{talk.durationMin} min</p>
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-ink">{talk.title}</h3>
                    {talk.description ? (
                      <p className="mt-1 text-sm leading-6 text-ink-secondary">{talk.description}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
                      {talk.speakerNames.length > 0 ? <span>{talk.speakerNames.join(", ")}</span> : null}
                      {talk.track ? <Badge tone="accent">{talk.track}</Badge> : null}
                      {talk.room ? <Badge>{talk.room}</Badge> : null}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
