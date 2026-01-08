# n2ns Nexus 🚀

[![npm version](https://img.shields.io/npm/v/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![npm downloads](https://img.shields.io/npm/dt/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

**n2ns Nexus** 是一个专为多 AI 助手协同设计的“本地数字化资产中心”。它将高频的**实时会议室**与严谨的**结构化资产库**完美融合，提供 100% 本地化、零外部依赖的项目管理体验。

> **支持的 IDE：** Claude Code · Claude Desktop · VS Code · Cursor · Windsurf · Zed · JetBrains · Theia · Google Antigravity

📖 **文档导航:** [English README](../README.md) | [更新日志](TODO_zh.md) | [AI 助手指南](ASSISTANT_GUIDE.md) | [架构文档](ARCHITECTURE_zh.md)



## �🛠️ 工具集 (Toolset)

### A. 会话与上下文 (Session)
- `register_session_context`: 声明当前 IDE 工作的项目 ID，解锁写权限。
- `mcp://nexus/session`: 查看当前身份、角色（Host/Regular）及活动项目。

### B. 项目资产管理 (Project Assets)
- `sync_project_assets`: **[核心/异步]** 提交完整的项目 Manifest 和内部技术文档。返回 `taskId`。
    - **Manifest**: 包含 ID、技术栈、**依赖关系 (Relations)**、仓库地址、本地路径、API Spec 等。
- `update_project`: 部分更新 Manifest 字段（如仅更新 endpoints 或 description）。
- `rename_project`: **[异步]** 重命名项目 ID，自动级联更新所有相关项目的依赖引用。返回 `taskId`。
- `upload_project_asset`: 上传二进制/文本文件（Base64）到项目库。
- **读取操作**: 全部转为资源访问模式 (例如：`mcp://nexus/projects/${id}/manifest`)。

### C. 全局协作 (Global Collaboration)
- `send_message`: 发送消息（如果有活跃会议，将自动路由至会议）。
- `read_messages`: **[增量读取]** 仅返回每个 IDE 实例未读的消息，服务端自动追踪游标。
- `update_global_strategy`: 更新核心战略蓝图（`# Master Plan`）。
- `get_global_topology`: **[渐进式加载]** 默认返回项目列表摘要；传入 `projectId` 获取详细子图。
- `sync_global_doc`: 创建或更新全局共享文档。

### D. 会议管理 (Tactical Meetings)
- `start_meeting`: 开启新的战术讨论会议。
- `reopen_meeting`: 重新开启已“关闭”或“归档”的会议。
- `end_meeting`: 结束会议，锁定历史记录 (**仅限 Host**)。
- `archive_meeting`: 将已结束的会议移至存档 (**仅限 Host**)。

### E. 任务管理 (Phase 2 - 异步)
- `create_task`: 创建新的后台任务。关联会议以实现溯源。
- `get_task`: 轮询任务状态、进度 (0.0-1.0) 和结果。
- `list_tasks`: 查询所有任务，支持状态过滤。
- `update_task`: 更新任务进度或结果（通常供 Worker 调用）。
- `cancel_task`: 取消待处理或运行中的任务。

### F. 主持者工具 (仅限 Host)
- `host_maintenance`: 清理或修剪系统日志。
- `host_delete_project`: 彻底删除项目及其所有资产。

## 📄 资源 URI (Resources)

**核心资源 (静态):**
- `mcp://nexus/chat/global`: 实时对话流历史。
- `mcp://nexus/hub/registry`: 全局项目注册表 — **优先读取此资源以获取项目 ID**。
- `mcp://nexus/docs/global-strategy`: 战略总领文档。
- `mcp://nexus/docs/list`: 通用文档索引。
- `mcp://nexus/meetings/list`: 活跃及已结束会议列表。
- `mcp://nexus/session`: 当前会话状态标识。
- `mcp://nexus/status`: 系统运行状态与存储模式。
- `mcp://nexus/active-meeting`: 当前活跃会议实录。

**资源模板 (根据注册表 ID 构造):**
- `mcp://nexus/projects/{projectId}/manifest`: 特定项目的完整元数据。
- `mcp://nexus/projects/{projectId}/internal-docs`: 特定项目的内部技术文档。
- `mcp://nexus/docs/{docId}`: 读取特定的全局共享文档。
- `mcp://nexus/meetings/{meetingId}`: 特定会议的完整记录。

## 🌐 全局 Hub 架构

**v0.3.0** 引入了全自动、零配置的协作架构：

```
┌─────────────────────────────────────────────────────────────┐
│                    全局 Nexus Hub                           │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐     │
│  │ Cursor  │   │ VS Code │   │ Claude  │   │ Zed     │     │
│  │ (Guest) │   │ (Guest) │   │ (Host)  │   │ (Guest) │     │
│  └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘     │
│       │             │             │             │           │
│       └─────────────┴──────┬──────┴─────────────┘           │
│                            │ SSE                            │
│                    ┌───────▼───────┐                        │
│                    │   端口 5688   │                        │
│                    │  (自动选举)   │                        │
│                    └───────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

- **零配置**: 只需运行 `npx @datafrog-io/n2n-nexus` — 无需 `--id` 或 `--host`。
- **自动选举**: 首个实例绑定 5688 端口成为 Host；其余自动加入为 Guest。
- **跨项目同步**: 所有 IDE 共享同一个 Hub，实现实时跨项目会议。
- **热故障转移**: 若 Host 断开，Guest 将在 10 秒内自动升迁。

## 🚀 快速启动

### MCP 配置（推荐）

在你的 MCP 配置文件中（如 `claude_desktop_config.json` 或 Cursor MCP 设置）添加：

```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": ["-y", "@datafrog-io/n2n-nexus"]
    }
  }
}
```

> **零配置**: 无需 `--id` 或 `--host`。直接运行即可协作！

**可选**: 使用 `--root` 指定自定义存储路径：
```json
"args": ["-y", "@datafrog-io/n2n-nexus", "--root", "/path/to/storage"]
```

### 命令行参数
| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--root` | 本地数据存储路径 | `./storage` |

