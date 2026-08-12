import { API } from "contracts/routes";

export const PUBLIC_HEADSHOT_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const publicSpeakerHeadshotPath = (
  eventSlug: string,
  speakerId: string,
  assetId: string,
  publicationRevision: number,
): string =>
  `${API}/public/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}/headshots/${encodeURIComponent(assetId)}/r${publicationRevision}`;

export const portalAssetKey = (eventId: string, assetId: string): string =>
  `portal/${eventId}/${assetId}`;
