import { EntityId } from "contracts/domain";
import { NotFound, toPublicAppError, Validation } from "contracts/errors";
import { Schema } from "effect";
import { Hono, type Context } from "hono";
import { getPublishedAgendaOperation } from "@/features/agenda/operations";
import { PublishedAgenda, type PublishedAgenda as PublishedAgendaType } from "@/features/agenda/schema";
import { runRestOperation } from "@/server/adapt";
import {
  renderPublishedCalendar,
  renderPublishedScheduleHtml,
  renderPublishedScheduleXml,
} from "./feeds";
import {
  embedContentFromSearch,
  filterPublishedAgenda,
  projectPublishedAgenda,
  SCHEDULE_EMBED_FIELDS,
  type ScheduleEmbedField,
} from "./embed-content";

type FeedContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

const requestIdFor = (c: FeedContext): string =>
  c.req.header("x-request-id") ?? crypto.randomUUID();

const contentFingerprint = (agenda: PublishedAgendaType): string => {
  const source = JSON.stringify({
    eventName: agenda.eventName,
    eventSlug: agenda.eventSlug,
    timezone: agenda.timezone,
    location: agenda.location,
    talks: agenda.talks,
  });
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const publicError = (
  c: FeedContext,
  error: NotFound | Validation,
  status: 400 | 404,
): Response => c.json(toPublicAppError(error, requestIdFor(c)), status);

const loadPublishedAgenda = async (
  c: FeedContext,
): Promise<{ readonly agenda: PublishedAgendaType } | { readonly response: Response }> => {
  const response = await runRestOperation(
    c,
    null,
    getPublishedAgendaOperation,
    { path: ["eventSlug"] },
  );
  if (!response.ok) return { response };
  return { agenda: Schema.decodeUnknownSync(PublishedAgenda)(await response.json()) };
};

const feedHeaders = (
  agenda: PublishedAgendaType,
  kind: "calendar" | "json" | "xml" | "html",
  talkId?: string,
  track?: string | null,
  fields: readonly ScheduleEmbedField[] = SCHEDULE_EMBED_FIELDS,
): Headers => {
  const suffix = talkId ? `session-${talkId}` : "schedule";
  const extension = kind === "calendar" ? "ics" : kind;
  const revision = kind === "calendar" ? agenda.calendarRevision ?? agenda.revision : agenda.revision;
  const updatedAt = kind === "calendar" ? agenda.calendarUpdatedAt ?? agenda.publishedAt : agenda.publishedAt;
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": CACHE_CONTROL,
    "Content-Disposition": `inline; filename="${agenda.eventSlug}-${suffix}.${extension}"`,
    "Content-Type": kind === "calendar"
      ? "text/calendar; charset=utf-8"
      : kind === "json"
        ? "application/json; charset=utf-8"
        : kind === "xml"
          ? "application/xml; charset=utf-8"
          : "text/html; charset=utf-8",
    ETag: `"${agenda.eventId}:r${revision}:c${contentFingerprint(agenda)}:${suffix}:${extension}${track ? `:track:${encodeURIComponent(track)}` : ""}:fields:${[...fields].sort().join(".")}"`,
    "Last-Modified": new Date(updatedAt).toUTCString(),
    "X-Content-Type-Options": "nosniff",
    "X-Session-Party-Revision": String(revision),
  });
  if (kind === "html") {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors *",
    );
  }
  return headers;
};

const notModified = (c: FeedContext, headers: Headers): Response | null => {
  const requestEtags = c.req.header("if-none-match")?.split(",").map((value) => value.trim());
  const etag = headers.get("etag");
  return etag && requestEtags?.some((value) => value === "*" || value === etag)
    ? new Response(null, { status: 304, headers })
    : null;
};

app.get("/events/:eventSlug/schedule.json", async (c) => {
  const loaded = await loadPublishedAgenda(c);
  if ("response" in loaded) return loaded.response;
  const selection = embedContentFromSearch(new URL(c.req.url).searchParams);
  const agenda = filterPublishedAgenda(loaded.agenda, selection.track);
  const headers = feedHeaders(agenda, "json", undefined, selection.track, selection.fields);
  return notModified(c, headers)
    ?? new Response(JSON.stringify(projectPublishedAgenda(agenda, selection.fields)), { status: 200, headers });
});

app.get("/events/:eventSlug/schedule.xml", async (c) => {
  const loaded = await loadPublishedAgenda(c);
  if ("response" in loaded) return loaded.response;
  const selection = embedContentFromSearch(new URL(c.req.url).searchParams);
  const agenda = filterPublishedAgenda(loaded.agenda, selection.track);
  const headers = feedHeaders(agenda, "xml", undefined, selection.track, selection.fields);
  return notModified(c, headers)
    ?? new Response(renderPublishedScheduleXml(agenda, selection.fields), { status: 200, headers });
});

app.get("/events/:eventSlug/schedule.html", async (c) => {
  const loaded = await loadPublishedAgenda(c);
  if ("response" in loaded) return loaded.response;
  const selection = embedContentFromSearch(new URL(c.req.url).searchParams);
  const agenda = filterPublishedAgenda(loaded.agenda, selection.track);
  const headers = feedHeaders(agenda, "html", undefined, selection.track, selection.fields);
  return notModified(c, headers)
    ?? new Response(renderPublishedScheduleHtml(agenda, selection.fields), { status: 200, headers });
});

app.get("/events/:eventSlug/schedule.ics", async (c) => {
  const loaded = await loadPublishedAgenda(c);
  if ("response" in loaded) return loaded.response;
  const selection = embedContentFromSearch(new URL(c.req.url).searchParams);
  const agenda = filterPublishedAgenda(loaded.agenda, selection.track);
  const headers = feedHeaders(agenda, "calendar", undefined, selection.track, selection.fields);
  return notModified(c, headers)
    ?? new Response(renderPublishedCalendar(agenda, agenda.talks, selection.fields), { status: 200, headers });
});

app.get("/events/:eventSlug/sessions/:sessionFile", async (c) => {
  const sessionFile = c.req.param("sessionFile");
  if (!sessionFile.endsWith(".ics")) return c.notFound();
  const decodedTalkId = Schema.decodeUnknownEither(EntityId)(sessionFile.slice(0, -4));
  if (decodedTalkId._tag === "Left") {
    return publicError(c, new Validation({ message: "Invalid session ID" }), 400);
  }
  const loaded = await loadPublishedAgenda(c);
  if ("response" in loaded) return loaded.response;
  const talk = loaded.agenda.talks.find(({ id }) => id === decodedTalkId.right);
  if (!talk) {
    return publicError(c, new NotFound({ entity: "published session", id: decodedTalkId.right }), 404);
  }
  const headers = feedHeaders(loaded.agenda, "calendar", talk.id);
  return notModified(c, headers)
    ?? new Response(renderPublishedCalendar(loaded.agenda, [talk]), { status: 200, headers });
});

export default app;
