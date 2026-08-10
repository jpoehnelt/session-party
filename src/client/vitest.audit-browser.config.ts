import path from "node:path";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, ".."),
      contracts: path.resolve(import.meta.dirname, "../../contracts"),
    },
  },
  test: {
    include: [
      "src/features/review/routes/review-lifecycle.browser.tsx",
      "src/features/comms/routes/comms-lifecycle.browser.tsx",
      "src/features/submit/routes/submit-draft.browser.tsx",
      "src/features/publication/components/public-program.browser.tsx",
      "src/features/agenda/components/agenda-board.browser.tsx",
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
