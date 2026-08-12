# Session Party walkthrough recorder

This directory defines a repeatable, synthetic-account walkthrough of the live Session Party demo for a technical hackathon audience. The intended result is a polished 6–8 minute architecture-led product tour and a 60–90 second submission cut assembled from independent scene recordings.

## Story

The recording follows one connected record through the product:

1. Organizer configures and publishes a structured CFP.
2. Reviewer evaluates an assigned proposal with a rubric and optional, non-authoritative AI assistance.
3. Organizer accepts the proposal.
4. Speaker completes profile, task, and upload work in the portal.
5. Organizer turns the accepted proposal into a conflict-checked scheduled talk.
6. A PartySocket client drives ready, running, held, and resumed state through a per-event PartyServer Durable Object; a full reload proves reconnect-safe persistence.
7. Organizer publishes an immutable program revision.
8. An anonymous visitor sees the responsive schedule, speakers, embeds, and feeds.

The detailed cut demonstrates operations rather than merely visiting routes: the organizer filters readiness, opens retained content versions, inspects delivery history and integration state; the public CFP is filled through a conditional branch; the reviewer can apply a labeled AI draft while the human save remains the commit boundary; the speaker sees persisted task and cross-role file state; publication exposes the stable-widget refresh boundary; and the attendee searches for the same talk and adds it to a browser-local itinerary. The PartyServer live-show scene performs the reversible write/reconnect workflow; shared publication and speaker fixture records are not mutated merely for a recording take.

The detailed timing, narration, visual beats, and short-cut edit are in [`narration.json`](./narration.json). The full cut targets 410 seconds; the short cut targets about 80 seconds. The assembled video opens with a five-second, 50-view flipbook across the recorded product surfaces: centered static frames at ten cuts per second, with no banner, labels, pan, chapter cards, or transition effects. Detailed scenes hold still after their authored interaction instead of adding filler movement; authored page changes use immediate positioning rather than animated scrolling. Every detailed scene carries a persistent technical trace naming the replaced SaaS, registered operation, state primitive, and behavioral guarantee; the trace is cleared only after the relevant interaction finishes.

## Safety and account requirements

- Use only the application's visible synthetic demo-role sign-in controls for Organizer, Reviewer, and Speaker.
- Never place real passwords, magic links, cookies, tokens, email addresses, or copied browser storage in this directory or in captured output.
- Start every role-specific scene in a fresh browser context. Do not reuse a saved authenticated state file.
- Use the AI Engineer Sandbox and its recognizable synthetic records, including `Taming 40-Minute CI`, Priya, and `Platform & Infra`.
- Keep mutating scenes idempotent. Prefer an existing canonical record; otherwise create a run-labeled synthetic record and reuse or clean it on the next run.
- Do not record browser chrome containing personal bookmarks, extensions, other tabs, notifications, or account information.
- The video must state that human verification, including Turnstile, is disabled for this hackathon demo so automated synthetic submissions can run, and that it can be re-enabled for production.

## Recording requirements

- Node.js and the repository's pinned `pnpm` toolchain.
- Playwright and its project-pinned Chromium browser; do not add or silently download a second automation stack.
- `ffmpeg` and `ffprobe` available on `PATH` for normalization, concatenation, captions, and final validation.
- Network access to the configured demo base URL, normally `https://sessionparty.com`.
- A clean output directory with enough space for per-scene WebM recordings, traces, screenshots, and the final MP4 files.

Record at 1920×1080 when practical, with a 16:9 viewport and consistent device scale. Each scene should:

1. Start from its explicit URL in a fresh context.
2. Sign in through the visible demo-role UI when authentication is required.
3. Wait for a stable named landmark before acting.
4. Use accessible labels and roles for selectors rather than coordinates.
5. Show a cursor halo or target highlight for important actions.
6. Keep recorder annotations visually separate from the product: cyan and white over a dark slate panel, with the rest of the page dimmed during a spotlight.
7. Hold the completed state for at least two seconds.
8. Save a trace and final screenshot when any step fails.
9. Close its context so Playwright finalizes the scene video.

Scenes are intentionally independent. A failure in review should not invalidate a usable CFP clip, and a slow public page should not force a new seven-minute take.

## Expected commands

The recorder exposes these repository-level entry points:

```sh
pnpm walkthrough           # record every scene, then assemble both cuts
pnpm walkthrough:record
pnpm walkthrough:assemble
```

Useful runtime options should be passed as environment variables, with safe defaults:

```sh
WALKTHROUGH_BASE_URL=https://sessionparty.com \
pnpm walkthrough:record -- --output=artifacts/walkthrough
```

No credential environment variables should be needed. Use `pnpm walkthrough:record -- --scene=review` for a fast scene retry; the recorder replaces that scene in an existing manifest without discarding the others. Use `--smoke` to skip authored hold times during selector preflight. The default run records every scene in narration order; a failing scene is skipped after saving its diagnostics, the remaining scenes still record, and the run exits non-zero listing the scenes to retry.

## Output contract

A successful run should produce:

```text
artifacts/walkthrough/
├── scenes/
│   ├── intro.webm
│   ├── workspace.webm
│   ├── cfp.webm
│   ├── review.webm
│   ├── speaker_portal.webm
│   ├── agenda.webm
│   ├── live_show.webm
│   ├── publication.webm
│   └── widgets_and_close.webm
├── screenshots/
│   └── <scene-name>.png            (<scene-name>-failure.png on failure)
├── traces/
│   └── <scene-name>.zip            (<scene-name>-failure.zip on failure)
├── manifest.json
├── session-party-walkthrough.srt
├── session-party-walkthrough-short.srt
├── session-party-walkthrough.mp4
└── session-party-walkthrough-short.mp4
```

The main MP4 is 1080p H.264 with a soft English subtitle track. This automated cut intentionally has no generated voice; `narration.json` and the exported SRT files are ready for a separately recorded voiceover. The short cut is assembled from the scene timings instead of being recorded as a second browser run. Captions remain useful without audio and match the final edit.

## Preflight and final verification

Before recording, confirm that the deployed demo is healthy and the canonical proposal, speaker, headshot, track, agenda, and public publication records are present. Browser-assisted exploration is appropriate for this one-time preflight; the deliverable itself should be produced by deterministic Playwright scenes.

Before handing off a video, verify with `ffprobe` that both MP4 files open, have video streams, use the intended dimensions, and fall within their target duration ranges. Then watch the full cuts once at normal speed and confirm:

- no loading, error, or empty state is accidentally presented as success;
- the same proposal and speaker story remains recognizable across roles;
- the uploaded headshot renders after reload in both portal and organizer views;
- the selected track carries into the agenda without re-entry;
- conflict validation and zero blocking conflicts are visible;
- live-show state moves through ready, running, held, and resumed, survives a full page reload, and is reset afterward;
- the anonymous schedule and speaker pages require no signed-in state;
- the verification disclosure is audible or visible in captions;
- no personal data or real credentials appear in frames, audio, traces, or filenames.
