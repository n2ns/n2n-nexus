# 更新日志

本项目的所有重要变更都将记录在此文件中。

## [v0.1.9] - 2025-12-30

### 🛡️ 协同与权限强化
- **会议权限控制**: 实现了 **Initiator-only** 停机策略。只有会议发起者或系统管理员 (Moderator) 才能执行 `end_meeting` 和 `archive_meeting`。
- **自动在线感知**: 实现了会话生命周期日志。AI 实例启动及关闭（IDE 关闭）时会自动发送 `[ONLINE/OFFLINE]` 状态报文，提升多 Agent 协作透明度。
- **语义名统一**: 完成了工具命名的零别名集成。全面转向 `send_message` 和 `read_messages` 以获得更好的语义理解。

### 🌐 资源命名空间隔离 (MCP 2025)
- **统一 Authority**: 所有 MCP 资源 URI 已迁移至 `mcp://nexus/` 权威标识符下，防止与其他 MCP Server 发生命名冲突。
- **状态资源**: 暴露了 `mcp://nexus/status` 和 `mcp://nexus/active-meeting` (当前活跃会议实录) 资源。

## [v0.1.9] - 2025-12-30

### 🛡️ 协同与权限强化
- **会议权限控制**: 实现了 **Initiator-only** 停机策略。只有会议发起者或系统管理员 (Moderator) 才能执行 `end_meeting` 和 `archive_meeting`。
- **自动在线感知**: 实现了会话生命周期日志。AI 实例启动及关闭（IDE 关闭）时会自动发送 `[ONLINE/OFFLINE]` 状态报文，提升多 Agent 协作透明度。
- **语义名统一**: 完成了工具命名的零别名集成。全面转向 `send_message` 和 `read_messages` 以获得更好的语义理解。

### 🌐 资源命名空间隔离 (MCP 2025)
- **统一 Authority**: 所有 MCP 资源 URI 已迁移至 `mcp://nexus/` 权威标识符下，防止与其他 MCP Server 发生命名冲突。
- **状态资源**: 暴露了 `mcp://nexus/status` 和 `mcp://nexus/active-meeting` (当前活跃会议实录) 资源。

## [v0.1.8] - 2025-12-30

### 🎯 会议架构 (Phase 1 & 2)
- **混合存储后端**: 自动选择 **SQLite** (优先) 或 **JSON Fallback**。
- **SQLite 引擎**: 基于 `better-sqlite3` 并启用 **WAL 模式**，支持高并发和多进程安全访问。
- **新生命周期实体**: `MeetingSession` 取代单体日志，实现结构化会议管理。
- **生命周期工具**:
  - `start_meeting(topic)`: 创建独立会议，具备防碰撞 ID 生成逻辑。
  - `end_meeting(meetingId?, summary?)`: 关闭会议并自动汇总决策。
  - `archive_meeting(meetingId)`: 将关闭的会议移至历史存档数据层。
  - `list_meetings(status?)`: 按状态筛选浏览会议。
  - `read_meeting(meetingId)`: 详细读取历史记录、参会者和决策。

### 🏗️ API 与存储优化
- **结构化 JSON 响应**: 会议工具现在返回机器可读的 JSON，方便 Agent 集成。
- **智能自动路由**: 全局讨论消息将自动路由至当前活跃的会议。
- **ID 生成增强**: 为非 ASCII 主题 (如中文) 增加 Base64 回退和随机后缀，确保 ID 唯一性。
- **并发控制**: 提取通用的 `AsyncMutex` 工具类，优化 SQLite 原生锁支持。
- **状态报告**: `mcp://nexus/status` 现在报告 `storage_mode` 和 `is_degraded` (降级) 标志。

### 🧪 质量保障
- **全方位测试套件**: 新增 24+ 项集成与压力测试 (100% 通过)。
- **并发压力测试**: 验证在高频消息并发情况下的数据完整性。
- **回退验证**: 确认系统在缺失原生模块时能稳定回退至 JSON 模式。

### 🛡️ 安全与权限 (Security)
- **工具权限加固**: 将 `delete_project` 重命名为 `moderator_delete_project`，并强制执行管理员身份验证，防止未授权删除项目。
- **错误信息脱敏**: 进一步优化了错误处理器，确保不向 AI 暴露本地绝对路径。

### 📄 资源与文档 (Resources & Docs)
- **新资源接口**: 增加了 `mcp://nexus/active-meeting` 资源，支持一键读取当前会议的完整 transcript 和决策。
- **README 补全**: 在中英文文档中同步更新了管理工具 (`Admin`) 章节，增加了新增工具的用法说明。
- **开发指南**: 更新了 `ASSISTANT_GUIDE.md`，提供了会议管理和同步的最佳实践。

## [v0.1.7] - 2025-12-30

### ⚙️ CLI 简化
- **Moderator 标志**: 将 `--moderator-id <id>` 替换为简单的 `--moderator` 布尔标志。
  - 主持者: `--id Master-AI --moderator`
  - 普通 AI: `--id Assistant-AI` (无需额外参数)

### ✅ 测试
- 新增 session 资源角色验证测试 (Moderator/Regular)。
- 全部 17 个单元测试通过。

## [v0.1.6] - 2025-12-29

### 🔒 并发安全
- **AsyncMutex 互斥锁**: 实现基于互斥锁的并发控制，防止多 AI 同时写入时的竞态条件。
- 受保护的写入操作：
  - Discussion 文件: `addGlobalLog()`, `pruneGlobalLogs()`, `clearGlobalLogs()`
  - Registry 文件: `saveProjectManifest()`, `renameProject()`, `deleteProject()`

### 📦 Schema v2.0
- **Manifest Schema 增强**: 新增可选字段，支持企业级协同：
  - `apiDependencies`: 项目依赖版本映射 (如 `">=v2.1"`)
  - `gatewayCompatibility`: 网关版本兼容性字符串
  - `api_versions`: 功能级 API 版本
  - `feature_tier`: 能力等级声明 (`"free"` | `"pro"` | `"enterprise"`)

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
