import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "node:path";
import { resolveLocalRuntime } from "./scripts/local-runtime.ts";

export default defineConfig(({ command }) => {
  const local = command === "serve" ? resolveLocalRuntime() : null;
  return {
    plugins: [
      react(),
      tailwindcss(),
      cloudflare({
        persistState: { path: ".wrangler/state" },
        remoteBindings: false,
        ...(local
          ? {
              configPath: "./wrangler.local.jsonc",
              config: (config: { vars?: Record<string, unknown> }) => ({
                vars: {
                  ...config.vars,
                  LOCAL_MODE: "1",
                  APP_URL: local.origin,
                },
              }),
            }
          : {}),
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        contracts: path.resolve(import.meta.dirname, "contracts"),
      },
    },
  };
});
