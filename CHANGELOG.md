# Changelog

All notable changes to Session Party are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the additional pre-1.0 compatibility policy in [`docs/upgrading.md`](docs/upgrading.md).

## [Unreleased]

### Added

- Read-only preflight and plan-first backup, recovery, and upgrade tools for self-hosted installations.
- An independent-template CI test covering configuration rendering, D1 migrations, R2, and Durable Objects.
- Operator documentation for costs, email, observability, secret rotation, retention, recovery, and upgrades.

### Security

- Restore plans require explicit new resource names and clearly identify every remote mutation.

## [0.1.0] - 2026-08-12

### Added

- Initial pre-1.0 Session Party application and Cloudflare self-hosting flow.

[Unreleased]: https://github.com/jpoehnelt/session-party/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jpoehnelt/session-party/releases/tag/v0.1.0
