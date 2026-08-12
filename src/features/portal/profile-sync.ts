import { Effect } from "effect";

/** Keep organizer reads responsive without flooding D1 with one write per speaker. */
export const PROFILE_SNAPSHOT_SYNC_CONCURRENCY = 4;

export const runBoundedProfileSnapshotSync = <Candidate, Error, Requirements>(
  candidates: Iterable<Candidate>,
  sync: (candidate: Candidate) => Effect.Effect<unknown, Error, Requirements>,
): Effect.Effect<void, Error, Requirements> => Effect.forEach(candidates, sync, {
  concurrency: PROFILE_SNAPSHOT_SYNC_CONCURRENCY,
  discard: true,
});
