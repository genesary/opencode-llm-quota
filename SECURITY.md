# Security policy

This plugin sends the user's Keycloak access token to the platform gateway, so a leak of that token is
the main risk we guard against.

## Supported versions

Only the latest released `0.x` version receives security fixes. Please upgrade before reporting.

| Version      | Supported |
| ------------ | --------- |
| latest `0.x` | yes       |
| older        | no        |

## Reporting a vulnerability

Do not open an issue for a security problem. Open a draft security advisory from the repository's
Security tab ("Advisories", then "New draft security advisory"), or contact the maintainers directly.
Include:

- what the issue is and its impact,
- how to reproduce it (a minimal config if possible),
- the affected versions.

We aim to acknowledge reports within a few days and to agree on a fix and disclosure timeline with you.

## Scope and hardening

- The plugin handles no login and reads no Keycloak secret. On OpenCode v2 the token comes from the
  host connection; on v1, from opencode-keycloak-auth's token source.
- The token is sent only to the origin of the platform provider's `baseURL`, the host LLM requests
  already go to. Non-http(s) URLs and redirects are refused.
- Neither the token nor a `/v1/quota` body is logged. Error bodies are not read.
- The TUI part never receives the token: the server part sends it display data only.
- The process-wide read ledger keys entries on a SHA-256 fingerprint of the token, never the token.

A case where the token can reach a log, a file, another host or the TUI is in scope, and we want to
hear about it.
