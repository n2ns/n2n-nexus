# n2n-nexus-host

[English version](README.md)

n2n-nexus 的 host：一个 Go 可执行文件，保存全部协调数据，并向 `n2n-nexus` npm 客户端（MCP 适配器和 hooks）提供 [`contract/`](../contract/README.md) 中定义的 HTTP 协议。使用方法见[使用手册](../docs/USER_GUIDE_zh.md)，设计见 [docs/ARCHITECTURE_zh.md](../docs/ARCHITECTURE_zh.md)。

## 安装

安装和启动 host：见[安装手册](../docs/INSTALL_zh.md#1-安装-host)。代码签名的计划见 [TODO.md](../TODO.md)。

## 目录结构

Go 模块是仓库根目录的 `github.com/n2ns/n2n-nexus`（`go.mod` 在根目录），所以 host 可以嵌入 `contract/`（`contract/contract.go`）。

```
host/
├── cmd/n2n-nexus-host/   命令行：托盘（默认）、serve、service、autostart、install（Windows）、version
├── internal/             config、protocol、store（+ migrations/）、core、agents、api、
│                         discovery、host、tray、service、clock、testhooks
└── release/render.mjs    生成一次发布的 Homebrew formula、Scoop manifest 和 winget manifest
```

## 构建和运行

需要 `go.mod` 中指定的 Go 版本。

```bash
go build -o host/bin/ ./host/cmd/n2n-nexus-host     # host/bin/ 已被 git 忽略

# 前台运行，不带托盘；使用临时数据目录和端口
go run ./host/cmd/n2n-nexus-host serve --port 5799 --root /tmp/x
```

`serve` 把日志写到标准错误；第一行 `<version> listening on http://<addr>` 给出地址（`--port 0` 任选一个空闲端口）。用 `NEXUS_ENDPOINT=http://127.0.0.1:5799` 让客户端连到它。

macOS 托盘需要 cgo（Cocoa）：用 `CGO_ENABLED=0` 构建的 macOS 版本有 `serve`、`service` 和 `autostart`，但没有托盘。Windows 和 Linux 用 `CGO_ENABLED=0` 构建。Windows 发布包含两个构建：`n2n-nexus-host.exe`（控制台程序，用于命令；不带参数时启动同目录的托盘构建）和 `n2n-nexus-host-tray.exe`（`-ldflags -H=windowsgui`，托盘不会打开控制台窗口）。GUI 程序无法让终端等待它结束，所以命令需要用控制台构建。

## 测试

```bash
go vet ./...
go test ./host/...

# 一致性测试：tests/conformance/ 里的黑盒 HTTP 测试，针对测试构建运行
npm run host:build-test       # go build -tags testclock -o host/bin/test/ ./host/cmd/n2n-nexus-host
npm run test:conformance      # 运行 NEXUS_HOST_BIN，默认 host/bin/test/n2n-nexus-host[.exe]，运行前会先构建它
```

`testclock` 构建标签会加上 `POST /test/clock {"now": <ms> | null}`（固定或放开 host 的时钟）、`POST /test/shutdown`（像 SIGTERM 一样让 host 正常停止；测试框架在 Windows 上用它）和 `serve --test-listen-wait-ms <ms>`（缩短 listening 等待时间）；正式版本这三样都没有。测试框架（`tests/conformance/harness.ts`）为每个测试文件启动一个 host，使用全新的 `--root`、`--port 0` 和该文件的 `settings.json`。`npm test`（客户端测试）也会先构建测试 host。

lefthook 的 pre-push hook 和 CI（`.github/workflows/host.yml`，在 ubuntu、windows 和 macos 上）会运行以上全部内容。

## 发布

1. 给提交打上 `host-vX.Y.Z` 标签并推送该标签。随后 `.github/workflows/host-release.yml` 会：
   - 在 linux、windows 和 macOS 上运行 `go vet ./...` 和 `go test ./host/...`，失败时什么也不发布；
   - 为 linux、windows（`.zip`）和 darwin（`.tar.gz`，在 macOS 上用 cgo 构建）构建 `n2n-nexus-host_<version>_<os>_<arch>`，每个平台都有 amd64 和 arm64，带 `-X main.version=<version>`；
   - 写出 `SHA256SUMS`，并为每个压缩包生成构建证明；
   - 用 `host/release/render.mjs` 生成各包管理器的 manifest（Homebrew formula 从该标签的源码压缩包构建）；
   - 创建 GitHub release `host-vX.Y.Z`，附上压缩包、`SHA256SUMS` 和 `winget-manifests.zip`（带 `-` 的标签，例如 `host-v0.9.0-rc.1`，会成为预发布版本）；重跑时如果 release 已经发布，不动它的文件，只有这次构建出的压缩包相同（`SHA256SUMS` 一致）才继续，被中断的运行留下的草稿则会被替换；
   - 对不带 `-` 的标签，把 formula 推送到 `n2ns/homebrew-tap`（`Formula/n2n-nexus-host.rb`），把 manifest 推送到 `n2ns/scoop-bucket`（`bucket/n2n-nexus-host.json`）。
2. 仓库 secrets：`HOMEBREW_TAP_DEPLOY_KEY` 和 `SCOOP_BUCKET_DEPLOY_KEY`，即对这两个仓库有写权限的 SSH 部署密钥。
3. winget：解压 release 里的 `winget-manifests.zip`，手动把其中 `winget/` 下的 manifest（`N2NS.n2n-nexus-host`）提交到 [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)。

npm 客户端用 `v*` 标签单独发布（`.github/workflows/publish.yml`）；标签必须是 `v` 加 `package.json` 里的版本号，在其他引用上手动运行什么也不发布。当某个改动会破坏旧版客户端或 host 时，把 `contract/` 中三个文件的 `contractVersion` 加一。
