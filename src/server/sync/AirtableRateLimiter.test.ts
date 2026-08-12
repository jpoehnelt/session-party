import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { internalServiceToken } from "../services";
import { AIRTABLE_GLOBAL_INTERVAL_MS } from "./AirtableRateLimiter";

describe("AirtableRateLimiter", () => {
  it("requires internal authorization and reserves globally spaced PAT slots", async () => {
    const stub = env.AIRTABLE_RATE_LIMITER.get(env.AIRTABLE_RATE_LIMITER.idFromName("airtable-pat-global"));
    await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAll());
    await expect(stub.fetch("https://airtable-rate-limiter/acquire", { method: "POST" })
      .then((response) => response.status)).resolves.toBe(403);
    const internalToken = await internalServiceToken(env);

    const responses = await Promise.all(Array.from({ length: 4 }, () => stub.fetch(
      "https://airtable-rate-limiter/acquire",
      {
        method: "POST",
        headers: { "x-session-party-internal": internalToken },
      },
    ).then((response) => response.json<{ readonly slotAt: number }>())));
    const slots = responses.map(({ slotAt }) => slotAt).sort((left, right) => left - right);
    const gaps = slots.slice(1).map((slot, index) => slot - slots[index]!);
    expect(gaps).toHaveLength(3);
    expect(gaps.every((gap) => gap >= AIRTABLE_GLOBAL_INTERVAL_MS)).toBe(true);
  });
});
