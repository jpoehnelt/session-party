import { execFileSync } from "node:child_process";

export default function globalSetup(): void {
  if (process.env.PLAYWRIGHT_BASE_URL) return;
  execFileSync("pnpm", ["demo:hydrate"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    timeout: 180_000,
  });
}
