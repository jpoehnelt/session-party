import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { internalServiceToken } from "./services";

type TemplateTestEnv = Cloudflare.Env & {
  readonly TEMPLATE_DB: D1Database;
  readonly TEMPLATE_FILES: R2Bucket;
  readonly TEST_MIGRATIONS: readonly D1Migration[];
};

const templateEnv = env as TemplateTestEnv;

describe("fresh self-hosting template", () => {
  it("applies every migration to an empty D1 database", async () => {
    await applyD1Migrations(templateEnv.TEMPLATE_DB, [...templateEnv.TEST_MIGRATIONS]);

    const applied = await templateEnv.TEMPLATE_DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    expect(applied.results).toHaveLength(templateEnv.TEST_MIGRATIONS.length);
    expect(applied.results.at(-1)?.name).toBe(templateEnv.TEST_MIGRATIONS.at(-1)?.name);
    expect((await templateEnv.TEMPLATE_DB.prepare("PRAGMA foreign_key_check").all()).results)
      .toEqual([]);
  });

  it("writes, reads, and removes an object through the fresh R2 binding", async () => {
    const key = "template-smoke/probe.txt";
    await templateEnv.TEMPLATE_FILES.put(key, "session-party-template-ok");
    expect(await (await templateEnv.TEMPLATE_FILES.get(key))?.text())
      .toBe("session-party-template-ok");
    await templateEnv.TEMPLATE_FILES.delete(key);
    expect(await templateEnv.TEMPLATE_FILES.get(key)).toBeNull();
  });

  it("reaches the canonical Scheduler Durable Object", async () => {
    // The namespace's runtime environment uses the primary DB binding; migrate
    // it as a freshly deployed template would before waking the scheduler.
    await applyD1Migrations(templateEnv.DB, [...templateEnv.TEST_MIGRATIONS]);
    const id = templateEnv.SCHEDULER.idFromName("mail");
    const response = await templateEnv.SCHEDULER.get(id).fetch("https://scheduler/poke", {
      method: "POST",
      headers: { "x-session-party-internal": await internalServiceToken(templateEnv) },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
