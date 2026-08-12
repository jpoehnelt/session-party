import type { Locator, Page } from "playwright";

const overlayCss = `
  [data-walkthrough-layer]{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
  [data-walkthrough-cursor]{position:absolute;width:34px;height:34px;border:5px solid #00e5ff;background:#fff;border-radius:50%;box-shadow:0 0 0 3px #071820,0 0 24px #00e5ff;transform:translate(-50%,-50%);left:50%;top:50%;transition:left .28s ease,top .28s ease}
  [data-walkthrough-callout]{display:none;position:absolute;border:5px solid #00e5ff;box-shadow:0 0 0 4px #fff,0 0 0 9999px #06121999,9px 9px 0 #071820;transition:all .28s ease}
  [data-walkthrough-callout]::after{content:attr(data-label);position:absolute;left:-5px;top:-42px;background:#00e5ff;color:#061219;border:3px solid #fff;padding:7px 11px;font:950 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap;box-shadow:4px 4px 0 #071820}
  [data-walkthrough-callout][data-side=right]::after{left:auto;right:-4px}
  [data-walkthrough-tech]{display:none;position:absolute;right:28px;top:28px;width:min(660px,46vw);background:#061219f2;color:#fff;border:4px solid #00e5ff;box-shadow:0 0 0 4px #fff,12px 12px 0 #071820;padding:20px 22px}
  [data-walkthrough-tech] b{display:block;color:#00e5ff;font:950 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;margin-bottom:14px}
  [data-walkthrough-tech] ul{display:grid;gap:10px;margin:0;padding:0;list-style:none}
  [data-walkthrough-tech] li{display:grid;grid-template-columns:8.5rem minmax(0,1fr);gap:12px;border-top:1px solid #ffffff33;padding-top:9px;font:750 15px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff}
  [data-walkthrough-tech] li:first-child{border-top:0;padding-top:0}
  [data-walkthrough-tech] em{color:#00e5ff;font-style:normal;font-weight:950;letter-spacing:.07em;text-transform:uppercase}
  [data-walkthrough-tech] span{color:#fff}
`;

export async function installPresentationLayer(page: Page) {
  await page.evaluate((css) => {
    if ((globalThis as any).document.querySelector("[data-walkthrough-layer]")) return;
    const layer = (globalThis as any).document.createElement("div");
    layer.dataset.walkthroughLayer = "true";
    layer.innerHTML = "<div data-walkthrough-cursor></div><div data-walkthrough-callout></div><aside data-walkthrough-tech><b>Technical trace · replacing SaaS with owned primitives</b><ul></ul></aside>";
    (globalThis as any).document.documentElement.append(layer);
    const style = (globalThis as any).document.createElement("style");
    style.dataset.walkthroughStyle = "true";
    style.textContent = css;
    (globalThis as any).document.head.append(style);
  }, overlayCss);
}

export async function titleCard(page: Page, title: string, subtitle: string, technicalDetails: readonly string[] = []) {
  await installPresentationLayer(page);
  void title;
  void subtitle;
  if (technicalDetails.length) {
    await page.evaluate((items) => {
      const panel = (globalThis as any).document.querySelector("[data-walkthrough-tech]")!;
      const list = panel.querySelector("ul")!;
      list.replaceChildren(...items.map((item: string) => {
        const row = (globalThis as any).document.createElement("li");
        const [label, ...rest] = item.split("|");
        const key = (globalThis as any).document.createElement("em");
        key.textContent = label ?? "Trace";
        const value = (globalThis as any).document.createElement("span");
        value.textContent = rest.join("|") || item;
        row.append(key, value);
        return row;
      }));
      panel.style.display = "block";
    }, technicalDetails);
    await page.waitForTimeout(350);
  }
}

export async function clearTechnicalOverlay(page: Page) {
  await page.evaluate(() => {
    const panel = (globalThis as any).document.querySelector("[data-walkthrough-tech]");
    if (panel) panel.style.display = "none";
  });
}

async function boxFor(locator: Locator) {
  await locator.first().waitFor({ state: "visible", timeout: 15_000 });
  await locator.first().scrollIntoViewIfNeeded();
  return locator.first().boundingBox();
}

export async function spotlight(page: Page, selector: string, label = "") {
  await installPresentationLayer(page);
  const locator = page.locator(selector);
  const box = await boxFor(locator);
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 12 });
  await page.evaluate(({ x, y, box, label }) => {
    const cursor = (globalThis as any).document.querySelector("[data-walkthrough-cursor]")!;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    const callout = (globalThis as any).document.querySelector("[data-walkthrough-callout]")!;
    callout.style.display = "block";
    callout.style.left = `${Math.max(8, box.x - 8)}px`;
    callout.style.top = `${Math.max(42, box.y - 8)}px`;
    callout.style.width = `${box.width + 16}px`;
    callout.style.height = `${box.height + 16}px`;
    callout.dataset.label = label;
    callout.dataset.side = x > ((globalThis as any).innerWidth / 2) ? "right" : "left";
  }, { x, y, box, label });
  await page.waitForTimeout(900);
}

export async function clearSpotlight(page: Page) {
  await page.evaluate(() => {
    const callout = (globalThis as any).document.querySelector("[data-walkthrough-callout]");
    if (callout) callout.style.display = "none";
  });
}

export async function scrollBy(page: Page, pixels: number) {
  await page.evaluate((distance) => ((globalThis as any).scrollBy)({ top: distance, behavior: "smooth" }), pixels);
  await page.waitForTimeout(1_200);
}
