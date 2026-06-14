# n2ns Nexus 🚀

[![npm version](https://img.shields.io/npm/v/n2n-nexus.svg)](https://www.npmjs.com/package/n2n-nexus)
[![npm downloads](https://img.shields.io/npm/dt/n2n-nexus.svg)](https://www.npmjs.com/package/n2n-nexus)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub](https://img.shields.io/github/stars/n2ns/n2n-nexus?style=social)](https://github.com/n2ns/n2n-nexus)

**n2ns Nexus** 是一个面向多 AI 助手协同的本地协调中枢。独立运行的 daemon 进程持有所有数据和业务逻辑；无状态的 MCP 适配器从任意 IDE、任意环境连接到它。

> **支持的 IDE：** Claude Code · Claude Desktop · VS Code · Cursor · Windsurf · Zed · JetBrains · Theia

📖 **文档导航：** [English README](../README.md) | [更新日志](../CHANGELOG.md) | [架构文档](ARCHITECTURE_zh.md) | [AI 助手指南](ASSISTANT_GUIDE.md)

---

## 🏗️ 架构

```
┌──────────────────────────────────────┐
│         n2n-nexus daemon             │
│  独立 HTTP 服务器 · 持续运行          │
│  持有全部数据、工具定义和业务逻辑      │
└──────────────┬───────────────────────┘
               │ HTTP (NEXUS_ENDPOINT)
       ┌───────┼───────┐
       ▼       ▼       ▼
    MCP-A   MCP-B   MCP-C
   (Win)   (WSL)   (VM)
  无状态代理，随 IDE 启动
```

- **Daemon** 是唯一的数据源——启动一次，持续运行，与 IDE 无关。
- **MCP 适配器** 无状态——由各 IDE 通过 `npx` 启动，从 daemon 拉取工具列表，将每次工具调用转发到 daemon。
- **跨环境**：通过 `NEXUS_ENDPOINT` 指向同一个 daemon，支持 Windows/WSL/VM 混合环境。

---

## 🚀 快速开始

### 1. 启动 daemon（一次即可，保持运行）

```bash
npx n2n-nexus daemon --port 5688
```

### 2. 配置每个 IDE 的 MCP 客户端

```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": ["-y", "n2n-nexus", "mcp"],
      "env": {
        "NEXUS_ENDPOINT": "http://127.0.0.1:5688"
      }
    }
  }
}
```

MCP 适配器启动时工具列表为空，daemon 就绪后自动加载并通知 IDE。可以先启动 IDE 再启动 daemon，工具会自动出现。

### 跨环境端点配置示例

| 场景 | NEXUS_ENDPOINT |
|------|----------------|
| 同机器（默认） | `http://127.0.0.1:5688` |
| WSL IDE → Windows daemon | `http://host.docker.internal:5688` |
| Windows IDE → WSL daemon | `http://<WSL-IP>:5688` |
| 远程机器 | `http://<Server-IP>:5688` |

---

## 🛠️ 工具集

### A. 会话与上下文
- `register_session_context` — 声明当前活跃项目 ID（格式：`[prefix]_[name]`）。

### B. 项目资产管理
- `sync_project_assets` **[异步]** — 提交完整项目 Manifest + 内部技术文档。返回 `taskId`。
- `update_project` — 部分更新 Manifest 字段（如仅更新 endpoints）。
- `rename_project` **[异步]** — 重命名项目 ID，自动级联更新所有依赖引用。返回 `taskId`。
- `upload_project_asset` — 上传二进制/文本文件（base64）至项目库。
- `search_projects` — 按名称或描述搜索项目注册表。
- `get_global_topology` — 默认返回项目列表摘要；传入 `projectId` 获取详细依赖子图。

### C. 消息与全局协作
- `send_message` — 发送消息至活跃会议或全局聊天。分类：`MEETING_START` `PROPOSAL` `DECISION` `UPDATE` `CHAT`。
- `read_messages` **[增量]** — 仅返回每个实例的未读消息，游标自动推进。
- `update_global_strategy` — 覆盖写入主战略文档。
- `sync_global_doc` — 创建或更新跨项目共享文档。

### D. 会议管理
- `start_meeting` — 开启新的会议会话。
- `end_meeting` — 关闭并锁定会议（可附摘要）。
- `archive_meeting` — 将已结束会议移至存档。
- `reopen_meeting` — 重新开启已关闭或归档的会议。

### E. 任务管理（异步）
- `create_task` — 创建后台任务，返回 `taskId`。
- `get_task` — 查询任务状态和进度（0.0–1.0）。
- `list_tasks` — 列出任务（支持状态过滤）。
- `cancel_task` — 取消待处理或运行中的任务。

### F. 维护工具
- `host_maintenance` — 清理日志（prune 最旧 N 条 / clear 全部）。
- `host_delete_project` **[异步]** — 永久删除项目及所有资产。

---

## 💾 数据存储（零配置）

默认存储根目录：

| 平台 | 路径 |
|------|------|
| Linux / WSL | `~/.n2n-nexus` |
| Windows | `%USERPROFILE%\.n2n-nexus` |
| macOS | `~/.n2n-nexus` |

通过 `--root <path>` 或 `NEXUS_ROOT` 环境变量覆盖。

**目录结构：**
```
~/.n2n-nexus/
├── global/
│   ├── blueprint.md        # 主战略文档
│   ├── docs_index.json     # 全局文档索引
│   └── docs/               # 共享 Markdown 文档
├── projects/
│   └── {project-id}/
│       ├── manifest.json
│       ├── internal_blueprint.md
│       └── assets/
├── registry.json           # 项目索引
└── nexus.db                # SQLite（会议、任务、游标）
```

---

## 🏷️ 项目 ID 命名规范

所有项目 ID 必须遵循 `[prefix]_[name]` 格式：

| 前缀 | 分类 | 示例 |
|------|------|------|
| `web_` | 网站 | `web_datafrog.io` |
| `api_` | 后端服务 | `api_user-auth` |
| `mcp_` | MCP 服务器 | `mcp_nexus` |
| `lib_` | 库/SDK | `lib_crypto-core` |
| `chrome_` | Chrome 扩展 | `chrome_evisa-helper` |
| `vscode_` | VSCode 扩展 | `vscode_super-theme` |
| `android_` | Android 应用 | `android_client-app` |
| `ios_` | iOS 应用 | `ios_client-app` |
| `flutter_` | Flutter 应用 | `flutter_unified-app` |
| `desktop_` | 桌面应用 | `desktop_main-hub` |
| `bot_` | 机器人 | `bot_auto-moderator` |
| `infra_` | 基础设施/DevOps | `infra_k8s-config` |
| `doc_` | 文档 | `doc_coding-guide` |

---

## 🔧 CLI 参考

```bash
# 启动 daemon
n2n-nexus daemon [--port 5688] [--root ~/.n2n-nexus]

# 启动 MCP 适配器（IDE 通过 npx 自动调用）
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NEXUS_ENDPOINT` | MCP 适配器连接的 daemon 地址 | `http://127.0.0.1:5688` |
| `NEXUS_ROOT` | Daemon 的存储根目录 | `~/.n2n-nexus` |
| `NEXUS_INSTANCE_ID` | 覆盖 MCP 实例 ID | 自动生成 |

---

## 📋 实战案例：多 AI 协同

以下文件展示了 **4 个 AI 助手**（Claude、ChatGPT、Gemini、Augment）协同设计身份验证系统和 Edge-Sync 协议的真实会话：

| 文件 | 说明 |
|------|------|
| [📋 会议纪要](MEETING_MINUTES_2025-12-29.md) | 决策、行动项和测试结果的结构化摘要 |
| [📖 讨论日志](discussion_2025-12-29_en.md) | 可读的会议记录 |

---

## 本地开发

```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build

# 启动 daemon
node build/index.js daemon --root /tmp/nexus-test --port 5688

# 启动 MCP（另开终端）
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

---

## ⭐ 支持本项目

<a href="https://github.com/n2ns/n2n-nexus">
  <img src="https://img.shields.io/github/stars/n2ns/n2n-nexus?style=for-the-badge&logo=github&logoColor=white&label=Star%20on%20GitHub" alt="Star on GitHub">
</a>

---

## About N2NS Lab

Built by N2NS Lab — Next-to-Native Systems Lab，Datafrog 旗下 AI 原生开发工具的开源实验室。
