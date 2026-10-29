# 更新日志 (Changelog)

[English version](../CHANGELOG.md)

本项目的所有重大变更都将记录在此文件中。

## [0.12.4] - 2026-10-30

### 修复

- Windows 上空闲的 Codex 对话重新能被叫醒。Stop `--wait` hook 启动的后台等待进程继承了 Codex 读取 hook 输出用的管道（Codex 通过 PowerShell 运行 hook），Codex 一直等这些管道直到 hook 超时，然后连等待进程一起结束：会话从不显示为 `listening`，只在下次输入或调用工具时才看到消息。现在等待进程由 PowerShell 的 `Start-Process` 启动，它不传递任何句柄。

### 变更

- 客户端回报失败的唤醒（`codex queue` 出错或退出码非 0）在 host 撤销它时记入 `host.log`：会话、唤醒 ID、再次送达的消息和通知各有几条。此前撤销和重试不留任何痕迹。

## [0.12.3] - 2026-10-29

### 修复

- Stop 事件丢失的会话（回合结束时 host 正好关闭或重启）像其他会话一样 30 分钟后过期：后台等待在会话处于 working 时不再算作它的活动，于是它不再被报告为 working，发给它的消息也不再等待一个永远不会到来的唤醒。
- 绑定到名字的 host（`--host mybox`）接受以该名字寻址的请求：它自己的健康探测、托盘和 `service install` 不再得到 403、不再报告没有应答。
- 资料文本（`set_profile` 的 title、note、label）、客户端报告的标题、主机名、WSL 发行版名和工作目录都按单行存储：其中的换行和 Unicode 行分隔符不能再在其他会话的通知里伪造消息的框架行。
- `leave_meeting` 之后重新加入会议的成员按文档所说从最新消息开始，而不是因错过的消息被拒绝第一次发言。
- 旧版本 host 写的数据库迁移失败时，提示在该版本的 CHANGELOG 要求重置数据目录时删除 `nexus.db`，而不是只给一条 SQL 错误。
- 客户端能承受端点上不是 n2n-nexus host 的情况：错误状态加非对象响应体不再让 hook 或 MCP 适配器崩溃；工具列表不是列表时适配器保持未连接（继续重试）而不是半连接；工具调用得到非对象响应体时作为传输错误失败。发现缓存先写临时文件再改名到位，并发的 hook 不会读到半截 URL。
- Windows 上通过 `install` 升级时，数据目录以反斜杠结尾且含空格也能带着原数据目录重启后台服务。

### 变更

- **允许局域网访问**添加的 Windows 防火墙规则只对专用和域网络生效，不含公用网络。早先版本添加的规则在关闭再开启局域网访问之前不会改变。
- WSL 上 MCP 适配器的实例 ID 包含发行版名，因为同一台 Windows 上的发行版共用主机名；同一工作区的两个发行版不再共用聊天和会议的已读游标。WSL 用户的 ID 会变一次，这些游标随之重置（hooks 按对话记录的游标不受影响）。

## [0.12.2] - 2026-10-29

### 变更

- 托盘图标和 README logo 更大、更简洁：网络图形几乎占满方块，底色提亮一档，去掉了灰边。
- 整理 host 和客户端的内部代码，行为不变：已读游标和会议通知标记由会议和对话共用一份实现（`host/internal/cursors`）；局域网发现查询串改从契约读取（`contract/hook.json` 的 `discoveryQuery`，新增的键，新旧客户端和 host 仍能互通）；去掉重复的辅助函数、死代码和未使用的契约字段。客户端测试每次运行只构建一次。

## [0.12.1] - 2026-10-29

### 变更

- 新的托盘图标，README 的 logo 同步更换：炭黑圆角底加灰边，上面是一张小网络，中间一个红色节点，用浅蓝连线连到四个白色节点。取代托盘里原来的青色圆形和六边形 logo；`assets` 里旧的图标和横幅文件已删除。macOS 菜单栏只显示这张网络图形，用模板图，系统按菜单栏明暗显示成黑色或白色。

### 修复

- host 因你自己的调用而发的消息（席位已占据、AI 共识提示、席位的批准或否决）对你算已读：席位入座或定完一点后可以立刻发下一稿，表态凑齐 AI 共识的成员也可以紧接着发言，不会因为那条消息被拒。
- 会议提醒不再重复 `read_messages` 以未读模式已经返回的消息：读过会议即视为已提醒，下一次 hook 提醒只显示之后新来的。
- 有用户席位的会议里，"审批人名单已变更"的消息不再列出席位会话，它不在任何审批人名单里。

## [0.12.0] - 2026-10-29

每台机器上的 host 和客户端要一起升级（契约版本 4）。数据库原地升级：保留 `nexus.db`。

### 新增

- 有用户席位的会议：用户所在终端的对话用 `start_meeting` 或 `join_meeting` 带 `seat: "user"` 坐上席位；后坐的会话接管席位。席位 `endorse` 当前稿时 host 发出 `DECISION`（附仍未解决的反对），会议接着进行下一个点；席位 `object` 即否决草案。其他人的共识此时不做决定，只在成立或失去时通报。只有席位能结束这类会议，且要写总结；其他人的 `end_meeting` 变成一条提议结束的消息。`list_meetings` 返回 `seat`，`approvals` 带席位的表态。
- 按时间清理，启动时一次、之后每小时一次，`settings.json` 两个字段：`meetingRetentionDays`（默认 30）和 `retentionDays`（默认 7）。已读或已过期的直接消息、已发出的通知、事件、结束的任务、没有活动的会话（仍被直接消息引用的除外）和没再出现的适配器实例在 `retentionDays` 后删除；连续 `meetingRetentionDays` 没有发言的进行中会议以 `endReason: expired` 关闭，关闭或归档满 `meetingRetentionDays` 的会议删除。有改动的清理记一条 `maintenance.cleanup` 事件。
- `host_maintenance` 新增 `cleanup`（加 `dryRun` 先看会删什么）和 `export`（把会议导出为 markdown）。

### 变更

- 先读后发：还有别人的未读消息时，会议里的 `send_message` 以及 `endorse` / `object` 被拒，结果附上这些消息（正文按 `notifyTextChars` 截断），它们随即算已读。被拒后的下一次发言放行，并附注当时未读的范围；草案和 `DECISION` 必须读完才能发。`withdraw` 照常执行并附上未读消息。
- 会议通知像私信一样显示每条消息的正文；叫醒、Stop 或提示词完整显示的算已读。
- 反对，以及改变上一次立场的表态，说明里要有依据（`#n`、文件路径、URL，或以 实测：/文档：/数据： 或 Measured:/Docs:/Data: 开头的一句）；同一份提案上最多改变立场两次。
- 会议消息、全局聊天和会议成员保存写入时发送方的名字和机器；旧数据库里的行在升级时补填，`read_messages` 返回 `senderBackfilled`，成员带 `machine` 和 `backfilled`。
- 会话报告所在环境（WSL 发行版，显示在平台后面：`Vector · WSL Ubuntu_26`）；macOS 上的主机名取系统设置里的电脑名。会话名为 `<客户端>@<目录>#<会话 id 最后 4 个字母和数字>`，和库里其他会话重名时多取几位，名字不会被复用。
- 托盘菜单第一行只写 host 是否在运行（"运行中"、"运行中 · 后台服务"或"未运行"）；地址单独一行，没有 host 应答时这一行显示原因。去掉了"（局域网）"后缀：**允许局域网访问**的勾选已经表示同一件事。

## [0.11.0] - 2026-10-29

每台机器上的 host 和客户端要一起升级，并在新 host 启动前删除 host 数据目录里的 `nexus.db`：这个版本启用新的数据库和契约版本，旧的 host 或客户端不能再和它配合使用。

### 新增

- 会话显示所在的机器。每个 hook 事件都带 `machine`（去掉 `.local` 的主机名、平台 `darwin` / `linux` / `wsl` / `win32`、本地时间减 UTC 的分钟数），缺少时 host 拒收。`peers` 和 `set_profile` 返回 `hostname`、`platform`、`utcOffset` 和 `label`；介绍和通知显示 `名字 (<标签或主机名> · <平台>)`；`read_messages` 返回 `senderMachine`。`set_profile({ label })` 给机器起名，显示时取代主机名。

### 变更

- 契约版本 3：host 和客户端必须一起升级（`n2n-nexus doctor` 会报告不匹配）。
- 数据库表结构改为每个模块一个文件，不再支持从旧数据库升级：启动这个 host 前删除 `nexus.db`（留着旧文件时 host 会提示）。
- 通知、协作规则、工具描述和 MCP 说明只陈述事实（发送方、正文、要不要回复、怎么回复），不再声明消息是已批准的指令；授权只保留在 `install claude` 写进 `CLAUDE.md` 的那段里。Claude Code 收件方会看到回复工具的全名。
- `send` / `read` / `reply` 和 `send_message` / `read_messages` 的描述第一句互相指引；介绍、`peers` 和 MCP 说明写明客户端自带的代理列表看不到 nexus 会话；`send` 提示发送方结束本轮，不要用 `read` 轮询。

