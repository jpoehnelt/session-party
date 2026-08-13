import assert from "node:assert/strict";
import test from "node:test";
import { backupPlan, preflight, restorePlan, upgradePlan } from "./operations.mjs";

test("backup and upgrade plans are remote-read-only", () => {
  const backup = backupPlan({ database: "session-party", bucket: "session-party-files", outputDir: "backups/test" });
  assert.equal(backup.mutatesRemoteState, false);
  assert.equal(backup.steps.some(({ destructive }) => destructive), false);
  assert.equal(upgradePlan({ database: "session-party", release: "v0.2.0" }).mutatesRemoteState, false);
});

test("restore plans require explicit new resource names and mark mutations", () => {
  const restore = restorePlan({ database: "session-party-recovery", bucket: "session-party-recovery-files", inputDir: "backups/test" });
  assert.equal(restore.mutatesRemoteState, true);
  assert.equal(restore.steps.every(({ destructive }) => destructive), true);
  assert.throws(() => restorePlan({ database: "$(unsafe)", bucket: "safe", inputDir: "backups/test" }), /explicit/);
});

test("preflight identifies complete bindings and contiguous migrations", async () => {
  const result = await preflight({
    observability: { enabled: true },
    d1_databases: [{ binding: "DB", database_name: "db", database_id: "id" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
    secrets: { required: ["SESSION_SECRET", "TURNSTILE_SECRET"] },
  }, ["0000_first.sql", "0001_second.sql"]);
  assert.equal(result.ok, true);
  assert.equal(result.latestMigration, "0001_second.sql");
});
