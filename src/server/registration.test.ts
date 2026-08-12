import { describe, expect, it } from "vitest";
import { mayCreateAccount, registrationPolicy } from "./registration";

describe("registration policy", () => {
  it("fails closed when the mode is missing or invalid", () => {
    expect(registrationPolicy({})).toMatchObject({ configured: false, mode: "closed" });
    expect(registrationPolicy({ REGISTRATION_MODE: "maybe" })).toMatchObject({
      configured: false,
      mode: "closed",
    });
    expect(mayCreateAccount(registrationPolicy({}), "owner@example.com")).toBe(false);
  });

  it("keeps initial-admin bootstrap separate from the registration choice", () => {
    const closed = registrationPolicy({
      REGISTRATION_MODE: "closed",
      INITIAL_ADMIN_EMAIL: " Owner@Example.com ",
    });
    expect(mayCreateAccount(closed, "owner@example.com")).toBe(true);
    expect(mayCreateAccount(closed, "unknown@example.com")).toBe(false);
  });

  it("opens account creation only after an explicit open choice", () => {
    const open = registrationPolicy({ REGISTRATION_MODE: " OPEN " });
    expect(open).toMatchObject({ configured: true, mode: "open" });
    expect(mayCreateAccount(open, "anyone@example.com")).toBe(true);
  });
});
