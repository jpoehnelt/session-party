import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";

const localSecret = "explicit-local-only-session-secret-v1";
const createdAt = 1_786_118_400_000;
const expiresAt = 4_102_444_800_000;
const expiredAt = 1_700_000_000_000;
const eventStartsAt = 1_789_660_800_000;
const eventEndsAt = 1_789_858_800_000;

const hmac = (value: string): string =>
  createHmac("sha256", localSecret).update(value).digest("hex");
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown): string => quote(JSON.stringify(value));

const corePersonas = [
  ["demo-owner", "owner@sessionparty.local", "Olivia Owner", "demo-owner-session", expiresAt],
  ["demo-admin", "admin@sessionparty.local", "Amari Admin", "demo-admin-session", expiresAt],
  ["demo-reviewer", "reviewer@sessionparty.local", "Riley Reviewer", "demo-reviewer-session", expiresAt],
  ["demo-speaker", "speaker@sessionparty.local", "Sam Speaker", "demo-speaker-session", expiresAt],
  ["demo-observer", "observer@sessionparty.local", "Owen Observer", "demo-observer-session", expiresAt],
  ["demo-expired", "expired@sessionparty.local", "Emery Expired", "demo-expired-session", expiredAt],
] as const;

const fixtureSpeakerNames = [
  "Alex Morgan", "Avery Chen", "Blair Okafor", "Cameron Singh", "Casey Rivera",
  "Dakota Kim", "Drew Williams", "Elliot Hassan", "Emerson Silva", "Finley Jones",
  "Harper Brown", "Hayden Garcia", "Jamie Patel", "Jordan Lee", "Kai Thompson",
  "Kendall Martin", "Lane Davis", "Logan Wilson", "Marley Taylor", "Morgan Clark",
  "Nico Anderson", "Parker Lewis", "Quinn Robinson", "Reese Walker", "Remy Martinez",
  "Robin Moore", "Rowan Hall", "Sasha Nguyen", "Taylor Jackson",
] as const;

const fixtureSpeakerPersonas = fixtureSpeakerNames.map((name, index) => {
  const ordinal = String(index + 2).padStart(2, "0");
  return [
    `demo-speaker-${ordinal}`,
    `speaker${ordinal}@sessionparty.local`,
    name,
    `demo-speaker-${ordinal}-session`,
    expiresAt,
  ] as const;
});

const personas = [...corePersonas, ...fixtureSpeakerPersonas] as const;

const userValues = personas.map(([id, email, name]) =>
  `(${quote(id)}, ${quote(email)}, ${quote(name)}, NULL, 1, ${createdAt}, ${createdAt})`
).join(",\n  ");
const tokenValues = [
  ...personas.map(([userId, , , token, expiry]) =>
    `(${quote(`${userId}-token`)}, ${quote(hmac(token))}, ${quote(userId)}, 'session', ${expiry}, NULL, ${createdAt})`
  ),
  `('local-smoke-session-token', ${quote(hmac("local-smoke-session"))}, 'demo-owner', 'session', ${expiresAt}, NULL, ${createdAt})`,
].join(",\n  ");

const rubric = {
  criteria: [
    { key: "relevance", label: "Audience relevance", description: "Clear value for working AI engineers.", max: 5 },
    { key: "specificity", label: "Specificity", description: "Concrete techniques and evidence.", max: 5 },
    { key: "delivery", label: "Delivery plan", description: "A credible, engaging session structure.", max: 5 },
  ],
};

