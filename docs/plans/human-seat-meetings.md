# 方案：人类参会的会议

状态：已定稿，待实施　｜　来源：会议 20261028221356-ius6uuex-7bch（6 个决策点全部由用户定，决议 #8、#15、#26、#39、#60、#64、#72、#83）

## 1. 目标

纯 AI 会议会产生脱离实际的决议（dac6 里"会议 90 天删除"是第一个发言者顺手给的数，全员沿用、全票通过，没有人校验）。需要第二种会议：人参会，机制不复杂。人坐在哪个终端前，就用那个会话入座；决议只有人批准才成立；人有一票否决权。

完成标准：

1. 有用户席位的会议里，AI 全体 endorse 不产生决议，只有席位 endorse 产生 DECISION；席位 object 使当前草案作废。
2. 发送会议消息和表态时，host 按读取游标检查未读，按本方案的规则拒绝或放行。
3. 会议通知带正文，按私信的 `notifyTextChars` 规则截断。
4. `docs/ASSISTANT_GUIDE*.md` 有第 6 节的全部起草规则。
5. 本方案列出的每条边界都有测试；`npm run check`、`go test ./host/...`、`npm run test:conformance` 通过。

## 2. 决策点 1：用户席位（#15）

- `start_meeting` / `join_meeting` 加可选参数 `seat: "user"`。
- 同一时刻只有一个席位。另一个会话以 `seat: "user"` 加入即接管；旧席位会话变成普通成员，保留原来的 active / async 模式，不离开会议；host 发一条会议消息"用户席位已由 X 转到 Y"。
- 席位会话对当前草案的表态和它的 `end_meeting` 是用户的决定；host 在这两处校验调用方是当前席位。
- 席位会话的发言在会议消息里显示为"用户席位（由 X 代理）"，不加每条消息的标记。
- 席位会话不在 AI 审批人名单里："AI 已达成共识"只统计席位以外的必需审批人。
- 用户有一票否决权：席位对当前草案的 `object` 使草案作废，不论 AI 怎么表态；没有席位批准，任何草案都不会成为决议。

数据：`meetings` 表加 `seat_member_id TEXT`（当前席位会话 id，NULL 为无席位）和 `had_seat INTEGER NOT NULL DEFAULT 0`（有过席位，席位会话被清理后仍保留，#68）。

## 3. 决策点 2：结束与共识（#26）

- 席位 endorse 当前草案：host 一步完成——校验席位和稿号 → 记录 → 发 DECISION（草案原文 + 席位说明；批准时仍有 AI 异议的，如实列出）→ 清掉当前草案。同一稿重复批准不重复生成。
- 决策点编号由席位 AI 写在草案第一行，host 原样带进 DECISION，不加字段。
- AI 共识（席位以外的必需审批人全体 endorse）：成立、失去、恢复时 host 各发一条提示，只在状态变化时发；不关会、不发 DECISION。
- 席位 object 当前草案：host 清掉当前草案，发"第 n 稿已被用户否决：<席位说明>"；不加状态，草案消息留在记录里。
- 结束整场：只有当前席位的 `end_meeting`，`summary` 必填。其他会话的 `end_meeting` 被拒，转成一条"提议结束：<它的 summary>"消息。
- 没有席位的会议维持现有规则（共识即关闭）。

## 4. 决策点 3：反对与改口（#39）

- `stance` 的 `object`，以及改变立场的 `stance`，说明里必须有至少一处可定位依据：本会议存在的 `#n`、文件路径、URL，或以"实测："/"文档："/"数据："开头的一句。host 只查格式和 `#n` 是否存在，不查真假；缺了拒绝并提示要什么。
- 改口不要求引用比上次表态更新的消息。
- 同一份草案上每个会话最多改变立场 2 次；第 3 次拒绝并提示"本稿立场已固定，有新依据请在发言里说明，等下一稿"。`withdraw` 不计入、不被锁。数字 2 只有 dac6 和本场的数据支持，以后按数据调整。
- 只管 `stance`，不检测普通发言。
- 被拒的 `stance` 和发言不计任何次数。
- 席位会话的 `object`（转达用户否决）不受依据检查和次数上限约束。

数据：`meeting_stances` 加 `changes INTEGER NOT NULL DEFAULT 0`（该会话在该草案上改变立场的次数）。

## 5. 决策点 4：发言前的未读检查与通知正文（#60、#64）

- `send_message` 到会议：调用方游标之后还有别人的消息时拒绝，返回里附上这些消息（消息号、发言人、类别、正文，合计按 `notifyTextChars` 截断并提示 `read_messages`），游标移到附回的最后一条完整消息；没附回的不移。被拒的发言不进记录。
- `stance`：同一检查，另要求当前草案在已读范围内。`withdraw` 和席位的 `object` 不被拦，只附未读提示。
- 判断只用 host 的读取游标；`latest` / `afterId` 历史模式不移游标、不算读过。
- 被拒之后的下一次 `send_message` 放行，host 在消息末尾附一行"发出时已有 #a–#b 未读"；游标只移到已连续完整交付的最后一条，附注的号段本身不算交付。host 只记"上次是否被拒"一个标记。只用于普通发言，`stance` 不放宽。
- 会议通知（Stop / listening 唤醒 / PostToolUse）像私信一样带每条消息的正文，合计超过 `notifyTextChars` 则截断并提示续读。是否算已读照搬私信：Stop / listening / 唤醒送达的算已读、移游标；PostToolUse 送达的不移。拒绝附回的消息记为已交付后，该次发送的 PostToolUse 钩子不再推同一批。

