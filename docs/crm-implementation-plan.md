# Speaker CRM implementation plan

Status: proposed architecture for the optional CRM rubric. `PLAN.md` remains authoritative. Accept this design before adding the CRM to `PLAN.md`.

## Outcome

Add an organization-scoped speaker CRM above the existing event-scoped speaker portal. Organizers can maintain one private contact directory across their organization's events, source and track prospective speakers, hand contacts into an event, send reviewed bulk email, and measure CRM activity without weakening event or Airtable authority boundaries.

The implementation should satisfy optional rubric criteria CRM-01 through CRM-12 (19 points). It must preserve all required-capability scores and evidence.

## Current state

- The optional CRM is unimplemented: all 12 CRM criteria are explicit gaps in `scripts/rubric/evidence.ts`.
- Speakers, managed speaker emails, speaker contacts, audit rows, domain changes, and API keys are event-scoped.
- Events have no organization/workspace relationship.
- The existing portal has useful event-level concepts—managed speakers, CSV import, contact logging, assets, and reviewed mail snapshots—but they are not a safe substitute for an organization CRM.
- Public schedules, submissions, portal claims, and Airtable synchronization treat the event speaker as their domain record. The CRM must link to that record rather than silently replacing it.

## Non-negotiable design decisions

### Establish a real organization boundary

Do not derive a CRM by unioning every event a user can access. Add explicit organizations, organization membership, and organization-to-event membership.

For existing installations, create one organization per event and copy only that event's owner/admin membership. Do not automatically combine existing events, even when they have the same owner. This is the only backfill that cannot accidentally expand access. Owners can later move an event into another organization through an explicit, audited operation that requires authority over both organizations.

Use an `organization_events` mapping instead of rebuilding the existing `events` table. Make `event_id` unique so an event belongs to exactly one organization.

The schema migration backfills tenancy only. Do not silently consolidate existing event speakers into CRM contacts inside SQL. Once the CRM directory exists, offer a reviewed, idempotent “import event speakers” bootstrap that groups exact normalized emails across the organization's events, creates contact-event links, and surfaces same-event duplicate or missing-email ambiguities for organizer resolution. Demo data should run this bootstrap so cross-event history is present in deterministic evidence.

In the first release, moving an event is allowed only while it has no CRM contact links or campaign dependencies. Otherwise block with the exact dependency counts; do not strand private records in the source organization or silently transfer them. This lets owners group existing events before running the CRM bootstrap without introducing an unsafe organization-merge workflow.

### Keep canonical CRM contacts separate from event speakers

A CRM contact is a private, organization-scoped identity. An event speaker remains the event-scoped workflow and publication identity. Link them with an explicit contact-event link containing the resulting `speaker_id`.

This permits one contact to appear in many events while preserving event-specific title, company, bio, workflow, visibility, and Airtable ownership.

### Preserve Airtable authority

Handoff and CRM edits must never directly overwrite Airtable-authoritative event speaker fields. If a target event has Airtable ownership, use the existing pending-edit/conflict path or link to the authoritative record without changing it.

CRM fields remain local to the organization in the first release. Organization CRM synchronization to Airtable is out of scope.

### Review every outbound campaign

Organization bulk email must use the same safety model as other external email: preview the template, rendered content, exact audience, reply-to, and timing; persist the reviewed immutable snapshot; enqueue only that authorized snapshot. An empty selection must never mean “all contacts.”

### Prefer versioned transactions over eventual repair

All mutations are idempotent and version-guarded. Transactions must prove the guarded write won before recording success, audit activity, or a completed idempotency result. Do not use a predictable next version as the sole lost-update sentinel.

## Authorization and privacy

- Add organization owner/admin authorization for browser principals.
- Event membership alone does not grant CRM access.
- Existing event API keys and event-scoped MCP tools cannot access CRM operations.
- Every CRM read and write must filter by `organization_id` after authorization; identifiers alone are never authority.
- Contact email, notes, tags, pipeline state, segments, campaign content, and activity are private and must never enter a public route or public schedule projection.
- Moving an event between organizations requires owner-level authority over the source and target, with explicit confirmation and an audit record.
- An event move is blocked once CRM contact links or campaign dependencies exist.
- The initial release does not add organization API keys, public CRM APIs, an Airtable CRM sync, or realtime organization rooms.

## Proposed data model

Names are illustrative but should remain consistent once migrations and contracts land.

