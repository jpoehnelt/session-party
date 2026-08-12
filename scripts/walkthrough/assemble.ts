import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { RecordedScene } from "./types";

const arg = (name: string, fallback: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const outputDir = resolve(arg("output", "artifacts/walkthrough"));
const manifest = JSON.parse(await readFile(resolve(outputDir, "manifest.json"), "utf8")) as {
  readonly disclosure: string;
  readonly scenes: readonly RecordedScene[];
};
const authoredNarration = JSON.parse(await readFile(resolve("scripts/walkthrough/narration.json"), "utf8")) as {
  readonly short: {
    readonly scenes: readonly { readonly durationSeconds: number; readonly narration: string }[];
  };
};
const normalizedDir = resolve(outputDir, "normalized");
await mkdir(normalizedDir, { recursive: true });

function run(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? "no status"}`);
}

const concatFile = async (name: string, files: readonly string[]) => {
  const path = resolve(normalizedDir, name);
  await writeFile(path, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  return path;
};

const mediaDuration = (path: string) => Number(spawnSync("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1",
  path,
], { encoding: "utf8" }).stdout.trim());

const normalized: string[] = [];
const shortClips: string[] = [];
for (const scene of manifest.scenes) {
  const target = resolve(normalizedDir, `${scene.id}.mp4`);
  run("ffmpeg", ["-y", "-i", scene.videoPath, "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2", "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-an", target]);
  normalized.push(target);
  const shortTarget = resolve(normalizedDir, `${scene.id}-short.mp4`);
  run("ffmpeg", ["-y", "-i", target, "-t", String(scene.shortSeconds), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", shortTarget]);
  shortClips.push(shortTarget);
}

const normalizedById = new Map(manifest.scenes.map((scene, index) => [scene.id, normalized[index]!]));
const montageSceneIds = ["workspace", "cfp", "review", "speaker_portal", "agenda", "live_show", "publication", "widgets_and_close"] as const;
const montageFractions = [0.55, 0.63, 0.71, 0.79, 0.87, 0.95] as const;
const hookSpecs = [
  ...montageSceneIds.flatMap((id) => montageFractions.map((fraction) => ({ id, fraction }))),
  { id: "intro", fraction: 0.65 },
  { id: "intro", fraction: 0.9 },
] as const;
const hookClipSeconds = 0.1;
const hookClips: string[] = [];
for (const [index, spec] of hookSpecs.entries()) {
  const source = normalizedById.get(spec.id);
  const scene = manifest.scenes.find((candidate) => candidate.id === spec.id);
  if (!source || !scene) throw new Error(`Missing montage source for ${spec.id}`);
  const still = resolve(normalizedDir, `hook-${String(index + 1).padStart(2, "0")}.png`);
  const target = resolve(normalizedDir, `hook-${String(index + 1).padStart(2, "0")}.mp4`);
  run("ffmpeg", [
    "-y", "-ss", String(scene.durationSeconds * spec.fraction), "-i", source, "-frames:v", "1",
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2", still,
  ]);
  run("ffmpeg", [
    "-y", "-loop", "1", "-i", still,
    "-t", String(hookClipSeconds),
    "-r", "30", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-an", target,
  ]);
  hookClips.push(target);
}
const hook = resolve(normalizedDir, "cold-open.mp4");
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", await concatFile("cold-open.txt", hookClips), "-c", "copy", hook]);
normalized[0] = hook;
const hookDuration = mediaDuration(hook);
const hookShort = resolve(normalizedDir, "intro-short.mp4");
run("ffmpeg", ["-y", "-i", hook, "-t", String(manifest.scenes[0]?.shortSeconds ?? 7), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", hookShort]);
shortClips[0] = hookShort;
const presentationScenes = manifest.scenes.map((scene, index) => index === 0 ? {
  ...scene,
  durationSeconds: hookDuration,
  narration: "Fifty views, one connected event workflow.",
} : scene);

const rawLong = resolve(outputDir, "session-party-walkthrough-raw.mp4");
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", await concatFile("long.txt", normalized), "-c", "copy", rawLong]);

const formatTime = (seconds: number) => {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
};
let cursor = 0;
const subtitles: string[] = [];
presentationScenes.forEach((scene, index) => {
  const end = cursor + scene.durationSeconds;
  subtitles.push(String(index + 1), `${formatTime(cursor + 0.4)} --> ${formatTime(Math.max(cursor + 1, end - 0.4))}`, scene.narration, "");
  cursor = end;
});
subtitles.push(String(presentationScenes.length + 1), `${formatTime(Math.max(0, cursor - 4))} --> ${formatTime(cursor)}`, manifest.disclosure, "");
const captionsPath = resolve(outputDir, "session-party-walkthrough.srt");
await writeFile(captionsPath, subtitles.join("\n"));

const finalLong = resolve(outputDir, "session-party-walkthrough.mp4");
run("ffmpeg", ["-y", "-i", rawLong, "-i", captionsPath, "-map", "0:v", "-map", "1:0", "-c:v", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", finalLong]);

const rawShort = resolve(outputDir, "session-party-walkthrough-short-raw.mp4");
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", await concatFile("short.txt", shortClips), "-c", "copy", rawShort]);
let shortCursor = 0;
const shortSubtitles: string[] = [];
authoredNarration.short.scenes.forEach((scene, index) => {
  const end = shortCursor + scene.durationSeconds;
  shortSubtitles.push(String(index + 1), `${formatTime(shortCursor + 0.2)} --> ${formatTime(end - 0.2)}`, scene.narration, "");
  shortCursor = end;
});
const shortCaptionsPath = resolve(outputDir, "session-party-walkthrough-short.srt");
await writeFile(shortCaptionsPath, shortSubtitles.join("\n"));
const finalShort = resolve(outputDir, "session-party-walkthrough-short.mp4");
run("ffmpeg", ["-y", "-i", rawShort, "-i", shortCaptionsPath, "-map", "0:v", "-map", "1:0", "-c:v", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", finalShort]);

await writeFile(resolve(outputDir, "outputs.json"), `${JSON.stringify({
  long: basename(finalLong),
  short: basename(finalShort),
  captions: basename(captionsPath),
  shortCaptions: basename(shortCaptionsPath),
  sceneCount: manifest.scenes.length,
}, null, 2)}\n`);
process.stdout.write(`Created ${finalLong}\nCreated ${finalShort}\n`);
