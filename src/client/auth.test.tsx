import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import LoginPage, { demoReturnTo } from "./auth";

describe("hackathon demo login", () => {
  it("sends each persona to its own event surface by default", () => {
    expect(demoReturnTo("organizer", "")).toBe("/e/devflow-conf-2027");
    expect(demoReturnTo("speaker", "")).toBe("/e/devflow-conf-2027/portal");
    expect(demoReturnTo("reviewer", "")).toBe("/e/devflow-conf-2027/review");
  });

  it("preserves an explicit safe destination", () => {
    expect(demoReturnTo("speaker", "?returnTo=%2Fe%2Fcustom%2Fportal%3Ftab%3Dtasks"))
      .toBe("/e/custom/portal?tab=tasks");
  });

  it("offers deterministic organizer, speaker, and reviewer identities", () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: ["/login?returnTo=%2Fevents"] }, createElement(LoginPage)),
    );

    expect(markup).toContain("Hackathon demo access");
    expect(markup).toContain("Continue as Organizer — Jordan Alvarez");
    expect(markup).toContain("Continue as Speaker — Priya Raman");
    expect(markup).toContain("Continue as Reviewer — Sam Whitfield");
    expect(markup).toContain("sbek-organizer@example.com");
    expect(markup).toContain("Email me a sign-in link");
  });
});
