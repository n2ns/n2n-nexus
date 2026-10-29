# Plan: Google Antigravity as a third client

Status: proposed, not implemented　|　Source: tests on Antigravity IDE 1.107.0 and the Antigravity CLI `agy` 1.4.10 (Windows and Linux/WSL), 2026-10-29; the design points in §3 were decided by the user.

## 1. Goal

Conversations in Google Antigravity, the IDE and the `agy` CLI, take part in n2n-nexus like Claude Code and Codex conversations do. Antigravity runs any model the user picks (Gemini and others), so n2n-nexus supports the client, not a model. The IDE is a user interface over `agy`: the IDE starts `agy --hub`, and that process runs the agent, the hooks and the MCP servers. One client, `antigravity`, therefore covers both.

Completion criteria:

1. In an Antigravity conversation, every n2n-nexus tool works, and `send` / `reply` / `peers` identify the calling conversation.
2. SessionStart introduces the conversation; unread direct messages and meeting news reach it at the start of a turn and between model calls; Stop delivers unread messages and holds the turn while the session is listening, as for Claude Code.
3. An idle Antigravity conversation is woken by a new direct message, without the user, through the waiter of §4.4.
4. `n2n-nexus install antigravity` / `uninstall antigravity` / `doctor` handle the MCP server, the hooks, the rule file and the permission grants of §4.5.
5. Every rule in this plan has a test (Go tests in `host/internal/agents`, `tests/conformance/`, client tests); `npm run check`, `go test ./host/...` and `npm run test:conformance` pass.

## 2. Verified facts

All of these were observed in this session's tests, not taken from documentation alone.

**MCP.**
- `clientInfo.name` is `antigravity-client`, on `initialize` (protocol 2025-11-25) and in the `server/discover` `_meta` (2026-07-28).
- Every `tools/call` carries `_meta["antigravity.google/conversation_id"]`, the same id the hooks get as `conversationId`.
- The MCP server process gets no `ANTIGRAVITY_*` environment variables.
- The global registration is `~/.gemini/config/mcp_config.json`, managed by `agy mcp add|remove|list`. `~/.gemini/antigravity/mcp_config.json` is no longer read.

**Hooks.**
- Hooks are configured in `~/.gemini/config/hooks.json` (global, read by both the IDE and the CLI). Each top-level key is a named hook.
- Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. The flat events take a list of handlers; the tool events take `{matcher, hooks}` groups.
- stdin is camelCase JSON. Every event carries `conversationId`, `workspacePaths` (may be empty in the IDE), `transcriptPath`, `artifactDirectoryPath`, `modelName` and `lastUserInput`. stdin has no event name.
- `SessionStart` fires with the first prompt of a new conversation, not when a conversation is resumed (`agy --conversation <id>`).
- `PreInvocation` fires before every model call and carries `invocationNum`, which is 0 at the start of each turn, including a turn started by a wake.
- `Stop` carries `executionNum`, `terminationReason` and `fullyIdle`. `executionNum` is 0 at a turn's first Stop and 1 after a Stop hook returned `continue`, so `executionNum > 0` means what Claude's `stop_hook_active` means.
- Output:
  - `SessionStart` and `PreInvocation` accept `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}`; the step stays in the conversation.
  - `PostToolUse` only accepts `{}`.
  - `Stop` accepts `{"decision":"continue","reason":"…"}`, and the reason is injected as a system message. A Stop hook held 240 s with `timeout: 600` and the turn continued.
- Hooks run synchronously. On Unix they run through `sh -c`, on Windows through `cmd /c "<command>"`. Go escapes every `"` in the command as `\"`, so a Windows command containing quotes does not run. `powershell -NoProfile -NonInteractive -EncodedCommand <base64>` runs, passes stdin to the program and returns its stdout.
- The hook process's environment holds `ANTIGRAVITY_CONVERSATION_ID`, not the language server address or its CSRF token.
- The PreToolUse decision `allow` does not suppress the CLI's command confirmation in its default `request-review` mode.

