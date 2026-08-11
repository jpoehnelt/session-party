import { getArchiveOperation } from "@/features/exports/operations";
import { InstitutionalArchive } from "@/features/exports/schema";
import { getFormOperation } from "@/features/forms/operations";
import { FormDetail } from "@/features/forms/schema";
import { getPublicSubmissionFormOperation } from "@/features/submit/operations";
import { PublicSubmissionForm } from "@/features/submit/schema";
import type { Principal } from "contracts/principal";
import {
  applyD1Migrations,
  env,
  SELF,
  type D1Migration,
} from "cloudflare:test";
import { Schema } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runRestOperation, runTransportOperation, type AppHono } from "./adapt";
import { apiKeyUserFromRequest, hashBearerMaterial, userFromRequest } from "./auth";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
  readonly MIGRATION_DB: D1Database;
};

type MigrationShape = D1Migration & {
  readonly name: string;
  readonly queries: readonly string[];
};

const testMigrations = (): readonly MigrationShape[] => {
  if (!("TEST_MIGRATIONS" in env)) {
    throw new Error("TEST_MIGRATIONS test binding is unavailable");
  }
  return (env as TestEnv).TEST_MIGRATIONS as readonly MigrationShape[];
};

const repairMigration = (migrations: readonly MigrationShape[]): MigrationShape => {
  const migration = migrations.find(({ name }) =>
    name.startsWith("0008_repair_legacy_form_version_ids"));
  if (!migration) throw new Error("Legacy form-version ID repair migration is unavailable");
  return migration;
};

const safeRows = async (db: D1Database, query: string): Promise<unknown> => {
  try {
    return (await db.prepare(query).all()).results;
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
};
const applyOneByOne = async (db: D1Database, migrations: readonly MigrationShape[]): Promise<void> => {
  for (const [ordinal, migration] of migrations.entries()) {
    try {
      await applyD1Migrations(db, [migration]);
    } catch (error) {
      throw new Error(JSON.stringify({
        message: "Migration application failed",
        ordinal,
        name: migration.name,
        error: error instanceof Error ? error.message : String(error),
        queryList: migration.queries,
        d1Migrations: await safeRows(
          db,
          "SELECT name, applied_at FROM d1_migrations ORDER BY id",
        ),
        sqliteMaster: await safeRows(
          db,
          "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
        ),
      }));
    }
  }
};

const assertDatabaseIntegrity = async (db: D1Database): Promise<void> => {
  const foreignKeys = await db.prepare("PRAGMA foreign_key_check").all();
  expect(foreignKeys.results).toEqual([]);
  const staleParents = await db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE instr(sql, '__new_') > 0 ORDER BY name",
  ).all();
  expect(staleParents.results).toEqual([]);
  const deliveryColumns = await db.prepare("PRAGMA table_info(mail_deliveries)").all<{
    name: string;
  }>();
  expect(deliveryColumns.results.map(({ name }) => name)).not.toContain("event_id");
  const attemptColumns = await db.prepare("PRAGMA table_info(mail_delivery_attempts)").all<{
    name: string;
  }>();
  expect(attemptColumns.results.map(({ name }) => name)).not.toContain("event_id");
  const snapshotEvent = await db.prepare(
    "SELECT `notnull` FROM pragma_table_info('mail_delivery_snapshots') WHERE name = 'event_id'",
  ).first<{ notnull: number }>();
  expect(snapshotEvent?.notnull).toBe(0);
  const mailIndexes = await db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'mail_%' ORDER BY name",
  ).all<{ name: string; sql: string }>();
  expect(mailIndexes.results.map(({ name }) => name)).not.toEqual(
    expect.arrayContaining([
      "mail_deliveries_event_id_unique",
      "mail_deliveries_event_status",
      "mail_attempts_event_id_unique",
    ]),
  );
  expect(mailIndexes.results).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: "mail_deliveries_snapshot_unique",
      sql: expect.stringContaining("(`snapshot_id`)"),
    }),
    expect.objectContaining({
      name: "mail_deliveries_idempotency_unique",
      sql: expect.stringContaining("(`idempotency_key`)"),
    }),
  ]));
  await expect(db.prepare(
    "INSERT INTO mail_delivery_snapshots (id, event_id, template_id, recipient_email, from_email, subject, rendered_html, created_at) VALUES ('invalid-global-template', NULL, 'missing-template', 'recipient@example.com', 'sender@example.com', 'Subject', '<p>Body</p>', 1700000000000)",
  ).run()).rejects.toThrow();
  await db.prepare(
    "INSERT INTO mail_delivery_snapshots (id, event_id, template_id, recipient_email, from_email, subject, rendered_html, created_at) VALUES ('valid-global-auth', NULL, NULL, 'recipient@example.com', 'sender@example.com', 'Subject', '<p>Body</p>', 1700000000000)",
  ).run();
  await db.prepare("DELETE FROM mail_delivery_snapshots WHERE id = 'valid-global-auth'").run();
  const acceleventsTables = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'accelevents_%' ORDER BY name",
  ).all<{ name: string }>();
  expect(acceleventsTables.results.map(({ name }) => name)).toEqual([
    "accelevents_external_identities",
    "accelevents_import_items",
    "accelevents_import_runs",
  ]);
};

