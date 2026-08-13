# Backup and restore

Back up D1 and R2 together before every upgrade and on a regular schedule. Keep at least one copy outside the Cloudflare account that runs Session Party. The repository commands print reviewed command plans; they never execute remote mutations themselves.

## Create a backup

Run the preflight, then print the timestamped backup plan:

```bash
pnpm ops:preflight
pnpm ops:backup-plan
```

The plan contains three read-only remote operations:

1. Record the current D1 Time Travel bookmark with `wrangler d1 time-travel info`.
2. Export schema and data with `wrangler d1 export DB --remote --output=.../d1.sql`.
3. Copy every object from R2 to independent storage with `rclone copy r2:BUCKET .../r2 --checksum`.

Copy the printed argument arrays into your operator shell only after checking the resource names and destination. Create the local destination first and store the bookmark beside the SQL export. Cloudflare's [D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) blocks database requests while it runs and may lose precision for very large integers, so schedule it away from a live event and verify the resulting file. Configure `rclone` with a least-privilege R2 token by following Cloudflare's [R2 rclone guide](https://developers.cloudflare.com/r2/examples/rclone/); never commit its credentials.

D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is always on for production-backend databases. Its restore window is currently 7 days on Workers Free and 30 days on Workers Paid. The SQL export is the long-retention copy; Time Travel is the fast rollback point.

## Restore without overwriting production

Provision a **new** D1 database and R2 bucket. Then print a restore plan with explicit recovery resource names:

```bash
pnpm ops:restore-plan -- backups/2026-08-12T08-00-00Z session-party-recovery session-party-recovery-files
```

The tool rejects shell expressions in resource names and labels every restore step as destructive. Review and run the printed D1 import and R2 copy commands. Then:

1. Bind the recovery resources in a temporary Worker or local checkout.
2. Run `pnpm ops:preflight`, `pnpm smoke:production -- https://recovery.example.com`, and a manual organizer sign-in/file-download check.
3. Compare row counts and R2 object counts with the backup evidence.
4. Switch production bindings only in a reviewed deployment with an agreed rollback window.

Do not import into the current production database or bucket. A direct `wrangler d1 time-travel restore` also overwrites D1 in place and cancels in-flight queries; use it only during an approved incident after recording the current bookmark. Cloudflare documents the exact destructive behavior and undo bookmark in the [Time Travel restore guide](https://developers.cloudflare.com/d1/reference/time-travel/#restore-a-database).

## Recovery drill

Quarterly, restore the newest retained backup into throwaway recovery resources, run the checks above, record duration and discrepancies, then remove the resources through your normal reviewed account process. A backup is not proven until it has been restored.
