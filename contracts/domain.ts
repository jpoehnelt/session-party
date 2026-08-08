import { Schema } from "effect";

/** JSON-compatible values used by generated transport descriptors. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Stable opaque identifier shared by wire DTOs. */
export const EntityId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
);
export type EntityId = typeof EntityId.Type;

/** Milliseconds since the Unix epoch on every transport. */
export const UnixTimestampMs = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
export type UnixTimestampMs = typeof UnixTimestampMs.Type;

/** Standard camelCase pagination input. */
export const PaginationInput = Schema.Struct({
  page: Schema.optionalWith(Schema.NumberFromString.pipe(Schema.int(), Schema.positive()), {
    default: () => 1,
  }),
  pageSize: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100)),
    { default: () => 25 },
  ),
});
export type PaginationInput = typeof PaginationInput.Type;

export const Pagination = Schema.Struct({
  page: Schema.Int.pipe(Schema.positive()),
  pageSize: Schema.Int.pipe(Schema.between(1, 100)),
  total: Schema.Int.pipe(Schema.nonNegative()),
  pageCount: Schema.Int.pipe(Schema.nonNegative()),
});
export type Pagination = typeof Pagination.Type;

export interface PageResult<A> {
  readonly results: readonly A[];
  readonly pagination: Pagination;
}

export type OperationId = `${string}.${string}`;
export type EventType = string;
