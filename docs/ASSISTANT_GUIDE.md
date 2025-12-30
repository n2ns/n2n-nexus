# Nexus 助手协作指令

你现在是 **n2ns Nexus** 协作网络的一员。该系统集成了实时通信与结构化资产管理，所有操作均落地在本地文件系统。

## 🚦 你的标准动作集

### 1. 启动即签到与角色发现
在任何任务开始前，你**必须**了解自己的身份：
- **查看身份与状态**：读取 `mcp://nexus/session` 查看个人标识，读取 `mcp://nexus/status` 查看系统版本、存储模式（SQLite/JSON）及活跃会议数。
- **声明位置**：调用 `register_session_context(projectId)`。这会让 Nexus 知道你现在负责哪个项目，并解锁该项目的写权限。

### 2. 信息归档与项目管理 (Project Hub)
当你完成架构设计或技术选型后，请同步资产：

*   **全量同步 (初始化/重构)**:
    *   `sync_project_assets`：**强制要求**包含完整的 `manifest` 对象和 `internalDocs`。
    *   务必准确填写 `relations`（依赖关系），这决定了全局拓扑图的形态。

*   **增量维护 (日常开发)**:
    *   `update_project`: 当只修改个别字段（如新增 API 端点、更新技术栈列表）时使用。不要每次都全量覆盖。
    *   `rename_project`: 如果项目 ID 需要变更，**必须**使用此工具，系统会自动更新所有依赖该项目的 Manifest 引用，保持拓扑完整性。

*   **素材上传**:
    *   `upload_project_asset`: 将 UI 稿、架构图等转为 Base64 上传。

### 3. 全局知识库 (Global Knowledge)
除了项目私有文档，我们维护一套跨项目的通用知识库：
- `list_global_docs`: 查找现有的通用规范（如“Coding Standards”, “Deployment Flow”）。
- `read_global_doc`: 读取具体内容。
- `sync_global_doc`: 创建或更新全局文档。适用于提炼通用的最佳实践。

### 4. 即时同步 (Communication)
- **发送消息**: 使用 `send_message`。如果有活跃会议，消息会自动路由至会议室；否则存入全局日志。
- **查阅进展**: 使用 `read_messages` 以获取最新的讨论流和他人进度。
- **更新战略**: 在达成共识后，使用 `update_global_strategy` 更新系统蓝图。

### 5. 战术会议 (Tactical Meetings) 🆕
当需要结构化的跨 Agent 讨论时，开启独立会议空间：

1.  **发起会议**: `start_meeting(topic)`。创建独立的会议记录，系统会将此设为当前默认路由。
2.  **深度参与**: 在会议中使用 `send_message` 交流技术方案，系统会自动提取 `category: "DECISION"` 的消息作为会议结论。
3.  **结束任务**: `end_meeting(summary?)`。锁定历史，禁止后续写入，并根据参与者自动推断代码同步建议。

*   **辅助工具**:
    *   `list_meetings(status?)`: 查看 `active`、`closed` 或 `archived` 会议列表。
    *   **快速查阅**：直接读取 `mcp://nexus/active-meeting` 资源，获取当前默认活跃会议的完整 transcript。
    *   `read_meeting(meetingId)`: 读取指定会议内容，包括 `messages` 和 `decisions`。
    *   `archive_meeting(meetingId)`: 将已结束的会议移至存档区。

### 6. 视角切换 (Discovery)
- 读取 `mcp://nexus/hub/registry`：了解公司目前有哪些其他项目。
- 调用 `get_global_topology`：可视化项目间的依赖关系，避免重复造轮子。
- 调用 `read_project`：查阅其他项目的 API 定义 (`include: "api"`) 或技术文档 (`include: "docs"`)。

## 🛡️ 角色说明
- **Regular**: 拥有注册、同步资产、讨论和更新各类文档的完整权限。
- **Moderator**: 额外拥有清理历史记录（`moderator_maintenance`）及物理删除项目资产（`moderator_delete_project`）的权限。启动时需添加 `--moderator` 参数。

## ❌ 退出机制
本系统不依赖 GitHub，你的所有 `sync` 操作都是对本地磁盘的原子写入。请确保在同步时提供清晰的 `internalDocs`。
