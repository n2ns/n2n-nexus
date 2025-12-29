# 更新日志

本项目的所有重要变更都将记录在此文件中。

## [v0.1.5] - 2025-12-29

### 🚀 主要功能
- **项目 ID 命名规范**: 强制执行 `[prefix]_[technical-name]` 格式，共 13 种类型前缀 (web_, api_, chrome_, vscode_, mcp_, android_, ios_, flutter_, desktop_, lib_, bot_, infra_, doc_)。
- **MCP Prompts 能力**: 新增 `init_project_nexus` Prompt，引导 AI 完成规范化项目注册流程。
- **delete_project 工具**: 新增管理员工具，用于完全删除项目（包括清单、资产、注册表条目）。

### 🔒 防护栏 (Guardrails)
- 新增 `validateProjectId()` 函数，在 `handleRegisterSession`、`handleSyncProjectAssets`、`handleRenameProject` 中进行运行时正则校验。
- 非法 ID 格式的项目将在 API 层被拒绝。

### ✨ 增强
- 资源名称现在显示项目类型图标（如 "🌐 Website: web_example.com"）。
- Handler 单元测试扩展，覆盖删除、重命名和校验场景。

### 📄 文档
- 在 README.md 中新增 "Project ID Conventions" 章节。
- 更新工具描述，加入前缀字典 (Prefix Dictionary) 指引。

## [v0.1.4] - 2025-12-29

### 🐛 Bug 修复
- 添加 shebang (`#!/usr/bin/env node`) 以修复 Windows 上 npx 执行问题。

## [v0.1.3] - 2025-12-29

### 🔧 CI/CD
- 切换至 npm Trusted Publishing (OIDC) - 无需 NPM_TOKEN。
- 升级至 Node.js 22 以支持 npm 11.5.1+。
- 添加 `--provenance` 标志以增强供应链安全。

## [v0.1.2] - 2025-12-29

### 🔧 重构
- 代码模块化：拆分为 `tools/`、`resources/`、`storage/` 模块。
- `index.ts` 从 535 行精简至 115 行。
- 测试文件从 `src/__tests__/` 移至顶层 `tests/` 目录。

### 📦 CI/CD
- GitHub Actions 触发方式从 `release` 改为 tag 推送 (`v*`)。

### 📄 文档
- 新增 npm 下载量徽章。
- 修复仓库 URL 为 `n2n-nexus`。

## [v0.1.1] - 2025-12-29

### 📦 npm 发布
- 发布到 npm：`@datafrog-io/n2n-nexus`。
- 更新 README，添加 `npx` 配置方式以便快速集成 MCP。
- 新增 CLI 命令行参数说明表格。

## [v0.1.0] - 2025-12-29

### 🚀 主要功能
- **项目资产中心 (Project Asset Hub)**: 集中存储项目清单 (Manifest)、内部文档 (Internal Docs) 和资产 (图片/文件)。
- **通信频道 (Communication Channels)**:
    - `mcp://chat/global`: 实时跨 Agent 消息流。
    - `post_global_discussion`: 用于协调的广播工具。
- **拓扑引擎 (Topology Engine)**:
    - `get_global_topology`: 基于 Manifest 中的 `relations` 自动生成依赖关系图。
- **全局知识库 (Global Knowledge Base)**:
    - 新增 `docs/` 目录结构，用于存储共享标准。
    - 工具: `sync_global_doc`, `read_global_doc`, `list_global_docs`.
- **自我修复存储 (Self-Healing Storage)**:
    - 自动修复损坏的 JSON 注册表或日志文件。
    - 缺失配置时的安全默认值。

### 🛠️ 工具集更新
- 新增 `update_project`: 支持 Manifest 局部字段更新。
- 新增 `rename_project`: 支持项目重命名，并自动级联更新所有引用。
- 新增 `register_session_context`: 用于 IDE 会话绑定。
- 新增 `moderator_maintenance`: 用于日志修剪。

### 📚 文档
- 更新 `README.md`: 补充了完整的架构图和数据持久化细节。
- 新增 `ASSISTANT_GUIDE.md`: AI 对 AI 的操作协议指南。
