import type { PublicSpeaker } from "@/features/portal/schema";

const segment = (value: string) => encodeURIComponent(value);

export const publicSessionPath = (eventSlug: string, talkId: string) =>
  `/event/${segment(eventSlug)}/sessions/${segment(talkId)}`;

export const publicEventSpeakerPath = (eventSlug: string, speaker: Pick<PublicSpeaker, "id" | "publicProfileSlug">) =>
  speaker.publicProfileSlug
    ? `/speakers/${segment(speaker.publicProfileSlug)}`
    : `/event/${segment(eventSlug)}/speakers/${segment(speaker.id)}`;
