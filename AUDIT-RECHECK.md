# session-party — Audit RE-CHECK Consolidated Status

> Companion to **[`AUDIT.md`](AUDIT.md)** (the original 47-finding report). Finding numbers below refer to that file.

_Re-verification of the 47-finding audit against latest `main` (commit `325f203`), baseline `b4aaec5`. Eleven per-dimension re-verifiers each re-inspected their findings on current source and re-ran the live gates. This report consolidates their verdicts. No verdict has been upgraded past what a re-verifier reported._

---

## Executive Summary

**Both CRITICALs are resolved; only 2 of the 9 HIGHs are.** The maintainer's ~14–21 follow-up commits were a focused **security + data-integrity + client-correctness pass**, not a broad remediation. The two CRITICAL items (destructive migration 0011, preview Workers pointed at production storage) were both fixed thoroughly and verifiably. Among the HIGHs, the two data/client-correctness items (the migration-parity masking test #3, the agenda optimistic-concurrency defeat #4) were fixed well — but all **five performance HIGHs (#5–#9)** and **both CI-gate HIGHs (#10, #11)** remain untouched. The entire performance dimension (10 findings) and the entire testing-ci dimension (7 findings) received zero fixes. Architecture (5) and realtime/sync server-correctness (6) were likewise not touched at all.

### Count table (47 findings)

| New status | Count |
|---|---|
| FIXED | 11 |
| PARTIAL | 0 |
| OPEN | 36 |
| RESOLVED-EARLIER | 0 |
| OBSOLETE | 0 |
| **Total** | **47** |

