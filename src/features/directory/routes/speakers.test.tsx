import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ListSpeakerDirectoryInput } from "../schema";
import SpeakerDirectoryPageRoute, { path, speakerDirectoryUrl } from "./speakers";

describe("speaker directory route", () => {
  it("builds stable paginated filter URLs", () => {
    expect(speakerDirectoryUrl({
      query: "  Analytical Engines  ",
      eventId: "event-two",
      status: "spoke",
      page: 3,
      pageSize: 50,
    })).toBe("/api/v1/install/speakers?query=Analytical+Engines&eventId=event-two&status=spoke&page=3&pageSize=50");
  });

  it("decodes REST pagination query strings into service numbers", () => {
    expect(Schema.decodeUnknownSync(ListSpeakerDirectoryInput)({
      page: "3",
      pageSize: "50",
    })).toEqual({ page: 3, pageSize: 50 });
  });

  it("exports the installation route and explains the non-merging identity model", () => {
    expect(path).toBe("/speaker-directory");
    const markup = renderToStaticMarkup(createElement(SpeakerDirectoryPageRoute));
    expect(markup).toContain("Speaker directory");
    expect(markup).toContain("grouped only by normalized email");
    expect(markup).toContain("unmerged");
    expect(markup).toContain("Invite returning speakers");
    expect(markup).toContain("implies no acceptance");
    expect(markup).toContain("sends no email");
  });
});
