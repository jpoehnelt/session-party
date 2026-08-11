# Speaker CRM implementation prompt

Copy this prompt into a new implementation task after `docs/crm-implementation-plan.md` is accepted.

---

Implement the optional organization-scoped Speaker CRM described in `docs/crm-implementation-plan.md`. Treat `PLAN.md` as authoritative; if the proposed CRM plan conflicts with it, stop and report the exact conflict instead of silently changing an invariant. Do not score or compare opensession.

## Objective

Deliver CRM-01 through CRM-12 from `rubric/manifest.json` as a reviewable PR stack without regressing required rubric capability or deterministic evidence. The result must be a private cross-event CRM with a directory, filters, contact profiles/history, tags, CSV import, duplicate merge, sourcing pipeline, saved segments, event handoff, reviewed organization bulk email, and dashboard metrics.

## Required architecture

1. Add an explicit organization tenancy boundary. Never infer a CRM by unioning events a user can access.
2. Use organizations, organization owner/admin membership, and an organization-event mapping with unique event ownership.
3. Backfill one organization per existing event and copy only that event's owner/admin membership. Never auto-combine existing events.
4. Keep canonical organization CRM contacts separate from event-scoped speakers. Link them explicitly through contact-event-speaker records. Do not merge event speakers into CRM contacts inside the schema migration; use a reviewed, idempotent bootstrap that surfaces ambiguous identities.
5. Preserve Airtable authority. Do not directly overwrite authoritative event fields; use the existing pending-edit/conflict contract or link without mutation.
6. Browser organization owners/admins may access CRM data. Event membership and current event API keys do not grant CRM access.
7. Keep all contact email, notes, tags, pipeline state, segments, campaign data, and activity private and organization-filtered.
8. Implement Effect v3 service logic, validated schemas, tagged errors, operation registry, and thin transports using existing repository patterns. Use the `crm.*` operation prefix.
9. Make commands idempotent and version-guarded. Prove the guarded write won before committing success, audit activity, or idempotency results.
10. Require an explicit nonempty audience and reviewed authorization before external email. Persist exact immutable recipient/content snapshots and enqueue only the authorized version.

In the first release, permit moving an event between organizations only before it has CRM contact links or campaign dependencies. Require owner authority over source and target, preview dependency counts, and block the move once dependencies exist rather than silently transferring private CRM data.

Do not add dependencies without approval. Do not add organization API keys, public CRM APIs, CRM MCP tools, organization realtime rooms, third-party CRM sync, enrichment/scraping, or autonomous outreach in this stack.

## Execution order

Create stacked branches and ready pull requests. Preserve ancestry, merge none of them, and keep each PR focused:

1. **Organization and CRM spine** — central contracts/schema, migration and parity, organization authorization and navigation, safe backfill, event move/adoption, mail organization/campaign association, scheduler budget semantics, seed fixtures, and generated registry.
2. **Directory/profile/tags** — CRM-01 through CRM-04: contact CRUD, normalized search, multi-filter directory, profile, persistent notes/activity, cross-event history, tags, and reviewed existing-event speaker bootstrap.
3. **Import/merge** — CRM-05 and CRM-06: reviewed CSV preview/commit, row outcomes, duplicate candidates, explicit transactional merge, aliases/tombstones, idempotency, and races.
4. **Pipeline/segments** — CRM-07 through CRM-09: at least five ordered stages, persisted kanban moves, timestamped transition history/notes, and saved dynamic segments using the directory filter compiler.
5. **Handoff/campaigns** — CRM-10 and CRM-11: previewed contact-to-event handoff using shared portal rules and exact-audience reviewed organization campaigns using the existing delivery queue.
6. **Dashboard/evidence** — CRM-12 plus deterministic multi-event fixtures, browser evidence for every CRM criterion, honest evidence mappings, and rubric baseline refresh only after independent verification.

Before starting each branch, rebase/update it on the current head of the preceding branch. After a lower branch changes, update only affected descendants and validate them in order. Once a PR is merged by the repository owner, update the next branch from `main` before final validation. Never merge without explicit authorization.

## Behavior details