No re-verifier issued a PARTIAL verdict; the three FIXED items with fix-quality caveats (#1, #3, #18, #29 nuances below) were each still assessed as genuinely FIXED, not partial. Nothing was found already-fixed-before-the-window or made obsolete.

### Did the maintainer resolve the 2 CRITICALs and 9 HIGHs?

- **CRITICALs — YES (2/2).** #1 (migration 0011 cascade) and #2 (preview prod bindings + cron) both FIXED, both with machine-checked regression guards added.
- **HIGHs — PARTIALLY (2/7... i.e. 2 of 9).** FIXED: #3, #4. **OPEN: #5, #6, #7, #8, #9 (all performance), #10, #11 (CI gates).** The seven open HIGHs are the ones with no active in-request-path exploit — realtime N+1s, unpaginated scans, no bundle splitting, no HTTP caching, and unguarded CI security/authorization suites — but they are real and unaddressed.

### Live-gate outcome (app-health re-run on `325f203`)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm check:types` (`tsc -b`) | **PASS** — exit 0, 0 diagnostics |
| Registry drift | `pnpm check:registry` (`pnpm gen --check`) | **PASS** — exit 0, no drift |
| Worker tests | `pnpm test:worker` (vitest/workerd) | **PASS** — exit 0, **53/53 files, 550/550 tests** (up from 50/50, 522/522 at baseline) |

**The migration-parity review test now passes AND actually exercises the destructive replay in the full suite.** This is the headline gate result: the case at `migration-parity.test.ts:607` ("backfills legacy assets and review rounds while preserving assignment recusal history") was moved onto its own dedicated D1 binding `REVIEW_MIGRATION_DB`, so `applyOneByOne(db, migrations.slice(11))` genuinely re-runs 0011 against the freshly-seeded fixture instead of no-opping on shared `d1_migrations` bookkeeping (the exact #3 masking defect). The data-layer re-verifier adversarially re-inserted the old destructive 0011 and confirmed the isolated test then fails — so the CI gate now has real teeth against the #1 regression class. Migration 0011 itself was also rewritten from create-copy-`DROP TABLE`-rename to three additive `ALTER TABLE ... ADD COLUMN` statements, eliminating the cascade hazard entirely rather than merely guarding it. Gates were re-run on Node v22.22.2 (sandbox), while CI/`engines` require Node 24 — see #45 (unchanged, Info).

### One newly introduced issue

The performance re-verifier flagged **one NEW regression (Medium)**: commit `6d44a74` (#149) added `syncReusableProfileSnapshots`, a sequential per-speaker DB **write** pass now embedded in the organizer speaker-directory **read** path. Detail in the "Newly introduced issues" section.

---

## Status table — all 47 findings

Sorted by original severity (Critical → Info), then finding number.

| # | Short title | Orig. sev | New status |
|---|---|---|---|
| 1 | Migration 0011 drops `review_rounds` w/ FK on — cascades review data | Critical | **FIXED** |
| 2 | Preview Workers get prod D1+R2 + live per-minute cron | Critical | **FIXED** |
| 3 | `migration-parity.test.ts` shared binding masks #1 | High | **FIXED** |
| 4 | Agenda editor `expectedVersion` auto-advances, defeats OCC | High | **FIXED** |
| 5 | EventRoom broadcasts re-run sequential D1 auth per client | High | OPEN |
| 6 | Public speaker gallery: sequential uncached R2 + base64 inline | High | OPEN |
| 7 | Client ships as one ~1.45 MB bundle — no code-splitting | High | OPEN |
| 8 | Public program/speaker JSON APIs set no HTTP caching | High | OPEN |
| 9 | Comms delivery/audience endpoints: unbounded full-table scans | High | OPEN |
| 10 | Playwright QA (auth/role/security) suite never runs in CI | High | OPEN |
| 11 | `test:audit-browser` not gated; 2 of 8 specs never run anywhere | High | OPEN |
| 12 | CSV formula injection in review-results export | Medium | **FIXED** |
| 13 | Show-state lost update: D1 await opens DO input gate | Medium | OPEN |
| 14 | `broadcastAuthorized` raw `send` drops delivery on mid-loop close | Medium | OPEN |
| 15 | `publication/api.ts` un-mounted; leaks Hono into client bundle | Medium | OPEN |
| 16 | Command infra (`sha256`/`stableStringify`) copy-implemented per slice | Medium | OPEN |
| 17 | Airtable dead-letter writes unbatched — double-fault wedges row | Medium | OPEN |
| 18 | AI review-suggestion endpoint: no idempotency/rate limit | Medium | **FIXED** |
| 19 | Live show "Current session" selector stale on reset | Medium | **FIXED** |
| 20 | Airtable sync re-scans every entity every drain tick | Medium | OPEN |
| 21 | Airtable outbox claim loop: per-row SELECT+UPDATE, no batch | Medium | OPEN |
| 22 | Airtable refresh: several sequential DB queries per record | Medium | OPEN |
| 23 | `test:storybook` not in required CI gate | Medium | OPEN |
| 24 | Submitter account handoff UI shipped with no interactive test | Medium | OPEN |
| 25 | `run_worker_first` divergence — embed/event routes unserved locally | Medium | **FIXED** |
| 26 | Unauthenticated demo-login not rate-limited | Low | **FIXED** |
| 27 | `SESSION_SECRET` reused across three trust domains | Low | OPEN |
| 28 | Session cookie no `__Host-` prefix; magic-link token in URL | Low | OPEN |
| 29 | Public submit lacks input size bounds | Low | **FIXED** |
| 30 | `show/control`/`show/cue`/agenda `onMessage` lack try/catch | Low | OPEN |
| 31 | Agenda soft-lock TOCTOU: two clients acquire same talk | Low | OPEN |
| 32 | `/poke` reschedule clobbered by in-flight alarm | Low | OPEN |
| 33 | Mail reclaim never increments `attemptCount` — unbounded retry | Low | OPEN |
| 34 | Dead compat scaffolding for retired `api.ts`/`tools.ts`/`party.ts` | Low | OPEN |
| 35 | `AGENTS.md` documents deprecated slice layout as canonical | Low | OPEN |
| 36 | Effect run outside `adapt.ts` boundary in cron entrypoint | Low | OPEN |
| 37 | App-wide `MutationObserver` in `RouteCoordinator` | Low | OPEN |
| 38 | Talk content history query unbounded (no `.limit()`) | Low | OPEN |
| 39 | Mail scheduler alarm processes batch fully sequentially | Low | OPEN |
| 40 | Migration 0017 `acceptance_events` rebuild has no parity test | Low | OPEN |
| 41 | Third-party GitHub Actions pinned to mutable tags, not SHAs | Low | OPEN |
| 42 | Real wall-clock `setTimeout` wait in an integration test | Low | OPEN |
| 43 | `@types/node` (26) ahead of pinned Node runtime (24) | Low | OPEN |
| 44 | `compatibility_date` ~1 year stale | Low | **FIXED** |
| 45 | Node engine range ≠ runtime gates verified on | Info | OPEN |
| 46 | Benign workerd teardown exception on green test run | Info | OPEN |
| 47 | `pnpm audit --prod` clean (positive) — no CI audit gate added | Info | OPEN |

---

## Still open / partial — actionable detail

_No finding was rated PARTIAL. The 36 items below are all OPEN. Grouped by dimension for actionability; each was confirmed unchanged (most byte-identical to baseline) by its re-verifier on `325f203`._

### Performance (all 10 OPEN — dimension received zero fixes)

- **#5 (High) — EventRoom sequential D1 auth per broadcast.** `src/server/party/EventRoom.ts:895-911` (`broadcastAuthorized`), `:913-939`, `:940-958`; `refreshConnectionAuthorization` :641-666 → `revalidateAuthorization` :581-639 still issues a fresh `db.select()` join every call, awaited in a plain `for` loop. **To do:** cache per-connection auth on connection state with a short TTL (invalidate on membership change) and/or `Promise.all` the revalidation. `EventRoom.ts` is byte-identical to baseline.
- **#6 (High) — Public speaker gallery sequential uncached R2 + base64 inline.** `src/features/portal/service.ts:4307-4346` — `Effect.forEach(snapshot.speakers, …)` with no `{ concurrency }`, per-speaker R2 `get` + `btoa` inline into JSON. **To do:** serve cacheable R2/CDN URLs instead of inlining, or at minimum add `{ concurrency }` + caching (#8).
- **#7 (High) — Single ~1.45 MB (425 KB gzip) bundle.** `src/client/route-discovery.ts:10-22` still `import.meta.glob([...], { eager: true })`; `vite.config.ts` has no `manualChunks`; no `React.lazy`. (One diff to the file, commit `91c76e8`, only excludes `*.stories.tsx` — not a splitting change.) **To do:** lazy route discovery (`eager:false` + `React.lazy`/`Suspense`) and/or `manualChunks`.
- **#8 (High) — Public JSON APIs set no HTTP caching.** `src/server/adapt.ts:233-234` still returns bare `c.json(...)`/`c.body(null,204)`; `feed-api.ts:77` remains the sole `Cache-Control` site. (adapt.ts changed in `01a7c1a` but only for the submit body-cap.) **To do:** add `Cache-Control`/`ETag` to public read ops; directly relieves #5–#7 on public pages.
- **#9 (High) — Comms delivery/audience unbounded scans.** `src/features/comms/schema.ts:184` `ListDeliveriesInput = Struct({ eventId })` (no pagination); `service.ts:1158-1216` join ends in `.orderBy(...)` with no `.limit()`, plus a second unlimited attempts query; `loadAudience` scans all accepted/rejected submissions. No commits to comms. **To do:** add `PaginationInput` + `.limit()`/keyset to both.
- **#20 (Medium) — Airtable full-entity re-scan every tick.** `airtable-engine.ts:313` (`enqueueOneMissingProjection`), `:1269-1291` (`drainAirtableBase`, unconditional call `:1277`); nested `entityTypes × entityIds`, re-runs ~4×/sec while draining. **To do:** projection cursor/watermark/dirty-set.
- **#21 (Medium) — Outbox claim loop per-row SELECT+UPDATE.** `airtable-engine.ts:792-843` — ~60 sequential round-trips per claim cycle. **To do:** collapse earlier-revision check into one grouped query; `db.batch([...])` the claim updates.
- **#22 (Medium) — Refresh page: sequential queries per record.** `airtable-engine.ts:1045-1178`, loop `:1085` — 5–10+ round-trips per record, no cross-record parallelism. **To do:** batch per-record lookups/projections; bounded concurrency.
- **#38 (Low) — Talk content history unbounded.** `src/features/agenda/service.ts:742-770` — `.orderBy(...)` with no `.limit()`. (agenda/service.ts changed but not this fn.) **To do:** add `.limit()`/pagination consistent with `listSubmissions`.
- **#39 (Low) — Mail scheduler alarm fully sequential.** `src/server/party/Scheduler.ts:445-493` query + `:495` loop; batch of ≤100 awaited in series. (Scheduler.ts changed in `01a7c1a` only to add demo rate-limiting elsewhere.) **To do:** bounded concurrency if volume grows.

### Realtime / sync server-correctness (all 6 OPEN — `EventRoom.ts` byte-identical to baseline)

- **#13 (Medium) — Show-state lost update via open input gate.** `EventRoom.ts:744` read → `:751` D1 `isCurrentEventTalk` await (gate open) → `:833` unconditional `put`, no revision CAS. Two `show/control` frames both read `revision=N`, both write `N+1`. **To do:** `blockConcurrencyWhile`, or move D1 validation before the read-modify-write, or add revision CAS on the put.
- **#14 (Medium) — `broadcastAuthorized` raw `send` truncates fan-out.** `EventRoom.ts:905` refresh await → `:909` bare `connection.send(encoded)`; a synchronous throw on a peer-closed socket aborts the loop so every later recipient misses the frame. Guarded `sendServerMessage` (:324-333) exists and is used by the sibling fan-outs. **To do:** route `broadcastAuthorized` through `sendServerMessage`.
- **#30 (Low) — Unguarded `onMessage` branches.** `EventRoom.ts:432` (`agenda/focus|preview`) and `:445-446` (`show/control|show/cue`) call handlers with no try/catch → unhandled rejection, no client reply; if it throws after `:833 put` during broadcast, state persists with no ack. **To do:** wrap in the same try/catch → `room/error` the operation branch uses.
- **#31 (Low) — Agenda soft-lock TOCTOU.** `EventRoom.ts:702-704` scan (awaits, gate open) → `:714-720` claim written only after loop; two clients can both acquire. Advisory-only impact (real `agenda/move` still `expectedVersion`-guarded). **To do:** write tentative claim before scan (release on conflict), or `blockConcurrencyWhile`.
- **#32 (Low) — `/poke` reschedule clobbered.** `AirtableSyncLane.ts:97-99` (`now+1` if sooner) vs `:112` unconditional `setAlarm(result.nextAlarmAt)` up to `now+60000`; Scheduler mirror worse (`Scheduler.ts:191` unconditional `now+1` vs `:768-771` `finally` always `now+INTERVAL_MS`). Self-heals next tick. **To do:** after drain, `setAlarm(min(existing, nextAlarmAt))`.
- **#33 (Low) — Mail reclaim never increments `attemptCount`.** `Scheduler.ts:509` reclaim → `:513-517` set `dispatching` with no `attemptCount`; WHERE `:518-526` and due-query dispatching arm `:481-484` omit `lt(attemptCount, maxAttempts)`. A `dispatching` isolate-crash re-sends forever, never dead-letters. **To do:** increment on reclaim, or bound the reclaim query by `attemptCount < maxAttempts`.

### Architecture (all 5 OPEN — dimension untouched)

- **#15 (Medium) — `publication/api.ts` un-mounted + Hono leaks to client.** `api.ts:11` `const app = new Hono()` (no routes), `:121` `export default app`; imported by 6 client modules for named helpers, so the un-tree-shakeable Hono app crosses into the browser bundle. gen.ts `!file.operations` guard (`:346`) excludes it → mounts nothing. **To do:** move client-needed constants to a client-safe module; delete the Hono app; drop the `api.ts` convention.
- **#16 (Medium) — Command infra copy-implemented per slice.** `comms/service.ts:115-119` `sha256: Effect.Effect<string>` via `Effect.promise` (rejection → unrecoverable defect) vs 7 siblings' `Effect.tryPromise`→`External`; `stableStringify` `undefined`-key divergence (comms/forms drop, submit serializes `"undefined"`). **To do:** extract one shared module w/ canonical policy + error channel; at minimum fix comms's `Effect.promise`→`Effect.tryPromise`.
- **#34 (Low) — Dead compat scaffolding.** `registry.gen.ts:61073-61075` emits `apiRouters=[]`/`tools=[]`/`partyHandlers={}`; `index.ts:245` loops the empty array; the very mechanism that silently swallows #15. **To do:** delete the dead detection/emit in gen.ts and the empty wiring in index.ts.
- **#35 (Low) — `AGENTS.md` documents deprecated layout.** `AGENTS.md:26` still prescribes `api.ts`/`tools.ts`/`party.ts` — the files gen.ts ignores when `operations.ts` is present. **To do:** rewrite to document the `operations.ts` convention as canonical.
- **#36 (Low) — Effect run outside `adapt.ts` boundary.** `src/server/index.ts:360-361` `runAutomatedDueReminderCron` = bare `Effect.runPromise(...)`, bypassing `runPromiseExit`+`logAppError`; typed failure rejects silently. Commit `2749f36` raised this cron to every-minute, so a silent rejection now recurs per-minute. **To do:** route through the shared `runPromiseExit`+`logAppError` boundary.

### Testing & CI (all 7 OPEN — dimension untouched)

- **#10 (High) — Playwright QA suite not in CI.** `package.json:34` defines `test:qa` but no `.github/workflows/*.yml` references it (grep empty); `security.qa.pw.ts` (8 role sessions) + 7 other `*.qa.pw.ts` never run. **To do:** add a required CI job running `pnpm test:qa` with its `dev:service` webserver.
- **#11 (High) — `test:audit-browser` not gated; 2 specs orphaned.** `ci.yml:197` `needs: [checks, rubric, worker-tests]` — none runs audit-browser; `scripts/rubric/evidence.ts:24-29` references only 6 of 8 `*.browser.tsx`, so `review-lifecycle.browser.tsx` (idempotency-key rotation assertions) and `forms.browser.tsx` never execute anywhere. **To do:** add `test:audit-browser` (full config) to a required job, or add rubric checks for the two orphaned specs.
- **#23 (Medium) — `test:storybook` not in required gate.** `ci.yml:19-36` `checks` runs `storybook:build` (static) only; actual story execution (`visual:stories:capture`) lives in `visual-regression.yml:52`, not in the gate's `needs`. No ruleset file in repo. **To do:** add `test:storybook` to a required job or add the `storybook` job to `needs`.
- **#24 (Medium) — Submitter account handoff untested.** `public-submit.tsx:476` `handleAccountRequest` (try/catch → `setAccountError`/`setAccountRequested`) has no interactive test; `submit.test.tsx` uses `renderToStaticMarkup` (no DOM/events), the one behavioral test (`:297-311`) calls `requestSubmitterAccount(...)` directly, bypassing the button. **To do:** add a Testing-Library/browser test clicking the button asserting success + fetch-failure branches.
- **#40 (Low) — Migration 0017 `acceptance_events` no parity test.** `grep acceptance_events migration-parity.test.ts` → zero; `0017_...sql:32-55` rebuild still untested. (Note: the adjacent 0011/#1/#3 work was fixed — see Fixed section — but did not add this case.) **To do:** add a legacy-`acceptance_events`-row parity case mirroring the existing `embeds` one.
- **#41 (Low) — Actions pinned to mutable tags.** Every `uses:` across all 4 workflows is `@v4`/`@v7`; `deploy`/`preview` jobs run with `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` in scope. **To do:** pin to full commit SHAs (with Dependabot/Renovate).
- **#42 (Low) — Real wall-clock `setTimeout` in a test.** `submit.test.ts:1163-1176` — ~500–600 ms real wait inside required `test:worker`. Per the original finding this is an acceptable documented tradeoff; unchanged. **To do (optional):** seed `closesAt` already in the past.

### Auth & security (2 OPEN)

- **#27 (Low) — `SESSION_SECRET` reused across 3 trust domains.** `services.ts:209` HMAC derivation key AND `:175` plaintext `x-session-party-internal` bearer (21 header sites). `SecretBindings` (`:136-143`) still lists only `SESSION_SECRET`; no commits to services.ts. **To do:** split into an HMAC key and a separate internal service token.
- **#28 (Low) — No `__Host-` cookie prefix; magic-link token in URL.** `auth.ts:274` `sp_session` (no prefix); `:650` `link.searchParams.set("token", token)`; `:714` read from query. **To do:** adopt `__Host-` prefix (coordinate with the hardcoded read name); optionally deliver the token via fragment/one-time exchange.

### Deps & config (1 OPEN + 1 positive/Info OPEN)

- **#43 (Low) — `@types/node` (26) ahead of Node (24).** `package.json:7` `">=24.11.0 <25"` vs `:77` `"@types/node": "^26.2.0"`. No version-changing commits. **To do:** pin `@types/node` to the `24.x` line.
- **#47 (Info, positive) — no CI audit gate.** `pnpm audit --prod` still clean; `pnpm-lock.yaml` unchanged since baseline. OPEN only because the optional non-blocking `pnpm audit`/Dependabot step was not added. Nothing broken.

### Client-UI (1 OPEN)

- **#37 (Low) — App-wide `MutationObserver`.** `src/client/router.tsx:308-309` observes `document.body` `{childList,subtree,characterData}`; `apply()` re-runs `querySelector('h1'/'main')` + title/meta writes on every mutation (e.g. any nested `Toaster` mount). `router.tsx` untouched. **To do:** scope the observer to the heading/`main` region, or drive metadata off route changes.

### App-health (2 OPEN, Info — environment observations, no fix expected)

- **#45 (Info) — Node engine range ≠ verification runtime.** `package.json:6-9` `>=24.11.0 <25`; CI pins Node 24 (`ci.yml:29,53,75,299,406`); gates re-ran on Node v22.22.2 with advisory "Unsupported engine" warnings. No `.npmrc`/`engine-strict` added. **To do (optional):** `engine-strict=true` or pin sandbox/CI to Node 24.x.
- **#46 (Info) — Benign workerd teardown exception.** `abortAllDurableObjects()` still prints to stderr on a green run (53/53 files, 550/550 tests, exit 0). Cosmetic. **To do (optional):** filter in pool config or note in CONTRIBUTING.

---

## Newly introduced issues (regressions from the fixes)

**One NEW finding** was flagged across all eleven re-verifiers (all other dimensions explicitly reported "None").

### NEW-1 (Medium) — Speaker-directory read path now runs a sequential per-speaker DB write pass on every organizer page load
- **Dimension:** performance
- **File:** `src/features/portal/service.ts:856-957` (`syncReusableProfileSnapshots`), called from `:1090` (`getSpeakerDirectory`) and `:1912` (`getPortalSnapshot`)
- **Introduced by:** commit `6d44a74` ("fix(portal): sync reusable profile snapshots (#149)") — a fix for a *data-consistency* problem (keeping event-owned speaker records in sync with reusable cross-event profiles), not a security finding from this audit.
- **Evidence:**
  ```ts
  // service.ts:884-957 — inside syncReusableProfileSnapshots
  yield* Effect.forEach(candidates, ({ speaker, profile }) => Effect.gen(function* () {
    yield* database(() => db.batch([
      db.insert(domainChanges).select(...),   // version claim
      db.insert(domainChanges).select(...),   // profile-synced change
      db.insert(auditLog).select(...),
      db.update(speakers).set(values).where(guard).returning({ id: speakers.id }),
    ]));
  }), { concurrency: 1, discard: true });      // fully sequential, one 4-statement batch per candidate
  // service.ts:1090 — getSpeakerDirectory calls it UNSCOPED for the whole event
  yield* syncReusableProfileSnapshots(input.eventId);
  ```
- **Why it's a problem:** `getPortalSnapshot` calls it scoped to one `speakerId` (cheap), but `getSpeakerDirectory` calls it **unscoped for the whole event**, and that read is hit by at least four organizer routes (`organizer-speakers.tsx`, `organizer-speaker-detail.tsx`, `organizer-content.tsx`, `organizer-tasks.tsx`). In steady state `candidates` is empty (2 extra SELECTs per load), but after any event where many speakers' profiles just changed (bulk CSV import, many concurrent profile edits), an organizer's page load blocks on N sequential D1 batch round-trips before the directory renders — a write side effect with no pagination/concurrency bound inside what is used as a plain GET, on routes hit far more often than the read-only endpoints in #5/#6/#9. It also means a directory page load can now fail/time out for a reason unrelated to reading data.
- **Assessment:** the sync logic itself appears correct (guarded by `eq(speakers.version, speaker.version)` optimistic concurrency; candidates pre-filtered so it converges) — but it was not given the concurrency/pagination treatment the audit already asked for on the sibling `getPublicSpeakers` (#6).
- **Recommended fix:** pass `{ concurrency: <n> }` to the `Effect.forEach`, and/or move the full-event sync to a background alarm path (Airtable-drain style) instead of inline on every organizer directory read.

---

## Fixed (11)

**CRITICAL (2/2):**
- **#1 — Migration 0011 cascade.** Rewritten from create-copy-`DROP TABLE`-rename to three additive `ALTER TABLE ... ADD COLUMN` statements (`0011_solid_imperial_guard.sql:34-36`); cascade hazard eliminated entirely. `gen --check` clean, chain applies cleanly. Commit `e80175e`. _Caveat noted by verifier: fix edits 0011 in place rather than shipping a forward-fix migration — any environment that already ran the old destructive 0011 has already lost data and won't re-run it; no such environment is evidenced for this repo._
- **#2 — Preview prod bindings + cron.** Removed `d1_databases`/`r2_buckets` from `env.preview` and set `triggers.crons: []` explicitly (correctly handling wrangler's inheritable-`triggers` trap); added a `jq -e` CI assertion (`ci.yml:324-330`) that fails the build if any reappear, plus a `preview-cleanup.yml` teardown workflow. Commit `e80175e`. _Disclosed side effect (not a new security bug): API-backed preview requests now throw on `env.DB`/`env.FILES` being undefined; at least `fetchPublicProgram` degrades gracefully._

**HIGH (2/7):**
- **#3 — Parity test masking.** Review-rounds case moved to a dedicated `REVIEW_MIGRATION_DB` binding so it genuinely re-runs 0011; strengthened to seed a `reviews` row and assert the new CHECK. Adversarially proven (re-inserting old 0011 makes it fail). Commit `e80175e`. _Caveat: only this one case was isolated; other parity `it()` blocks still share `MIGRATION_DB` — a maintainability nit, not the masking defect._
- **#4 — Agenda editor OCC defeat.** New `editorVersion` state captured only at editor-open, `talkEditorConcurrency()` helper derives `{expectedVersion, stale}`, all five mutation handlers early-return when stale, and a conflict Alert with an explicit "Load latest changes" button is shown. Unit + browser regression tests added. Commit `f22e2c8` (#154).

**MEDIUM (4):**
- **#12 — CSV formula injection.** New `quoteReviewCsvCell` neutralizes leading `= + - @`/tab/CR (including behind leading whitespace) before quoting; all export cells routed through `serializeReviewCsvRows`. Test added, re-run green. Commit `382d146`.
- **#18 — AI suggestion idempotency/rate limit.** Flipped to `idempotency: "required"` with a mandatory `idempotency-key` header; exact-retry replays the stored output instead of re-billing; an atomic `db.batch` inserts a per-submission/per-minute budget row whose unique-index violation → `Conflict` before any billed AI call. Tests pass. Commit `382d146`. _Minor nitpick: fixed (not sliding) 60 s window; does not reopen the unbounded-loop defect._
- **#19 — Live show selector stale on reset.** `showControlTalkSelection(currentTalkId) => currentTalkId ?? ""` now always writes, including the falsy branch; placeholder restored and action buttons disabled on reset. Browser test added. Commit `f22e2c8`.
- **#25 — `run_worker_first` divergence.** `wrangler.local.jsonc` now includes `/event/*` and `/embed/*` (a strict superset of production plus `/__local/*`), so the public-program/embed worker paths execute in local dev and the QA suite. Commit `f22e2c8`.

**LOW (3):**
- **#26 — Demo-login abuse.** `authorizeDemoLogin()` now gates the endpoint (429 on limit, fails **closed**): global 1000/15 min + per-source 30/15 min in a Scheduler-DO transaction; `issueDemoBrowserSession` evicts old sessions to cap each persona at ≤20 live tokens; body read via `readBoundedJson`. Commit `01a7c1a`.
- **#29 — Public submit input bounds.** 256 KiB streaming body cap (defeats a lying content-length) → 413; `answers` `maxItems(100)`; `AnswerValue` `maxLength(20_000)`; the expensive `sha256` deferred behind `Effect.suspend` past the abuse gate. Test drives real HTTP for 413/400 cases. Commit `01a7c1a`. _Nuance: `validateAnswers`/`normalizePublicSpeakers` still run before the abuse gate, but now on schema-bounded input — the amplification vector is closed._
- **#44 — Stale `compatibility_date`.** Bumped `wrangler.jsonc:5` from `2025-08-01` to `2026-08-08` (4 days stale vs today). Commit `d0ba4bb`.
