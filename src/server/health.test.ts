import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "./index";

describe("health endpoint", () => {
  it("reports ok with storage probes and no-store caching", async () => {
    const response = await SELF.fetch("https://example.test/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      status: "ok",
      d1: true,
      r2: true,
      runtime: "cloudflare-workers",
    });
  });

  it("degrades to 503 when a storage binding stops answering", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("simulated D1 outage");
      },
    };
    const degradedEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "DB" ? brokenDb : Reflect.get(target, property, receiver);
      },
    }) as Env;

    const response = await worker.fetch(
      new Request("https://example.test/health"),
      degradedEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "degraded", d1: false, r2: true });
  });

  it("never leaks configuration details", async () => {
    const response = await SELF.fetch("https://example.test/health");
    const body = await response.text();
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("@");
    expect(body).not.toContain("email");
  });
});