- Directory search covers name, email, company, and title; filters compose across tags, company/title, pipeline stage, prior event, and email presence.
- Contact detail shows identity, persistent notes, tags, linked events, sessions/talks, outreach and campaign state, pipeline transitions, and ordered activity.
- Exact normalized email is unique inside an organization. Name matches are suggestions, not automatic identity proof.
- Existing event-speaker bootstrap previews exact-email groups and contact-event links, then reports same-event duplicates and missing-email rows for explicit resolution.
- CSV import has a digest-bound preview and commit. It reports inserts, updates, skips, warnings, and errors and is replay-safe.
- Merge chooses a survivor and field values, then atomically preserves/relinks event history, tags, notes, pipeline history, segments, aliases, and campaign history.
- Pipeline starts with at least Prospect, Contacted, Interested, Confirmed, and Declined. Every move records actor, from/to, timestamp, and optional note.
- Saved dynamic segments persist normalized, versioned filter definitions and use the directory query implementation.
- Handoff targets only an event in the same organization, previews create/link/conflict behavior, is replay-safe, does not imply acceptance/publication, and respects managed identities and Airtable ownership.
- A campaign audience is an explicit selection or saved segment with a displayed resolved count. Empty selection is an error. Preview subject/body/reply-to, exclusions, and exact recipients. Authorization stores audience/content digests and timing. Reauthoring creates a new review version.
- CRM campaign sends use the account campaign budget and never consume an unrelated event's budget. Delivery attempts appear in contact activity.
- Dashboard shows total contacts, returning speakers, pipeline distribution/conversion, recent additions/outreach, top companies, and available campaign delivery summary with clear denominators/time ranges.

## Validation and evidence

For every PR, run focused tests and `pnpm check` before committing. On the final cumulative branch run:

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

Tests must include two organizations with overlapping identities, an event-only member denied CRM access, two events with a returning speaker, realistic migration data, import replay and malformed rows, relationship-preserving merge, concurrent edits/moves/merge/handoff/campaign authorization, Airtable-owned handoff, empty and invalid campaign audiences, immutable reviewed snapshots, retries/failures/budgeting, and deterministic dashboard/history ordering.

Map rubric evidence only to assertions that prove the full criterion. Do not claim full evidence for a static render, nearby service test, or manually inferred behavior. Required scores must not regress. Update the CRM gaps and baseline only after the final cumulative tests prove the new state.

## Working rules

- Read `AGENTS.md`, `PLAN.md`, the CRM section of `rubric/manifest.json`, and the relevant existing event, portal, comms, scheduler, audit, migration, and authorization implementations before editing.
- Inspect current `main` and open PR state immediately before branching.
- Preserve unrelated work and generated-file conventions. Never hand-edit `src/server/registry.gen.ts`; run `pnpm gen`.
- Use focused Conventional Commits. Push each coherent branch and open a ready PR with its correct stacked base.
- In each PR body, state the delivered CRM criteria, architectural invariants, migration/rollback implications, security boundaries, focused validation, cumulative validation status, and the next PR in the stack.
- Start or reuse one 10-minute monitor for the open stack. At current heads, check CI, reviews, and actionable unresolved threads; make the smallest focused fix on the affected branch, run proportionate validation, push, resolve addressed threads, and update descendants only when required. Never merge. Stop monitoring when all PRs are clean or the stack is closed, merged, or cancelled.
- If a schema/authority decision would materially differ from `docs/crm-implementation-plan.md`, stop and ask with the exact tradeoff. Otherwise proceed autonomously through implementation, verification, commits, pushes, ready PRs, and feedback cleanup.

## Completion report

Report:

- PR stack order, bases, branches, and current heads;
- CRM criteria delivered by each PR;
- migrations and backfill behavior;
- authorization and privacy guarantees;
- campaign review/budget behavior;
- exact validation commands and outcomes;
- resulting required and optional rubric capability/evidence/gap values;
- unresolved blockers or decisions, with the smallest next action.

Do not declare completion while any CRM criterion lacks deterministic evidence, any required score regresses, migration or tenancy validation is incomplete, CI is failing, or actionable review feedback remains.
