# 参与贡献

[English version](../CONTRIBUTING.md)

感谢你帮助改进 n2n-nexus。

## 开发环境

使用 Node.js 24（与 CI 和 lint 工具链一致），host 使用 `go.mod` 中指定的 Go 版本（`npm test` 也会构建 Go 测试 host）。发布的客户端要求 Node.js 22.14+（22.x 系列）或 Node.js 23.6+。

```bash
npm install
npm run build
npm test
go vet ./...
go test ./host/...
npm run host:build-test && npm run test:conformance
```

pre-commit 运行 lint。pre-push 通过 lefthook 运行 `go vet`、`go test ./host/...`、构建、`npm test`、测试 host 构建和一致性测试。

完整的本地运行：

```bash
# 启动一个 host
go run ./host/cmd/n2n-nexus-host serve --root /tmp/nexus-test --port 5799

# 启动 MCP 适配器（另开一个终端）
NEXUS_ENDPOINT=http://127.0.0.1:5799 node build/index.js mcp
```

## Pull Request 规范

- 改动保持集中，便于评审。
- 行为改动要新增或更新测试：Go 测试放在 host 代码旁边，客户端能通过 HTTP 观察到的行为在 `tests/conformance/` 里写一致性测试，客户端测试放在 `tests/`。
- 修改 HTTP API、数据库 schema 或 `contract/` 中的协议之前，先更新 `docs/ARCHITECTURE.md`。
- AI 助手能看到的工具行为发生变化时，更新 `docs/ASSISTANT_GUIDE.md` 和 `docs/ASSISTANT_GUIDE_zh.md`。
- 提交 PR 前运行 `npm run build && npm test`、`go test ./host/...` 和 `npm run test:conformance`。

## 提交规范

- 不要提交 host 数据目录、`tests/tmp/`、`host/bin/` 或生成的 `node_modules/`。
- 在 PR 描述中说明用户可见的行为变化。

## 架构说明

系统设计见 `docs/ARCHITECTURE.md`，host 的构建和发布见 `host/README.md`。

## 更新日志

用户可见的变更应记录在 `CHANGELOG.md` 和 `docs/CHANGELOG_zh.md` 中，并且和改动在同一个提交里：写在顶部的 `## [未发布]`（英文文件里是 `## [Unreleased]`）下面，没有这个章节时由该提交加上。发布提交把这个标题改成版本号和日期。
