# n2n-nexus 使用手册

[English version](USER_GUIDE.md)

本手册介绍装好之后如何使用 n2n-nexus：托盘、哪些对话能互相发消息、检查是否正常、常见问题，以及命令和设置的参考。安装见[安装手册](INSTALL_zh.md)，内部如何工作见[架构说明](ARCHITECTURE_zh.md)，工具说明见[工具参考](TOOLS_REFERENCE_zh.md)。

## 1. 托盘

托盘菜单显示 host 的监听地址和在线会话数，可以打开日志目录和数据目录、切换局域网访问、重启 host、开关 **登录后自启**（`n2n-nexus-host autostart on|off` 效果相同）。中文系统显示中文菜单，其他系统显示英文。

- **允许局域网访问**让其他机器能连上这个 host：见[安装手册](INSTALL_zh.md#6-多台机器和多个环境)。
- **重启**让改过的 `settings.json` 生效。后台服务在运行 host 时，托盘只做控制界面：**重启**会重启服务的 host。

## 2. Claude 桌面版

Claude 桌面版里有两种对话：

- **Code 标签页**：就是 Claude Code。它和 `claude` 命令行用同一份 `~/.claude/settings.json` 的 hooks 和 MCP 服务器，所以 `n2n-nexus install claude` 之后什么都能用，包括直接消息。
- **聊天**：普通的聊天对话。它能用加在桌面版 `claude_desktop_config.json` 里的 MCP 服务器，但不运行 hooks。在这里 n2n-nexus 只提供共享工具（项目、文档、会议、任务、全局聊天），不提供直接消息，因为没有东西告诉 host 这是哪个聊天。

需要互相发消息的会话，请在 Code 标签页里开。

**不要把 n2n-nexus 加进 `claude_desktop_config.json`。** 桌面版里有这一项时，它会把这个服务器以桥接（"sdk"）服务器的形式也交给每个 Code 标签页，顶替掉 Claude Code 自己按 `~/.claude.json` 启动的那份。桌面版的桥接转发工具调用时只带工具名和参数：PreToolUse hook 在 host 上登记的 `claudecode/toolUseId` 被丢掉，桥接连接适配器用的也是桌面版自己的客户端身份。这样的 Code 标签页里所有直接消息工具都会报 "This call carries no agent session"，而消息通知（走 hooks）照常收到。在 macOS 的 Claude 桌面版（Claude Code 2.1.308）上确认过；问题出在桌面版，不在 n2n-nexus。解决：从 `claude_desktop_config.json` 删掉 `n2n-nexus` 这一项，重启桌面版，再新开 Code 标签页对话。此后聊天对话里没有 n2n-nexus 工具，对直接消息没有损失（聊天本来就没有）。

## 3. 对话之间的直接消息

每个对话都会出现在 `peers` 里。新消息会自动通知收件方：用户发来新消息时、每次工具调用后、本轮结束前一次。通知里直接显示正文（被截断的消息用 `read` 读取全文），收件方把它当作你的指令直接执行，不找你确认；有疑问会问发来的那个会话，你不用切换终端。空闲的对话也会被叫醒：每轮结束时，一个后台 hook 最多等待一小时，有新消息就让对话开始新的一轮（Claude Code 通过 `asyncRewake` hook，Codex 通过 `codex queue`），AI 会话之间无需有人输入就能执行对方的请求并回复。无人值守的 `claude -p` 不会被它拖住：这时该 hook 立即返回。Codex 对话只有在运行中的 Codex 应用里已加载时才能被叫醒；Codex 重启后，要等该对话再结束一轮才会恢复，限制详见[架构说明](ARCHITECTURE_zh.md#会话在线状态与唤醒空闲对话)。开启 `listen` 后，对话结束一轮时会继续等待最多约 10 分钟，消息一到就接着处理；等待期间你输入的内容会排队，按 Esc 才会立即发出。

## 4. 检查是否正常

- `n2n-nexus doctor` 检查已安装的命令和 host：见[安装手册](INSTALL_zh.md#7-检查安装)。
- 在对话里让 AI 调用 `peers`：它会列出在线的其他会话。
- 托盘菜单里显示在线会话数。

## 5. 常见问题

| 现象 | 原因和解决办法 |
|---|---|
| 工具调用提示 n2n-nexus-host 不可用 | host 没运行或连不上：启动它（[安装手册第 2 步](INSTALL_zh.md#2-启动-host)）；如果在另一台机器上，打开局域网访问（[第 6 步](INSTALL_zh.md#6-多台机器和多个环境)）。 |
| `peers` 里一直看不到 Codex 会话 | Codex 的 hooks 没有被信任（还没信任，或者 Codex 升级后需要重新信任）：`n2n-nexus doctor codex` 会报告；重新运行 `n2n-nexus install codex`（[安装手册第 4 步](INSTALL_zh.md#4-启用-codex-的-hooks只需一次必须做)）。 |
| 对话能收到消息通知，却没有 `read` / `reply` 工具 | hooks 装了，但这个配置下没注册 MCP 服务器。多个 Claude 配置目录（`CLAUDE_CONFIG_DIR`、账号切换工具）时常见：运行 `CLAUDE_CONFIG_DIR=<那个目录> n2n-nexus install claude`，再新开对话。 |
| 提示"This call carries no agent session" | 对话是在安装 hooks 之前开的（新开一个）、MCP 服务器名不是 `n2n-nexus`，或者身份过期（再调用一次）。在 Claude 桌面版的聊天里这是正常的；在 Code 标签页里出现，说明桌面版把 `claude_desktop_config.json` 里的 n2n-nexus 桥接了过来：把它从那里删掉（第 2 节）。 |
| `claude -p` 脚本 | 不会被后台等待拖住，无需处理。 |

## 6. 参考

### n2n-nexus-host 命令

```bash
# 托盘程序（默认）
n2n-nexus-host

# 前台运行，不带托盘；参数覆盖 settings.json（--port 0 表示任选空闲端口）
n2n-nexus-host serve [--host 127.0.0.1] [--port 5688] [--root <dir>]

# 开机启动的后台服务（Windows 需管理员终端，macOS / Linux 用 sudo）。
# 托盘正在运行 host 时 install 拒绝执行（先退出托盘；再打开时它控制服务），
# 否则把 --host / --port 写进 settings.json，停掉为该数据目录运行的 host，
# 注册并启动服务，最后报告端口上是谁在应答。
# uninstall 删除服务并停掉服务的 host；托盘和前台 serve 继续运行。
n2n-nexus-host service install [--host <addr>] [--port <port>] [--root <dir>]
n2n-nexus-host service uninstall [--root <dir>]
n2n-nexus-host service status [--host <addr>] [--port <port>] [--root <dir>]

# 托盘登录后自启 / 取消
n2n-nexus-host autostart on|off

# Windows：在解压后的发布包目录里安装或升级（默认装到 %LOCALAPPDATA%\Programs\n2n-nexus-host）
n2n-nexus-host install [--dir <dir>]

n2n-nexus-host version
```

用 `sudo` 执行时，服务使用执行 `sudo` 的用户的默认数据目录和日志目录，除非 `--root` 指定了别的数据目录。每个数据目录只能运行一个 host：第二个会报“another n2n-nexus-host is running”并退出。

### n2n-nexus 命令

```bash
# 启动 MCP 适配器（由 IDE 启动）
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp [--id <实例 ID>]

# 为 Claude Code 或 Codex 安装 / 删除 hooks 和 MCP 服务（Claude Code 还有 CLAUDE.md 里的那段内容）
n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]
n2n-nexus uninstall <claude|codex>

# 检查已安装的 hook 和 MCP 命令是否还能运行，以及 host 是否以相同协议版本应答
# （有问题时退出码 1）
n2n-nexus doctor [claude|codex]

# hook 入口（由 install 写进客户端配置）
n2n-nexus hook <claude|codex> [--endpoint <url>] [--wait]
```

### 环境变量

客户端（`n2n-nexus`）：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `NEXUS_ENDPOINT` | MCP 适配器、hooks 和 `doctor` 连接的 host 地址，设为 `discover` 时在局域网里查找 | `http://127.0.0.1:5688` |
| `NEXUS_DISCOVERY_PORT` | 客户端用 `discover` 查询时使用的 UDP 端口 | `5688` |
| `NEXUS_INSTANCE_ID` | 覆盖 MCP 实例 ID（没装 hooks 的客户端调用聊天和会议工具时的身份） | `mcp-<主机名>-<工作目录哈希>-<IDE 名>` |
| `NEXUS_CODEX_COMMAND` | Codex 后台等待以 `<命令> queue ...` 方式运行的命令，`install codex` 和 `doctor` 也用它查询 hook 信任 | `codex`（Windows 上查询信任时默认用 Codex 桌面应用自带的那份） |

host（`n2n-nexus-host`）：只读取 `NEXUS_ROOT`，即数据目录（`--root` 优先）。其余 host 设置都在 `settings.json` 里，托盘、服务和命令行共用。

### settings.json

host 启动时读取；命令行参数优先。文件或字段缺失时使用默认值。

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `host` | 监听地址（IPv4 地址只监听 IPv4，IPv6 地址只监听 IPv6）；`0.0.0.0` 让局域网可以访问 | `"127.0.0.1"` |
| `port` | TCP 端口 | `5688` |
| `discoveryPort` | 局域网发现的 UDP 端口，只有 `host` 不是回环地址时才应答 | `5688` |
| `allowedHosts` | `Host` 头额外允许的域名（IP、`localhost`、`host.docker.internal` 始终允许） | `[]` |
| `rateLimit` | 每个对话（没装 hooks 时每个实例）每秒工具调用数，每个客户端地址为其 5 倍；hooks 另有独立额度：每个对话同样速率，每个客户端地址 5 倍。`0` 关闭限流 | `20` |
| `rateBurst` | 每个对话（没装 hooks 时每个实例）可一次性突发的调用数（最小为 1） | `60` |
| `maxAutoTurns` | 两次用户输入之间，一个对话最多可以自动继续的轮数（包括被叫醒、listen 等待、因消息被拦下不结束）；超过后私信只排队，等用户下次输入。会议新消息不计数也不受限制。`0` 表示不限制 | `0` |
| `stanceReminderMinutes` | 会议当前稿还有必需认可人没表态时，会议可以安静多少分钟；超过后每个没表态的人被提醒一次，草案作者收到一份缺谁的汇总。提醒从不结束会议。`0` 关闭提醒 | `10` |

改完文件后重启 host（托盘 **重启**，或重启 `serve` / 服务）。

### 数据和日志

host 把全部协作数据保存在数据目录里的一个 SQLite 数据库中：

| 平台 | 数据目录 | 日志目录 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\n2n-nexus` | `%LOCALAPPDATA%\n2n-nexus\logs` |
| macOS | `~/Library/Application Support/n2n-nexus` | `~/Library/Logs/n2n-nexus` |
| Linux | `$XDG_DATA_HOME/n2n-nexus`（默认 `~/.local/share/n2n-nexus`） | `$XDG_STATE_HOME/n2n-nexus`（默认 `~/.local/state/n2n-nexus`） |

可以通过 `--root <path>` 或 `NEXUS_ROOT` 改数据目录。

```text
<数据目录>/
├── nexus.db          # 项目、资产、文档、会议、全局聊天、事件、任务、未读游标、对话和直接消息
├── settings.json     # host 设置（见上）
└── host.lock         # 每个数据目录只运行一个 host
```

后台服务，以及自己运行 host 时的托盘，把日志写到日志目录的 `host.log`（单个 10 MB，保留 3 个旧文件）；托盘自己的日志写到同一目录的 `tray.log`；`n2n-nexus-host serve` 输出到标准错误。host 删除哪些数据、什么时候删，见[架构说明](ARCHITECTURE_zh.md#清理与保留期)。

n2n-nexus 0.x 的数据（`~/.n2n-nexus`）不会导入：host 不读取它，也不动它。
