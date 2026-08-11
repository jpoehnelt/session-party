# Session Party exhaustive QA plan

Target: `https://sessionparty.com/e/ai-engineer-sandbox`

This plan validates every reachable route, interaction, state transition, role boundary, and critical workflow for the AI Engineer Sandbox event. It is both a manual exploratory charter and the specification for automated coverage.

## 1. Quality bar and exit decision

The release passes only when all of the following are true:

- Every route and every rendered interactive control has a recorded result in the control inventory; tested + intentionally blocked + not applicable must equal discovered controls.
- All P0 and P1 workflow cases pass on desktop and mobile; no open Sev 1 or Sev 2 defects remain.
- No role can read or mutate data outside its event, role, or speaker identity.
- Keyboard-only and screen-reader smoke passes complete all P0 workflows; automated accessibility scans have no serious or critical findings.
- No public projection leaks private data, draft agenda state, reviewer evidence, contact data, private assets, audit data, or integration secrets.
- Published data matches the latest immutable publication revision; drafts and warnings never leak publicly.
- Destructive, outbound, or irreversible actions require clear intent, show accurate scope, are auditable, and are verified with sandbox-only recipients/data.
- Core flows meet the performance and resilience budgets in section 12.
- All defects include evidence, environment, role, fixture IDs, exact reproduction steps, expected/actual result, severity, and cleanup state.

Severity:

- **Sev 1 / stop-ship:** cross-tenant or private-data exposure, auth bypass, unrecoverable corruption, unintended external email, published wrong/private program, core workflow unavailable.
- **Sev 2 / release blocker:** P0 workflow cannot complete, incorrect acceptance/readiness/agenda state, inaccessible P0 flow, silent loss/duplication, unsafe upload/embed.
- **Sev 3:** material UX, IA, visual, responsive, error-recovery, or non-core functional defect with a workaround.
- **Sev 4:** polish, minor copy, low-impact consistency, or edge-case issue.

## 2. Safe environment, personas, and fixtures

Run write-path tests only in the named sandbox event. Snapshot the event before execution and record all created IDs. Use timestamped names prefixed `QA-<run-id>-`; remove or archive them after evidence capture.

Personas:

1. Signed-out visitor.
2. Owner (all event and membership controls).
3. Admin (organizer operations without owner-only escalation).
4. Reviewer: assigned, unassigned, and recused variants.
5. Accepted primary speaker with incomplete onboarding.
6. Accepted speaker with complete onboarding and confirmed agenda.
7. CFP submitter with a draft and submitted proposal.
8. Valid event-scoped API key for each preset plus expired and revoked keys.
9. User authenticated to another event but not this event.
10. Public visitor on phone, tablet, and desktop.

Data fixtures must include empty, one-item, and high-volume states; Unicode and long text; duplicate normalized email; DST boundary dates; unplaced/TBD and conflicting talks; co-speakers; hidden/public speakers; all submission statuses; every task kind; allowed and forbidden upload types; allowed and forbidden embed hosts; retry/dead-letter delivery; fixture/live/unavailable integrations; zero/one/many publication revisions.

Outbound safety:

- Use only sink addresses owned by the QA team and provider sandbox/fake adapters.
- Verify exact recipient count, template version, reply-to, send time, rendered HTML/text, ICS bytes, and correlation ID before queueing.
- Publishing, imports, member removal, role changes, key revocation, resource/task deletion, acceptance reversal, and automated mail require a recorded pre-action snapshot and cleanup/recovery check.
- Never enter production secrets into the UI; verify that secret fields are absent and responses/logs are redacted.

## 3. Control-inventory protocol: proving every interaction was tested

For each route, enumerate at every breakpoint and role:

- Links, buttons, menu items, tabs, accordions, disclosure widgets, dialogs, drawers, sortable/draggable items, table rows, pagination, filters, search, checkboxes/radios/switches, selects, date/time/color controls, file inputs, text fields, textareas, copy/download actions, and keyboard shortcuts.
- Conditional controls in loading, empty, error, partial-data, permission-denied, selected, dirty, saving, success, stale-version, offline, and retry states.
- Browser-native behavior: Back/Forward, reload, deep link, open in new tab, URL query state, focus restoration, unsaved edits, clipboard, downloads, print where relevant.

