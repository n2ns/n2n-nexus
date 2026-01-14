# 架构与标准 (Architecture & Standards)

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

## 💾 数据持久化 (Data Persistence)

Nexus 将所有数据存储在本地文件系统中（默认路径可配置），完全掌控数据主权。

**目录结构示例**:
```text
Nexus_Storage/
├── global/
│   ├── blueprint.md       # Master Strategy
│   ├── discussion.json    # 全局聊天历史 (fallback)
│   ├── docs_index.json    # 全局文档索引
│   └── docs/              # 全局 Markdown 文档
│       ├── coding-standards.md
│       └── deployment-flow.md
├── projects/
│   └── {project-id}/
│       ├── manifest.json          # 项目元数据
│       ├── internal_blueprint.md  # 技术实现文档
│       └── assets/                # 二进制资产 (图片、PDF)
├── meetings/              # 会议文件 (JSON 回退模式)
│   └── {meeting-id}.json
├── registry.json          # 全局项目索引
├── archives/              # 归档备份 (保留)
└── nexus.db               # SQLite 数据库 (会议、任务、状态)
```

**自我修复 (Self-healing)**: 核心数据文件（如 `registry.json`, `discussion.json`）具备自动检测与修复机制。如果文件损坏或意外丢失，系统会自动重建初始状态，确保服务不中断。

**多并发安全 (Concurrency Safety)**: 对共享文件（`discussion.json`, `registry.json`）的所有写入操作均受 `AsyncMutex` 锁保护，防止多个 AI 代理同时通信时发生竞争条件。

## 🌐 Host-Guest 网络架构 (v2)

### 零配置启动与选举
系统旨在提供“魔法般”的用户体验，同一台机器上的多个实例无需手动配置即可自动发现并组网。

1.  **并行竞速选举**: 启动时，每个实例并发扫描前 5 个端口 (5688-5692) (<300ms)。
2.  **角色解析**:
    *   **Host**: 如果发现空闲端口，实例绑定该端口并成为 Host。
    *   **Guest**: 如果发现已有 Host，实例通过 SSE (Server-Sent Events) 连接并成为 Guest。
3.  **立即握手**: `StdioServerTransport` 对 IDE 的连接是立即完成的 (<10ms)。静态请求（如 `tools/list`）由本地直接响应，避免 IDE 超时；动态请求被**缓冲**，直到选举完成。

### 故障转移与高可用
*   **智能代理 (Smart Proxy)**: Guest 实例通过 HTTP/SSE 将 IDE 请求代理给 Host。它们处理背压和缓冲，防止网络抖动导致数据丢失。
*   **自动故障转移**: 如果 Host 进程终止（例如用户关闭了 Host IDE 窗口），Guest 实例会检测到连接断开（通过 `ECONNREFUSED` 或 SSE `end`），并触发 **重新选举**。其中一个幸存的 Guest 将自动晋升为新的 Host，自动恢复集群服务。
