import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      contracts: path.resolve(import.meta.dirname, "contracts"),
    },
  },
});