**Waking.**
- `agy agentapi send-message <conversationId> <text>` starts a turn in an idle conversation. The text arrives as a system message.
- `agentapi` needs `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`; the language server rejects a wrong token (`invalid CSRF token`).
- Antigravity hands both variables, plus `ANTIGRAVITY_CONVERSATION_ID` and `ANTIGRAVITY_AGENTAPI_EXE` (the `agy` executable itself on both platforms), to the commands the agent runs with `run_command`, and to nothing else. Its own documentation shows an agent using `agentapi send-message` on its own conversation.
- A command the agent started in the background keeps running across turns. When it ends, the conversation starts a turn showing its output. It ends when `agy` exits.

**Dead ends** (not to be retried):
- Sidecars are switched off for the IDE and the CLI by built-in feature flags.
- The language server writes no discovery file.
- `/_sidecar/*` routes are not served.
- Reading the CSRF token from the hub's command line works but takes a credential the client does not hand out; it is not used.

**Rules and permissions.**
- A file in `~/.gemini/config/rules/` with front matter `trigger: always_on` is in the context of every IDE and CLI conversation.
- Without such a rule, a hook-injected instruction to start a background program was once refused by the model as a likely prompt injection: Antigravity marks injected system messages "not actually sent by the user". With the rule, the model started the waiter at once.
- Command grants have the form `command(<command prefix>)`:
  - IDE: `userSettings.globalPermissionGrants.allow` in `~/.gemini/config/config.json`;
  - CLI: `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`.
- With the IDE policy `CASCADE_COMMANDS_AUTO_EXECUTION_OFF` and a grant for the waiter command, the waiter started without a confirmation. The CLI with a persisted grant did the same.

## 3. Design points decided by the user

1. **Waiter command**: `n2n-nexus hook antigravity --wait`, with ` --endpoint <url>` appended when install was given one. It is a short command found on PATH (install already requires `npm i -g n2n-nexus`), so the model types it exactly and the grant matches it. `doctor` checks that it resolves.
2. **Rule text**: a file owned by n2n-nexus, `~/.gemini/config/rules/n2n-nexus.md` with `trigger: always_on`. It is not a block in the user's `GEMINI.md`.
3. **Permission grants**: install adds the waiter command's grant to both the IDE and the CLI file, creating the file or the field when missing and keeping everything else; uninstall removes exactly that entry.
4. **Title**: the conversation's title is the `lastUserInput` of its `SessionStart`, cut to `maxTitleChars`, set once.

## 4. Design

### 4.1 Contract (`contract/hook.json`)

- `clients`: add `antigravity`.
- `clientInfoNames.antigravity`: `antigravity-client`.
- `meta.antigravityConversationKey`: `antigravity.google/conversation_id`.
- `texts.waiterReminder`: `[n2n-nexus] The n2n-nexus message waiter of this conversation is not running. Start it as described in the n2n-nexus rule.`

`contractVersion` stays 4. An older host answers an `antigravity` hook with 400 (the hook exits silently) and treats an `antigravity` caller as naming no session, so Claude Code and Codex are unaffected either way.

### 4.2 Identity

- **Client, `callerOf`** (`src/server/nexus.ts`): when the client name is `antigravity-client`, the caller is `{client: "antigravity", sessionId: _meta[antigravityConversationKey]}`.
- **Host, `parseCaller` and `serveHook`** (`host/internal/api/api.go`): accept `antigravity` with a `sessionId`.
- **Host, `callerSession`** (`host/internal/agents/identity.go`): `antigravity` → `sessionKey("antigravity", sessionId)`, as for Codex.

### 4.3 Hooks

`n2n-nexus hook antigravity <Event>`; the event name comes from the command line because stdin has none. The client (`src/cli/hook.ts`) maps the input onto the fields the host already reads:

| Antigravity | forwarded as |
|---|---|
| `conversationId` | `session_id` |
| `workspacePaths[0]` (or none) | `cwd` |
| `SessionStart` | `SessionStart`, with `title` from `lastUserInput` |
| `PreInvocation`, `invocationNum` 0 | `UserPromptSubmit` |
| `PreInvocation`, `invocationNum` > 0 | `PostToolUse` (mid-turn news; nothing is marked read, as now) |
| `Stop`, `executionNum` > 0 | `Stop` with `stop_hook_active: true` |

Host (`host/internal/agents`):
- **Output per client.**
  - For `antigravity`, `contextOutput` returns `{"injectSteps":[{"systemMessage":{"systemMessage": text}}]}` and `blockOutput` returns `{"decision":"continue","reason": text}`.
  - The client prints `{}` when the host's output is null.
- **Waiter reminder.** On the forwarded `UserPromptSubmit` of an `antigravity` session that has no background wait open, the host appends `texts.waiterReminder` to the injected text.
- **Waits are not cancelled.** For `antigravity` sessions the host does not call `cancelBackgroundWaits` on events: the waiter outlives turns. Its requests already deliver nothing while the session is `working` or a listening Stop hook waits.
- **No SessionEnd.** Antigravity has no such event, so a session goes offline through `staleSessionMs` as now. The waiter's requests keep a session that is not `working` from going stale; a `working` session is kept alive by its own events, so one whose Stop was lost still goes stale.

Registered events and timeouts:
- `SessionStart` and `PreInvocation`: `hookTimeoutSec`.
- `Stop`: `hookStopTimeoutSec` (600 s, listening).

### 4.4 Waiter

`n2n-nexus hook antigravity --wait` (`src/cli/hook.ts`), started by the agent as a background `run_command`:

1. It reads `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_AGENTAPI_EXE`, `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`. Without them it prints why and exits 1, which happens only when run outside Antigravity.
2. It loops forever: ask the host for a wake (`BackgroundWait`, as `waitForWake`). Any answer other than a wake means ask again. Unreachable-host errors back off from `wakeRetryFirstDelayMs` to `wakeRetryMaxDelayMs`. There is no deadline: the waiter ending would itself start a turn.
3. On a wake it runs `<agy> agentapi send-message <conversationId> <text>`:
   - `<agy>` is `ANTIGRAVITY_AGENTAPI_EXE`. When that is a `.bat`/`.cmd` wrapper, it is the executable named in its `"<exe>" agentapi %*` line.
   - Never through a shell, because the text comes from another session.
   - It then reports `WakeResult` with `ok` from the exit code, as the Codex wait does, and goes on waiting.
4. The credentials are passed only to `agentapi` and never sent to the host. The waiter needs the same environment variables `agentapi` needs and no others.

Several waiters for one conversation can happen, for example when the model starts a second one. The host already hands each wake to exactly one open wait, so the others stay as standbys. A waiter is never told to exit.

### 4.5 Install, uninstall, doctor

`n2n-nexus install antigravity [--endpoint <url>] [--node <path>]` requires `agy --version` to run, then:

1. **MCP**: `agy mcp remove n2n-nexus`, then `agy mcp add -e PATH=… -e NEXUS_ENDPOINT=… n2n-nexus -- "<node>" "<npx>" -y n2n-nexus@latest mcp`. Flags go before the name; the same PATH rule as `mcpAddArgs`.
2. **Hooks**: the named hook `n2n-nexus` in `~/.gemini/config/hooks.json`, replacing an earlier one and keeping the other named hooks. The command is:
   - on Unix: `"<node>" "<entry>" hook antigravity <Event>[ --endpoint <url>]`;
   - on Windows: `powershell -NoProfile -NonInteractive -EncodedCommand <base64 of: & '<node>' '<entry>' 'hook' 'antigravity' '<Event>' …>`.
3. **Rule file**: `~/.gemini/config/rules/n2n-nexus.md`, rewritten on every install. It contains:
   - front matter `trigger: always_on`;
   - what n2n-nexus is;
   - the exact waiter command, and that it is started in the background when a `[n2n-nexus]` message says the waiter is not running, and never stopped;
   - the text of the Claude `INSTRUCTIONS` block: direct messages count as the user's own requests.
