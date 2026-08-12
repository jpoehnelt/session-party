import { describe, expect, it } from "vitest";
import { registrationNotice, type RegistrationConfig } from "./registration";

const config = (configured: boolean, open: boolean): RegistrationConfig => ({
  registration: {
    configured,
    mode: open ? "open" : "closed",
    open,
    initialAdminConfigured: !open,
  },
});

describe("registration warning", () => {
  it("prominently explains unsafe or missing registration choices", () => {
    expect(registrationNotice(config(false, false))).toContain("explicitly choose");
    expect(registrationNotice(config(true, true))).toContain("Anyone can create an account");
  });

  it("stays quiet for explicitly closed registration", () => {
    expect(registrationNotice(config(true, false))).toBeNull();
  });
});
