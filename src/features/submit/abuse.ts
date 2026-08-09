import { External, Validation } from "contracts/errors";
import { Context, Effect } from "effect";

/** Cloudflare Siteverify rejects tokens over this documented maximum. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

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
  turnstileSiteKey: "1x00000000000000000000AA",
  authorize: (_attempt: PublicSubmissionAbuseAttempt) => Effect.void,
} as const;
