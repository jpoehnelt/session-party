import { execFileSync } from "node:child_process";

export const arg = (name: string, fallback: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

export function ensureTools(tools: readonly string[]) {
  for (const tool of tools) {
    try {
      execFileSync(tool, ["-version"], { stdio: "ignore" });
    } catch {
      throw new Error(`${tool} must be available on PATH; install it before running the walkthrough scripts.`);
    }
  }
}

export function mediaDurationSeconds(path: string) {
  const output = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ], { encoding: "utf8" }).trim();
  const duration = Number(output);
  if (!Number.isFinite(duration)) throw new Error(`ffprobe reported an invalid duration for ${path}: ${output || "empty output"}`);
  return duration;
}
