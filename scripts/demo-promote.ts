import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const eventId = "demo-event";
const eventSlug = "ai-engineer-sandbox";
const productionConfirmation = "ai-engineer-sandbox";
const applyProduction = process.argv.includes("--apply-production");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "session-party-demo-"));
const outputPath = outputArgument
  ? resolve(outputArgument.slice("--output=".length))
  : join(temporaryDirectory, "session-party-demo.sql");
const sqlQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const snapshotTables = [
  "events",
  "users",
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
  (SELECT count(*) FROM tracks WHERE event_id = '${eventId}') AS tracks,
  (SELECT count(*) FROM rooms WHERE event_id = '${eventId}') AS rooms,
  (SELECT count(*) FROM tasks WHERE event_id = '${eventId}') AS tasks,
  (SELECT count(*) FROM pages WHERE event_id = '${eventId}') AS resources,
  (SELECT count(*) FROM assets WHERE event_id = '${eventId}') AS assets,
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
  readonly tracks: number;
  readonly rooms: number;
  readonly tasks: number;
  readonly resources: number;
  readonly assets: number;
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
    tracks: 4,
    rooms: 4,
    tasks: 5,
    resources: 1,
    assets: 3,
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

const localInventory = query(false, "SELECT count(*) AS events FROM events;");
if (localInventory.events !== 1) {
  throw new Error(`Local promotion source must contain exactly the demo event; found ${String(localInventory.events)} events.`);
}
const localCounts = verifyDemo(query(false, verificationSql), "local");
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
  const table = /^INSERT INTO "([^"]+)"/.exec(line)?.[1];
  if (!table || !snapshotTables.includes(table as typeof snapshotTables[number])) {
    throw new Error(`Unexpected table in demo export: ${table ?? line.slice(0, 80)}`);
  }
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

if (!applyProduction) {
  console.log(JSON.stringify({
    prepared: true,
    applyProduction: false,
    outputPath,
    copiedAssets: localAssets.length,
    counts: localCounts,
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