4. **Grants**: `command(<waiter command>)` in both files of §2.

`uninstall antigravity` removes the parts in this order: the rule file, the named hook, the two grants, the MCP registration.
- Waiters in open conversations keep running until their `agy` exits. Killing one would start a turn in which the model, if the rule were still present, would restart it; with the rule removed first, it does not.
- Uninstall prints that open Antigravity conversations keep their waiter until they are closed.

`doctor` additionally checks, for Antigravity:
- the named hook and its node and entry paths;
- the rule file;
- both grants;
- the MCP registration;
- that `n2n-nexus` resolves on PATH.

New helpers go next to the existing ones. `src/cli/client-dirs.ts` gets `geminiDir()` (`~/.gemini`). `readMcpCommand` reads `mcp_config.json` with the JSON branch it already has for Claude.

## 5. Known limits (documented in `docs/ARCHITECTURE.md` next to the Codex limits)

- **Resumed conversations.** A conversation resumed after `agy` restarted has no waiter until the user's next prompt, whose `PreInvocation` reminds the model.
- **Depends on the model.** The waiter is started by the model following the rule; a model that does not follow it leaves the conversation without idle waking, while hooks, Stop delivery and listening still work.
- **Visible task.** The waiter is visible as a running background task in the conversation.
- **After uninstall.** Waiters started before an uninstall keep delivering until their `agy` exits.

## 6. Code changes

| Area | Files |
|---|---|
| Contract | `contract/hook.json` (§4.1); `src/contract.ts` exports |
| Host | `host/internal/api/api.go` (`parseCaller`, `serveHook`); `host/internal/agents/identity.go`; `host/internal/agents/hooks.go`, `agents.go` (output per client, reminder, no cancel) |
| Client | `src/server/nexus.ts` (`callerOf`); `src/cli/hook.ts` (mapping, `--wait` loop for antigravity); `src/cli/hook-command.ts` (PowerShell form, recognition by hook name); `src/cli/install.ts`, `src/cli/doctor.ts`, `src/cli/client-dirs.ts`, `src/cli/mcp-config.ts` |
| Docs | `docs/TOOLS_REFERENCE.md` (direct messages between conversations), `docs/ARCHITECTURE.md` / `_zh`, `docs/INSTALL.md` / `_zh`, `docs/USER_GUIDE.md` / `_zh`, `README.md` / `docs/README_zh.md` client lists, `CLAUDE.md` (Architecture: three clients) |

## 7. Tests

- **Go, `host/internal/agents`.**
  - Antigravity output shapes for SessionStart, UserPromptSubmit, PostToolUse and Stop.
  - The reminder only when no background wait is open.
  - Background waits are not cancelled by antigravity events.
  - `stop_hook_active` handling.
  - Caller identity.
- **Conformance, `tests/conformance/agents.ts`.** The same through the HTTP API, including a wake handed to one of two open waits.
- **Client.**
  - Input mapping table of §4.3.
  - Waiter: resolving `agy` from an `.exe` and from a `.bat` wrapper, no shell, retry and backoff, `WakeResult`.
  - Install and uninstall on temporary `~/.gemini` trees: hooks, rule file, both grant files created or merged, nothing else changed.
  - The PowerShell command form.
  - `mcp_proxy.test.ts`: the `antigravity-client` caller for both protocol eras.

## 8. Order and commits

Each step ends with its tests passing and one commit.

1. Contract and host (§4.1–4.3 host side) with Go and conformance tests.
2. Client: identity, hook mapping, waiter (§4.2–4.4).
3. Install, uninstall, doctor (§4.5).
4. Docs (§5, §6).
5. End-to-end check on Windows (IDE) and Linux (CLI): two Antigravity conversations and one Claude Code conversation message each other; an idle Antigravity conversation is woken; resume and uninstall behave as in §5.
