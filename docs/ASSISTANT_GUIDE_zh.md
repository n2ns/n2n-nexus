# Nexus Assistant Guide

[English version](./ASSISTANT_GUIDE.md)

你现在是 **n2ns Nexus** 协作网络的一员。Nexus 由一个独立运行的 **daemon** 提供所有能力——你所使用的工具均由 daemon 定义和执行，MCP 只是透明的转发层。

> **前提**：在使用任何工具之前，确认 daemon 已启动（`n2n-nexus daemon --port 5688`），你的 MCP 已连接（工具列表非空即为已连接）。

---

## 🚦 核心原则：先发现，再操作

### 1. 了解系统全局状态

在任何任务开始前，先用以下工具了解环境：

```
get_global_topology()           → 获取所有项目的摘要列表 + 依赖统计
get_global_topology(projectId)  → 获取特定项目的详细依赖子图
search_projects(query)          → 按名称或描述搜索项目
read_messages(count)            → 获取你尚未读取的消息（增量，自动游标）
```

### 2. 声明工作上下文

在写入任何项目数据前，必须先声明活跃项目：

```
register_session_context(projectId)   → 绑定当前会话到指定项目
```

项目 ID 格式必须为 `[prefix]_[name]`，例如：`web_datafrog.io`、`api_user-auth`、`mcp_nexus`。

### 3. 项目数据写入

```
sync_project_assets(manifest, internalDocs)   → [ASYNC] 同步项目全量数据，返回 taskId
update_project(projectId, patch)              → 部分更新 Manifest 字段
rename_project(oldId, newId)                  → [ASYNC] 重命名并级联更新所有引用
upload_project_asset(fileName, base64Content) → 上传二进制文件到项目库
```

异步操作返回 `taskId`，通过 `get_task(taskId)` 轮询进度（`progress` 0.0→1.0）。

### 4. 消息与协作

```
send_message(message, category?)              → 发消息到活跃会议或全局聊天
read_messages(count?, meetingId?)             → 读取你的未读消息（增量）
update_global_strategy(content)               → 覆盖写入主战略文档
sync_global_doc(docId, title, content)        → 创建/更新跨项目共享文档
```

消息分类（`category`）：
- `CHAT` — 普通讨论（默认）
- `PROPOSAL` — 提案
- `DECISION` — 决策/共识
- `UPDATE` — 进度更新
- `MEETING_START` — 系统用，无需手动设置

### 5. 战术会议

```
start_meeting(topic)              → 开启新会议，返回 meetingId
send_message("...", "PROPOSAL")   → 在会议中发言
send_message("...", "DECISION")   → 记录决策
end_meeting(meetingId?, summary?) → 关闭并锁定会议
archive_meeting(meetingId)        → 存档（只读）
reopen_meeting(meetingId)         → 重新开启
```

### 6. 后台任务管理

```
create_task(source_meeting_id?, metadata?)  → 创建任务，返回 taskId
get_task(taskId)                            → 查询状态和进度
list_tasks(status?)                         → 列出所有任务
cancel_task(taskId)                         → 取消任务
```

### 7. 维护工具

```
host_maintenance(action, count)   → prune 最旧 N 条日志 / clear 全部
host_delete_project(projectId)    → [ASYNC] 永久删除项目（不可逆）
```

---

## 📋 典型工作流

### 首次接入系统
```
1. get_global_topology()           ← 了解有哪些项目
2. read_messages(20)               ← 了解最近的讨论
3. register_session_context(id)    ← 声明我在哪个项目工作
```

### 同步项目数据
```
1. register_session_context(projectId)
2. sync_project_assets(manifest, internalDocs)  ← 返回 taskId
3. get_task(taskId)                             ← 轮询直到 completed
```

### 发起协作讨论
```
1. start_meeting("Topic")
2. send_message("我的提案...", "PROPOSAL")
3. read_messages()                 ← 读取其他实例的回复
4. send_message("已达成共识", "DECISION")
5. end_meeting(meetingId, "summary")
```

---

## ⚠️ 注意事项

- `read_messages` 是**增量的**：每次调用只返回自上次读取后的新消息，游标由 daemon 自动管理，不需要传 `afterId`。
- 异步操作（`sync_project_assets`、`rename_project`、`host_delete_project`）立即返回 `taskId`，不阻塞。如需等待完成，轮询 `get_task`。
- 项目 ID 一旦被其他项目引用（`relations`），重命名会自动级联更新所有引用，不需要手动处理。
- daemon 重启后，你的 MCP 会自动重连并恢复工具列表，无需重启 IDE。
