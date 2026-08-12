import type { PublicSpeaker } from "@/features/portal/schema";
import type { EmbedDefinition } from "./schema";

const segment = (value: string) => encodeURIComponent(value);

export const publicSessionPath = (eventSlug: string, talkId: string) =>
  `/event/${segment(eventSlug)}/sessions/${segment(talkId)}`;

export const publicEventSpeakerPath = (eventSlug: string, speaker: Pick<PublicSpeaker, "id">) =>
  `/event/${segment(eventSlug)}/speakers/${segment(speaker.id)}`;

export const stableEmbedPath = (definition: Pick<EmbedDefinition, "eventSlug" | "id">): string =>
  `/embed/${segment(definition.eventSlug)}/${segment(definition.id)}`;

export const stableEmbedCode = (
  definition: Pick<EmbedDefinition, "eventSlug" | "id" | "name">,
  origin: string,
): string =>
  `<iframe title="${definition.name.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" src="${origin}${stableEmbedPath(definition)}" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>`;
