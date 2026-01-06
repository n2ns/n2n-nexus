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
