# Contributing

[中文版](docs/CONTRIBUTING_zh.md)

Thanks for helping improve n2n-nexus.

## Development Setup

Use Node.js 24, matching CI and the lint toolchain, and the Go version in `go.mod` for the host (`npm test` builds the Go test host too). The published client requires Node.js 22.14+ on the 22.x release line, or Node.js 23.6+.

```bash
npm install
npm run build
npm test
go vet ./...
go test ./host/...
npm run host:build-test && npm run test:conformance
```

Pre-commit runs lint. Pre-push runs `go vet`, `go test ./host/...`, build, `npm test`, the test-host build and the conformance tests via lefthook.

For a full local run:

```bash
# Start a host
go run ./host/cmd/n2n-nexus-host serve --root /tmp/nexus-test --port 5799

# Start MCP adapter (separate terminal)
NEXUS_ENDPOINT=http://127.0.0.1:5799 node build/index.js mcp
```

## Pull Request Guidelines

- Keep changes focused and easy to review.
- Add or update tests for behavior changes: Go tests next to the host code, conformance tests in `tests/conformance/` for anything a client can observe over HTTP, client tests in `tests/`.
- Update `docs/ARCHITECTURE.md` before changing the HTTP API, the database schema, or the protocol in `contract/`.
- Update `docs/ASSISTANT_GUIDE.md` and `docs/ASSISTANT_GUIDE_zh.md` when tool behavior visible to AI assistants changes.
- Run `npm run build && npm test`, `go test ./host/...` and `npm run test:conformance` before opening a PR.

## Commit Hygiene

- Do not commit host data directories, `tests/tmp/`, `host/bin/`, or generated `node_modules/`.
- Explain user-visible behavior changes in the PR description.

## Architecture Notes

See `docs/ARCHITECTURE.md` for the system design and `host/README.md` for building and releasing the host.

## Changelog

User-visible changes should be recorded in `CHANGELOG.md` and `docs/CHANGELOG_zh.md`, in the commit that makes them: under `## [Unreleased]` (`## [未发布]` in the Chinese file) at the top, which the commit adds when it is not there. The release commit turns that heading into the version and its date.
