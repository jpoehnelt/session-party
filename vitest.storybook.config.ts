import path from "node:path";
import { argosVitestPlugin } from "@argos-ci/storybook/vitest-plugin";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    storybookTest({
      configDir: path.resolve(import.meta.dirname, ".storybook"),
    }),
    // Argos supplies deterministic per-story PNG capture only. reg-suit owns
    // comparison, storage, and reporting, so no screenshots leave through Argos.
    argosVitestPlugin({ uploadToArgos: false }),
  ],
  test: {
    name: "storybook",
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
