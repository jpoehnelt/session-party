import { describe, expect, it } from "vitest";
import { resolveLocalRuntime } from "./local-runtime";

describe("resolveLocalRuntime", () => {
  it("derives an exact loopback origin from the assigned port", () => {
    expect(resolveLocalRuntime({ PASEO_PORT: "5188" })).toEqual({
      host: "127.0.0.1",
      port: 5188,
      origin: "http://127.0.0.1:5188",
    });
  });

  it("accepts only the matching explicit loopback origin", () => {
    expect(resolveLocalRuntime({
      HOST: "127.0.0.1",
      PASEO_PORT: "5188",
      PASEO_BASE_URL: "http://127.0.0.1:5188",
    }).origin).toBe("http://127.0.0.1:5188");

    expect(() => resolveLocalRuntime({
      PASEO_PORT: "5188",
      PASEO_BASE_URL: "https://example.invalid",
    })).toThrow("PASEO_BASE_URL must be exactly http://127.0.0.1:5188");
  });

  it("permits the supervisor bind address only with an assigned port", () => {
    expect(resolveLocalRuntime({ HOST: "0.0.0.0", PASEO_PORT: "5188" })).toEqual({
      host: "0.0.0.0",
      port: 5188,
      origin: "http://127.0.0.1:5188",
    });

    expect(() => resolveLocalRuntime({ HOST: "0.0.0.0" })).toThrow(
      "HOST must be 127.0.0.1, or 0.0.0.0 with an assigned PASEO_PORT",
    );
  });
});
