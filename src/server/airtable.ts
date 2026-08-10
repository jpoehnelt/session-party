export type AirtableAdapterMode = "fake" | "live";

export interface AirtableWriteRecord {
  readonly sessionPartyId: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface AirtableRecord {
  readonly id: string;
  readonly createdTime?: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface AirtableUpsertBatch {
  readonly baseId: string;
  readonly tableId: string;
  readonly mergeFieldId: string;
  readonly records: readonly AirtableWriteRecord[];
}

export interface AirtableDeleteBatch {
  readonly baseId: string;
  readonly tableId: string;
  readonly recordIds: readonly string[];
}

export interface AirtableListPage {
  readonly baseId: string;
  readonly tableId: string;
  readonly fieldIds: readonly string[];
  readonly cursor?: string;
  readonly viewId?: string;
}

export interface AirtablePage {
  readonly records: readonly AirtableRecord[];
  readonly cursor?: string;
}

export interface AirtableAdapterService {
  readonly mode: AirtableAdapterMode;
  readonly upsertBatch: (input: AirtableUpsertBatch) => Promise<readonly AirtableRecord[]>;
  readonly deleteBatch: (input: AirtableDeleteBatch) => Promise<void>;
  readonly listPage: (input: AirtableListPage) => Promise<AirtablePage>;
}

export class AirtableAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = "AirtableAdapterError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const boundedJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new AirtableAdapterError({
      code: "response_too_large",
      message: "Airtable returned an oversized response",
      retryable: false,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AirtableAdapterError({
      code: "invalid_json",
      message: "Airtable returned invalid JSON",
      retryable: response.status >= 500,
    });
  }
};

const errorMessage = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const error = Reflect.get(payload, "error");
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : null;
};

const parseRetryAfter = (response: Response): number | undefined => {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

const airtableRequest = async (
  pat: string,
  url: URL,
  init: RequestInit,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AirtableAdapterError({
      code: "network_error",
      message: error instanceof Error ? error.message : "Airtable request failed",
      retryable: true,
    });
  }
  if (response.ok && response.status === 204) return null;
  let payload: unknown;
  try {
    payload = await boundedJson(response);
  } catch (error) {
    if (response.ok) throw error;
    const retryAfter = parseRetryAfter(response);
    throw new AirtableAdapterError({
      code: `http_${response.status}`,
      message: `Airtable returned ${response.status} with an unreadable error response`,
      retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      retryAfterMs: response.status === 429
        ? Math.max(30_000, retryAfter ?? 30_000)
        : retryAfter,
    });
  }
  if (!response.ok) {
    const retryAfter = parseRetryAfter(response);
    throw new AirtableAdapterError({
      code: `http_${response.status}`,
      message: errorMessage(payload) ?? `Airtable returned ${response.status}`,
      retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      retryAfterMs: response.status === 429
        ? Math.max(30_000, retryAfter ?? 30_000)
        : retryAfter,
    });
  }
  return payload;
};

const decodeRecord = (value: unknown): AirtableRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = Reflect.get(value, "id");
  const fields = Reflect.get(value, "fields");
  const createdTime = Reflect.get(value, "createdTime");
  if (
    typeof id !== "string"
    || typeof fields !== "object"
    || fields === null
    || Array.isArray(fields)
  ) return null;
  return {
    id,
    fields: fields as Readonly<Record<string, unknown>>,
    ...(typeof createdTime === "string" ? { createdTime } : {}),
  };
};

const decodeRecords = (payload: unknown): readonly AirtableRecord[] => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AirtableAdapterError({
      code: "invalid_response",
      message: "Airtable returned an invalid record response",
      retryable: false,
    });
  }
  const rawRecords = Reflect.get(payload, "records");
  if (!Array.isArray(rawRecords)) {
    throw new AirtableAdapterError({
      code: "invalid_response",
      message: "Airtable response did not include records",
      retryable: false,
    });
  }
  const records = rawRecords.map(decodeRecord);
  if (records.some((record) => record === null)) {
    throw new AirtableAdapterError({
      code: "invalid_response",
      message: "Airtable returned an invalid record",
      retryable: false,
    });
  }
  return records as readonly AirtableRecord[];
};

