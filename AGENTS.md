# Repository Guidelines

- Keep changes focused and preserve unrelated work.
- Run `pnpm check` before committing (integrator runs full suite; slice agents skip it).

## Project: session-party

Open-source Sessionboard replacement (Cloudflare Workers + Effect + PartyServer + D1/Drizzle). Read `PLAN.md` first — it is the authoritative architecture doc.

### Ownership (STRICT — enables massive parallel agent work)

- Slice agents write ONLY inside `src/features/<their-slice>/` (+ that slice's tests).
- FROZEN, integrator-only: `contracts/`, `migrations/`, `src/ui/`, `src/server/`, `src/client/`, root configs. Never edit these; if a schema/contract gap blocks you, report it and continue with what's buildable.
- Never hand-edit `src/server/registry.gen.ts` — run `pnpm gen`.

### Delivery

- Once an implementation branch has one coherent, focused commit, its agent pushes the branch and opens a ready pull request against `main`.
- The coordinator owns root-config integration, review, sequencing, and merges.
- Merge green pull requests one at a time; update the next branch from `main` before its final validation.

### Conventions

- Server code is **Effect v3**: validate all external input with `effect/Schema` (`contracts/types.ts`), fail with tagged errors from `contracts/errors.ts` only, obtain capabilities via services from `src/server/services.ts`. Copy patterns from the canonical slice `src/features/events/` — do not invent Effect idioms.
- Client code is plain React 19 + react-router + Tailwind 4. Import UI exclusively from `@/ui` — never write one-off styled primitives or new global CSS.
- Slice layout: `service.ts` (Effect domain logic) → thin `api.ts` (Hono router, default export) + `tools.ts` (`export const tools: ToolDef[]`) + optional `party.ts` (realtime handlers) + `routes/*.tsx` (client pages) + `components/`.
- Paths: `@/*` → `src/*`, `contracts/*` → `contracts/*`. API mounts under `/api/v1` per `contracts/routes.ts`.
- No new dependencies without integrator approval. No formatters/linters/full test suite in slice work.

### Commands

- `pnpm dev` — vite dev server (Worker + client, local D1/R2/DOs)
- `pnpm db:migrate:local` — apply migrations to local D1
- `pnpm gen` — regenerate feature registry
- `pnpm check` — typecheck all projects + registry freshness
- `pnpm test` — vitest (workers pool)
