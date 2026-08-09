# Session Party Brand and Interface Direction

> **Status:** Draft — pending user visual-direction approval
>
> **Authority:** `PLAN.md` remains authoritative for product scope, architecture, workflows, privacy, and acceptance criteria. This document proposes brand and interface direction within those constraints.
>
> **Approval boundary:** The destination, document structure, requirement for a component library, and selection of **shadcn/ui with Radix Primitives** are approved. The visual direction, slogan, logo, colors, typography, motion, and component styling are not yet approved.

## Brand thesis

Session Party should feel like a product an event-production team can trust during a live program, not a generic administration template. It serves two deliberately different experiences:

1. **Backstage:** a dense, precise operations cockpit for organizers and reviewers.
2. **Front of house:** calm, event-led public and speaker experiences.

The proposed unifying idea is:

> **Backstage precision. Front-of-house delight.**

This is a working thesis, not an approved slogan.

### Working positioning

**Session Party is the open event-program operations system that carries speakers and sessions from open call to showtime.**

### Working brand promise

Every session, speaker, deadline, and publication state is visible before doors open.

### Proposed tagline

> **From open call to showtime.**

The existing product name remains the working name. This packet does not propose renaming it.

## Audience and product context

### Primary audience

Non-technical event-production staff responsible for proposals, reviews, speaker readiness, agenda construction, communications, synchronization, and publication. They need to make consequential decisions quickly and understand what remains unfinished.

### Secondary audiences

- Reviewers working through assigned tracks and submissions
- Accepted speakers completing profiles, tasks, and schedule confirmations
- Applicants submitting or revising proposals
- Public visitors viewing published speakers and schedules
- Technical operators diagnosing delivery and synchronization state

### Product constraints that shape the brand

The admin UI is the primary product. MCP is a thin test and automation transport, not a substitute for the organizer experience. The interface must remain credible at the deterministic demo scale:

- 30 speakers
- 60 submissions across `unreviewed`, `approve`, `maybe`, and `deny`
- Track-scoped reviewers
- 4 tracks
- 4 rooms
- 18 talks
- Default and optional speaker tasks

The primary walkthrough spans CFP submission, review, atomic acceptance and provisioning, speaker onboarding, readiness, agenda conflict resolution, real email and ICS delivery, resources, and publication. The interface therefore cannot optimize only for polished event pages or attractive empty states.

## Personality

### Attributes

- **Prepared:** unfinished work, deadlines, conflicts, and delivery failures stay visible.
- **Calm:** the product reduces operational anxiety rather than dramatizing it.
- **Human:** language reflects event work instead of database or integration internals.
- **Alive:** event covers, speakers, schedules, and visible progress connect the interface to a real gathering.
- **Decisive:** each decision context presents one clear primary action.

### Anti-attributes

Session Party is not:

- A consumer event-discovery network
- A playful party-planning toy
- A developer console
- A wall of decorative dashboard cards
- A visual clone of Luma or Sessionboard
- A sparse generic SaaS shell whose calmness comes from missing information

## Luma principles to borrow — and what not to copy

### Borrow

1. **Cover-led identity.** The event cover is the primary visual artifact rather than a small attachment.
2. **Compact essential metadata.** Date, time, location, timezone, and host sit close to the event title.
3. **One dominant action.** The next step receives clear visual priority.
4. **Event-specific atmosphere.** Color, cover art, and theme make each event feel authored.
5. **Progressive disclosure.** Identity and the next action precede long-form detail.
6. **Responsive stacking.** Desktop cover-and-content composition becomes a coherent single column on mobile.
7. **Cross-channel consistency.** Event or calendar color carries into email buttons and links.
8. **Accessible theme derivation.** Selected colors are adjusted to preserve contrast instead of being applied unchanged.

### Do not copy