const recordsUrl = (baseId: string, tableId: string): URL =>
  new URL(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`);

export const createLiveAirtableAdapter = (pat: string): AirtableAdapterService => ({
  mode: "live",
  upsertBatch: async (input) => {
    if (input.records.length === 0 || input.records.length > 10) {
      throw new AirtableAdapterError({
        code: "invalid_batch",
        message: "Airtable upsert batches must contain between one and ten records",
        retryable: false,
      });
    }
    const url = recordsUrl(input.baseId, input.tableId);
    url.searchParams.set("returnFieldsByFieldId", "true");
    const payload = await airtableRequest(pat, url, {
      method: "PATCH",
      body: JSON.stringify({
        performUpsert: { fieldsToMergeOn: [input.mergeFieldId] },
        records: input.records.map((record) => ({
          fields: {
            ...record.fields,
            [input.mergeFieldId]: record.sessionPartyId,
          },
        })),
      }),
    });
    return decodeRecords(payload);
  },
  deleteBatch: async (input) => {
    if (input.recordIds.length === 0 || input.recordIds.length > 10) {
      throw new AirtableAdapterError({
        code: "invalid_batch",
        message: "Airtable delete batches must contain between one and ten records",
        retryable: false,
      });
    }
    const url = recordsUrl(input.baseId, input.tableId);
    for (const id of input.recordIds) url.searchParams.append("records[]", id);
    await airtableRequest(pat, url, { method: "DELETE" });
  },
  listPage: async (input) => {
    const url = recordsUrl(input.baseId, input.tableId);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    for (const fieldId of input.fieldIds) url.searchParams.append("fields[]", fieldId);
    if (input.cursor) url.searchParams.set("offset", input.cursor);
    if (input.viewId) url.searchParams.set("view", input.viewId);
    const payload = await airtableRequest(pat, url, { method: "GET" });
    const records = decodeRecords(payload);
    const cursor = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? Reflect.get(payload, "offset")
      : undefined;
    return {
      records,
      ...(typeof cursor === "string" ? { cursor } : {}),
    };
  },
});

type FakeTable = {
  readonly nextRecord: number;
  readonly records: Readonly<Record<string, AirtableRecord>>;
};

export const fakeAirtableStorageKey = (baseId: string, tableId: string): string =>
  `airtable-fake:${baseId}:${tableId}`;

const emptyFakeTable = (): FakeTable => ({ nextRecord: 1, records: {} });

export const createFakeAirtableAdapter = (
  storage: DurableObjectStorage,
): AirtableAdapterService => ({
  mode: "fake",
  upsertBatch: async (input) => storage.transaction(async (transaction) => {
    if (input.records.length === 0 || input.records.length > 10) {
      throw new AirtableAdapterError({
        code: "invalid_batch",
        message: "Airtable upsert batches must contain between one and ten records",
        retryable: false,
      });
    }
    const key = fakeAirtableStorageKey(input.baseId, input.tableId);
    const current = await transaction.get<FakeTable>(key) ?? emptyFakeTable();
    let nextRecord = current.nextRecord;
    const records = { ...current.records };
    const written: AirtableRecord[] = [];
    for (const inputRecord of input.records) {
      const existing = Object.values(records).find(
        (record) => record.fields[input.mergeFieldId] === inputRecord.sessionPartyId,
      );
      const id = existing?.id ?? `recFake${String(nextRecord++).padStart(8, "0")}`;
      const record: AirtableRecord = {
        id,
        createdTime: existing?.createdTime ?? "2000-01-01T00:00:00.000Z",
        fields: {
          ...existing?.fields,
          ...inputRecord.fields,
          [input.mergeFieldId]: inputRecord.sessionPartyId,
        },
      };
      records[id] = record;
      written.push(record);
    }
    await transaction.put(key, { nextRecord, records } satisfies FakeTable);
    return written;
  }),
  deleteBatch: async (input) => storage.transaction(async (transaction) => {
    if (input.recordIds.length === 0 || input.recordIds.length > 10) {
      throw new AirtableAdapterError({
        code: "invalid_batch",
        message: "Airtable delete batches must contain between one and ten records",
        retryable: false,
      });
    }
    const key = fakeAirtableStorageKey(input.baseId, input.tableId);
    const current = await transaction.get<FakeTable>(key) ?? emptyFakeTable();
    const records = { ...current.records };
    for (const id of input.recordIds) delete records[id];
    await transaction.put(key, { ...current, records } satisfies FakeTable);
  }),
  listPage: async (input) => {
    const key = fakeAirtableStorageKey(input.baseId, input.tableId);
    const table = await storage.get<FakeTable>(key) ?? emptyFakeTable();
    const start = input.cursor ? Number(input.cursor) : 0;
    const all = Object.values(table.records).sort((left, right) => left.id.localeCompare(right.id));
    const records = all.slice(start, start + 100).map((record) => ({
      ...record,
      fields: Object.fromEntries(
        Object.entries(record.fields).filter(([field]) => input.fieldIds.includes(field)),
      ),
    }));
    const next = start + records.length;
    return {
      records,
      ...(next < all.length ? { cursor: String(next) } : {}),
    };
  },
});
