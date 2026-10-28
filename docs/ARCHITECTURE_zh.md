# 架构与标准

[English version](ARCHITECTURE.md)

## 🏛️ 系统架构

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus-host（Go）                 │
│  托盘程序，或开机服务（service install）           │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  HTTP 接口        │  │  存储                 │  │
│  │  GET  /health    │  │  单个 SQLite 文件     │  │
│  │  GET  /api/tools │  │  （nexus.db，WAL），  │  │
│  │  POST /api/tools │  │  带编号的迁移脚本，    │  │
│  │       /call      │  │  每个写操作一个事务    │  │
│  │  POST /api/hook  │  │                      │  │
│  └──────┬───────────┘  └──────────────────────┘  │
│   工具、对话、局域网发现、定时清理                 │
└─────────┼────────────────────────────────────────┘
          │ HTTP（NEXUS_ENDPOINT — 可跨环境配置）
   ┌──────┼──────┐
   ▼      ▼      ▼
MCP-A  MCP-B  MCP-C      hooks（Claude Code / Codex）
(Win)  (WSL)  (VM)       每个客户端事件调用一次 POST /api/hook
n2n-nexus（npm）：无状态适配器，每条 MCP 连接一个
```

两个程序共用一份协议：

- **`n2n-nexus-host`**（Go，`host/`）：保存全部数据、工具定义和业务逻辑。从 GitHub Releases、Homebrew 或 Scoop 安装。
- **`n2n-nexus`**（TypeScript，npm，`src/`）：只有客户端——MCP 适配器（`mcp`）、hook 命令（`hook`）、为 Claude Code 和 Codex 执行的 `install` / `uninstall`，以及 `doctor`。不含存储，也不含服务器。
- **`contract/`** 是两边协议的唯一来源：`tools.json`（每个工具的名称、标题、说明、annotations、输入和输出 JSON Schema）、`hook.json`（hook 字段、`_meta` 键名、时限、上限、通知文本）、`errors.json`（接口、错误格式、状态码）。host 嵌入这些文件，客户端运行时读取 `hook.json`，`tests/conformance/` 里的一致性测试用它们检验 host。`GET /health` 返回 host 的 `contractVersion`，`n2n-nexus doctor` 拿它和客户端的版本比较。

### 核心原则

1. **Host 是唯一的真相来源** — 所有读写、业务逻辑和工具定义都在 host 侧。
2. **MCP 无状态** — 不含 hardcode 工具名、不存本地持久化数据，自己也不持有会话；对话和直接消息都在 host。
3. **Host 决定工具能力** — 适配器启动和重连时拉取 `GET /api/tools`。
4. **无本地降级** — host 不可达时，MCP 每 3 秒重试并报告错误，不做本地 fallback（避免数据分裂）。host 拒绝的工具调用（校验失败、不存在、无权限）作为错误结果（`isError: true`）返回给 IDE，不影响连接；未知工具名返回 JSON-RPC `-32602` 错误。
5. **MCP、hooks 与 host 之间全部走普通 HTTP** — 客户端的 hooks 上报对话事件，并把新消息通知带回给模型；正文由模型用工具读取。

### MCP 启动流程

```
读取 NEXUS_ENDPOINT（默认 http://127.0.0.1:5688）
  │
  ├─ 开始 stdio 服务（MCP TypeScript SDK v2，serveStdio），同时拉一次 GET /api/tools；
  │  第一次 tools/list 最多等这次拉取 1 秒
  │     ├─ 2026-07-28 客户端：server/discover、每请求 _meta 信封，
  │     │  list_changed 经 subscriptions/listen 下发
  │     └─ 2025 代客户端：initialize 握手，主动下发 list_changed
  │
  ├─ 连不上：提示在本机安装并启动 n2n-nexus-host（远程地址则
  │  需在那台机器上启动），自己从不启动
  ├─ 单次调用超时：只让这次调用失败，保留工具列表，不重连
  │
  ├─ 若 host 不在线：重试循环（每 3 秒）
  │     └─ GET /api/tools 成功 → 缓存工具列表
  │           → notifications/tools/list_changed → IDE 重新拉取
  │
  └─ stdin 关闭 → 停止重试、关闭、退出
