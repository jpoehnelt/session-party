# Visual regression

Session Party keeps independent reg-suit baselines for Storybook stories and rendered application pages. The workflow runs for pull requests, every push to `main`, and manual dispatches.

## Surfaces

- `pnpm visual:stories:capture` runs the Storybook browser suite and writes PNGs to `screenshots/`. Argos is used only as the screenshot engine; uploads are disabled.
- `pnpm visual:pages:capture` writes full-page captures to `screenshots-pages/`. Start the local application from a reset database and run `pnpm demo:hydrate` before this command.
- `pnpm visual:stories:compare` and `pnpm visual:pages:compare` compare and publish their respective captures through reg-suit.

The page suite freezes the browser clock, disables motion, waits for fonts and stable layout, rejects HTTP errors and login redirects, and uses the seeded owner, reviewer, and speaker sessions.

## R2 configuration

Configure these GitHub Actions secrets:

- `REG_S3_BUCKET_NAME`
- `REG_S3_ENDPOINT`
- `REG_S3_ACCESS_KEY_ID`
- `REG_S3_SECRET_ACCESS_KEY`

Configure these GitHub Actions variables:

- `REG_S3_CUSTOM_DOMAIN`
- `REG_S3_REGION` (defaults to `auto`)

The bucket must allow public reads through the configured custom domain. Storybook reports and baselines use the `storybook/` prefix; page reports and baselines use `pages/`.

When storage is not configured, capture and artifact upload still run, while comparison and publication are skipped. GitHub statuses and sticky pull-request comments are informational; they are not configured as branch-protection requirements.

When a comparison needs review, its sticky pull-request comment includes an **Approve screenshots** checkbox. Checking it approves only the SHA embedded in that comment, and only collaborators with write, maintain, or admin access may approve. A new push creates a new SHA-bound checkbox, so earlier approvals cannot carry forward.

## First baseline

The first pull request may report a missing baseline. Once this workflow lands, its `main` run publishes complete baselines under that commit SHA. Subsequent pull requests compare their merge result with the baseline stored for the current base SHA.
