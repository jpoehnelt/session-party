import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertCompatibleDemoUsers,
  assertExactProductionTarget,
  buildDemoReplacementSql,
  demoTarget,
  fixtureUserCollisionSql,
  type DemoUserIdentity,
  type ProductionEventIdentity,
} from "./demo-reconcile";

const { eventId, eventSlug, productionConfirmation } = demoTarget;
const localIsolationEventId = "demo-other-event";
const applyProduction = process.argv.includes("--apply-production");
const prepareReconciliation = process.argv.includes("--prepare-reconciliation");
const inspectProduction = process.argv.includes("--inspect-production");
if (prepareReconciliation && applyProduction) {
  throw new Error("Reconciliation preparation is deliberately dry-run-only; remove --apply-production.");
}
if (prepareReconciliation && !inspectProduction) {
  throw new Error("Reconciliation preparation requires the read-only --inspect-production preflight.");
}
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "session-party-demo-"));
const outputPath = outputArgument
  ? resolve(outputArgument.slice("--output=".length))
  : join(temporaryDirectory, "session-party-demo.sql");
const sqlQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const snapshotTables = [
  "events",
  "users",
  "speaker_profiles",
  "speaker_profile_changes",
  "event_members",
  "assets",
  "forms",
  "form_fields",
  "form_versions",
  "form_version_fields",
  "submissions",
  "submission_answers",
  "speakers",
  "submission_speakers",
  "review_rounds",
  "review_assignments",
  "reviews",
  "acceptance_events",
  "speaker_provisioning",
  "tracks",
  "rooms",
  "talks",
  "talk_speakers",
  "tasks",
  "task_completions",
  "pages",
  "email_templates",
  "mail_delivery_snapshots",
  "mail_deliveries",
  "mail_delivery_attempts",
  "integrations",
  "accelevents_external_identities",
  "accelevents_import_runs",
  "accelevents_import_items",
  "audit_log",
  "idempotency_records",
  "domain_changes",
] as const;