Create one inventory row per control instance/type with: `ID`, route, role, viewport, accessible name, initial state, action, expected UI result, expected API/domain change, persistence after reload, audit/realtime effect, negative cases, evidence, cleanup, result, defect.

For every actionable control execute:

1. Pointer activation.
2. Keyboard activation (Tab/Shift+Tab plus Enter or Space as appropriate).
3. Disabled/permission state.
4. Happy path.
5. Validation boundary and server rejection.
6. Double activation/race/idempotency.
7. Cancel/close/Escape/outside-click where applicable.
8. Reload/back-forward persistence.
9. Concurrent stale-version behavior from two sessions where it mutates data.
10. Screen-reader name, role, state, live feedback, and focus destination.

The final reconciliation compares runtime-discovered controls, source route/control inventory, and completed test IDs. Any unmatched item blocks sign-off.

## 4. Global shell, authentication, navigation, and IA

### Global shell

- Skip link is first focusable element, becomes visible on focus, moves focus to `main`, and works after client navigation.
- Desktop sidebar and mobile Menu/Sheet contain the same routes in the same logical order; current page is announced; mobile drawer traps focus, closes by button/Escape/navigation, and restores focus to Menu.
- Brand, All events, each event-nav item, Sign in/Log out, and browser Back/Forward navigate correctly without stale data or focus loss.
- Route change updates H1, document title, canonical URL, Open Graph title/URL, and focus once; loading states do not leave an incorrect final title.
- Deep links, query parameters, trailing slash, malformed event slug, nonexistent resource, and unknown route produce truthful, recoverable states.
- Long event names, translated/Unicode content, 200% zoom, text-only zoom, reduced motion, high contrast, dark OS preference, narrow and ultrawide layouts do not obscure actions.

### Authentication/session

- Each demo-persona button, magic-link request field/button, required/invalid email, duplicate request, generic success response, throttling, expired/replayed token, and return-to redirect.
- Session-check loading, signed-out, signed-in, expiry mid-action, logout, multiple tabs, revoked membership, cookie/security attributes, CSRF posture, and no open redirect through `returnTo`.
- Auth failures never reveal account existence, raw token, stack, key, or cross-event identifiers.

### Information architecture and content

- Validate organizer mental model and sequence: Overview → Forms → Submissions → Review → Onboarding → Speakers → Tasks/Resources → Agenda → Communications → Publication → Exports/Integrations → Settings.
- Run five first-click tasks with non-technical production staff: open CFP, accept a proposal, find one blocked speaker, place/publish a talk, send a schedule confirmation. Record first click, completion, hesitation, backtracks, terminology confusion, and confidence.
- Verify labels distinguish Onboarding vs Speakers vs Tasks, Agenda vs Publication, Communications vs logged contact, and Exports vs Integrations.
- Check all headings, helper text, statuses, dates, counts, pluralization, terminology, empty/error copy, destructive warnings, and success toasts for clarity and consistency.

## 5. Organizer route-by-route functional and UX matrix

### Overview `/e/ai-engineer-sandbox`

- Verify proposal, accepted, scheduled, conflict, pipeline, placement, and publication counts against source lists/API; test zero and large values.
- Pipeline graphic has equivalent accessible text and does not rely on color alone.
- Review and Agenda links land correctly and focus page headings.
- Production brief formats date/timezone/location/status consistently and handles missing values.
- Test loading, partial metric failure, complete failure/retry, stale response, and membership loss.

### Forms `/forms`

