import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

interface TestEnv extends Cloudflare.Env {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
}

const hasMigrations = (value: Cloudflare.Env): value is TestEnv => "TEST_MIGRATIONS" in value;

beforeAll(async () => {
  if (hasMigrations(env)) await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
  const now = Date.UTC(2026, 7, 12, 16, 0, 0);
  await env.DB.batch([
    env.DB.prepare("insert into events (id, slug, name, timezone, starts_at, ends_at, version, created_at, updated_at) values (?, ?, ?, 'UTC', ?, ?, 1, ?, ?)")
      .bind("feed-event", "feed-summit", "Feed Summit", now, now + 86_400_000, now, now),
    env.DB.prepare("insert into domain_changes (id, event_id, aggregate_type, aggregate_id, aggregate_version, event_type, audiences, payload, request_id, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("feed-private", "feed-event", "submission", "submission-1", 1, "submission.updated", JSON.stringify([{ kind: "admins" }]), JSON.stringify({ email: "private@example.com" }), "feed-private", now),
    env.DB.prepare("insert into domain_changes (id, event_id, aggregate_type, aggregate_id, aggregate_version, event_type, audiences, payload, request_id, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("feed-public-1", "feed-event", "agenda-publication", "feed-event", 1, "agenda/published", JSON.stringify([{ kind: "public" }]), JSON.stringify({ revision: 1, talks: [] }), "feed-public-1", now + 1),
    env.DB.prepare("insert into domain_changes (id, event_id, aggregate_type, aggregate_id, aggregate_version, event_type, audiences, payload, request_id, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("feed-public-2", "feed-event", "speaker-publication", "feed-event", 1, "portal/speakers-published", JSON.stringify([{ kind: "public" }]), JSON.stringify({ revision: 1, speakers: [] }), "feed-public-2", now + 2),
  ]);
});

describe("public monotonic change feed", () => {
  it("returns only safe public invalidations in ascending cursor order", async () => {
    const response = await SELF.fetch("https://example.com/events/feed-summit/changes.json?limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("public");
    const body = await response.json<{
      nextCursor: number;
      latestSequence: number;
      hasMore: boolean;
      changes: readonly { sequence: number; type: string; resourceUrl: string }[];
    }>();
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      type: "agenda/published",
      resourceUrl: "https://example.com/api/v1/public/events/feed-summit/agenda/published",
    });
    expect(JSON.stringify(body)).not.toContain("private@example.com");
    expect(body.hasMore).toBe(true);
    expect(body.latestSequence).toBeGreaterThan(body.nextCursor);

    const next = await SELF.fetch(`https://example.com/events/feed-summit/changes.json?after=${body.nextCursor}&limit=1`);
    const nextBody = await next.json<typeof body>();
    expect(nextBody.changes[0]?.type).toBe("portal/speakers-published");
    expect(nextBody.changes[0]!.sequence).toBeGreaterThan(body.changes[0]!.sequence);
  });

  it("supports conditional polling with ETag and 304", async () => {
    const first = await SELF.fetch("https://example.com/events/feed-summit/changes.json?after=0");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const cached = await SELF.fetch("https://example.com/events/feed-summit/changes.json?after=0", {
      headers: { "If-None-Match": etag! },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("x-session-party-cursor")).toBeTruthy();
  });

  it("validates bounded cursors and does not reveal unknown events", async () => {
    expect((await SELF.fetch("https://example.com/events/feed-summit/changes.json?after=-1")).status).toBe(400);
    expect((await SELF.fetch("https://example.com/events/missing/changes.json")).status).toBe(404);
  });
});