## [0.10.0] - 2026-10-28

### 新增

- `n2n-nexus install claude` 在用户级 `CLAUDE.md` 里写入一段带标记的内容（`<!-- n2n-nexus:begin … -->` 到 `<!-- n2n-nexus:end -->`）：其他会话发来的直接消息就是用户本人的指令，照要求执行、不找用户确认，有疑问问发送方。Claude Code 只在用户自己的指令要求时才照其他会话的消息去做，所以需要这一段。文件里的其他内容原样保留；`uninstall claude` 删除这一段，文件里没有别的内容时连文件一起删。升级后再运行一次 `install claude` 才会写入。

### 变更

- 直接消息整条送达：通知里显示每条消息的正文，夹在 `--- Message <id> from … ---` 和 `--- End of message <id> ---` 之间，并说明怎么回复，不再只带发送方和第一行。一条通知里的正文合计截到 5000 个字符（契约里的 `notifyTextChars`）；被截断的消息会标出来，`read` 返回全文。完整显示的消息在通知让本轮继续或开始时（Stop、待命、后台唤醒）标为已读，无需回复的消息随提示词显示时也标为已读；`reply` 把被回复的消息标为已读。其他消息仍为未读，留给 `read`，其中包括工具调用后显示的所有消息，因为那段上下文可能只到了子代理。
- 通知、SessionStart 介绍和 MCP 说明写明这些会话属于同一个用户：消息就是这位用户的指令，照要求执行、不找用户确认、不超出范围；需要更多工作或缺少信息时用 `reply` 问发送方。`send` 的指引是把对方需要的一切写进一条消息；任务只回复一次结果，做不完时说明卡在哪里、需要什么才能继续。

## [0.9.5] - 2026-10-26

### 新增

- Windows 上的 host：`n2n-nexus-host.exe install [--dir <dir>]` 从解压后的发布 zip 把 host 安装到 `%LOCALAPPDATA%\Programs\n2n-nexus-host`，第一次安装时打开登录后自启，并启动托盘。从新版本的发布包里再运行一次即可升级：它会替换程序（正在运行的程序先挪开，下次安装时删除）、重启托盘，并在管理员确认后让后台服务改用新版本、按原来的数据目录重启。

### 变更

- `n2n-nexus install codex` 直接在 Codex 里信任 n2n-nexus 的 hooks：它向 Codex 自己（`codex app-server`；Windows 上用 Codex 桌面应用运行的那份，否则用 `PATH` 上的 `codex`）取得每条 hook 的信任哈希并存下，不再需要 `/hooks` 这一步。失败时会说明怎么手动信任（Codex 桌面应用的设置，或命令行里的 `/hooks`）。`n2n-nexus doctor codex` 会向 Codex 核对 hooks 是否被信任，Codex 升级可能会让信任失效。

## [0.9.4] - 2026-10-26

### 变更

- 契约版本升为 2：npm 客户端和 host 必须一起升级（`n2n-nexus doctor` 会报告版本不一致）。
- 装了 n2n-nexus hooks 时，聊天和会议识别的是对话本身，而不是 MCP 适配器实例。同一个 IDE 在同一个工作区里的多个对话共用一个实例；现在它们各有自己的未读游标，它们的消息、会议的 `initiator` 和 `participants`、`meeting.*` 事件的 `actor` 都带会话 ID（`claude:<id>` / `codex:<id>`），可以用于 `send`。没装 hooks 的客户端仍按实例。某个实例在最近 30 分钟内识别出过对话、而某次调用识别不出时，调用会失败并提示重试，而不会通过共用的游标读取。结果里的 `identity` 说明用的是哪种身份。
- `read_messages` 的未读模式不再返回你自己发的消息；对话第一次以未读模式读全局聊天时从最新消息开始。新增历史模式：`latest: true` 或 `afterId` 读取时不移动游标，并包含自己的消息。每条消息带 `senderName`，`category` 总是存在（没有类别时为 null）。
- 会议消息按会议编号，从 1 开始：`read_messages` 的 `id`、`send_message` 返回的 `messageId`（发到会议时现在也返回）和会议里的 `afterId` 都用这个编号，新会议不再接着之前会议的编号。

- 会议有了成员。新增 `join_meeting(meetingId, mode?, approver?, since?)` 和 `leave_meeting(meetingId)`；发起者自动加入自己的会议。会议新消息通过 hooks 送达成员，每个会议一行：active 成员会被叫醒（或本轮继续），async 成员在下次输入或调用工具时看到，自己发的消息不会提醒自己。会议新消息不算自动轮次，超过 `maxAutoTurns` 后仍会送达，所以会议一直进行到被结束为止；结束时其他每个成员收到一条通知。`list_meetings` 显示成员和会议引起的叫醒次数。
- 以共识形成决议。`send_message(..., draft: true)` 发布会议的当前稿并确定它的必需认可名单（通过 hooks 以 `required` 身份加入的成员）；`stance(meetingId, messageId, endorse | object | withdraw, note?)` 对它表态，反对要带理由。当前稿至少有两名必需认可人全部认可、且没人反对时，会议自动以这份草案作为 `DECISION` 结束（`endReason: consensus`；`end_meeting` 记为 `manual`）。普通提案不会重置表态；认可人离开或重新加入会改变名单，名单变化会发到会议里。安静超过 `stanceReminderMinutes`（`settings.json` 新字段，默认 10）仍未表态的必需认可人会被提醒一次。`list_meetings` 显示每个会议的 `endReason` 以及当前稿和各人表态。
- 私信说明它要什么：`send` 和 `reply` 新增 `expectsReply`（false：通知注明无需回复，也不要求回复）和 `wake`（false：不叫醒收件方、不拦住它结束这一轮，等它下次输入或调用工具时再看）。`read` 返回 `expectsReply`。
- 会话有了可读的 `title`：Claude Code 或 Codex 里显示的对话标题，由 hooks 读取，显示在 `peers`、介绍、通知和会议成员里名称的旁边。`set_profile({ title })` 可以自己设置（设为 `""` 恢复客户端的标题）。`send` 仍用名称。
- 一条私信只完整列出一次；它一直未读时，之后的通知只计数。

### 修复

- `codex queue` 失败时不再丢失唤醒：Codex 的后台等待回报投递结果，host 撤销没送达的唤醒，等待隔一段时间（1 秒起，每次加倍，最长 5 分钟）后重试，同样的消息和通知会再次唤醒对话；失败的那次唤醒不计入自动轮次。会话不再一直停在 `working` 直到过期。
- 30 分钟无活动而被判为离线的会话，现在会像正常结束的会话一样通知订阅了 `notifyWhenIdle` 的人，订阅者只在后台等待时也一样。
- 被叫醒的那一轮开始时，提示词不再重复叫醒时已经提醒过的内容。
- Codex 的 SessionEnd hook 符合 Codex 的 3 秒上限：`n2n-nexus install codex` 写入超时 3（已有安装要重新运行一次，Codex 的 "clamping SessionEnd hook timeout" 告警随之消失），SessionEnd 请求 1.5 秒后放弃，不再重新查找 host。
- `n2n-nexus uninstall <client>` 不再要求客户端在 PATH 上：照样从客户端的配置文件里删掉 hooks。找不到客户端时跳过 `<client> mcp remove`，MCP 服务仍有注册时会说明这一点以及怎么删（之后再运行该命令，或从 `~/.claude.json` / `config.toml` 里删掉 `n2n-nexus` 条目）。`install` 仍要求客户端存在。
- 工具调用在 hooks 识别出对话时按对话限流，共用一个适配器实例的多个对话（同一客户端、同一目录）不再互相耗尽额度；没装 hooks 时仍按实例限流。按客户端地址的限流不变。

## [0.9.3] - 2026-10-24

### 变更

- MCP 服务器会自己更新：`n2n-nexus install` 把它注册成 `"<node>" "<npx>" -y n2n-nexus@latest mcp`（npx 取所选 Node 旁边 npm 自带的那个；`PATH` 设为一个其中 `node` 就是这个 Node 的目录，后面跟系统目录），所以每次新开对话都启动最新发布的版本。hooks 仍运行全局安装的包，用 `npm i -g n2n-nexus@latest` 升级。已有的安装运行一次 `n2n-nexus install claude` / `n2n-nexus install codex` 即可切换；hook 命令不变，所以 Codex 不会要求重新信任。`n2n-nexus doctor` 检查新的写法，旧写法的 MCP 命令会报出来。

