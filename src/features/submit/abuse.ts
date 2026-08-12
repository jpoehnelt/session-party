import { External, Validation } from "contracts/errors";
import { Context, Effect } from "effect";

/** Cloudflare Siteverify rejects tokens over this documented maximum. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

/**
 * The disposable production demo event deliberately uses Cloudflare's
 * published always-pass test credentials. Every other event continues to use
 * the configured live widget and secret.
 */
export const TURNSTILE_DEMO_EVENT_ID = "demo-event";
export const TURNSTILE_ALWAYS_PASS_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_ALWAYS_PASS_SECRET_KEY = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_ACTION = "test";
export const TURNSTILE_TEST_HOSTNAME = "localhost";

export const turnstileSiteKeyForEvent = (
  eventId: string,
  configuredSiteKey: string | null,
): string | null => eventId === TURNSTILE_DEMO_EVENT_ID
  ? TURNSTILE_ALWAYS_PASS_SITE_KEY
  : configuredSiteKey;

export type PublicSubmissionAbuseAttempt = {
  readonly eventId: string;
  readonly formId: string;
  /** Null means a legacy published form lacks the immutable speakerEmail semantic. */
  readonly normalizedEmail: string | null;
  readonly turnstileToken: string | undefined;
  /** Derived only from trusted request transport, never request JSON. */
  readonly remoteIp: string | null;
};

export class PublicSubmissionRequest extends Context.Tag("session-party/submit/PublicSubmissionRequest")<
  PublicSubmissionRequest,
  { readonly remoteIp: string | null }
>() {}

/** AppLayer supplies production Siteverify + durable-budget behavior. */
export class PublicSubmissionAbuse extends Context.Tag("session-party/submit/PublicSubmissionAbuse")<
  PublicSubmissionAbuse,
  {
    readonly turnstileSiteKey: string | null;
    readonly authorize: (attempt: PublicSubmissionAbuseAttempt) => Effect.Effect<void, Validation | External>;
  }
>() {}

export const normalizePublicEmail = (value: string): string => value.trim().toLocaleLowerCase("en-US");

/** Deterministic, explicitly injected local-test seam. Never install in production. */
export const localTestPublicSubmissionAbuse = {
  turnstileSiteKey: TURNSTILE_ALWAYS_PASS_SITE_KEY,
  authorize: (_attempt: PublicSubmissionAbuseAttempt) => Effect.void,
} as const;
