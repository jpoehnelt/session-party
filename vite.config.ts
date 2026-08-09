import { cloudflare, type WorkerConfig } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "node:path";
import { resolveLocalRuntime } from "./scripts/local-runtime.ts";

export default defineConfig(({ command }) => {
  const local = command === "serve" ? resolveLocalRuntime() : null;
  const isPreview = command === "build" && process.env.CLOUDFLARE_ENV === "preview";
  const requiredPreviewValue = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Preview builds require ${name}`);
    return value;
  };
  const preview = isPreview
    ? {
        workerName: requiredPreviewValue("PREVIEW_WORKER_NAME"),
        databaseName: requiredPreviewValue("PREVIEW_DATABASE_NAME"),
        bucketName: requiredPreviewValue("PREVIEW_BUCKET_NAME"),
        appUrl: requiredPreviewValue("PREVIEW_APP_URL"),
      }
    : null;
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
          : preview
            ? {
                config: (config: WorkerConfig) => {
                  config.d1_databases = (config.d1_databases ?? []).map((database) => ({
                    ...database,
                    database_name: preview.databaseName,
                    database_id: undefined,
                  }));
                  config.r2_buckets = (config.r2_buckets ?? []).map((bucket) => ({
                    ...bucket,
                    bucket_name: preview.bucketName,
                  }));
                  return {
                    name: preview.workerName,
                    vars: {
                      ...config.vars,
                      PREVIEW_MODE: "1",
                      APP_URL: preview.appUrl,
                    },
                  };
                },
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
