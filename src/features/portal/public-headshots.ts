import { EntityId } from "contracts/domain";
import { API } from "contracts/routes";
import { assets, domainChanges, events } from "contracts/schema";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Schema } from "effect";
import { Hono } from "hono";
import {
  isAnonymousPublicRequest,
  matchPublicCache,
  PUBLIC_HEADSHOT_CACHE_CONTROL,
  storePublicCache,
} from "@/server/public-cache";
import { PublishedSpeakerGallerySnapshot } from "./schema";
import {
  portalAssetKey,
  PUBLIC_HEADSHOT_CONTENT_TYPES,
} from "./public-assets";

const PublicHeadshotRequest = Schema.Struct({
  eventSlug: EntityId,
  speakerId: EntityId,
  assetId: EntityId,
  publicationRevision: Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
});

const notFound = (): Response => new Response("Not found", {
  status: 404,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

const app = new Hono<{ Bindings: Env }>();

app.get(
  `${API}/public/events/:eventSlug/speakers/:speakerId/headshots/:assetId/:publicationRevision`,
  async (c) => {
    const revision = c.req.param("publicationRevision");
    const decoded = Schema.decodeUnknownEither(PublicHeadshotRequest)({
      eventSlug: c.req.param("eventSlug"),
      speakerId: c.req.param("speakerId"),
      assetId: c.req.param("assetId"),
      publicationRevision: revision.startsWith("r") ? revision.slice(1) : revision,
    });
    if (decoded._tag === "Left") return notFound();

    const { eventSlug, speakerId, assetId, publicationRevision } = decoded.right;
    const db = drizzle(c.env.DB);
    const [publication] = await db
      .select({
        eventId: events.id,
        aggregateVersion: domainChanges.aggregateVersion,
        payload: domainChanges.payload,
      })
      .from(events)
      .innerJoin(domainChanges, and(
        eq(domainChanges.eventId, events.id),
        eq(domainChanges.aggregateType, "speaker-publication"),
        eq(domainChanges.aggregateId, events.id),
      ))
      .where(eq(events.slug, eventSlug))
      .orderBy(desc(domainChanges.aggregateVersion))
      .limit(1);
    if (!publication || publication.aggregateVersion !== publicationRevision) return notFound();

    const snapshot = Schema.decodeUnknownEither(PublishedSpeakerGallerySnapshot)(publication.payload);
    if (snapshot._tag === "Left" || snapshot.right.revision !== publicationRevision) return notFound();
    const publishedSpeaker = snapshot.right.speakers.find((speaker) =>
      speaker.id === speakerId && speaker.headshotAssetId === assetId);
    if (!publishedSpeaker) return notFound();

    const [asset] = await db
      .select({ contentType: assets.contentType })
      .from(assets)
      .where(and(
        eq(assets.eventId, publication.eventId),
        eq(assets.id, assetId),
        eq(assets.speakerId, speakerId),
        eq(assets.purpose, "headshot"),
      ))
      .limit(1);
    if (!asset || !PUBLIC_HEADSHOT_CONTENT_TYPES.has(asset.contentType)) return notFound();

    // Authorization deliberately precedes the cache lookup. A newer publication
    // can revoke this otherwise-public asset URL at any time.
    const anonymous = isAnonymousPublicRequest(c.req.raw);
    if (anonymous) {
      const cached = await matchPublicCache(c.req.raw);
      if (cached) return cached;
    }

    const object = await c.env.FILES.get(portalAssetKey(publication.eventId, assetId));
    if (!object) return notFound();

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", anonymous ? PUBLIC_HEADSHOT_CACHE_CONTROL : "private, no-store");
    headers.set("Content-Disposition", "inline");
    headers.set("Content-Length", String(object.size));
    headers.set("Content-Type", asset.contentType);
    if (anonymous) headers.set("ETag", object.httpEtag);
    headers.set("Last-Modified", object.uploaded.toUTCString());
    headers.set("X-Content-Type-Options", "nosniff");
    const requestEtags = anonymous
      ? c.req.header("If-None-Match")?.split(",").map((value) => value.trim())
      : undefined;
    if (requestEtags?.some((value) => value === "*" || value === object.httpEtag)) {
      return new Response(null, { status: 304, headers });
    }

    const response = new Response(object.body, { status: 200, headers });
    if (anonymous) await storePublicCache(c.req.raw, response, c.executionCtx);
    return response;
  },
);

export default app;
