import { describe, expect, it } from "vitest";
import { eventCreationNotice, type EventCreationConfig } from "./event-creation";

const config = (configured: boolean, open: boolean): EventCreationConfig => ({
  eventCreation: {
    configured,
    mode: open ? "open" : "closed",
    open,
    initialAdminConfigured: !open,
  },
});

describe("event creation warning", () => {
  it("prominently explains unsafe or missing event creation choices", () => {
    expect(eventCreationNotice(config(false, false))).toContain("explicitly choose");
    expect(eventCreationNotice(config(true, true))).toContain("Any signed-in account");
  });

  it("stays quiet for explicitly closed event creation", () => {
    expect(eventCreationNotice(config(true, false))).toBeNull();
  });
});
