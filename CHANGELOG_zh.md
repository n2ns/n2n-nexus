# 更新日志

本项目的所有重要变更都将记录在此文件中。

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
