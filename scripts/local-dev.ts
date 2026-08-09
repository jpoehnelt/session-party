import { spawn } from "node:child_process";
import { resolveLocalRuntime } from "./local-runtime";

const { host, port, origin } = resolveLocalRuntime();
const child = spawn(
  "pnpm",
  ["vite", "dev", "--host", host, "--port", String(port), "--strictPort"],
  {
    stdio: "inherit",
    env: { ...process.env, PASEO_BASE_URL: origin },
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