```

适配器的实例 ID（没装 hooks 的客户端调用聊天和会议工具时的身份）取自该连接上第一次见到的客户端名，来源是请求 `_meta` 中的 `io.modelcontextprotocol/clientInfo`（2026-07-28）或 `initialize`（2025 代），`NEXUS_INSTANCE_ID` / `--id` 可固定。每次工具调用都以 `instanceId` 带上它。装了 hooks 时，聊天和会议调用改为按对话识别（`caller`，经 hook 的 toolUseId 绑定或 Codex 会话 ID 解析），所以共用一个实例的多个对话各有自己的未读游标。

### 对话与 hooks

每个 Claude Code 或 Codex 对话是一个会话，ID 为 `claude:<会话 ID>` 或 `codex:<会话 ID>`，直接使用客户端自己分配的 ID。`n2n-nexus install <claude|codex>` 写入的 hooks 会在 SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd（Claude Code 还有只匹配 n2n-nexus 工具的 PreToolUse）时运行 `n2n-nexus hook <client>`。hook 命令把事件里用于识别的字段转发给 `POST /api/hook`，并打印 host 的回应；每个事件都附上对话所在的机器（`hostname`：macOS 上取 `scutil --get ComputerName` 的电脑名，它由用户设置、不随网络变化，其他系统取去掉 `.local` 的主机名；`platform`：用 `/proc/version` 区分 `wsl` 和 `linux`；`environment`：WSL 发行版名，取自 `WSL_DISTRO_NAME`，因为同一台 Windows 上的发行版共用它的主机名；以及 `utcOffset`），host 要求必须有，存进会话并显示在名字后面，因为不同机器或 WSL 发行版上的会话常常工作目录都一样；在 SessionStart、UserPromptSubmit 和 Stop 时还附上对话标题；出任何错误都以退出码 0 退出、不输出，所以 host 不在也不会卡住客户端。

```
客户端事件 ──▶ n2n-nexus hook ──▶ POST /api/hook ──▶ 会话状态、通知
                                                      │
UserPromptSubmit / PostToolUse ◀── additionalContext ◀─┤  "2 unread direct messages ..."
Stop                           ◀── decision: block   ◀─┘  每次结束前一次，或待命时消息一到就返回
```

工具调用的对话身份不经过模型参数。适配器从请求的 `_meta` 里读取：Claude Code 带 `claudecode/toolUseId`，由调用前刚运行的 PreToolUse hook 绑定到对话（已实测：调用会等 hook 结束）；Codex 带 `sessionId`。适配器把它作为 `caller` 放进 `POST /api/tools/call`。身份是对话而不是适配器进程，所以适配器重启、恢复对话、子代理都沿用同一身份，一个适配器也能同时服务多个 Codex 对话。

通知带上每条消息的完整正文（一条通知里的正文合计截到 `notifyTextChars`，即 5000 个字符；被截断的消息用 `read` 读全文），请求随 hook 注入的上下文或 Stop 的理由送到模型面前，Claude Code 把它当作 hook 反馈来看待，而不只是工具结果。通知只陈述事实：发送方、正文、要不要回复、怎么回复（Claude Code 会话还给出工具全名）；不声明任何授权，因为客户端自己的提示把 hook 输出说成"不是用户输入"，hook 文本里的授权声明只会和它打架。Claude Code 只在用户自己的指令要求时才照其他会话的消息去做，所以 `install claude` 会在用户级 `CLAUDE.md` 里加一段写明这一点的标记内容，授权只来自那里。完整显示的消息在提醒驱动这一轮时（Stop、待命、后台唤醒；唤醒失败会恢复为未读，但消息到达的同时用户按下 Esc、客户端没读到的 Stop 文本会连同消息一起丢失）标为已读，无需回复的消息随提示词显示时也标为已读。随提示词显示、需要回复的消息，以及工具调用后显示的所有消息（那段上下文可能是子代理的，对话本身看不到），仍为未读，直到 `reply` 回复它或 `read` 读取它，本轮结束时 Stop 照样为它拦住一次。待命中的 Stop hook 最长挂起 590 秒，消息一到立即返回；客户端杀掉 hook（用户按 Esc）或 host 关闭时结束等待。系统仍采用可信本地 host 边界，这不是身份认证机制：同一系统用户下的所有进程都被视为可信，可以冒充任何对话；需要互相隔离的代理应以不同的系统用户运行，各自使用自己的 host（见[安全文档](SECURITY_zh.md#安全模型)中的本地信任模型）。精确契约见[工具参考](TOOLS_REFERENCE_zh.md#对话之间的直接消息)。

### 会话、在线状态与唤醒空闲对话

新对话的 SessionStart hook 会输出一段介绍：它自己的名称和 ID、没有离线的其他会话（最多列 5 个）、`peers`、`send`、`read` 的用法，客户端自带的代理列表看不到这些会话，以及协作规则（消息可以要求什么由用户自己的指令决定，有疑问问发送方；交出工作时把对方需要的一切写进一条消息，发完就结束本轮而不是用 `read` 轮询；只回复一次结果，做不完时说明卡在哪里、需要什么才能继续；不发单纯的确认；不把任务推回给发来的会话）。适配器也会在 MCP 的服务器 instructions 里给出同样的说明。客户端不一定会报告对话结束，所以 `idle` 或 `working` 的会话 30 分钟没有任何活动就算 `offline`，直到它下一次有事件。

空闲的对话并没有在运行，只靠 hooks，要等它的用户有动作才能把消息送进去。为了让 AI 会话之间无需有人输入就能执行对方的请求并回复，`install` 会增加第二个 Stop hook `n2n-nexus hook <client> --wait`，每轮结束时启动一个后台等待：

```
一轮结束 ──▶ Stop hook（提醒未读，或进入 listen 等待）
         └─▶ Stop hook --wait ──▶ POST /api/hook {BackgroundWait}（每次最多 590 秒，循环最长 1 小时）
                                    │  等待期间会话显示为 "listening"
                                    ├─ 有新消息 ─▶ { wake: 通知, dispatchId }
                                    │     Claude Code：asyncRewake hook 以退出码 2 结束，通知开启新的一轮
                                    │     Codex：独立后台进程执行 `codex queue --thread <id> --message <通知>`，
                                    │       再回报 POST /api/hook {WakeResult, dispatch_id, ok}
                                    ├─ 该会话有其他任何事件 ─▶ null（等待结束）
                                    └─ 时间到或 host 关闭 ─▶ { timeout: true }（再次请求）
