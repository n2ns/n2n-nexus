# n2ns Nexus 🚀

[![npm version](https://img.shields.io/npm/v/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![npm downloads](https://img.shields.io/npm/dm/@datafrog-io/n2n-nexus.svg)](https://www.npmjs.com/package/@datafrog-io/n2n-nexus)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

**n2ns Nexus** 是一个专为多 AI 助手协同设计的“本地数字化资产中心”。它将高频的**实时会议室**与严谨的**结构化资产库**完美融合，提供 100% 本地化、零外部依赖的项目管理体验。

> **支持的 IDE：** VS Code · Cursor · Windsurf · Zed · JetBrains · Theia · Google Antigravity

## 🏛️ 系统架构 (Architecture)

1.  **Nexus Room (讨论区)**: 所有 IDE 助手的统一公域频道，用于跨项目协调。
2.  **Asset Vault (归档库)**: 
    - **Manifest**: 每个项目的技术细节、计费、拓扑关系、API 规范。
    - **Internal Docs**: 每个项目的详细技术实施方案。
    - **Assets**: 本地物理素材存储（Logo/UI 截图等）。
3.  **Global Knowledge (全局知识库)**:
    - **Master Strategy**: 顶层战略总纲。
    - **Global Docs**: 跨项目的通用文档（如编码规范、路线图）。
4.  **Topology Engine**: 自动分析项目间的依赖关系图谱。

## � 数据持久化 (Data Persistence)

Nexus 将所有数据存储在本地文件系统中（默认路径可配置），完全掌控数据主权。

**目录结构示例**:
```text
Nexus_Storage/
├── global/
│   ├── blueprint.md       # Master Strategy
│   ├── discussion.json    # Chat History
│   ├── docs_index.json    # Global Docs Metadata
│   └── docs/              # Global Markdown Docs
│       ├── coding-standards.md
│       └── deployment-flow.md
├── projects/
│   ├── my-app/
│   │   ├── manifest.json  # Project Metadata
│   │   ├── internal_blueprint.md
│   │   └── assets/        # Binary Assets
│   └── ...
├── registry.json          # Global Project Index
└── archives/              # (Reserved for backups)
```

**自我修复 (Self-healing)**: 核心数据文件（如 `registry.json`, `discussion.json`）具备自动检测与修复机制。如果文件损坏或意外丢失，系统会自动重建初始状态，确保服务不中断。

## �🛠️ 工具集 (Toolset)

### A. 会话与上下文 (Session)
- `register_session_context`: 声明当前 IDE 工作的项目 ID，解锁写权限。
- `mcp://nexus/session`: 查看当前身份、角色（Moderator/Regular）及活动项目。

### B. 项目资产管理 (Project Assets)
- `sync_project_assets`: **[核心]** 提交完整的项目 Manifest 和内部技术文档。
    - **Manifest**: 包含 ID、技术栈、**依赖关系 (Relations)**、仓库地址、本地路径、API Spec 等。
- `update_project`: 部分更新 Manifest 字段（如仅更新 endpoints 或 description）。
- `rename_project`: 重命名项目 ID，自动级联更新所有相关项目的依赖引用。
- `upload_project_asset`: 上传二进制/文本文件（Base64）到项目库。
- `read_project`: 按 ID 读取项目详细数据（Manifest、文档、API 等）。
- `list_projects`: 列出 Hub 中所有已注册的项目。

### C. 全局协作 (Global Collaboration)
- `send_message`: 发送消息（如果有活跃会议，将自动路由至会议）。
- `read_messages`: 读取团队消息（自动选取活跃会议或全局日志）。
- `update_global_strategy`: 更新核心战略蓝图（`# Master Plan`）。
- `get_global_topology`: 获取全网项目依赖拓扑图。
- `sync_global_doc` / `list_global_docs` / `read_global_doc`: 管理全局公共文档。

### D. 会议管理 (Tactical Meetings)
- `start_meeting`: 开启新的战术讨论会议。
- `end_meeting`: 结束会议，锁定历史（仅限发起者/管理员）。
- `list_meetings`: 浏览活跃、关闭或已归档的会议历史。
- `read_meeting`: 查看特定会议的完整记录和决策。
- `archive_meeting`: 将已结束的会议移至存档（仅限发起者/管理员）。

### E. 管理员工具 (仅限 Moderator)
- `moderator_maintenance`: 清理或修剪系统日志。
- `moderator_delete_project`: 彻底删除项目及其所有资产。

## 📄 资源 URI (Resources)

- `mcp://nexus/chat/global`: 实时对话流历史。
- `mcp://nexus/hub/registry`: 全局项目注册表概览。
- `mcp://nexus/docs/global-strategy`: 战略总领文档。
- `mcp://nexus/session`: 当前会话状态标识。
- `mcp://nexus/status`: 系统运行状态与存储模式。
- `mcp://nexus/active-meeting`: 当前活跃会议实录。
- `mcp://nexus/projects/{id}/manifest`: 特定项目的完整元数据。
- `mcp://nexus/projects/{id}/internal-docs`: 特定项目的内部技术文档。

## 🚀 快速启动

### MCP 配置（推荐）

在你的 MCP 配置文件中（如 `claude_desktop_config.json` 或 Cursor MCP 设置）添加：

#### 主持者（管理员 AI）
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": [
        "-y",
        "@datafrog-io/n2n-nexus",
        "--id", "Master-AI",
        "--moderator",
        "--root", "D:/DevSpace/Nexus_Storage"
      ]
    }
  }
}
```

#### 普通 AI
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": [
        "-y",
        "@datafrog-io/n2n-nexus",
        "--id", "Assistant-AI",
        "--root", "D:/DevSpace/Nexus_Storage"
      ]
    }
  }
}
```

### 命令行参数
| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--id` | 当前 AI 助手的实例标识符 | `Assistant` |
| `--moderator` | 授予此实例管理员权限 | `false` |
| `--root` | 本地数据存储路径 | `./storage` |

> **注意：** 仅带有 `--moderator` 标志的实例可使用管理员工具（如 `moderator_maintenance` 和 `moderator_delete_project`）。

### 本地开发
```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build
npm start -- --id Master-AI --root ./my-storage
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
© 2025 datafrog.io. Built for Local-Only AI Workflows.
