import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EXPECTED_LATEST_MIGRATION, runSetupChecks } from "./setup";

type TestEnv = Cloudflare.Env & {
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, [...(env as TestEnv).TEST_MIGRATIONS]);
});

describe("installation setup checks", () => {
  it("keeps installation details behind an authenticated operator session", async () => {
    const response = await SELF.fetch("http://localhost:5173/api/v1/setup");
    expect(response.status).toBe(401);
  });

  it("tracks the latest migration shipped by the application", () => {
    const migrations = (env as TestEnv).TEST_MIGRATIONS;
    expect(migrations.at(-1)?.name).toMatch(new RegExp(`^${EXPECTED_LATEST_MIGRATION}`));
  });

  it("probes D1, R2, and required Durable Objects without mutating production data", async () => {
    const checks = await runSetupChecks(
      new Request("http://localhost:5173/setup"),
      env,
      "operator@example.com",
    );
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "domain", status: "pass" }),
      expect.objectContaining({ key: "database", status: "pass" }),
      expect.objectContaining({ key: "r2", status: "pass" }),
      expect.objectContaining({ key: "durableObjects", status: "pass" }),
      expect.objectContaining({ key: "email", status: "warn" }),
      expect.objectContaining({ key: "turnstile", status: "warn" }),
      expect.objectContaining({ key: "initialAdmin", status: "warn" }),
    ]));
  });
});