- Create primary CFP and additional form; cancel additional-form flow; duplicate/invalid names and primary-form uniqueness.
- Select every form; add every field type; edit labels/help/required/options/semantic key/routing; add/remove/reorder fields and options at first/middle/last boundaries.
- Enforce unique semantic roles and exactly one title/abstract for primary CFP publication; legacy null semantics remain explicit.
- Preview every field with valid/invalid/empty/long/Unicode values and conditional routing branches.
- Save draft, reload persistence, concurrent stale save, publish immutable version, close/reopen, republish, delete draft cancel/confirm, and prohibit deleting published/history-bearing forms.
- Public link/submit affordances target the correct version; existing submissions retain historical labels and answers.

### Submissions `/submissions`

- Exercise state/form/category filters singly and in every meaningful combination; clearing, empty results, pagination boundaries, reload, and query/state preservation.
- Verify ordering, page counts, row metadata, long text truncation, status badges, unrouted category, and exact link into selected review item.
- Test all statuses and role restrictions; speaker/private fields never appear in list payload/UI.
- Loading/error/retry, rapid filter changes, no duplicate/missing rows across pages, and live changes while paginating.

### Review `/review`

- Round creation/edit; each criterion type; add/remove/reorder criterion/options; invalid configurations; draft → active → closed transitions and forbidden transitions.
- Search/status/category/assignment filters, select all/clear reviewers, bulk assign, reminders preview/cancel/confirm, CSV export contents/escaping/filename.
- Open every proposal row; next/previous if present; rubric scores at min/max and invalid values; rationale; save/overwrite/history; committee comment empty/long/Unicode and append-only behavior.
- Assign/reassign, recuse with reason, replacement after recusal, unassigned review, reviewer progress, and concurrent reviews.
- AI suggestion request, loading/failure/quota, labeling, input minimization, no automatic human score/status transition, and explicit human confirmation.
- Accept, reject, waitlist where exposed, revoke acceptance, repeat/idempotent actions, stale decision conflict, created speaker/talk/onboarding effects, and audit evidence.
- Reviewer sees allowed event proposals/comments but no speaker contact/private profile; speaker never sees reviewer identity/scores/comments; cross-event deep links fail closed.

### Onboarding `/dashboard`

- Reconcile speaker/ready/needs-attention/overdue counts with definitions and speaker/task records.
- Toggle “needs attention only”; verify row count, state, checklist progress, blocker priority, recommendation, due date, and last-contact evidence.
- For every Log contact button: open, accessible association to speaker, validate channel/summary/time, Save, Cancel, double-save/idempotency, reload persistence, immutable history, and no implication that opening an email draft logged contact.
- Test zero tasks, no due dates, overdue across timezone/DST, multiple blockers, completed speaker, newly accepted speaker, revoked acceptance, and high-volume matrix usability.
- Table remains usable on mobile via reflow/scroll with headers available to assistive technology.

### Speakers `/speakers`

- Add speaker validation, duplicate email/identity/linkage, optional fields, cancel/reset, and created-state persistence.
- Search by every advertised dimension; status/category filters; empty results; pagination; select row/page, clear, selection persistence across filters/pages.
- Open/close row details; edit each field; invalid/long values; save; stale version; restore after error.
- Provision portal idempotently; verify correct identity and no parallel account.
- Send invites and remind outstanding: disabled with no selection, exact audience preview, cancel/confirm, sandbox delivery, repeat safety, history/audit.
- Public visibility and talk/submission links update downstream projections only after publication where required.

### Tasks `/tasks`

- Create/edit/delete/cancel for profile, upload, form, link, and confirm task kinds.
- Required name/order, number boundaries/duplicates, due date/timezone, optional description, form ID required only for form tasks, missing/deleted/wrong-event form.
- Reordering and duplicate order semantics, speaker readiness recalculation, existing completions, deadline changes, concurrent edits, delete impact, and audit.
- Destructive dialog focus, wording, cancel, confirm, pending/disabled state, and retry.

### Resources `/resources`