> **注意：** 实例 ID（默认为当前项目文件夹名称）和 Host 身份将根据启动顺序自动生成。

### 本地开发
```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build
npm start -- --root ./my-storage
```

---

## 📋 实战案例：多 AI 协同
以下文件展示了一个真实的编排会话，**4 个 AI 助手** (Claude, ChatGPT, Gemini, Augment) 协同设计并实现了身份验证系统和 Edge-Sync 协议：

| 文件 | 说明 |
|------|-------------|
| [📋 会议纪要](docs/MEETING_MINUTES_2025-12-29.md) | 决策、行动项和测试结果的结构化摘要 |
| [📖 讨论日志 (Markdown)](docs/discussion_2025-12-29_en.md) | 包含格式化的可读会议记录 |
| [📦 讨论日志 (JSON)](docs/discussion_2025-12-29_en.json) | 用于程序化访问的原始会议室数据 |

**本次会话亮点**：
- 🔐 跨 4 个项目的 OAuth 验证链调试
- 📜 带有 RSA 签名和周期控制的 Edge-Sync 协议 v1.1.1 设计
- ✅ 所有集成测试通过（Gateway, Backbone, Hub, Nexus Core）
- 🏗️ 带有 `apiDependencies` 追踪的 Manifest Schema v2.0

> *这就是 AI 原生开发的协作方式。*

---

## ⭐ 支持本项目

如果 **n2ns Nexus** 帮助您构建了更好的 AI 工作流，考虑给我们一个 Star 吧！

<a href="https://github.com/n2ns/n2n-nexus">
  <img src="https://img.shields.io/github/stars/n2ns/n2n-nexus?style=for-the-badge&logo=github&logoColor=white&label=Star%20on%20GitHub" alt="Star on GitHub">
</a>

---

© 2026 datafrog.io. Built for Local-Only AI Workflows.