const verificationSql = `
SELECT
  (SELECT count(*) FROM events WHERE id = '${eventId}' AND slug = '${eventSlug}') AS events,
  (SELECT count(*) FROM forms WHERE event_id = '${eventId}') AS forms,
  (SELECT count(*) FROM submissions s INNER JOIN forms f ON f.event_id = s.event_id AND f.id = s.form_id WHERE s.event_id = '${eventId}' AND f.kind = 'cfp') AS submissions,
  (SELECT count(*) FROM submissions s INNER JOIN forms f ON f.event_id = s.event_id AND f.id = s.form_id WHERE s.event_id = '${eventId}' AND f.kind = 'cfp' AND s.status = 'accepted') AS accepted,
  (SELECT count(*) FROM speaker_provisioning WHERE event_id = '${eventId}' AND status = 'provisioned') AS provisioned,
  (SELECT count(*) FROM talks WHERE event_id = '${eventId}' AND submission_id IS NOT NULL) AS canonical_talks,
  (SELECT count(*) FROM talks WHERE event_id = '${eventId}' AND submission_id IS NOT NULL AND trim(coalesce(description, '')) <> '') AS described_talks,
  (SELECT count(DISTINCT date(starts_at / 1000, 'unixepoch')) FROM talks WHERE event_id = '${eventId}' AND submission_id IS NOT NULL AND starts_at IS NOT NULL) AS schedule_days,
  (SELECT count(*) FROM tracks WHERE event_id = '${eventId}') AS tracks,
  (SELECT count(*) FROM rooms WHERE event_id = '${eventId}') AS rooms,
  (SELECT count(*) FROM tasks WHERE event_id = '${eventId}') AS tasks,
  (SELECT count(*) FROM pages WHERE event_id = '${eventId}') AS resources,
  (SELECT count(*) FROM assets WHERE event_id = '${eventId}') AS assets,
  (SELECT count(*) FROM speaker_profiles WHERE user_id = 'demo-speaker' AND slug = 'priya-raman' AND visible = 1) AS reusable_profiles,
  (SELECT count(*) FROM speaker_profile_changes c INNER JOIN speaker_profiles p ON p.id = c.profile_id WHERE p.user_id = 'demo-speaker') AS reusable_profile_changes,
  (SELECT count(*) FROM speakers s INNER JOIN speaker_profiles p ON p.id = s.profile_source_id WHERE s.event_id = '${eventId}' AND p.user_id = s.user_id) AS linked_event_profiles,
  (SELECT count(*) FROM domain_changes WHERE event_id = '${eventId}' AND aggregate_type = 'agenda-publication' AND event_type = 'agenda/published') AS agenda_publications,
  (SELECT count(*) FROM domain_changes WHERE event_id = '${eventId}' AND aggregate_type = 'speaker-publication' AND event_type = 'portal/speakers-published') AS speaker_publications,
  (SELECT count(*) FROM speakers s WHERE s.event_id = '${eventId}' AND s.visible = 1 AND s.profile_review_status = 'approved' AND EXISTS (SELECT 1 FROM acceptance_events a WHERE a.event_id = s.event_id AND a.primary_speaker_id = s.id AND a.type = 'accepted')) AS public_speakers,
  (SELECT count(*) FROM speakers s WHERE s.event_id = '${eventId}' AND s.visible = 1 AND s.profile_review_status = 'approved' AND trim(coalesce(s.title, '')) <> '' AND trim(coalesce(s.company, '')) <> '' AND trim(coalesce(s.bio, '')) <> '' AND EXISTS (SELECT 1 FROM acceptance_events a WHERE a.event_id = s.event_id AND a.primary_speaker_id = s.id AND a.type = 'accepted')) AS complete_public_profiles,
  (SELECT count(*) FROM speakers s WHERE s.event_id = '${eventId}' AND s.visible = 1 AND s.profile_review_status = 'approved' AND s.headshot_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM acceptance_events a WHERE a.event_id = s.event_id AND a.primary_speaker_id = s.id AND a.type = 'accepted')) AS public_headshots,
  (SELECT count(*) FROM event_members m INNER JOIN users u ON u.id = m.user_id WHERE m.event_id = '${eventId}' AND m.role = 'owner' AND u.email = 'sbek-organizer@example.com') AS organizer_personas,
  (SELECT count(*) FROM event_members m INNER JOIN users u ON u.id = m.user_id WHERE m.event_id = '${eventId}' AND m.role = 'reviewer' AND u.email = 'sbek-reviewer@example.com') AS reviewer_personas,
  (SELECT count(*) FROM speakers s INNER JOIN users u ON u.id = s.user_id WHERE s.event_id = '${eventId}' AND s.display_name = 'Priya Raman' AND u.email = 'sbek-speaker@example.com') AS speaker_personas,
  (SELECT count(*) FROM mail_deliveries d INNER JOIN mail_delivery_snapshots s ON s.id = d.snapshot_id WHERE s.event_id = '${eventId}' AND d.status = 'sent') AS sent_mail,
  (SELECT count(*) FROM accelevents_import_runs WHERE event_id = '${eventId}' AND status = 'succeeded') AS completed_imports;
`;

type Verification = {
  readonly events: number;
  readonly forms: number;
  readonly submissions: number;
  readonly accepted: number;
  readonly provisioned: number;
  readonly canonical_talks: number;
  readonly described_talks: number;
  readonly schedule_days: number;
  readonly tracks: number;
  readonly rooms: number;
  readonly tasks: number;
  readonly resources: number;
  readonly assets: number;
  readonly reusable_profiles: number;
  readonly reusable_profile_changes: number;
  readonly linked_event_profiles: number;
  readonly agenda_publications: number;
  readonly speaker_publications: number;
  readonly public_speakers: number;
  readonly complete_public_profiles: number;
  readonly public_headshots: number;
  readonly organizer_personas: number;
  readonly reviewer_personas: number;
  readonly speaker_personas: number;
  readonly sent_mail: number;
  readonly completed_imports: number;
};

