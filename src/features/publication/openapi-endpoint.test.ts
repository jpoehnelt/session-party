import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("full OpenAPI document endpoint", () => {
  it("serves the complete generated document with caching and CORS headers", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toContain("max-age=60");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const document = await response.json() as {
      readonly openapi: string;
      readonly info: { readonly title: string };
      readonly servers: readonly { readonly url: string }[];
      readonly paths: Readonly<Record<string, unknown>>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("session-party API");
    expect(document.servers).toEqual([{ url: "https://example.test/api/v1" }]);
    expect(Object.keys(document.paths).length).toBeGreaterThan(50);
    expect(document.paths["/public/events/{eventSlug}/agenda/published"]).toBeDefined();
  });

  it("answers conditional requests with 304 and varies servers by origin", async () => {
    const first = await SELF.fetch("https://example.test/api/v1/openapi.json");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"openapi:c[0-9a-f]{8}"$/);

    const revalidated = await SELF.fetch("https://example.test/api/v1/openapi.json", {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");

    const otherOrigin = await SELF.fetch("https://other.example/api/v1/openapi.json");
    expect(otherOrigin.status).toBe(200);
    const document = await otherOrigin.json() as { readonly servers: readonly { readonly url: string }[] };
    expect(document.servers).toEqual([{ url: "https://other.example/api/v1" }]);
  });
});
