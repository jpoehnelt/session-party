import { afterEach, describe, expect, it, vi } from "vitest";
import { AirtableAdapterError, createLiveAirtableAdapter } from "./airtable";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("live Airtable adapter", () => {
  it("uses physical field IDs and Airtable performUpsert batches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      records: [{
        id: "recOne",
        fields: { fldSessionPartyId: "speaker-1", fldVisible: true },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const adapter = createLiveAirtableAdapter("pat-test-value");

    await expect(adapter.upsertBatch({
      baseId: "appBase",
      tableId: "tblSpeakers",
      mergeFieldId: "fldSessionPartyId",
      records: [{ sessionPartyId: "speaker-1", fields: { fldVisible: true } }],
    })).resolves.toEqual([
      { id: "recOne", fields: { fldSessionPartyId: "speaker-1", fldVisible: true } },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v0/appBase/tblSpeakers?returnFieldsByFieldId=true");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(init?.body))).toEqual({
      performUpsert: { fieldsToMergeOn: ["fldSessionPartyId"] },
      records: [{ fields: { fldVisible: true, fldSessionPartyId: "speaker-1" } }],
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer pat-test-value");
  });

  it("classifies 429 responses as retryable with Airtable's minimum backoff", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Too many requests" },
    }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "1" },
    }));
    const adapter = createLiveAirtableAdapter("pat-test-value");

    const error = await adapter.listPage({
      baseId: "appBase",
      tableId: "tblSpeakers",
      fieldIds: ["fldSessionPartyId"],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AirtableAdapterError);
    expect(error).toMatchObject({ code: "http_429", retryable: true, retryAfterMs: 30_000 });
  });

  it("preserves 429 backoff even when Airtable returns a non-JSON error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "2" },
    }));
    const adapter = createLiveAirtableAdapter("pat-test-value");

    await expect(adapter.listPage({
      baseId: "appBase",
      tableId: "tblSpeakers",
      fieldIds: ["fldSessionPartyId"],
    })).rejects.toMatchObject({ code: "http_429", retryable: true, retryAfterMs: 30_000 });
  });

  it("rejects oversized writes before making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const adapter = createLiveAirtableAdapter("pat-test-value");
    const records = Array.from({ length: 11 }, (_, index) => ({
      sessionPartyId: `speaker-${index}`,
      fields: {},
    }));

    await expect(adapter.upsertBatch({
      baseId: "appBase",
      tableId: "tblSpeakers",
      mergeFieldId: "fldSessionPartyId",
      records,
    })).rejects.toMatchObject({ code: "invalid_batch", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
