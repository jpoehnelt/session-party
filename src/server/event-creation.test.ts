import { describe, expect, it } from "vitest";
import { eventCreationPolicy, mayCreateEvent } from "./event-creation";

describe("event creation policy", () => {
  it("fails closed when the mode is missing or invalid", () => {
    expect(eventCreationPolicy({})).toMatchObject({ configured: false, mode: "closed" });
    expect(eventCreationPolicy({ EVENT_CREATION_MODE: "maybe" })).toMatchObject({
      configured: false,
      mode: "closed",
    });
    expect(mayCreateEvent(eventCreationPolicy({}), "owner@example.com", true)).toBe(false);
  });

  it("allows only the bootstrap admin or an existing owner in closed mode", () => {
    const closed = eventCreationPolicy({
      EVENT_CREATION_MODE: "closed",
      INITIAL_ADMIN_EMAIL: " Owner@Example.com ",
    });
    expect(mayCreateEvent(closed, "owner@example.com", false)).toBe(true);
    expect(mayCreateEvent(closed, "existing-owner@example.com", true)).toBe(true);
    expect(mayCreateEvent(closed, "unknown@example.com", false)).toBe(false);
  });

  it("allows any signed-in account only after an explicit open choice", () => {
    const open = eventCreationPolicy({ EVENT_CREATION_MODE: " OPEN " });
    expect(open).toMatchObject({ configured: true, mode: "open" });
    expect(mayCreateEvent(open, "anyone@example.com", false)).toBe(true);
  });
});
