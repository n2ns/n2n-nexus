# n2n-nexus 工具参考

[English version](TOOLS_REFERENCE.md)

本文档介绍 n2n-nexus 适配器提供的 MCP 工具。工具调用会转发给运行在 `NEXUS_ENDPOINT` 的 host（`n2n-nexus-host`）。

下面的参数表来自 `contract/tools.json`。host 通过 `GET /api/tools` 提供这份 JSON Schema，并在处理函数运行前用它校验每一次调用。参数无效的调用会被拒绝，并返回说明原因的错误（`Invalid arguments for <tool>: ...`）；schema 没有声明的键会在校验前被丢弃。

## 约定

- 每个成功的结果都返回两份：一份是 `structuredContent`（JSON 对象），另一份是放在文本块里的同一段 JSON，供只读取文本的客户端使用。返回数据的工具（`search_projects`、`get_global_topology`、`get_project`、`read_messages`、`list_events`、`get_global_strategy`、`list_global_docs`、`get_global_doc`、`list_meetings`、`stance`、`get_task`、`list_tasks`、`peers`、`read`、`set_profile`）还会提供 `outputSchema`；只返回确认的工具不提供，以保持 `tools/list` 精简。结果的结构就是 `contract/tools.json` 里的 `outputSchema` 条目；host 用它们校验每一个结果。
- 调用按对话限流，没装 hooks 时按实例（默认每秒 20 次，突发 60 次；对应 host `settings.json` 中的 `rateLimit` 和 `rateBurst`）。超出限制的调用会失败并返回 "Rate limit exceeded ... retry after Ns"；等待该时长后重试。
- 每个工具都有供客户端界面显示的 `title`（例如 "Delete Project"）。
- 每个工具都带有 MCP annotations：`readOnlyHint`、`destructiveHint`、`idempotentHint` 和 `openWorldHint: false`（所有工具都只作用于 host）。按照 MCP 的定义，只有更新完全是追加时，工具才算非破坏性。读取类工具标为只读。`start_meeting`、`join_meeting`、`create_task`、`send_message`、`send` 和 `reply` 只追加数据，是非破坏性的（`join_meeting` 也是幂等的）；`update_task` 也标为非破坏性且幂等。`listen`、`set_profile`、`sync_project_assets`、`update_project`、`upload_project_asset`、`rename_project`、`sync_global_doc`、`update_global_strategy`、`end_meeting`、`archive_meeting`、`reopen_meeting`、`leave_meeting`、`stance`、`cancel_task`、`host_maintenance` 和 `host_delete_project` 会改写或删除已有状态，标为破坏性，以便客户端请求确认。`read_messages` 和 `read` 不是只读的，因为它们会推进调用方自己的未读状态；但它们是非破坏性的，因为不改变任何共享数据。
- 每个适配器都有一个实例 ID（`NEXUS_INSTANCE_ID`、`--id`，默认是 `mcp-<hostname>-<工作目录的哈希>-<IDE 名>`，其中 IDE 名是 MCP 客户端名，取自请求的 `io.modelcontextprotocol/clientInfo`，2025 代的客户端则取自 `initialize`）。同一个 IDE 在同一个工作区里重启后它保持不变，而同一个工作区里的两个 IDE 仍然互相区分。适配器在每次调用中都以 `instanceId` 带上它。同一个 IDE 在同一个工作区里的多个对话共用它，所以装了 n2n-nexus hooks 时，聊天和会议工具改为识别对话本身（见下一条）；没装 hooks 的客户端按实例识别，这时没有 `instanceId` 的 `read_messages` 会失败。
- 结果里会出现两种 ID：对话的会话 ID（`claude:<id>` 或 `codex:<id>`）和适配器实例 ID（`mcp-…`）。直接消息工具（`peers`、`send`、`read`、`reply`）使用会话 ID。聊天和会议在装了 hooks 时使用调用方对话的会话 ID，否则使用实例 ID：`send_message` / `read_messages` 的发送方和 `from`、未读游标、会议的 `initiator` 和 `participants`、`meeting.*` 事件的 `actor`；结果里的 `identity`（`session` 或 `instance`）说明是哪一种。这里的会话 ID 可以用于 `send`，实例 ID 不能。某个实例在最近 30 分钟内识别出过对话、而这次调用识别不出时，调用会失败并提示重试，而不会改用该实例共用的游标。其他事件和全局文档的 `updatedBy` 仍是实例 ID。
- 项目 ID 采用 `[prefix]_[name]` 格式；前缀列在[助手指南](ASSISTANT_GUIDE_zh.md#2-项目-id)中。
- 所有项目写入工具都同步执行并直接返回结果。任务工具（`create_task`、`get_task`、`list_tasks`、`update_task`、`cancel_task`）用于跟踪由助手自己管理的工作。
- 项目工具显式接收 `projectId`。
- `host_delete_project` 是破坏性操作，且不可逆。

## 共享对象结构

### 项目 manifest

由 `sync_project_assets` 使用，`update_project` 使用其中一部分。

| 字段 | 类型 | MCP schema 是否要求 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 项目 ID。不能通过 `update_project` 修改；请使用 `rename_project`。 |
| `name` | string | 是 | 便于阅读的项目名称。 |
| `description` | string | 是 | 项目简介。 |
| `techStack` | string[] | 是 | 项目使用的技术。 |
| `relations` | object[] | 是 | 项目之间的关系。结构：`{ targetId, type }`，其中 `type` 为 `dependency`、`parent`、`child` 或 `related`。 |
| `repositoryUrl` | string | 是 | 源代码仓库 URL。 |
| `localPath` | string | 是 | 项目在本地文件系统中的路径。 |
| `endpoints` | object[] | 是 | 结构：`{ name, url, description }`。 |
| `apiSpec` | object[] | 是 | 结构：`{ method, path, summary }`。 |
| `billing` | object | 否 | `{ plain, price }`：以自由文本表示的计费方案或条款（`plain`）和价格（`price`），两者都是字符串。 |
| `lastUpdated` | string | 否 | 保存在 manifest 中的字段。 |
| `apiDependencies` | object | 否 | 可选，项目 ID 到版本约束的映射。 |
| `gatewayCompatibility` | string | 否 | 可选，网关版本兼容性字符串。 |
| `api_versions` | object | 否 | 可选，功能级 API 版本映射。 |
| `feature_tier` | string | 否 | 可选，`standard`、`advanced` 或 `team`。 |

## 项目资产管理

### `sync_project_assets`

同步完整的项目 manifest 和内部文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `manifest` | 项目 manifest | 是 | 完整的 manifest 对象。见[项目 manifest](#项目-manifest)。 |
| `internalDocs` | string | 是 | Markdown 格式的实现指南或内部笔记。 |

行为：

- 保存 manifest 和项目文档。
- 返回 `{ ok: true, projectId }`。

### `upload_project_asset`

把二进制或文本资产上传到项目的资产库。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 目标项目。必须已存在。 |
| `fileName` | string | 是 | 只能是文件名。不安全的路径字符会被替换；`.` 会被拒绝。 |
| `base64Content` | string | 是 | Base64 编码的文件内容。 |

行为：

- 把文件随项目存进 host 数据库，替换同名资产。项目改名或删除时，其资产也随之改名或删除。
- 返回 `{ ok: true, projectId, fileName }`，其中是清理后的文件名。

### `update_project`

修改已有项目 manifest 中的字段。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 要更新的项目。 |
| `patch` | object | 是 | 要更新的部分 manifest 字段。未知字段和 `id` 会被拒绝。 |

行为：

- 返回 `{ ok: true, projectId }`。
- 要修改项目 ID，请使用 `rename_project`。

### `rename_project`

重命名项目 ID，并级联更新关系。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `oldId` | string | 是 | 现有项目 ID。 |
| `newId` | string | 是 | 新项目 ID。 |

行为：

- `oldId` 不存在时失败。
- 返回 `{ ok: true, oldId, newId }`。

### `search_projects`

搜索项目注册表。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `query` | string | 是 |  | 项目 ID、名称或描述中的子串，不区分大小写。 |
| `limit` | integer | 否 | `10` | 最多返回的项目数（1–200）。 |

### `get_global_topology`

读取项目拓扑。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 否 | 提供时，返回该项目及它直接或间接依赖的项目（只看出向关系）；未知的 projectId 会报错。不提供时，返回所有项目（id、名称、摘要、最后活跃时间）以及项目总数和关系总数。 |

行为：

- 提供了 `projectId` 但项目不存在时失败。

### `get_project`

读取单个项目的 manifest 和内部文档。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `projectId` | string | 是 |  | 要读取的项目。 |
| `includeDocs` | boolean | 否 | `true` | 设为 `false` 时不返回内部文档。 |

行为：

- 返回 `{ manifest, internalDocs? }`。
- 项目不存在时失败。

## 消息与协作

### 对话之间的直接消息

每个 Claude Code 和 Codex 对话都是一个会话，ID 为 `claude:<会话 ID>` 或 `codex:<会话 ID>`，取自客户端。`n2n-nexus install <claude|codex>` 写入的 hooks 会创建会话并保持其状态最新；子代理与其父对话共用同一个会话。恢复对话时沿用原来的会话。在同一个客户端里开始的新对话（例如 Claude Code 中执行 `/clear` 之后）是一个新会话；Claude Code 还会结束旧会话，旧会话随之变为离线。

下面六个工具从 MCP 请求的 `_meta` 识别调用方，从不使用参数：Claude Code 带上 `claudecode/toolUseId`，它由 PreToolUse hook 在调用前刚刚绑定到对话；Codex 带上 `sessionId`。其他客户端、没有 hooks 的对话，或绑定已超过五分钟的调用会收到一条错误，说明：直接消息需要装有 n2n-nexus hooks 的 Claude Code 或 Codex（`n2n-nexus install <claude|codex>`）；hooks 只对安装之后开始的对话生效；MCP 服务器必须以 `n2n-nexus` 为名注册；PreToolUse 绑定过期时再调用一次工具即可解决。其他所有工具都不关心调用方。

这六个工具是对话之间的直接消息。全局聊天和会议是另外的东西：`send_message` 发到那里，`read_messages` 从那里读取；两者都不会发到或读取对话的直接消息。

| 工具 | 参数 | 结果与行为 |
| --- | --- | --- |
| `peers` | `includeOffline?: boolean = false` | `{ self: Profile, peers: Profile[] }`；其他未离线的会话，最近活跃的在前。带 `includeOffline` 时，还包括过去 24 小时内活跃过的离线会话。 |
| `send` | `to: string`、`text: string`（1–32000 个字符）、`notifyWhenIdle?: boolean = false`、`expectsReply?: boolean = true`、`wake?: boolean = true` | `{ messageId, to: { id, name, status } }`。`to` 是会话 ID（任何状态）或某个未离线会话的名称；不能给自己发消息。离线的收件方在恢复时收到消息。带 `notifyWhenIdle` 时，收件方下一次结束一轮、开始待命或离线时，你会收到一次通知（订阅 24 小时后失效）。`expectsReply: false` 告诉收件方无需回复；`wake: false` 不叫醒收件方、也不拦住它结束这一轮，它在下次输入或调用工具时看到这条消息。单纯的确认收到要两个都设为 false，或者干脆不发。 |
| `read` | `count?: integer = 10`（1–50） | `{ messages: [{ messageId, from: { id, name }, replyTo, text, createdAt, expectsReply }], remaining }`；未读消息，最早的在前，读取后标为已读。 |
| `reply` | `messageId: string`、`text: string`（1–32000 个字符）、`expectsReply?: boolean = true`、`wake?: boolean = true` | 结果与 `send` 相同。该消息必须是发给你的（它的 ID 在通知和 `read` 里）；回复发给它的发送方，`replyTo` 设为该消息，被回复的消息标为已读。 |
| `listen` | `on: boolean` | `{ listening }`。开启期间，对话每结束一轮，其 Stop hook 会等待最多 590 秒，有消息或通知到达时让对话继续。在 Claude Code 中按 Esc 会结束一次等待。 |
| `set_profile` | `name?: string`（1–48 个 `A–Z a–z 0–9 . _ @ # -` 中的字符）、`note?: string`（≤ 200 个字符）、`title?: string`（≤ 80 个字符）、`label?: string`（≤ 32 个字符）；至少提供一个 | `{ profile }`。名称在未离线的会话中唯一。 自己设置的 `title` 会取代客户端提供的标题，直到设为 `""`。`label` 是你所在机器的名字（如 `mac-air`），显示时取代主机名；设为 `""` 删除。 |

`Profile` 包含 `id`、`name`、`title`、`client`（`claude` 或 `codex`）、`cwd`、`hostname`、`platform`、`environment`、`utcOffset`、`label`、`note`、`status` 和 `lastActiveAt`。`hostname`（macOS 上是系统设置里起的电脑名，其他系统是去掉 `.local` 后缀的主机名）、`platform`（`darwin`、`linux`、`wsl` 表示 Windows 下的 Linux 发行版、`win32`）、`environment`（WSL 发行版名，用来区分同一台 Windows 上的多个发行版，其他情况为 `""`）和 `utcOffset`（本地时间减 UTC 的分钟数）由会话的 hooks 随每个事件上报。介绍、通知和会议消息在名字后面显示机器，格式为 `<label 或主机名> · <macOS | Linux | WSL | Windows>[ <environment>]`，例如 `claude@_projects#3f9a (Vector · WSL Ubuntu_26)`。`title` 是客户端里显示的对话标题（Claude Code：对话标题或你给它起的名字；Codex：线程名，没有则为第一句提问），由 hooks 在对话开始、每次提交提示词和本轮结束时读取，最多 80 个字符；还没有时为 `""`。它显示在 `peers`、介绍、通知和会议成员里名称的旁边；`send` 仍用 `name`。会话的名称为 `<client>@<工作目录名>#<客户端会话 ID 的最后 4 个字母和数字>`；数据库里已有别的会话（不论状态）用了这个名称时，多取 ID 的位数，所以只要两个会话的记录都在，一个名称就不会指向两个会话；会话恢复时如果名称已被别的会话用 `set_profile` 占用，就按同样的规则重新取名。`status` 为 `working`（用户发送了提示词或有工具在运行）、`idle`（本轮已结束；有后台等待消息的会话改为显示 `listening`）、`listening`（在 listen 模式下等待）或 `offline`（对话已结束）。客户端不一定会报告对话结束，所以 `idle` 或 `working` 的会话 30 分钟没有任何活动也会变为 `offline`；它的下一个事件会让它恢复。只有 `listening` 的会话会立即回应；`idle` 和 `working` 的会话要等它的用户下次发送提示词或它下次调用工具时才会看到消息。

送达。收件方的 hooks 提醒新消息时带上完整正文：每条列出的消息夹在 `--- Message <id> from <发送方> (<会话 ID>) at <时间> ---` 和 `--- End of message <id> ---` 之间，前面是它回复的消息，后面是怎么回复它。一条通知里所有正文合计截到 5000 个字符（`notifyTextChars`）；被截断的消息会标出来，`read` 返回它的全文。通知只陈述事实：发送方、正文、要不要回复、怎么回复（Claude Code 会话还给出工具全名 `mcp__n2n-nexus__reply`）；收件方可以为一条消息做什么，由它的用户自己的指令决定，例如 `install claude` 写进 `CLAUDE.md` 的那段。完整显示的消息在提醒让一轮继续或开始时（本轮即将结束、待命、空闲）标为已读，无需回复的消息随提示词显示时也标为已读。其他消息仍为未读，直到用 `reply` 回复或用 `read` 读取：随提示词显示、需要回复的消息，以及工具调用后显示的所有消息，因为那段上下文可能只到了子代理；这类消息在本轮结束时照样拦住一次。每条消息只列出一次；它一直未读时，之后的通知只计数。`expectsReply: false` 的消息会标上 `(no reply needed)`，消息全都无需回复的通知不会要求回复。已加入的会议的新消息也这样送达，每条带正文（见 [`join_meeting`](#join_meeting)）：

| 客户端事件 | 收件方看到的内容 |
| --- | --- |
| 对话开始 | 自己的名称和 ID、未离线的其他会话（最多列出五个）、其中哪些能立即回应、`peers`、`send` 和 `read` 的用法，客户端自带的代理列表看不到这些会话，以及协作规则：消息可以要求什么由用户自己的指令决定，有疑问问发送方；把工作交给别的会话时，对方需要的一切都写进一条消息，发完就结束本轮而不是用 `read` 轮询；任务只回复一次结果，做不完时说明卡在哪里、需要什么才能继续；不发单纯的确认，也不把任务推回给发来的会话。 |
| 提交提示词 | 新消息（最多显示五条）、之前提醒过的未读消息数、待处理的通知和会议新消息。被叫醒的那一轮开始时的提示词只附带叫醒之后新到的内容。 |
| 每次工具调用后 | 只有尚未提醒过的消息、通知和会议新消息。 |
| 本轮即将结束 | 有可以叫醒会话的未读消息（`wake` 为 true）、待处理的通知，或会话以 active 方式参加的会议有新消息时，本轮带着提醒再继续一次。 |
| 待命中 | 一有可以叫醒会话的内容到达就结束等待，对话带着它继续。 |
| 空闲（本轮已结束） | Stop hook 启动的后台等待（`n2n-nexus hook <client> --wait`，最长一小时）带着提醒开启新的一轮：Claude Code 通过 `asyncRewake` hook（退出码 2），Codex 通过 `codex queue --thread <会话 ID>`（`NEXUS_CODEX_COMMAND` 可替换 `codex` 命令）。在无人值守的 Claude 会话（`claude -p`、`CLAUDE_CODE_SESSION_ATTENDED=0`）中，该 hook 立即返回，因为 `claude -p` 会等它结束才退出。等待期间会话显示为 `listening`；对话中的任何新活动都会结束等待。Codex 只会为运行中的 Codex 应用里已加载的对话启动排队的一轮，且 Codex 退出时等待结束；`codex queue` 失败时这次唤醒会被撤销，等待隔一段时间（1 秒起，每次加倍，最长 5 分钟）后再次送达同样的消息。 |
| 自动轮次上限 | 被叫醒、待命中的 Stop，以及因私信或其通知而不结束的 Stop，各算一次自动轮次；会议新消息和会议通知不计数，也不受限制；提醒中会写 `Automatic turn n of N`。设置了 `maxAutoTurns` 时（host `settings.json`；默认 0，即不限制，提醒中也不写计数），从用户上次输入以来达到这个次数后，消息仍会保存，但不再叫醒或拦住对话；用户下次输入时提醒这些消息，并重新开始计数。叫醒后一分钟内的提示词视为被叫醒的那一轮开始，不清零计数。 |

未读消息 24 小时后过期，发送方随后会收到通知。通知也会报告 `notifyWhenIdle` 的结果。

HTTP 客户端：hooks 调用 `POST /api/hook`，请求体为 `{ client: "claude" | "codex", input }`，其中 `input` 包含 hook 标准输入中的字段 `hook_event_name`、`session_id`、`cwd`、`stop_hook_active`、`tool_use_id`、`tool_name`、`source` 和 `reason`，另加 `machine: { hostname, platform, environment, utcOffset }`（见 `contract/hook.json` 的 `schemas.hookMachine`），对话的每个事件都必须带上，缺少或无效时返回 400；响应为 `{ output }`，不为 null 时由 hook 打印。工具调用在 `POST /api/tools/call` 中用与 `tool`、`args`、`instanceId` 并列的 `caller` 指明会话：`{ client: "claude", toolUseId }` 或 `{ client: "codex", sessionId }`。它们只在可信本地 host 范围内标识对话，不是凭证：同一系统用户的任何进程都能发送它们（见 [SECURITY_zh.md](SECURITY_zh.md) 中的本地信任模型）。

### `send_message`

发到某个会议或全局聊天。要给某一个对话发消息，请使用 `send`；`send_message` 不会发到对话的直接消息。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | string | 是 | 消息正文。 |
| `category` | string | 否 | `PROPOSAL`、`DECISION`、`UPDATE`、`CHAT` 或 `MEETING_START`（保留值；host 从不写入）之一。不传时消息没有分类。 |
| `meetingId` | string | 否 | 目标会议。必须处于活跃状态。 |
| `draft` | boolean | 否 | 把这条消息发布为会议的当前待决稿（只限会议；类别为 `PROPOSAL`）。见 [`stance`](#stance)。 |

行为：

- 提供 `meetingId` 时，消息发到该会议。
- 否则，如果有活跃会议，消息发到该会议。
- 否则写入全局聊天。
- 会议中的 `DECISION` 消息还会记入该会议的决策（`list_meetings` 中的 `decisionCount`）。
- 随消息保存的发送方是调用方对话的会话 ID，没装 hooks 时是适配器实例 ID。
- 先读后发：会议里在你的读取游标之后还有别人的消息时，发言被拒。游标随未读模式的 `read_messages`、完整显示并算作已读的通知（见上面的送达表）以及被拒时移动；历史读取（`latest`、`afterId`）不移动它。被拒的消息不会发出；结果为 `{ ok: false, refused: true, sentTo: "meeting", meetingId, identity, unread, message }`，`unread` 是那些消息（`[{ id, from, senderName, senderMachine, senderBackfilled, text, category, timestamp, cut }]`，从旧到新）。它们的正文合计截到 5000 个字符（`notifyTextChars`）：到达上限的那条截断附上（`cut: true`），之后的不附；`read_messages` 返回它们。完整附上的消息从此算已读，不再提醒。host 因你自己的调用而发的消息（席位已占据、AI 共识提示、席位的批准或否决），在你已读完它之前所有消息时对你算已读。
- 被拒之后对该会议的下一次 `send_message` 即使又有新消息也会发出，正文末尾附上 `[n2n-nexus: sent while #a–#b were unread by the sender.]`；那些消息仍为未读。草案（`draft: true`）和 `DECISION` 不放行：它们的正文会成为决议，必须读完才能发。全局聊天没有这项检查。
- 结果：`{ ok: true, sentTo: "meeting" | "global", meetingId?, messageId, identity, currentProposalId?, message }`（带 `draft` 时有 `currentProposalId`）；`messageId` 是消息在所属会议里的编号（每个会议从 1 开始），或它的全局聊天 ID（可用于 `afterId`）。

### `read_messages`

读取全局聊天或会议中的消息：未读消息（默认）或历史。发给你的对话的直接消息用 `read` 读取。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `count` | integer | 否 | `10` | 要读取的消息数（1–500）。 |
| `meetingId` | string | 否 |  | 提供时从该会议读取。否则从全局聊天读取。 |
| `latest` | boolean | 否 |  | 历史模式：最新的 `count` 条，最早的在前。不能与 `afterId` 同时使用。 |
| `afterId` | integer | 否 |  | 历史模式：ID 大于 `afterId` 的前 `count` 条（会议里是消息编号）。不能与 `latest` 同时使用。 |

行为：

- 未读模式按对话增量进行（没装 hooks 时按适配器实例）：每次调用返回读取游标之后的他人消息，最早的在前，游标越过这些消息和它自己发的消息。在会议里，通知完整显示并算作已读的消息、被拒的 `send_message` 或 `stance` 完整附上的消息也会让游标越过，不会再次返回。
- 对话第一次以未读模式读全局聊天时从最新消息开始：本次不返回消息，带一条 `note`；更早的消息用 `latest` 或 `afterId` 读。第一次读某个会议时从该会议的第一条开始。
- 历史模式不动游标，包含自己的消息，也不需要识别身份。
- 结果：`{ source: "global" | "meeting", mode: "unread" | "history", identity?, meetingId?, messages: [{ id, from, senderName, senderMachine, senderBackfilled, text, category, timestamp }], count, note? }`。`from` 是发送方的会话 ID（`senderName` 是它的名字，可用于 `send`，用户席位的消息为 `user's seat (via <名字>)`；`senderMachine` 是它的机器，格式 `<label 或主机名> · <平台>[ <environment>]`，两者都是写这条消息时的样子，会话被清理后仍保留）或实例 ID（`senderName` 和 `senderMachine` 为 null）；`senderBackfilled` 为 true 表示 host 开始保存这两项之前写的消息，名字和机器是升级数据库时按会话当时的样子补填的；没有类别的消息 `category` 为 null。会议消息的 `id` 是它在该会议里的编号，从 1 开始；全局聊天的消息有自己的 ID。
- 没装 hooks 时未读模式需要调用方实例：没有 `instanceId` 的调用会失败，并返回 `read_messages needs the instanceId field of the POST /api/tools/call body (the n2n-nexus MCP adapter sends it automatically); unread cursors are kept per instance.` MCP 适配器总会带上它。

### `list_events`

读取结构化活动日志。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `limit` | integer | 否 | `20` | 最多返回的事件数，最新的在前（1–500）。 |
| `action` | string | 否 |  | 完整的 action（`meeting.end`）或前缀（`project`、`meeting`）。 |

行为：

- 通过 host 工具产生的每一次状态变更都会被记录：`project.sync`、`project.update`、`project.rename`、`project.delete`、`project.asset`、`doc.sync`、`strategy.update`、`meeting.start`、`meeting.end`、`meeting.archive`、`meeting.reopen`、`meeting.join`、`meeting.leave`、`maintenance.prune`、`maintenance.clear`。
- 每个事件带有 `timestamp`、`actor`、`action`，以及可选的 `target` 和 `detail`。`meeting.*` 事件的 `actor` 是调用方对话的会话 ID（没装 hooks 时是适配器实例 ID）；其他事件记录适配器实例 ID。

### `update_global_strategy`

覆盖写入主战略文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string | 是 | 全局战略文档的完整 Markdown 内容。 |

行为：

- 替换已保存的战略文档。用 `get_global_strategy` 读回。

### `get_global_strategy`

读取主战略文档。没有参数。

行为：

- 返回 `{ content }`。

### `list_global_docs`

列出全局共享文档。没有参数。

行为：

- 返回 `{ count, docs: [{ docId, title, lastUpdated, updatedBy }] }`，最近更新的在前。

### `get_global_doc`

读取一份全局共享文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `docId` | string | 是 | 来自 `list_global_docs` 的文档 ID。 |

行为：

- 返回 `{ docId, title, lastUpdated, updatedBy, content }`。
- 文档不存在时失败。

### `sync_global_doc`

创建或更新一份全局共享文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `docId` | string | 是 | 固定不变的文档 ID。 |
| `title` | string | 是 | 便于阅读的文档标题。 |
| `content` | string | 是 | Markdown 内容。 |

## 会议管理

### `list_meetings`

列出会议，最新的在前。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | string | 否 |  | `active`、`closed` 或 `archived`。 |
| `limit` | integer | 否 | `20` | 最多返回的会议数（1–200）。 |

行为：

- 返回 `{ count, activeMeetingId, meetings: [{ id, topic, status, initiator, startTime, endTime?, participants, members, messageCount, decisionCount, wakes, summary?, endReason, seat, proposal }] }`。`seat` 是坐在用户席位上的会话（见[用户席位](#用户席位)），没有席位的会议为 null。
- `endReason` 为 `consensus`（由 [`stance`](#stance) 自动结案）、`manual`（`end_meeting`）、`expired`（连续 `meetingRetentionDays` 天没有发言，被 host 的清理关闭）或 null。`proposal` 是当前待决稿，没有时为 null：`{ messageId, author, approversVersion, required, endorsed, waiting, objections: [{ id, note }], seat }`。
- `participants` 是所有发过言的人；`members` 是加入了且没有离开的成员：`[{ id, name, title, machine, backfilled, mode, approver, status, joinedAt, wakes, lastWokenAt }]`，`name`、`title`、`machine` 是会话加入时的样子（适配器实例为 null；升级数据库时补填的 `backfilled` 为 true），`status` 是会话现在的状态（适配器实例或已被清理的会话为 null）。`wakes` 统计这个会议引起的叫醒和拦住结束的次数，按成员和按会议各一个；它只用于展示，不会因此结束会议。
- 用 `read_messages(meetingId)` 读取会议的消息。

### `start_meeting`

开启一个新会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `topic` | string | 是 | 会议主题。用于创建会议记录。 |
| `seat` | string | 否 | `user`：你坐上用户席位（见[用户席位](#用户席位)）。 |

行为：

- 调用方对话（没装 hooks 时是它的适配器实例）成为会议的 `initiator`，并以 `active`、`required` 成员身份加入。
- 新会议成为所有人的默认会议：不传 `meetingId` 的 `send_message` 和 `end_meeting` 都作用于它，直到它结束（之后是仍处于活跃状态、最近被激活的会议，如果有的话）。`reopen_meeting` 以同样的方式让重新开启的会议成为默认会议。

### `end_meeting`

关闭并锁定会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 否 | 要关闭的会议。不传时使用活跃会议。 |
| `summary` | string | 否 | 可选的结束总结；用户席位结束会议时必填。 |

### `archive_meeting`

存档已关闭的会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 是 | 要存档的会议。 |

### `reopen_meeting`

重新激活已关闭或已存档的会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 是 | 要重新开启的会议。 |

行为：

- 任何适配器实例都能结束、存档或重新开启会议，不只是它的 `initiator`。有用户席位的会议只能由席位结束：其他人的 `end_meeting` 改为发一条 `Proposed end of the meeting (only the user's seat ends it): <summary>`，返回 `{ ok: false, refused: true, meetingId, status: "active", messageId, message }`。
- `end_meeting` 关闭时 `endReason` 为 `manual`，不算共识；`reopen_meeting` 清除它和当前稿：重新开启的会议要对新草案表态（之前的表态保留为历史）。
- 结束会议时，除结束者以外的每个成员收到一条会议已结束的通知（附总结），无需回复；active 成员会被它叫醒，async 成员在下次输入或调用工具时看到。重新开启不会恢复已离开的成员。

### `join_meeting`

加入一个活跃会议，或者修改参加方式。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `meetingId` | string | 是 |  | 要加入的会议，必须处于活跃状态。 |
| `mode` | string | 否 | `active` | `active`：他人的新消息会叫醒你（或拦住本轮结束）；`async`：你在下次输入或调用工具时看到。 |
| `approver` | string | 否 | active 为 `required`，async 为 `optional` | 形成决议时是否必须得到你的认可。 |
| `since` | `beginning`、`latest` 或整数 | 否 | 首次加入为 `latest` | 这个会议的 `read_messages` 从哪里开始读：从第一条、从最新一条之后，或从该编号之后（`0` 即从头）。之后再次加入时不给 `since` 会保留你的游标。 |
| `seat` | string | 否 |  | `user`：你坐上用户席位（见[用户席位](#用户席位)）。 |

行为：

- 结果：`{ ok, meetingId, mode, approver, identity, delivery }`。`delivery` 为 `wake`（active）、`next-hook`（async）或 `unavailable`：没装 hooks 的客户端以适配器实例身份加入，没有任何方式能通知它。
- 新消息通过 hooks 按会议提醒：`Meeting "<主题>" (<id>): N new message(s), #a–#b:`，然后每条消息夹在 `--- Meeting message #n from <发送方> (<机器>) at <时间>[ (<类别>)] ---` 和 `--- End of meeting message #n ---` 之间。一条通知里会议消息的正文合计截到 5000 个字符（`notifyTextChars`，与私信分开计算）：到达上限的那条截断，之后的只计数（`- N more message(s) not shown (#a–#b).`）；`read_messages(meetingId)` 返回它们。和私信一样，让一轮继续或开始的通知、随提示词显示的通知里完整显示的消息算已读并移动你的读取游标，前提是它前面没有别人的未读消息；工具调用后显示的仍为未读。`read_messages` 以未读模式返回过的消息之后不再提醒。自己发的消息不会叫醒自己。会议新消息不算自动轮次，超过 `maxAutoTurns` 后仍会送达；会议一直进行到被结束为止。
- 加入前的消息不会提醒。已是成员时再次加入只修改 `mode` 和 `approver`；改为 `async` 即可暂停。`leave_meeting` 之后再加入，从最新一条开始。
- 记录 `meeting.join` 事件。

### `leave_meeting`

离开会议：会议新消息不再提醒或唤醒你，你的认可也不再计入。你作为提案作者收到的表态通知仍会在下一次正常 hook 时送达，退出后不会因此被唤醒。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 是 | 要离开的会议。你不是成员时会失败。 |

行为：

- 结果：`{ ok, meetingId }`。记录 `meeting.leave` 事件。`join_meeting` 可以重新加入；`reopen_meeting` 不会。
- 离开会把你从当前稿的必需认可名单里移除（见 [`stance`](#stance)）。

### `stance`

认可或反对一份提案，或撤回你的表态。会议通过对当前稿达成共识形成决议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 是 | 一个活跃会议。 |
| `messageId` | integer | 是 | 提案在会议里的编号（一条 `PROPOSAL` 消息）。 |
| `stance` | string | 是 | `endorse`、`object` 或 `withdraw`。 |
| `note` | string | `object` 时必填 | 反对的理由，或认可时附带的保留意见。 |

行为：

- 当前稿是最近一次用 `send_message(..., draft: true)` 发布的消息；普通的 `PROPOSAL` 既不换稿，也不改变任何人的表态。发布草案时确定它的必需认可名单：通过 hooks 以 `required` 身份加入的成员（适配器实例不能认可）。名单只在其中有人离开、或用 `join_meeting` 修改 `approver` 时变化（发稿前就已加入的成员可以重新以 `required` 加入名单，之后才加入的不进名单）；每次变化都会以新的 `approversVersion` 发到会议里。
- 先读后表态，同 [`send_message`](#send_message)：读取游标之后还有别人的消息时，`endorse` 和 `object` 被拒，返回 `{ ok: false, refused: true, meetingId, messageId, stance, unread, message }`，完整附上的消息算已读；`send_message` 被拒后的放行不适用于表态。`withdraw` 照常执行，并在 `unread` 和 `message` 里带上未读消息。
- 依据：`object`，以及和你在这份提案上一次表态（撤回的也算）不同的表态，`note` 里至少要有一项：本会议存在的消息 `#n`、文件路径、URL，或以 `实测：`、`文档：`、`数据：`（`Measured:`、`Docs:`、`Data:`）开头的一句。host 只查格式和 `#n` 是否存在，不查真假；缺了表态失败，并提示需要什么。
- 同一份提案上最多改变立场 2 次，第 3 次失败（有新依据请用 `send_message` 说明，等下一稿）。`withdraw` 始终可用，不计入次数。失败的表态不计任何次数。
- 每人对每份提案一条表态，新的覆盖旧的，`withdraw` 删除。反对会连同理由发到会议里。提案作者会收到每次表态的通知；认可不会叫醒其他人。
- 当前稿至少有 2 名必需认可人、他们全部认可、且没有任何人反对（适配器实例的反对同样阻止）时，会议以共识结案：`n2n-nexus` 发一条带草案原文的 `DECISION`，会议以 `endReason: consensus` 关闭，其他成员收到结束通知，通知里写明草案编号和决议的消息编号。必需认可人少于 2 名时，只能用 `end_meeting` 结束。
- 结果：`{ ok, meetingId, messageId, stance, currentProposalId, counted, approvals: { required, endorsed, waiting, objections: [{ id, note }], seat }, decided, decisionId?, unread?, message? }`。`approvals.seat` 是用户席位的 `{ id, stance, note }`，没有席位时为 null；席位不出现在其他列表里。适配器实例的 `counted` 为 false；`waiting` 是还没有任何表态的必需认可人；这次表态让会议结案时 `decided` 为 true。
- 有草案的会议安静超过 `stanceReminderMinutes`（host `settings.json`，默认 10）、且有必需认可人还没表态时，每人被提醒一次，作者收到一份缺谁的汇总。提醒从不结束会议。

### 用户席位

一个会议可以有一个代表用户的会话：用 `seat: "user"` 调用 `start_meeting` 或 `join_meeting` 的会话（需要装 hooks）。坐上席位会把它从原来的会话转过来，原会话照旧是成员；host 发一条 `The user's seat is taken by …` 或 `The user's seat moved from … to …`。席位的发言发送方显示为 `user's seat (via <名字>)`。有席位的会议里：

- 席位对当前稿的表态就是用户的决定。`endorse`：host 发一条带草案原文的 `DECISION`（附席位的说明和仍未解决的反对），之后到下一稿之前没有当前稿；`decisionId` 是它的编号。`object`：host 发 `Draft #n was vetoed by the user's seat (…): <说明>`，草案作废。会议继续进行下一个点。认可已不是当前稿的草案只记录表态。
- 其他人的共识不做决定：席位以外的必需认可人（至少两名）全部认可当前稿且无人反对时，host 发 `AI consensus on draft #n …`，不再成立时发 `AI consensus on draft #n is lost.`；只在状态变化时发。表态提醒不提醒席位。
- 席位不需要依据、没有改口次数限制，它的 `object` 也不因未读被拒（未读消息照样附上）。
- 只有席位能结束会议，且要给 `summary`（见 [`end_meeting`](#end_meeting)）。席位会话不在时什么都不变；用户可以在任一对话里重新坐上席位。有过席位的会议在席位会话被清理后仍按这些规则进行。

## 任务管理

### `create_task`

创建一条任务记录，由你自己用 `update_task` 跟踪和更新；host 不执行任务。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `source_meeting_id` | string | 否 | 把任务关联到某个会议，便于追溯。该会议必须存在。 |
| `metadata` | object | 否 | 任意元数据对象。 |
| `ttl` | integer | 否 | 存活时间，单位毫秒。超过 TTL 的待处理或运行中任务会在每小时一次的清理中被标为 `failed`（`TTL expired`）；结束的任务在最后一次更新 `retentionDays` 天后清除（host `settings.json`，默认 7）。 |

行为：

- 返回 `{ task_id, status, message, task }`。

### `get_task`

读取任务状态和结果。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | `create_task` 返回的任务 ID。 |

### `list_tasks`

列出任务，可按状态筛选。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | string | 否 |  | `pending`、`running`、`completed`、`failed` 或 `cancelled` 之一。 |
| `limit` | integer | 否 | `50` | 最多返回的任务数（1–500）。 |

### `update_task`

更新你创建的任务。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | 要更新的任务。 |
| `status` | string | 否 | `pending`、`running`、`completed`、`failed` 或 `cancelled` 之一。 |
| `progress` | number | 否 | 进度，从 `0` 到 `1`。 |
| `result_uri` | string | 否 | 结果所在位置。 |
| `error_message` | string | 否 | 任务失败的原因。 |
| `metadata` | object | 否 | 替换任务的整个元数据对象；未提供的键不会保留。 |

行为：

- 只修改提供的字段和任务的更新时间。
- 返回任务：`{ id, status, progress, source_meeting_id, metadata, result_uri, error_message, created_at, updated_at, ttl }`。
- 任务不存在时失败。

### `cancel_task`

取消待处理或运行中的任务。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | 要取消的任务。 |

## 维护

### `host_maintenance`

修剪或清空全局聊天流，立即执行清理，或把会议导出为 markdown。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | `prune`、`clear`、`cleanup` 或 `export`。 |
| `count` | integer | `prune` 时必填 | 要删除的最旧消息数；`prune` 时至少为 `1`。其他 action 忽略它。 |
| `dryRun` | boolean | 否 | `cleanup`：只报告会删除或改动什么，不做任何改动。 |
| `meetingId` | string | `export` 时必填 | 要导出的会议。 |

行为：

- `prune` 和 `clear` 返回 `{ ok, message, removed, remaining }`。
- `cleanup` 立即执行每小时一次的清理（清理什么见[架构](ARCHITECTURE_zh.md#清理与保留期)），返回 `{ ok, message, cleanup: { dryRun, counts, meetings: [{ id, topic, action }], sessions: [{ id, name }] } }`。`counts` 含 `tasksExpired`、`tasks`、`events`、`meetingsExpired`、`meetings`、`messagesExpired`、`messages`、`notices`、`toolUseBindings`、`sessions`、`instances`；会议的 `action` 为 `expire`（关闭）或 `delete`（删除）。有改动的清理记一条 `maintenance.cleanup` 事件，带同样的清单。
- `export` 返回 `{ ok, message, markdown }`：会议的主题、状态、时间和总结，成员（含已离开的）及其机器，决议，以及每条消息的发言人、机器、时间和类别。升级数据库时补填的名字标 `*`。会议不存在时失败。

### `host_delete_project`

永久删除项目及其资产。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 要删除的项目。 |

行为：

- 项目不存在时失败。
- 返回 `{ ok: true, projectId }`。
- 此操作不可逆。
