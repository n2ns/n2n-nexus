# n2n-nexus-host

[中文版](README_zh.md)

The host of n2n-nexus: one Go executable that owns all coordination data and serves the HTTP protocol in [`contract/`](../contract/README.md) to the `n2n-nexus` npm client (MCP adapter and hooks). See the [User guide](../docs/USER_GUIDE.md) for using it and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for the design.

## Install

Installing and starting the host: [Installation guide](../docs/INSTALL.md#1-install-the-host). Code signing is planned in [TODO.md](../TODO.md).

## Layout

The Go module is `github.com/n2ns/n2n-nexus` at the repository root (`go.mod` there), so the host can embed `contract/` (`contract/contract.go`).

```
host/
├── cmd/n2n-nexus-host/   command line: tray (default), serve, service, autostart, install (Windows), version
├── internal/             config, protocol, store (+ migrations/), core, agents, api,
│                         discovery, host, tray, service, clock, testhooks
└── release/render.mjs    renders the Homebrew formula, Scoop manifest and winget manifests of a release
```

## Build and run

Requires the Go version in `go.mod`.

```bash
go build -o host/bin/ ./host/cmd/n2n-nexus-host     # host/bin/ is git-ignored

# Foreground, no tray; a scratch data directory and port
go run ./host/cmd/n2n-nexus-host serve --port 5799 --root /tmp/x
```

`serve` logs to standard error; the first line `<version> listening on http://<addr>` tells the address (`--port 0` picks a free port). Point a client at it with `NEXUS_ENDPOINT=http://127.0.0.1:5799`.

The macOS tray needs cgo (Cocoa): a macOS build with `CGO_ENABLED=0` has `serve`, `service` and `autostart` but no tray. Windows and Linux build with `CGO_ENABLED=0`. Windows releases contain two builds: `n2n-nexus-host.exe` (console, for commands; without arguments it starts the tray build next to it) and `n2n-nexus-host-tray.exe` (`-ldflags -H=windowsgui`, so the tray opens no console window). A GUI program cannot make the terminal wait for it, which is why commands need the console build.

## Test

```bash
go vet ./...
go test ./host/...

# Conformance: the black-box HTTP tests in tests/conformance/ against the test build
npm run host:build-test       # go build -tags testclock -o host/bin/test/ ./host/cmd/n2n-nexus-host
npm run test:conformance      # runs NEXUS_HOST_BIN, default host/bin/test/n2n-nexus-host[.exe], which it builds first
```

The `testclock` build tag adds `POST /test/clock {"now": <ms> | null}` (pin or release the host's clock), `POST /test/shutdown` (stop the host gracefully, as SIGTERM does; the harness uses it on Windows) and `serve --test-listen-wait-ms <ms>` (shorter listening wait); release builds have none of them. The harness (`tests/conformance/harness.ts`) starts one host per test file with a fresh `--root`, `--port 0` and the file's `settings.json`. `npm test` (client tests) also builds the test host first.

The lefthook pre-push hook and CI (`.github/workflows/host.yml`, on ubuntu, windows and macos) run all of the above.

## Release

1. Tag the commit `host-vX.Y.Z` and push the tag. `.github/workflows/host-release.yml` then:
   - runs `go vet ./...` and `go test ./host/...` on linux, windows and macOS, and releases nothing when they fail;
   - builds `n2n-nexus-host_<version>_<os>_<arch>` for linux, windows (`.zip`) and darwin (`.tar.gz`, built on macOS with cgo), each amd64 and arm64, with `-X main.version=<version>`;
   - writes `SHA256SUMS` and attests build provenance for every archive;
   - renders the package manifests with `host/release/render.mjs` (the Homebrew formula builds the tagged source tarball);
   - creates the GitHub release `host-vX.Y.Z` with the archives, `SHA256SUMS` and `winget-manifests.zip` (a tag with `-`, such as `host-v0.9.0-rc.1`, becomes a prerelease); when a rerun finds the release published, it leaves its files alone and goes on only if this run built the same archives (`SHA256SUMS` equal), and it replaces a draft that an interrupted run left;
   - for tags without `-`, pushes the formula to `n2ns/homebrew-tap` (`Formula/n2n-nexus-host.rb`) and the manifest to `n2ns/scoop-bucket` (`bucket/n2n-nexus-host.json`).
2. Repository secrets: `HOMEBREW_TAP_DEPLOY_KEY` and `SCOOP_BUCKET_DEPLOY_KEY`, SSH deploy keys with write access to those two repositories.
3. winget: unpack `winget-manifests.zip` from the release and submit its `winget/` manifests (`N2NS.n2n-nexus-host`) to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) by hand.

The npm client is released separately with `v*` tags (`.github/workflows/publish.yml`); the tag must be `v` followed by the version in `package.json`, and a manual run on anything else publishes nothing. When a change breaks an older client or host, bump `contractVersion` in the three `contract/` files.
