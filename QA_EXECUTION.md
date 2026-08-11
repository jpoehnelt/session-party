# QA execution record — AI Engineer Sandbox

Run date: 2026-08-11  
Target: `https://sessionparty.com/e/ai-engineer-sandbox`  
Specification: `QA_PLAN.md`

## Automated coverage implemented

`pnpm test:qa` starts a clean local Worker, hydrates the deterministic AI Engineer Sandbox fixture, and runs the Playwright matrix in Desktop Chrome, Pixel 7 Chrome, Desktop Firefox, and Desktop WebKit.

- 39 owner, admin, reviewer, speaker, public, embed, authentication, invitation, and error routes at both breakpoints.
- Runtime discovery and JSON evidence for links, buttons, inputs, selects, textareas, summaries, and explicit ARIA roles across 78 desktop/mobile route-persona inventories: 5,477 visible instances and 514 distinct signatures in the latest serialized run.
- Accessible-name, single-H1, document-title, canonical/Open Graph URL and title, current-navigation, horizontal-overflow, browser-error, and HTTP-document assertions.
- Axe WCAG 2.0/2.1/2.2 A/AA scans; serious and critical violations fail the run.
- Skip-link, mobile navigation, Escape close, focus restoration, client-route focus, title, and canonical behavior.
- Sequential Tab-order reconciliation covers every enabled stable control across 27 distinct owner, reviewer, speaker, public, embed, authentication, error, and dynamic CFP surfaces at desktop and mobile Chromium: 1,270 desktop plus 1,054 mobile Tab stops in the latest run. Native radio groups, roving tabs, and collapsed disclosures are modeled by their actual keyboard contract.
- Pointer hit-testing now reconciles the same 27-route desktop/mobile surface with non-mutating trial activation for every enabled visible stable control, proving scrolling, stability, hit targeting, and freedom from overlay obstruction. The only exclusions are the keyboard-only skip link and visually hidden file input represented by its visible chooser button; the latest serialized run covered 1,312 desktop plus 1,096 mobile pointer targets.
- Safe interaction scenarios for login validation, browser Back/Forward and multi-tab logout, modal validation/cancel, full form-builder creation/edit/reorder/remove/save/reload/delete, submission filters and pagination, review filters plus two-tab rubric editing, contact editing, speaker selection, task and resource validation/create/edit/reload/delete lifecycles, destructive-dialog cancellation, agenda views/setup/live show plus track/room and talk-content/schedule validation/edit/reload/restore, agenda card drag/drop with invalid-target no-op and keyboard restoration, communication tabs/template editing, publish/import confirmation, membership-role cancellation, every archive download, public-link clipboard behavior, every embed-builder option plus saved-definition round trip, public-program mobile navigation/session details/schedule controls, and the public CFP's conditional fields, validation, co-speaker controls, Unicode local-draft save, and reload recovery.
- Authorization checks for signed-out, expired, malformed, cross-event, owner, admin, assigned/unassigned/recused reviewer, and speaker identities at both the REST and organizer-UI boundaries. Reviewer evidence proves committee-wide reads, empty assigned-only worklists for unassigned/recused identities, retained recusal history, private-contact redaction, and denial of post-recusal scoring.
- Public-projection privacy assertions, immutable publication-revision reconciliation, and hostile login return-target containment.
- Controlled form mutations cover role denial, concurrent idempotent create replay, mismatched replay, competing optimistic writers, stale overwrite denial, and replay-safe deletion. The real builder now creates every supported field type, exercises reordering/removal, persists across reload, protects unsaved navigation, and deletes its disposable draft on desktop/mobile Chromium, Firefox, and WebKit. Controlled API-key mutations cover one-time secret disclosure, scope and cross-event isolation, metadata redaction, and immediate revocation. Controlled task/resource lifecycles cover every task kind, role denial, unsafe embed schemes and lookalike hosts, competing writers, stale deletes, and verified cleanup; the real editors additionally prove conditional Form ID validation, server-rejected resource-input preservation, create/update/reload, confirmation cancellation, and deletion in all four browser profiles.
- Controlled event-member mutations cover reviewer denial, admin escalation and self-demotion denial, last-owner protection, competing role writers, stale overwrite denial, immediate session revocation, replay-safe removal/addition, and deterministic fixture restoration. The settings UI performs the successful role/remove/add transitions and projects the same owner/admin capability boundary instead of exposing guaranteed-failure controls.
- Event metadata updates now require the loaded event version. Two simultaneous organizers produce exactly one committed winner and one recoverable conflict; the stale UI cannot overwrite the winner, while the successful update atomically records one admin-audience domain change and one audit entry.
- Controlled communication-template mutations cover reviewer denial, replay and mismatched-replay behavior, competing optimistic writers, stale overwrite denial, exact winner-only domain/audit/idempotency evidence, and deterministic fixture restoration. The real editor preserves the stale writer's draft and now requires an explicit accessible confirmation before internal tab/template navigation can discard unsaved changes.
- Managed-speaker profile mutations cover reviewer denial, accepted-speaker ownership, normalized-email uniqueness, competing optimistic writers, stale overwrite denial, deterministic restoration, and public-projection immutability. The organizer UI exposes editing only for directly managed profiles, explains speaker-owned accepted profiles, and preserves a stale writer's fields until recovery.
- The real review score editor now proves a winning rubric/rationale save, canonical reload, stale second-tab rejection, preservation of the losing draft, and deterministic fixture restoration on desktop/mobile Chromium, Firefox, and WebKit.
- Agenda setup now gives every track and room row a distinct accessible edit name, protects changed drafts from accidental sheet dismissal, and proves invalid-input preservation plus successful edit/reload/API restoration in all four browser profiles.
- Agenda talk editing now protects changed title, abstract, track, room, start, and duration drafts from accidental sheet dismissal. The real UI proves keep/discard behavior, title and duration validation, content and schedule persistence after reload, immutable public-revision isolation, and exact API fixture restoration in all four browser profiles.
- Agenda placement now makes the visible talk-card action itself draggable instead of requiring a drag from the narrow list-item border. The interaction suite proves invalid drops are no-ops, a valid cross-track drop mutates canonical state, the keyboard editor restores the placement, reload preserves it, and cleanup is exact.
- An explicit 320/375/768/1024/1440/2560 px matrix checks representative public, organizer, table-heavy, agenda, and settings routes for reflow, true clipping, shell mode, and H1 integrity; forced-colors mode covers public sessions, forms, and agenda.
- Failure injection verifies a recoverable organizer event-load state; local performance observers gate representative public and organizer routes at LCP ≤2.5 s and CLS ≤0.1. Deploy-ready static assets include baseline nosniff, referrer, and browser-permission headers.
- Agenda disconnect/reconnect coverage proves offline status annunciation, mutation lockout, canonical refresh recovery, and restored controls. Form creation also fails closed when the browser session expires between editing and submission, with no draft persisted.
- Portal uploads now validate decoded file signatures/containers in addition to declared MIME, extension, and purpose limits. Unit coverage rejects empty, truncated, renamed HTML/SVG, executable, corrupt OOXML, and double-extension payloads without R2, asset, completion, or idempotency side effects; Chromium, Firefox, and WebKit also verify the speaker UI reports rejection and preserves the asset list after reload.

