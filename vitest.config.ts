import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/server/index.ts",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2025-08-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["FILES"],
        durableObjects: {
          EVENT_ROOM: "EventRoom",
          SCHEDULER: "Scheduler",
          MCP_OBJECT: "SessionPartyMcp",
        },
        bindings: {
          APP_URL: "http://localhost:5173",
          LOCAL_MODE: "1",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      contracts: path.resolve(import.meta.dirname, "contracts"),
    },
  },
});