- Create/edit/delete/cancel resource; title/slug/order/audience/body/embed URL validation; slug uniqueness and normalization.
- Speaker-only vs public visibility; ordering; Markdown/rich-content safety if supported; link handling.
- Allow only documented HTTPS embed providers; reject HTTP, lookalike/subdomain tricks, redirects, script/data/javascript URLs, raw active HTML, and same-origin injection. Verify iframe sandbox/referrer/allow attributes.
- Deleting or changing a viewed resource updates portal safely; no unauthorized cache exposure.

### Agenda `/agenda`

- Create/edit tracks, rooms, and talks; cancel; required/optional/TBD fields; duration/date boundaries; timezone/DST; accepted submission linkage and standalone talks.
- Drag/drop and keyboard equivalent for unplaced ↔ slot, same/different track/day, reorder, invalid drop, auto-scroll, cancel/escape, and rapid/concurrent drags.
- Drafts allow incomplete/TBD and named conflict warnings; verify speaker/room/track/time/overlap conflicts, warning accuracy, no silent mutation, and resolution.
- Setup controls, show-control open/close, ready/run/hold/complete transitions, timer anchors, reconnect/hibernation recovery, two controllers, permissions, and canonical agenda non-mutation.
- Publish control blocks incomplete/conflicting talks, previews exact included records, creates one immutable revision, is idempotent under double-click, and leaves drafts private.
- Network loss, failed refresh/retry, Party disconnect/gap REST recovery, stale versions, optimistic rollback, and post-commit broadcast failure.

### Communications `/comms`

- Switch Templates/Audience & queue/Delivery history; keyboard semantics and preserved context.
- Select/create template; edit name, subject, text, HTML, merge cues, ICS toggle; invalid/unknown cues, escaping, long content, save/version history, unsaved navigation.
- Preview every representative recipient, missing fields, HTML/text parity, malicious merge values, correct event/talk/time/room/portal URL, and ICS with/without room and no video link.
- Audience filters, row selection, select/clear, exact count, invite/reminder intent, immediate vs scheduled mode, timezone/DST, past time, and confirmation identity invalidation after any material change.
- Review confirmation then cancel/queue/schedule; double activation; immutable snapshot; provider success/rejection/ambiguous timeout; retry/dead-letter; daily/event/campaign budgets; correlation/provider IDs.
- Delivery history refresh, filters/detail if present, status truth, attempts, download/inspect ICS, no secret/raw token, and accessibility of delivery failures.

### Publication `/publication`

- Reconcile readiness/conflicts/current revision with agenda; Copy public link clipboard success/failure.
- Publish schedule/new revision disabled and explained when blocked; confirmation cancel/confirm; exact revision number; double-click/idempotency; failure/retry; stale concurrent publish.
- Confirm only complete, confirmed talks and explicitly public speaker data enter immutable projection; private fields/drafts/reviews/tasks/assets never do.
- Compare organizer preview, public program, speakers page, and schedule embed; old revision remains stable until new publish.

### Exports `/exports`

- Exercise every export button/format exposed (archive JSON, CSVs, files/ZIP); empty/large event, progress, cancel if exposed, retry, double-click, filenames, MIME, encoding, spreadsheet-formula injection, stable IDs, and schema/version metadata.
- Reconcile speakers, submissions, answers, sessions, reviews, decisions, onboarding evidence, frozen speaker-at-time fields, and nullable legacy fields.
- Authorization, signed download expiry if used, missing R2 object, partial ZIP failure, and no private data in public exports.

### Integrations `/integrations`

- Reload status; Airtable not-configured/configured/error/dead-letter/conflict states; mapping JSON empty/malformed/unknown/duplicate/wrong table-field IDs; Save/Configure action; PAT never accepted or returned.
- Fixture vs live Accelevents selector; disabled live credentials; event ID/URL key validation; save/reload.
- Import dialog cancel/confirm; created/updated/unchanged/failed reconciliation; item evidence; rerun idempotency; partial failure/resume; wrong-event identities; relationship integrity.
- Airtable refresh/import controls where configured: authoritative field rules, pending overlay, conflict winner, batch/rate limit/429 recovery, last-refreshed truth, ordered outbox, and loop prevention.

