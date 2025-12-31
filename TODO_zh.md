# Nexus 项目待办清单 (TODO List)

## 📅 2025-12-31: Token 经济与 API 表面积优化

**目标**: 通过将“读取”操作从工具 (Tools) 迁移至资源 (Resources)，降低 MCP 服务器的静态 Token 成本。

### 1. 工具向资源迁移 (Phase 1 - 已完成)
- [x] **标准化资源 URI**: 
    - [x] 实现 `mcp://nexus/meetings/list` 和 `mcp://nexus/docs/list`。
    - [x] 支持针对项目和文档的动态资源 URI 直接读取。
- [x] **精简冗余工具 (The Purge)**:
    - [x] 成功移除 `list_projects`, `list_meetings`, `list_global_docs`。
    - [x] 成功移除 `read_project`, `read_global_doc`, `read_meeting`。

### 2. 实施策略

#### Phase 1: 资源化迁移 (已完成)
- [x] **工具清理**: 直接物理移除冗余工具，保持 API 简洁。
- [x] **架构优化**: 底层存储方法已针对资源的延迟加载 (Lazy Loading) 进行优化。
- [x] **助手指南同步**: 更新 `ASSISTANT_GUIDE.md` 至 v0.2.0 的任务优先探索模式。

#### Phase 1.5: 类型安全加固 (已完成)
- [x] **集成 Zod**: 引入 `zod` 校验框架。
- [x] **Schema 迁移**: 所有工具定义均迁移至 `schemas.ts` 并具备严格类型约束。
- [x] **运行时校验**: 在工具处理器中强制执行 Zod 解析。

#### Phase 2: 任务原语化 (已完成)
- [x] **架构分离**: 在数据库层面解耦“会议 (Context)”与“任务 (Execution)”。
- [x] **数据库增强**: 建立具备生命周期追踪能力的 `tasks` 表。
- [x] **服务层**: 实现 `TaskService` 用于 CRUD 和状态管理。
- [x] **异步操作**: 项目同步 (`sync_project_assets`) 现在立即返回 taskId。
- [x] **任务工具集**: 新增 `create_task`, `get_task`, `list_tasks`, `update_task`, `cancel_task`。

#### Phase 2.5: 安全性提升 (已完成)
- [x] **ID 校验**: 对所有涉及 projectId 的操作应用 `ProjectIdSchema` 防护。
- [x] **路径穿透防御**: 为文件上传增加 `FileNameSchema` 校验。
- [x] **内部工具标记**: 将 `update_task` 标记为 `[INTERNAL]` 防止误用。

#### Phase 3: 基础设施与安全加固 (已完成)
- [x] **工具大清洗 (Code Diet)**: 移除所有 6 个冗余读取工具，全面转向 Resource-First 模式。
- [x] **深度异步化**: 将项目更名和删除操作迁移至 Task 原语，支持级联背景处理。
- [x] **会议管理强化**: 实现 `reopen_meeting` 并对 `end/archive` 执行管理员权限强制校验。
- [x] **版本发布**: 正式发布 v0.2.0 版本 (2025-12-31)。

#### Phase 4: 未来路线图 (Backlog)
- [ ] **更多异步场景**: 考虑将 `upload_project_asset` 迁移至异步模式。
- [ ] **任务自动清理**: 实现针对已过期或已完成任务的定时清理作业。
- [ ] **流式进度通报**: 支持通过 MCP 资源订阅获取任务进度的实时推送。

---
*最后更新日期: 2025-12-31 由 Nexus AI 助手更新。*
