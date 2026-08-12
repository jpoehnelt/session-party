import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCompatibleDemoUsers,
  assertExactProductionTarget,
  buildDemoReplacementSql,
  demoTarget,
  fixtureUserCollisionSql,
  reconcileDemoInsert,
} from "./demo-reconcile";

describe("demo reconciliation safeguards", () => {
  it("accepts only the locked production event identity", () => {
    assert.doesNotThrow(() => assertExactProductionTarget([
      { id: demoTarget.eventId, slug: demoTarget.eventSlug },
    ]));
    assert.throws(
      () => assertExactProductionTarget([{ id: demoTarget.eventId, slug: "different" }]),
      /requires exactly demo-event\/ai-engineer-sandbox/,
    );
    assert.throws(() => assertExactProductionTarget([]), /requires exactly/);
  });

  it("rejects fixture ID or email collisions with another production identity", () => {
    const local = [{ id: "demo-owner", email: "owner@example.com" }];
    assert.doesNotThrow(() => assertCompatibleDemoUsers(local, local));
    assert.throws(
      () => assertCompatibleDemoUsers(local, [{ id: "real-user", email: "owner@example.com" }]),
      /not the deterministic demo identity/,
    );
    assert.throws(
      () => assertCompatibleDemoUsers(local, [{ id: "demo-owner", email: "other@example.com" }]),
      /not the deterministic demo identity/,
    );
  });

  it("builds a replacement locked to the demo event and retains exact fixture users", () => {
    const sql = buildDemoReplacementSql([
      'INSERT INTO "events" VALUES(\'demo-event\',\'ai-engineer-sandbox\');',
      'INSERT INTO "users" VALUES(\'demo-owner\',\'owner@example.com\');',
      'INSERT INTO "speaker_profiles" ("id","user_id","slug") VALUES(\'profile-new\',\'demo-speaker\',\'priya-raman\');',
      'INSERT INTO "speaker_profile_changes" ("id","profile_id","profile_version") VALUES(\'change-new\',\'profile-new\',1);',
      'INSERT INTO "talks" VALUES(\'demo-talk\');',
    ], "production-owner", 1_800_000_000_000);

    assert.match(sql, /DELETE FROM events WHERE id = 'demo-event' AND slug = 'ai-engineer-sandbox';/);
    assert.match(sql, /INSERT OR IGNORE INTO "users"/);
    assert.match(sql, /ON CONFLICT\("user_id"\) DO UPDATE SET "id"=excluded\."id"/);
    assert.match(sql, /ON CONFLICT\("profile_id","profile_version"\) DO UPDATE SET "id"=excluded\."id"/);
    assert.match(sql, /WHERE NOT EXISTS/);
    assert.doesNotMatch(sql, /DELETE FROM users/);
    assert.doesNotMatch(sql, /DELETE FROM events WHERE id !=/);
  });

  it("reconciles reusable profile state without replacement deletes", () => {
    const profile = reconcileDemoInsert(
      'INSERT INTO "speaker_profiles" ("id","user_id","slug") VALUES(\'profile-new\',\'demo-speaker\',\'priya-raman\');',
    );
    const change = reconcileDemoInsert(
      'INSERT INTO "speaker_profile_changes" ("id","profile_id","profile_version") VALUES(\'change-new\',\'profile-new\',1);',
    );
    assert.match(profile, /ON CONFLICT\("user_id"\) DO UPDATE/);
    assert.match(change, /ON CONFLICT\("profile_id","profile_version"\) DO UPDATE/);
    assert.doesNotMatch(profile, /REPLACE|DELETE/i);
    assert.doesNotMatch(change, /REPLACE|DELETE/i);
  });

  it("refuses snapshots without the one locked event and escapes collision queries", () => {
    assert.throws(
      () => buildDemoReplacementSql(['INSERT INTO "events" VALUES(\'other\',\'other\');'], "owner", 1),
      /locked event identity/,
    );
    const sql = fixtureUserCollisionSql([{ id: "demo-owner", email: "O'Reilly@example.com" }]);
    assert.match(sql, /O''Reilly@example\.com/i);
  });
});