### Settings `/settings`

- Edit every metadata field; required/invalid name/slug/timezone/date range/accent; slug collision/change effects; save, errors, stale version, reload, public projection publication rules.
- Add member validation (unknown account, duplicate, cross-event user), each role, and audit.
- For every existing member: select each permissible role, unchanged disabled state, Change role dialog cancel/confirm, Remove dialog cancel/confirm, immediate session impact, last-owner protection, self-demotion/removal rules, and concurrent membership mutation.
- Copy MCP endpoint; key name/preset/expiry and every scope projection; Create key; one-time secret visibility; copy secret/config; dismiss; reload proves secret cannot be recovered.
- Revoke active key cancel/confirm if dialog exists, immediate rejection of existing MCP session, already revoked state, expired key, cross-event scope, filtered tools/list, rate limit, and audit.

## 6. Public, submission, reviewer-invite, and speaker surfaces

### Public program `/event/ai-engineer-sandbox/*`

- All internal tabs/routes (sessions, speakers, personal schedule and any detail views), event-brand links, talk/speaker cards, expand/collapse bio/description, filters, detail dialogs, deep links, and Back/Forward.
- Personal schedule add/remove, all/personal toggle, persistence policy, duplicate talk, schedule update after publication, empty selection, and keyboard/screen-reader operation.
- Mobile cards, chronological ordering, timezone labels, room/track visibility, hidden speakers, co-speakers, cancelled/unpublished talks, external links, missing images, image alt text, and sharing metadata.

### Schedule and speaker embeds `/embed/ai-engineer-sandbox/{schedule,speakers}`

- All embed filters/interactions, responsive container widths/heights, no parent CSS bleed, keyboard focus, origin/CSP/frame behavior, empty/error/retry, and only published data.
- Embed builder: configure every option, generated code updates, Copy, Save definition, toggle saved definition, Get code, Delete; persistence, naming collision, invalid values, and escaping.

### Public CFP `/submit/ai-engineer-sandbox/:formId`

- Every published field type and validation; semantic title/abstract/name/email; routing branches; required hidden-field behavior; URL/date/number/options boundaries.
- Add/remove every co-speaker row; duplicate/invalid email and primary/co-speaker identity edge cases.
- Save draft/sign-in path if exposed, resume, edit, submit, double submit/idempotency, success receipt, closed/unpublished/old version, rate limit, Turnstile, offline/retry, and no leaked reviewer/internal data.
- Accepted submitter edit flow via `/portal/events/ai-engineer-sandbox/submissions`: Sign in, list, edit allowed answers, save, stale version, historical form version, and submit another link.

### Reviewer invitation `/reviewer-invitations/accept`

- Missing/malformed/expired/used/wrong-email token; signed-out identity bridge; signed-in wrong/right email; accept once; replay idempotency; resulting reviewer membership only; no token leakage in logs/history after completion.

### Speaker portal `/e/ai-engineer-sandbox/portal/*`

- Access check, claim portal, retry, wrong/non-speaker identity, revoked acceptance, and exact event isolation.
- Navigation across profile, tasks, resources, content/uploads, and submissions if exposed; mobile and deep links.
- Profile: every field/link, add link, validation, Save, retry, stale update, public/private projection.
- Tasks: each type, open/close form task, submit validation, confirm/link behavior, completion rules, due/overdue display, progress/readiness updates, and task changes mid-session.
- Uploads: headshot JPEG/PNG/WebP ≤10 MB; slides PDF/PPT/PPTX ≤100 MB; docs PDF/DOC/DOCX ≤25 MB; boundary sizes, spoofed MIME/extension, corrupt/zero-byte, duplicate/replacement/version history, progress/cancel/retry, download, attachment disposition, delete if exposed; reject HTML/SVG/executables.
- Resources: audience filtering, safe embeds, external links, unavailable resource.
- Content organizer route `/content`: filters, select current results, clear, selected ZIP, per-file download, comments disclosure/add comment, version restore, empty/error states, and authorization.

