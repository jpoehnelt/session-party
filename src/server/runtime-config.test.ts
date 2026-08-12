import { describe, expect, it } from "vitest";
import { publicRuntimeConfig } from "./runtime-config";

describe("public runtime configuration", () => {
  it("disables analytics by default", () => {
    expect(publicRuntimeConfig({})).toEqual({ analytics: null });
    expect(publicRuntimeConfig({ POSTHOG_KEY: "", POSTHOG_HOST: "" })).toEqual({ analytics: null });
  });

  it("requires both a project key and a safe HTTPS origin", () => {
    expect(publicRuntimeConfig({ POSTHOG_KEY: "phc_example" })).toEqual({ analytics: null });
    expect(publicRuntimeConfig({
      POSTHOG_KEY: "phc_example",
      POSTHOG_HOST: "http://analytics.example.com",
    })).toEqual({ analytics: null });
    expect(publicRuntimeConfig({
      POSTHOG_KEY: "phc_example",
      POSTHOG_HOST: "https://analytics.example.com/capture",
    })).toEqual({ analytics: null });
  });

  it("exposes only the explicitly configured public PostHog settings", () => {
    expect(publicRuntimeConfig({
      POSTHOG_KEY: "  phc_example  ",
      POSTHOG_HOST: "https://analytics.example.com/",
    })).toEqual({
      analytics: {
        provider: "posthog",
        key: "phc_example",
        host: "https://analytics.example.com",
      },
    });
  });
});