const insertAuthenticatedUser = async (): Promise<string> => {
  const token = "migration-parity-browser-session";
  const tokenHash = await hashBearerMaterial(env, token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).bind("parity-user", "parity@example.com", "Parity User", now, now),
    env.DB.prepare(
      "INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at) VALUES (?, ?, ?, 'session', ?, NULL, ?)",
    ).bind("parity-session", tokenHash, "parity-user", now + 60_000, now),
  ]);
  return token;
};

const proveAuthenticatedEventRoundTrip = async (): Promise<void> => {
  const token = await insertAuthenticatedUser();
  const headers = {
    "Content-Type": "application/json",
    Cookie: `sp_session=${encodeURIComponent(token)}`,
  };
  const created = await SELF.fetch("https://example.test/api/v1/events", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Migration Parity", slug: "migration-parity" }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const event = await created.json<{ id: string; version: number }>();
  expect(event.version).toBe(1);

  const fetched = await SELF.fetch(`https://example.test/api/v1/events/${event.id}`, {
    headers,
  });
  expect(fetched.status, await fetched.clone().text()).toBe(200);
  expect(await fetched.json<{ id: string }>()).toMatchObject({ id: event.id });
};

const seedLegacyRows = async (db: D1Database): Promise<void> => {
  const now = 1_700_000_000_000;
  const rows = [
    "INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('legacy-user', 'legacy@example.com', 'Legacy User', 1700000000000, 1700000000000)",
    "INSERT INTO events (id, slug, name, timezone, created_at, updated_at) VALUES ('legacy-event', 'legacy-event', 'Legacy Event', 'UTC', 1700000000000, 1700000000000)",
    "INSERT INTO event_members (id, event_id, user_id, role, created_at, updated_at) VALUES ('legacy-member', 'legacy-event', 'legacy-user', 'owner', 1700000000000, 1700000000000)",
    "INSERT INTO forms (id, event_id, kind, name, status, created_at, updated_at) VALUES ('legacy-form', 'legacy-event', 'cfp', 'Legacy CFP', 'open', 1700000000000, 1700000000000)",
    "INSERT INTO form_fields (id, form_id, `order`, type, label, required, created_at, updated_at) VALUES ('legacy-field', 'legacy-form', 1, 'textarea', 'Abstract', 1, 1700000000000, 1700000000000)",
    "INSERT INTO submissions (id, event_id, form_id, title, status, submitted_at, created_at, updated_at) VALUES ('legacy-submission', 'legacy-event', 'legacy-form', 'Legacy Talk', 'accepted', 1700000000000, 1700000000000, 1700000000000)",
    "INSERT INTO submission_answers (id, submission_id, field_id, value) VALUES ('legacy-answer', 'legacy-submission', 'legacy-field', '\"Legacy abstract\"')",
    "INSERT INTO speakers (id, event_id, user_id, display_name, visible, created_at, updated_at) VALUES ('legacy-speaker', 'legacy-event', 'legacy-user', 'Legacy User', 1, 1700000000000, 1700000000000)",
    "INSERT INTO submission_speakers (id, submission_id, speaker_id, is_primary) VALUES ('legacy-submission-speaker', 'legacy-submission', 'legacy-speaker', 1)",
    "INSERT INTO api_keys (id, event_id, name, hash, created_at, updated_at) VALUES ('legacy-api-key', 'legacy-event', 'Legacy Key', 'raw-legacy-key-material', 1700000000000, 1700000000000)",
    "INSERT INTO auth_tokens (id, user_id, kind, expires_at, consumed_at, created_at) VALUES ('legacy-token', 'legacy-user', 'session', 1800000000000, NULL, 1700000000000)",
    "INSERT INTO email_templates (id, event_id, name, subject, body, attach_ics, created_at, updated_at) VALUES ('legacy-template', 'legacy-event', 'Legacy Mail', 'Welcome', '<p>Welcome</p>', 0, 1700000000000, 1700000000000)",
    "INSERT INTO email_sends (id, event_id, template_id, to_user_id, subject, scheduled_for, sent_at, status, error, created_at, updated_at) VALUES ('legacy-send', 'legacy-event', 'legacy-template', 'legacy-user', 'Welcome', 1700000000000, 1700000001000, 'sent', NULL, 1700000000000, 1700000001000)",
    "UPDATE email_templates SET subject = 'Changed after send', body = '<p>Changed after send</p>', updated_at = 1700000002000 WHERE id = 'legacy-template'",
  ];
  expect(now).toBe(1_700_000_000_000);
  await db.batch(rows.map((query) => db.prepare(query)));
};

const legacyOwner: Principal = {
  kind: "browser-session",
  userId: "legacy-user",
  email: "legacy@example.com",
  name: "Legacy User",
  sessionId: "migration-parity-legacy-owner",
  expiresAt: 1_800_000_000_000,
};

const upgradedEnv = (db: D1Database): Env =>
  Object.assign(Object.create(env), { DB: db, LOCAL_MODE: "1" }) as Env;

const assertCanonicalFormVersionIds = async (db: D1Database): Promise<void> => {
  const result = await db.prepare(`
    SELECT count(*) AS invalid_count
    FROM (
      SELECT id AS value FROM form_versions
      UNION ALL SELECT form_version_id FROM form_version_fields
      UNION ALL SELECT form_version_id FROM submissions
      UNION ALL SELECT form_version_id FROM submission_answers
    )
    WHERE length(value) = 0
      OR length(value) > 128
      OR value GLOB '*[^A-Za-z0-9_-]*'
  `).first();
  expect(result).toEqual({ invalid_count: 0 });
};

const assertHistoricalFormAndSubmissionRoundTrip = async (db: D1Database): Promise<void> => {
  const historical = await db.prepare(`
    SELECT
      fv.id AS form_version_id,
      fvf.form_version_id AS field_form_version_id,
      s.id AS submission_id,
      s.form_version_id AS submission_form_version_id,
      a.id AS answer_id,
      a.form_version_id AS answer_form_version_id,
      a.form_version_field_id,
      a.value AS answer_value
    FROM form_versions fv
    JOIN form_version_fields fvf
      ON fvf.event_id = fv.event_id
      AND fvf.form_version_id = fv.id
    JOIN submissions s
      ON s.event_id = fv.event_id
      AND s.form_id = fv.form_id
      AND s.form_version_id = fv.id
    JOIN submission_answers a
      ON a.event_id = s.event_id
      AND a.submission_id = s.id
      AND a.form_version_id = s.form_version_id
      AND a.form_version_field_id = fvf.id
    WHERE fv.event_id = 'legacy-event'
      AND fv.form_id = 'legacy-form'
  `).first();
  expect(historical).toEqual({
    form_version_id: "legacy-v1_legacy-form",
    field_form_version_id: "legacy-v1_legacy-form",
    submission_id: "legacy-submission",
    submission_form_version_id: "legacy-v1_legacy-form",
    answer_id: "legacy-answer",
    answer_form_version_id: "legacy-v1_legacy-form",
    form_version_field_id: "legacy-field",
    answer_value: "\"Legacy abstract\"",
  });
  await assertCanonicalFormVersionIds(db);

  const runtimeEnv = upgradedEnv(db);
  const formWire = await runTransportOperation(
    runtimeEnv,
    legacyOwner,
    getFormOperation,
    { eventId: "legacy-event", formId: "legacy-form" },
  );
  expect(Schema.decodeUnknownSync(FormDetail)(formWire)).toMatchObject({
    id: "legacy-form",
    publishedVersion: {
      id: "legacy-v1_legacy-form",
      versionNumber: 1,
      fields: [{ id: "legacy-field", sourceFieldId: "legacy-field" }],
    },
  });

  const app = new Hono<AppHono>();
  const rest = getPublicSubmissionFormOperation.rest;
  app.get(`/api/v1${rest.path}`, (context) =>
    runRestOperation(context, null, getPublicSubmissionFormOperation, rest.input));
  const publicResponse = await app.request(
    "/api/v1/public/events/legacy-event/forms/legacy-form",
    {},
    runtimeEnv,
  );
  expect(publicResponse.status, await publicResponse.clone().text()).toBe(200);
  expect(Schema.decodeUnknownSync(PublicSubmissionForm)(await publicResponse.json())).toMatchObject({
    event: { slug: "legacy-event" },
    form: {
      id: "legacy-form",
      versionId: "legacy-v1_legacy-form",
      versionNumber: 1,
      availability: "open",
      fields: [{ id: "legacy-field" }],
    },
  });

  const archiveWire = await runTransportOperation(
    runtimeEnv,
    legacyOwner,
    getArchiveOperation,
    { eventId: "legacy-event" },
  );
  expect(Schema.decodeUnknownSync(InstitutionalArchive)(archiveWire)).toMatchObject({
    submissions: [{
      id: "legacy-submission",
      formId: "legacy-form",
      formVersionId: "legacy-v1_legacy-form",
      answers: [{ id: "legacy-answer", fieldId: "legacy-field" }],
    }],
  });
};

describe("baseline migration parity", () => {
  it("treats the repair as an idempotent no-op without legacy rows", async () => {
    const migrations = testMigrations();
    expect(migrations).toHaveLength(16);
    const repair = repairMigration(migrations);
    await applyOneByOne(env.DB, migrations);
    await assertCanonicalFormVersionIds(env.DB);
    await applyD1Migrations(env.DB, [repair]);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM d1_migrations WHERE name = ?",
    ).bind(repair.name).first()).toEqual({ count: 1 });
    await assertDatabaseIntegrity(env.DB);
    await proveAuthenticatedEventRoundTrip();
  });

  it("upgrades nonempty 0000 rows without losing identity or history", async () => {
    const migrations = testMigrations();
    const db = (env as TestEnv).MIGRATION_DB;
    expect(migrations).toHaveLength(16);
    const repair = repairMigration(migrations);
    await applyOneByOne(db, migrations.slice(0, 1));
    await seedLegacyRows(db);
    await applyOneByOne(db, migrations.slice(1, 2));
    expect(await db.prepare(`
      SELECT
        (SELECT id FROM form_versions WHERE form_id = 'legacy-form') AS version_id,
        (SELECT form_version_id FROM form_version_fields WHERE id = 'legacy-field') AS field_version_id,
        (SELECT form_version_id FROM submissions WHERE id = 'legacy-submission') AS submission_version_id,
        (SELECT form_version_id FROM submission_answers WHERE id = 'legacy-answer') AS answer_version_id
    `).first()).toEqual({
      version_id: "legacy-v1:legacy-form",
      field_version_id: "legacy-v1:legacy-form",
      submission_version_id: "legacy-v1:legacy-form",
      answer_version_id: "legacy-v1:legacy-form",
    });

    await db.prepare(`
      INSERT INTO form_versions
        (id, event_id, form_id, version_number, name, published_at, created_at)
      VALUES
        ('legacy-v1_legacy-form', 'legacy-event', 'legacy-form', 2, 'Occupied target',
         1700000000000, 1700000000000)
    `).run();
    await expect(applyD1Migrations(db, [repair])).rejects.toThrow(
      /repair_legacy_form_version_ids_collision/,
    );
    expect(await db.prepare(`
      SELECT
        (SELECT count(*) FROM form_versions WHERE id = 'legacy-v1:legacy-form') AS source_count,
        (SELECT count(*) FROM form_versions WHERE id = 'legacy-v1_legacy-form') AS target_count,
        (SELECT form_version_id FROM submission_answers WHERE id = 'legacy-answer') AS answer_version_id,
        (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '__repair_legacy_form_version_ids_preflight') AS preflight_count
    `).first()).toEqual({
      source_count: 1,
      target_count: 1,
      answer_version_id: "legacy-v1:legacy-form",
      preflight_count: 0,
    });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await db.prepare("DELETE FROM form_versions WHERE id = 'legacy-v1_legacy-form'").run();

    await applyOneByOne(db, migrations.slice(2, 15));
    await db.batch([
      db.prepare(
        "INSERT INTO tracks (id, event_id, name, `order`, version, created_at, updated_at) VALUES ('legacy-embed-track', 'legacy-event', 'Systems', 0, 1, 1700000000000, 1700000000000)",
      ),
      db.prepare(
        `INSERT INTO embeds
          (id, event_id, name, widget, preset, aesthetic, accent, track, fields, enabled, version, created_at, updated_at)
         VALUES
          ('legacy-embed-definition', 'legacy-event', 'Systems schedule', 'schedule', 'agenda', 'minimal', '#005A9C', 'Systems', '["title"]', 1, 1, 1700000000000, 1700000000000)`,
      ),
    ]);
    await applyOneByOne(db, migrations.slice(15));
    await expect(db.prepare(
      "SELECT track_id, track FROM embeds WHERE id = 'legacy-embed-definition'",
    ).first()).resolves.toEqual({ track_id: "legacy-embed-track", track: "Systems" });

    await assertDatabaseIntegrity(db);
    const event = await db.prepare(
      "SELECT id, version, created_at, updated_at FROM events WHERE id = 'legacy-event'",
    ).first<{ id: string; version: number; created_at: number; updated_at: number }>();
    expect(event).toEqual({
      id: "legacy-event",
      version: 1,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    });

    await assertHistoricalFormAndSubmissionRoundTrip(db);
    await db.batch(repair.queries.map((query) => db.prepare(query)));
    await assertDatabaseIntegrity(db);
    await assertHistoricalFormAndSubmissionRoundTrip(db);
    const semantics = await db.prepare(
      "SELECT (SELECT semantic_key FROM form_fields WHERE id = 'legacy-field') AS draft_semantic_key, (SELECT semantic_key FROM form_version_fields WHERE id = 'legacy-field') AS version_semantic_key",
    ).first();
    expect(semantics).toEqual({ draft_semantic_key: null, version_semantic_key: null });
    const historicalSpeakerContext = await db.prepare(
      "SELECT title_at_time, organization_at_time FROM submission_speakers WHERE id = 'legacy-submission-speaker'",
    ).first();
    expect(historicalSpeakerContext).toEqual({ title_at_time: null, organization_at_time: null });
    expect(await db.prepare(
      "SELECT contact_email FROM speakers WHERE id = 'legacy-speaker'",
    ).first()).toEqual({ contact_email: null });
    await db.prepare(
      `INSERT INTO speaker_contacts
        (id, event_id, speaker_id, actor_user_id, medium, note, contacted_at, created_at)
       VALUES ('legacy-contact', 'legacy-event', 'legacy-speaker', 'legacy-user', 'personalEmail',
        'Migration verification', 1700000003000, 1700000003000)`,
    ).run();
    expect(await db.prepare(
      "SELECT medium, contacted_at FROM speaker_contacts WHERE id = 'legacy-contact'",
    ).first()).toEqual({ medium: "personalEmail", contacted_at: 1_700_000_003_000 });
    await db.prepare(
      `INSERT INTO review_comments
        (id, event_id, submission_id, author_user_id, body, created_at)
       VALUES ('legacy-review-comment', 'legacy-event', 'legacy-submission', 'legacy-user',
        'Committee follow-up', 1700000004000)`,
    ).run();
    expect(await db.prepare(
      "SELECT body FROM review_comments WHERE id = 'legacy-review-comment'",
    ).first()).toEqual({ body: "Committee follow-up" });

    const mail = await db.prepare(
      `SELECT
        d.id, d.status, d.provider, d.provider_message_id, d.provider_result,
        d.sent_at, d.created_at,
        s.subject AS snapshot_subject, s.rendered_html, s.rendered_text,
        s.redacted_at IS NOT NULL AS snapshot_redacted,
        t.subject AS current_template_subject, t.body AS current_template_body
       FROM mail_deliveries d
       JOIN mail_delivery_snapshots s ON s.id = d.snapshot_id
       JOIN email_templates t ON t.id = s.template_id
       WHERE d.id = 'legacy-send'`,
    ).first();
    expect(mail).toMatchObject({
      id: "legacy-send",
      status: "sent",
      provider: "legacy-import",
      provider_message_id: "legacy-unverified:legacy-send",
      provider_result: "{\"mode\":\"legacy-import\",\"externalDeliveryUnverified\":true}",
      sent_at: 1_700_000_001_000,
      created_at: 1_700_000_000_000,
      snapshot_subject: "[legacy content unavailable]",
      rendered_html: null,
      rendered_text: null,
      snapshot_redacted: 1,
      current_template_subject: "Changed after send",
      current_template_body: "<p>Changed after send</p>",
    });

    await db.batch([
      db.prepare(
        `INSERT INTO mail_delivery_snapshots
          (id, event_id, recipient_email, from_email, subject, rendered_html, rendered_text, created_at)
         VALUES ('post-cutover-snapshot', NULL, 'speaker@example.com', 'Session Party <welcome@sessionparty.com>', 'Welcome', '<p>Welcome</p>', 'Welcome', ?)`,
      ).bind(1_700_000_002_000),
      db.prepare(
        `INSERT INTO mail_deliveries
          (id, snapshot_id, idempotency_key, scheduled_for, available_at, created_at)
         VALUES ('post-cutover-send', 'post-cutover-snapshot', 'post-cutover-send', ?, ?, ?)`,
      ).bind(1_700_000_002_000, 1_700_000_002_000, 1_700_000_002_000),
    ]);
    expect(await db.prepare(
      "SELECT provider FROM mail_deliveries WHERE id = 'post-cutover-send'",
    ).first()).toEqual({ provider: "cloudflare-email" });

    const credentials = await db.prepare(
      "SELECT (SELECT consumed_at IS NOT NULL FROM auth_tokens WHERE id = 'legacy-token') AS token_invalidated, (SELECT count(*) FROM api_keys WHERE id = 'legacy-api-key') AS legacy_api_key_count",
    ).first();
    expect(credentials).toEqual({ token_invalidated: 1, legacy_api_key_count: 0 });
    const legacyAuthEnv = upgradedEnv(db);
    expect(await userFromRequest(
      new Request("https://example.test", {
        headers: { Cookie: "sp_session=legacy-token-material" },
      }),
      legacyAuthEnv,
    )).toBeNull();
    expect(await apiKeyUserFromRequest(
      new Request("https://example.test", {
        headers: { Authorization: "Bearer raw-legacy-key-material" },
      }),
      legacyAuthEnv,
    )).toBeNull();

    await expect(db.prepare(
      "INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, created_by, version, created_at, updated_at) VALUES ('invalid-scope-key', 'legacy-event', 'Invalid', ?, '[\"bogus:scope\"]', 1800000000000, 'legacy-user', 1, 1700000000000, 1700000000000)",
    ).bind("f".repeat(64)).run()).rejects.toThrow(/known scopes/);
  });


  it("adds Accelevents evidence tables without rewriting configured integrations", async () => {
    const migrations = testMigrations();
    const db = (env as TestEnv).MIGRATION_DB;
    expect(migrations).toHaveLength(16);
    await applyOneByOne(db, migrations.slice(0, 3));
    await db.batch([
      db.prepare(
        "INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('accel-user', 'accel@example.com', 'Accel Owner', 1, 1700000000000, 1700000000000)",
      ),
      db.prepare(
        "INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at) VALUES ('accel-event', 'accel-event', 'Accel Event', 'UTC', 1, 1700000000000, 1700000000000)",
      ),
      db.prepare(
        `INSERT INTO integrations
          (id, event_id, kind, secret_ref, config, cursor, last_sync_at, last_error, version, created_at, updated_at)
         VALUES
          ('accel-integration', 'accel-event', 'accelevents', 'ACCELEVENTS_API_TOKEN',
           '{\"kind\":\"accelevents\",\"accelEventId\":\"provider-1\",\"eventUrl\":\"event-one\"}',
           NULL, 1700000000000, NULL, 2, 1700000000000, 1700000000000)`,
      ),
    ]);
    await applyOneByOne(db, migrations.slice(3));
    await assertDatabaseIntegrity(db);

    const integration = await db.prepare(
      "SELECT id, event_id, secret_ref, config, last_sync_at, version FROM integrations WHERE id = 'accel-integration'",
    ).first();
    expect(integration).toEqual({
      id: "accel-integration",
      event_id: "accel-event",
      secret_ref: "ACCELEVENTS_API_TOKEN",
      config: "{\"kind\":\"accelevents\",\"accelEventId\":\"provider-1\",\"eventUrl\":\"event-one\"}",
      last_sync_at: 1_700_000_000_000,
      version: 2,
    });
    const tableDefinitions = await db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'accelevents_%'",
    ).all<{ name: string; sql: string }>();
    const definitions = tableDefinitions.results.map(({ sql }) => sql).join("\n");
    expect(definitions).toContain("accelevents_identities_entity_type");
    expect(definitions).toContain("accelevents_runs_mode");
    expect(definitions).toContain("accelevents_runs_status");
    expect(definitions).toContain("accelevents_items_entity_type");
    expect(definitions).toContain("accelevents_items_action");
    await db.prepare(
      `INSERT INTO accelevents_import_runs
        (id, event_id, integration_id, source_event_id, event_url, mode, status,
         total_count, created_count, updated_count, unchanged_count, failed_count,
         error_code, error_detail, started_at, completed_at)
       VALUES
        ('valid-enum-run', 'accel-event', 'accel-integration', 'provider-1', 'event-one',
         'fixture', 'succeeded', 0, 0, 0, 0, 0, NULL, NULL, 1700000000000, 1700000000001)`,
    ).run();
    await expect(db.prepare(
      `INSERT INTO accelevents_import_runs
        (id, event_id, integration_id, source_event_id, event_url, mode, status,
         total_count, created_count, updated_count, unchanged_count, failed_count,
         error_code, error_detail, started_at, completed_at)
       VALUES
        ('bad-mode', 'accel-event', 'accel-integration', 'provider-1', 'event-one',
         'preview', 'succeeded', 0, 0, 0, 0, 0, NULL, NULL, 1700000000000, 1700000000001)`,
    ).run()).rejects.toThrow();
    await expect(db.prepare(
      `INSERT INTO accelevents_import_runs
        (id, event_id, integration_id, source_event_id, event_url, mode, status,
         total_count, created_count, updated_count, unchanged_count, failed_count,
         error_code, error_detail, started_at, completed_at)
       VALUES
        ('bad-status', 'accel-event', 'accel-integration', 'provider-1', 'event-one',
         'fixture', 'abandoned', 0, 0, 0, 0, 0, NULL, NULL, 1700000000000, 1700000000001)`,
    ).run()).rejects.toThrow();
    await expect(db.prepare(
      `INSERT INTO accelevents_import_items
        (id, event_id, integration_id, run_id, item_order, entity_type, external_id,
         action, local_id, error_code, error_detail, created_at)
       VALUES
        ('bad-entity', 'accel-event', 'accel-integration', 'valid-enum-run', 0, 'session',
         'external-1', 'failed', NULL, 'invalid', 'invalid entity', 1700000000001)`,
    ).run()).rejects.toThrow();
    await expect(db.prepare(
      `INSERT INTO accelevents_import_items
        (id, event_id, integration_id, run_id, item_order, entity_type, external_id,
         action, local_id, error_code, error_detail, created_at)
       VALUES
        ('bad-action', 'accel-event', 'accel-integration', 'valid-enum-run', 0, 'speaker',
         'external-2', 'deleted', 'speaker-1', NULL, NULL, 1700000000001)`,
    ).run()).rejects.toThrow();
    await expect(db.prepare(
      `INSERT INTO accelevents_import_runs
        (id, event_id, integration_id, source_event_id, event_url, mode, status,
         total_count, created_count, updated_count, unchanged_count, failed_count,
         error_code, error_detail, started_at, completed_at)
       VALUES
        ('bad-counts', 'accel-event', 'accel-integration', 'provider-1', 'event-one',
         'fixture', 'succeeded', 2, 1, 0, 0, 0, NULL, NULL, 1700000000000, 1700000000001)`,
    ).run()).rejects.toThrow();
  });

  it("backfills legacy assets and review rounds while preserving assignment recusal history", async () => {
    const migrations = testMigrations();
    const db = (env as TestEnv).MIGRATION_DB;
    expect(migrations).toHaveLength(16);
    await applyOneByOne(db, migrations.slice(0, 11));
    const now = 1_700_000_000_000;
    await db.batch([
      db.prepare("INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('recusal-user', 'recusal@example.com', 'Recusal Reviewer', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at) VALUES ('recusal-event', 'recusal-event', 'Recusal Event', 'UTC', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at) VALUES ('recusal-member', 'recusal-event', 'recusal-user', 'reviewer', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO speakers (id, event_id, user_id, display_name, visible, version, created_at, updated_at) VALUES ('recusal-speaker', 'recusal-event', 'recusal-user', 'Recusal Reviewer', 1, 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO forms (id, event_id, kind, name, status, version, created_at, updated_at) VALUES ('recusal-form', 'recusal-event', 'cfp', 'Recusal CFP', 'closed', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO form_versions (id, event_id, form_id, version_number, name, published_at, created_at) VALUES ('recusal-form-v1', 'recusal-event', 'recusal-form', 1, 'Recusal CFP', ?, ?)").bind(now, now),
      db.prepare("INSERT INTO submissions (id, event_id, form_id, form_version_id, title, status, submitted_at, version, created_at, updated_at) VALUES ('recusal-submission', 'recusal-event', 'recusal-form', 'recusal-form-v1', 'Recusal proposal', 'submitted', ?, 1, ?, ?)").bind(now, now, now),
      db.prepare("INSERT INTO review_rounds (id, event_id, name, `order`, status, rubric, version, created_at, updated_at) VALUES ('recusal-round', 'recusal-event', 'Review', 1, 'active', '{\"criteria\":[{\"key\":\"clarity\",\"label\":\"Clarity\",\"max\":5}]}', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO review_assignments (id, event_id, round_id, submission_id, reviewer_user_id, version, created_at, updated_at) VALUES ('recusal-assignment-old', 'recusal-event', 'recusal-round', 'recusal-submission', 'recusal-user', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO assets (id, event_id, uploader_user_id, filename, content_type, size, version, created_at, updated_at) VALUES ('legacy-asset', 'recusal-event', 'recusal-user', 'legacy.pdf', 'application/pdf', 42, 3, ?, ?)").bind(now, now),
    ]);
    await db.prepare(
      "UPDATE speakers SET headshot_asset_id = 'legacy-asset' WHERE id = 'recusal-speaker'",
    ).run();
    expect(await db.prepare(
      "SELECT headshot_asset_id FROM speakers WHERE id = 'recusal-speaker'",
    ).first()).toEqual({ headshot_asset_id: "legacy-asset" });

    await applyOneByOne(db, migrations.slice(11));
    expect(await db.prepare(
      "SELECT id, status, recusal_reason, recused_at, version FROM review_assignments WHERE id = 'recusal-assignment-old'",
    ).first()).toEqual({
      id: "recusal-assignment-old",
      status: "assigned",
      recusal_reason: null,
      recused_at: null,
      version: 1,
    });
    expect(await db.prepare(
      "SELECT speaker_id, purpose, supersedes_asset_id, restored_from_asset_id, current, version FROM assets WHERE id = 'legacy-asset'",
    ).first()).toEqual({
      speaker_id: null,
      purpose: null,
      supersedes_asset_id: null,
      restored_from_asset_id: null,
      current: 1,
      version: 3,
    });
    expect(await db.prepare(
      "SELECT headshot_asset_id FROM speakers WHERE id = 'recusal-speaker'",
    ).first()).toEqual({ headshot_asset_id: "legacy-asset" });
    expect(await db.prepare(
      "SELECT starts_at, ends_at, blind FROM review_rounds WHERE id = 'recusal-round'",
    ).first()).toEqual({ starts_at: null, ends_at: null, blind: 0 });
    await db.prepare("UPDATE review_assignments SET status = 'recused', recusal_reason = 'Conflict', recused_at = ?, version = 2, updated_at = ? WHERE id = 'recusal-assignment-old'").bind(now + 1, now + 1).run();
    await db.prepare("INSERT INTO review_assignments (id, event_id, round_id, submission_id, reviewer_user_id, status, version, created_at, updated_at) VALUES ('recusal-assignment-new', 'recusal-event', 'recusal-round', 'recusal-submission', 'recusal-user', 'assigned', 1, ?, ?)").bind(now + 2, now + 2).run();
    await expect(db.prepare("INSERT INTO review_assignments (id, event_id, round_id, submission_id, reviewer_user_id, status, version, created_at, updated_at) VALUES ('recusal-assignment-duplicate', 'recusal-event', 'recusal-round', 'recusal-submission', 'recusal-user', 'assigned', 1, ?, ?)").bind(now + 3, now + 3).run()).rejects.toThrow(/review_assignments/);
    await assertDatabaseIntegrity(db);
  });

  it("repairs duplicate current asset lineages before enforcing uniqueness", async () => {
    const migrations = testMigrations();
    const db = (env as TestEnv).MIGRATION_DB;
    expect(migrations).toHaveLength(16);
    const lineageMigration = migrations.find(({ name }) => name.startsWith("0012_groovy_epoch"));
    if (!lineageMigration) throw new Error("Asset-lineage migration is unavailable");
    await applyOneByOne(db, migrations.filter((migration) => migration !== lineageMigration));
    await db.prepare("DROP INDEX IF EXISTS assets_current_lineage_unique").run();
    const now = 1_700_000_000_000;
    await db.batch([
      db.prepare("INSERT INTO users (id, email, name, version, created_at, updated_at) VALUES ('lineage-user', 'lineage@example.com', 'Lineage User', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at) VALUES ('lineage-event', 'lineage-event', 'Lineage Event', 'UTC', 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO speakers (id, event_id, display_name, workflow_status, links, visible, version, created_at, updated_at) VALUES ('lineage-speaker', 'lineage-event', 'Lineage Speaker', 'Ready', '[]', 1, 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO assets (id, event_id, uploader_user_id, speaker_id, purpose, filename, content_type, size, supersedes_asset_id, restored_from_asset_id, current, version, created_at, updated_at) VALUES ('lineage-old', 'lineage-event', 'lineage-user', 'lineage-speaker', 'slides', 'old.pdf', 'application/pdf', 10, NULL, NULL, 1, 1, ?, ?)").bind(now, now),
      db.prepare("INSERT INTO assets (id, event_id, uploader_user_id, speaker_id, purpose, filename, content_type, size, supersedes_asset_id, restored_from_asset_id, current, version, created_at, updated_at) VALUES ('lineage-new', 'lineage-event', 'lineage-user', 'lineage-speaker', 'slides', 'new.pdf', 'application/pdf', 20, 'lineage-old', NULL, 1, 2, ?, ?)").bind(now + 1, now + 1),
    ]);

    const repairQuery = lineageMigration.queries.find((query) => query.includes("UPDATE `assets`") && query.includes("`preferred`"));
    const indexQuery = lineageMigration.queries.find((query) => query.includes("CREATE UNIQUE INDEX `assets_current_lineage_unique`"));
    if (!repairQuery || !indexQuery) throw new Error("Asset-lineage repair statements are unavailable");
    await db.batch([db.prepare(repairQuery), db.prepare(indexQuery)]);
    expect((await db.prepare(
      "SELECT id, current FROM assets WHERE event_id = 'lineage-event' ORDER BY id",
    ).all()).results).toEqual([
      { id: "lineage-new", current: 1 },
      { id: "lineage-old", current: 0 },
    ]);
    await expect(db.prepare("UPDATE assets SET current = 1 WHERE id = 'lineage-old'").run())
      .rejects.toThrow(/assets_current_lineage_unique|UNIQUE constraint failed/);
    await assertDatabaseIntegrity(db);
  });
});