## 7. Accessibility (WCAG 2.2 AA target)

- Automated scan every stable route/state at desktop and mobile, followed by manual verification; do not treat zero scanner findings as a pass.
- Complete P0 workflows keyboard-only: logical order, visible focus, no traps, skip link, dialogs/drawers, menus, tabs, disclosures, tables, drag/drop alternative, form submission, toasts, downloads.
- Screen-reader passes with VoiceOver/Safari and one Chromium combination: landmarks, one clear H1, hierarchy, link/button names, current nav, table headers/captions, list semantics, progress/status announcements, charts, form labels/descriptions/errors, required/invalid state, dialogs, focus return, live regions.
- Contrast for text, controls, borders, focus, disabled states, status colors, charts; information never color-only.
- 320 CSS px reflow, 200% zoom, 400% text zoom where applicable, target size, spacing, orientation, reduced motion, animation pause, no hover-only content.
- Error prevention for legal/financial/data-changing actions, accessible authentication, redundant entry avoidance, consistent help/identification.

## 8. UI and visual quality

- Screenshot matrix: 320, 375, 768, 1024, 1440, and ultrawide; default/hover/focus/active/disabled/loading/error/success/empty/selected/dialog states.
- Verify production visual language consistently: typography, spacing rhythm, border/shadow geometry, color tokens, density, alignment, hit targets, icons, status badges, tables/cards, and sticky regions.
- No clipping, overlap, horizontal page overflow, orphan labels, ambiguous row actions, layout shift, broken images, z-index issues, truncated essential content, or unreadable long values.
- Dense operations tables preserve scanability, column association, action proximity, selection feedback, sticky context, and usable mobile transformation.
- Test browser font/image failure and slow loading; skeletons/spinners reserve space and communicate purpose.

## 9. UX research and heuristics

- Moderated think-aloud with at least 3 non-technical event-production users and one reviewer/speaker each.
- Tasks: configure/open CFP; triage and accept; diagnose/chase readiness; draft a conflict then resolve/publish; send a confirmed schedule; correct a speaker asset; import and verify records; export archive.
- Measure completion, time, first-click success, error/recovery, backtracks, help requests, confidence, and SUS or single-ease score.
- Heuristic review: system status, real-world match, control/freedom, consistency, error prevention, recognition, efficiency, minimalist hierarchy, recovery, and help.
- Specifically probe trust: draft vs published, logged vs sent contact, fixture vs live import, AI vs human review, pending sync vs canonical state, and what recipients/public can see.

## 10. Authorization, privacy, and security

- Build route × operation × persona matrix for signed-out, speaker, reviewer, admin, owner, API scopes, wrong-event member; test both UI hiding and direct REST/MCP/Party calls.
- Tamper every event/resource/user ID; IDs never confer authority. Verify same-event relationships on create/update/link/import.
- Validate Schema rejection at every ingress: missing/extra/wrong-type/oversized/malformed values; safe public error envelope and request ID; no stack/cause/secret.
- Test stored/reflected XSS in names, abstracts, comments, templates, merge values, resources, embed URLs, filenames; SQL/CSV/formula injection; URL and redirect validation.
- Session/token/key hashing, expiry, revocation, replay, rate limits, Turnstile fail-open/closed policy, secure cookies, CSRF, clickjacking/CSP, CORS, cache-control, referrer leakage.
- Realtime audience filtering and direct replies; API-key identities excluded from presence; reconnect refetch applies identical authorization.
- Retention/deletion fixtures for auth tokens, audit, rendered email/ICS, and event-private data; verify deletion request effects and immutable evidence policy.

## 11. Data integrity, concurrency, and cross-feature journeys

End-to-end journeys:

