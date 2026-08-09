import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const stateRoot = path.resolve(".wrangler/state/v3");
await rm(stateRoot, { recursive: true, force: true });
await mkdir(stateRoot, { recursive: true });

const migration = spawnSync(
  "pnpm",
  [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "session-party",
    "--local",
    "--config",
    "wrangler.local.jsonc",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, CI: process.env.CI ?? "1" },
  },
);
if (migration.status !== 0) process.exit(migration.status ?? 1);

const seed = spawnSync("pnpm", ["tsx", "scripts/seed.ts"], { stdio: "inherit" });
if (seed.status !== 0) process.exit(seed.status ?? 1);