- n2n-nexus 是让会话之间互相派活的：直接消息的通知、`read` 工具和助手指南现在告诉收到消息的模型执行消息里要求的事，并用 `reply` 回复，不再限定只在它自己的用户要求时才做。
- 默认不限制自动轮次：host `settings.json` 里的 `maxAutoTurns` 默认改为 `0`，会话之间可以一直互相叫醒、执行对方的请求，不用有人输入。设一个数字可以重新加上限；`settings.json` 里已经写了 `maxAutoTurns` 的保持原值。
- 任何 MCP 适配器实例都能结束、存档或重新开启会议，不只是开启它的那个。

### 修复

- Codex 后台等待在开始等待前就加载好唤醒要用的模块，等待期间升级包（或 npx 缓存被清理）不再让唤醒悄悄失败。

### 文档

- 新增安装手册（`docs/INSTALL.md`），介绍 host 和客户端的安装、升级和卸载，包括 Codex hooks 的一次性信任；使用手册（`docs/USER_GUIDE.md`）介绍如何使用，并收录命令、环境变量、`settings.json` 和数据目录参考。README 改为概览并链接到它们；各文档只写自己负责的内容，不再互相重复。
- 每份文档都有章节一致的中文版：新增中文的安装手册、使用手册、工具参考、host README、贡献指南和安全文档，中文更新日志补全了所有版本。

## [0.9.2] - 2026-10-24

### 修复

- `n2n-nexus install` / `uninstall` 写入软链接形式的 `settings.json` 或 `hooks.json` 时写到链接指向的文件（PlanSwap 这类账号切换工具用软链接在多个配置目录间共享同一个文件），不再把链接替换成一份副本。
- 托盘控制后台服务时显示服务实际的监听地址（例如 `http://0.0.0.0:5688（局域网）`），不再显示它用来检查服务的本机回环地址。

## [0.9.1] - 2026-10-24

让使用 n2n-nexus 的 AI 模型读到更清楚的说明。

### 变更

- 工具说明区分 `send` / `read`（会话之间的私信）与 `send_message` / `read_messages`（全局聊天和会议），说明 `read_messages`、`list_events` 和会议里的 ID 是 MCP 适配器实例 ID 而不是会话 ID，写明哪个会议成为当前会议、只有发起实例能结束 / 归档 / 重开，并准确描述 `sync_project_assets`（新建或整体替换）、任务 metadata、`billing`、策略文档和 `get_global_topology`。
- MCP 服务器说明和 SessionStart 介绍补上 `reply`、`set_profile`、私信需要的 hooks，以及两类消息的区别。
- 报错说明下一步：缺少会话身份时列出原因（没装 hooks、装完没开新对话、MCP 服务器名不是 `n2n-nexus`、绑定过期请重试）；会议权限报错写出发起实例和调用实例；参数校验报错只列出不合格的字段；`cancel_task` 区分任务不存在和已结束；适配器和 hook 的报错称 n2n-nexus-host 而不是 daemon。
- `get_global_topology` 传入不存在的 `projectId` 时报错，不再返回空图；`host_maintenance` 的 `prune` 要求 `count` ≥ 1，不再什么都不删。

## [0.9.0] - 2026-10-23

两个程序的 0.9.0 版本：host 改为独立的 Go 程序 `n2n-nexus-host`，npm 包 `n2n-nexus` 只保留客户端。

### 新增

- `n2n-nexus-host`：用 Go 重写的 host，Windows、macOS、Linux（amd64 和 arm64）各一个可执行文件。不带参数时以托盘程序运行：显示状态、地址和在线会话数、打开日志目录和数据目录、开关局域网访问（Windows 上经 UAC 确认后添加 TCP 和 UDP 防火墙规则，其他系统提示需要放行的端口）、登录后自启（托盘第一次运行时自动打开）、重启、退出；中文系统显示中文，其他显示英文。`serve` 在前台运行；`service install|uninstall|status` 注册以安装用户身份运行的开机服务，host 退出 5 秒后自动重启（Windows 计划任务、macOS LaunchDaemon、Linux systemd 单元），托盘正在运行 host 时拒绝安装；`autostart on|off` 设置托盘登录后自启。端口上已有 host（服务）应答时，托盘只做控制界面。每个数据目录只运行一个 host。
- 安装方式：Homebrew（`brew install n2ns/tap/n2n-nexus-host`，从源码编译）、Scoop（`scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`，`scoop install n2ns/n2n-nexus-host`），以及 GitHub Releases（标签 `host-v*`）上的压缩包，附 `SHA256SUMS` 和构建证明（`gh attestation verify`）。程序暂未做代码签名。
- `update_task`：更新任务的 `status`、`progress`（0–1）、`result_uri`、`error_message` 或 `metadata`，返回更新后的任务。
- `contract/`：host 与客户端之间的 JSON 协议（`tools.json`、`hook.json`、`errors.json`），随 npm 包发布。`GET /health` 返回 host 的 `contractVersion`，`n2n-nexus doctor` 检查 host 的协议版本与客户端一致。
- 局域网发现：`NEXUS_ENDPOINT=discover`（或 `--endpoint discover`）让 MCP 适配器和 hooks 通过 `NEXUS_DISCOVERY_PORT`（默认 5688）上的 UDP 广播查找 host，缓存在 `~/.n2n-nexus/discovered-endpoint`，连不上时重新查找。监听非回环地址的 host 在它的 `discoveryPort` 上应答。没有应答时，客户端使用本机地址 `http://127.0.0.1:5688`。
- SessionStart hook 告诉新对话它自己的会话名称和 ID，以及哪些其他会话不处于离线状态，不用先被要求查询就能给它们发消息。
- MCP 适配器发送服务器 instructions，说明如何查找其他 AI 会话并给它们发消息。
- 空闲的对话会被叫醒：`install` 增加第二个 Stop hook（`n2n-nexus hook <client> --wait`），每轮结束后最多等待一小时，有新消息或通知就让对话开始新的一轮：Claude Code 通过 `asyncRewake` hook，Codex 通过 `codex queue`（可用 `NEXUS_CODEX_COMMAND` 指定命令）。等待期间会话显示为 `listening`，对话里有任何新活动就结束等待。重新运行 `n2n-nexus install <client>` 即可加上这个 hook。 无人值守的 Claude 会话（`claude -p`，`CLAUDE_CODE_SESSION_ATTENDED=0`）不等待，回答完立即退出。
- 自动轮次上限：被叫醒、listen 等待、因消息被拦下不结束都算一次自动轮次。从用户上次输入算起达到 `maxAutoTurns`（host 的 `settings.json`，默认 8；`0` 表示不限制）后，消息照常保存，但不再叫醒或拦住对话，避免两个 AI 会话无限互相叫醒。提醒里会写明 `Automatic turn n of N`；被叫醒那一轮开始时的用户提交不清零计数。

### 变更

- **不兼容：** npm 包 `n2n-nexus` 只含客户端（MCP 适配器、`hook`、`install` / `uninstall`、`doctor`）；删除 `n2n-nexus daemon`，不再依赖 `better-sqlite3`。host 请用 `n2n-nexus-host` 运行。
- **不兼容：** 存储改为新的 SQLite 数据库：host 数据目录下的 `nexus.db`（`%LOCALAPPDATA%\n2n-nexus`、`~/Library/Application Support/n2n-nexus`、`$XDG_DATA_HOME/n2n-nexus`，默认 `~/.local/share/n2n-nexus`；`--root` 或 `NEXUS_ROOT` 可改）。项目、资产和全局文档都是其中的表，不再是文件；每个写操作一个事务，表结构由编号的迁移脚本管理。旧版本在 `~/.n2n-nexus` 里的数据不导入，原样保留。
- **不兼容：** host 只有四个接口：`GET /health`、`GET /api/tools`、`POST /api/tools/call`、`POST /api/hook`。删除项目、消息、全局、会议、任务、事件和维护的 REST 接口，它们的功能都有对应的工具。
- **不兼容：** `read_messages` 需要 `instanceId`（MCP 适配器总会带上）；不带的调用不再共用 `unknown` 未读游标。
- **不兼容：** host 设置放在数据目录的 `settings.json` 里（`host`、`port`、`discoveryPort`、`allowedHosts`、`rateLimit`、`rateBurst`、`maxAutoTurns`），命令行参数覆盖；host 除 `NEXUS_ROOT` 外不读任何环境变量。`NEXUS_HOST`、`NEXUS_DAEMON_PORT`、`NEXUS_ALLOWED_HOSTS`、`NEXUS_RATE_LIMIT`、`NEXUS_RATE_BURST`、`NEXUS_MAX_AUTO_TURNS` 不再使用；`NEXUS_DISCOVERY_PORT` 仍供使用 `discover` 的客户端使用。
- hooks 按对话和按客户端地址限流，与工具调用使用各自独立的桶。
- host 只保留有限时间的数据：事件、已读或已过期的直接消息、已发出的通知保留 30 天，已结束的任务保留 7 天；`host.log` 单个 10 MB 轮转，保留 3 个旧文件（托盘自己的日志写 `tray.log`）。
- MCP 适配器和 hooks 从不启动 host。本机地址上没有 host 应答时，工具调用报错并提示安装并启动 `n2n-nexus-host`；远程地址则提示需在那台机器上启动。hooks 静默跳过。
- `peers` 默认只列出未离线的会话；传 `includeOffline: true` 时，和以前一样再列出 24 小时内活跃过的离线会话。
- `idle` 或 `working` 状态的会话 30 分钟没有任何活动就标为 `offline`，因为客户端不一定发送 SessionEnd（已结束或关闭的 Codex 对话此前会一直"在线"）；它下一次有事件时恢复。`peers` 与 SessionStart 介绍会说明只有 `listening` 的会话能马上回复。