| Entity | Purpose and key constraints |
| --- | --- |
| `organizations` | `id`, unique `slug`, `name`, `version`, timestamps. |
| `organization_members` | `(organization_id, user_id)` primary key; role `owner` or `admin`; version and timestamps. |
| `organization_events` | Unique `event_id`; `(organization_id, event_id)` relationship and timestamps. |
| `crm_contacts` | Canonical private identity: organization, display name, normalized name, email, normalized email, title, company, bio, source, version, timestamps. Unique non-null `(organization_id, normalized_email)`. |
| `crm_contact_event_links` | Contact-to-event history and handoff result: organization, contact, event, speaker, linked timestamp. Unique contact/event and event/speaker relationships. |
| `crm_tags` | Organization-owned tag vocabulary; unique normalized name per organization. |
| `crm_contact_tags` | Contact/tag join with unique pair. |
| `crm_notes` | Append-only internal notes linked to a contact and optionally a pipeline entry; author and timestamp. |
| `crm_activities` | Append-only organization audit/activity stream containing actor, action, entity, structured summary, and timestamp. Do not reuse event-required `domain_changes` or `audit_log` without changing their tenancy contract. |
| `crm_pipeline_stages` | Organization stages with stable IDs, names, order, and active state. Seed at least Prospect, Contacted, Interested, Confirmed, and Declined. |
| `crm_pipeline_entries` | One contact in one sourcing pipeline; current stage, owner, version, timestamps. |
| `crm_pipeline_transitions` | Append-only from/to stage history, actor, timestamp, and optional note. |
| `crm_segments` | Saved organization list with name, mode (`dynamic` initially; `curated` if delivered), normalized filter JSON, version, timestamps. |
| `crm_segment_contacts` | Optional curated membership when curated segments are implemented. |
| `crm_contact_aliases` | Previous identity values and merge tombstones so imports and old references resolve to the surviving contact. |
| `crm_campaigns` | Draft/reviewed/scheduled/sending/completed campaign, subject/template/reply-to, reviewed audience digest, authorization metadata, and version. |
| `crm_campaign_recipients` | Exact contact/email/rendered snapshot and delivery linkage for every authorized recipient. |

Extend mail delivery snapshots with an optional organization/campaign association rather than inventing a second queue. Organization campaign delivery must be counted as campaign traffic under the existing account-level budget and must not consume an unrelated event's budget. Keep snapshot immutability and attempt history.

Indexes should cover organization plus normalized email/name, company, title, tag joins, pipeline stage/order, event links, activity time, and campaign state. Foreign keys must prevent cross-organization links even when application validation is bypassed; where SQLite cannot express a composite invariant directly, use composite unique keys plus matching composite foreign keys or transaction guards with migration tests.

## Identity, import, and merge rules

1. Normalize email by trimming and lowercasing. Normalize names for search and duplicate suggestions without treating a name match as proof of identity.
2. Exact normalized email is the primary import/upsert key inside one organization.
3. Missing-email contacts are allowed only with a stable generated identity and must be highlighted as incomplete.
4. Duplicate suggestions include exact email aliases and strong normalized-name/company matches. They never auto-merge non-identical emails.
5. Merge requires an explicit survivor and field choices. In one transaction, relink event history, tags, notes, pipeline history, segment membership, aliases, and campaign history; reject self, cross-organization, stale-version, and incompatible link merges.
6. Preserve a tombstone/alias so a later import of the losing identity resolves to the survivor.
7. CSV import has preview and commit phases. Preview validates size, headers, encoding, malformed rows, normalized identities, prospective inserts/updates, and duplicate warnings. Commit accepts the preview digest and applies exactly those reviewed rows idempotently.
8. Required CSV columns are name and email. Optional columns include title, company, bio, and tags. Return row-level imported, updated, skipped, and error results.

## Product surface

Use organization routes outside the event shell:

- `/o/:organizationSlug/crm` — directory and filters
- `/o/:organizationSlug/crm/contacts/:contactId` — private profile, notes, history, tags, and activity
- `/o/:organizationSlug/crm/pipeline` — sourcing kanban
- `/o/:organizationSlug/crm/segments` — saved lists
- `/o/:organizationSlug/crm/campaigns` — reviewed bulk email workflow
- `/o/:organizationSlug/crm/dashboard` — metrics

The organization switcher/navigation is central integration work. Event pages may link back to the CRM contact but must not expose private CRM data in event or public routes.

### Directory and profile

