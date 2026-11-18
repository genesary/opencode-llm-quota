<!--
Keep PRs focused and describe what users will see.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link any issue: Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs only
- [ ] Refactor / internal
- [ ] Tests / CI

## Checklist

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` passes
- [ ] `npm run test:e2e` passes, if an entry point or the RPC contract changed
- [ ] Added or updated tests for the change
- [ ] Updated `README.md` and `CHANGELOG.md` (Unreleased) if behavior or configuration changed
- [ ] No new runtime dependency (Node built-ins and `fetch` only)
- [ ] The token is still sent to the provider's gateway only, and never logged
- [ ] Still at most one gateway read per model and per minute