1. **No consumer-discovery navigation in the organizer product.** Session Party is an operations tool, not an event marketplace.
2. **No card-only organizer density.** Submission triage, readiness, agenda work, and sync failures need tables, filters, bulk actions, matrices, and timelines.
3. **No decorative effects in critical operations.** Confetti, particles, patterned backgrounds, and seasonal effects do not belong in review queues or conflict resolution.
4. **No hidden operational state.** Timezones, deadlines, draft versus published state, pending synchronization, conflicts, and delivery failures remain explicit.
5. **No visual finality before acknowledgement.** Realtime progress advances only after server acknowledgement.
6. **No private-data leakage through presentation.** Public surfaces consume the privacy-filtered published projection rather than hiding private admin fields with CSS.
7. **No copying Luma’s identity or implementation.** The research supplies principles, not a mandate to reproduce Luma’s branding, navigation, effects, or component architecture.

## Visual foundations

All values in this section are candidates pending rendered review and user approval.

### Color roles

| Role | Candidate | Intended use |
|---|---:|---|
| Canvas | `#FAF9F7` | Warm application background |
| Paper | `#FFFEFC` | Cards, tables, sheets, and dialogs |
| Ink | `#1C1B18` | Primary text |
| Secondary ink | `#55524B` | Supporting information |
| Faint ink | `#8B867C` | Noncritical metadata |
| Cue violet | `#6C3BF4` | Product identity and primary action |
| Violet soft | `#F0EAFE` | Selection and low-emphasis state |
| Success | `#1A7F4E` | Confirmed, ready, delivered |
| Warning | `#8A5B00` | At risk, incomplete, approaching deadline |
| Danger | `#C92C34` | Conflict, blocking failure, destructive action |
| Backstage | Proposed `#171719` | Optional dark presentation or public-event surface |

Use tinted near-whites and near-blacks rather than pure white or black. Maintain stable semantic status colors across events.

Each event may provide one accessible accent for its public CFP, portal, gallery, schedule, and email. Event accents never redefine conflict, warning, success, pending sync, or failure.

**Open:** final brand accent, dark-surface scope, light/dark theme policy, and event-accent derivation rules.

### Typography

#### Proposed pairing

- **Instrument Sans:** titles, navigation, body, and controls
- **IBM Plex Mono:** times, rooms, tracks, deadlines, versions, and synchronization timestamps

The intended character is an event poster paired with a stage manager’s run sheet. The monospaced face remains limited to operational data so the product does not resemble a developer tool.

| Role | Candidate desktop size |
|---|---:|
| Public event title | 48–64px |
| Organizer event title | 32–36px |
| Page title | 28–32px |
| Section title | 18–20px |
| Body | 14–16px |
| Operational metadata | 12–13px mono |
| Table content | 13–14px |

If approved, self-host optimized WOFF2 assets rather than using a render-blocking third party.

**Open:** typefaces, weights, exact scale, line heights, and comparison against the current system stack.

### Spacing, radii, elevation, and borders

- Use a 4px/8px spacing base and define layout values as tokens.
- Use generous spacing on public and portal surfaces; use tighter but legible spacing in organizer tables, toolbars, and queues.
- Preserve soft, controlled radii; do not make every container a large rounded card.
- Use hairline borders, spacing, and type hierarchy for ordinary structure.
- Reserve shadows for genuinely floating menus, popovers, dialogs, and sheets.
- Let tables be their own surface; do not wrap them in repeated bordered cards.

**Open:** exact spacing scale, radii, elevation tokens, and optional admin density presets.

### Motion

- Candidate fade: 160ms
- Candidate sheet/dialog transition: 220–260ms
- Use restrained exponential or quartic ease-out motion, never bounce.
- The Cue Rail advances only after server acknowledgement.
- Every motion treatment requires a reduced-motion equivalent.

**Open:** final durations, easing curves, Cue Rail movement, and public-page effects.

## Signature visual language: the Cue Rail

The proposed signature element is a **Cue Rail**: a fine timeline carrying compact blocks, checkpoints, and state markers.

It is functional rather than decorative:

- CFP → review → acceptance → onboarding → scheduled → published
- Speaker readiness progression
- Agenda time and room alignment
- Communication and calendar-invite history
- Integration pending → confirmed → conflict transitions

```text
● Accepted ── ● Profile ── ◐ Tasks ── ○ Scheduled ── ○ Published
                 done       3 of 5      waiting
```

The Cue Rail extends the `ReadinessThread` required by `PLAN.md`; it must not become a competing component or decoration added to unrelated pages. On public pages, it may simplify into a quieter date rail or schedule marker.