### 修复

- 后台等待算作活动，等待超过 30 分钟的会话不会在两次等待之间被标为 `offline`。开着 `listen` 的会话在等待全部结束后不再一直停在 `listening`；host 重启时也会复位残留的 `listening` 会话，30 分钟无活动后和其他会话一样变为 `offline`。
- 开始、结束、重新打开会议时，会议本身和活跃会议在同一个事务里更新。
- 事件过滤 `action` 只匹配完整名称或完整的 `<action>.` 前缀，不再忽略大小写，也不再把 `_`、`%` 当通配符。
- host 在请求超时内没有应答的工具调用只让这一次失败；MCP 适配器不再因此丢掉工具列表并重连，避免客户端重试 host 仍在执行的调用。
- Windows：`install <claude|codex>` 能找到 npm 安装的 `claude.cmd` / `codex.cmd`，`--wait` hook 也能叫醒这样安装的 Codex。直接用 Node 运行 npm 包装脚本背后的程序，不经过 cmd.exe，消息文本不会被当成命令执行，换行也能保留；从 npx 缓存路径安装会像其他系统一样被拒绝。
- `create_task` 的说明不再指向不存在的工具。
- npm 包带上 README 和指南里链接的文档（工具参考、安全、贡献指南、中文助手指南、2025-12-29 会议记录）。

## [0.8.2] - 2026-10-22

### 修复

- 两个 daemon 在全新存储目录上同时启动时，输掉的那个不再在到达端口前以 `SqliteError: database is locked` 崩溃；数据库初始化会等待另一个进程，输家按设计因 `EADDRINUSE` 退出。
- 文件存储的读取（`get_project`、`search_projects`、拓扑、全局文档）与写入共用一把读写锁，`rename_project` 进行中的读取不再返回文档和技术栈为空的条目。
- `sync_project_assets` 与 `update_project` 先写 manifest 和文档、最后写 registry，后一步失败时还原已写的文件；创建失败不再留下没有目录的项目，更新失败不再出现新旧字段混合。
- 0.6.0 之前写入的任务时间（`YYYY-MM-DD HH:MM:SS`）在启动时转换为 ISO 8601，不再提前最多一天被清理。
- `n2n-nexus uninstall`（以及 `install`）在 `mcp remove` 失败且客户端配置里仍有注册时报错、退出码 1 并说明处理办法；本来没注册的情况照旧忽略。

## [0.8.1] - 2026-10-22

### 新增

- `n2n-nexus install <claude|codex>` 写入 PATH 上的 `node`（当它就是当前运行的 Node 时），不再写 `process.execPath` 解析出的带版本号目录（nvm、Homebrew Cellar、fnm 等），这类目录在升级 Node 后会消失。`--node <path>` 可手动指定路径，路径必须存在、能运行且满足 `engines.node`。`install` 会打印实际写入的路径，位于版本目录时给出提示。
- `n2n-nexus doctor [claude|codex]`：检查已安装的 hook 命令和 MCP 命令里的 Node 路径与入口脚本是否存在、能否运行，并给出修复建议。

### 修复

- daemon 响应改为流式 UTF-8 解码，跨块的多字节字符不再变成 U+FFFD。
- `rename_project` 把目录、manifest 和 registry 条目作为一个整体重命名，任一步失败全部回滚。
- `host_delete_project` 在项目文件删不掉时返回失败并保留 registry 条目。
- `upload_project_asset` 在写锁内检查项目存在，与删除并发时不再把已删除的项目重新建出来；返回的是实际保存的文件名；清洗后为 `.` 的文件名会被拒绝。
- `listen({ on: false })` 会结束正在等待的 Stop hook，而不是等到超时。

### 升级说明

- 重新运行 `n2n-nexus install claude` 和/或 `n2n-nexus install codex`，让 hooks 和 MCP 命令使用稳定的 Node 路径。

## [0.8.0] - 2026-10-21

### 新增

- 每个 Claude Code 和 Codex 对话都是一个独立会话，ID 为 `claude:<id>` 或 `codex:<id>`，直接使用客户端分配的 ID。恢复对话、重启适配器、子代理都沿用同一身份。
- 直接消息工具 `peers`、`send`、`read`、`reply`、`listen`、`set_profile`。工具调用通过 MCP 请求的 `_meta` 标明所属对话（Claude Code 是 `claudecode/toolUseId`，由 PreToolUse hook 绑定；Codex 是 `sessionId`），不经过参数。
- `n2n-nexus hook <claude|codex>` 与 `POST /api/hook`：客户端 hooks 维护每个对话的状态（working、idle、listening、offline），并在用户发来新消息时、每次工具调用后、本轮结束前一次通知新消息。通知只带发送方和第一行，正文通过 `read` 以工具结果的形式读取。
- `listen`：对话结束一轮后继续等待最多 590 秒，消息一到就接着处理。`send(notifyWhenIdle)` 在收件方下一次结束一轮或离线时通知一次。未读消息 24 小时后过期，并通知发送方。
- `n2n-nexus install <claude|codex> [--endpoint <url>]` 与 `uninstall`：在客户端的用户级配置里写入或删除 hooks 和 MCP 服务，与已有设置合并。Codex 的 hooks 需要先用 `/hooks` 信任一次。
- 本机地址（`127.0.0.1` 或 `localhost`）上没有 daemon 时，适配器和 hooks 会在后台拉起一个，日志在 `~/.n2n-nexus/daemon.log`。

### 移除

- `list_sessions`、`update_session`、`read_inbox`、`get_message`、`acknowledge_message`，`send_message` 的 `to`、`replyTo`、`ttlMs` 参数，`POST /api/sessions/register` 与 `POST /api/sessions/disconnect`，以及适配器的随机会话 ID 和心跳。`send_message` 现在只发到会议和全局聊天。

### 修复

- 两个 daemon 在全新的存储目录上同时启动时，后一个不再在战略文档迁移里崩溃，而是因 `EADDRINUSE` 退出。

### 升级说明

- 升级后执行 `n2n-nexus install claude` 和 / 或 `n2n-nexus install codex`；直接消息依赖这些 hooks。其他 MCP 客户端仍可使用除直接消息以外的全部工具。
- 0.7.0 的会话和直接消息不做迁移，旧表不再读取。

## [0.7.0] - 2026-10-20

### 新增

- 会话发现：`list_sessions` 与 `update_session`。每条 MCP 连接有独立的会话 ID、显示名称、可选的项目关联、接收消息策略，以及基于心跳的在线状态。共用同一实例 ID 的连接各有独立收件箱。
- 直接消息：`send_message(to, replyTo?, ttlMs?)`，以及 `read_inbox`、`get_message` 和 `acknowledge_message`。回执区分已接受、已取回、已确认、已回复、已拒绝和已过期。已取回但未确认的消息仍可再次取回，回复会关联到原消息。

### 变更

- MCP 适配器注册自己的连接身份，并用心跳维持。稳定的实例 ID 继续用于标识旧的共享消息游标和会议权限。
- 更新了兼容的运行时和开发依赖，包括 Zod、ESLint、typescript-eslint、Vitest 和 Lefthook。

### 修复

- 战略文档迁移现在会记录完成状态，并保留有冲突的文档，防止之后的用户文档被误认为旧数据、在重启时被删除。
- HTTP 响应中断时，现在会让等待中的请求失败，而不是让连接尝试、工具调用或关机无限期等待。
- 格式错误的 Host 头和请求 URL 返回 HTTP 400，不会让 daemon 退出；原有的浏览器和 Host 限制仍然有效。
- 并发地把同一个项目重命名为不同目标时，不会再同时报告成功，也不会记录一次实际没有发生的重命名。
- MCP 适配器可以连接 IPv6 的 daemon 地址，不再把地址两侧的方括号当成 DNS 主机名的一部分。
- 任务过期计算保留时间戳的毫秒部分，维护任务不会在 TTL 到期前就把任务判为失败。

### 升级说明

- 先升级 daemon，再把 MCP 适配器重启到 0.7.0。新适配器在执行工具前需要 daemon 提供会话注册接口。升级后的 daemon 仍支持原有的会议和全局消息操作。
- 收件箱按 MCP 连接划分。宿主里共用一条连接的多个聊天共用一个收件箱；重启适配器会创建新会话，不会继承之前的收件箱。
- 收到的消息需要显式调用 `read_inbox`；本版本不会自动唤醒模型。在线状态只表示近期有心跳，已取回不代表已处理，确认表示收到，不表示工作已完成。

