import { mkdir } from "node:fs/promises";
import { test } from "@playwright/test";
import { gotoVisualTarget, installDeterministicBrowser } from "./helpers/visual-readiness";

type Persona = "public" | "owner" | "reviewer" | "speaker";

interface VisualTarget {
  readonly name: string;
  readonly path: string;
  readonly persona: Persona;
}

const EVENT_SLUG = "ai-engineer-sandbox";
const SESSION_BY_PERSONA: Partial<Record<Persona, string>> = {
  owner: "demo-owner-session",
  reviewer: "demo-reviewer-session",
  speaker: "demo-speaker-session",
};

const TARGETS: readonly VisualTarget[] = [
  { name: "landing", path: "/", persona: "public" },
  { name: "events-home", path: "/events", persona: "owner" },
  { name: "event-dashboard", path: `/e/${EVENT_SLUG}/dashboard`, persona: "owner" },
  { name: "forms", path: `/e/${EVENT_SLUG}/forms`, persona: "owner" },
  { name: "review-workbench", path: `/e/${EVENT_SLUG}/review`, persona: "reviewer" },
  { name: "agenda", path: `/e/${EVENT_SLUG}/agenda`, persona: "owner" },
  { name: "publication", path: `/e/${EVENT_SLUG}/publication`, persona: "owner" },
  { name: "speaker-portal", path: `/e/${EVENT_SLUG}/portal`, persona: "speaker" },
  { name: "reusable-speaker-profile", path: "/speaker/profile", persona: "speaker" },
  { name: "public-program", path: `/event/${EVENT_SLUG}`, persona: "public" },
  { name: "public-reusable-speaker-profile", path: "/speakers/priya-raman", persona: "public" },
  { name: "schedule-embed", path: `/embed/${EVENT_SLUG}/schedule`, persona: "public" },
  { name: "speaker-embed", path: `/embed/${EVENT_SLUG}/speakers`, persona: "public" },
];

test.beforeAll(async () => {
  await mkdir("screenshots-pages", { recursive: true });
});

for (const target of TARGETS) {
  test(`${target.persona}: ${target.name}`, async ({ context, page, baseURL }) => {
    const session = SESSION_BY_PERSONA[target.persona];
    if (session) {
      const origin = new URL(baseURL ?? "http://127.0.0.1:5173");
      await context.addCookies([
        {
          name: "sp_session",
          value: session,
          domain: origin.hostname,
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
          secure: origin.protocol === "https:",
        },
      ]);
    }

    await installDeterministicBrowser(page);
    await gotoVisualTarget(page, target.path);
    await page.screenshot({
      path: `screenshots-pages/page--${target.name}--${target.persona}.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
}
