const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;

/**
 * Exponential backoff with deterministic per-delivery jitter of up to +25%.
 * The jitter derives from the delivery id and attempt number rather than
 * randomness, so retry schedules stay reproducible in tests and stable across
 * lease-reclaim replays while deliveries that failed in the same batch still
 * spread out instead of hammering a struggling receiver in lockstep. Shared by
 * the mail and webhook delivery lanes.
 */
export const retryDelayMs = (deliveryId: string, attemptCount: number): number => {
  const exponential = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1),
  );
  const source = `${deliveryId}:${attemptCount}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return exponential + ((hash >>> 0) % (Math.floor(exponential / 4) + 1));
};
