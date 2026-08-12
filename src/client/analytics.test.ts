import { describe, expect, it, vi } from "vitest";
import { initializeAnalytics } from "./analytics";

describe("analytics initialization", () => {
  it("does not load an analytics SDK when analytics is disabled", async () => {
    const loadPosthog = vi.fn();
    expect(await initializeAnalytics({
      fetchConfig: async () => Response.json({ analytics: null }),
      loadPosthog,
    })).toBe(false);
    expect(loadPosthog).not.toHaveBeenCalled();
  });

  it("initializes only the explicitly configured PostHog destination", async () => {
    const init = vi.fn();
    expect(await initializeAnalytics({
      fetchConfig: async () => Response.json({
        analytics: {
          provider: "posthog",
          key: "phc_owner_project",
          host: "https://analytics.example.com",
        },
      }),
      loadPosthog: async () => ({ default: { init } }),
    })).toBe(true);
    expect(init).toHaveBeenCalledWith("phc_owner_project", {
      api_host: "https://analytics.example.com",
      defaults: "2026-05-30",
    });
  });

  it("fails open without loading PostHog when configuration cannot be read", async () => {
    const loadPosthog = vi.fn();
    expect(await initializeAnalytics({
      fetchConfig: async () => { throw new Error("offline"); },
      loadPosthog,
    })).toBe(false);
    expect(loadPosthog).not.toHaveBeenCalled();
  });
});