## [0.6.0] - 2026-10-16

### 新增

- 限流（MCP 工具规范对服务端的要求）：每个实例 ID 一个令牌桶（默认每秒 20 次、突发 60 次；`NEXUS_RATE_LIMIT`、`NEXUS_RATE_BURST`，设 `0` 关闭），另按客户端地址以 5 倍额度再限一次，因为实例 ID 由调用方自报。不带实例 ID 的请求（多数 REST 读接口）只按地址限流。超限时守护进程返回带 `Retry-After` 的 `429`，MCP 适配器把它作为工具错误交给模型，连接不受影响。`/health` 与 `GET /api/tools` 不计入。

- 结构化工具结果：每次成功调用在 JSON 文本之外同时返回 `structuredContent`，11 个返回数据的工具发布 `outputSchema`。结果结构是 `src/daemon/tool-outputs.ts` 中的 zod 契约，并用于给处理函数定类型；有测试经适配器在新旧两代协议下调用全部工具，逐个按契约校验结果。若写入类工具也发布 schema，`tools/list` 会从约 14 KB 涨到 27 KB，而它们只返回一行确认，因此未发布（只发布读取类时为 22 KB）。

- 每个工具新增显示用的 `title`（例如 "Delete Project"），MCP 客户端会用它代替原始工具名展示。

- 所有工具加上 MCP 工具注解（`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`），客户端可以区分只读工具和会覆盖或删除数据的工具，并在调用后者前请用户确认。

- 新增 `list_meetings` 工具与 `GET /api/meetings`：列出会议及其状态、发起者、参与者、消息与决策数、摘要。此前助手只能访问已知 ID 的会议。

- 新增 `get_project` 工具与 `GET /api/projects/:projectId`：读取项目完整 Manifest 和内部文档。此前助手能同步却无法读回。

- 新增 `get_global_strategy`、`list_global_docs`、`get_global_doc` 工具。此前助手能写主策略和共享文档，却没有工具读回，只有 REST API 能读。

- `list_events` 工具与 `GET /api/events`：结构化活动日志（actor、action、target、detail），记录经由 daemon 发生的每次状态变更。

### 移除

- `register_session_context` 与 `POST /api/session/register`。守护进程为每个实例在内存里记“当前项目”，只有 `upload_project_asset` 用它；MCP 2026-07-28 取消了协议会话，并建议跨调用状态以显式工具参数传递。`upload_project_asset` 改为接收 `projectId` 并校验项目存在。

- 0.5 之前选举架构的残留与其他死代码：未使用的常量（`PORT_RANGE_*`、`HANDSHAKE_TIMEOUT`、`HEARTBEAT_INTERVAL`）、`hasFlag`、`HubConfig`/`ToolContext`/`MeetingState` 类型、`isSqliteAvailable`、`getTasksByMeeting`、`getActiveTaskCount`、`NexusClient.health`、从未使用的 `archives/` 目录与 `tasks.json` 路径、`suggestedSyncTargets`（解析早已不存在的 `name@project` 实例 ID 格式）、未写入文档的 `NEXUS_PORT`（`NEXUS_DAEMON_PORT` 的别名）以及 `migrations/003_add_tasks_table.sql`（schema 在 `sqlite.ts` 中）。两份 `getRootPath` 实现合并到 `config/paths.ts`，`--root ./relative` 与 `~` 的解析因此一致。`billing` 在读取与 patch 时不再被丢弃。

- 会议存储的 JSON 回退（`store.ts`、`meetings.ts`）与 `/api/storage/info` 端点。SQLite 为必需依赖，daemon 不再报告“degraded”存储模式。

### 修复

- `NEXUS_RATE_BURST` 取 0 到 1 之间的值会让所有调用永远返回 429，取 0 则静默关闭限流。现在突发数至少为 1，只有 `NEXUS_RATE_LIMIT=0` 才关闭限流。

- 旧版本（其 `update_project` 未经校验就写盘）写入的 manifest 中，relations、endpoints、apiSpec 等嵌套项可能缺字段或带多余字段，导致 `get_project` 与 `get_global_topology` 在 2026-07-28 客户端上通不过 outputSchema 校验。现在读取时规范化：丢弃无效项，缺失的字符串补为空，未知关系类型按 `related` 处理；不改写磁盘文件。

- 结果契约此前只靠 TypeScript 约束，而 TypeScript 不检查返回变量里的多余字段，存储数据新增字段就可能以违反已发布 `outputSchema` 的 structuredContent 到达客户端。现在每个结果出守护进程前都经过 zod 契约：剥掉未声明字段，无法满足契约的结果变为服务端错误。

- 一次重连尝试刚连上、还在通知客户端时，若有工具调用再次失去守护进程连接，这次尝试结束后仍会停掉重连循环，而适配器已经断开；之后每次调用都只返回 "Daemon is not ready yet"，直到重启 IDE。现在只有连接仍然在线时才停止重连。

- 适配器的重连循环使用 3 秒的 `setInterval`，而单次尝试最长要等 5 秒请求超时，守护进程假死时请求会层层叠加。现在每次尝试结束后才安排下一次。

- `rename_project`、`cancel_task`、`end_meeting`、`archive_meeting`、`reopen_meeting` 此前标注为 `destructiveHint: false`，而 MCP 规定该值只用于纯追加式工具，客户端可能不经用户确认就执行它们。现在标为破坏性。

- 守护进程报告工具不存在时（例如升级后适配器未察觉），适配器虽返回 `-32602`，`tools/list` 却仍列出该工具。现在会重新拉取工具列表，有变化时发送 `list_changed`。

- 适配器此前先拉取守护进程工具列表、再开始读 stdin。守护进程接受连接却不回应时，`server/discover` 与 `initialize` 要等 5 秒客户端超时，足以让探测型客户端把它误判为旧版服务器，stdin 关闭后也迟迟不退出。现在适配器立即开始服务，在后台拉取。

- 在 2026-07-28 连接上，不带 `io.modelcontextprotocol/clientInfo` 的请求（规范只是 SHOULD）得到的实例 ID 不含 IDE 名，同一客户端会变成两个实例，未读游标和会议权限随之分裂。适配器现在沿用该连接上第一次见到的客户端名。

- 调用适配器不认识的工具时，此前返回 `isError: true` 的工具结果。MCP 规范把未知工具归为协议错误，适配器现在返回 JSON-RPC 错误 `-32602`（Invalid Params），守护进程报告工具不存在时同样如此。

- IDE 关闭 stdin 后 MCP 适配器不退出：守护进程不可达时，3 秒一次的重连定时器让进程一直存活，留下孤儿适配器。现在 stdin 结束时适配器会关闭并退出，符合 stdio 传输规范。

- 与 `Object.prototype` 键同名的项目和文档 ID 处理错误：`register_session_context({ projectId: "constructor" })` 对不存在的项目返回成功，名为 `__proto__` 的项目或文档写入后丢失（赋值改写了对象原型）。注册表与文档索引改为无原型的映射。

- `sync_project_assets` 分两次加锁分别写 manifest 和内部文档，并发的 `host_delete_project` 可以插在两步之间，留下注册表不认识的项目目录。现在两步在同一临界区内完成。

- `npm run build` 现在先清空 `build/`。单独的 `tsc` 会留下已删除源码的编译产物（例如 `build/storage/store.js`），`npm publish` 会把它们一起发布。

- 任务的 `ttl` 只存不用，`cleanupTasks` 也从未被调度，tasks 表无限增长。daemon 现在在启动时和每小时执行任务维护：超过 TTL 的 pending/running 任务标记为 `failed`（`TTL expired`），完成超过 7 天的任务被清除。同时删除 `tasks_updated_at` 触发器：它会用另一种格式的 `datetime('now')` 覆盖 `updateTask` 写入的 ISO 8601 `updated_at`，使时间比较混用两种格式。

- `update_global_strategy` 写的是 `global/docs/strategy.md`，而文档把 `global/blueprint.md` 描述为主战略文档，且两处初始化用不同占位文案各创建一次 `blueprint.md`。现在该工具写入 `blueprint.md`，`GET /api/global/strategy` 读取它。首次启动时会把已有的 `strategy` 全局文档搬进 `blueprint.md`（除非那里已有非占位内容）并从文档索引中移除。

- `sqlite.ts` 在模块加载时注册的 SIGINT/SIGTERM 处理器会立即 `process.exit(0)`，导致 daemon 的 `server.close` 优雅关闭从不执行。信号处理改到 daemon 入口：停止接受连接、处理完进行中的请求、关闭数据库、再退出。

