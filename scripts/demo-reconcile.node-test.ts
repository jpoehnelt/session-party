import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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

  it("replaces only fixture profile history and permits the next versioned save", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
      CREATE TABLE speaker_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        title TEXT,
        company TEXT,
        bio TEXT,
        headshot_url TEXT,
        links TEXT,
        visible INTEGER NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE speaker_profile_changes (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES speaker_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE,
        profile_version INTEGER NOT NULL,
        actor_user_id TEXT NOT NULL,
        before TEXT,
        after TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(profile_id, profile_version)
      );
      CREATE TABLE event_members (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(event_id, user_id)
      );
      INSERT INTO users VALUES ('demo-speaker', 'sbek-speaker@example.com');
      INSERT INTO users VALUES ('production-owner', 'owner@example.com');
      INSERT INTO users VALUES ('unrelated-user', 'unrelated@example.com');
      INSERT INTO events VALUES ('demo-event', 'ai-engineer-sandbox');
      INSERT INTO speaker_profiles VALUES ('old-demo-profile', 'demo-speaker', 'priya-raman', 'Stale', NULL, NULL, NULL, NULL, '[]', 1, 3, 1, 3);
      INSERT INTO speaker_profiles VALUES ('unrelated-profile', 'unrelated-user', 'unrelated', 'Unrelated', NULL, NULL, NULL, NULL, '[]', 1, 2, 1, 2);
      INSERT INTO speaker_profile_changes VALUES ('demo-v1', 'old-demo-profile', 1, 'demo-speaker', NULL, '{}', 1);
      INSERT INTO speaker_profile_changes VALUES ('demo-v2', 'old-demo-profile', 2, 'demo-speaker', '{}', '{}', 2);
      INSERT INTO speaker_profile_changes VALUES ('demo-v3', 'old-demo-profile', 3, 'demo-speaker', '{}', '{}', 3);
      INSERT INTO speaker_profile_changes VALUES ('unrelated-v1', 'unrelated-profile', 1, 'unrelated-user', NULL, '{}', 1);
      INSERT INTO speaker_profile_changes VALUES ('unrelated-v2', 'unrelated-profile', 2, 'unrelated-user', '{}', '{}', 2);
    `);

    db.exec(buildDemoReplacementSql([
      `INSERT INTO "events" ("id","slug") VALUES('demo-event','ai-engineer-sandbox');`,
      `INSERT INTO "speaker_profiles" ("id","user_id","slug","display_name","title","company","bio","headshot_url","links","visible","version","created_at","updated_at") VALUES('new-demo-profile','demo-speaker','priya-raman','Priya Raman',NULL,NULL,NULL,NULL,'[]',1,1,10,10);`,
      `INSERT INTO "speaker_profile_changes" ("id","profile_id","profile_version","actor_user_id","before","after","created_at") VALUES('new-demo-v1','new-demo-profile',1,'demo-speaker',NULL,'{}',10);`,
    ], "production-owner", 10));

    assert.deepEqual(
      db.prepare("SELECT profile_version FROM speaker_profile_changes WHERE profile_id = 'new-demo-profile' ORDER BY profile_version").all()
        .map((row) => row.profile_version),
      [1],
    );
    assert.deepEqual(
      db.prepare("SELECT profile_version FROM speaker_profile_changes WHERE profile_id = 'unrelated-profile' ORDER BY profile_version").all()
        .map((row) => row.profile_version),
      [1, 2],
    );
    assert.doesNotThrow(() => db.exec(`
      UPDATE speaker_profiles SET version = 2 WHERE id = 'new-demo-profile' AND version = 1;
      INSERT INTO speaker_profile_changes VALUES ('new-demo-v2', 'new-demo-profile', 2, 'demo-speaker', '{}', '{}', 11);
    `));
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
