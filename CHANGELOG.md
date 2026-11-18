# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-18

### Added

- Reads `GET /v1/quota?model=<name>` on the gateway of the platform provider (the
  origin of its `baseURL`) for each of its models: at most once per minute and per
  model for the whole process, plus once after a model response ends, with the same
  floor. Errors back off up to 15 min; a 404 parks the model for an hour.
- Display as a state rather than raw percentages: normal or low priority, with the
  time back to normal, for a soft budget; daily, hourly and weekly hard caps;
  per-minute caps above 80%; requests in flight from 12 of 16.
- OpenCode v2 (2.0.25 and later): token from the host connection
  (`ctx.integration.connection`); snapshot and toasts sent over RPC to a TUI part
  that adds a status line after `prompt.footer.status`, toasts on state changes and
  `/quota`; a `quota` tool.
- OpenCode v1 (1.17 and later): toasts on state changes (`client.tui.showToast`) and
  the `quota` tool; token from opencode-keycloak-auth's token source
  (`patches/opencode-keycloak-auth-token-source.diff`).
- `OPENCODE_QUOTA_LOG_FILE`, since OpenCode v2 shows plugin console output nowhere.
- End-to-end tests against OpenCode 1.17.11, 1.19.6, 2.0.25 and 2.3.2
  (`npm run test:e2e`).