const sql = `
DELETE FROM events WHERE id = 'demo-event';
DELETE FROM auth_tokens WHERE user_id IN (${personas.map(([id]) => quote(id)).join(", ")});
DELETE FROM users WHERE id IN (${personas.map(([id]) => quote(id)).join(", ")});

INSERT INTO users (id, email, name, avatar_asset_id, version, created_at, updated_at)
VALUES
  ${userValues};

INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at)
VALUES
  ${tokenValues};

INSERT INTO events (
  id, slug, name, description, location, timezone, starts_at, ends_at,
  banner_asset_id, accent_color, version, created_at, updated_at
)
VALUES (
  'demo-event', 'ai-engineer-sandbox', 'AI Engineer Sandbox',
  'A deterministic end-to-end conference production workspace.', 'Pier 27, San Francisco',
  'America/Los_Angeles', ${eventStartsAt}, ${eventEndsAt}, NULL, '#635BFF', 1,
  ${createdAt}, ${createdAt}
);

INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at)
VALUES
  ('demo-member-owner', 'demo-event', 'demo-owner', 'owner', 1, ${createdAt}, ${createdAt}),
  ('demo-member-admin', 'demo-event', 'demo-admin', 'admin', 1, ${createdAt}, ${createdAt}),
  ('demo-member-reviewer', 'demo-event', 'demo-reviewer', 'reviewer', 1, ${createdAt}, ${createdAt});

INSERT INTO review_rounds (id, event_id, name, \`order\`, status, rubric, version, created_at, updated_at)
VALUES
  ('demo-review-round-active', 'demo-event', 'Program review', 1, 'active', ${json(rubric)}, 1, ${createdAt}, ${createdAt}),
  ('demo-review-round-final', 'demo-event', 'Final selection', 2, 'pending', ${json(rubric)}, 1, ${createdAt}, ${createdAt});

INSERT INTO tracks (id, event_id, name, color, \`order\`, version, created_at, updated_at)
VALUES
  ('demo-track-systems', 'demo-event', 'AI systems', '#635BFF', 1, 1, ${createdAt}, ${createdAt}),
  ('demo-track-tools', 'demo-event', 'Developer tools', '#0F9D8A', 2, 1, ${createdAt}, ${createdAt}),
  ('demo-track-research', 'demo-event', 'Applied research', '#D97706', 3, 1, ${createdAt}, ${createdAt}),
  ('demo-track-leadership', 'demo-event', 'Engineering leadership', '#DB2777', 4, 1, ${createdAt}, ${createdAt});

INSERT INTO rooms (id, event_id, name, capacity, \`order\`, version, created_at, updated_at)
VALUES
  ('demo-room-harbor', 'demo-event', 'Harbor Stage', 220, 1, 1, ${createdAt}, ${createdAt}),
  ('demo-room-summit', 'demo-event', 'Summit Room', 140, 2, 1, ${createdAt}, ${createdAt}),
  ('demo-room-studio', 'demo-event', 'Builder Studio', 90, 3, 1, ${createdAt}, ${createdAt}),
  ('demo-room-lab', 'demo-event', 'Research Lab', 70, 4, 1, ${createdAt}, ${createdAt});

INSERT INTO integrations (
  id, event_id, kind, secret_ref, config, cursor, last_sync_at, last_error,
  version, created_at, updated_at
)
VALUES (
  'demo-accelevents', 'demo-event', 'accelevents', 'ACCELEVENTS_API_TOKEN',
  ${json({ kind: "accelevents", accelEventId: "fixture-event", eventUrl: "fixture-event" })},
  NULL, NULL, NULL, 1, ${createdAt}, ${createdAt}
);

INSERT INTO api_keys (
  id, event_id, name, key_hash, scopes, expires_at, revoked_at, created_by,
  version, created_at, updated_at
)
VALUES (
  'local-api-key', 'demo-event', 'Local Smoke', ${quote(hmac("local-smoke-api-key"))},
  '["event:read"]', ${expiresAt}, NULL, 'demo-owner', 1, ${createdAt}, ${createdAt}
);
`;

const result = spawnSync(
  "pnpm",
  [
    "wrangler",
    "d1",
    "execute",
    "session-party",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--command",
    sql,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(JSON.stringify({
  mode: "local-fake",
  seeded: true,
  event: { id: "demo-event", slug: "ai-engineer-sandbox" },
  personas: Object.fromEntries(personas.map(([id, , , token]) => [id.replace("demo-", ""), token])),
}));
