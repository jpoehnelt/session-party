import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./contracts/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
