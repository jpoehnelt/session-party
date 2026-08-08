# SmolForge Friction Log

Repository: `jpoehnelt/session-party`

Purpose: record observed setup, authentication, Actions, agent, transcript, preview, and deployment friction while adopting SmolForge. Entries distinguish Forge product behavior from browser-automation or local-tooling behavior.

## 2026-08-08

### SF-001 — CLI absent despite Forge remote

- Area: local setup
- Severity: low
- Classification: setup friction
- Observed: the repository already used `https://forge.smol.ai/jpoehnelt/session-party.git` as `origin`, but `sf` was not installed.
- Impact: local capability and configuration inventory was unavailable until a separate global install.
- Resolution: installed `@smolai/forge` globally. npm linked `sf` and `smolforge` through the local Vite+ shim directory.
- Follow-up: consider surfacing CLI installation and `sf auth status` more prominently on repository onboarding.

### SF-002 — `sf auth login --help` attempted authentication

- Area: CLI discoverability
- Severity: medium
- Classification: probable CLI defect
- Observed: `sf auth login --help` returned `Password was not provided on stdin` instead of command help.
- Impact: the normal safe discovery path unexpectedly entered login validation and did not explain available authentication flags.
- Workaround: use `sf help`, the published `llms.txt`, or browser-based repository authentication instructions.
- Follow-up: make `--help` side-effect free for every subcommand.

### SF-003 — Browser authentication and CLI authentication are separate

- Area: authentication
- Severity: low
- Classification: intentional boundary with workflow cost
- Observed: signing into Forge in the browser did not change `sf auth status`; the CLI remained unauthenticated.
- Impact: an agent needs a second repository-scoped PAT setup step before it can use authenticated CLI/API operations.
- Positive: the boundary prevents browser session credentials from leaking into Git or terminal contexts.
- Follow-up: after browser sign-in, present a direct, persistent path to create and install the least-privilege repository PAT.

### SF-004 — Git / Agent Auth panel was not consistently discoverable

- Area: repository authentication UI
- Severity: medium
- Classification: mixed Forge UI / browser-automation friction
- Observed: the `Git / Agent Auth` control appeared on some repository pages, disappeared on another render, and an initial click produced no visible dialog. Opening it from the authenticated Actions page eventually worked and exposed the repository-scoped token flow.
- Impact: setup required repeated navigation and snapshots.
- Workaround: open the authenticated repository Actions page and use `Git / Agent Auth` there.
- Follow-up: keep the control stable across repository pages and provide a direct URL for the setup panel.

### SF-005 — Repository code view reported `Path not found`

- Area: repository browser
- Severity: medium
- Classification: probable Forge UI/data defect
- Observed: the repository page listed `AGENTS.md` and `LICENSE` but also rendered `Error: Path not found`, both before and after authentication.
- Impact: the default code view did not provide a reliable repository inventory.
- Workaround: use local Git or navigate to specific repository sections.
- Follow-up: inspect default-tree/path resolution for repositories whose Forge `main` is behind a local checkout.

### SF-006 — No consolidated repository capability inventory

- Area: administration
- Severity: medium
- Classification: product workflow friction
- Observed: Actions, Sites, transcripts, branches, repository-agent access, and general settings required separate pages. The browser session could not be reused by a plain same-origin `fetch('/api/accounts')`, which returned 401 because application authentication lives outside cookies.
- Impact: establishing the current integration state required multiple page visits and manual correlation.
- Workaround: inspect Actions, Sites, Transcripts, Branches, and Settings individually.
- Follow-up: add a repository readiness page showing enabled capabilities, quotas, workflows, preview policy, transcript coverage, agent availability, and deployment state.

### SF-007 — Workflow editor navigation was unreliable under automation

- Area: Actions
- Severity: medium
- Classification: browser-automation friction; Forge save succeeded
- Observed: clicking `New workflow` and `Create workflow` initially appeared to leave the browser on the Actions page. Reading the link target and navigating directly to `/actions/workflows/new` opened the editor. The save click timed out, but the workflow was created successfully after the page settled.
- Impact: workflow creation appeared broken until the direct route and delayed save result were inspected.
- Workaround: navigate directly to the link target, enter text with keyboard events rather than DOM-only fill events, and re-snapshot after save timeouts before retrying.
- Resolution: created the `Integration` workflow successfully; Forge reported one detected job and safe exact-cache reuse.
- Follow-up: improve navigation/save progress feedback and correlate click timeouts with the Paseo browser host before attributing them to Forge.

### SF-008 — Browser automation host intermittently timed out

- Area: test harness
- Severity: medium
- Classification: browser-automation friction, not yet attributed to Forge
- Observed: one repository-link click, one text wait, and one screenshot attempt timed out or reported that the tab had not painted. Retrying navigation or taking a new snapshot recovered.
- Impact: Forge UI adoption took additional retries.
- Workaround: direct navigation plus fresh snapshots.
- Follow-up: correlate Forge page load/network timing with Paseo browser-host logs before assigning this to Forge.

## Current observed Forge state

- Repository visibility: unlisted.
- Remote Forge branch: `main` at `22e12d1`; local checkout is ahead.
- Actions: zero workflows and zero runs.
- Sites: Forge Deploy Alpha available; no deploy project configured.
- Transcripts: zero captured sessions.
- Branches: one branch, `main`.
- Repository agent: UI entry point is present.
- Local CLI: installed, not authenticated.

## Entry template

### SF-NNN — Short title

- Area:
- Severity: low | medium | high | blocking
- Classification: Forge product | local tooling | browser automation | documentation | unknown
- Observed:
- Impact:
- Workaround:
- Resolution:
- Follow-up:
