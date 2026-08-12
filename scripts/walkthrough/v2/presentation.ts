import type { Locator, Page } from "playwright";
import type { Trace } from "./types";

const css = `
  [data-wt-v2-layer]{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
  [data-wt-v2-trace]{display:none;position:absolute;left:28px;bottom:28px;width:min(680px,48vw);background:#171717;color:#fff;border:6px solid #ff5a36;box-shadow:10px 10px 0 #fff;padding:18px 20px}
  [data-wt-v2-trace] dl{display:grid;grid-template-columns:8.5rem minmax(0,1fr);gap:10px 14px;margin:0}
  [data-wt-v2-trace] dt{color:#ffb19f;font:950 13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}
  [data-wt-v2-trace] dd{margin:0;color:#fff;font:800 16px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}
  [data-wt-v2-focus]{display:none;position:absolute;border:6px solid #ff5a36;box-shadow:0 0 0 3px #fff,8px 8px 0 #171717}
  [data-wt-v2-focus]::after{content:attr(data-label);position:absolute;right:-6px;top:-44px;background:#ff5a36;color:#171717;border:3px solid #fff;padding:7px 11px;font:950 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap;box-shadow:4px 4px 0 #171717}
  [data-wt-v2-cursor]{display:none;position:absolute;width:28px;height:28px;border-radius:50%;border:6px solid #ff5a36;background:#fff;box-shadow:0 0 0 3px #171717;transform:translate(-50%,-50%)}
`;

export async function install(page: Page) {
  await page.evaluate((styles) => {
    const doc = (globalThis as any).document;
    if (doc.querySelector("[data-wt-v2-layer]")) return;
    const layer = doc.createElement("div");
    layer.dataset.wtV2Layer = "true";
    layer.innerHTML = `
      <aside data-wt-v2-trace><dl>
        <dt>Action</dt><dd data-wt-v2-action></dd>
        <dt>Operation</dt><dd data-wt-v2-operation></dd>
        <dt>State</dt><dd data-wt-v2-state></dd>
      </dl></aside>
      <div data-wt-v2-focus></div>
      <div data-wt-v2-cursor></div>`;
    doc.documentElement.append(layer);
    const style = doc.createElement("style");
    style.dataset.wtV2Style = "true";
    style.textContent = styles;
    doc.head.append(style);
  }, css);
}

export async function anchor(page: Page, target: Locator, viewportRatio = 0.46) {
  const locator = target.first();
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  await locator.evaluate((element, ratio) => {
    const win = (globalThis as any).window;
    const rect = element.getBoundingClientRect();
    const absoluteTop = win.scrollY + rect.top;
    win.scrollTo({ top: Math.max(0, absoluteTop - win.innerHeight * Number(ratio)), behavior: "instant" });
  }, viewportRatio);
  await page.waitForTimeout(450);
}

export async function showTrace(page: Page, details: Trace) {
  await install(page);
  await page.evaluate((value) => {
    const doc = (globalThis as any).document;
    const panel = doc.querySelector("[data-wt-v2-trace]")!;
    panel.querySelector("[data-wt-v2-action]")!.textContent = value.action;
    panel.querySelector("[data-wt-v2-operation]")!.textContent = value.operation;
    panel.querySelector("[data-wt-v2-state]")!.textContent = value.state;
    panel.style.display = "block";
  }, details);
}

export async function focus(page: Page, target: Locator, label: string) {
  await install(page);
  const locator = target.first();
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Unable to frame walkthrough target: ${label}`);
  await page.evaluate(({ box: value, text }) => {
    const outline = (globalThis as any).document.querySelector("[data-wt-v2-focus]")!;
    outline.style.display = "block";
    outline.style.left = `${Math.max(8, value.x - 8)}px`;
    outline.style.top = `${Math.max(44, value.y - 8)}px`;
    outline.style.width = `${value.width + 16}px`;
    outline.style.height = `${value.height + 16}px`;
    outline.dataset.label = text;
  }, { box, text: label });
}

export async function clearFocus(page: Page) {
  await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const outline = doc.querySelector("[data-wt-v2-focus]");
    const cursor = doc.querySelector("[data-wt-v2-cursor]");
    if (outline) outline.style.display = "none";
    if (cursor) cursor.style.display = "none";
  });
}

export async function click(page: Page, target: Locator, label: string) {
  const locator = target.first();
  await focus(page, locator, label);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Unable to click walkthrough target: ${label}`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    const cursor = (globalThis as any).document.querySelector("[data-wt-v2-cursor]")!;
    cursor.style.display = "block";
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
  }, point);
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await page.waitForTimeout(500);
  await locator.click();
  await page.waitForTimeout(600);
}