**Open:** marker geometry, line weight, animation treatment, and whether the rail informs the final logo.

## Logo direction

### Proposed concept

A compact cue symbol made from offset session blocks intersected by one vertical timeline. It should suggest a run of show, multiple rooms or tracks, and work converging on one coordinated event. Pair it with a direct `Session Party` wordmark at medium or semibold weight.

### Avoid

- Microphones
- Calendar-page icons
- Tickets
- Confetti bursts
- Disco balls
- Generic sparkles

No symbol, logo form, casing, or wordmark is approved. Visual exploration is required before implementation.

## Product expressions

### Front of house

Public CFP, portal, gallery, schedule, and embeds borrow Luma’s event-first clarity:

- Large event cover
- Confident event title
- Compact date, location, timezone, and host metadata
- One primary next action
- Generous spacing
- Event-specific color
- Mobile-first stacking
- Progressive disclosure of supporting information

For speakers, the hero is the next required action rather than marketing copy:

> **Upload your slides by Tuesday**
>
> Your profile and headshot are complete.
>
> `[Upload slides]`

Public pages read only the published, privacy-filtered projection. They never expose email, private form answers, reviews, tasks, audit data, integration state, or non-public assets.

### Backstage

The organizer UI is denser and more explicit:

- Persistent selected-event identity
- Grouped event-scoped navigation
- Filters and saved views
- Tables and compact queues
- Bulk operations
- Explicit deadlines and timezones
- Conflict indicators
- Detail sheets for focused work
- Keyboard alternatives to drag-and-drop
- Pending, acknowledged, reconnecting, conflict, stale, dead-letter, and published states

The router owns the shell; route modules render page content only.

### Event imagery

- Use a square cover as the primary public identity asset.
- Use a compact crop in organizer navigation and headers.
- Give public CFP and portal surfaces more room for the cover.
- Do not use generic SaaS illustrations.
- Preserve user artwork and avoid placing uncontrolled text over it.
- When no cover exists, use a generated typographic poster based on event name, date, and accent, with a restrained cue-grid pattern.
- Carry approved event-accent treatment into communications.

**Open:** final aspect ratios, crop behavior, fallback-poster templates, supported media formats, and whether derived color comes from an explicit accent or image sampling.

## Component foundation

### Approved decision

Use **shadcn/ui with Radix Primitives** as the single accessible component foundation.

- Radix supplies behavior for dialogs, sheets, menus, selects, tabs, tooltips, popovers, focus management, keyboard navigation, and focus restoration.
- shadcn/ui supplies source-owned component implementations that can be adapted to Session Party tokens rather than imposing a vendor theme.
- `src/ui/index.ts` remains the only feature import boundary. Feature slices import exclusively from `@/ui`.
- Replace the current handwritten interaction primitives behind that boundary; do not maintain parallel dialog, sheet, tabs, button, field, or menu systems.
- Do not combine Radix with a competing primitive library.
- Complex tables, agenda movement, and domain workflows remain Session Party composites built on the shared foundation.

Before freezing the UI contract, run a rendered integration spike covering:

1. Event-switcher popover
2. Mobile navigation sheet
3. Submission detail sheet
4. Keyboard-accessible tabs
5. Agenda move menu
6. Form field with validation and description

Verify keyboard behavior, screen-reader semantics, visual control, bundle output, React 19 behavior, and migration cost. The spike validates the integration; it does not reopen the package decision unless it reveals a blocking incompatibility.

### Required domain composites

Build these `PLAN.md` composites on Radix-backed shadcn components and Session Party tokens:

- `EventIdentityHeader`
- `StatusBadge`
- `FilterBar` / `DataToolbar`
- `DetailSheet`
- `FormRenderer` / `FormFieldEditor`
- `ReadinessThread` / `ProgressChecklist`
- `AgendaBoard` / `ConflictIndicator`
- `SpeakerGallery` / `ScheduleList`
- `SyncStatusCard`

Feature slices must not invent competing buttons, badges, dialogs, sheets, tab systems, or status vocabularies.

### Component character

- Use one bordered surface per content grouping; do not nest visually equivalent cards.
- Let tables be their own surface and reserve shadows for floating elements.
- Use one violet primary action per decision context and neutral secondary actions.
- Isolate destructive actions and label their consequence.
- Reveal selection-scoped bulk actions only after selection.
- Combine a plain-language status label, shape or icon, color, and optional timestamp or explanation. Never rely on color alone.

