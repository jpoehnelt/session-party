# Self-hosting operations

This runbook covers the routine work around a Session Party installation. Start each maintenance window with:

```bash
pnpm ops:preflight
```

The preflight validates the checked-in D1/R2 bindings, required-secret declarations, Workers observability setting, and contiguous migration files. It does not contact Cloudflare or reveal secret values.

## Cost and service constraints

Cloudflare prices and limits change; confirm the linked pages before budgeting.

- Sending magic links or event email to arbitrary recipients requires Workers Paid. Cloudflare currently includes 3,000 outbound messages per account each month, then charges per thousand; see [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/). A self-hosted installation without arbitrary-recipient email cannot support normal passwordless sign-in.
- D1 bills rows read, rows written, and stored data and scales to zero; current Free and Paid allowances are in [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
- R2 Standard currently includes a monthly free tier for storage and operations, with no direct egress charge; backup copies still consume operations and destination storage. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- Worker requests, CPU, Durable Object storage/alarms, and logs are separately metered under [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Set account budgets or notifications appropriate to your plan, and inspect D1, R2, Worker, Durable Object, and Email usage after a representative event.

## Email

Onboard and verify the sending domain before go-live. `MAIL_FROM` must use that domain. Keep message size and recipient limits in mind; Cloudflare's current limits are documented in [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/). Session Party uses passwordless email, so verify magic-link delivery, suppression/bounce behavior, and the reply-to address from an external mailbox.

## Logs and alerts

Workers observability is enabled in `wrangler.jsonc`. Use **Workers & Pages → Worker → Logs** for errors, uncaught exceptions, and structured application logs. Cloudflare currently retains Workers Logs for 3 days on Free and 7 days on Paid; export logs if your audit or incident policy requires longer retention. See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

Create and test Cloudflare Notifications for available service incidents, traffic/error-rate changes, billing, and security events. Delivery options depend on the account plan; see [Configure Notifications](https://developers.cloudflare.com/notifications/get-started/). During a live event, assign a person to watch Worker error rate, D1 failures, mail dead letters/retries, and storage usage.

## Secret rotation

Store secrets only with Cloudflare's secret management, never in `wrangler.jsonc`, logs, screenshots, or tickets.

- `SESSION_SECRET`: rotating it invalidates deployment-bound bearer hashes, including active sessions and outstanding magic links. Announce a sign-in interruption and keep the prior value only in your approved secret manager for the rollback window.
- `TURNSTILE_SECRET`: rotate it together with the matching site key/hostname configuration and test a public submission.
- `ACCELEVENTS_API_TOKEN` and `AIRTABLE_PAT`: rotate at the provider, update the Worker secret, test the integration with least privilege, then revoke the old credential.

Never print secret values during verification. Confirm only that the named secret exists.

## Retention and troubleshooting

Choose retention periods for proposal data, speaker files, audit history, mail evidence, logs, and backups based on your legal and event requirements. Document deletion ownership and test recovery quarterly. The application does not replace an organizational retention policy.

For incidents:

1. Record the deployed tag, request IDs, affected hostname/event, and start time.
2. Check Workers Logs and Cloudflare service status before changing data.
3. Run the read-only `pnpm ops:preflight` and `pnpm smoke:production -- https://events.example.com` checks.
4. If an upgrade is involved, stop and use [Upgrading](upgrading.md). If data is involved, preserve the current bookmark and use [Backup and restore](backup-restore.md).
5. Avoid repeated retries of sends, migrations, imports, or binding changes until their idempotency and impact are understood.