- 工具参数此前完全不校验：daemon 直接断言类型，让 SQLite 或文件系统在后面报错（例如 `category: "SYSTEM"` 会变成 `CHECK constraint failed` 的 500）。现在每个工具在 `src/daemon/tools.ts` 有 zod 契约，提供给 MCP 客户端的 JSON Schema 由它生成，同一契约校验工具调用与 REST 端点，失败返回 400 并指出出错字段。`update_project` 的 `patch` 拒绝未知字段，`create_task` 会检查 `source_meeting_id` 是否存在，SQLite 外键约束已启用。

- MCP 适配器每次启动随机生成实例 ID，IDE 重启后未读游标归零，会议也没人能再结束或归档（只有发起者可以）。默认值改为 `mcp-<主机名>-<工作目录哈希>-<IDE 名>`（IDE 名来自 MCP 握手），同一机器、同一工作区、同一 IDE 保持不变。`reopen_meeting` 与 `end_meeting`、`archive_meeting` 一样只允许发起者操作。

- daemon 此前接受任何 HTTP 请求，用户浏览器中打开的网页可以用跨站 `text/plain` POST 调用本地 daemon 的 `host_delete_project`。现在拒绝带浏览器 `Origin` 或跨站 `Sec-Fetch-Site` 头的请求（403），POST 必须是 `Content-Type: application/json`（415），请求体上限 16 MB（413），不再无限缓冲。`Host` 头必须是 IP、`localhost`、`host.docker.internal` 或 `NEXUS_ALLOWED_HOSTS` 中的域名，以阻断以同源 GET 形式到达 daemon 的 DNS rebinding 页面。

- MCP 适配器此前把任何失败的工具调用（任务不存在、会议已关闭、权限不足等）都当成 daemon 掉线：清空工具列表、通知 IDE 并进入重连循环。现在传输失败与工具失败区分开（`NexusTransportError` 与 `NexusToolError`），只有前者触发重连，工具失败以 `isError` 结果返回。`POST /api/tools/call` 对未知工具返回 404，对工具拒绝的调用返回 400。

### 变更

- MCP 适配器从 `@modelcontextprotocol/sdk` 1.x（协议 2025-11-25）迁移到 v2 SDK（`@modelcontextprotocol/server` 2.3），通过 `serveStdio` 在 stdio 上同时服务无状态的 2026-07-28 版与 2025 代客户端。2026-07-28 客户端可使用 `server/discover`、每请求 `_meta` 信封，并经 `subscriptions/listen` 收到列表变更通知；实例 ID 从请求信封读取客户端名。第一次 `tools/list` 最多等待 1 秒的启动拉取，本地守护进程在线时即完整；即使守护进程假死，`server/discover` 与 `initialize` 也立即得到响应。

- 无参数工具（`get_global_strategy`、`list_global_docs`）的 schema 改为 MCP 规范推荐的 `{ "type": "object", "properties": {}, "additionalProperties": false }`，并拒绝多余参数。

- `send_message` 的路由不再依赖 `register_session_context`：给了 `meetingId` 就发到该会议，否则发到活跃会议，否则发到全局聊天。`POST /api/messages/send` 采用同一规则（去掉了 `source` 参数），不再有一套默认值不同的独立代码路径。

- 全局聊天从 `global/discussion.json` 迁入 SQLite。不带 `meetingId` 的 `read_messages` 现在真正按实例增量读取（工具描述此前就这样承诺），追加不再重写整个文件，`host_maintenance` 会返回删除条数。daemon 首次启动时会导入已有的 `discussion.json`（五种已知类别之外的 category 置空），并将其改名为 `discussion.json.migrated`。
- daemon 的状态变更（注册会话、项目同步/重命名/删除、会议结束等）记录为事件，不再以 `SYSTEM` 行写入全局聊天。

- `sync_project_assets`、`update_project`、`rename_project`、`host_delete_project` 改为同步执行并直接返回结果，不再返回需轮询的 `task_id`。这些操作只需毫秒级时间，后台任务封装只多了一次轮询往返，还让写入与其他请求并发竞争。

- 要求 Node.js 22.14+（22.x 系列）或 23.6+，并将 MCP SDK、SQLite 与测试依赖更新到最新兼容稳定版。

## [0.5.0] - 2026-06-14

### 🏗️ Daemon + MCP 架构（破坏性重构）

架构全面重写。旧的 Host/Guest 选举机制被独立 HTTP daemon 取代，daemon 成为唯一的真相来源。

**原因**：选举模型假设所有 AI 实例共享同一个 `localhost`。这在 Windows/WSL/VM 跨环境场景下完全失效（各自处于不同的 localhost 命名空间），且在"Host" IDE 关闭时会导致其他实例无法访问数据。Split-brain 风险不可接受。

#### 新架构
- **`n2n-nexus daemon`** — 独立 HTTP 服务器；用户手动启动，持续运行；持有所有数据、工具定义和业务逻辑；不随 IDE 关闭而消亡
- **`n2n-nexus mcp`** — 无状态 MCP 代理；由 IDE 通过 `npx` 启动；从 daemon 拉取工具列表（`GET /api/tools`），转发每个工具调用（`POST /api/tools/call`）
- **跨环境支持**：通过配置 `NEXUS_ENDPOINT` 桥接 Windows/WSL/VM 或远程机器

#### MCP 行为
- 启动时工具列表为空；后台重试循环（每 3 秒）直到 daemon 可达
- 连接成功后：发送 `notifications/tools/list_changed` → IDE 自动重新加载工具列表
- daemon 断开后：清空工具列表，通知 IDE，重新进入重试循环
- MCP 内不含任何 hardcode 工具名——daemon 升级新工具后所有 MCP 实例无需更新即可获得新能力

#### 已删除（新架构不再需要）
- `src/network/` — 选举、Host、Guest 逻辑
- `src/auth/` — Host/Guest 权限门控
- `src/tools/handlers/`、`src/tools/definitions.ts`、`src/tools/schemas/`
- `src/resources/` — MCP Resources 层
- `src/server/resources.ts`、`src/server/tools.ts`

#### 存储层不变
`src/storage/` 保持原样。SQLite WAL 模式是安全的，因为只有 daemon 进程直接写入；MCP 进程通过 HTTP 间接访问，天然串行，无并发冲突。

---

## [0.4.2] - 2026-01-14
### 🛡️ 稳定性与自动化 (Stability & Automation)
- **Lefthook Integration**: 引入高性能 Git 钩子。现在提交时自动运行 `lint`，推送时自动运行 `build + test`，确保零回归。
- **E2E Test Stability**: 修复了子进程日志阻塞导致的测试挂起问题（通过实现 `stdout` 泄流）。
- **CLI Port Override**: 修复了 `--port` 命令行参数在 Host 选举过程中被忽略的 Bug。
- **Non-blocking Handshake**: 优化了 Stdio 连接逻辑，防止其阻塞选举。

## [0.4.1] - 2026-01-14
### ✨ 开发者体验与可观测性 (Developer Experience & Observability)
- **MCP Logging Protocol**: 实现了标准的 `notifications/message` 协议支持。调试日志现在直接显示在 IDE 的 "Model Context Protocol" 输出频道中。
- **Improved Stdio Handling**: 严格验证并确保了 `stdout` 流的 JSON-RPC 合规性，防止 IDE 插件加载失败。
- **Better Error Reporting**: 启动失败时会在 `stderr` 中提供更具描述性的上下文信息。

## [0.4.0] - 2026-01-14
### 🚀 高可用与高扩展 (High Availability & Scalability)
- **Failover Mechanism**: 实现了自动的 Guest-to-Host 故障转移。如果 Host 进程意外退出，Guest 会检测到端口/锁释放并立即接管 Host 角色，同时保证数据持久性。
- **Progressive Discovery**: 新增 `search_projects` 工具。允许 AI 根据意图搜索相关项目，而无需读取包含 1000+ 项目的完整注册表，大幅节省 Token。
- **Immediate Handshake**: 实现了请求缓冲机制 (Request Buffering)，允许 Server 在 Host 选举 (~300ms) 完成前就立即接受 (<10ms) IDE 的请求，彻底解决了启动时的竞态条件。
- **Stability**: 增加了针对进程故障转移 (`tests/failover.test.ts`) 和请求缓冲 (`tests/buffered_requests.test.ts`) 的端到端测试。

## [0.3.9] - 2026-01-11
### 🚀 在线优先架构 (Online First Architecture)
- **性能**: 移除了等待选举的顶层阻塞 await。服务端现在 <300ms 内即可启动（在线优先），在网络拥堵时启动时间缩短 99%。
- **稳定性**: 确保 Host 选举完成前 `tools/list` 就已可用，修复了 MCP 客户端（Cursor/Claude）中的 "Timeout" 错误。
- **竞态修复**: 从 Local 模式切换到 Guest 模式前先显式关闭服务端，防止 Stdio 流冲突。
- **重构**: 将 `isHost` 逻辑从静态配置移到动态的 `updateConfig` 流程。

