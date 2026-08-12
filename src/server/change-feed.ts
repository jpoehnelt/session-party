import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();
const CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=120";

interface EventRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface ChangeRow {
  readonly sequence: number;
  readonly id: string;
  readonly aggregate_type: "agenda-publication" | "speaker-publication";
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_type: "agenda/published" | "portal/speakers-published";
  readonly occurred_at: number;
}

const integerQuery = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null => {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

// The public feed is an invalidation log, not a second data projection. It
// exposes only immutable cursor metadata for the two reviewed public snapshots;
// consumers follow resourceUrl to fetch their canonical, schema-validated data.
const publicProjectionFilter = `(
  (aggregate_type = 'agenda-publication' and event_type = 'agenda/published')
  or
  (aggregate_type = 'speaker-publication' and event_type = 'portal/speakers-published')
)`;

const resourceUrl = (origin: string, eventSlug: string, type: ChangeRow["event_type"]): string =>
  new URL(
    type === "agenda/published"
      ? `/api/v1/public/events/${encodeURIComponent(eventSlug)}/agenda/published`
      : `/api/v1/public/events/${encodeURIComponent(eventSlug)}/speakers`,
    origin,
  ).toString();

app.get("/events/:eventSlug/changes.json", async (c) => {
  const after = integerQuery(c.req.query("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerQuery(c.req.query("limit"), 50, 1, 100);
  if (after === null || limit === null) {
    return c.json({
      error: "Validation",
      message: "after must be a nonnegative integer and limit must be between 1 and 100",
      requestId: c.req.header("x-request-id") ?? crypto.randomUUID(),
    }, 400);
  }

  const event = await c.env.DB.prepare(
    "select id, slug, name from events where slug = ? limit 1",
  ).bind(c.req.param("eventSlug")).first<EventRow>();
  if (!event) {
    return c.json({
      error: "NotFound",
      message: "Published event not found",
      requestId: c.req.header("x-request-id") ?? crypto.randomUUID(),
    }, 404);
  }

  const [page, head] = await Promise.all([
    c.env.DB.prepare(`
      select sequence, id, aggregate_type, aggregate_id, aggregate_version, event_type, occurred_at
      from domain_changes
      where event_id = ? and sequence > ? and ${publicProjectionFilter}
      order by sequence asc
      limit ?
    `).bind(event.id, after, limit + 1).all<ChangeRow>(),
    c.env.DB.prepare(`
      select coalesce(max(sequence), 0) as sequence
      from domain_changes
      where event_id = ? and ${publicProjectionFilter}
    `).bind(event.id).first<{ readonly sequence: number }>(),
  ]);

  const rows = page.results.slice(0, limit);
  const latestSequence = head?.sequence ?? 0;
  const nextCursor = rows.at(-1)?.sequence ?? after;
  const etag = `"${event.id}:changes:a${after}:l${limit}:h${latestSequence}"`;
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": CACHE_CONTROL,
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
    Link: `<${new URL(`/events/${encodeURIComponent(event.slug)}/changes.json?after=${nextCursor}&limit=${limit}`, c.req.url)}>; rel="next"`,
    "X-Content-Type-Options": "nosniff",
    "X-Session-Party-Cursor": String(nextCursor),
  });
  const requested = c.req.header("if-none-match")?.split(",").map((value) => value.trim());
  if (requested?.some((value) => value === "*" || value === etag)) {
    return new Response(null, { status: 304, headers });
  }

  const origin = new URL(c.req.url).origin;
  return new Response(JSON.stringify({
    event: { id: event.id, slug: event.slug, name: event.name },
    after,
    nextCursor,
    latestSequence,
    hasMore: page.results.length > limit,
    changes: rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      type: row.event_type,
      aggregate: {
        type: row.aggregate_type,
        id: row.aggregate_id,
        version: row.aggregate_version,
      },
      resourceUrl: resourceUrl(origin, event.slug, row.event_type),
      occurredAt: row.occurred_at,
    })),
  }), { status: 200, headers });
});

export default app;
