import { describe, expect, it } from "vitest";
import {
  TURNSTILE_DEMO_DISABLED_SITE_KEY,
  TURNSTILE_DEMO_EVENT_ID,
  turnstileSiteKeyForEvent,
} from "./abuse";

describe("demo event Turnstile selection", () => {
  it("disables Turnstile only for the exact disposable demo event ID", () => {
    expect(turnstileSiteKeyForEvent(TURNSTILE_DEMO_EVENT_ID, "live-site-key"))
      .toBe(TURNSTILE_DEMO_DISABLED_SITE_KEY);
    expect(turnstileSiteKeyForEvent("demo-event-copy", "live-site-key"))
      .toBe("live-site-key");
    expect(turnstileSiteKeyForEvent("other-event", "live-site-key"))
      .toBe("live-site-key");
  });

  it("does not make missing live configuration available to other events", () => {
    expect(turnstileSiteKeyForEvent("other-event", null)).toBeNull();
  });
});
