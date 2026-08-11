import type { PublishedAgenda } from "@/features/agenda/schema";

export const SCHEDULE_EMBED_FIELDS = [
  "title",
  "time",
  "room",
  "track",
  "speakers",
  "description",
] as const;

export type ScheduleEmbedField = typeof SCHEDULE_EMBED_FIELDS[number];

export interface EmbedContentSelection {
  readonly track: string | null;
  readonly fields: readonly ScheduleEmbedField[];
}

export function embedContentFromSearch(search: string | URLSearchParams): EmbedContentSelection {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const track = params.get("track")?.trim() || null;
  const allowed = new Set<string>(SCHEDULE_EMBED_FIELDS);
  const fields = params.has("fields")
    ? [...new Set((params.get("fields") ?? "").split(",").map((field) => field.trim()).filter((field): field is ScheduleEmbedField => allowed.has(field)))]
    : [...SCHEDULE_EMBED_FIELDS];
  return { track, fields };
}

export function filterPublishedAgenda(
  agenda: PublishedAgenda,
  track: string | null,
  trackId?: string | null,
): PublishedAgenda {
  if (trackId) return { ...agenda, talks: agenda.talks.filter((talk) => talk.trackId === trackId) };
  if (!track) return agenda;
  return { ...agenda, talks: agenda.talks.filter((talk) => talk.track === track) };
}

export function projectPublishedAgenda(
  agenda: PublishedAgenda,
  fields: readonly ScheduleEmbedField[],
) {
  const visible = new Set(fields);
  return {
    ...agenda,
    talks: agenda.talks.map((talk) => ({
      id: talk.id,
      ...(visible.has("title") ? { title: talk.title } : {}),
      ...(visible.has("description") ? { description: talk.description } : {}),
      ...(visible.has("track") ? {
        ...(talk.trackId === undefined ? {} : { trackId: talk.trackId }),
        track: talk.track,
      } : {}),
      ...(visible.has("room") ? { room: talk.room } : {}),
      ...(visible.has("time") ? { startsAt: talk.startsAt, durationMin: talk.durationMin } : {}),
      ...(visible.has("speakers") ? { speakerNames: talk.speakerNames } : {}),
    })),
  };
}