## Content voice

The voice is concise, operational, and reassuring. Name the user’s task and the system’s actual state; avoid internal nouns and generic success/error labels.

| Avoid | Prefer |
|---|---|
| Submit | Send proposal |
| Complete task | Upload slides |
| Entity synchronization failed | Airtable could not confirm this change |
| No data available | No proposals yet |
| Error processing request | We couldn’t save this change. Try again. |
| Pending | Waiting for Airtable |
| Success | Invite delivered |
| Publish | Publish schedule |

An empty state answers what belongs here, why it is empty, and what the user should do next.

## Accessibility and responsive behavior

### Accessibility requirements

- Target at least WCAG 2.2 AA unless the user sets a stronger target.
- Maintain text, icon, border, and focus-indicator contrast across brand and event themes.
- Derive accessible event accents rather than trusting arbitrary input unchanged.
- Never communicate status through color alone.
- Provide persistent, visible focus treatment.
- Restore focus after dialogs, sheets, and menus close.
- Connect field labels, descriptions, required state, and errors programmatically.
- Support complete keyboard operation for menus, tabs, bulk selection, detail sheets, and agenda movement.
- Provide non-pointer alternatives to agenda drag-and-drop.
- Use semantic tables for tabular data and preserve meaningful reading order when layouts collapse.
- Announce saved, failed, reconnecting, and server-acknowledged state without stealing focus.
- Respect reduced motion and avoid movement that implies unacknowledged completion.
- Keep touch targets usable on mobile without inflating dense desktop rows.
- Ensure public surfaces consume the privacy-filtered projection rather than relying on visual hiding.

### Responsive behavior

- Public and portal experiences stack to one coherent column on mobile, preserving event identity and the primary next action near the top.
- The organizer shell becomes a keyboard- and screen-reader-accessible mobile navigation sheet.
- Dense tables do not silently become repetitive card grids. Use horizontal overflow, column priority, responsive disclosure, or focused detail views according to the task.
- Agenda movement remains possible without a large pointer canvas.
- Timezone context remains visible when date/time layouts compact.

**Open:** final WCAG target, detailed keyboard models, breakpoints, dense-table mobile strategy, and timezone presentation policy.

## Do / don’t

| Do | Don’t |
|---|---|
| Lead public surfaces with the event cover and essential metadata. | Recreate Luma’s consumer discovery experience. |
| Give each decision context one clear primary action. | Style every action as primary. |
| Use tables, filters, matrices, and timelines for operations. | Force dense work into identical cards. |
| Keep deadlines, timezones, conflicts, sync, and publication state explicit. | Hide operational complexity to make screenshots look cleaner. |
| Use the Cue Rail where progression is real and useful. | Scatter timeline decoration across unrelated pages. |
| Reuse one token vocabulary and the shadcn/Radix foundation. | Mix competing primitive libraries or parallel controls. |
| Use semantic label + shape/icon + color for status. | Depend on color alone. |
| Preserve event-specific identity on public and portal surfaces. | Let event accents redefine success, warning, or failure. |
| Reserve shadows for floating surfaces. | Nest card inside card or shadow every container. |
| Advance realtime progress only after server acknowledgement. | Animate success before the mutation is confirmed. |
| Guide users from empty and error states. | Say only “Nothing here” or “Something went wrong.” |
| Offer keyboard alternatives for agenda operations. | Make drag-and-drop the only path. |

## Implementation mapping

This sequence is guidance, not authorization to edit code.

1. **Approve the visual direction**
   - Brand thesis and tagline
   - Logo exploration brief
   - Color and typography direction
   - Cue Rail
   - Public-versus-admin split
2. **Establish the approved component foundation**
   - Add the minimum shadcn/Radix dependencies centrally
   - Run the six-pattern integration spike
   - Map shadcn components to Session Party tokens
   - Migrate callers cleanly and remove overlapping primitives
3. **Freeze the interface contract**
   - Tokens, primitive APIs, status vocabulary
   - Focus, keyboard, responsive, and `AppShell` behavior
