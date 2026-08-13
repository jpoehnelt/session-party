# Walkthrough v2

Walkthrough v2 records independent proof shots and trims all authentication, navigation, loading, and pre-positioning before assembly. The final body stays at normal speed. Only the roughly four-second opening is accelerated. Its 50 frames come from 50 dedicated routes or visibly distinct UI states; the recorder rejects pixel-identical captures instead of cycling the body shots.

```sh
pnpm walkthrough:v2
pnpm walkthrough:v2:record -- --smoke
pnpm walkthrough:v2:record -- --shot=review-workbench
pnpm walkthrough:v2:record -- --opening-only
pnpm walkthrough:v2:record -- --opening-only --opening-from=48
pnpm walkthrough:v2:assemble
```

The full run writes to `artifacts/walkthrough-v2/` and does not overwrite the original walkthrough. Each retained shot shows one action, its registered operation or realtime message, and the state guarantee demonstrated on screen. Setup footage remains available under `raw/` for diagnosis but never enters the assembled video. A failing shot is skipped after saving its diagnostics, the remaining shots still record, and the run exits non-zero listing the shots to retry with `--shot=<id>`; retried shots replace their manifest entries without discarding the others.

Pacing constraints:

- normal speed after the opening montage;
- no retained login, loading, navigation, or scrolling;
- six to twenty-four seconds per proof shot;
- at least three seconds on important results;
- no chapter cards or animated transitions;
- opaque signal-orange technical traces, limited to action, operation, and state.
