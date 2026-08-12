import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { clearSpotlight, scrollBy, spotlight, titleCard } from "./presentation";
import { scenes } from "./scenes";
import type { RecordedScene } from "./types";

const arg = (name: string, fallback: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

const baseUrl = arg("base-url", process.env.WALKTHROUGH_BASE_URL ?? "https://sessionparty.com").replace(/\/$/, "");
const eventSlug = arg("event", process.env.WALKTHROUGH_EVENT_SLUG ?? "ai-engineer-sandbox");
const outputDir = resolve(arg("output", "artifacts/walkthrough"));
const headed = process.argv.includes("--headed");
const smoke = process.argv.includes("--smoke");
const only = arg("scene", "");
const from = arg("from", "");

await mkdir(resolve(outputDir, "scenes"), { recursive: true });
await mkdir(resolve(outputDir, "traces"), { recursive: true });
await mkdir(resolve(outputDir, "screenshots"), { recursive: true });

const narrationPath = resolve("scripts/walkthrough/narration.json");
const authoredNarration = JSON.parse(await readFile(narrationPath, "utf8")) as {
  readonly disclosure: string;
  readonly full: { readonly scenes: readonly { readonly id: string; readonly durationSeconds: number; readonly narration: string }[] };
};
const targetDurationByScene = new Map(authoredNarration.full.scenes.map((scene) => [scene.id, scene.durationSeconds]));
const narrationByScene = new Map(authoredNarration.full.scenes.map((scene) => [scene.id, scene.narration]));
const browser = await chromium.launch({ headless: !headed });
const recorded: RecordedScene[] = [];
const state = new Map<string, string>();

try {
  const fromIndex = from ? scenes.findIndex((scene) => scene.id === from) : 0;
  if (from && fromIndex < 0) throw new Error(`Unknown starting scene: ${from}`);
  for (const scene of scenes.filter((candidate, index) => (!only || candidate.id === only) && index >= fromIndex)) {
    process.stdout.write(`Recording ${scene.id}: ${scene.title}\n`);
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      recordVideo: { dir: resolve(outputDir, "scenes"), size: { width: 1920, height: 1080 } },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
      localStorage.setItem("session-party-walkthrough", "true");
    });
    const video = page.video();
    const startedAt = performance.now();
    try {
      await scene.run({
        page,
        state,
        baseUrl,
        eventSlug,
        outputDir,
        headed,
        pause: (milliseconds) => page.waitForTimeout(milliseconds),
        titleCard: (title, subtitle, technicalDetails) => titleCard(page, title, subtitle, technicalDetails),
        spotlight: (selector, label) => spotlight(page, selector, label),
        clearSpotlight: () => clearSpotlight(page),
        scrollBy: (pixels) => scrollBy(page, pixels),
      });
      const targetMilliseconds = smoke ? 0 : (targetDurationByScene.get(scene.id) ?? 15) * 1_000;
      let remaining = targetMilliseconds - (performance.now() - startedAt);
      let direction = 1;
      while (remaining > 1_000) {
        const hold = Math.min(4_000, remaining);
        await page.evaluate((distance) => ((globalThis as any).scrollBy)({ top: distance, behavior: "smooth" }), 120 * direction).catch(() => undefined);
        await page.waitForTimeout(hold);
        direction *= -1;
        remaining = targetMilliseconds - (performance.now() - startedAt);
      }
      await page.screenshot({ path: resolve(outputDir, "screenshots", `${scene.id}.png`), fullPage: false });
      await context.tracing.stop({ path: resolve(outputDir, "traces", `${scene.id}.zip`) });
    } catch (error) {
      await page.screenshot({ path: resolve(outputDir, "screenshots", `${scene.id}-failure.png`), fullPage: true }).catch(() => undefined);
      await context.tracing.stop({ path: resolve(outputDir, "traces", `${scene.id}-failure.zip`) }).catch(() => undefined);
      throw new Error(`${scene.id} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await context.close();
    }
    if (!video) throw new Error(`No video was created for ${scene.id}`);
    const videoPath = resolve(outputDir, "scenes", `${scene.id}.webm`);
    await video.saveAs(videoPath);
    const encodedDuration = Number(execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ], { encoding: "utf8" }).trim());
    recorded.push({
      id: scene.id,
      title: scene.title,
      narration: narrationByScene.get(scene.id) ?? scene.narration,
      shortSeconds: scene.shortSeconds,
      videoPath,
      durationSeconds: encodedDuration,
    });
  }
} finally {
  await browser.close();
}

const manifestPath = resolve(outputDir, "manifest.json");
const partialRun = Boolean(only || from);
const previous = partialRun
  ? await readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as { readonly scenes?: readonly RecordedScene[] }).catch(() => null)
  : null;
const mergedRecorded = previous?.scenes
  ? scenes.flatMap((scene) => recorded.find((candidate) => candidate.id === scene.id) ?? previous.scenes!.find((candidate) => candidate.id === scene.id) ?? [])
  : recorded;
await writeFile(manifestPath, `${JSON.stringify({
  baseUrl,
  eventSlug,
  recordedAt: new Date().toISOString(),
  disclosure: authoredNarration.disclosure,
  scenes: mergedRecorded,
}, null, 2)}\n`);
process.stdout.write(`Recorded ${recorded.length} scenes; manifest contains ${mergedRecorded.length} scenes in ${outputDir}\n`);
