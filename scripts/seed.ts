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
  ["demo-owner", "sbek-organizer@example.com", "Jordan Alvarez", "demo-owner-session", expiresAt],
  ["demo-admin", "admin@sessionparty.local", "Amari Admin", "demo-admin-session", expiresAt],
  ["demo-reviewer", "sbek-reviewer@example.com", "Sam Whitfield", "demo-reviewer-session", expiresAt],
  ["demo-reviewer-unassigned", "unassigned-reviewer@sessionparty.local", "Uma Unassigned", "demo-reviewer-unassigned-session", expiresAt],
  ["demo-reviewer-recused", "recused-reviewer@sessionparty.local", "Riley Recused", "demo-reviewer-recused-session", expiresAt],
  ["demo-speaker", "sbek-speaker@example.com", "Priya Raman", "demo-speaker-session", expiresAt],
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

const directorySpeakers = [
  { speakerId: "demo-directory-priya", eventId: "demo-event", userId: "demo-speaker", email: "sbek-speaker@example.com", name: "Priya Raman" },
  { speakerId: "demo-directory-priya-managed", eventId: "demo-other-event", userId: null, email: "sbek-speaker@example.com", name: "Priya Raman" },
  ...fixtureSpeakerPersonas.slice(0, 12).map(([userId, email, name], index) => ({
    speakerId: `demo-directory-speaker-${String(index + 2).padStart(2, "0")}`,
    eventId: index % 3 === 0 ? "demo-other-event" : "demo-event",
    userId,
    email,
    name,
  })),
] as const;

const directoryProfileValues = directorySpeakers
  .filter((speaker): speaker is typeof speaker & { readonly userId: string } => speaker.userId !== null)
  .map((speaker, index) => `(
    ${quote(`demo-directory-profile-${speaker.userId}`)}, ${quote(speaker.userId)},
    ${quote(`directory-${speaker.userId}`)}, ${quote(speaker.name)},
    ${quote(index % 2 === 0 ? "Principal engineer" : "Research lead")},
    ${quote(index % 2 === 0 ? "Session Party Labs" : "Independent")},
    ${quote(`Reusable profile for ${speaker.name}.`)}, NULL, '[]', 0, 1, ${createdAt}, ${createdAt}
  )`).join(",\n  ");
