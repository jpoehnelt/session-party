import { describe, expect, it } from "vitest";
import { loginPathForLocation, validReturnTo } from "./return-to";

describe("returnTo", () => {
  it("keeps a relative route including its query and fragment", () => {
    const location = {
      pathname: "/e/effect-summit/agenda",
      search: "?view=day",
      hash: "#schedule",
    };

    expect(loginPathForLocation(location)).toBe(
      "/login?returnTo=%2Fe%2Feffect-summit%2Fagenda%3Fview%3Dday%23schedule",
    );
    expect(validReturnTo("?returnTo=%2Fe%2Feffect-summit%2Fagenda%3Fview%3Dday%23schedule")).toBe(
      "/e/effect-summit/agenda?view=day#schedule",
    );
  });

  it("rejects external and malformed return paths", () => {
    expect(validReturnTo("?returnTo=https%3A%2F%2Fexample.com")).toBeUndefined();
    expect(validReturnTo("?returnTo=%2F%2Fexample.com")).toBeUndefined();
    expect(validReturnTo("?returnTo=%2F%5Cexample.com")).toBeUndefined();
  });
});