const run = (arguments_: readonly string[], capture = false): string => {
  const result = spawnSync("pnpm", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "");
    throw new Error(`pnpm ${arguments_.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
  return capture ? result.stdout ?? "" : "";
};

const queryRows = (remote: boolean, sql: string): readonly Record<string, unknown>[] => {
  const output = run([
    "wrangler",
    "d1",
    "execute",
    "session-party",
    remote ? "--remote" : "--local",
    "--config",
    remote ? "wrangler.jsonc" : "wrangler.local.jsonc",
    "--json",
    "--command",
    sql,
  ], true);
  const decoded = JSON.parse(output) as Array<{ readonly results?: readonly Record<string, unknown>[] }>;
  return decoded[0]?.results ?? [];
};

const queryRowsAtState = (state: string, sql: string): readonly Record<string, unknown>[] => {
  const output = run([
    "wrangler",
    "d1",
    "execute",
    "session-party",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    state,
    "--json",
    "--command",
    sql,
  ], true);
  const decoded = JSON.parse(output) as Array<{ readonly results?: readonly Record<string, unknown>[] }>;
  return decoded[0]?.results ?? [];
};

const query = (remote: boolean, sql: string): Record<string, unknown> => {
  const row = queryRows(remote, sql)[0];
  if (!row) throw new Error("D1 verification query returned no row");
  return row;
};

const verifyDemo = (row: Record<string, unknown>, location: "local" | "production"): Verification => {
  const counts = row as Verification;
  const expected: Record<keyof Verification, number | ((value: number) => boolean)> = {
    events: 1,
    forms: 2,
    submissions: 60,
    accepted: 30,
    provisioned: 30,
    canonical_talks: 18,
    described_talks: 18,
    schedule_days: 3,
    tracks: 4,
    rooms: 4,
    tasks: 5,
    resources: 1,
    assets: 32,
    reusable_profiles: 1,
    reusable_profile_changes: 1,
    linked_event_profiles: 1,
    agenda_publications: 1,
    speaker_publications: 1,
    public_speakers: 30,
    complete_public_profiles: 30,
    public_headshots: 30,
    organizer_personas: 1,
    reviewer_personas: 1,
    speaker_personas: 1,
    sent_mail: (value) => value >= 1,
    completed_imports: (value) => value >= 2,
  };
  for (const [key, requirement] of Object.entries(expected) as Array<[keyof Verification, number | ((value: number) => boolean)]>) {
    const value = counts[key];
    if (typeof value !== "number" || (typeof requirement === "number" ? value !== requirement : !requirement(value))) {
      throw new Error(`${location} demo verification failed for ${key}: received ${String(value)}`);
    }
  }
  return counts;
};

const localEventIds = queryRows(false, "SELECT id FROM events ORDER BY id;").map((row) => row.id);
if (
  localEventIds.length !== 2
  || localEventIds[0] !== eventId
  || localEventIds[1] !== localIsolationEventId
) {
  throw new Error(
    `Local promotion source must contain only the demo event and its tenancy-isolation fixture; found ${JSON.stringify(localEventIds)}.`,
  );
}
const localCounts = verifyDemo(query(false, verificationSql), "local");
const localUsers = queryRows(false, "SELECT id, email FROM users ORDER BY id;").map((row): DemoUserIdentity => {
  if (typeof row.id !== "string" || typeof row.email !== "string") {
    throw new Error(`Invalid local demo user identity: ${JSON.stringify(row)}`);
  }
  return { id: row.id, email: row.email };
});
const localReusableProfileIds = new Set(queryRows(
  false,
  `SELECT DISTINCT p.id
   FROM speaker_profiles p
   INNER JOIN speakers s ON s.profile_source_id = p.id
   WHERE s.event_id = '${eventId}'
   ORDER BY p.id;`,
).map((row) => {
  if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(row.id)) {
    throw new Error(`Invalid local reusable profile identity: ${JSON.stringify(row)}`);
  }
  return row.id;
}));
const localAssets = queryRows(
  false,
  `SELECT id, content_type, size FROM assets WHERE event_id = '${eventId}' ORDER BY id;`,
).map((row) => {
  const id = row.id;
  const contentType = row.content_type;
  const size = row.size;
  if (
    typeof id !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(id)
    || typeof contentType !== "string"
    || contentType.length === 0
    || typeof size !== "number"
    || !Number.isSafeInteger(size)
    || size < 0
  ) {
    throw new Error(`Invalid local asset metadata: ${JSON.stringify(row)}`);
  }
  const file = join(temporaryDirectory, `asset-${id}`);
  run([
    "wrangler",
    "r2",
    "object",
    "get",
    `session-party-files/portal/${eventId}/${id}`,
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--file",
    file,
  ]);
  const actualSize = statSync(file).size;
  if (actualSize !== size) {
    throw new Error(`Local asset ${id} size mismatch: D1=${size}, R2=${actualSize}`);
  }
  return { id, contentType, size, file };
});
if (localAssets.length !== localCounts.assets) {
  throw new Error(`Local asset inventory mismatch: D1=${localCounts.assets}, R2=${localAssets.length}`);
}
const localHeadshotAssetIds = new Set(queryRows(
  false,
  `SELECT headshot_asset_id AS id FROM speakers WHERE event_id = '${eventId}' AND headshot_asset_id IS NOT NULL ORDER BY id;`,
).map((row) => {
  if (typeof row.id !== "string") throw new Error(`Invalid local headshot asset identity: ${JSON.stringify(row)}`);
  return row.id;
}));
const localHeadshotContents = localAssets
  .filter(({ id }) => localHeadshotAssetIds.has(id))
  .map(({ file }) => readFileSync(file).toString("base64"));
if (localHeadshotAssetIds.size !== localCounts.public_headshots || new Set(localHeadshotContents).size !== localCounts.public_headshots) {
  throw new Error(
    `Local demo requires ${localCounts.public_headshots} distinct headshot files; found ${localHeadshotAssetIds.size} identities and ${new Set(localHeadshotContents).size} unique files.`,
  );
}
const exportArguments = [
  "wrangler",
  "d1",
  "export",
  "session-party",
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--no-schema",
  "--skip-confirmation",
  "--output",
  outputPath,
  ...snapshotTables.flatMap((table) => ["--table", table]),
];
run(exportArguments);

const exported = readFileSync(outputPath, "utf8");
for (const forbidden of ['INSERT INTO "auth_tokens"', 'INSERT INTO "api_keys"']) {
  if (exported.includes(forbidden)) throw new Error(`Credential-bearing table leaked into demo snapshot: ${forbidden}`);
}
if (!exported.includes(`INSERT INTO "events"`) || !exported.includes(eventSlug)) {
  throw new Error("Exported snapshot does not contain the deterministic demo event");
}
const provenance = [
  "-- Session Party deterministic demo snapshot.",
  "-- Generated from operation-driven local hydration; fake mail and fixture Accelevents evidence remain labeled by their stored providers.",
  "-- Authentication tokens and API keys are deliberately excluded.",
  "",
].join("\n");
const insertsByTable = new Map<string, string[]>();
for (const line of exported.split("\n")) {
  if (!line.startsWith("INSERT INTO ")) continue;
  if (line.includes(`'${localIsolationEventId}'`)) continue;
  const table = /^INSERT INTO "([^"]+)"/.exec(line)?.[1];
  if (!table || !snapshotTables.includes(table as typeof snapshotTables[number])) {
    throw new Error(`Unexpected table in demo export: ${table ?? line.slice(0, 80)}`);
  }
  if (
    (table === "speaker_profiles" || table === "speaker_profile_changes")
    && ![...localReusableProfileIds].some((id) => line.includes(`'${id}'`))
  ) continue;
  const statements = insertsByTable.get(table) ?? [];
  statements.push(line);
  insertsByTable.set(table, statements);
}
const orderedInserts = snapshotTables.flatMap((table) => insertsByTable.get(table) ?? []);
const productionImportBatches = snapshotTables.flatMap((table) => {
  const statements = insertsByTable.get(table) ?? [];
  if (statements.length === 0) return [];
  const file = join(temporaryDirectory, `import-${table}.sql`);
  writeFileSync(file, `${statements.join("\n")}\n`, "utf8");
  return [{ table, file, statementCount: statements.length }];
});
writeFileSync(
  outputPath,
  `${provenance}PRAGMA defer_foreign_keys=TRUE;\n${orderedInserts.join("\n")}\n`,
  "utf8",
);

const validationReplacementPath = join(temporaryDirectory, "replace-demo-event.sql");
writeFileSync(
  validationReplacementPath,
  buildDemoReplacementSql(orderedInserts, "demo-owner", 1_800_000_000_000),
  "utf8",
);

const validationState = join(temporaryDirectory, "validation-state");
run([
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "session-party",
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--persist-to",
  validationState,
]);
run([
  "wrangler",
  "d1",
  "execute",
  "session-party",
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--persist-to",
  validationState,
  "--file",
  outputPath,
]);
const validationOutput = run([
  "wrangler",
  "d1",
  "execute",
  "session-party",
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--persist-to",
  validationState,
  "--json",
  "--command",
  verificationSql,
], true);
const validationDecoded = JSON.parse(validationOutput) as Array<{
  readonly results?: readonly Record<string, unknown>[];
}>;
const validationRow = validationDecoded[0]?.results?.[0];
if (!validationRow) throw new Error("Isolated demo import validation returned no row");
verifyDemo(validationRow, "local");

run([
  "wrangler",
  "d1",
  "execute",
  "session-party",
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--persist-to",
  validationState,
  "--command",
  `INSERT INTO events (id, slug, name, timezone, version, created_at, updated_at)
   VALUES ('reconciliation-unrelated-event', 'reconciliation-unrelated-event', 'Must survive demo replacement', 'UTC', 1, 1, 1);
   UPDATE talks SET description = NULL, starts_at = 1789664400000 WHERE event_id = '${eventId}';
   UPDATE speakers SET title = NULL, company = NULL, bio = NULL, headshot_asset_id = NULL WHERE event_id = '${eventId}';
   INSERT INTO users (id, email, name, version, created_at, updated_at)
   VALUES ('reconciliation-unrelated-user', 'unrelated@example.com', 'Must survive replacement', 1, 1, 1);
   INSERT INTO speaker_profiles (id, user_id, slug, display_name, links, visible, version, created_at, updated_at)
   VALUES ('reconciliation-unrelated-profile', 'reconciliation-unrelated-user', 'unrelated-profile', 'Must survive replacement', '[]', 1, 1, 1, 1);`,
]);
run([
  "wrangler",
  "d1",
  "execute",
  "session-party",
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--persist-to",
  validationState,
  "--file",
  validationReplacementPath,
]);
verifyDemo(queryRowsAtState(validationState, verificationSql)[0] ?? {}, "local");
const isolatedInventory = queryRowsAtState(
  validationState,
  "SELECT id, slug, name FROM events ORDER BY id;",
);
if (
  isolatedInventory.length !== 2
  || !isolatedInventory.some((row) => row.id === "reconciliation-unrelated-event" && row.name === "Must survive demo replacement")
) {
  throw new Error(`Isolated replacement touched unrelated event state: ${JSON.stringify(isolatedInventory)}`);
}
const unrelatedProfiles = queryRowsAtState(
  validationState,
  "SELECT id, user_id, slug, display_name FROM speaker_profiles WHERE id = 'reconciliation-unrelated-profile';",
);
if (
  unrelatedProfiles.length !== 1
  || unrelatedProfiles[0]?.user_id !== "reconciliation-unrelated-user"
  || unrelatedProfiles[0]?.slug !== "unrelated-profile"
  || unrelatedProfiles[0]?.display_name !== "Must survive replacement"
) {
  throw new Error(`Isolated replacement touched unrelated reusable profiles: ${JSON.stringify(unrelatedProfiles)}`);
}

if (!applyProduction) {
  let production: null | {
    readonly totalEvents: unknown;
    readonly target: readonly ProductionEventIdentity[];
    readonly currentCounts: Record<string, unknown>;
    readonly compatibleFixtureUsers: number;
  } = null;
  let replacementOutputPath: string | null = null;
  let assetOutputDirectory: string | null = null;
  let assetManifestPath: string | null = null;
  if (inspectProduction) {
    const target = queryRows(
      true,
      `SELECT id, slug FROM events WHERE id = '${eventId}' OR slug = '${eventSlug}' ORDER BY id;`,
    ).map((row): ProductionEventIdentity => {
      if (typeof row.id !== "string" || typeof row.slug !== "string") {
        throw new Error(`Invalid production event identity: ${JSON.stringify(row)}`);
      }
      return { id: row.id, slug: row.slug };
    });
    assertExactProductionTarget(target);
    const collidingUsers = queryRows(true, fixtureUserCollisionSql(localUsers)).map((row): DemoUserIdentity => {
      if (typeof row.id !== "string" || typeof row.email !== "string") {
        throw new Error(`Invalid production demo user identity: ${JSON.stringify(row)}`);
      }
      return { id: row.id, email: row.email };
    });
    assertCompatibleDemoUsers(localUsers, collidingUsers);
    production = {
      totalEvents: query(true, "SELECT count(*) AS events FROM events;").events,
      target,
      currentCounts: query(true, verificationSql),
      compatibleFixtureUsers: collidingUsers.length,
    };
    if (prepareReconciliation) {
      const productionOwnerEmail = process.env.SESSION_PARTY_PRODUCTION_OWNER_EMAIL?.trim().toLowerCase();
      if (
        !productionOwnerEmail
        || productionOwnerEmail.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(productionOwnerEmail)
      ) {
        throw new Error("Set SESSION_PARTY_PRODUCTION_OWNER_EMAIL to the existing production organizer account.");
      }
      const ownerRows = queryRows(
        true,
        `SELECT id FROM users WHERE lower(email) = ${sqlQuote(productionOwnerEmail)} ORDER BY id;`,
      );
      if (ownerRows.length !== 1 || typeof ownerRows[0]?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(ownerRows[0].id)) {
        throw new Error(`Production owner lookup requires exactly one existing account; found ${ownerRows.length}.`);
      }
      replacementOutputPath = outputPath.endsWith(".sql")
        ? `${outputPath.slice(0, -4)}.replacement.sql`
        : `${outputPath}.replacement.sql`;
      writeFileSync(
        replacementOutputPath,
        buildDemoReplacementSql(orderedInserts, ownerRows[0].id, Date.now()),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      const preparedAssetOutputDirectory = `${replacementOutputPath}.assets`;
      assetOutputDirectory = preparedAssetOutputDirectory;
      mkdirSync(preparedAssetOutputDirectory, { recursive: false, mode: 0o700 });
      for (const asset of localAssets) copyFileSync(asset.file, join(preparedAssetOutputDirectory, asset.id));
      assetManifestPath = `${replacementOutputPath}.assets.json`;
      writeFileSync(assetManifestPath, `${JSON.stringify(localAssets.map((asset) => ({
        id: asset.id,
        key: `portal/${eventId}/${asset.id}`,
        contentType: asset.contentType,
        size: asset.size,
        file: join(preparedAssetOutputDirectory, asset.id),
      })), null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }
  console.log(JSON.stringify({
    prepared: true,
    applyProduction: false,
    outputPath,
    replacementOutputPath,
    assetOutputDirectory,
    assetManifestPath,
    copiedAssets: localAssets.length,
    replacementSimulation: {
      passed: true,
      lockedTarget: demoTarget,
      unrelatedEventPreserved: true,
    },
    counts: localCounts,
    production,
  }, null, 2));
  process.exit(0);
}

if (process.env.SESSION_PARTY_PRODUCTION_CONFIRM !== productionConfirmation) {
  throw new Error(
    `Set SESSION_PARTY_PRODUCTION_CONFIRM=${productionConfirmation} to authorize the guarded production import.`,
  );
}
const productionOwnerEmail = process.env.SESSION_PARTY_PRODUCTION_OWNER_EMAIL?.trim().toLowerCase();
if (
  !productionOwnerEmail
  || productionOwnerEmail.length > 254
  || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(productionOwnerEmail)
) {
  throw new Error("Set SESSION_PARTY_PRODUCTION_OWNER_EMAIL to the existing production organizer account.");
}
const remoteInventory = query(true, "SELECT count(*) AS events FROM events;");
if (remoteInventory.events !== 0) {
  throw new Error(`Production import requires an empty events table; found ${String(remoteInventory.events)} event(s).`);
}
const ownerRows = queryRows(
  true,
  `SELECT id FROM users WHERE lower(email) = ${sqlQuote(productionOwnerEmail)} ORDER BY id;`,
);
if (ownerRows.length !== 1 || typeof ownerRows[0]?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(ownerRows[0].id)) {
  throw new Error(`Production owner lookup requires exactly one existing account; found ${ownerRows.length}.`);
}
const productionOwnerUserId = ownerRows[0].id;
for (const asset of localAssets) {
  run([
    "wrangler",
    "r2",
    "object",
    "put",
    `session-party-files/portal/${eventId}/${asset.id}`,
    "--remote",
    "--config",
    "wrangler.jsonc",
    "--content-type",
    asset.contentType,
    "--file",
    asset.file,
    "--force",
  ]);
}
for (const batch of productionImportBatches) {
  run([
    "wrangler",
    "d1",
    "execute",
    "session-party",
    "--remote",
    "--config",
    "wrangler.jsonc",
    "--yes",
    "--file",
    batch.file,
  ]);
  console.log(JSON.stringify({ importedTable: batch.table, statements: batch.statementCount }));
}
const membershipNow = Date.now();
run([
  "wrangler",
  "d1",
  "execute",
  "session-party",
  "--remote",
  "--config",
  "wrangler.jsonc",
  "--yes",
  "--command",
  `INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at)
   VALUES ('production-demo-owner', '${eventId}', ${sqlQuote(productionOwnerUserId)}, 'owner', 1, ${membershipNow}, ${membershipNow});`,
]);
const productionCounts = verifyDemo(query(true, verificationSql), "production");
console.log(JSON.stringify({
  promoted: true,
  event: { id: eventId, slug: eventSlug },
  credentialsIncluded: false,
  evidence: { mail: "local-fake", accelevents: "fixture" },
  copiedAssets: localAssets.length,
  productionOwnerLinked: true,
  counts: productionCounts,
}, null, 2));