const directorySpeakerValues = directorySpeakers.map((speaker, index) => `(
  ${quote(speaker.speakerId)}, ${quote(speaker.eventId)}, ${speaker.userId ? quote(speaker.userId) : "NULL"},
  ${quote(speaker.email)}, ${quote(speaker.name)},
  ${quote(index % 2 === 0 ? "Principal engineer" : "Research lead")},
  ${quote(index % 2 === 0 ? "Session Party Labs" : "Independent")},
  ${quote(`Event profile for ${speaker.name}.`)}, 'Ready', NULL, NULL, '[]', 1,
  ${speaker.userId ? quote(`demo-directory-profile-${speaker.userId}`) : "NULL"},
  ${speaker.userId ? "1" : "NULL"}, 'approved', NULL, NULL, ${createdAt}, 'demo-owner',
  1, ${createdAt}, ${createdAt}
)`).join(",\n  ");
const directorySubmissionValues = directorySpeakers.map((speaker, index) => {
  const accepted = index % 3 !== 1;
  const suffix = speaker.eventId === "demo-event" ? "main" : "other";
  const at = createdAt + index * 86_400_000;
  return `(
    ${quote(`demo-directory-submission-${index}`)}, ${quote(speaker.eventId)},
    ${quote(`demo-directory-form-${suffix}`)}, ${quote(`demo-directory-form-version-${suffix}`)},
    ${quote(`${speaker.name}: Practical systems`)}, 'AI systems', ${quote(accepted ? "accepted" : "submitted")},
    ${at}, ${accepted ? at : "NULL"}, 1, ${at}, ${at}
  )`;
}).join(",\n  ");
const directoryAssociationValues = directorySpeakers.map((speaker, index) => `(
  ${quote(`demo-directory-association-${index}`)}, ${quote(speaker.eventId)},
  ${quote(`demo-directory-submission-${index}`)}, ${quote(speaker.speakerId)}, 1,
  'speaker', NULL, NULL, ${createdAt + index * 86_400_000}
)`).join(",\n  ");
const confirmedDirectorySpeakers = directorySpeakers.filter((_, index) => index % 2 === 0);
const directoryTalkValues = confirmedDirectorySpeakers.map((speaker, index) => {
  const sourceIndex = directorySpeakers.indexOf(speaker);
  const at = createdAt + index * 3_600_000;
  return `(
    ${quote(`demo-directory-talk-${sourceIndex}`)}, ${quote(speaker.eventId)},
    ${quote(`demo-directory-submission-${sourceIndex}`)}, ${quote(`${speaker.name}: Practical systems`)},
    ${quote(`Confirmed session by ${speaker.name}.`)}, NULL, NULL, ${at}, 30, 'confirmed', 1, ${createdAt}, ${createdAt}
  )`;
}).join(",\n  ");
const directoryTalkSpeakerValues = confirmedDirectorySpeakers.map((speaker) => {
  const sourceIndex = directorySpeakers.indexOf(speaker);
  return `(
    ${quote(`demo-directory-talk-speaker-${sourceIndex}`)}, ${quote(speaker.eventId)},
    ${quote(`demo-directory-talk-${sourceIndex}`)}, ${quote(speaker.speakerId)}, ${createdAt}
  )`;
}).join(",\n  ");

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
DELETE FROM events WHERE id = 'demo-other-event';
DELETE FROM install_grants WHERE user_id IN (${personas.map(([id]) => quote(id)).join(", ")});
DELETE FROM auth_tokens WHERE user_id IN (${personas.map(([id]) => quote(id)).join(", ")});
DELETE FROM users WHERE id IN (${personas.map(([id]) => quote(id)).join(", ")});

INSERT INTO users (id, email, name, avatar_asset_id, version, created_at, updated_at)
VALUES
  ${userValues};

INSERT INTO auth_tokens (id, token_hash, user_id, kind, expires_at, consumed_at, created_at)
VALUES
  ${tokenValues};

INSERT INTO install_grants (
  id, user_id, role, granted_by_user_id, granted_at, revoked_by_user_id, revoked_at,
  grant_key_hash, grant_request_hash, revoke_key_hash, revoke_request_hash,
  version, created_at, updated_at
)
VALUES (
  'demo-install-staff', 'demo-owner', 'staff', 'demo-owner', ${createdAt}, NULL, NULL,
  NULL, NULL, NULL, NULL, 1, ${createdAt}, ${createdAt}
);

INSERT INTO events (
  id, slug, name, description, location, timezone, starts_at, ends_at,
  banner_asset_id, accent_color, version, created_at, updated_at
)
VALUES (
  'demo-event', 'ai-engineer-sandbox', 'AI Engineer Sandbox',
  'A deterministic end-to-end conference production workspace.', 'Pier 27, San Francisco',
  'America/Los_Angeles', ${eventStartsAt}, ${eventEndsAt}, NULL, '#635BFF', 1,
  ${createdAt}, ${createdAt}
), (
  'demo-other-event', 'other-event-sandbox', 'Other Event Sandbox',
  'An isolation fixture that must never grant access to AI Engineer Sandbox.', 'Remote',
  'UTC', ${eventStartsAt}, ${eventEndsAt}, NULL, '#171714', 1,
  ${createdAt}, ${createdAt}
);

INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at)
VALUES
  ('demo-member-owner', 'demo-event', 'demo-owner', 'owner', 1, ${createdAt}, ${createdAt}),
  ('demo-member-admin', 'demo-event', 'demo-admin', 'admin', 1, ${createdAt}, ${createdAt}),
  ('demo-member-reviewer', 'demo-event', 'demo-reviewer', 'reviewer', 1, ${createdAt}, ${createdAt}),
  ('demo-member-reviewer-unassigned', 'demo-event', 'demo-reviewer-unassigned', 'reviewer', 1, ${createdAt}, ${createdAt}),
  ('demo-member-reviewer-recused', 'demo-event', 'demo-reviewer-recused', 'reviewer', 1, ${createdAt}, ${createdAt}),
  ('demo-member-other-event', 'demo-other-event', 'demo-observer', 'owner', 1, ${createdAt}, ${createdAt});

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

INSERT INTO speaker_profiles (
  id, user_id, slug, display_name, title, company, bio, headshot_url, links,
  visible, version, created_at, updated_at
)
VALUES
  ${directoryProfileValues};

INSERT INTO forms (
  id, event_id, kind, name, description, status, opens_at, closes_at,
  version, created_at, updated_at
)
VALUES
  ('demo-directory-form-main', 'demo-event', 'cfp', 'Directory fixture CFP', NULL, 'closed', NULL, NULL, 1, ${createdAt}, ${createdAt}),
  ('demo-directory-form-other', 'demo-other-event', 'cfp', 'Directory fixture CFP', NULL, 'closed', NULL, NULL, 1, ${createdAt}, ${createdAt});

INSERT INTO form_versions (
  id, event_id, form_id, version_number, name, description, published_at, retired_at, created_at
)
VALUES
  ('demo-directory-form-version-main', 'demo-event', 'demo-directory-form-main', 1, 'Directory fixture CFP', NULL, ${createdAt}, NULL, ${createdAt}),
  ('demo-directory-form-version-other', 'demo-other-event', 'demo-directory-form-other', 1, 'Directory fixture CFP', NULL, ${createdAt}, NULL, ${createdAt});

INSERT INTO speakers (
  id, event_id, user_id, contact_email, display_name, title, company, bio,
  workflow_status, headshot_asset_id, headshot_url, links, visible,
  profile_source_id, profile_source_version, profile_review_status, profile_review_note,
  profile_submitted_at, profile_reviewed_at, profile_reviewed_by,
  version, created_at, updated_at
)
VALUES
  ${directorySpeakerValues};

INSERT INTO managed_speaker_emails (id, event_id, normalized_email, speaker_id, created_at, updated_at)
VALUES (
  'demo-directory-priya-managed-email', 'demo-other-event', 'sbek-speaker@example.com',
  'demo-directory-priya-managed', ${createdAt}, ${createdAt}
);

INSERT INTO submissions (
  id, event_id, form_id, form_version_id, title, category, status,
  submitted_at, accepted_at, version, created_at, updated_at
)
VALUES
  ${directorySubmissionValues};

INSERT INTO submission_speakers (
  id, event_id, submission_id, speaker_id, is_primary, role_label,
  title_at_time, organization_at_time, created_at
)
VALUES
  ${directoryAssociationValues};

INSERT INTO talks (
  id, event_id, submission_id, title, description, track_id, room_id, starts_at,
  duration_min, status, version, created_at, updated_at
)
VALUES
  ${directoryTalkValues};

INSERT INTO talk_speakers (id, event_id, talk_id, speaker_id, created_at)
VALUES
  ${directoryTalkSpeakerValues};

INSERT INTO speaker_contacts (
  id, event_id, speaker_id, actor_user_id, medium, note, contacted_at, created_at
)
VALUES
  ('demo-directory-contact-priya', 'demo-event', 'demo-directory-priya', 'demo-owner',
   'personalEmail', 'Asked Priya about the next edition.', ${createdAt}, ${createdAt}),
  ('demo-directory-contact-priya-managed', 'demo-other-event', 'demo-directory-priya-managed', 'demo-owner',
   'toolEmail', 'Sent the prior-event logistics note.', ${createdAt + 86_400_000}, ${createdAt + 86_400_000});
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