```

后台等待会在原有的一小时时限内重试临时连接故障；使用 `discover` 时重新查找 host。正常取消（`output: null`）仍结束等待。host 与客户端都需要包含这项恢复行为，才能在 host 正常重启后继续等待。

会话处于 `working`，或者 listen 模式的 Stop hook 正在等待时，后台等待不会送达，所以同一条消息只提醒一次。`codex queue` 失败（出错或退出码非 0）时，Codex 的后台等待回报 `ok: false`，host 撤销这次唤醒：它提醒过的消息和通知重新算作未提醒，会话退出 `working`，这一轮不计入自动轮次；随后等待在 1 秒后重新请求（每失败一次间隔加倍，最长 5 分钟），再次送达它们。回报到达前该会话已有其他事件，说明唤醒已送达，回报被忽略。已在 Windows 上用 Claude 桌面应用和 Codex 桌面应用实测（2026-10-23）：两个方向都能在数秒内叫醒空闲的对话。已知限制：

- Codex 只会为运行中的 Codex 应用里已加载的对话启动排队的一轮。Codex 重启后，用户点开对话才会加载。
- Codex 的后台等待会随 Codex 应用退出而结束，要等该对话再结束一轮才会重新启动。这期间发来的消息留在 host 里为未读（不进入 Codex 自己的队列），直到用户下次在该对话里发消息。
- Claude Code 的对话在最后一轮结束后一小时内可被叫醒（hook 的超时时间）。
- 每次 AI 回复都会再次叫醒对方，所以会话之间不用有人输入就能一轮轮处理对方的请求。要设上限，就在 `settings.json` 里设置 `maxAutoTurns`（默认 0，不限制）：host 会统计从用户上次输入以来的自动轮次（被叫醒、listen 等待、因消息被拦下不结束），达到这个数后不再自动继续；叫醒后一分钟内的那次用户提交视为被叫醒的那一轮开始，不清零计数。超过上限的消息会等用户下次输入时再提醒。会议新消息不计数，也不受上限限制：会议一直进行到被结束为止；`wake: false` 的消息从不叫醒任何人。
- 自动轮次的计数只按时间区分"被叫醒的那一轮"和"用户输入"。如果一次唤醒没有真正开始新的一轮（例如 Codex 对话没加载），而用户在那一分钟内亲自输入，这次输入不清零计数，用户下一次输入才会清零。如果被叫醒的那一轮晚于一分钟才开始（例如用户之后才点开的 Codex 对话），它的提交会清零计数。两种情况都不会丢消息，也不会让会话在无人参与时无限循环。

---

## 💾 数据持久化

全部数据都在 host 数据目录里的一个 SQLite 文件 `nexus.db` 中，同一目录下还有 `settings.json` 和 `host.lock`（各系统的位置见[使用手册](USER_GUIDE_zh.md#数据和日志)）。

- **表结构**：嵌入 host 的编号迁移脚本（`host/internal/store/migrations/0001_core.sql`、`0002_agents.sql`）在启动时按序执行，每个文件一个事务；版本号存在 `PRAGMA user_version`。版本高于 host 的数据库会被拒绝，提示升级 host，或在版本说明要求时删除 `nexus.db`。每个文件包含一个模块当前的完整表结构（`0001_core.sql`：internal/core；`0002_agents.sql`：internal/agents）；以后改表结构时新增编号文件。
- **表**：`projects`（manifest 的标量字段各占一列，结构化字段存 JSON，内部文档存文本）、`project_relations` 和 `project_assets`（资产内容存 BLOB；两者都随项目改名、删除级联）、`global_strategy`、`global_docs`、`meetings`（带 `status` 和 `is_default`）、`meeting_messages`（用 `seq` 按会议编号）、`meeting_members`（谁参加、以什么方式、已提醒到哪里）、`decisions`、`global_messages`、`events`、`tasks`、`read_cursors`，以及对话用的 `agent_sessions`、`agent_messages`、`agent_notices`、`agent_idle_subscriptions`、`tool_use_bindings`，以及 `hooked_instances`（调用时解析出过对话的适配器实例，用于聊天和会议的身份识别）。
- **事务**：每个写操作一个事务，多行修改（会议消息，开始 / 结束 / 重开会议，项目改名）要么全部生效，要么都不生效。数据库使用 WAL 模式，开启 `foreign_keys`，忙等超时 5 秒，只用一个连接。
- **只有 host 打开数据库**。MCP 适配器和 hooks 都走 HTTP。
- **活动日志**：通过工具产生的状态变更（项目同步 / 更新 / 改名 / 删除 / 资产、文档同步、策略更新、会议开始 / 结束 / 归档 / 重开、维护）记录为结构化事件，用 `list_events` 读取，不混入聊天流。

会议成员和表态记录实际解析出的身份类型；草案资格在发布事务中保存快照。

### 清理与保留期

启动时一次，之后每小时一次，host 会：

- 把超过 TTL 的待处理或运行中任务标为 `failed`，删除结束（`completed`、`failed`、`cancelled`）7 天后的任务；
- 删除 30 天前的事件；
- 让超过 24 小时有效期的未读直接消息过期（通知发送方），删除 30 天前已读或已过期的直接消息和已发出的通知；
- 删除已过期（5 分钟）的工具调用绑定。

日志（文件和位置见[使用手册](USER_GUIDE_zh.md#数据和日志)）：只有持有 `host.lock` 的一方写 `host.log`；托盘自己的日志写到 `tray.log`。

---

## 🌐 发布模型

两个程序的命令见[使用手册](USER_GUIDE_zh.md#6-参考)。

**Host**：以托盘程序或开机服务方式运行；适配器和 hooks 从不自己启动它，连不上时只报告。配置只来自 `<数据目录>/settings.json`（`host`、`port`、`discoveryPort`、`allowedHosts`、`rateLimit`、`rateBurst`、`maxAutoTurns`、`stanceReminderMinutes`），命令行参数覆盖；host 只读取 `NEXUS_ROOT` 一个环境变量。服务拿不到安装终端的环境变量，所以这个文件是托盘、服务和命令行共用的唯一来源。

**局域网独立 host**：一个开启局域网访问的 host 为所有机器服务，不依赖任何 IDE；每台客户端机器只需要客户端，它通过 UDP 广播找到 host（`--endpoint discover`）。配置步骤见[安装手册](INSTALL_zh.md#6-多台机器和多个环境)。

**无启动顺序要求**：可以先启动 IDE 再启动 host——host 上线后工具会自动出现。host 重启对 IDE 透明，MCP 自动重连并通知 IDE。

### 各平台的托盘与服务

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 开机服务（`service install`，需管理员 / root） | 计划任务 `n2n-nexus-host`：开机触发，以安装用户 S4U 登录（不保存密码），无时限 | `/Library/LaunchDaemons/io.n2ns.n2n-nexus-host.plist`，含 `UserName`、`RunAtLoad`、`KeepAlive` | `/etc/systemd/system/n2n-nexus-host.service`，含 `User=`、`Restart=always`、`RestartSec=5` |
| 托盘登录后自启（`autostart`、托盘菜单） | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `n2n-nexus-host` 值 | `~/Library/LaunchAgents/io.n2ns.n2n-nexus-host.tray.plist` | `~/.config/autostart/n2n-nexus-host.desktop` |
| 托盘开启局域网访问 | 经 UAC 确认用 `netsh advfirewall` 添加 TCP / UDP 入站规则 | 提示需要放行的端口 | 提示需要放行的端口 |

所有服务都运行 `n2n-nexus-host serve --supervise --root <数据目录> --log-dir <日志目录>`，目录取自安装用户，服务自己的环境变量改不了它们：监督进程以子进程运行 `serve`，子进程退出 5 秒后重新启动，日志写到 `host.log`。托盘正在进程内为该数据目录运行 host 时，`service install` 拒绝执行（先退出托盘，再打开时它控制服务）；否则先停掉为该数据目录运行的 host（按 `host.lock` 里记录的 PID，不按命令行字符串匹配），把 `--host` / `--port` 写进 `settings.json`，注册并启动服务，最后报告端口上是谁在应答；用 `sudo` 执行时使用调用者的默认目录。`service uninstall` 删除服务，只停服务自己的 `serve`，不停托盘或前台 `serve`。托盘启动时先在配置的端口上探测 `GET /health`：已有 host 应答（例如服务）时只做控制界面——**重启**（以及改设置）会在数据目录写入 `restart-request`，服务的 `serve` 每秒检查一次，看到后退出，由监督进程用新设置重新启动（用文件是因为托盘无权结束计划任务 S4U 登录下的进程），再最多等 20 秒等它重新应答，自己从不另起 host——否则在进程内运行 host。在托盘里改设置会写 `settings.json` 并重启 host。菜单显示 host 实际绑定的地址和在线会话数（`GET /health` 的 `sessions.online`），每 5 秒刷新。IPv4 地址（含 `0.0.0.0`）只监听 IPv4，IPv6 地址只监听 IPv6。托盘文本在中文系统上为中文，其他为英文（macOS 上没有 `LANG` 时，例如作为登录项启动，读 `AppleLanguages`）。macOS 托盘依赖 cgo（Cocoa），所以 macOS 发布版本在 macOS 上用 `CGO_ENABLED=1` 构建；Windows 和 Linux 用 `CGO_ENABLED=0` 交叉编译，Windows 发布同一程序的两个构建：`n2n-nexus-host.exe`（控制台程序，用于命令；不带参数运行时启动同目录的托盘构建后立即返回）和 `n2n-nexus-host-tray.exe`（GUI 程序，`-H=windowsgui`，不开控制台窗口；登录后自启注册的是它）。

### 单实例

host 在打开数据库之前对 `<数据目录>/host.lock` 加独占锁，并在其中记录自己的 PID、监督进程的 PID 和角色（`tray`、`serve` 或 `supervised`）。同一数据目录的第二个 host 会报“another n2n-nexus-host is running for <dir> (PID n)”并退出。

---

## 🧩 Host 内部结构

```
host/
├── cmd/n2n-nexus-host/   命令行：托盘（默认）、serve、service、autostart、version
└── internal/
    ├── config/           数据和日志目录、settings.json
    ├── protocol/         加载嵌入的协议（contract/contract.go），编译 JSON Schema，
    │                     去掉未声明的参数键，校验参数和结果
    ├── store/            打开 nexus.db、执行迁移、事务
    ├── core/             项目、文档、会议、聊天、事件和任务工具及其表
    ├── agents/           对话：hooks、直接消息工具、等待，以及它们的表
    ├── api/              HTTP 服务器：4 个接口、Host / Origin 检查、请求体上限、限流
    ├── discovery/        UDP 局域网发现应答
    ├── host/             组装一个 host：锁、数据库、工具、服务器、发现、每小时清理、日志
    ├── tray/             托盘菜单及中英文文本
    ├── service/          开机服务、托盘自启、`serve --supervise` 监督进程、防火墙脚本
    ├── clock/            系统时钟和测试用可设置时钟
    └── testhooks/        只在测试构建（`-tags testclock`）中存在：POST /test/clock、--test-listen-wait-ms
