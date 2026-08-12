import { Schema } from "effect";

export const EventRole = Schema.Literal("owner", "admin", "reviewer");
export type EventRole = typeof EventRole.Type;

export const InstallRole = Schema.Literal("staff");
export type InstallRole = typeof InstallRole.Type;

export const ApiScope = Schema.Literal(
  "event:read",
  "event:write",
  "forms:read",
  "forms:write",
  "submissions:read",
  "submissions:write",
  "speakers:read",
  "speakers:write",
  "reviews:read",
  "reviews:write",
  "agenda:read",
  "agenda:write",
  "communications:read",
  "communications:write",
  "content:read",
  "content:write",
  "integrations:read",
  "integrations:write",
  "audit:read",
);
export type ApiScope = typeof ApiScope.Type;

/** Runtime decoder for the JSON array stored in api_keys.scopes. */
export const ApiScopes = Schema.NonEmptyArray(ApiScope);

export interface BrowserSessionPrincipal {
  readonly kind: "browser-session";
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  /** Informational snapshot for clients; authorization always rechecks the active grant. */
  readonly installRole?: InstallRole;
  readonly apiKeyId?: undefined;
  readonly eventId?: undefined;
  readonly scopes?: undefined;
}

export interface EventApiKeyPrincipal {
  readonly kind: "api-key";
  /** Stable audit actor identifier; this is not a user or event membership. */
  readonly userId: `api-key:${string}`;
  readonly apiKeyId: string;
  readonly eventId: string;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: number;
  readonly email?: undefined;
  readonly sessionId?: undefined;
}

/** Authenticated identity only. Event authority is always evaluated separately. */
export type Principal = BrowserSessionPrincipal | EventApiKeyPrincipal;

type NonEmptyReadonlyArray<A> = readonly [A, ...A[]];

export type EventMemberPolicy =
  | { readonly kind: "deny" }
  | {
      readonly kind: "event-member";
      readonly roles: NonEmptyReadonlyArray<EventRole>;
    };

export type EventApiKeyPolicy =
  | { readonly kind: "deny" }
  | {
      readonly kind: "api-key";
      /** Every listed scope is required. Empty, wildcard, and implicit-admin policies are unrepresentable. */
      readonly scopes: NonEmptyReadonlyArray<ApiScope>;
    };

export interface EventAuthorizationPolicy {
  readonly kind: "event";
  /** Event-scoped OperationDef inputs expose the resolved event ID at top-level `eventId`. */
  readonly eventId: "eventId";
  readonly browser: EventMemberPolicy;
  readonly apiKey: EventApiKeyPolicy;
}

export interface InstallAuthorizationPolicy {
  readonly kind: "install";
  readonly browser: {
    readonly kind: "install-role";
    readonly roles: NonEmptyReadonlyArray<InstallRole>;
  };
  readonly apiKey: { readonly kind: "deny" };
}

/** Declarative metadata consumed by operation adapters; it contains no transport behavior. */
export type AuthorizationPolicy =
  | { readonly kind: "public" }
  | { readonly kind: "authenticated" }
  | { readonly kind: "browser-session" }
  | InstallAuthorizationPolicy
  | EventAuthorizationPolicy;

export const publicAuthorization: AuthorizationPolicy = { kind: "public" };
export const authenticatedAuthorization: AuthorizationPolicy = { kind: "authenticated" };
export const browserSessionAuthorization: AuthorizationPolicy = { kind: "browser-session" };
export const installStaffAuthorization: InstallAuthorizationPolicy = {
  kind: "install",
  browser: { kind: "install-role", roles: ["staff"] },
  apiKey: { kind: "deny" },
};

export const eventAuthorization = (
  browser: EventMemberPolicy,
  apiKey: EventApiKeyPolicy,
): EventAuthorizationPolicy => ({ kind: "event", eventId: "eventId", browser, apiKey });

export const allowsEventRole = (
  policy: EventMemberPolicy,
  role: EventRole,
): boolean => policy.kind === "event-member" && policy.roles.some((allowed) => allowed === role);

export const allowsApiScopes = (
  policy: EventApiKeyPolicy,
  granted: readonly ApiScope[],
): boolean =>
  policy.kind === "api-key" &&
  policy.scopes.every((required) => granted.some((scope) => scope === required));
