import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { arg, ensureTools } from "../shared";
import type { RecordedShot } from "./types";

ensureTools(["ffmpeg", "ffprobe"]);
const outputDir = resolve(arg("output", "artifacts/walkthrough-v2"));
const normalizedDir = resolve(outputDir, "normalized");
await mkdir(normalizedDir, { recursive: true });

const manifest = JSON.parse(await readFile(resolve(outputDir, "manifest.json"), "utf8")) as {
  readonly shots: readonly RecordedShot[];
};
if (!manifest.shots.length) throw new Error(`manifest.json in ${outputDir} contains no shots; run pnpm walkthrough:v2:record first`);

function run(command: string, args: readonly string[]) {
  const commandArgs = command === "ffmpeg" ? ["-hide_banner", "-loglevel", "error", ...args] : args;
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? "no status"}`);
}

const concatFile = async (name: string, paths: readonly string[]) => {
  const path = resolve(normalizedDir, name);
  await writeFile(path, `${paths.map((entry) => `file '${entry.replaceAll("'", "'\\''")}'`).join("\n")}\n`);
  return path;
};

const normalized = new Map<string, string>();
for (const shot of manifest.shots) {
  const target = resolve(normalizedDir, `${shot.id}.mp4`);
  run("ffmpeg", [
    "-y", "-ss", shot.trimStartSeconds.toFixed(3), "-i", shot.videoPath,
    "-t", shot.trimDurationSeconds.toFixed(3),
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
    "-r", "30", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", target,
  ]);
  normalized.set(shot.id, target);
}

const hookFrames = Array.from({ length: 50 }, (_, index) => manifest.shots[index % manifest.shots.length]!);
const hookClips: string[] = [];
for (const [index, shot] of hookFrames.entries()) {
  const still = resolve(normalizedDir, `hook-${String(index + 1).padStart(2, "0")}.png`);
  const clip = resolve(normalizedDir, `hook-${String(index + 1).padStart(2, "0")}.mp4`);
  run("ffmpeg", ["-y", "-ss", String(Math.max(0, shot.trimStartSeconds - 1)), "-i", shot.videoPath, "-frames:v", "1", still]);
  run("ffmpeg", ["-y", "-loop", "1", "-i", still, "-t", "0.08", "-r", "30", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", clip]);
  hookClips.push(clip);
}
const hook = resolve(normalizedDir, "opening-50-views.mp4");
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", await concatFile("opening.txt", hookClips), "-c", "copy", hook]);

const ordered = manifest.shots.map((shot) => normalized.get(shot.id)!);
const finalPath = resolve(outputDir, "session-party-walkthrough-v2.mp4");
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", await concatFile("full.txt", [hook, ...ordered]), "-r", "30", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", finalPath]);

const shortIds = new Set([
  "cfp-builder", "public-cfp", "review-workbench", "speaker-tasks", "agenda-handoff",
  "live-control", "publication", "public-program", "stable-embed",
]);
const shortClips: string[] = [];
for (const shot of manifest.shots.filter((candidate) => shortIds.has(candidate.id) && candidate.shortSeconds)) {
  const clip = resolve(normalizedDir, `${shot.id}-short.mp4`);
  run("ffmpeg", ["-y", "-i", normalized.get(shot.id)!, "-t", String(shot.shortSeconds), "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", clip]);
  shortClips.push(clip);
}
const shortPath = resolve(outputDir, "session-party-walkthrough-v2-short.mp4");
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", await concatFile("short.txt", [hook, ...shortClips]), "-r", "30", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", shortPath]);

await writeFile(resolve(outputDir, "outputs.json"), `${JSON.stringify({
  full: finalPath,
  short: shortPath,
  shotCount: manifest.shots.length,
  openingViews: hookFrames.length,
}, null, 2)}\n`);
process.stdout.write(`Created ${finalPath}\nCreated ${shortPath}\n`);
