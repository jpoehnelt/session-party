import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";

const localSecret = "explicit-local-only-session-secret-v1";
const session = "local-smoke-session";
const apiKey = "local-smoke-api-key";
const hmac = (value: string): string =>
  createHmac("sha256", localSecret).update(value).digest("hex");

const createdAt = 1_700_000_000_000;
const expiresAt = 4_102_444_800_000;
const sql = `
INSERT OR REPLACE INTO users (id, email, name, version, created_at, updated_at)
VALUES ('local-user', 'local@example.invalid', 'Local Operator', 1, ${createdAt}, ${createdAt});
INSERT OR REPLACE INTO events (id, slug, name, timezone, version, created_at, updated_at)
VALUES ('local-event', 'local-event', 'Local Event', 'UTC', 1, ${createdAt}, ${createdAt});
INSERT OR REPLACE INTO event_members (id, event_id, user_id, role, version, created_at, updated_at)
VALUES ('local-member', 'local-event', 'local-user', 'owner', 1, ${createdAt}, ${createdAt});
INSERT OR REPLACE INTO forms (id, event_id, kind, name, description, status, version, created_at, updated_at)
VALUES ('local-cfp', 'local-event', 'cfp', 'Local CFP', 'Deterministic local submission form', 'open', 1, ${createdAt}, ${createdAt});
INSERT OR REPLACE INTO form_fields (id, event_id, form_id, \`order\`, type, label, semantic_key, required, version, created_at, updated_at)
VALUES
  ('local-cfp-title', 'local-event', 'local-cfp', 0, 'text', 'Session title', 'submissionTitle', 1, 1, ${createdAt}, ${createdAt}),
  ('local-cfp-abstract', 'local-event', 'local-cfp', 1, 'textarea', 'Session abstract', 'submissionAbstract', 1, 1, ${createdAt}, ${createdAt}),
  ('local-cfp-speaker-name', 'local-event', 'local-cfp', 2, 'text', 'Speaker name', 'speakerName', 1, 1, ${createdAt}, ${createdAt}),
  ('local-cfp-speaker-email', 'local-event', 'local-cfp', 3, 'email', 'Speaker email', 'speakerEmail', 1, 1, ${createdAt}, ${createdAt});
INSERT OR REPLACE INTO form_versions (id, event_id, form_id, version_number, name, description, published_at, retired_at, created_at)
VALUES ('local-cfp-v1', 'local-event', 'local-cfp', 1, 'Local CFP', 'Deterministic local submission form', ${createdAt}, NULL, ${createdAt});
INSERT OR REPLACE INTO form_version_fields (id, event_id, form_version_id, source_field_id, \`order\`, type, label, semantic_key, required, created_at)
VALUES
  ('local-cfp-v1-title', 'local-event', 'local-cfp-v1', 'local-cfp-title', 0, 'text', 'Session title', 'submissionTitle', 1, ${createdAt}),
  ('local-cfp-v1-abstract', 'local-event', 'local-cfp-v1', 'local-cfp-abstract', 1, 'textarea', 'Session abstract', 'submissionAbstract', 1, ${createdAt}),
  ('local-cfp-v1-speaker-name', 'local-event', 'local-cfp-v1', 'local-cfp-speaker-name', 2, 'text', 'Speaker name', 'speakerName', 1, ${createdAt}),
  ('local-cfp-v1-speaker-email', 'local-event', 'local-cfp-v1', 'local-cfp-speaker-email', 3, 'email', 'Speaker email', 'speakerEmail', 1, ${createdAt});
INSERT OR REPLACE INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at)
VALUES ('local-session', '${hmac(session)}', 'local-user', 'session', ${expiresAt}, NULL, ${createdAt});
INSERT OR REPLACE INTO api_keys (id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by, version, created_at, updated_at)
VALUES ('local-api-key', 'local-event', 'Local Smoke', '${hmac(apiKey)}', '["event:read"]', ${expiresAt}, NULL, 'local-user', 1, ${createdAt}, ${createdAt});
`;

const result = spawnSync(
  "pnpm",
  ["wrangler", "d1", "execute", "session-party", "--local", "--command", sql],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(JSON.stringify({ mode: "local-fake", seeded: true }));
