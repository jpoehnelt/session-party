import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  PROFILE_SNAPSHOT_SYNC_CONCURRENCY,
  runBoundedProfileSnapshotSync,
} from "./profile-sync";

describe("reusable profile snapshot sync scheduling", () => {
  it("runs writes concurrently while respecting the D1 fan-out bound", async () => {
    let active = 0;
    let maximumActive = 0;
    const completed: number[] = [];

    await Effect.runPromise(runBoundedProfileSnapshotSync(
      Array.from({ length: PROFILE_SNAPSHOT_SYNC_CONCURRENCY * 3 }, (_, index) => index),
      (candidate) => Effect.gen(function* () {
        yield* Effect.sync(() => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
        });
        yield* Effect.sleep("10 millis");
        yield* Effect.sync(() => {
          completed.push(candidate);
          active -= 1;
        });
      }),
    ));

    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(PROFILE_SNAPSHOT_SYNC_CONCURRENCY);
    expect(completed).toHaveLength(PROFILE_SNAPSHOT_SYNC_CONCURRENCY * 3);
    expect(active).toBe(0);
  });
});