Latest local result: **272 passed, 116 intentionally skipped, 0 failed** across 388 project cases. The skips avoid duplicating browser-independent API/security/mutation/viewport/resilience/keyboard/pointer checks, omit the deploy-only header assertion under Vite dev, and avoid mobile-only, native-drag, or Chromium-permission-specific interactions in other engines; route, control, runtime-error, interaction, and accessibility coverage runs in Chromium, Firefox, and WebKit, with the full route surface also covered on mobile Chromium. The shared D1 sandbox runs serially so route inventories cannot observe another test's in-flight disposable mutation.

Baseline regression suites also passed before the QA fixes:

- `pnpm check`: registry, TypeScript, and 98-item/145-check rubric manifest passed.
- `pnpm test`: 47 files and 475 tests passed.
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
| Upload validation | Portal uploads trusted the declared MIME type and matching extension, allowing renamed active content or arbitrary bytes to be stored as an allowed file. | Validate decoded PNG/JPEG/WebP/PDF/OLE/OOXML signatures or containers before any R2 or database side effect; add adversarial unit and cross-browser speaker-UI coverage. |
| Membership UX/authorization | Admin settings exposed owner/admin escalation, self-management, and role-change controls that the service correctly rejected, inviting destructive dialogs that could only end in 403. | Derive the current manager from the authenticated session and canonical membership; owners retain guarded controls, admins can add/remove reviewers only, and last-owner actions are disabled before confirmation. |
| Settings concurrency/evidence | Event metadata updates incremented a version but did not require the loaded version, so simultaneous organizers could silently overwrite each other and changes had no domain/audit evidence. | Require `expectedVersion`, guard the D1 update, atomically emit domain/audit evidence only for the winner, and show a recoverable stale-write conflict without losing either editor's state. |
| Communications edit safety | Switching workspace tabs or templates silently discarded an unsaved message draft, and the existing concurrency contract lacked end-to-end evidence. | Add a keyboard-accessible discard confirmation with keep-editing and discard paths; prove two browser writers yield one winner/one recoverable conflict, retain the losing draft, record evidence only for the winner, and restore the sandbox fixture. |
| Speaker ownership UX | Accepted speaker rows exposed an organizer profile editor that the service always rejected, while the sandbox had no deterministic directly managed profile for the successful path. | Project controls from profile ownership, explain speaker-managed accepted profiles, add a hidden managed fixture, and prove real save, stale-writer recovery, restoration, and public-projection immutability. |
| Form builder scale/edit safety | Saving a legitimate draft containing all 11 supported builder field types exceeded D1's per-statement bind-variable ceiling; switching forms also discarded unsaved edits without warning. | Chunk field and immutable-version inserts inside the atomic D1 batch, add a clear keep/discard confirmation, and prove create/edit/reorder/remove/save/reload/delete on desktop/mobile Chromium, Firefox, and WebKit. |
| Task configuration UX | Form ID appeared for every task kind and was optional in the browser, inviting irrelevant or incomplete linkage; successful task/resource UI lifecycles were unproven. | Render a required Form ID only for form tasks, and prove conditional validation plus reversible task/resource create/update/reload/delete across desktop/mobile Chromium, Firefox, and WebKit, including preservation of server-rejected resource input. |
| Agenda setup edit safety | Every track and room row exposed the same generic “Edit” accessible name, and closing the setup sheet silently discarded a changed draft. | Name each action with its entity type and title; require explicit discard confirmation for changed track/room drafts, reset accepted discards, and prove validation, keep/discard, persistence, reload, and restoration across all four browser profiles. |
| Agenda talk edit safety | Closing a talk sheet silently discarded changed session content or schedule fields with no warning. | Compare every editor field with the canonical version, require explicit confirmation before discarding, and prove keep/discard, validation, private-draft isolation, persistence, reload, and exact restoration across all four browser profiles. |
| Agenda drag hit area | Talk cards put the drag contract on an outer list item while the full visible hit area was an inner button, so starting a drag from the card itself did not reliably initiate placement. | Put native draggable behavior and its start/end handlers on the visible named card action; prove invalid and valid drops, canonical mutation, keyboard-equivalent restoration, reload, and cleanup. |