```

Go 模块是仓库根目录的 `github.com/n2ns/n2n-nexus`，所以 host 直接嵌入 `contract/`。工具只有出现在 `contract/tools.json` 里才存在；host 为每个工具注册一个处理函数，启动时记录缺少处理函数的工具。

**会话状态机**：`agents.Agents` 是一个 host 的进程内协调者。它把全部内存中的对话状态——挂起的 listening Stop、后台等待、自动轮次计数、唤醒时间——放在一把互斥锁后面；每个 hook 和直接消息工具调用都在锁内执行，存下消息或通知的一方在释放锁之前就把它交给正在等待的 hook。启动时把上一个 host 留下的 `listening` 会话复位为 `idle`。关闭时先用 `{ "output": { "timeout": true } }` 答复挂起的后台等待，让客户端重连；挂起的 listening Stop 仍返回 `{ "output": null }`，然后再关闭服务器。时间来自 `Clock`：正式版本用系统时间，`testclock` 构建中由一致性测试通过 `POST /test/clock` 设置。

**发现**：`host` 不是回环地址的 host 在 UDP `discoveryPort` 上应答 `n2n-nexus/discover`，回复 `{"service":"n2n-nexus","version","host","port"}`。`NEXUS_ENDPOINT=discover` 的客户端在 `NEXUS_DISCOVERY_PORT` 上广播查询，使用第一个应答并缓存在 `~/.n2n-nexus/discovered-endpoint`。

---

## 📡 HTTP 接口

host 只有四个接口（见 `contract/errors.json`）：

```
GET  /health                 { ok, service: "n2n-nexus", version, contractVersion, sessions: { online } }
GET  /api/tools              contract/tools.json 中的工具定义（JSON Schema）
POST /api/tools/call         { tool, args, instanceId, caller? } → { ok: true, result }
POST /api/hook               客户端 hook 事件 { client, input } → { output }；BackgroundWait 事件即后台等待
```

所有能力都是工具，没有其他 REST 路由（未知路由返回 404）。工具调用先去掉 schema 未声明的键，再按输入 schema 校验 `args`（400 `Invalid arguments for <tool>: ...`），结果按输出 schema 校验。调用方造成的失败（包括“找不到”）返回 400 和错误文字；未知工具返回 404。错误体为 `{ ok: false, error }`。

### 请求防护

host 没有身份认证，所以要挡住网页：拒绝浏览器发起的请求（带 `Origin` 头或跨站 `Sec-Fetch-Site`：403）、既不是 IP 也不是 `localhost`、`host.docker.internal` 或 `allowedHosts` 中名称的 `Host`（403，防 DNS rebinding）、不是 `application/json` 的 POST（415）和超过 16 MB 的请求体（413）。

限流使用令牌桶（每秒 `rateLimit`，可突发 `rateBurst`；`rateLimit: 0` 关闭），超限返回 429 和 `Retry-After`：

- 工具调用按对话计（hooks 根据调用方的 Claude `toolUseId` 或 Codex `sessionId` 识别出的会话），识别不出时按 `instanceId` 计，另外因为这些 ID 是自报的，再按客户端地址以 5 倍额度计；
- hooks 按对话（`<client>:<session_id>`）计，并按客户端地址以 5 倍额度计，都是独立的桶，忙碌对话的 hooks 不会占用该地址的工具调用额度；
- `GET /health` 和 `GET /api/tools` 不限流。

信任模型不变：同一操作系统用户的所有进程都被视为可信。见[安全文档](SECURITY_zh.md)。

## 边界说明

- 默认不提供云端桥接。
- 默认不做跨机器实时同步——如需要，让 `NEXUS_ENDPOINT` 指向可达的 host，或设为 `discover`，通过 UDP 广播查找开启了局域网访问的 host。
- 单 host 节点，不内置集群。
- 开源基础版本不包含认证层。
