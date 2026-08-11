# QA execution record — AI Engineer Sandbox

Run date: 2026-08-11  
Target: `https://sessionparty.com/e/ai-engineer-sandbox`  
Specification: `QA_PLAN.md`

## Automated coverage implemented

`pnpm test:qa` starts a clean local Worker, hydrates the deterministic AI Engineer Sandbox fixture, and runs the Playwright matrix in Desktop Chrome, Pixel 7 Chrome, Desktop Firefox, and Desktop WebKit.

- 39 owner, admin, reviewer, speaker, public, embed, authentication, invitation, and error routes at both breakpoints.
- Runtime discovery and JSON evidence for links, buttons, inputs, selects, textareas, summaries, and explicit ARIA roles across 78 desktop/mobile route-persona inventories: 5,905 visible instances and 509 distinct signatures in the latest serialized run.
- Accessible-name, single-H1, document-title, canonical/Open Graph URL and title, current-navigation, horizontal-overflow, browser-error, and HTTP-document assertions.
- Axe WCAG 2.0/2.1/2.2 A/AA scans; serious and critical violations fail the run.
- Skip-link, mobile navigation, Escape close, focus restoration, client-route focus, title, and canonical behavior.
- Safe interaction scenarios for login validation, browser Back/Forward and multi-tab logout, modal validation/cancel, submission filters and pagination, review filters, contact editing, speaker selection, destructive-dialog cancellation, agenda views/setup/live show, communication tabs/template editing, publish/import confirmation, membership-role cancellation, every archive download, public-link clipboard behavior, every embed-builder option plus saved-definition round trip, public-program mobile navigation/session details/schedule controls, and the public CFP's conditional fields, validation, co-speaker controls, Unicode local-draft save, and reload recovery.
- Authorization checks for signed-out, expired, malformed, cross-event, owner, admin, reviewer, and speaker identities at both the REST and organizer-UI boundaries.
- Public-projection privacy assertions, immutable publication-revision reconciliation, and hostile login return-target containment.
- Controlled form mutations cover role denial, concurrent idempotent create replay, mismatched replay, competing optimistic writers, stale overwrite denial, and replay-safe deletion. Controlled API-key mutations cover one-time secret disclosure, scope and cross-event isolation, metadata redaction, and immediate revocation. Controlled task/resource lifecycles cover every task kind, role denial, unsafe embed schemes and lookalike hosts, competing writers, stale deletes, and verified cleanup.
- An explicit 320/375/768/1024/1440/2560 px matrix checks representative public, organizer, table-heavy, agenda, and settings routes for reflow, true clipping, shell mode, and H1 integrity; forced-colors mode covers public sessions, forms, and agenda.
- Failure injection verifies a recoverable organizer event-load state; local performance observers gate representative public and organizer routes at LCP ≤2.5 s and CLS ≤0.1. Deploy-ready static assets include baseline nosniff, referrer, and browser-permission headers.

Latest local result: **229 passed, 83 intentionally skipped, 0 failed** across 312 project cases. The skips avoid duplicating browser-independent API/security/mutation/viewport/resilience checks, omit the deploy-only header assertion under Vite dev, and avoid mobile-only or Chromium-permission-specific interactions in other engines; route, control, runtime-error, interaction, and accessibility coverage runs in Chromium, Firefox, and WebKit, with the full route surface also covered on mobile Chromium. The shared D1 sandbox runs serially so route inventories cannot observe another test's in-flight disposable mutation.

Baseline regression suites also passed before the QA fixes:

- `pnpm check`: registry, TypeScript, and 98-item/145-check rubric manifest passed.
- `pnpm test`: 47 files and 469 tests passed.
- `pnpm test:audit-browser`: 6 files and 11 tests passed.
- `pnpm rubric:test`: 7 tests passed.

## Defects found and fixed

| Area | Finding | Resolution |
| --- | --- | --- |
| Route metadata | Agenda/communications H1 text could be concatenated in the title; async public routes retained the loading title. | Use rendered heading text and keep route metadata synchronized through async updates. |
| Error routing | The wildcard route retained stale metadata and had no H1. | Run it through the route coordinator and render the empty-state title as H1. |
| Public errors | Stable public-program error states had no H1. | Add explicit EmptyState heading levels. |
| Dialog focus | Mobile navigation and generic modals failed to return focus to their opener. | Capture the opener before the portal moves focus and restore it after close. |
| Publication IA | Publication rendered both “Publish the run of show” and “Embed & share” as H1. | Support section heading levels and render the embedded builder title as H2. |
| ARIA | Onboarding and event-setup visual meters used `aria-label` on generic divs. | Expose native progressbar semantics and numeric values. |
| Contrast | Forms, review, communications, landing, integrations, checkbox help, and speaker-portal text produced serious contrast violations. | Replace opacity/faint tokens with passing semantic text colors. |
| Keyboard access | The horizontally scrollable MCP endpoint was not keyboard focusable on mobile. | Make scrollable code regions focusable. |
| Public CFP stability | Editing co-speaker fields crashed the React route because a deferred state updater dereferenced a cleared event target. | Capture each input value synchronously before updating the co-speaker collection; verify all four fields plus draft recovery on desktop and mobile. |
| Signed-out semantics | Twelve private organizer routes rendered access failures without a top-level heading. | Promote route-level failure titles to H1 and scan every signed-out state with axe. |
| WebKit focus | Pointer-activated controls are not focused by Safari/WebKit, so a controlled dialog could lose its opener on close. | Support an explicit opener reference and restore the form-dialog trigger after every close transition. |
| WebKit embeds | WebKit rejected `allow-presentation` as an iframe sandbox token and emitted a runtime console error. | Remove the unnecessary token while preserving allowlisted script/same-origin and fullscreen behavior. |
| Layout stability | The async top bar inserted its first action after session resolution, shifting the entire readiness dashboard to CLS 0.114. | Reserve the action footprint during session loading; the route now passes the 0.1 local CLS budget. |

## Deployed read-only reconciliation

The public subset was also run against `https://sessionparty.com` without fixture writes: **8 passed and 10 failed**, representing three unique defects in the currently deployed revision:

1. Landing workflow-card text has serious contrast violations at desktop and mobile.
2. Sessions and Speakers public routes retain `Loading published program — Session Party` after content loads.
3. The unknown-route page has no H1.

All three pass in the local matrix with this change set. Login, schedule embed, speaker embed, and invalid reviewer-invitation surfaces passed at both breakpoints.

## Deliberately not executed against production

The production run is read-only. Publishing, imports, member/role changes, key creation/revocation, deletes, outbound communication, uploads, acceptance decisions, and other mutating/destructive actions remain limited to the deterministic local sandbox. The following plan areas still require dedicated controlled environments or human sessions before a full release sign-off:

- Final per-control execution reconciliation beyond discovery/accessibility evidence; unmatched controls are not silently treated as covered.
- Unassigned/recused reviewer personas and mutation-level role checks outside forms, API keys, tasks, and resources.
- Real provider email, file-storage, Airtable, Accelevents, retry/dead-letter, and audit evidence.
- Concurrent stale-version, offline/reconnect, Party gap recovery, idempotency-race, and session-expiry cases.
- Screen-reader manual passes, true browser 200% zoom, manual visual review, mobile Safari/device coverage, and moderated IA first-click studies.
- Production p75 Core Web Vitals/load, broader slow-network/failure injection, deployed-header confirmation, CSP, and upload/embed adversarial testing.

Those items remain blockers for claiming the entire `QA_PLAN.md` release gate; they are not silently treated as passes.
