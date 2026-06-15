# Contributing

Thanks for helping improve n2n-nexus.

## Development Setup

```bash
npm install
npm run build
npm test
```

Pre-commit runs lint. Pre-push runs `build && test` via lefthook.

For a full local run:

```bash
# Start daemon
node build/index.js daemon --root /tmp/nexus-test --port 5688

# Start MCP adapter (separate terminal)
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

## Pull Request Guidelines

- Keep changes focused and easy to review.
- Add or update tests for behavior changes. Tests use `port: 0` for dynamic port allocation and write to `tests/tmp/` (cleaned per test).
- Update `docs/ARCHITECTURE.md` before changing the daemon REST API, storage layout, or tool definitions.
- Update `docs/ASSISTANT_GUIDE.md` and `docs/ASSISTANT_GUIDE_zh.md` when tool behavior visible to AI assistants changes.
- Run `npm run build && npm test` before opening a PR.

## Commit Hygiene

- Do not commit `~/.n2n-nexus/` data, `tests/tmp/`, or generated `node_modules/`.
- Explain user-visible behavior changes in the PR description.

## Architecture Notes

The daemon is the single source of truth. The MCP adapter is a stateless proxy — it has no tool definitions and no local data. All tool definitions and business logic live in `src/daemon/server.ts`. See `docs/ARCHITECTURE.md` for the full system design.

## Changelog

User-visible changes should be recorded in `CHANGELOG.md`.
