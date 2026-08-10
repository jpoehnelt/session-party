import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBED_DESIGN,
  embedDesignFromSearch,
  embedDesignSearch,
  embedDesignStyle,
} from "./embed-design";

describe("embed design configuration", () => {
  it("round-trips a supported aesthetic and normalized brand color", () => {
    const design = embedDesignFromSearch("?aesthetic=minimal&accent=%23ff5a36");

    expect(design).toEqual({ aesthetic: "minimal", accent: "#FF5A36" });
    expect(embedDesignSearch(design)).toBe("aesthetic=minimal&accent=%23FF5A36");
  });

  it("fails closed to the default design for unsupported query values", () => {
    expect(embedDesignFromSearch("?aesthetic=scripted&accent=red")).toEqual(DEFAULT_EMBED_DESIGN);
  });

  it("projects the selected aesthetic and accent into scoped design tokens", () => {
    expect(embedDesignStyle({ aesthetic: "editorial", accent: "#123456" })).toMatchObject({
      "--color-accent": "#123456",
      "--color-canvas": "#F4EFE5",
      "--color-production-coral": "#123456",
    });
  });
});