## [0.3.5] - 2026-01-10
### 协议与稳定性
- **修复 (僵尸 Host)**: 实现了“智能重试”和“重新选举”逻辑。如果 Guest 反复连接到僵尸 Host（握手成功但 SSE 断开），现在会自动触发重新选举流程，将坏端口加入黑名单，并在必要时在从端口上将自身提升为 Host。
- **重构**: 启用了动态角色切换 (Guest -> Host)，无需重启进程。

## [0.3.4] - 2026-01-10
### 协议与稳定性
- **新握手协议**: 引入 `POST /nexus/handshake` 替代旧版 `/hello`。支持严格的客户端/服务端版本校验和稳健的 Host 探测。
- **全局错误安全网**: 增加了 `uncaughtException` 和 `unhandledRejection` 处理器，防止后台任务错误导致进程退出，确保 Hub 的高可用性。
- **修复 (EOF 错误)**: 解决了由于 SQLite 非幂等初始化导致的“连接关闭：EOF”崩溃问题。
- **修复 (僵尸 Host)**: 改进了 Guest 的 Host检测逻辑，消除了死循环重试。
- **测试覆盖**: 新增 `guest_connection.test.ts` 验证 Guest-Host SSE 集成。

## [0.3.3] - 2026-01-10
### 🔄 零配置持久化 (Zero-Config Persistence)
- **支持 XDG Base Directory**: 将存储位置从不稳定的 `node_modules` 迁移至系统标准的 User Data 路径：
  - **Linux/WSL**: `~/.local/share/n2n-nexus`
  - **Windows**: `%APPDATA%\n2n-nexus`
  - **macOS**: `~/Library/Application Support/n2n-nexus`
- **数据持久化**: 数据现在可以从 `npx` 缓存清理、项目删除和重新安装中幸存。
- **监听地址**: 默认监听地址更改为 `0.0.0.0` 以支持 WSL 镜像模式网络。
- **身份安全**: 默认的 "Assistant" ID 现在会自动追加随机后缀（例如 `Assistant-x9a2`），以防止多个空 IDE 连接时发生冲突。

## [0.3.8] - 2026-01-11

### 修复
- **Guest 代理分帧**: 在 Guest 到 Host 的代理中实现了正确的消息分帧（按换行分隔的 JSON 缓冲区），解决了 IDE 的 stdin 管道把 JSON-RPC 消息拆成碎片时出现的 "context deadline exceeded" 超时。

## [0.3.7] - 2026-01-08
### 安全与稳定性
- **安全**: 修复了 Guest 代理连接 URL 中潜在的 URL 参数注入。
- **稳定性**: 将 Host 选举的回退循环从异步递归改为 `while(true)`，防止长时间运行后栈溢出。
- **重构**: 改进了 `config.ts` 的代码结构，便于维护。

## [0.3.1] - 2026-01-08
### 修复
- **严重**: Guest 代理重连逻辑中的递归栈溢出（部分修复）。
- **严重**: 回退端口绑定失败时服务端崩溃（现在会带退避重试）。
- **性能**: 用批量并发优化端口扫描（扫描时间 56 秒 -> 3 秒）。
- **配置**: 端口范围扩大到 5688-5800（113 个端口）。

## [v0.3.0] - 2026-01-08

### 🌐 全局 Hub 架构 (零配置多 IDE 协作)

此版本引入了全自动的 Host 选举和全局 Hub 架构，无需任何配置即可实现多 IDE 无缝协作。

#### 自动 Host 选举 (基于端口)
- **端口范围 5688-5700**: 首个绑定端口的实例成为 Host，其余成为 Guest。
- **探测优先策略**: Guest 在尝试绑定前先扫描已有 Host，消除竞态条件。
- **Hello 握手协议**: `/hello` 端点验证 Nexus 身份，区分其他服务。
- **10 秒接管窗口**: 绑定失败后，Guest 等待 10 秒再探测加入胜者。

#### 全局 Hub (基于 SSE 通讯)
- **单一 Hub 架构**: 所有 IDE（不论哪个项目）都连接到同一个 Host，实现跨项目协作。
- **Stdio-to-SSE 代理**: Guest 透明地将 IDE 流量转发到 Host。
- **多会话路由**: Host 维护会话映射，支持多个 Guest 并发连接。
- **存储路径继承**: Host 广播 `rootStorage` 路径；Guest 继承它以实现无缝故障转移。

#### 心跳与看门狗 (高可用)
- **Host 心跳**: Host 每 30 秒发送 `: ping` 保持连接活跃。
- **Guest 看门狗**: Guest 监控活动；若 60 秒无响应，自动触发重选。
- **热故障转移**: 存活的 Guest 自动使用继承的存储路径升迁为新 Host。

#### 术语重构
- **Moderator → Host**: 所有代码、测试和文档已更新。
- **`isModerator` → `isHost`**: API 和配置属性已重命名。
- **`moderator_*` → `host_*`**: 工具名已更新（如 `host_maintenance`）。

#### 零配置体验
- **`--id` 弃用**: 实例 ID 现在自动从项目文件夹名派生。
- **`--host` 移除**: Host 角色通过端口绑定自动确定。
- **简化 CLI**: 只需 `npx n2n-nexus` 即可开始。

| 指标 | 之前 | 之后 |
|------|------|------|
| 必需 CLI 参数 | 2-3 | 0-1 |
| 手动 Host 设置 | 需要 | 自动 |
| 多 IDE 同步 | 基于文件 | SSE 实时 |
| 故障转移时间 | 手动重启 | < 10 秒 |

#### 测试覆盖
- 新增 `election.test.ts`，包含 9 个覆盖探测、绑定和竞争场景的测试用例。
- 全部 55 个测试通过。

## [v0.2.1] - 2026-01-01

### 🚀 Token 经济深度优化

此版本重点优化了 AI 加载 MCP 服务端时的上下文窗口 (Context Window) 消耗。

#### 工具定义优化 (-49% Token 消耗)
- **精雕细琢的 Schema**: 使用手动优化的 `definitions.ts` 替换了 `Zod.toJSONSchema()`。
- **移除 $schema 冗余**: 消除了每个工具定义中的 `$schema` 声明（每个工具节省约 50 字符）。
- **精简描述**: 将平均描述长度缩短了 50%。
- **隐藏内部工具**: `update_task`（标记为 `[INTERNAL]`）已从公开的 `ListTools` 中排除。

| 指标 | 优化前 | 优化后 | 提升 |
|--------|--------|-------|-------------|
| 工具定义字符数 | 10,241 | 5,237 | **-49%** |
| 预估 Token | ~2,560 | ~1,310 | **-1,250 tokens** |

#### 增量消息读取
- **已读游标表**: 新增 `read_cursors` SQLite 表，追踪每个 IDE 实例在每个会议中的最后阅读消息 ID。
- **自动增量**: `read_messages` 自动根据 `instanceId` 只返回未读消息。
- **零配置**: 无需 `afterId` 参数 — 游标完全由服务端维护。
- **响应增强**: 返回 `{ newMessages: N, messages: [...] }` 便于 AI 验证。

#### Context7 风格渐进加载
- **`get_global_topology` 升级**:
  - **默认 (列表模式)**: 返回轻量级摘要 `{ totalProjects, totalEdges, projects: [{id, name}] }`。
  - **聚焦模式**: 传入 `projectId` 获取该特定项目的详细子图。
- **`listResources` 优化**:
  - **O(1) 扩展性**: 资源列表大小现在是常量，不再随项目数量增长。
  - **静态资源**: 固定 8 个核心资源（聊天、注册表、文档、会议等）。
  - **基于模板的项目**: 不再动态列出每个项目；改用路径模板。
  - **发现流程**: AI 先读取 `hub/registry` → 发现项目 ID → 根据模板构造 URI。

| 场景 | 优化前 | 优化后 |
|----------|--------|-------|
| 0 个项目 | 8 资源 | 8 资源 + 4 模板 |
| 20 个项目 | 28 资源 | 8 资源 + 4 模板 (固定) |
| 50 个项目 | 58 资源 | 8 资源 + 4 模板 (固定) |

#### 文档
- 更新了 `README.md`，包含新的工具行为描述。
- 将 `ASSISTANT_GUIDE.md` 升级至 v0.2.1，引入“渐进式发现，增量读取”原则。
- 重新组织了 Resources 章节，采用“核心资源 + 资源模板”结构。

## [v0.2.0] - 2025-12-31

### 🚀 任务原语系统 (Phase 2 & 3)
- **异步深耕**: 关键阻塞操作 (`rename_project`, `moderator_delete_project`) 迁移至 Task 原语，支持背景级联更新。
- **可追溯性**: 所有任务现在都支持 `source_meeting_id`，将执行结果与会议决策关联。
- **进度展示**: 增加了进度追踪 (0.0-1.0) 和 `result_uri` 结构化输出。
- **生命周期工具**: 新增 `create_task`、`get_task`、`list_tasks`、`update_task` 和 `cancel_task`。

