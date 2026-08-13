import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { arg, ensureTools, mediaDurationSeconds } from "../shared";
import { captureOpeningViews } from "./opening";
import { anchor, clearFocus, click, focus, install, showTrace } from "./presentation";
import { shots } from "./shots";
import type { RecordedShot } from "./types";

const baseUrl = arg("base-url", process.env.WALKTHROUGH_BASE_URL ?? "https://sessionparty.com").replace(/\/$/, "");
const eventSlug = arg("event", process.env.WALKTHROUGH_EVENT_SLUG ?? "ai-engineer-sandbox");
const outputDir = resolve(arg("output", "artifacts/walkthrough-v2"));
const only = arg("shot", "");
const from = arg("from", "");
const smoke = process.argv.includes("--smoke");
const headed = process.argv.includes("--headed");
const openingOnly = process.argv.includes("--opening-only");
const skipOpening = process.argv.includes("--skip-opening") || Boolean(only || from);
const openingFrom = Number(arg("opening-from", "1"));
if (!Number.isInteger(openingFrom) || openingFrom < 1 || openingFrom > 50) throw new Error("--opening-from must be an integer from 1 through 50");

ensureTools(["ffprobe"]);
if (only && !shots.some((shot) => shot.id === only)) {
  throw new Error(`Unknown shot: ${only}. Valid shots: ${shots.map((shot) => shot.id).join(", ")}`);
}

await Promise.all([
  mkdir(resolve(outputDir, "raw"), { recursive: true }),
  mkdir(resolve(outputDir, "screenshots"), { recursive: true }),
  mkdir(resolve(outputDir, "opening"), { recursive: true }),
  mkdir(resolve(outputDir, "diagnostics"), { recursive: true }),
]);

const browser = await chromium.launch({ headless: !headed });
const state = new Map<string, string>();
const recorded: RecordedShot[] = [];
const failures: { readonly id: string; readonly message: string }[] = [];
let opening = null as Awaited<ReturnType<typeof captureOpeningViews>> | null;

try {
  opening = skipOpening ? null : await captureOpeningViews({ browser, baseUrl, eventSlug, outputDir, startAt: openingFrom });
  const fromIndex = from ? shots.findIndex((candidate) => candidate.id === from) : 0;
  if (from && fromIndex < 0) throw new Error(`Unknown starting shot: ${from}`);
  for (const shot of (openingOnly ? [] : shots).filter((candidate, index) => (!only || candidate.id === only) && index >= fromIndex)) {
    process.stdout.write(`Preparing ${shot.id}: ${shot.title}\n`);
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      recordVideo: { dir: resolve(outputDir, "raw"), size: { width: 1920, height: 1080 } },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
      localStorage.setItem("session-party-walkthrough", "v2");
    });
    const video = page.video();
    const videoClock = performance.now();
    let traceStopped = false;
    try {
      const shotContext = {
        page,
        baseUrl,
        eventSlug,
        state,
        pause: (milliseconds: number) => page.waitForTimeout(smoke ? Math.min(80, milliseconds) : milliseconds),
        anchor: (target: Parameters<typeof anchor>[1], ratio?: number) => anchor(page, target, ratio),
        trace: (details: Parameters<typeof showTrace>[1]) => showTrace(page, details),
        focus: (target: Parameters<typeof focus>[1], label: string) => focus(page, target, label),
        clearFocus: () => clearFocus(page),
        click: (target: Parameters<typeof click>[1], label: string) => click(page, target, label),
      };
      await shot.prepare(shotContext);
      await page.evaluate(async () => {
        const doc = (globalThis as any).document;
        await doc.fonts.ready;
        doc.querySelectorAll("[data-wt-v2-layer]").forEach((node: any) => node.remove());
        doc.querySelectorAll("[data-wt-v2-style]").forEach((node: any) => node.remove());
      });
      await page.waitForTimeout(650);
      const trimStartSeconds = (performance.now() - videoClock) / 1_000;
      const captureStarted = performance.now();
      await install(page);
      await shot.capture(shotContext);
      const minimumMilliseconds = smoke ? 250 : shot.durationSeconds * 1_000;
      const remainder = minimumMilliseconds - (performance.now() - captureStarted);
      if (remainder > 0) await page.waitForTimeout(remainder);
      const trimDurationSeconds = (performance.now() - captureStarted) / 1_000;
      const screenshotPath = resolve(outputDir, "screenshots", `${shot.id}.png`);
      await page.screenshot({ path: screenshotPath });
      await context.tracing.stop({ path: resolve(outputDir, "diagnostics", `${shot.id}.zip`) });
      traceStopped = true;
      await context.close();
      if (!video) throw new Error(`Playwright did not create a video for ${shot.id}`);
      const videoPath = resolve(outputDir, "raw", `${shot.id}.webm`);
      await video.saveAs(videoPath);
      const encodedDuration = mediaDurationSeconds(videoPath);
      if (encodedDuration < trimStartSeconds + Math.min(trimDurationSeconds, 0.5)) {
        throw new Error(`Encoded video is shorter than the requested trim for ${shot.id}`);
      }
      recorded.push({
        id: shot.id,
        chapter: shot.chapter,
        title: shot.title,
        durationSeconds: shot.durationSeconds,
        shortSeconds: shot.shortSeconds,
        videoPath,
        trimStartSeconds,
        trimDurationSeconds: Math.min(trimDurationSeconds, encodedDuration - trimStartSeconds),
        screenshotPath,
      });
      process.stdout.write(`Captured ${shot.id}: ${trimDurationSeconds.toFixed(1)}s retained\n`);
    } catch (error) {
      await page.screenshot({ path: resolve(outputDir, "diagnostics", `${shot.id}-failure.png`), fullPage: true }).catch(() => undefined);
      if (!traceStopped) await context.tracing.stop({ path: resolve(outputDir, "diagnostics", `${shot.id}-failure.zip`) }).catch(() => undefined);
      await context.close().catch(() => undefined);
      const message = `${shot.id} failed: ${error instanceof Error ? error.message : String(error)}`;
      failures.push({ id: shot.id, message });
      process.stderr.write(`${message}\nContinuing with the remaining shots.\n`);
    }
  }
} finally {
  await browser.close();
}

const manifestPath = resolve(outputDir, "manifest.json");
const previous = await readFile(manifestPath, "utf8")
  .then((value) => JSON.parse(value) as { readonly shots?: readonly RecordedShot[]; readonly openingViews?: readonly unknown[] })
  .catch(() => null);
const merged = shots.flatMap((shot) =>
  recorded.find((candidate) => candidate.id === shot.id) ?? previous?.shots?.find((candidate) => candidate.id === shot.id) ?? []);
await writeFile(manifestPath, `${JSON.stringify({
  version: 2,
  baseUrl,
  eventSlug,
  recordedAt: new Date().toISOString(),
  openingViews: opening ?? previous?.openingViews ?? [],
  shots: merged,
}, null, 2)}\n`);
process.stdout.write(`Recorded ${recorded.length} proof shots; manifest contains ${merged.length}.\n`);
if (failures.length) {
  process.stderr.write(`${failures.length} shot(s) failed: ${failures.map((failure) => failure.id).join(", ")}. Retry each with --shot=<id>; successful shots are already in the manifest.\n`);
  process.exitCode = 1;
}