数据：`meeting_members` 加 `last_send_refused INTEGER NOT NULL DEFAULT 0`。

## 6. 决策点 5：席位与清理（#72）

用户原话："人类参会的时候, 会议会在人类的参与下正常结束, 人类临时离开的时候, 需要的是等人类回来继续, 人类要关机休息, 停止工作, 会议也是在人类指令下结束的. 只有特殊情况, 比如会议中途, 电脑死机,停电, 会议没有正常结束"。

1. 正常结束：只有席位的 `end_meeting`。AI 的 `end_meeting` 始终转"提议结束"；AI 共识不关会。
2. 人临时离开：会议什么都不做。席位会话离线与否不改变任何规则；不设"空缺"、不设期限、不存状态、不发离线提示。人回来在任一终端 `seat: "user"` 加入即接管。
3. 异常中断：唯一的兜底是 TODO 里已定的"连续 `meetingRetentionDays` 无发言 → expired"，只关闭并保留记录到清理期，不出决议。它是事故后的清理，不是结束方式。
4. 明确不做：角色切换、awaiting-user 等新状态、每条消息标记、"用户已读到 #n"、赞成必须写依据。

## 7. 决策点 6：起草规则（#83，只改 `docs/ASSISTANT_GUIDE*.md`）

- 数字参数：草案里每个数字后面必须跟"来源：#n / 文件 / 实测"或"待用户定（影响：…）"，席位 AI 发草案前自查；普通发言里提数字时写来源，没有就写"无依据，仅作例子"。用户已定的标"用户已定，见 #n"。文件里原有的数字、消息编号不算新参数。
- 依据等级（实证 / 引用 / 推理 / 跟随）只作 endorse 说明里的可选写法；host 不做字段、解析或提示。
- 席位 AI：拆 3–6 个决策点（默认范围），第 0 点是拆分本身，把开场已有意见归到对应点；每点草案第一行"决策点 k/N：标题"，改稿时第一行"替换 #n，改了：…"；转述用户用「用户原话：…」，批准、否决、结束时引用原话并指明稿号；自己的看法用普通发言并注明"这是我的意见，不是用户的"；请用户批准前先看 `stance` 返回的当前表态并转述分歧；重新入座时先复述中断前的进度；`summary` 固定三段：定了什么、没定什么（含"未定：第 k 点"）、接下来谁做什么。
- 普通参会 AI：每点最多两次发言；会议里用 unread 模式读；被拒后按附回内容重新考虑，不原样重发；改观点写"改为同意 #n，撤回 #m 的某某，依据 …"；object 的说明用"事实：… / 结论：…"。
- 汇总：保留不同方案、依据和代价，不用票数代替用户取舍；不把"全员赞成"写成"已验证"。
- 无席位的会议同样适用数字规则；"待用户定"的数字随 DECISION 列为"交用户定"事项。主持人发最终提案时末尾附三个是/否——有没有"待用户定"的数字；决定是否不可逆（删数据、改契约、发布）；收敛前有没有反对或改口——任一为"是"就在提案开头标"建议用户审阅"。

## 8. 代码改动清单

| 处 | 改动 |
|---|---|
| `contract/tools.json` | `start_meeting` / `join_meeting` 加 `seat`；`send_message`、`stance` 的描述写明未读检查和拒绝返回（返回加 `unread` 数组、`refused: true`）；`list_meetings` 的 meeting 加 `seat`、`hadSeat`；`stance` 的 approvals 加 `seat` |
| `contract/hook.json` | 会议通知文本改为带正文的格式（`meetingNews` 改为每条一段，加截断提示） |
| `host/internal/store/migrations/0005_meeting_seat.sql` | `meetings.seat_member_id`、`meetings.had_seat`；`meeting_stances.changes`；`meeting_members.last_send_refused` |
| `host/internal/core/meetings.go` | `seat` 参数、接管、席位消息、`end_meeting` 的席位校验与"提议结束" |
| `host/internal/core/stances.go` | 依据格式检查、改口计数、席位 endorse → DECISION、席位 object → 清草案、共识提示的状态变化 |
| `host/internal/core/messages.go` | 发送前未读检查、拒绝附回、放行附注、游标推进规则 |
| `host/internal/agents/meetings.go` | 会议通知带正文，已读规则照私信 |
| `docs/ASSISTANT_GUIDE*.md`、`docs/TOOLS_REFERENCE*.md` | 第 7 节的规则；工具行为 |

契约版本升 1（host 和客户端一起升级）。

## 9. 测试

Go（`host/internal/core`、`host/internal/agents`）与 conformance 各覆盖：席位接管与旧席位降为成员；非席位 `end_meeting` 被拒并转提议；席位 endorse 生成 DECISION 且重复批准不重复；席位 object 清草案；共识提示只在状态变化时发；object 无依据拒绝、改口第 3 次拒绝、withdraw 不计数、席位 object 不受限；发送有未读被拒并附回、游标推进到最后一条完整消息、下一次放行并附注、`stance` 要求草案已读；通知带正文与截断、PostToolUse 不移游标；无席位会议行为不变；席位会话被清理后 `had_seat` 仍为 1。

## 10. 实施顺序与待定

1. 第 5 节（未读检查、通知正文）先做，它对无席位会议也生效。
2. 第 2–4、6 节（席位）。
3. 第 7 节（GUIDE）与前两步同一版本发布。

每步按高风险走独立评审。待用户定：版本号。（0.11.0 库里已有记录的快照已定为按迁移时的会话补填，随清理机制在 `0004_retention.sql` 实现。）
