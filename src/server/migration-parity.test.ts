import {
  applyD1Migrations,
  env,
  SELF,
  type D1Migration,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
    "INSERT INTO form_fields (id, form_id, `order`, type, label, required, created_at, updated_at) VALUES ('legacy-field', 'legacy-form', 0, 'textarea', 'Abstract', 1, 1700000000000, 1700000000000)",
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

describe("baseline migration parity", () => {
  it("applies every migration to a blank database and serves authenticated events", async () => {
    await applyOneByOne(env.DB, testMigrations());
    await assertDatabaseIntegrity(env.DB);
    await proveAuthenticatedEventRoundTrip();
  });

  it("upgrades nonempty 0000 rows without losing identity or history", async () => {
    const migrations = testMigrations();
    const db = (env as TestEnv).MIGRATION_DB;
    expect(migrations).toHaveLength(4);
    await applyOneByOne(db, migrations.slice(0, 1));
    await seedLegacyRows(db);
    await applyOneByOne(db, migrations.slice(1));

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

    const answer = await db.prepare(
      "SELECT id, event_id, form_version_id, form_version_field_id, value FROM submission_answers WHERE id = 'legacy-answer'",
    ).first();
    expect(answer).toMatchObject({
      id: "legacy-answer",
      event_id: "legacy-event",
      form_version_id: "legacy-v1:legacy-form",
      form_version_field_id: "legacy-field",
      value: "\"Legacy abstract\"",
    });
    const semantics = await db.prepare(
      "SELECT (SELECT semantic_key FROM form_fields WHERE id = 'legacy-field') AS draft_semantic_key, (SELECT semantic_key FROM form_version_fields WHERE id = 'legacy-field') AS version_semantic_key",
    ).first();
    expect(semantics).toEqual({ draft_semantic_key: null, version_semantic_key: null });

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
    const upgradedEnv = Object.assign(Object.create(env), { DB: db }) as Env;
    expect(await userFromRequest(
      new Request("https://example.test", {
        headers: { Cookie: "sp_session=legacy-token-material" },
      }),
      upgradedEnv,
    )).toBeNull();
    expect(await apiKeyUserFromRequest(
      new Request("https://example.test", {
        headers: { Authorization: "Bearer raw-legacy-key-material" },
      }),
      upgradedEnv,
    )).toBeNull();

    await expect(db.prepare(
      "INSERT INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, created_by, version, created_at, updated_at) VALUES ('invalid-scope-key', 'legacy-event', 'Invalid', ?, '[\"bogus:scope\"]', 1800000000000, 'legacy-user', 1, 1700000000000, 1700000000000)",
    ).bind("f".repeat(64)).run()).rejects.toThrow(/known scopes/);
  });

  it("adds Accelevents evidence tables without rewriting configured integrations", async () => {
    const migrations = testMigrations();
    const db = (env as TestEnv).MIGRATION_DB;
    expect(migrations).toHaveLength(4);
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
});