- Debounced search over name, email, title, and company.
- Composable filters for tags, pipeline stage, prior event participation, title/company, and “has email.”
- Stable pagination and deterministic ordering.
- Profile with identity fields, initials/photo fallback, persistent notes, tags, linked events, talks/sessions, outreach, campaign delivery state, pipeline transitions, and an activity timeline.
- Event history is read through contact-event links and current event-domain records; deleted or inaccessible event details use a safe tombstone label.
- A reviewed event-speaker bootstrap previews exact-email groups, new contacts, new links, and ambiguous rows before committing the displayed result.

### Pipeline and segments

- Kanban displays at least five ordered stages.
- Moving a card is a versioned operation that records a timestamped transition; dragging is not optimistic success until the server confirms.
- Each pipeline card opens a detail view with a notes composer and timestamped from/to stage history that persists after reload.
- Saved segments persist a normalized filter definition and evaluate using the same query builder as the directory. Store a definition version for future migrations.

### Event handoff

- Choose only an event belonging to the same organization.
- Preview whether handoff will create a managed speaker, link an exact existing speaker, or require duplicate resolution.
- Commit creates/links the event speaker and contact-event record atomically and idempotently.
- Reuse a shared portal domain function rather than duplicating speaker creation rules.
- Respect accepted-submission ownership, current portal claims, managed email identities, and Airtable pending edits.
- A handoff is not an acceptance decision and does not publish the speaker.

### Campaigns

- Audience comes from an explicit nonempty selection or a saved segment plus a displayed resolved count.
- Preview renders the exact subject/body/reply-to for representative and exceptional recipients and shows exclusions such as missing or invalid email.
- Authorization records actor, timestamp, audience digest, content digest, and scheduled time.
- Queue rows are created from the authorized immutable recipient snapshots only.
- Contact activity shows queued, delivered, bounced, failed, or cancelled state from delivery records.
- Retries are idempotent; reauthoring content or audience creates a new review version.

### Dashboard

Show at minimum:

- total contacts;
- returning speakers (linked to more than one event);
- pipeline distribution and conversion counts;
- recent additions and outreach;
- top companies;
- campaign delivery summary when campaign data exists.

All metrics use organization-scoped server queries and define the time range and denominator in the UI.

## Operations

Implement the feature as `src/features/crm/` using the repository's Effect service → operation → transport pattern. Operation names use the `crm.*` prefix. A likely initial operation set is:

- `crm.listContacts`, `crm.getContact`, `crm.createContact`, `crm.updateContact`
- `crm.addNote`, `crm.addTag`, `crm.removeTag`, `crm.listActivity`
- `crm.previewEventSpeakerImport`, `crm.commitEventSpeakerImport`
- `crm.previewCsvImport`, `crm.commitCsvImport`
- `crm.listDuplicateCandidates`, `crm.previewMerge`, `crm.mergeContacts`
- `crm.listPipeline`, `crm.movePipelineEntry`
- `crm.listSegments`, `crm.saveSegment`, `crm.deleteSegment`, `crm.resolveSegment`
- `crm.previewEventHandoff`, `crm.commitEventHandoff`
- `crm.previewCampaign`, `crm.authorizeCampaign`, `crm.cancelCampaign`, `crm.getCampaign`
- `crm.getDashboard`

Expose browser JSON transports first. Do not expose CRM operations as MCP tools until an organization-scoped non-browser principal and explicit tool policy exist.

## Pull request stack

Keep the work reviewable and preserve stack ancestry. Merge one green PR at a time, update the next branch from `main`, and rerun its validation before merge.

### PR 1 — organization and CRM spine

Central/integrator-owned changes:

- organization contracts, schemas, authorization policy, routes, migration, seed data, and migration parity;
- safe one-organization-per-event backfill and owner/admin membership copy;
- explicit event move/adoption operation and audit activity;
- organization navigation and route shell;
- mail snapshot organization/campaign association and scheduler budget semantics required later;
- generated registry refresh.

Tests must prove tenancy isolation, browser role enforcement, event-key denial, safe backfill, unique event ownership, event-move authorization, and migration behavior from realistic pre-CRM data.

### PR 2 — directory, profile, notes, and tags

Delivers CRM-01 through CRM-04:

- contact CRUD, normalized search, filters, pagination;
- profile identity, persistent notes, activity, and linked cross-event history;
- reviewed, idempotent existing-event speaker bootstrap with ambiguity reporting;
- organization tags and contact tagging;
- organization-level routes and focused browser tests.

### PR 3 — CSV import and deduplication

Delivers CRM-05 and CRM-06:

