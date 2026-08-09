import { describe, expect, it } from "vitest";
import { discoveredClientRoutePaths } from "./route-discovery";

describe("client route discovery", () => {
  it("excludes test modules from the client router", () => {
    expect(discoveredClientRoutePaths).not.toEqual([]);
    expect(discoveredClientRoutePaths.every((path) => !path.includes(".test."))).toBe(true);
  });
});