### 🛡️ 类型安全与安全性
- **纵深防御**: 在 `handleRemoveProject` 和 `handleModeratorMaintenance` 内部增加了二次权限检查，最大限度隔离项目。
- **会议加固**: `end_meeting` 和 `archive_meeting` 现在严格**仅限 Moderator** 调用。
- **Zod 集成**: 所有工具定义迁移到严格类型的 Zod schema，并用正则校验防止路径穿越。
- **基础设施**: 工具链升级到 **TypeScript 5.9.3**、**Vitest 4.0.16** 和 **ESLint 9.39.2**。

### ✂️ 代码瘦身 (架构整洁)
- **大清理**: 删除了 6 个冗余工具（`list_projects`、`read_project`、`list_global_docs`、`read_global_doc`、`list_meetings`、`read_meeting`），改用 Resource URI。
- **原生 Zod 4 Schema**: 移除 `zod-to-json-schema` 依赖，改用 Zod 4 原生的 `toJSONSchema()` 生成。

## [v0.1.9] - 2025-12-30

### 🛡️ 协作与安全
- **仅发起者可操作**: `end_meeting` 和 `archive_meeting` 改为受限访问。
- **会话在线感知**: 在全局日志中自动发布 `[ONLINE/OFFLINE]` 状态消息。
- **工具命名整理**: 完成向 `send_message` 和 `read_messages` 的过渡。

### 🌐 资源命名空间 (MCP 2025 标准)
- **统一的 authority**: 所有核心资源 URI 迁移到 `mcp://nexus/`。
- **新资源**: 新增 `mcp://nexus/status` 和 `mcp://nexus/active-meeting`。

## [v0.1.8] - 2025-12-30

### 🎯 会议架构 (Phase 1 & 2)
- **混合存储后端**: 在 **SQLite**（优先）和 **JSON 回退**之间自动选择。
- **SQLite 引擎**: 基于 `better-sqlite3`，启用 **WAL 模式**，支持高并发和多进程安全。
- **新的生命周期实体**: `MeetingSession` 用一个个独立会议取代单一的聊天日志。
- **生命周期工具**:
  - `start_meeting(topic)`: 创建专用会议，带唯一 ID 和随机熵。
  - `end_meeting(meetingId?, summary?)`: 结束会议，汇总决策。
  - `archive_meeting(meetingId)`: 把会议移入历史归档。
  - `list_meetings(status?)`: 按条件列出会议。
  - `read_meeting(meetingId)`: 读取会议的历史、参与者和决策详情。

### 🏗️ API 与存储改进
- **结构化 JSON 响应**: 会议工具现在返回机器可读的 JSON，便于代理集成。
- **智能自动路由**: 全局讨论消息自动转发到当前活跃的会议。
- **ID 生成**: 稳健的 slug 生成，非 ASCII 主题（中文/Unicode）回退为 Base64。
- **并发控制**: 共享的 `AsyncMutex` 工具和 SQLite 原生锁。
- **状态报告**: `mcp://nexus/status` 现在报告 `storage_mode` 和 `is_degraded` 标志。

### 🧪 质量保证
- **完整测试套件**: 新增 24 个以上集成测试和压力测试（全部通过）。
- **并发压力测试**: 验证了消息快速连发时的数据完整性。
- **回退验证**: 确认原生模块不可用时系统依然稳定。

### 🛡️ 安全
- **加固项目删除**: 将 `delete_project` 重命名为 `moderator_delete_project`，并强制显式的 Moderator 校验，防止未授权删除项目。
- **路径清理**: 改进错误处理，从 MCP 错误消息中去掉本地文件的绝对路径。

### 📄 资源与文档
- **新资源**: 新增 `mcp://nexus/active-meeting`，可直接读取当前会议的记录和决策。
- **改进工具体验**: 在工具定义中写明返回值结构和管理权限要求。
- **手册**: 更新 `ASSISTANT_GUIDE.md` 和中英文 README，加入新的管理工具文档和 Phase 2 最佳实践。

## [v0.1.7] - 2025-12-30

### ⚙️ CLI 简化
- **Moderator 参数**: 用简单的布尔参数 `--moderator` 取代 `--moderator-id <id>`。
  - Moderator: `--id Master-AI --moderator`
  - 普通 AI: `--id Assistant-AI`（无需额外参数）

### ✅ 测试
- 新增会话资源测试，验证角色（Moderator/普通）。
- 全部 17 个单元测试通过。

## [v0.1.6] - 2025-12-29

### 🔒 并发安全
- **AsyncMutex 锁**: 实现基于互斥锁的并发控制，防止同时写文件时的竞态条件。
- 受保护的写操作:
  - 讨论: `addGlobalLog()`、`pruneGlobalLogs()`、`clearGlobalLogs()`
  - 注册表: `saveProjectManifest()`、`renameProject()`、`deleteProject()`

### 📦 Schema v2.0
- **Manifest Schema 增强**: 新增若干可选字段，用于跨项目协作和兼容性声明:
  - `apiDependencies`: projectId 到版本约束的映射（例如 `">=v2.1"`）
  - `gatewayCompatibility`: 网关版本兼容性字符串
  - `api_versions`: 功能级 API 版本
  - `feature_tier`: 能力类别声明，用于互操作

## [v0.1.5] - 2025-12-29

### 🚀 主要功能
- **项目 ID 命名规范**: 强制采用 `[prefix]_[technical-name]` 标准，共 13 种类型前缀（web_、api_、chrome_、vscode_、mcp_、android_、ios_、flutter_、desktop_、lib_、bot_、infra_、doc_）。
- **MCP Prompts 能力**: 新增 `init_project_nexus` prompt，引导 AI 按正确流程注册项目。
- **delete_project 工具**: 新的管理工具，完整删除项目（manifest、资产、注册表条目）。

### 🔒 防护
- 新增 `validateProjectId()`，在 `handleRegisterSession`、`handleSyncProjectAssets` 和 `handleRenameProject` 中做运行时正则校验。
- ID 格式无效的项目现在在 API 层即被拒绝。

### ✨ 增强
- 资源名称现在显示项目类型图标（例如 "🌐 Website: web_example.com"）。
- 处理函数单元测试扩展到删除、重命名和校验场景。

### 📄 文档
- 在 README.md 中新增 "Project ID Conventions" 章节。
- 工具说明中加入前缀字典指引。

## [v0.1.4] - 2025-12-29

### 🐛 缺陷修复
- 添加 shebang（`#!/usr/bin/env node`），修复 Windows 上 npx 无法执行的问题。

## [v0.1.3] - 2025-12-29

### 🔧 CI/CD
- 改用 npm Trusted Publishing（OIDC），不再需要 NPM_TOKEN。
- 升级到 Node.js 22，以支持 npm 11.5.1+。
- 添加 `--provenance` 参数，提升供应链安全。

## [v0.1.2] - 2025-12-29

### 🔧 重构
- 把代码库拆分为 `tools/`、`resources/` 和 `storage/` 模块。
- `index.ts` 从 535 行缩减到 115 行。
- 测试从 `src/__tests__/` 移到顶层 `tests/` 目录。

### 📦 CI/CD
- GitHub Actions 的触发方式从 `release` 改为推送标签（`v*`）。

### 📄 文档
- 新增 npm 下载量徽章。
- 仓库 URL 修正为 `n2n-nexus`。

## [v0.1.1] - 2025-12-29

### 📦 npm 发布
- 以 `n2n-nexus` 发布到 npm。
- README 增加 `npx` 配置，便于接入 MCP。
- 新增 CLI 参数说明表。

## [v0.1.0] - 2025-12-29

### 🚀 主要功能
- **项目资产中心**: 集中存储项目 Manifest、内部文档和资产（图片/文件）。
- **通讯频道**:
    - `mcp://chat/global`: 代理之间的实时消息流。
    - `post_global_discussion`: 用于协调的广播工具。
- **拓扑引擎**:
    - `get_global_topology`: 根据 manifest 的 `relations` 自动生成依赖图。
- **全局知识库**:
    - 新的 `docs/` 目录结构，存放共享规范。
    - 工具: `sync_global_doc`、`read_global_doc`、`list_global_docs`。
- **自愈存储**:
    - 自动修复损坏的 JSON 注册表或日志。
    - 缺少配置时使用安全的默认值。

### 🛠️ 工具
- 新增 `update_project`，用于局部修补 manifest。
- 新增 `rename_project`，自动级联更新所有项目中的引用。
- 新增 `register_session_context`，用于绑定 IDE 会话。
- 新增 `moderator_maintenance`，用于清理日志。

### 📚 文档
- 更新 `README.md`，加入完整的架构图和数据持久化说明。
- 新增 `ASSISTANT_GUIDE.md`，描述 AI 之间的操作协议。
