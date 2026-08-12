import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "./template-install.mjs";

const safeResource = (value, label) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be an explicit Cloudflare resource name`);
  }
  return value;
};

const command = (purpose, argv, destructive = false) => ({ purpose, argv, destructive });

export const backupPlan = ({ database, bucket, outputDir }) => ({
  operation: "backup",
  mutatesRemoteState: false,
  steps: [
    command("Capture the current D1 Time Travel bookmark", ["pnpm", "exec", "wrangler", "d1", "time-travel", "info", safeResource(database, "database"), "--json"]),
    command("Export D1 schema and data for retention beyond Time Travel", ["pnpm", "exec", "wrangler", "d1", "export", safeResource(database, "database"), "--remote", `--output=${outputDir}/d1.sql`]),
    command("Copy every R2 object to independent storage", ["rclone", "copy", `r2:${safeResource(bucket, "bucket")}`, `${outputDir}/r2`, "--checksum"]),
  ],
});

export const restorePlan = ({ database, bucket, inputDir }) => ({
  operation: "restore-to-new-resources",
  mutatesRemoteState: true,
  warning: "Import only into newly provisioned recovery resources, validate them, then switch bindings in a reviewed deployment.",
  steps: [
    command("Import the D1 export into the new recovery database", ["pnpm", "exec", "wrangler", "d1", "execute", safeResource(database, "database"), "--remote", `--file=${inputDir}/d1.sql`], true),
    command("Restore objects into the new recovery bucket", ["rclone", "copy", `${inputDir}/r2`, `r2:${safeResource(bucket, "bucket")}`, "--checksum"], true),
  ],
});

export const upgradePlan = ({ database, release }) => ({
  operation: "upgrade",
  mutatesRemoteState: false,
  release,
  steps: [
    command("Run repository and binding preflight", ["pnpm", "ops:preflight"]),
    command("Capture a bookmark and long-retention export", ["pnpm", "ops:backup-plan"]),
    command("Install the release exactly", ["pnpm", "install", "--frozen-lockfile"]),
    command("Run validation", ["pnpm", "check"]),
    command("Build the deploy artifact", ["pnpm", "build"]),
    command("Review pending D1 migrations", ["pnpm", "exec", "wrangler", "d1", "migrations", "list", safeResource(database, "database"), "--remote"]),
  ],
});

export const preflight = async (config, migrationFiles) => {
  const failures = [];
  const database = config.d1_databases?.find(({ binding }) => binding === "DB");
  const files = config.r2_buckets?.find(({ binding }) => binding === "FILES");
  if (!database?.database_name || !database.database_id) failures.push("DB binding is incomplete");
  if (!files?.bucket_name) failures.push("FILES binding is incomplete");
  if (config.observability?.enabled !== true) failures.push("Workers observability is disabled");
  const requiredSecrets = new Set(config.secrets?.required ?? []);
  for (const secret of ["SESSION_SECRET", "TURNSTILE_SECRET"]) {
    if (!requiredSecrets.has(secret)) failures.push(`${secret} is not declared required`);
  }
  const migrations = migrationFiles.filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  migrations.forEach((name, index) => {
    if (!name.startsWith(String(index).padStart(4, "0"))) failures.push(`Migration sequence gap at ${name}`);
  });
  if (migrations.length === 0) failures.push("No D1 migrations found");
  return {
    ok: failures.length === 0,
    failures,
    database: database?.database_name ?? null,
    bucket: files?.bucket_name ?? null,
    latestMigration: migrations.at(-1) ?? null,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] ?? "preflight";
  const config = parseJsonc(await readFile("wrangler.jsonc", "utf8"));
  const database = config.d1_databases?.find(({ binding }) => binding === "DB")?.database_name;
  const bucket = config.r2_buckets?.find(({ binding }) => binding === "FILES")?.bucket_name;
  const stamp = new Date().toISOString().replaceAll(":", "-");
  let result;
  if (action === "preflight") result = await preflight(config, await readdir("migrations"));
  else if (action === "backup") result = backupPlan({ database, bucket, outputDir: `backups/${stamp}` });
  else if (action === "restore") {
    const inputDir = process.argv[3];
    const targetDatabase = process.argv[4];
    const targetBucket = process.argv[5];
    if (!inputDir || !targetDatabase || !targetBucket) throw new Error("Usage: operations.mjs restore <input-dir> <new-database> <new-bucket>");
    result = restorePlan({ database: targetDatabase, bucket: targetBucket, inputDir });
  } else if (action === "upgrade") result = upgradePlan({ database, release: process.argv[3] ?? "reviewed-release-tag" });
  else throw new Error(`Unknown operation: ${action}`);
  console.log(JSON.stringify(result, null, 2));
  if (action === "preflight" && !result.ok) process.exitCode = 1;
}