1. Create/publish routed CFP → submit/resume → review/comment/score → accept → provision speaker → complete tasks/profile/uploads/form → place agenda → publish → public/mobile/embed → send ICS → export archive.
2. Draft agenda with TBD/conflict → save warning → ensure private → resolve → publish one revision → edit draft → prove public remains old → publish next revision.
3. Create campaign → preview exact recipient → alter audience/template and prove confirmation invalidates → reconfirm → queue → provider retry → history/audit.
4. Accelevents fixture import twice → first creates/updates, second unchanged → partial failure/retry → links and stable IDs preserved.
5. Two users mutate the same form/review/speaker/task/resource/agenda record; stale writer receives a clear conflict and cannot overwrite silently.
6. Commit succeeds but realtime broadcast fails; originating UI shows committed truth and other client recovers through REST refresh.

For every mutation reconcile UI, REST response, D1/domain state, audit/domain change, Party audience, downstream derived count, public projection, and export. Verify idempotency keys and expected versions under duplicate, timeout, refresh, and concurrent requests.

## 12. Performance, resilience, and compatibility

Budgets (adjust only with an explicit product decision):

- Public pages: mobile p75 LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1 on representative production conditions.
- Organizer route navigation: visible purposeful loading within 100 ms; usable primary content ≤2 s p75 with seeded event; interactions acknowledge ≤100 ms and complete ≤1 s absent external adapters.
- No unbounded rendering or interaction degradation at 1,000 submissions, 500 speakers, 500 talks, 100 tasks/resources, and 10,000 audit/delivery records; pagination/filtering remains correct.

Test cold/warm cache, slow/failed API, offline mid-edit, 401/403/404/409/422/429/500, malformed response, timeout, retry, duplicate response, out-of-order response, browser reload, tab suspension, Worker/DO restart, Party disconnect/reconnect, R2 failure, email/provider ambiguity, and integration throttling.

Compatibility: current and previous Chrome, Firefox, Safari, and Edge; iOS Safari and Android Chrome; mouse, trackpad, touch, keyboard; common password manager/content-extension interference noted separately from app defects.

Inspect console errors, failed requests, unhandled rejections, source-map/secret leakage, cache headers, payload size, duplicate calls, abort behavior, and memory growth during long agenda/comms sessions.

## 13. Automation strategy

- **Unit/component:** validation boundaries, derived counts, conflict detection, merge/ICS rendering, authorization policies, schema encoding, form routing, publication projection, import normalization, accessibility states.
- **API/contract:** every OperationDef success/error/auth/idempotency/concurrency path; REST/OpenAPI/MCP schema parity; event isolation; public projection allowlist.
- **Browser E2E:** one test per control inventory row where stable; all P0 journeys; visual snapshots; keyboard and automated a11y; downloads/clipboard; responsive matrix.
- **Realtime/concurrency:** two-browser role-filtered delivery, disconnect/gap recovery, stale version, duplicate command, show-control persistence.
- **External adapters:** deterministic fakes for normal/error/timeout/rate-limit/ambiguous cases; a small separately gated live-provider canary.

Tag tests by `route`, `persona`, `priority`, `mutation`, `outbound`, `a11y`, `visual`, and `cleanup`. Quarantine is not a pass: every flaky test needs an owner, defect, and expiry.

## 14. Execution sequence and reporting

1. Freeze build/version, seed fixtures, snapshot event, verify sink recipients and fake adapters.
2. Discover routes and controls for every persona/breakpoint; create inventory and reconcile against source.
3. Run auth/authorization and public-data leak tests first.
4. Run P0 happy paths, then negative/concurrency/resilience paths.
5. Run full route/control matrix, accessibility, responsive/visual, UX research, performance, and compatibility.
6. Re-test fixes; run adjacent-feature and end-to-end regression.
7. Clean fixtures; prove no queued/scheduled outbound work remains; compare final state with intended retained baseline.
8. Publish sign-off report: build, environment, coverage reconciliation, pass/fail/block counts, Sev 1–4 list, performance/a11y results, known risks, evidence links, and ship/no-ship recommendation.

Daily status must distinguish verified facts from inference and show: cases run/passed/failed/blocked, controls discovered/covered, defects by severity, newly found data/outbound risks, cleanup status, and the next critical path.
