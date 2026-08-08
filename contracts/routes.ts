import type { JsonObject, OperationId } from "./domain";

export const API = "/api/v1";
export const PARTY = "event-room";

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Maps fields of an operation's single input DTO to REST request locations.
 * Every field is camelCase. A body may consume the whole DTO only when no
 * other location is declared.
 */
export interface RestInputLocations {
  readonly path?: readonly string[];
  readonly query?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: "all" | readonly string[];
}

export interface RestRegistrationDescriptor {
  readonly operationId: OperationId;
  readonly method: HttpMethod;
  readonly path: string;
  readonly input: RestInputLocations;
  readonly successStatus: 200 | 201 | 202 | 204;
}

export interface OpenApiDocument extends JsonObject {
  readonly openapi: "3.1.0";
  readonly info: JsonObject;
  readonly paths: JsonObject;
}

export const clientRoutes = {
  home: "/",
  event: (slug: string) => `/e/${slug}`,
  portal: (slug: string) => `/e/${slug}/portal`,
  submit: (slug: string, formId: string) => `/submit/${slug}/${formId}`,
  embedSpeakers: (slug: string) => `/embed/${slug}/speakers`,
  embedSchedule: (slug: string) => `/embed/${slug}/schedule`,
} as const;