## Deployed read-only reconciliation

The public subset was also run against `https://sessionparty.com` without fixture writes: **8 passed and 10 failed**, representing three unique defects in the currently deployed revision:

1. Landing workflow-card text has serious contrast violations at desktop and mobile.
2. Sessions and Speakers public routes retain `Loading published program — Session Party` after content loads.
3. The unknown-route page has no H1.

All three pass in the local matrix with this change set. Login, schedule embed, speaker embed, and invalid reviewer-invitation surfaces passed at both breakpoints.

## Deliberately not executed against production

The production run is read-only. Publishing, imports, member/role changes, key creation/revocation, deletes, outbound communication, uploads, acceptance decisions, and other mutating/destructive actions remain limited to the deterministic local sandbox. The following plan areas still require dedicated controlled environments or human sessions before a full release sign-off:

- Actual pointer-triggered state-transition reconciliation is still incomplete for controls outside the explicit interaction scenarios; pointer hit-testing, sequential keyboard reachability, and discovery/accessibility evidence are complete for stable route surfaces, and unmatched dynamic/error-state controls are not silently treated as covered.
- Mutation-level role and concurrency checks outside forms, event metadata, membership, API keys, tasks, resources, communication templates, managed speaker profiles, and reviewer recusal.
- Real provider email, file-storage, Airtable, Accelevents, retry/dead-letter, and audit evidence.
- Concurrent stale-version, Party gap recovery, and idempotency-race cases outside the covered forms, event metadata, membership, tasks, resources, communication templates, managed speaker profiles, agenda-offline, and form-session-expiry paths.
- Screen-reader manual passes, true browser 200% zoom, manual visual review, mobile Safari/device coverage, and moderated IA first-click studies.
- Production p75 Core Web Vitals/load, broader slow-network/failure injection, deployed-header confirmation, CSP, full upload boundary/storage-failure coverage, and deeper embed redirect/frame-policy testing.

Those items remain blockers for claiming the entire `QA_PLAN.md` release gate; they are not silently treated as passes.
