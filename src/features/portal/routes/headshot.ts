import { useEffect, useState } from "react";
import type { DownloadContentOutput } from "../schema";
import { downloadContent } from "./api";

const HEADSHOT_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function downloadedHeadshotDataUrl(download: DownloadContentOutput): string | null {
  if (!HEADSHOT_CONTENT_TYPES.has(download.asset.contentType)) return null;
  return `data:${download.asset.contentType};base64,${download.contentBase64}`;
}

export function preferredHeadshotUrl(
  downloadedUrl: string | null,
  fallbackUrl: string | null,
): string | undefined {
  return downloadedUrl ?? fallbackUrl ?? undefined;
}

export function useDownloadedHeadshot(
  eventId: string,
  assetId: string | null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setUrl(null);
    if (assetId === null) return () => { active = false; };

    void downloadContent(eventId, { eventId, assetId }).then(
      (download) => {
        if (active) setUrl(downloadedHeadshotDataUrl(download));
      },
      () => {
        if (active) setUrl(null);
      },
    );
    return () => { active = false; };
  }, [assetId, eventId]);

  return url;
}
