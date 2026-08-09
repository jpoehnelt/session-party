import { describe, expect, it } from "vitest";
import { publicProgramMetadata } from "./index";

describe("publicProgramMetadata", () => {
  it("uses the event and public surface in share metadata", () => {
    expect(publicProgramMetadata(
      "/event/ai-engineer-sandbox/gallery",
      "AI Engineer Sandbox",
      "https://sessionparty.com/event/ai-engineer-sandbox/gallery",
    )).toEqual({
      title: "Speaker gallery — AI Engineer Sandbox — Session Party",
      description: "AI Engineer Sandbox speaker gallery: the current published event program.",
      canonicalUrl: "https://sessionparty.com/event/ai-engineer-sandbox/gallery",
    });
  });

  it("falls back to the sessions surface", () => {
    expect(publicProgramMetadata("/event/demo/unknown", "Demo", "https://example.com/event/demo/unknown").title)
      .toBe("Sessions — Demo — Session Party");
  });
});
