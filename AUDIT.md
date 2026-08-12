# session-party — Consolidated Codebase Audit

> **Status note:** This is the original findings report (47 confirmed findings), produced against commit `b4aaec5`. For the current disposition of each finding against the latest `main` (`325f203`) — what has since been FIXED vs what remains OPEN, plus one regression introduced by the fixes — see **[`AUDIT-RECHECK.md`](AUDIT-RECHECK.md)**. As of that re-check, 11 findings (including both criticals) are fixed and 36 remain open.

_Full-codebase audit of session-party (Cloudflare Workers + Hono, Drizzle/D1, partyserver Durable Objects, Airtable sync, React 19 client). ~164k lines of TypeScript across 284 files. Findings below are only those a second-pass verifier marked CONFIRMED or CORRECTED; refuted items are listed at the end. Findings were produced by 11 independent finder agents (Opus on auth/injection/server-correctness/architecture; Sonnet on the rest), each output then adversarially re-checked by a verifier agent; only CONFIRMED/CORRECTED findings survived._

---

## Executive Summary

**Overall risk posture: MEDIUM-HIGH.** The project's own quality gates are healthy — the code compiles, the generated registry is in sync, and the worker test suite is fully green (see below). Nothing here is an active in-the-wild compromise. But two CRITICAL issues sit in the upgrade/deploy path, not the request path, and both are the kind that stay invisible until the worst moment: a migration that silently cascades away all review data on self-hosted upgrades, and a CI pipeline that points per-PR preview Workers (and a per-minute cron) directly at the **production** D1 database and R2 bucket. Compounding the first, the migration test that should have caught it is structured so it never does. Beyond those, the dominant themes are (a) realtime/Durable-Object concurrency correctness on the hot broadcast path, (b) pervasive unpaginated/sequential data access (public pages, sync engine, delivery history), and (c) meaningful CI coverage gaps — the entire Playwright security/authorization suite and part of the audit-browser suite never execute in any required CI job.

