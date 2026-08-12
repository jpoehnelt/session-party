import type { Locator, Page } from "playwright";

const overlayCss = `
  [data-walkthrough-layer]{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
  [data-walkthrough-cursor]{position:absolute;width:32px;height:32px;border:4px solid #caff4a;border-radius:50%;box-shadow:0 0 0 3px #171714,0 4px 18px #0008;transform:translate(-50%,-50%);left:50%;top:50%;transition:left .28s ease,top .28s ease}
  [data-walkthrough-callout]{display:none;position:absolute;border:4px solid #7857ff;box-shadow:0 0 0 4px #fff,8px 8px 0 #171714;transition:all .28s ease}
  [data-walkthrough-callout]::after{content:attr(data-label);position:absolute;left:-4px;top:-38px;background:#171714;color:#fff;padding:6px 10px;font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
  [data-walkthrough-callout][data-side=right]::after{left:auto;right:-4px}
  [data-walkthrough-title]{display:none;position:absolute;left:50%;top:50%;width:min(760px,80vw);transform:translate(-50%,-50%);background:#fffdf7;border:5px solid #171714;box-shadow:14px 14px 0 #7857ff;padding:34px 42px;text-align:left}
  [data-walkthrough-title] strong{display:block;font-size:48px;line-height:1;font-weight:950;letter-spacing:-.055em;color:#171714}
  [data-walkthrough-title] span{display:block;margin-top:16px;font-size:22px;line-height:1.35;font-weight:700;color:#4f4a40}
  [data-walkthrough-tech]{display:none;position:absolute;right:30px;top:30px;width:min(570px,42vw);background:#171714;color:#fff;border:4px solid #caff4a;box-shadow:10px 10px 0 #7857ff;padding:22px 24px}
  [data-walkthrough-tech] b{display:block;color:#caff4a;font-size:13px;font-weight:950;letter-spacing:.16em;text-transform:uppercase;margin-bottom:12px}
  [data-walkthrough-tech] ul{display:grid;gap:9px;margin:0;padding:0;list-style:none}
  [data-walkthrough-tech] li{font:800 17px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff}
  [data-walkthrough-tech] li::before{content:'→';color:#caff4a;margin-right:10px}
`;

export async function installPresentationLayer(page: Page) {
  await page.evaluate((css) => {
    if ((globalThis as any).document.querySelector("[data-walkthrough-layer]")) return;
    const layer = (globalThis as any).document.createElement("div");
    layer.dataset.walkthroughLayer = "true";
    layer.innerHTML = "<div data-walkthrough-cursor></div><div data-walkthrough-callout></div><div data-walkthrough-title><strong></strong><span></span></div><aside data-walkthrough-tech><b>Killing the SaaS layer · open primitives</b><ul></ul></aside>";
    (globalThis as any).document.documentElement.append(layer);
    const style = (globalThis as any).document.createElement("style");
    style.dataset.walkthroughStyle = "true";
    style.textContent = css;
    (globalThis as any).document.head.append(style);
  }, overlayCss);
}

export async function titleCard(page: Page, title: string, subtitle: string, technicalDetails: readonly string[] = []) {
  await installPresentationLayer(page);
  await page.evaluate(({ title, subtitle }) => {
    const card = (globalThis as any).document.querySelector("[data-walkthrough-title]")!;
    card.querySelector("strong")!.textContent = title;
    card.querySelector("span")!.textContent = subtitle;
    card.style.display = "block";
  }, { title, subtitle });
  await page.waitForTimeout(2_200);
  await page.evaluate(() => {
    const card = (globalThis as any).document.querySelector("[data-walkthrough-title]");
    if (card) card.style.display = "none";
  });
  if (technicalDetails.length) {
    await page.evaluate((items) => {
      const panel = (globalThis as any).document.querySelector("[data-walkthrough-tech]")!;
      const list = panel.querySelector("ul")!;
      list.replaceChildren(...items.map((item: string) => {
        const row = (globalThis as any).document.createElement("li");
        row.textContent = item;
        return row;
      }));
      panel.style.display = "block";
    }, technicalDetails);
    await page.waitForTimeout(3_200);
    await page.evaluate(() => {
      const panel = (globalThis as any).document.querySelector("[data-walkthrough-tech]");
      if (panel) panel.style.display = "none";
    });
  }
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
