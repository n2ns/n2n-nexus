# n2n-nexus 重构计划

## 背景与动机

### 现有架构的根本缺陷

当前架构基于"所有 AI 实例运行在同一 localhost 环境"这一错误前提，导致以下问题无法解决：

1. **MCP 进程与 IDE 生命周期绑定**：IDE 关闭 → MCP 进程消失 → 若该实例为 Host，所有数据访问中断
2. **跨环境通信不可行**：Windows IDE + WSL IDE + VM IDE 各自处于不同的 localhost 命名空间，端口扫描选举机制完全失效
3. **Split-Brain 风险**：多实例同时启动时，端口绑定与 HTTP handler 注册之间存在时间窗口，多个实例可能各自成为 Host，数据永久分裂
4. **Re-election 不可靠**：Host 宕机后，所有 Guest 同时触发重选，同样产生 Split-Brain
5. **存储路径各自独立**：每个环境的 `~/.n2n-nexus` 是不同的物理路径，数据天然隔离

---

## 新架构设计

```
┌──────────────────────────────────────────────────┐
│              Nexus Server (daemon)               │
│  独立进程，与 IDE 无关，用户手动启动，持续运行      │
│                                                  │
│  ┌─────────────┐  ┌──────────────┐               │
│  │  REST API   │  │  存储层       │               │
│  │  (HTTP)     │  │  SQLite +    │               │
│  │             │  │  文件系统     │               │
│  └──────┬──────┘  └──────────────┘               │
│    所有业务逻辑、工具定义、数据读写均在此处          │
└─────────┼────────────────────────────────────────┘
          │ HTTP（可跨环境，配置 NEXUS_ENDPOINT 即可）
          │
 ┌────────┼───────────────────────┐
 ▼        ▼                       ▼
MCP-A   MCP-B                   MCP-C
(Win)   (WSL)                   (VM)
无状态   无状态                  无状态
纯代理   纯代理                  纯代理
随 IDE   随 IDE                  随 IDE
启动     启动                    启动
```

### 核心原则

1. **Server 是唯一的真相来源**：所有数据读写、业务逻辑、工具定义只在 Server 侧
2. **MCP 是无状态协议适配器**：不含任何工具定义和业务逻辑，只做协议转换
3. **Server 决定工具能力**：MCP 启动时从 Server 拉取工具列表，工具由 Server 定义和执行
4. **无 fallback 到本地**：Server 不可达时直接报错退出，不做本地降级（降级导致数据分裂）
5. **MCP ↔ Server 全部走普通 HTTP**：不使用 SSE，AI 的请求驱动模型不需要推送

---

## 发布模型：一个 npm 包，两个命令

```
n2n-nexus
         │
         ├─ n2n-nexus daemon     用户手动启动一次，持续运行，与 IDE 无关
         │    HTTP Server，持有所有数据和业务逻辑
         │
         └─ n2n-nexus mcp        IDE 自动启动，随 IDE 生命周期
              无状态代理，连接 Server
```

**Server 启动（用户手动，一次即可）：**
```bash
npx n2n-nexus daemon --root ~/.n2n-nexus --port 5688
# 或通过环境变量
NEXUS_ROOT=~/.n2n-nexus NEXUS_DAEMON_PORT=5688 npx n2n-nexus daemon
```

**MCP 配置（各 IDE，标准 npx 方式）：**
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

跨环境 NEXUS_ENDPOINT 配置：
- 同机所有 IDE：`http://127.0.0.1:5688`（默认）
- WSL IDE 访问 Windows Server：`http://host.docker.internal:5688`
- Windows IDE 访问 WSL Server：`http://<WSL-IP>:5688`
- 局域网其他机器：`http://<Server-IP>:5688`

---

## Server REST API 设计

### MCP 工具能力接口（新增，核心）

```
GET  /api/tools                       返回完整工具定义列表（JSON Schema），供 MCP 注册
POST /api/tools/call                  执行工具调用 { tool, args }，Server 内部分发
```

### 系统接口

```
GET  /health                          健康状态 + 版本信息
GET  /api/storage/info                存储信息
```

### 会话与项目

```
POST /api/session/register            注册会话上下文

POST /api/projects/sync               同步项目资产（manifest + 内部文档）
POST /api/projects/update             更新项目字段
POST /api/projects/rename             重命名项目（级联更新关系）
POST /api/projects/delete             删除项目
GET  /api/projects/search             搜索项目
GET  /api/projects/topology           项目拓扑图（全量或指定项目子图）
```

### 消息与全局协作

```
POST /api/messages/send               发送消息（会议或全局）
GET  /api/messages/unread             读取未读消息（游标自动推进）

GET  /api/global/docs                 列出全局文档
GET  /api/global/docs/:docId          读取指定文档
POST /api/global/docs/:docId          创建/更新文档
POST /api/global/strategy             更新全局策略文档
```

### 会议管理

```
POST /api/meetings/start              开始会议
POST /api/meetings/end                结束会议（可附 summary）
POST /api/meetings/archive            存档会议
POST /api/meetings/reopen             重新开启会议
GET  /api/meetings/:meetingId         获取会议详情
```

### 任务管理

```
POST /api/tasks                       创建任务
GET  /api/tasks/:taskId               获取任务状态
GET  /api/tasks                       列出任务（支持状态过滤）
POST /api/tasks/:taskId/update        更新任务状态和进度
POST /api/tasks/:taskId/cancel        取消任务
```

### 维护

```
POST /api/maintenance/logs            日志清理（prune N 条 / clear 全部）
```

---

## MCP 层设计

MCP Server 启动流程：

