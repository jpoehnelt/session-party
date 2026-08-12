import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
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
const hookSpecs = [
  { id: "cfp", start: 10, label: "CFP BUILDER" },
  { id: "cfp", start: 15, label: "PUBLIC SUBMISSION" },
  { id: "review", start: 10, label: "BLIND REVIEW" },
  { id: "speaker_portal", start: 9, label: "SPEAKER PORTAL" },
  { id: "agenda", start: 11, label: "AGENDA" },
  { id: "live_show", start: 10, label: "PARTYSERVER LIVE DESK" },
  { id: "publication", start: 15, label: "PUBLICATION" },
  { id: "widgets_and_close", start: 2, label: "STABLE PUBLIC EMBED" },
] as const;
const hookClips: string[] = [];
for (const [index, spec] of hookSpecs.entries()) {
  const source = normalizedById.get(spec.id);
  if (!source) throw new Error(`Missing normalized scene for cold open: ${spec.id}`);
  const target = resolve(normalizedDir, `hook-${String(index + 1).padStart(2, "0")}.mp4`);
  const plate = resolve(normalizedDir, `hook-${String(index + 1).padStart(2, "0")}.png`);
  const svg = `
    <svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
      <rect x="28" y="26" width="1030" height="72" fill="#061219" fill-opacity=".94"/>
      <text x="52" y="75" fill="#00e5ff" font-family="Arial, sans-serif" font-size="38" font-weight="900">KILL 6 SAAS PRODUCTS. ONE CLOUDFLARE APP.</text>
      <rect x="28" y="980" width="620" height="68" fill="#061219" fill-opacity=".94"/>
      <text x="52" y="1026" fill="white" font-family="Arial, sans-serif" font-size="31" font-weight="900">${spec.label}</text>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(plate);
  run("ffmpeg", ["-y", "-ss", String(spec.start), "-i", source, "-loop", "1", "-i", plate, "-t", "1.35", "-filter_complex", "[0:v][1:v]overlay=0:0", "-r", "30", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-an", target]);
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
  narration: "Kill six event-operations SaaS products with one open-source Cloudflare application: intake, review, speakers, scheduling, live control, publication, and embeds.",
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