4. **Recompose the application shell**
   - Selected-event identity, grouped navigation, mobile navigation, global feedback
5. **Create three showcase experiences**
   - Events home, event operations overview, public CFP
6. **Build the shared domain composites**
   - Event identity, status, toolbar, detail sheet, readiness, agenda, conflict, publication, sync
7. **Design credible full states**
   - 60-submission queue, 30-speaker matrix, 4-track/4-room agenda, delivery/sync failures
8. **Complete state and accessibility behavior**
   - Loading, empty, error, retry, disabled, acknowledgement, reconnecting, keyboard movement, reduced motion, and mobile routes

Where this packet conflicts with `PLAN.md`, `PLAN.md` wins until the user explicitly changes the product specification.

## Validation checklist

A direction is ready for implementation only when it demonstrates:

- Events home with zero and several events
- Cover-led event identity
- Full organizer shell at desktop and mobile widths
- 60-submission track-scoped triage without card-grid collapse
- Four-status review flow
- Speaker readiness at one-speaker and 30-speaker scale
- Agenda backlog, conflicts, and non-pointer movement
- Explicit timezone treatment
- Working-versus-published agenda distinction
- Real email and valid ICS evidence in the release workflow
- Airtable pending, confirmed, conflict, stale, and dead-letter states only when demonstrating the bonus integration
- Speaker portal next action
- Mobile CFP
- Mobile speaker and schedule embeds
- Keyboard-only completion
- Screen-reader semantics
- Reduced motion
- No exposure of reviews, email, tasks, audit, integrations, or private assets on public surfaces

Accelevents is optional post-deadline work and is not a brand-system acceptance requirement.

## Open decisions

- Final brand thesis and tagline
- Logo and wordmark
- Primary brand accent
- Dark-surface scope
- Typography and type scale
- Light/dark theme policy
- Event-accent derivation
- Cover ratios and fallback-poster system
- Cue Rail geometry and motion
- Canonical status vocabulary
- Admin density presets
- Responsive breakpoints and dense-table mobile strategy
- Timezone presentation policy
- WCAG conformance target and detailed keyboard models
- Final spacing, radii, elevation, and motion tokens

None of these are implied approved by approval of this document’s destination, format, or component foundation.

## Approval history

| Date | Decision | Status |
|---|---|---|
| 2026-08-08 | Research a stronger visual direction grounded in Luma, the repository specification, and the supplied competition brief. | Requested |
| 2026-08-08 | Prepare a brand packet. | Requested |
| 2026-08-08 | Use repo-local `docs/brand.md` as the canonical destination, keep `PLAN.md` authoritative, and add a pointer under `PLAN.md` → `## UX plan`. | Approved |
| 2026-08-08 | Use a proper component library. | Approved |
| 2026-08-08 | Standardize on shadcn/ui with Radix Primitives behind the `@/ui` boundary. | Approved |
| 2026-08-08 | Brand thesis, logo, colors, typography, Cue Rail, imagery, motion, and other visual choices in this packet. | Draft; not yet reviewed or approved |

## Sources

Accessed **2026-08-08** unless otherwise stated.

### Repository and supplied brief

- `PLAN.md`, especially the UX plan, information architecture, UI freeze, local UI scenarios, feature acceptance, and demo sections.
- `_10_0000 Kill My SaaS - Competition Brief.pdf`, supplied by the user; high-level requirements and included Sessionboard reference screenshots. No public source URL was supplied.

### Luma

- Luma homepage: https://luma.com/
- Representative public event page inspected during research: https://luma.com/b12bierh
- Luma Help, “Creating an Event”: https://help.luma.com/p/creating-an-event
- Luma Help, “Event Themes and Customization”: https://help.luma.com/p/event-themes-and-customization
- Luma Help, “Adding Hosts and Managers to Your Event”: https://help.luma.com/p/adding-hosts-and-managers-to-your-event
- Luma Help, “How to Promote Your Event and Grow Attendance”: https://help.luma.com/p/promote-your-event

### Source-use note

Luma sources establish observed interaction and presentation principles, not a requirement to copy Luma’s branding, component implementation, navigation, theme effects, or consumer-discovery model. Repository requirements and the user’s eventual visual approvals control Session Party’s design.