```
读取 NEXUS_ENDPOINT（默认 http://127.0.0.1:5688）
  │
  ├─ 连接 stdio transport（立即完成，IDE 认为 MCP 已就绪）
  │
  ├─ 声明 capabilities: { tools: {} }（支持工具，列表暂时为空）
  │
  └─ 后台启动重试循环（每 3 秒）
          │
          ├─ GET /api/tools 失败
          │     → 打印 "[n2n-nexus] Waiting for daemon at <endpoint>..."
          │     → 继续等待，不退出
          │
          └─ GET /api/tools 成功
                → 缓存工具列表
                → 发送 notifications/tools/list_changed
                → IDE 重新拉取，工具出现
```

工具调用流程：

```
CallTool { tool, args }
  │
  ├─ 有缓存工具列表 → POST /api/tools/call { tool, args, instanceId }
  │       成功 → 返回结果
  │       失败（daemon 断开）→ 清空工具列表，重新进入重试循环
  │                           → 返回 AI："Daemon 暂时不可达，请稍后重试"
  │
  └─ 无缓存（daemon 尚未连接）→ 返回 AI："Daemon 尚未就绪，请稍后重试"
```

**daemon 和 MCP 无强制启动顺序**：用户可以先开 IDE 再启动 daemon，工具列表会在 daemon 就绪后自动出现。daemon 中途重启同样自动恢复，不需要重启 IDE。

注意：capability 声明必须包含 `listChanged: true`，否则 IDE 不会响应工具列表变更通知：
```typescript
capabilities: { tools: { listChanged: true } }
```

MCP 不含任何工具名称的 hardcode。daemon 升级加新工具后，所有 MCP 实例无需更新即可获得新能力。

---

## 消息同步：游标 + 按需拉取

不使用 SSE，原因：AI 是请求驱动模型，无法被动接收推送，推过来也还是要主动读。

```
AI-A 发消息:  POST /api/tools/call { tool: "send_message" }
              → Server 存入 SQLite → 返回 OK

AI-B 读消息:  POST /api/tools/call { tool: "read_messages" }
              → Server 查 read_cursors 表
              → 返回该 instanceId 上次读取之后的新消息，自动推进游标
```

SQLite `read_cursors` 表（已有）按 `instance_id + context_id` 追踪各实例读取位置，天然支持多实例增量读取。

未来可选：若需要在 IDE 侧边栏实时展示消息，可增加独立的 `GET /api/events/subscribe` SSE 端点，与 MCP↔Server 核心通信无关。

---

## 文件变更清单

### 删除（彻底移除）

```
src/network/              整个目录（election / host / guest，选举机制全部废弃）
src/auth/                 整个目录（Host/Guest 权限区分不再需要）
src/tools/definitions.ts  工具定义迁移到 Server 侧
src/tools/schemas/        工具 schema 迁移到 Server 侧
src/tools/handlers/       所有 handler 迁移到 Server 侧
src/server/resources.ts   资源读取统一走 Server API
src/resources/            同上
```

### 重写

```
src/index.ts
  仅保留 mcp / daemon 两个命令路由，去除选举相关代码

src/daemon/server.ts
  扩展为完整 REST API Server：
  - 内置所有工具定义（/api/tools）
  - 实现 /api/tools/call 统一分发
  - 补全会议、任务、全局文档等全部端点

src/server/nexus.ts
  重写为纯协议适配器：
  - 启动时从 Server 拉取 tools
  - ListTools → 返回拉取的列表
  - CallTool → POST /api/tools/call 转发

src/client/nexus-client.ts
  简化为两个核心方法：
  - fetchTools(): Promise<ToolDefinition[]>
  - callTool(name, args): Promise<unknown>

src/config/index.ts
  移除选举相关配置，只保留 instanceId / endpoint
```

### 保留不动（存储层，直接复用）

```
src/storage/sqlite.ts
src/storage/sqlite-meeting.ts
src/storage/tasks.ts
src/storage/projects.ts
src/storage/registry.ts
src/storage/logs.ts
src/storage/docs.ts
src/storage/paths.ts
src/storage/store.ts
src/storage/meetings.ts
src/types.ts
```

**SQLite 并发安全说明**：better-sqlite3 在多进程并发写入时会产生 SQLITE_BUSY 锁竞争。新架构中此问题不存在——只有 daemon 一个进程直接访问 SQLite，MCP 进程通过 HTTP 间接访问，天然串行，无并发冲突。

---

## 实施顺序

彻底重构，不做渐进兼容。按以下顺序保证每步结束后可独立验证：

### 第一步：重写 Server（`src/daemon/server.ts`）

- 实现 `/api/tools` 端点（返回完整工具定义列表）
- 实现 `/api/tools/call` 端点（统一工具分发入口）
- 补全会议、任务、全局文档、项目拓扑等全部缺失端点
- 将原 `src/tools/handlers/` 的业务逻辑迁移至此
- 编写 Server 端集成测试，覆盖所有端点

### 第二步：重写 MCP 层（`src/server/nexus.ts` + `src/client/nexus-client.ts`）

- NexusClient 简化为 `fetchTools()` + `callTool()`
- NexusServer 改为：启动时拉取 tools → ListTools/CallTool 转发
- 验证 MCP ↔ Server 全流程（所有工具可通过 MCP 正常调用）

### 第三步：清理

- 删除 `src/network/`、`src/auth/`、`src/tools/`、`src/resources/`
- 简化 `src/config/index.ts`、`src/index.ts`
- 更新测试套件，去除所有选举相关测试

---

## 不在本次重构范围内

- 认证/授权（API key 等）：留待后续需求驱动
- Server 高可用/集群：当前定位是单节点
- IDE 侧边栏实时消息展示：可选 SSE 扩展，独立于核心重构
