import { EntityId } from "contracts/domain";
import { NotFound, toPublicAppError, Validation } from "contracts/errors";
import { Schema } from "effect";
import { Hono, type Context } from "hono";
import { getPublishedAgendaOperation } from "@/features/agenda/operations";
import { PublishedAgenda, type PublishedAgenda as PublishedAgendaType } from "@/features/agenda/schema";
import { runRestOperation } from "@/server/adapt";
import { renderPublishedCalendar } from "./feeds";

type FeedContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

const requestIdFor = (c: FeedContext): string =>
  c.req.header("x-request-id") ?? crypto.randomUUID();

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
  kind: "calendar" | "json",
  talkId?: string,
): Headers => {
  const suffix = talkId ? `session-${talkId}` : "schedule";
  const extension = kind === "calendar" ? "ics" : "json";
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": CACHE_CONTROL,
    "Content-Disposition": `inline; filename="${agenda.eventSlug}-${suffix}.${extension}"`,
    "Content-Type": kind === "calendar"
      ? "text/calendar; charset=utf-8"
      : "application/json; charset=utf-8",
    ETag: `"${agenda.eventId}:r${agenda.revision}:${suffix}:${extension}"`,
    "Last-Modified": new Date(agenda.publishedAt).toUTCString(),
    "X-Content-Type-Options": "nosniff",
    "X-Session-Party-Revision": String(agenda.revision),
  });
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
  const headers = feedHeaders(loaded.agenda, "json");
  return notModified(c, headers)
    ?? new Response(JSON.stringify(loaded.agenda), { status: 200, headers });
});

app.get("/events/:eventSlug/schedule.ics", async (c) => {
  const loaded = await loadPublishedAgenda(c);
  if ("response" in loaded) return loaded.response;
  const headers = feedHeaders(loaded.agenda, "calendar");
  return notModified(c, headers)
    ?? new Response(renderPublishedCalendar(loaded.agenda), { status: 200, headers });
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
