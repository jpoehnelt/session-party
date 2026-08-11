import type { APIRequestContext } from "@playwright/test";

const EVENT_ID = "demo-event";
const EVENT_SLUG = "ai-engineer-sandbox";
const OWNER_HEADERS = { Cookie: "sp_session=demo-owner-session" };

export interface PublicRouteFixtures {
  readonly talkId: string;
  readonly speakerId: string;
  readonly embedId: string;
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string): Promise<T> {
  if (!response.ok()) throw new Error(`${label} returned ${response.status()}`);
  return response.json() as Promise<T>;
}

export async function loadPublicRouteFixtures(request: APIRequestContext): Promise<PublicRouteFixtures> {
  const [agenda, gallery, embeds] = await Promise.all([
    request.get(`/api/v1/public/events/${EVENT_SLUG}/agenda/published`).then((response) => json<{
      readonly talks: readonly { readonly id: string }[];
    }>(response, "published agenda")),
    request.get(`/api/v1/public/events/${EVENT_SLUG}/speakers`).then((response) => json<{
      readonly speakers: readonly { readonly id: string }[];
    }>(response, "published speaker gallery")),
    request.get(`/api/v1/events/${EVENT_ID}/embeds`, { headers: OWNER_HEADERS }).then((response) => json<readonly {
      readonly id: string;
      readonly enabled: boolean;
    }[]>(response, "embed definitions")),
  ]);
  const talkId = agenda.talks[0]?.id;
  const speakerId = gallery.speakers[0]?.id;
  if (!talkId) throw new Error("published agenda has no talk fixture");
  if (!speakerId) throw new Error("published speaker gallery has no speaker fixture");

  let embedId = embeds.find(({ enabled }) => enabled)?.id;
  if (!embedId) {
    const created = await request.post(`/api/v1/events/${EVENT_ID}/embeds`, {
      headers: OWNER_HEADERS,
      data: {
        eventId: EVENT_ID,
        name: "QA public route inventory",
        widget: "schedule",
        preset: "agenda",
        aesthetic: "minimal",
        accent: "#7857ff",
        trackId: null,
        track: null,
        fields: ["title", "time", "room", "track", "speakers", "description"],
        enabled: true,
      },
    });
    embedId = (await json<{ readonly id: string }>(created, "create embed definition")).id;
  }

  return { talkId, speakerId, embedId };
}

export function resolvePublicRoutePath(path: string, fixtures: PublicRouteFixtures): string {
  return path
    .replace("__qa_public_talk__", encodeURIComponent(fixtures.talkId))
    .replace("__qa_public_speaker__", encodeURIComponent(fixtures.speakerId))
    .replace("__qa_public_embed__", encodeURIComponent(fixtures.embedId));
}