- reviewed CSV preview/commit with row results;
- duplicate suggestions and explicit transactional merge;
- aliases/tombstones and stale-version/idempotency tests.

### PR 4 — sourcing pipeline and saved segments

Delivers CRM-07 through CRM-09:

- five-stage kanban with versioned moves;
- timestamped transition history and notes;
- reusable directory filter compiler and saved dynamic segments.

### PR 5 — event handoff and organization campaigns

Delivers CRM-10 and CRM-11:

- previewed, idempotent contact-to-event handoff using shared portal rules;
- exact-audience campaign preview, reviewed authorization, immutable snapshots, queue linkage, and contact delivery activity;
- concurrency, Airtable-authority, empty-selection, budget, and retry tests.

### PR 6 — dashboard and deterministic evidence

Delivers CRM-12 and closes evidence gaps:

- organization CRM dashboard;
- deterministic multi-event demo fixtures;
- browser-level evidence for every rubric behavior;
- `scripts/rubric/evidence.ts` mappings with no inferred or overstated coverage;
- refreshed rubric baseline only after independently verifying the achieved score.

## Verification strategy

Each PR runs focused unit/service/route/browser tests plus `pnpm check`. The final stack runs:

```text
pnpm check
pnpm test:worker
pnpm test:migrations
pnpm test:audit-browser
pnpm test:storybook
pnpm test:visual-tools
pnpm build
pnpm rubric:test
pnpm rubric:gate
```

Required deterministic scenarios include:

- two organizations with overlapping contact emails and no data leakage;
- an event member who is not an organization member;
- two events in one organization with one returning speaker;
- safe migration from existing event speakers and memberships;
- reviewed event-speaker bootstrap with exact-email grouping, missing-email rows, and same-event duplicate conflicts;
- an allowed pre-bootstrap event move and a blocked move after CRM links exist;
- exact email import replay, malformed rows, duplicate-name candidates, and a merge preserving every relationship;
- concurrent contact edit, pipeline move, merge, handoff, and campaign authorization;
- Airtable-owned event speaker handoff;
- empty audience, invalid email, reviewed snapshot mutation attempt, retry, bounce/failure, and daily campaign budget;
- intentionally out-of-order activity and event history to prove ordering;
- dashboard counts tied to the same fixtures shown in directory and pipeline views.

## Rubric acceptance matrix

| Criterion | Acceptance evidence |
| --- | --- |
| CRM-01 | Browser test searches an organization directory by name, email, company, and title across at least two linked events. |
| CRM-02 | Browser test combines tag, company/title, pipeline, and prior-event filters and asserts the resulting identities. |
| CRM-03 | Contact detail asserts identity, notes after remount, two-event activity/history, outreach state, and session metadata. |
| CRM-04 | Browser/service test creates a tag, assigns it, filters by it, and removes it without cross-org leakage. |
| CRM-05 | Browser/service test previews and commits CSV, then asserts inserts, updates, skips, errors, and replay behavior. |
| CRM-06 | Browser/service test detects a likely duplicate and merges it while preserving links, tags, notes, pipeline history, and aliases. |
| CRM-07 | Browser test displays five stages and moves a contact between columns with persisted state. |
| CRM-08 | Contact detail asserts the move's from/to stages, actor, timestamp, and attached note after remount. |
| CRM-09 | Browser test saves a multi-filter segment, reloads it, and resolves the expected contacts after underlying data changes. |
| CRM-10 | Browser/service test previews and commits handoff, links the event speaker, replays safely, and respects Airtable authority. |
| CRM-11 | Browser/service test explicitly selects recipients, reviews content/audience, authorizes the immutable snapshot, and observes delivery/log state. |
| CRM-12 | Browser test validates total contacts, returning speakers, pipeline counts, recent activity, and top companies from deterministic fixtures. |

## Out of scope for the first CRM release

- public CRM pages;
- organization API keys or CRM MCP tools;
- organization-level realtime/PartyServer rooms;
- third-party CRM or Airtable contact synchronization;
- lead enrichment, scraping, automated scoring, or AI-written outreach;
- arbitrary custom-field schema builders (tags satisfy CRM-04 initially);
- automatic event clustering during migration;
- email sequences or autonomous follow-ups.

## Exit criteria

The CRM is complete when all CRM-01 through CRM-12 behaviors have deterministic evidence, the rubric no longer lists a CRM gap, tenancy and migration tests pass, required capability/evidence scores do not regress, campaign authorization is reviewed and immutable, and every branch in the stack is green with no unresolved actionable review feedback.
