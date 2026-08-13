# Upgrading a self-hosted installation

Session Party is pre-1.0. Patch releases should remain backward-compatible, but minor releases may include schema, configuration, or API changes. Read the release notes and [`CHANGELOG.md`](../CHANGELOG.md) before every upgrade; pin a reviewed tag or commit rather than deploying an unreviewed moving branch.

## Safe sequence

1. Check out the target release in a clean clone and install its pinned dependencies.
2. Run `pnpm ops:upgrade-plan -- v0.x.y`. This prints the preflight, backup, validation, build, and migration-review steps without changing Cloudflare state.
3. Run `pnpm ops:preflight` against the checked-in binding declarations.
4. Complete the D1/R2 backup in [Backup and restore](backup-restore.md), including a current Time Travel bookmark.
5. Inspect every new file in `migrations/`. Confirm the changes and the maintenance window with another operator.
6. Run `pnpm check`, `pnpm test:self-hosting-template`, and `pnpm build` locally or in CI.
7. Apply remote migrations and deploy only as separately approved production actions.
8. Run `pnpm smoke:production -- https://events.example.com`, sign in as an operator, and verify one representative event, uploaded file, and scheduled-email queue.

Do not combine migration application and deployment into an unattended upgrade. The repository's `pnpm deploy` command performs both and is intended only after the plan, backup, and approval gates are complete.

## Rollback

If code fails but the schema remains compatible, redeploy the previous reviewed tag. If a migration or data change must be undone, stop writes, record the current D1 bookmark, and follow the reviewed recovery process in [Backup and restore](backup-restore.md). D1 Time Travel is an in-place destructive operation; R2 objects require the retained object copy. Never assume rolling back Worker code reverses D1 or R2 state.

Record the deployed tag, migration list, backup location, smoke result, operator, and rollback deadline in your change ticket.