**Live quality-gate outcome (app-health dimension — verified by direct re-run, not assumed):**

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm check:types` (`tsc -b`) | **PASS** — exit 0, 0 diagnostics |
| Registry drift | `pnpm check:registry` (`pnpm gen --check`) | **PASS** — exit 0, no drift |
| Worker tests | `pnpm test:worker` (vitest/workerd) | **PASS** — 50/50 files, 522/522 tests |

The gates are green, with two caveats worth noting: the suite was verified on Node v22.22.2 while `package.json` and CI both require Node 24 (see LOW/INFO items), and a benign `abortAllDurableObjects()` teardown line prints to stderr on a fully-passing run (cosmetic). Note that the green worker suite does **not** contradict the CRITICAL migration finding — the one test that exercises 0011 is masked by shared-binding bookkeeping (finding #3), and the QA/audit-browser suites that would catch other regressions do not run in CI at all (findings #10, #11).

**Counts by severity (confirmed findings, after merging cross-dimension duplicates):**

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 9 |
| Medium | 14 |
| Low | 19 |
| Info | 3 |
| **Total** | **47** |

**Top 5 to fix first:**
1. **Migration 0011 cascades away all review data on upgrade** (CRITICAL, #1) — rebuilds `review_rounds` with FK enforcement on; any self-hosted DB with review data loses assignments + reviews.
2. **Per-PR preview Workers have read/write production D1 + R2 + a live cron** (CRITICAL, #2) — every PR, and a per-minute scheduled job, mutates production data.
3. **The migration-parity test masks #1** (HIGH, #3) — shared D1 binding makes the destructive replay a no-op in the full suite; fix this to actually surface #1 in CI.
4. **Agenda editor silently defeats its own optimistic-concurrency guard** (HIGH, #4) — realtime refresh auto-advances `expectedVersion`, so concurrent edits clobber each other with no conflict shown in the flagship collaborative feature.
5. **The entire Playwright QA suite (auth/role authorization/security) never runs in CI** (HIGH, #10), and 2 of 8 audit-browser specs incl. review-decision idempotency never execute anywhere (HIGH, #11).

---

## CRITICAL

### 1. Migration 0011 drops `review_rounds` with FK enforcement on, cascading away all review data
- **Severity:** Critical
- **Dimensions:** data-layer
- **File:** `migrations/0011_solid_imperial_guard.sql:35-57` (`DROP TABLE` at :54); child FKs at `migrations/0001_baseline_green_spine.sql:891,982`
- **Description:** Migration 0011 rebuilds `review_rounds` via create-copy-drop-rename but never wraps it in `PRAGMA foreign_keys=OFF/ON` (the guard is present in 0002/0010/0015/0017, absent here). Because `review_assignments` and `reviews` reference `review_rounds` with `ON DELETE cascade`, the `DROP TABLE review_rounds` deletes every dependent assignment and review row on any deployment that already holds review data.
- **Evidence:**
  ```sql
  -- 0011:54-55, no surrounding PRAGMA foreign_keys=OFF/ON
  DROP TABLE `review_rounds`;--> statement-breakpoint
  ALTER TABLE `__new_review_rounds` RENAME TO `review_rounds`;
  ```
  Reproduced against the repo's own harness: `vitest run migration-parity.test.ts -t "backfills legacy assets"` fails with the seeded `recusal-assignment-old` row deleted (`expected null to deeply equal {...}`).
- **Recommendation:** Wrap the 0011 rebuild in `PRAGMA foreign_keys=OFF;` … `PRAGMA foreign_keys=ON;` (matching 0002/0010/0015/0017). Ship a forward-fix migration for any environment that may already have run 0011, and add an isolated parity test that seeds `review_rounds`/`review_assignments`/`reviews` before replaying 0011 (see #3).

### 2. Per-PR preview Workers get read/write access to production D1 + R2, plus a live per-minute production cron
- **Severity:** Critical
- **Dimensions:** deps-config
- **File:** `wrangler.jsonc:44-79` (`env.preview`); `.github/workflows/ci.yml:210-368` (preview deploy job); R2 layer ungated at `src/server/services.ts:649-655`; cron→DB path at `src/server/party/Scheduler.ts:328-388`
- **Description:** `env.preview.d1_databases[0].database_id` and `r2_buckets[0].bucket_name` are byte-identical to the production values, and `env.preview` sets its own `triggers.crons: ["* * * * *"]`. While `AiService` and `Mail` branch on the preview/local environment, the `Files` (R2) layer and all Drizzle `env.DB` call sites do not — so every PR preview Worker reads/writes production storage, and its per-minute `scheduled()` handler mutates the production `mail_deliveries` table every minute regardless of whether anyone visits the preview URL.
- **Evidence:**
  ```jsonc
  // wrangler.jsonc:54 (comment present verbatim)
  // "Hackathon previews deliberately share production data. PR CI never migrates it."
  ```
  Building the exact CI config (`CLOUDFLARE_ENV=preview … pnpm build`) emits `dist/session_party/wrangler.json` with `"database_id":"2cb93013-…"`, `"bucket_name":"session-party-files"`, `"triggers":{"crons":["* * * * *"]}`. The PR comment text (`ci.yml:344`) even says "This preview has read/write production D1 and R2 bindings."
- **Recommendation:** Give `env.preview` its own D1 database and R2 bucket (or a disposable per-PR namespace), and disable or no-op the cron in preview. If shared production data is a deliberate hackathon choice, gate the R2 `Files` layer and every scheduled/`env.DB` write path behind `isExplicitPreviewEnvironment` the way AI/Mail already are, and make that intent loud in the deploy job.

---

## HIGH

### 3. `migration-parity.test.ts` shares one D1 binding across `it()` blocks, masking exactly the #1 regression class
- **Severity:** High
- **Dimensions:** data-layer
- **File:** `src/server/migration-parity.test.ts:606-661` (test body; `applyOneByOne` at :610/:631), workaround acknowledged at :682-685
- **Description:** Every `it()` in the describe block reuses the same `MIGRATION_DB` binding, and `applyD1Migrations` is idempotent via `d1_migrations` bookkeeping. An earlier test drives the binding through all 18 migrations, so a later test's selective replay of `migrations.slice(11)` is a no-op — 0011's destructive SQL never runs against that test's freshly-seeded fixture in a full-suite run. This is why CI's green suite does not catch #1.
- **Evidence:**
  ```
  $ vitest run migration-parity.test.ts            -> 6 passed (6)
  $ vitest run migration-parity.test.ts -t "backfills legacy assets"  -> 1 failed
  ```
  The sibling 0016 test (:682-685) already documents and works around this exact shared-binding no-op — but the workaround is not applied to the 0011 review-rounds case.
- **Recommendation:** Give each migration-parity case an isolated binding/fresh DB, or apply the same direct-replay workaround the 0016 case uses, so destructive migrations are actually re-executed against their fixtures. This is the test that should have gated #1.

### 4. Agenda talk editor's `expectedVersion` auto-advances via realtime refresh, silently defeating optimistic concurrency
- **Severity:** High
- **Dimensions:** client-ui
- **File:** `src/features/agenda/routes/agenda.tsx:479-482` (`selectedTalk` memo), :546-561 (form init, no re-sync); server guard at `src/features/agenda/service.ts:1350-1351`
- **Description:** `refreshAgenda()` replaces the entire agenda snapshot on any `agenda/talk_upserted|talk_deleted|conflicts` websocket event for any talk, and `selectedTalk` is a `useMemo` over the live `agenda.talks`. So a remote edit advances the open editor's `selectedTalk.version` to the new server value while the `form` state (populated once at `selectTalk`, mutated only by field `onChange`) stays stale. The next save sends the freshly-advanced `expectedVersion`, so the server's version check passes and the organizer silently clobbers the intervening edit with no conflict surfaced to either party — in the product's flagship concurrent-editing feature.
- **Evidence:**
  ```ts
  // service.ts:1350 — server genuinely enforces the guard
  if (before.version !== input.expectedVersion) return yield* Effect.fail(new Conflict(...));
  // agenda.tsx — no setForm() call site re-syncs from agenda/selectedTalk (552, 1262, 1269, 1333, …)
  ```
- **Recommendation:** Capture `expectedVersion` at the moment the editor is opened (or last successfully saved), not from the live snapshot, and surface a conflict when the underlying talk's version moves out from under the open form. Use the `agenda/talk_upserted` payload to detect that *this* talk changed and prompt the editor to reconcile.

### 5. EventRoom broadcasts re-run a sequential D1 auth query per connected client
- **Severity:** High
- **Dimensions:** performance
- **File:** `src/server/party/EventRoom.ts:895-958` (`broadcastAuthorized`/`broadcastAgendaCollaboration`/`broadcastPresence`), `refreshConnectionAuthorization` at :641-666
- **Description:** Every fan-out iterates `getConnections()` in a plain `for` loop and `await`s `refreshConnectionAuthorization` per connection, which unconditionally issues a fresh D1 join (`authTokens`/`eventMembers`, or `apiKeys`) with no cache/TTL. This is the generic path every agenda/comms/show-control mutation emits through, so each broadcast is N sequential D1 round-trips scaling with room size on the hot realtime path.
- **Evidence:**
  ```ts
  for (const connection of this.getConnections<EventRoomConnectionState>()) {
    const state = await this.refreshConnectionAuthorization(connection); // fresh D1 select, every time
    ...
  }
  ```
- **Recommendation:** Cache the per-connection authorization on the connection state with a short TTL (invalidated on membership change), and/or parallelize the revalidation with `Promise.all` before the send loop. Reserve a full re-query for connection open and explicit membership-change events.

### 6. Public speaker gallery does sequential, uncached per-speaker R2 fetch + base64 inlining
- **Severity:** High
- **Dimensions:** performance
- **File:** `src/features/portal/service.ts:4049-4088` (`getPublicSpeakers`)
- **Description:** `getPublicSpeakers` runs `Effect.forEach(snapshot.speakers, …)` with no `concurrency` option (Effect defaults to sequential), and for each speaker does an R2 `get`, reads the full body, and base64-encodes it into a `data:` URL inlined in the JSON response. On the public program page this serializes one R2 round-trip per speaker and bloats the payload, with no HTTP caching in front (see #8).
- **Evidence:**
  ```ts
  const publicSpeakers = yield* Effect.forEach(snapshot.speakers, (speaker) => Effect.gen(function* () {
    const object = yield* get(assetKey(event.id, asset.id));
    headshotUrl = `data:${asset.contentType};base64,${btoa(binary)}`;
  ```
- **Recommendation:** Serve headshots as cacheable R2/CDN URLs rather than inlining base64, or at minimum pass `{ concurrency: … }` to `Effect.forEach` and add caching (#8). Inlining N images sequentially into one JSON body is the worst of both latency and size.

### 7. Client ships as a single ~1.45 MB (425 KB gzip) bundle — no route code-splitting
- **Severity:** High
- **Dimensions:** performance
- **File:** `src/client/route-discovery.ts:11-21`
- **Description:** Routes are discovered via `import.meta.glob([...], { eager: true })` with no `React.lazy`/dynamic `import()` anywhere and no `manualChunks` in `vite.config.ts`, so the whole app (all feature slices, including the public-facing pages) ships as one chunk. Reproduced: `dist/client/assets/index-…js 1,454.42 kB │ gzip: 425.53 kB`, with Vite's own >500 kB warning.
- **Evidence:**
  ```
  dist/client/assets/index-OYe_VMhR.js   1,454.42 kB │ gzip: 425.53 kB
  (!) Some chunks are larger than 500 kB … Consider dynamic import() to code-split
  ```
- **Recommendation:** Switch route discovery to lazy (`{ eager: false }` + `React.lazy`/`Suspense`) so each route is its own chunk, and/or configure `manualChunks` to split vendor and per-feature bundles. Public pages especially should not download the entire authenticated app.

### 8. Public program/speaker JSON APIs set no HTTP caching, unlike the sibling feed endpoints
- **Severity:** High
- **Dimensions:** performance
- **File:** `src/server/adapt.ts:159-212` (`runRestOperation`); the one cached endpoint is `src/features/publication/feed-api.ts:77`
- **Description:** `runRestOperation` only ever returns `c.json(...)`/`c.body(null,204)` with no cache headers, and no middleware adds them. The public, cache-friendly routes `agenda.getPublished` (`/public/events/:slug/agenda/published`) and `portal.getPublicSpeakers` (`/public/events/:slug/speakers`) go through this dispatcher, so every hit reaches the worker + DB/R2 — while `feed-api.ts` is the lone endpoint that sets `Cache-Control`.
- **Evidence:**
  ```ts
  return status === 204 ? c.body(null, 204) : c.json(exit.value, status); // no headers set anywhere
  ```
  `grep -rn "Cache-Control" src/server src/features` → single hit (`feed-api.ts:77`).
- **Recommendation:** Add `Cache-Control` (and ideally `ETag`/edge `cache` API) to the public read operations, either via a per-operation `rest.cache` field honored by `runRestOperation` or a small caching wrapper. This directly relieves #5–#7 on public pages.

### 9. Communication delivery/audience endpoints do unbounded full-table scans with no LIMIT or pagination
- **Severity:** High
- **Dimensions:** performance, api-surface _(both flagged; merged)_
- **File:** `src/features/comms/service.ts:1158-1216` (`listDeliveries`), :479-535 (`loadAudience`/`listAudience`); inputs at `src/features/comms/schema.ts:94,184`
- **Description:** `listDeliveries` joins `mailDeliveries`/`mailDeliverySnapshots`/`emailTemplates` filtered only by `eventId` with `orderBy` but no `.limit()`, then runs a second unlimited query over `mailDeliveryAttempts` — on `mail_deliveries`, a table that grows unboundedly for the life of an event. `loadAudience` similarly scans all accepted/rejected submissions joined to speakers/users. Both input schemas are bare `Struct({ eventId })` with no page/cursor field, even though a bounded `PaginationInput` exists and is used elsewhere (`ListSubmissionsInput`).
- **Evidence:**
  ```ts
  export const ListDeliveriesInput = Schema.Struct({ eventId: EntityId }); // no pagination
  .where(eq(mailDeliverySnapshots.eventId, input.eventId)).orderBy(...) // no .limit()
  ```
- **Recommendation:** Add `PaginationInput` to both operations and `.limit()`/keyset pagination to both queries (delivery history is the higher risk as it grows without bound). The audience scan should also cap or page.

### 10. The entire Playwright QA suite (auth / role-authorization / security) never runs in CI
- **Severity:** High
- **Dimensions:** testing-ci
- **File:** `package.json:34,44`; suite at `e2e/security.qa.pw.ts` (+ 7 other `e2e/*.qa.pw.ts`)
- **Description:** `test:qa` (`playwright test --config playwright.qa.config.ts`) is absent from the `ci` composite script and from all three workflow files. `playwright.qa.config.ts` matches all 8 `*.qa.pw.ts` files, including `security.qa.pw.ts` (8 role sessions: owner/admin/reviewer/unassigned/recused/speaker/observer/expired, with an `expectSafeDenial` helper). None of it executes in any required CI job — so authorization/security regressions are entirely unguarded by CI.
- **Evidence:**
  ```
  ci: "pnpm check && pnpm rubric:test && pnpm test:worker && pnpm test:audit-browser && … "  // no test:qa
  $ grep -rn "test:qa\|playwright.qa.config\|\.qa\.pw\." .github/workflows/   -> no output
  ```
- **Recommendation:** Add a required CI job that runs `pnpm test:qa` (with the `dev:service` webserver it expects). Given it covers role-based authorization and denial paths, it belongs in the merge-gating set, not an optional workflow.

### 11. `test:audit-browser` isn't in the required CI gate; 2 of 8 browser specs (incl. review-decision idempotency) never execute anywhere
- **Severity:** High
- **Dimensions:** testing-ci
- **File:** `.github/workflows/ci.yml:18-36,194-197`; `scripts/rubric.ts:87-125`; `scripts/rubric/evidence.ts:24-29`
- **Description:** The `ci` gate is `needs: [checks, rubric, worker-tests]`, and `test:audit-browser` is a step in none of them. Worse, the rubric runner only executes browser specs that have an associated rubric check in `evidence.ts`, which references just 6 of the 8 configured files — so `review-lifecycle.browser.tsx` and `forms.browser.tsx` never run in any path. `review-lifecycle.browser.tsx` contains the idempotency-key rotation assertions (retry reuses key, key rotates on version bump, distinct key per submission) that would catch a class of double-submit/duplicate-decision bugs.
- **Evidence:**
  ```
  $ grep -n "review-lifecycle\|forms\.browser" scripts/rubric/evidence.ts   -> no output
  // review-lifecycle.browser.tsx:86-154 — idempotencyKey assertions
  ```
- **Recommendation:** Add `test:audit-browser` (the full config, all 8 files) to a required CI job, or add rubric checks for the two orphaned specs so the rubric runner includes them. Either way, ensure `review-lifecycle.browser.tsx` actually runs.

---

## MEDIUM

### 12. CSV formula injection in review-results export
- **Severity:** Medium
- **Dimensions:** injection-input
- **File:** `src/features/review/routes/review-workbench.tsx:642` (`quote` helper); data from `src/features/review/service.ts:1281-1331`; submitter input at `src/features/submit/service.ts:466,666`
- **Description:** The export `quote` helper does CSV escaping only (wraps in quotes, doubles interior quotes) with no neutralization of leading formula sigils (`= + - @`, tab/CR). Submission `title` is anonymous-submitter free text with no content filter, so a CFP submitter can plant `=cmd|'/c calc'!A1` (or a `HYPERLINK`/`WEBSERVICE` exfil formula) in a title that lands in an organizer's downloaded `.csv`. Reviewer `comment` is a second vector; `category` is organizer-constrained (correction: not attacker-controlled).
- **Evidence:**
  ```js
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; // no =/+/-/@ guard
  ```
- **Recommendation:** Prefix any cell whose first char is `= + - @` (or tab/CR) with a `'` or a leading space before quoting, in the shared `exportCsv` path. Bounded by modern Excel's DDE-off default + prompts, hence Medium not High — but the fix is trivial.

### 13. Show-state lost update: D1 await between the storage read and write opens the DO input gate
- **Severity:** Medium
- **Dimensions:** server-correctness
- **File:** `src/server/party/EventRoom.ts:744` (read), :751 (D1 await), :833 (unconditional put)
- **Description:** `handleShowControl` reads show state via `ctx.storage.get`, then for `select`/`start` awaits `isCurrentEventTalk(talkId)` — a D1 subrequest that leaves the DO input gate OPEN. A second `show/control` frame delivered during that await reads the same `revision = N`, and both handlers compute `N+1` and `put` with no CAS or `blockConcurrencyWhile`, losing one update and breaking the revision monotonicity clients rely on to order `show/state` frames. (`hold`/`resume`/`complete`/`reset` have no intervening await and are safe.)
- **Evidence:**
  ```ts
  const current = await this.getShowState();                    // 744
  ... !(await this.isCurrentEventTalk(talkId))                  // 751  D1, gate OPEN
  await this.ctx.storage.put(SHOW_STATE_KEY, next);             // 833  no revision CAS
  ```
- **Recommendation:** Guard the read-modify-write with `ctx.blockConcurrencyWhile(...)`, or move the D1 talk-validation before the read-modify-write section, or add a revision compare-and-swap on the `put`.

### 14. `broadcastAuthorized` uses a raw `connection.send`; a socket closing mid-loop drops delivery to remaining recipients
- **Severity:** Medium
- **Dimensions:** server-correctness
- **File:** `src/server/party/EventRoom.ts:905` (refresh await), :909 (bare send)
- **Description:** Unlike every sibling fan-out (which routes through `sendServerMessage`'s readyState check + try/catch), `broadcastAuthorized` calls the bare `connection.send(encoded)` after a per-connection D1 `refresh` await during which a recipient can transition to CLOSING/CLOSED. Per partyserver's own comments, `send()` on a peer-closed socket throws synchronously, which aborts the `for` loop so every recipient after the closing one silently misses the frame (and it surfaces as a 500 / unhandled rejection). An abrupt 1006 drop instead yields an uncaught async rejection.
- **Evidence:**
  ```ts
  const state = await this.refreshConnectionAuthorization(connection); // 905 peer may close here
  connection.send(encoded);                                            // 909 raw, no guard
  ```
- **Recommendation:** Route `broadcastAuthorized` through the guarded `sendServerMessage` (readyState check + try/catch), matching the other fan-outs, so one closing recipient can't truncate delivery to the rest.

### 15. `publication/api.ts` server router is silently un-mounted and leaks Hono into the client bundle
- **Severity:** Medium
- **Dimensions:** architecture
- **File:** `src/features/publication/api.ts:2,11,121`; wiring at `scripts/gen.ts:346,352`; `src/server/index.ts:243`
- **Description:** `publication/api.ts` is the last file on the retired `api.ts` convention, and because the slice also ships `operations.ts`, gen.ts's `!file.operations` guard excludes it — `apiRouters` is emitted `[]`, so `index.ts:243` mounts nothing (latent: the router defines no routes anyway). The active cost is that the file is imported by six client route/component modules, and `const app = new Hono()` is not tree-shakeable, so the whole Hono server framework crosses into the browser bundle (verified: 122 `hono` mentions retained in a named-export bundle).
- **Evidence:**
  ```
  BUNDLE HAS_new_Hono true   HONO_MENTIONS 122
  // publication/api.ts:11 — const app = new Hono(); with no app.get/post anywhere
  ```
- **Recommendation:** Move the exported constants the client actually needs out of `api.ts` into a client-safe module, delete the unused `Hono` app, and drop the dead `api.ts` convention so the server framework stops shipping to the browser.

### 16. Correctness-critical command infrastructure is copy-implemented per slice with divergent behavior
- **Severity:** Medium
- **Dimensions:** architecture
- **File:** `src/features/comms/service.ts:113-120` (and agenda:223, forms:76, submit:98, +5 more)
- **Description:** `sha256`, `stableStringify`, and `PreparedCommand` are re-defined across 8+ slices with real behavioral divergence: `comms`'s `sha256` is typed `Effect.Effect<string>` via `Effect.promise` (a digest rejection becomes an unrecoverable defect) while the other 7 map to a tagged `External` error; and the three `stableStringify` copies disagree on `undefined`-key handling (comms/forms drop them, submit serializes them as literal `"undefined"`). Since idempotency hashes are only compared within a slice, no slice is currently internally inconsistent — this is a maintainability/correctness-drift hazard plus the comms defect-channel outlier.
- **Evidence:**
  ```ts
  // comms:117 — no error channel; rejection => defect
  const sha256 = (v): Effect.Effect<string> => Effect.promise(async () => {...});
  // agenda:223 — mapped to tagged External
  const sha256 = (v): Effect.Effect<string, External> => Effect.tryPromise({...});
  ```
- **Recommendation:** Extract `sha256`/`stableStringify`/`PreparedCommand` into one shared module with a single canonical `undefined` policy and a proper error channel; delete the per-slice copies. At minimum fix comms's `Effect.promise` → `Effect.tryPromise`.

### 17. Airtable outbox dead-lettering writes are unbatched; a fault between the status flip and the evidence insert leaves a permanently-stuck row
- **Severity:** Medium
- **Dimensions:** data-layer
- **File:** `src/server/sync/airtable-engine.ts:723-773` (`failOutbound`); status flip :738-745, unbatched `deadLetter` insert :747-753
- **Description:** `failOutbound` does two independent sequential `await`s — flip status to `dead_letter`, then insert the dead-letter evidence row — with no `db.batch()`/transaction. D1 auto-commits the first immediately, so if `deadLetter` throws (transient failure/timeout) the row is left `dead_letter` with no evidence and no diagnostic trail, and `claimOutbound` never re-selects `dead_letter` rows — so it's stuck permanently. Requires a double-fault to trigger; the data isn't lost but the integration item silently wedges.
- **Evidence:**
  ```ts
  await db.update(airtableOutbox).set({ status: terminal ? "dead_letter" : "retry" })...; // commits
  if (terminal) { await deadLetter(db, {...}); await db.update(...).set({status:"blocked"})... } // may throw
  ```
- **Recommendation:** Wrap the status flip + evidence insert (+ `blocked` update) in a single `db.batch([...])` so they commit atomically, and/or add a reclaim/recovery path for `dead_letter` rows lacking evidence.

### 18. AI review-suggestion endpoint has no idempotency guard or rate limit despite billed inference cost
- **Severity:** Medium
- **Dimensions:** api-surface
- **File:** `src/features/review/operations.ts:299-324` (`idempotency: "none"`); impl `src/features/review/service.ts:2279-2391`; billed call `src/server/services.ts:673-692`
- **Description:** `requestAiSuggestion` declares `idempotency: "none"` (unlike accept/reject/append/round mutations which are `"required"`), and the handler never checks `input.requestId` against prior requests, has no cooldown, and no per-user/per-submission counter — every call unconditionally reaches `env.AI.run("@cf/meta/llama-3.1-8b-instruct", ...)`, a real billed Workers AI call in production. Any reviewer (or API-key/MCP client) with `reviews:write` can call it unbounded times per submission; the only gate is authorization.
- **Evidence:**
  ```ts
  idempotency: "none", concurrency: "none",   // operations.ts
  const responseText = yield* ai.reviewText(prompt)...  // no dedupe/cooldown before this
  ```
- **Recommendation:** Honor `requestId` for dedupe (return the prior suggestion on replay) and add a per-user or per-submission rate limit / cooldown (a durable counter as used for CFP), so a billed inference call can't be triggered in an unbounded loop.

### 19. Live show "Current session" selector does not clear on reset, showing a stale talk
- **Severity:** Medium
- **Dimensions:** client-ui
- **File:** `src/features/agenda/components/LiveShowControl.tsx:61-63`
- **Description:** The effect `if (state.currentTalkId) setSelectedTalkId(state.currentTalkId)` never handles the falsy branch. On show reset, `EventRoom` broadcasts `currentTalkId: null`, but the guard is skipped so `selectedTalkId` keeps its pre-reset value — the `<Select>` shows the stale talk instead of the placeholder, and because post-reset `state.status` is `"idle"` the "Set ready"/"Start" buttons are enabled and pre-armed against the stale id.
- **Evidence:**
  ```ts
  useEffect(() => { if (state.currentTalkId) setSelectedTalkId(state.currentTalkId); }, [state.currentTalkId]);
  // EventRoom.ts:818 reset -> initialShowState() -> currentTalkId: null
  ```
- **Recommendation:** Handle the reset: `setSelectedTalkId(state.currentTalkId ?? "")` (or clear on `status === "idle"`), so the selector falls back to the placeholder and the action buttons disable.

### 20. Airtable sync re-scans every entity in the event on every drain tick
- **Severity:** Medium
- **Dimensions:** performance
- **File:** `src/server/sync/airtable-engine.ts:313-397` (`enqueueOneMissingProjection`), :1269-1291 (`drainAirtableBase`)
- **Description:** `enqueueOneMissingProjection` nested-loops `AIRTABLE_ENTITY_TYPES × entityIds`, running 1–4+ queries plus a `sha256` per entity, returning early only when it finds a stale entity — so in steady state it's a full O(total entities) sweep. `drainAirtableBase` calls it unconditionally at the top of every tick, and while `processOutbound` is active the alarm re-fires every 250 ms, so the full sweep repeats ~4×/second.
- **Evidence:**
  ```ts
  for (const integration of baseIntegrations) {
    await enqueueOneMissingProjection(db, integration, now);  // full entity scan every tick
    if (await processOutbound(...)) return { nextAlarmAt: now + 250 };
  }
  ```
- **Recommendation:** Track a projection cursor/watermark (or a dirty-set) so the drain only inspects entities changed since last projection, rather than re-hashing the whole event every 250 ms.

### 21. Airtable outbox claim loop issues one SELECT and one UPDATE per candidate row instead of batching
- **Severity:** Medium
- **Dimensions:** performance
- **File:** `src/server/sync/airtable-engine.ts:792-843` (`claimOutbound`)
- **Description:** `claimOutbound` selects up to 50 candidates, then a `for` loop issues one `db.select().limit(1)` per candidate (earlier-revision check), then a second `for` loop issues one `db.update().returning()` per claimed row (capped at `MAX_AIRTABLE_BATCH = 10`) — up to ~60 sequential D1 round-trips per claim cycle.
- **Evidence:**
  ```ts
  for (const row of candidates) { const [earlier] = await db.select(...).limit(1); ... }
  for (const row of selected)   { const [updated] = await db.update(...).where(...).returning(); }
  ```
- **Recommendation:** Collapse the per-candidate earlier-revision check into a single grouped query, and batch the claim updates via `db.batch([...])`, cutting the round-trip count from ~60 to a small constant.

### 22. Airtable refresh page processing issues several sequential DB queries per record
- **Severity:** Medium
- **Dimensions:** performance
- **File:** `src/server/sync/airtable-engine.ts:1085-1178` (`processRefresh` record loop)
- **Description:** For each record in a refresh page, the loop awaits `db.select().limit(1)` on `airtableRecordLinks`, then `entityProjection` (1–4 queries), then `recordOwnershipViolations`, then `applyInboundRecord` (3 parallel queries + a `db.batch`) — fully serialized across records (5–10+ round-trips per record, no cross-record parallelism).
- **Evidence:**
  ```ts
  for (const record of page.records) {
    const [existingRecordLink] = await db.select(...).limit(1);
    const projection = await entityProjection(...);
    await recordOwnershipViolations(...); await applyInboundRecord(...);
  }
  ```
- **Recommendation:** Batch the per-record link lookups and projections across the page, and where ordering allows, process records with bounded concurrency instead of strict serialization.

### 23. `test:storybook` isn't run by the required CI gate — only inside a non-required visual-regression workflow
- **Severity:** Medium
- **Dimensions:** testing-ci
- **File:** `.github/workflows/ci.yml:18-36,195-197`; `.github/workflows/visual-regression.yml:30-52`
- **Description:** `pnpm ci` includes `test:storybook`, but `ci.yml`'s `checks` job only runs `storybook:build` (a static build, no story render/execution). Actual story execution (`visual:stories:capture` = `test:storybook`) lives only in `visual-regression.yml`'s `storybook` job, which is not in the `ci` gate's `needs: [checks, rubric, worker-tests]`. Whether that workflow is separately required is not knowable from the repo (no ruleset/`settings.yml`).
- **Evidence:**
  ```yaml
  ci:
    needs: [checks, rubric, worker-tests]   # no "storybook" job listed
  ```
- **Recommendation:** Add `test:storybook` to a required CI job (or add the visual-regression `storybook` job to the gate's `needs`), so story-render regressions block merge rather than depending on branch-protection config that isn't in the repo.

### 24. New "submitter account handoff" UI flow shipped with no test through the rendered component
- **Severity:** Medium
- **Dimensions:** testing-ci
- **File:** `src/features/submit/routes/public-submit.tsx:476-489` (`handleAccountRequest`); tests `src/features/submit/routes/submit.test.tsx:88-90,281-311`
- **Description:** The recent (today's date) commit `26cf579` "feat(submit): add submitter account handoff" added `handleAccountRequest` (try/catch → `setAccountError`/`setAccountRequested`) but no interactive test: `submit.test.tsx` renders via `renderToStaticMarkup` (no DOM, no events), has no `@testing-library`/`fireEvent`/`userEvent`/`act`, only asserts static markup strings, and the one behavioral test calls `requestSubmitterAccount(...)` directly — bypassing the button wiring and all component state. A broken `onClick` or a silently-swallowed fetch failure would pass every existing test.
- **Evidence:**
  ```tsx
  function renderRoute(pathname, child) { return renderToStaticMarkup(...); } // no DOM/events
  // no @testing-library / fireEvent / userEvent / act( anywhere in the file
  ```
- **Recommendation:** Add an interactive test (Testing Library or the existing `submit-draft.browser.tsx` real-browser harness) that clicks the button and asserts both the success and the fetch-failure (`setAccountError`) branches.

### 25. `run_worker_first` diverges between `wrangler.local.jsonc` and `wrangler.jsonc`, so public-program/embed routes are never worker-served in local dev
- **Severity:** Medium
- **Dimensions:** deps-config
- **File:** `wrangler.local.jsonc:8-9` vs `wrangler.jsonc:10`
- **Description:** Local dev's `run_worker_first` omits `/event/*` and `/embed/*` (present in production), so locally the SPA static-asset fallback answers those paths and the Worker's `fetchPublicProgram`/`fetchEmbedShell` (OG-tag rewriting, CSP `frame-ancestors` relaxation) never runs. Verified first-hand: requests to `/event/test-slug` and `/embed/test-slug/schedule` produced zero worker-invocation spans locally. Since the QA/visual Playwright suite runs against this config, that logic goes untested and can regress silently. (Correction: locally *no* page carries the production `X-Frame-Options`/CSP headers at all, so the finder's specific "would still carry frame-blocking headers" claim doesn't hold — but the untested-logic defect stands.)
- **Evidence:**
  ```jsonc
  // wrangler.jsonc:10
  "run_worker_first": ["/api/*","/mcp","/parties/*","/event/*","/events/*","/embed/*"]
  // wrangler.local.jsonc:9
  "run_worker_first": ["/api/*","/mcp","/parties/*","/events/*","/__local/*"]
  ```
- **Recommendation:** Align `wrangler.local.jsonc`'s `run_worker_first` with production (add `/event/*`, `/embed/*`) so local dev and the QA suite actually exercise the public-program/embed worker paths.

---

## LOW

### 26. Unauthenticated demo-login endpoint is enabled in production and is not rate-limited
- **Severity:** Low
- **Dimensions:** auth-security
- **File:** `src/server/auth.ts:486` (`auth.post("/demo")`), mounted unconditionally at `src/server/index.ts:230`
- **Description:** `/demo` has no environment gate (contrast the `/__local/smoke` route which gates on `isExplicitLocalEnvironment`) and no rate limit (contrast `/request-link`'s `authorizeRequestLink`), so any anonymous caller can mint an `owner`-role session and run one unbounded `INSERT INTO auth_tokens` per call. The public role-switching is by design for the hackathon demo tenant; the substantive issue is the missing rate limit + unbounded token-table growth on an anonymous endpoint.
- **Evidence:**
  ```ts
  auth.post("/demo", async (c) => {              // no isExplicitLocalEnvironment gate, no abuse.authorize
    const session = await issueBrowserSession(c.env, seed.users[parsed.persona]);
  ```
- **Recommendation:** Add the same rate-limit gate `/request-link` uses (and/or a TTL/cap on demo tokens). If public role-switching must stay, at least bound token issuance per source.

### 27. `SESSION_SECRET` is reused across three distinct trust domains
- **Severity:** Low
- **Dimensions:** auth-security
- **File:** `src/server/services.ts:195` (`sessionSecret`)
- **Description:** One secret is simultaneously (a) the HMAC key deriving every session/API-key/magic-link lookup and rate-limit hash, and (b) the literal `x-session-party-internal` bearer value sent to and compared verbatim by the Scheduler/EventRoom/MailQueue internal routes. A value that should never leave the Worker is transmitted in plaintext headers, widening its exposure surface. (Disclosure of the HMAC key alone does not enable session forgery — validation still requires a matching DB row.)
- **Evidence:**
  ```ts
  headers: { "x-session-party-internal": sessionSecret(env) }, // presented as bearer
  encoder.encode(sessionSecret(env)), { name: "HMAC", ... }    // same value as derivation key
  ```
- **Recommendation:** Split into two secrets — one HMAC derivation key, one internal service token — so the plaintext-transmitted credential is distinct from the key that derives all auth hashes.

### 28. Session cookie omits the `__Host-` prefix and the magic-link token is carried in the URL query
- **Severity:** Low
- **Dimensions:** auth-security
- **File:** `src/server/auth.ts:211` (cookie), :564 (token in URL)
- **Description:** `sp_session` is set with `httpOnly`/`sameSite:Lax`/`secure`/`path:/` but no `__Host-` prefix, and the magic-link verification token is placed in the query string (exposed to logs/history/referrers). Exposure is bounded — the token is single-use, 15-min TTL, consumed atomically, and `returnTo` is same-origin-validated.
- **Evidence:**
  ```ts
  setCookie(c, "sp_session", session, { httpOnly: true, sameSite: "Lax", secure: ..., path: "/" });
  link.searchParams.set("token", token);
  ```
- **Recommendation:** Adopt the `__Host-` cookie prefix (coordinated with the hardcoded read name at auth.ts:201). Optionally deliver the magic-link token via fragment or a one-time exchange to keep it out of server logs/referrers.

### 29. Public submit endpoint lacks input size bounds (body size, answers count, answer-text length)
- **Severity:** Low
- **Dimensions:** injection-input, api-surface _(both flagged; merged — api-surface rated the text-length facet Medium)_
- **File:** `src/server/adapt.ts:148` (no body cap); `src/features/submit/schema.ts:106` (`answers` no `maxItems`); `contracts/types.ts:47` (`AnswerValue` no `maxLength`)
- **Description:** The anonymous submit path reads the body with `c.req.json()` and no size guard (no `bodyLimit` middleware exists anywhere), the `answers` array has no `maxItems` (while sibling `coSpeakers` is `maxItems(10)`), and `AnswerValue` strings have no `maxLength` (while `SpeakerName`/`TurnstileToken`/etc. are bounded) with no cap in `validateValue`. Expensive `sha256(stableStringify(...))` + validation also run *before* the Turnstile/abuse gate. Practical impact is resource amplification bounded by Cloudflare's ~100 MB platform body cap, per-request CPU isolation, and CAPTCHA-per-stored-row — hence Low, not an outage primitive.
- **Evidence:**
  ```ts
  const body = await c.req.json<unknown>().catch(() => null);   // adapt.ts:148 no cap
  answers: Schema.Array(SubmissionAnswer),                       // schema.ts:106 no maxItems
  coSpeakers: ...pipe(Schema.maxItems(10)),                      // sibling IS bounded
  ```
- **Recommendation:** Add `maxItems` to `answers`, `maxLength` to `AnswerValue` strings, a `readBoundedJson`-style body cap on the public submit route (the auth path already caps at 1 KiB), and move the hash/validate work after the abuse gate.

### 30. `show/control`, `show/cue`, and agenda-collaboration `onMessage` branches lack try/catch
- **Severity:** Low
- **Dimensions:** server-correctness
- **File:** `src/server/party/EventRoom.ts:432,445-446`
- **Description:** The operation branch and generic handler branch each wrap execution in try/catch and reply `room/error`, but the `agenda/focus|preview` and `show/control|show/cue` branches call their handlers unguarded. A throw becomes an unhandled rejection out of `onMessage` (partyserver's wrapper uses a bare `return`, not `await`, so its try/catch can't catch it), leaving the client with no reply — and if the throw lands after the `ctx.storage.put` but during `broadcastAuthorized`, state is persisted while the actor gets neither result nor error.
- **Evidence:**
  ```ts
  if (message.t === "show/control") await this.handleShowControl(...);  // no try/catch
  else await this.handleShowCue(...);
  ```
- **Recommendation:** Wrap these branches in the same try/catch → `room/error` pattern the operation/generic branches use, so every handler failure produces a client reply.

### 31. Agenda soft-lock is TOCTOU: two clients can acquire the same talk concurrently
- **Severity:** Low
- **Dimensions:** server-correctness
- **File:** `src/server/party/EventRoom.ts:702`
- **Description:** `handleAgendaCollaboration` scans all connections (each via a D1 `refresh` await → gate open) to detect a conflicting holder, and only writes its own claim via `setState` after the scan completes. Two clients focusing the same talk concurrently can each finish the scan before either has written a claim, and both acquire. Impact is bounded: advisory lock driving ghost-preview UI only; the real `agenda/move` is guarded by `expectedVersion` at the DB layer, so worst case is transient duplicate previews.
- **Evidence:**
  ```ts
  for (const candidate of this.getConnections(...)) { const s = await this.refreshConnectionAuthorization(candidate); ... }
  connection.setState({ ...state, agendaCollaboration: { talkId } }); // claim written after scan
  ```
- **Recommendation:** Write the tentative claim before the scan (then release on conflict), or serialize the acquire with `blockConcurrencyWhile`. Low priority given the advisory-only impact.

### 32. `/poke` reschedule can be clobbered by an in-flight alarm, delaying newly enqueued sync/mail work
- **Severity:** Low
- **Dimensions:** server-correctness
- **File:** `src/server/sync/AirtableSyncLane.ts:97-99,112` (mirror: `Scheduler.ts:187` vs :717)
- **Description:** `/poke` sets the alarm to `now+1` only if the existing alarm is later/unset, but a `/poke` delivered mid-`drainAirtableBase` (gate open on D1 awaits) is overwritten when the running `alarm()` resumes and unconditionally sets `nextAlarmAt` (up to `now+60_000`), delaying the freshly committed row ~60 s. Self-healing (drains next tick); the Scheduler mirror's `finally`-always-`setAlarm` makes the clobber even more reliable.
- **Evidence:**
  ```ts
  if (current === null || current > next) await this.ctx.storage.setAlarm(next); // 97-99 (now+1)
  await this.ctx.storage.setAlarm(result.nextAlarmAt);                           // 112 (up to now+60000)
  ```
- **Recommendation:** After the drain, re-read the alarm and only push it later if nothing newer was requested (`setAlarm(min(existing, nextAlarmAt))`), so a mid-drain poke isn't lost.

### 33. Mail reclaim path never increments `attemptCount`, so an isolate crash mid-send retries unboundedly
- **Severity:** Low
- **Dimensions:** server-correctness
- **File:** `src/server/party/Scheduler.ts:457-477` (reclaim) vs :478-500 (fresh claim)
- **Description:** The fresh claim sets `attemptCount = attemptCount + 1`, but the reclaim branch (expired lease on `claimed`/`dispatching`) re-leases with no increment, and neither the reclaim `WHERE` nor the `dispatching` due-arm bounds `attemptCount < maxAttempts`. A delivery stuck in `dispatching` (isolate lost mid-`sendMail` before the catch runs) is reclaimed and re-sent every alarm with `attemptCount` frozen below max forever. Narrow: ordinary send errors hit the catch → `retry`, whose next cycle is a fresh (incrementing) claim.
- **Evidence:**
  ```ts
  const reclaim = delivery.status === "claimed" || delivery.status === "dispatching";
  reclaim ? db.update(...).set({ status:"dispatching", leaseOwner, leaseExpiresAt })   // no attemptCount
          : db.update(...).set({ status:"claimed", ..., attemptCount: sql`... + 1` }); // increments
  ```
  The repo's own test `reclaims a crash-window send` asserts `attempt_count` unchanged post-reclaim.
- **Recommendation:** Increment `attemptCount` on reclaim too (or bound the reclaim query by `attemptCount < maxAttempts`) so a crash-looping delivery eventually dead-letters instead of re-sending forever.

### 34. Dead compatibility scaffolding for the retired `api.ts`/`tools.ts`/`party.ts` path
- **Severity:** Low
- **Dimensions:** architecture
- **File:** `src/server/registry.gen.ts:60076-60078`; `scripts/gen.ts:346-354`; `src/server/index.ts:243`
- **Description:** `apiRouters`, `tools`, and `partyHandlers` are always emitted empty (`[]`/`[]`/`{}`), and `index.ts:243` loops over the empty `apiRouters`. No slice has a slice-root `tools.ts`/`party.ts`, and the only `api.ts` (publication) is excluded by the `!file.operations` guard — so this compat path can only ever produce empty output. Harmless at runtime; it's the very mechanism that silently swallows #15's un-mounted router.
- **Evidence:**
  ```ts
  export const apiRouters = []; export const tools = []; export const partyHandlers = {};
  for (const router of apiRouters) app.route(API, router); // iterates nothing
  ```
- **Recommendation:** Delete the dead compat detection/emit in gen.ts and the empty-array wiring in index.ts, removing the latent silent-skip trap.

### 35. `AGENTS.md` documents the deprecated slice layout as canonical
- **Severity:** Low
- **Dimensions:** architecture
- **File:** `AGENTS.md:26`
- **Description:** AGENTS.md tells contributors to build slices as `service.ts → thin api.ts (Hono router) + tools.ts + optional party.ts`, but gen.ts's real wiring keys off `operations.ts`; a contributor following the doc verbatim authors exactly the files gen.ts silently ignores when `operations.ts` is present — turning doc drift into un-served endpoints.
- **Evidence:**
  ```
  AGENTS.md:26 — Slice layout: service.ts → thin api.ts (Hono router, default export) + tools.ts + optional party.ts
  ```
- **Recommendation:** Rewrite AGENTS.md to document the `operations.ts` convention as canonical and mark `api.ts`/`tools.ts`/`party.ts` as removed.

### 36. Effect is run outside the single `adapt.ts` boundary in the Worker entrypoint
- **Severity:** Low
- **Dimensions:** architecture
- **File:** `src/server/index.ts:355`
- **Description:** `runAutomatedDueReminderCron` calls `Effect.runPromise(...pipe(Effect.provide(AppLayer(env))))` directly (fire-and-forget via `ctx.waitUntil` in `scheduled()`), bypassing adapt.ts's `Exit`-handling and `logAppError` redacted-logging path — a typed failure rejects the promise instead of being mapped/logged. (Uses `runPromise`, so it doesn't violate PLAN.md rule 5's literal `runPromiseExit` wording, but deviates from the one-runtime-boundary principle.)
- **Evidence:**
  ```ts
  Effect.runPromise(enqueueAutomatedDueTaskReminders(runAt).pipe(Effect.provide(AppLayer(env))));
  ```
- **Recommendation:** Route the cron through the same `runPromiseExit` + `logAppError` boundary as adapt.ts (or extract a shared runner) so scheduled failures are logged/redacted consistently.

### 37. App-wide `MutationObserver` in `RouteCoordinator` re-runs on every DOM mutation in the whole document
- **Severity:** Low
- **Dimensions:** client-ui
- **File:** `src/client/router.tsx:307-310`
- **Description:** `RouteCoordinator` (wrapping every route) observes `document.body` with `{ childList, subtree, characterData }`, and `apply()` runs `querySelector('h1'/'main')` + `document.title` write + four meta/link `setAttribute`s on every mutation anywhere under `<body>`. Since `Toaster` mounts inside 17 route components, toast mount/unmount retriggers the whole `apply()`. (The expensive `heading.focus()` is guarded by a `settled` flag, so the real cost is redundant querySelector/DOM-write churn, not focus-jumps.)
- **Evidence:**
  ```ts
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  ```
- **Recommendation:** Scope the observer to the heading/`main` region, or drive the metadata update off route changes (react-router location) rather than a document-wide mutation observer.

### 38. Talk content history query has no bound on an event-sourced audit log
- **Severity:** Low
- **Dimensions:** performance _(CORRECTED from Medium)_
- **File:** `src/features/agenda/service.ts:496-524` (`listTalkContentHistory`, no `.limit()`)
- **Description:** `listTalkContentHistory` selects every matching `audit_log` row (filtered on `action = 'agenda.talk_content_updated'`) with `orderBy` but no `.limit()`. **Correction:** the finder's aggravating cause is false — inbound Airtable refreshes write `action = "integrations.airtable.refreshed"`, not `"agenda.talk_content_updated"`, so two-way sync does not feed this history; growth is bounded by actual human/API edits to a talk. The missing `.limit()` is still real (a heavily-edited talk or an MCP automation could produce a large response), hence Low rather than refuted.
- **Evidence:**
  ```ts
  // only writer of the filtered action: agenda/service.ts:1628 updateTalkContent -> action:"agenda.talk_content_updated"
  // airtable-engine.ts:671 inbound refresh -> action:"integrations.airtable.refreshed" (different, not matched)
  ```
- **Recommendation:** Add `.limit()`/pagination consistent with `listSubmissions`.

### 39. Mail scheduler alarm processes its batch of deliveries fully sequentially
- **Severity:** Low
- **Dimensions:** performance
- **File:** `src/server/party/Scheduler.ts:442-714`
- **Description:** The `for (const delivery of due)` loop (batch capped at 100) awaits every step — claim/reclaim, attempt lookup, `sendMail`, status/redaction updates — in series, with the alarm re-firing every 60 s. Background job, not a request-latency path, so Low.
- **Evidence:**
  ```ts
  for (const delivery of due) { ... const receipt = await sendMail(this.env, {...}); ... }
  ```
- **Recommendation:** Process the batch with bounded concurrency (e.g. `Promise.all` over small chunks) if delivery volume grows enough to overrun the 60 s window.

### 40. Migration 0017's destructive rebuild of `acceptance_events` has no parity test for pre-existing rows
- **Severity:** Low
- **Dimensions:** testing-ci _(CORRECTED from Medium)_
- **File:** `migrations/0017_add_reusable_speaker_profile_pages.sql:39-61`
- **Description:** No test seeds a legacy `acceptance_events` row before applying 0017 (zero `acceptance_events` matches in `migration-parity.test.ts`). **Correction:** the `embeds` half of the original finding is wrong — a test *does* seed a legacy `embeds` row before 0015–0017 and asserts it survives (`migration-parity.test.ts:378-393`). Both 0017 rebuilds are also schema no-ops (byte-identical to the prior table definitions), which lowers real-world risk, leaving only the narrow risk of a mistyped `INSERT...SELECT` column swap in `acceptance_events` going undetected by an empty-DB run.
- **Evidence:**
  ```
  // 0017 __new_acceptance_events == 0001 acceptance_events (identical); __new_embeds == 0015 __new_embeds (identical)
  // embeds IS covered: migration-parity.test.ts:390-393 asserts legacy embeds row survives 0015-0017
  ```
- **Recommendation:** Add an `acceptance_events` legacy-row parity case mirroring the existing `embeds` one, so a column-mapping regression in the rebuild is caught.

### 41. Third-party GitHub Actions pinned to mutable major-version tags, not commit SHAs
- **Severity:** Low
- **Dimensions:** testing-ci
- **File:** `.github/workflows/ci.yml` (all `uses:`), `visual-regression.yml`, `visual-approval.yml`
- **Description:** Every third-party action (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `actions/github-script@v7`) is pinned to a mutable tag, not a commit SHA — and the `deploy`/`preview` jobs run with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` in scope, so a compromised upstream tag would have production-secret reach. Standard hardening advice, no active compromise.
- **Evidence:**
  ```
  ci.yml:23  - uses: actions/checkout@v4
  ci.yml:242 uses: actions/github-script@v7
  ```
- **Recommendation:** Pin third-party actions to full commit SHAs (with a bot like Dependabot/Renovate to bump them), especially on the secret-bearing deploy jobs.

### 42. Real wall-clock `setTimeout` wait in an integration test
- **Severity:** Low
- **Dimensions:** testing-ci
- **File:** `src/features/submit/submit.test.ts:1134-1147`
- **Description:** The test uses a real, un-mocked ~500–600 ms `setTimeout` to advance D1's SQLite clock past a `closesAt` CHECK constraint (fake JS timers don't affect SQL `now`). Documented, bounded tradeoff — not a defect, but it runs inside the required `test:worker` job and adds real wall-clock time.
- **Evidence:**
  ```ts
  const closesAt = new Date(Date.now() + 500);
  setTimeout(resolve, Math.max(0, closesAt.getTime() - Date.now() + 100)); // real wait
  ```
- **Recommendation:** Acceptable as-is; if suite time matters, seed the row with a `closesAt` already in the past rather than waiting real time.

### 43. `@types/node` major version (26) is ahead of the pinned Node runtime (24)
- **Severity:** Low
- **Dimensions:** deps-config
- **File:** `package.json:6-9,77`
- **Description:** `engines.node` is `>=24.11.0 <25` and all five CI `setup-node` steps pin Node 24, but `devDependencies."@types/node"` is `^26.2.0` (installed `26.2.0`). A typings/runtime skew affecting Node-side scripts only, not the Workers runtime.
- **Evidence:**
  ```
  "node": ">=24.11.0 <25"    "@types/node": "^26.2.0"   (installed 26.2.0)
  ```
- **Recommendation:** Pin `@types/node` to the `24.x` line to match the runtime.

### 44. `compatibility_date` has not moved since the first commit and is ~1 year stale
- **Severity:** Low
- **Dimensions:** deps-config
- **File:** `wrangler.jsonc:5`
- **Description:** `compatibility_date` is `"2025-08-01"` and no commit has touched it since (git history shows a single addition); against the current date (2026-08-12) it's ~12.4 months stale, so the Worker runs on year-old runtime semantics. Not an active bug.
- **Evidence:**
  ```
  $ git log -p --follow -- wrangler.jsonc | grep compatibility_date  -> +  "compatibility_date": "2025-08-01",
  ```
- **Recommendation:** Bump `compatibility_date` to a recent date after reviewing the Cloudflare compatibility-flags changelog, and revisit it on a cadence.

---

## INFO

### 45. Node engine range does not match the runtime the gates were verified on (and CI uses)
- **Severity:** Info
- **Dimensions:** app-health
- **File:** `package.json:6-9`
- **Description:** `engines.node` is `>=24.11.0 <25` and CI pins Node 24, but this audit's gates ran on Node v22.22.2 — pnpm's engine check is advisory (no `engine-strict`/`.npmrc`), so every script printed "Unsupported engine" and proceeded. The gates passed, but not on the declared/CI Node major, so a Node-22-vs-24 behavioral divergence would not have been caught by this run.
- **Evidence:**
  ```
  WARN Unsupported engine: wanted {"node":">=24.11.0 <25"} (current v22.22.2)  // then exit 0
  .github/workflows/ci.yml: node-version: 24 (×5)
  ```
- **Recommendation:** Set `engine-strict=true` (or pin the sandbox/CI image to Node 24.x) so "passing" always means passing on the real target.

### 46. Benign workerd teardown exception printed to stderr during a fully-green test run
- **Severity:** Info
- **Dimensions:** app-health
- **File:** N/A (vitest-pool-workers / workerd isolate teardown, not application code)
- **Description:** `pnpm test:worker` prints `exception = workerd/api/unsafe.c++:215: … Application called abortAllDurableObjects().` to stderr as part of DO isolate-pool disposal, after the pass summary, with the run still exiting 0 (50/50 files, 522/522 tests). Cosmetic; easy to mistake for a real failure when grepping CI logs.
- **Evidence:**
  ```
  Test Files 50 passed (50)   Tests 522 passed (522)
  exception = workerd/api/unsafe.c++:215: … Application called abortAllDurableObjects().
  ```
- **Recommendation:** No functional fix; optionally filter the message in the pool config or note it in CONTRIBUTING so engineers don't chase a false positive.

### 47. `pnpm audit --prod` reports no known vulnerabilities (positive finding)
- **Severity:** Info
- **Dimensions:** deps-config
- **File:** `package.json` / `pnpm-lock.yaml`
- **Description:** Re-running `pnpm audit --prod` reports "No known vulnerabilities found." There is no `audit` step in CI, so this is a point-in-time snapshot, not a continuously-enforced gate.
- **Evidence:**
  ```
  $ pnpm audit --prod  ->  No known vulnerabilities found
  $ grep -n "audit" .github/workflows/ci.yml  ->  (no output)
  ```
- **Recommendation:** Optionally add a non-blocking `pnpm audit --prod` step (or Dependabot alerts) to catch future advisories.

---

## Refuted / not reproduced

_Checked during verification and dropped from the findings above:_

- **EventRoom `/broadcast` gate uses a non-constant-time secret comparison** (auth-security, was INFO) — REFUTED. The `POST /broadcast` handler is not internet-reachable: external traffic arrives via `routePartykitRequest` with pathname `/parties/event-room/<name>...`, which fails the `url.pathname !== "/broadcast"` guard (EventRoom.ts:541) and 404s before the secret comparison at :551. Only internal Worker callers fetching the hardcoded `https://event-room/broadcast` reach the compare, so the variable-time `!==` is not a remotely observable timing oracle.

## Corrections applied (finding was kept, but a claim was fixed)

- **#25** (`run_worker_first` divergence): locally *no* page carries the production `X-Frame-Options`/CSP headers, so the "would still carry frame-blocking headers" claim was dropped; the untested-worker-logic defect stands.
- **#38** (talk content history unbounded): the "two-way Airtable sync feeds this table" growth mechanism is false (different audit action); downgraded Medium→Low, defect retained.
- **#40** (0017 parity test): the `embeds` half is already covered by an existing test and both rebuilds are schema no-ops; scoped down to `acceptance_events` only, downgraded Medium→Low.
- **#29** (unbounded submit input): `category` is organizer-constrained, not attacker free-text (the `title` and `comment` vectors remain); DoS severity downgraded to Low given Cloudflare platform caps + Turnstile-per-row.
