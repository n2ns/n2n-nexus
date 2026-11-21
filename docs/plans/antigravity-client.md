# Plan: Google Antigravity as a fourth client

Status: implemented (§8 phases 1–4, 2026-11-21); end-to-end acceptance (§7.2) outstanding　|　Last evidence update: 2026-11-20　|　Current capability probes: agy 1.5.13, Linux/WSL CLI. Historical evidence: IDE 1.107.0 and agy 1.4.10, 2026-10-29. See §2 for the distinction; §3 preserves the user-decided design points.

## 1. Goal

Conversations in Google Antigravity, the IDE and the `agy` CLI, take part in n2n-nexus like Claude Code, Codex and pi conversations do. Antigravity runs any model the user picks (Gemini and others), so n2n-nexus supports the client, not a model. Use one protocol client, `antigravity`, for the CLI and IDE. Current CLI capability evidence and the separate Windows/IDE acceptance requirement are recorded in §2.

Completion criteria:

1. In an Antigravity conversation, every n2n-nexus tool works, and `send` / `reply` / `peers` identify the calling conversation.
2. SessionStart introduces the conversation; unread direct messages and meeting news reach it at the start of a turn and between model calls; Stop delivers unread messages and holds the turn while the session is listening, as for Claude Code.
3. An idle Antigravity conversation is woken by a new direct message, without the user, through the waiter of §4.4.
4. `n2n-nexus install antigravity` / `uninstall antigravity` / `doctor` handle the MCP server, the hooks, the rule file and the permission grants of §4.5.
5. The existing database upgrades without losing sessions or their references. Every behavior in this plan has coverage in §7; `npm run check`, `go vet ./...`, `go test ./host/...` and `npm run test:conformance` pass. CLI and Windows/IDE end-to-end results are reported separately.

## 2. Evidence and verification boundary

### 2.1 Current CLI evidence: 2026-11-20

The probes ran against `agy --version` = `1.5.13` on Linux/WSL, using an isolated workspace MCP server, workspace hooks and rules, and invocation-only settings. They exercised Antigravity's capabilities, not an implemented n2n-nexus adapter. The command tests used a per-invocation sandbox-disabled setting and a command allow rule; they do not establish compatibility with users' sandbox policies. Installation must preserve those policies.

| Area | Observed result |
|---|---|
| MCP identity | `clientInfo.name` was `antigravity-client`. Calls carried `_meta["antigravity.google/conversation_id"]`, matching the hook's `conversationId` in two distinct conversations. Some calls also carried `antigravity.google/root_conversation_id`; identity must use the conversation key, not the root key. |
| Environment | The MCP process had none of the four variables listed in §4.4. Hooks had `ANTIGRAVITY_CONVERSATION_ID`, but not the language server address, CSRF token or agentapi executable. Commands started by the model received all four. Only presence booleans were recorded; credentials were not printed or persisted. |
| Hook input | CamelCase JSON included `hookEventName`, `cwd`, `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName` and `lastUserInput`. The earlier statement that stdin has no event name no longer describes 1.5.13. |
| Turn boundaries | `PreInvocation.invocationNum` was 0 at the start of user and externally woken turns. Subsequent invocations in a turn increased it. |
| Resume | Interactive `--conversation <id>` resumed without SessionStart. A `stream-json` invocation with the same option did emit SessionStart. Recovery must work through PreInvocation and must not require SessionStart. |
| Hook output | SessionStart and PreInvocation accepted `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}`. Stop accepted `{"decision":"continue","reason":"…"}`; continuation also worked after holding a Stop for 12 seconds. PostToolUse accepted `{}`. |
| Stop state | `executionNum` changed from 0 to 1 after Stop continuation, while `continuationActive` remained false. `fullyIdle` remained false while the permanent waiter ran, including when the model had finished its turn. Neither field replaces `executionNum` or the host's turn state. |
| Wake | `agy agentapi send-message <conversationId> <text>` injected a system message and began a turn without new user input. A wrong token was rejected with `invalid CSRF token` and exit code 1. |
| Waiter lifecycle | A background command survived turns. A workspace rule with `trigger: always_on` plus a PreInvocation reminder started it automatically, including after interactive resume. Normal CLI exit ended its waiter and MCP child. Ending the waiter itself started another model turn. |
| Streaming output | With a live background command, the observed `stream-json` output buffered later updates until the command completed. Hook events and the transcript established that the woken turns had already run. |

The initial capability probes completed two stream-json idle wakes and two wakes after interactive resume, including MCP calls after waking. A subsequent diagnostic repeated the same first-wake prompt in two fresh interactive conversations with `gemini-3.8-flash-high`:

| Diagnostic | First wake, through MCP call and reply | Second wake, through MCP call and reply |
|---|---:|---:|
| Original PTY handling | 13.14 s | 7.97 s |
| PTY with cursor-position query responses enabled | 11.39 s | 7.00 s |

Neither diagnostic received a cursor-position query. These four successes do not reproduce a fixed first-wake failure and provide no evidence for terminal-query blocking. The durations are observations, not a latency guarantee.

One earlier interactive wake had reached PreInvocation but produced no visible reply before the test was interrupted after approximately 158 seconds. Its model-response record reported `output_tokens: 18320`, empty visible content and no tool calls; the subsequent error was `The stream was interrupted`. This locates the delay in model generation after message acceptance. It does not establish why that generation took so long or guarantee that it will not recur. A successful agentapi exit is an acceptance receipt, not proof that the model has completed the requested work.

### 2.2 Historical evidence: 2026-10-29

The original probes used Antigravity IDE 1.107.0 and agy 1.4.10 on Windows and Linux/WSL. Keep these as historical inputs to the design; the November CLI probes did not revalidate current Windows or IDE behavior:

- The IDE launched `agy --hub` to run the agent, hooks and MCP servers.
- MCP identity was observed with both `initialize` (2025-11-25) and `server/discover` metadata (2026-07-28). The November probes did not separately pin both protocol eras.
- Global MCP registration used `~/.gemini/config/mcp_config.json`; `~/.gemini/antigravity/mcp_config.json` was not read. Global named hooks used `~/.gemini/config/hooks.json`. Flat events used handler arrays; tool events used `{matcher, hooks}` groups. November probes exercised workspace `.agents/mcp_config.json` and `.agents/hooks.json` instead.
- A Stop held for 240 seconds with `timeout: 600` continued the turn. PostToolUse did not accept context injection, so this design delivers mid-turn news through PreInvocation.
- Windows hooks ran through `cmd /c`, with quoted commands failing under the observed escaping. `powershell -NoProfile -NonInteractive -EncodedCommand <base64>` passed stdin and stdout successfully. Retain that command form and revalidate it on Windows.
- Global rules under `~/.gemini/config/rules/` used `trigger: always_on`. A rule resolved a model refusal to start the waiter from an injected reminder alone.
- IDE grants used `userSettings.globalPermissionGrants.allow` in `~/.gemini/config/config.json`; CLI grants used `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. `command(<command prefix>)` allowed waiter startup without a confirmation. A PreToolUse `allow` decision alone did not suppress command confirmation.
- Sidecars were unavailable to the tested IDE/CLI, no language-server discovery file was found, and `/_sidecar/*` routes were not served. These are version-scoped observations, not claims about every current Antigravity surface. This design uses the model-started waiter and does not depend on sidecars or extracting credentials from process command lines.

### 2.3 Acceptance still required

The CLI probes do not constitute acceptance of the n2n-nexus implementation. Database upgrades, protocol schemas, host BackgroundWait/WakeResult behavior, retry and reconnection, duplicate waiters, installer/uninstaller/doctor, both MCP protocol eras and the existing three clients still require the automated checks in §7. Current Windows/IDE behavior, the installed global rule and grants, and execution under the user's normal permission policy require separate end-to-end acceptance. No implementation, deployment or release is authorized by this document update.

## 3. Design points decided by the user

1. **Waiter command**: `n2n-nexus hook antigravity --wait`, with ` --endpoint <url>` appended when install was given one. It is a short command found on PATH (install already requires `npm i -g n2n-nexus`), so the model types it exactly and the grant matches it. `doctor` checks that it resolves.
2. **Rule text**: a file owned by n2n-nexus, `~/.gemini/config/rules/n2n-nexus.md` with `trigger: always_on`. It is not a block in the user's `GEMINI.md`.
3. **Permission grants**: install adds the waiter command's grant to both the IDE and the CLI file, creating the file or the field when missing and keeping everything else; uninstall removes exactly that entry.
4. **Title**: the conversation's title is the `lastUserInput` of its `SessionStart`, cut to `maxTitleChars`, set once.

## 4. Design

### 4.1 Contract and database

In `contract/hook.json`:

- `clients` and `schemas.hookRequest.properties.client.enum`: add `antigravity`.
- `schemas.caller.oneOf`: add `{client: "antigravity", sessionId: string}` with a nonempty session ID; `schemas.toolCall` already references this schema.
- `clientInfoNames.antigravity`: `antigravity-client`.
- `meta.antigravityConversationKey`: `antigravity.google/conversation_id`.
- `texts.waiterReminder`: `[n2n-nexus] The n2n-nexus message waiter of this conversation is not running. Start it as described in the n2n-nexus rule.`

In `contract/tools.json`, extend the three profile `client` enums: `peers.self`, `peers.peers[]` and `set_profile.profile`. Update the client lists and session-ID examples in tool descriptions and `texts.noAgentSessionError`. In `src/contract.ts`, extend the `HOOK_CLIENTS` tuple and `Caller` union, and export the metadata key and reminder text where consumed. Add `WaiterReminder` to the typed `Hook.Texts` in `host/internal/protocol/protocol.go` so the host can read the new contract text.

Add `host/internal/store/migrations/0011_antigravity_client.sql`. The current `0009_pi_client.sql` restricts `agent_sessions.client` to `claude`, `codex`, and `pi`. Rebuild `agent_sessions` using the same copy/drop/rename/index pattern, retaining every column (including `stale_from` from `0010_session_stale_from.sql`) and adding `antigravity` to the CHECK constraint. Use the existing migration runner's transaction and foreign-key check; do not edit applied migrations or reset user data. Verify preservation of sessions and all referencing rows in `host/internal/store/migrate_test.go`.

`contractVersion` stays at the existing value 5 under this additive design. Compatibility must be checked in §7; Antigravity itself requires the updated host and client. An older host answers an `antigravity` hook with 400 (the hook exits with code 0, nothing on stdout and one line on stderr) and treats an `antigravity` caller as naming no session, so Claude Code, Codex and pi are unaffected either way.

### 4.2 Identity

- **Client, `callerOf`** (`src/server/nexus.ts`): when the client name is `antigravity-client`, the caller is `{client: "antigravity", sessionId: _meta[antigravityConversationKey]}`.
- **Host, `parseCaller` and `serveHook`** (`host/internal/api/api.go`): accept `antigravity` with a `sessionId`.
- **Host, `callerSession`** (`host/internal/agents/identity.go`): `antigravity` → `sessionKey("antigravity", sessionId)`, as for Codex.

### 4.3 Hooks

`n2n-nexus hook antigravity <Event>` keeps the explicitly registered event argument as the event source for both historical and current payloads; 1.5.13 also supplies `hookEventName` on stdin. Normalize the event before choosing the Stop timeout or retry path, which currently reads `stdin.hook_event_name`. The client (`src/cli/hook.ts`) maps the input onto the fields the host already reads:

| Antigravity | forwarded as |
|---|---|
| `conversationId` | `session_id` |
| First nonempty `workspacePaths[0]`, then `cwd` when the list is empty; otherwise omit | `cwd` |
| `SessionStart` | `SessionStart`, with `title` from `lastUserInput` |
| `PreInvocation`, `invocationNum` 0 | `UserPromptSubmit` |
| `PreInvocation`, `invocationNum` > 0 | `PostToolUse` (mid-turn news; nothing is marked read, as now) |
| `Stop` | `Stop`, with `stop_hook_active` set from `executionNum > 0` |

Keep `input.machine = machineInfo()` on real forwarded events. Supply the SessionStart title directly from `lastUserInput` and do not send Antigravity through the existing Claude/Codex title-file readers in `src/cli/title.ts`. Repeated SessionStart events must not replace an already initialized Antigravity title or a title set with `set_profile`; retain the set-once decision in §3. Do not interpret `continuationActive` as `stop_hook_active`, or `fullyIdle: false` as proof the model is working.

Host (`host/internal/agents`):
- **Output per client.**
  - Pass the client through both immediate Stop delivery in `hooks.go` and held listening-Stop delivery in `agents.go`; for `antigravity`, `contextOutput` returns `{"injectSteps":[{"systemMessage":{"systemMessage": text}}]}` and `blockOutput` returns `{"decision":"continue","reason": text}`.
  - The client prints `{}` when the host's output is null.
- **Waiter reminder.** On the forwarded `UserPromptSubmit` of an `antigravity` session that has no background wait open, including the first prompt after resume without SessionStart, the host appends `texts.waiterReminder` to the injected text. A turn a wake just began gets no reminder: the waiter that delivered the wake is alive and asks again after reporting it.
- **Waits are not cancelled.** For `antigravity` sessions the host does not call `cancelBackgroundWaits` on events: the waiter outlives turns. Its requests already deliver nothing while the session is `working` or a listening Stop hook waits; they also deliver nothing while one of the session's own hook events is handled, so what that event's expiry check finds reaches the event. A SessionStart with an open wait leaves the session `listening`.
- **No SessionEnd.** Antigravity has no such event, so a session goes offline through `staleSessionMs` as now. The waiter's requests keep a session that is not `working` from going stale; a `working` session is kept alive by its own events, so one whose Stop was lost still goes stale.

Registered events and timeouts:
- `SessionStart` and `PreInvocation`: `hookTimeoutSec`.
- `Stop`: `hookStopTimeoutSec` (600 s, listening).

### 4.4 Waiter

`n2n-nexus hook antigravity --wait` (`src/cli/hook.ts`), started by the agent as a background `run_command`:

1. It reads `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_AGENTAPI_EXE`, `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`. Without them it prints why and exits 1, without printing their values. Missing variables are a startup failure, not proof that a command was run outside Antigravity.
2. It loops forever: ask the host for a wake (`BackgroundWait`, as `waitForWake`). A held-request timeout starts the next wait. A null result (for example, a session not yet registered with a newly discovered host) and unreachable-host errors use backoff from `wakeRetryFirstDelayMs` to `wakeRetryMaxDelayMs`, preventing a tight loop while awaiting a real hook to register the session again. There is no deadline: the waiter ending would itself start a turn.
3. On a wake it runs `<agy> agentapi send-message <conversationId> <text>`:
   - `<agy>` is `ANTIGRAVITY_AGENTAPI_EXE`. When that is a `.bat`/`.cmd` wrapper, it is the executable named in its `"<exe>" agentapi %*` line.
   - Never through a shell, because the text comes from another session.
   - It reports `WakeResult` to the endpoint that issued that `dispatchId`, with `ok` from the agentapi exit code, as the Codex wait does, and goes on waiting. After an explicit send failure, apply the same retry backoff before requesting another wake.
   - `ok: true` means agentapi accepted the message. It does not mean that the model replied or completed work. Do not resend an accepted wake just because no reply appears promptly. Keep the host's existing rules for failed reports and real events that have already overtaken a report; an unknown report outcome is not a reason to send the same text again.
4. The credentials are passed only to `agentapi` and never sent to the host. The waiter needs the same environment variables `agentapi` needs and no others.

Several waiters for one conversation can happen, for example when the model starts a second one. The host already hands each wake to exactly one open wait, so the others stay as standbys. A waiter is never told to exit.

### 4.5 Install, uninstall, doctor

`n2n-nexus install antigravity [--endpoint <url>] [--node <path>]` requires `agy --version` to run. Map the protocol client name `antigravity` to executable `agy` for the probe, registration and removal; the current installer runs the protocol client name directly. Extend `src/cli/client-command.ts` for the Antigravity executable/wrapper without changing the existing clients' npm-shim behavior. Then:

1. **MCP**: `agy mcp remove n2n-nexus`, then `agy mcp add -e PATH=… -e NEXUS_ENDPOINT=… n2n-nexus -- "<node>" "<npx>" -y n2n-nexus@latest mcp`. Flags go before the name; retain the PATH construction in `mcpAddArgs`, but add an Antigravity argument-order branch because the current function places flags after the name. Preserve removal-failure handling: inspect the registration file to distinguish an absent entry from a failed removal, rather than calling a nonexistent `agy mcp get`.
2. **Hooks**: the named hook `n2n-nexus` in `~/.gemini/config/hooks.json`, replacing an earlier one and keeping the other named hooks. The command is:
   - on Unix: `"<node>" "<entry>" hook antigravity <Event>[ --endpoint <url>]`;
   - on Windows: `powershell -NoProfile -NonInteractive -EncodedCommand <base64 of: & '<node>' '<entry>' 'hook' 'antigravity' '<Event>' …>`.
3. **Rule file**: `~/.gemini/config/rules/n2n-nexus.md`, rewritten on every install. It contains:
   - front matter `trigger: always_on`;
   - what n2n-nexus is;
   - the exact waiter command, and that it is started in the background when a `[n2n-nexus]` message says the waiter is not running, and never stopped;
   - the text of the Claude `INSTRUCTIONS` block: direct messages count as the user's own requests.
4. **Grants**: `command(<waiter command>)` in both files of §2.2. Preserve all other grants and settings. Do not disable a sandbox, change the model, or change the global permission mode as part of installation.

`uninstall antigravity` removes the parts in this order: the rule file, the named hook, the two grants, the MCP registration.
- Waiters in open conversations keep running until their `agy` exits. Killing one would start a turn in which the model, if the rule were still present, would restart it; removing the rule first prevents future loads of that rule, but already loaded conversation context may remain. Do not kill existing waiters during uninstall.
- Uninstall prints that open Antigravity conversations keep their waiter until they are closed.

`doctor` additionally checks, for Antigravity:
- the named hook and its node and entry paths;
- the rule file;
- both grants;
- the MCP registration;
- that `n2n-nexus` resolves on PATH.

Keep Antigravity-specific named-hook/rule/grant merge and removal helpers next to the existing CLI helpers; do not feed its named-hook object into the Claude/Codex hook-group merger. Extend usage text and the client-name map in install, hook and doctor. `src/cli/client-dirs.ts` gets `geminiDir()` (`~/.gemini`). `readMcpCommand` reads `mcp_config.json` with the JSON branch it already has for Claude.

## 5. Known limits (to document in `docs/ARCHITECTURE.md` and its Chinese counterpart during implementation)

- **Resumed conversations.** A conversation resumed after `agy` restarted has no waiter until a prompt runs PreInvocation and the model starts it. Merely opening a resumed conversation does not establish reachability. SessionStart is not a recovery prerequisite.
- **Depends on the model.** The waiter is started by the model following the rule; a model that does not follow it leaves the conversation without idle waking, while hooks, Stop delivery and listening still work.
- **Visible task.** The waiter is visible as a running background task, so `fullyIdle` can stay false after a model turn ends. Stream-json consumers must not use delayed stdout updates as proof that no turn ran.
- **Model response latency.** Delivery acceptance and model completion are separate. The long-generation observation in §2.1 does not justify a first-wake workaround, an automatic duplicate send or a model-setting change.
- **After uninstall.** Waiters started before an uninstall keep delivering until their `agy` exits.

## 6. Code changes

Implemented on 2026-11-21 in these files; the Antigravity installer helpers are in `src/cli/antigravity.ts`, and the Antigravity caller tests in `tests/adapter_identity.test.ts` (both protocol eras).

| Area | Files and responsibility |
|---|---|
| Contract | `contract/hook.json` client list, request/caller schemas, metadata, texts; `contract/tools.json` profile enums and descriptions; `src/contract.ts` types and exports |
| Storage | New `host/internal/store/migrations/0011_antigravity_client.sql`; migration regression in `host/internal/store/migrate_test.go` |
| Host | `host/internal/protocol/protocol.go` typed reminder text; `host/internal/api/api.go` caller/hook admission; `host/internal/agents/identity.go` session identity; `host/internal/agents/hooks.go` and `agents.go` client-specific outputs, title initialization, reminder and persistent waits |
| Client | `src/server/nexus.ts` caller identity and client-list instructions; `src/cli/hook.ts` input normalization and persistent waiter; `src/cli/client-command.ts` executable/wrapper handling; `src/cli/hook-command.ts` event arguments and PowerShell command form; `src/cli/install.ts`, `doctor.ts`, `client-dirs.ts`, `mcp-config.ts` registration, named hooks, rules, grants and diagnosis |
| Documentation | `docs/TOOLS_REFERENCE.md` and `_zh`, `docs/ASSISTANT_GUIDE.md` and `_zh`, `docs/ARCHITECTURE.md` and `_zh`, `docs/INSTALL.md` and `_zh`, `docs/USER_GUIDE.md` and `_zh`, `README.md`, `docs/README_zh.md`, `AGENTS.md`; user-visible implementation entries in `CHANGELOG.md` and `docs/CHANGELOG_zh.md` under Unreleased |

During implementation, search the whole repository for the three-client lists, installation usage, session-ID examples, schema enums and wake descriptions. Update every statement made outdated by the implementation, including this plan's status. Do not claim four-client support in current user documentation before the implementation exists.

## 7. Required verification

All checks below are acceptance work for the implementation, not results of the isolated capability probes in §2.

### 7.1 Automated checks

| Scope | Cases and checks |
|---|---|
| Storage (`host/internal/store/migrate_test.go`) | Upgrade a populated database through 0010 to the new migration; retain every session column, message/broadcast reference and pi PID mapping; insert an Antigravity session; reject an unknown client; verify `PRAGMA foreign_key_check`, enabled foreign keys after migration and reopening without reapplying it. Also test a fresh database. Run `go test ./host/internal/store`. |
| Host (`host/internal/agents`, `host/internal/api`, `host/internal/protocol`) | Caller admission and identity; schema loading; context output and both immediate/held Stop output; set-once title on repeated SessionStart; reminder with and without a wait, including resume without SessionStart; persistent waits across real events; existing automatic-turn limits; working/listening Stop priority; no duplicate delivery across two waiters; failed and superseded WakeResult reports. Run the Go tests for these packages. |
| HTTP conformance (`tests/conformance/agents.ts` and the agent hook/listen/tool test files) | Exercise the same cases through HTTP, validate `peers.self`, `peers.peers[]` and `set_profile.profile` against the expanded output schemas, and retain old-client behavior. Include `tests/conformance/structured_output.test.ts` in the conformance run. |
| Hook client (`tests/hook_cli.test.ts`) | Historical and 1.5.13 payloads; explicit event argument; workspace/cwd mapping; `machine`; title; normalized Stop timeout; null output printed as `{}`; `executionNum` even when `continuationActive` is false; missing environment variables without secret output. A fake agentapi records argument boundaries and controls exit codes. Verify permanent waiting, timeout renewal, null/unreachable/send-failure backoff, endpoint-specific WakeResult, and no resend after an accepted wake without a model reply. |
| MCP proxy (`tests/mcp_proxy.test.ts`) | Antigravity metadata through both 2025-era and 2026-07-28 clients; two conversation IDs through one adapter; absent/invalid IDs do not invent identity; root conversation metadata does not override the calling conversation. Existing client cases continue to pass. |
| Installation (`tests/install.test.ts`, `tests/install_windows.test.ts`, `tests/cli_windows_spawn.test.ts`, `tests/mcp-config.test.ts`, `tests/doctor.test.ts`) | Executable name `agy`, flags before MCP name, native executable and wrapper handling without a shell, PowerShell event command; temporary configuration trees covering install/reinstall/endpoint change/uninstall; preserve unrelated hooks, rules, grants and policy settings; report actual MCP removal failures; doctor detects each missing or inconsistent owned artifact. Endpoint changes replace the old owned waiter grant rather than leaving it behind. |

Run targeted tests as their changes land. The final automated gate is `npm run check`, `go vet ./...`, `go test ./host/...` and `npm run test:conformance`. Migration, cross-client contract and permission changes require the independent first-round review specified by `AGENTS.md`; verify its findings, fix in-scope defects and recheck the fixes before accepting those changes.

Compatibility checks must cover the new host with the existing Claude/Codex/pi adapters, the new adapter with an older host for existing clients, and Antigravity's fail-soft hook behavior against an older host. The adapter fetches tool schemas from the host; test that existing clients can list and consume profiles containing the new client value. Follow the [contract version rule](../../contract/README.md) if those checks establish a breaking change; obtain the user's version decision before changing a version number.

### 7.2 End-to-end acceptance

Run the installed implementation in Linux/WSL CLI and, separately, Windows IDE. Record each product version, interface (interactive/streaming/IDE), permission policy and observed result. Do not count the historical Windows tests or the standalone probe as current acceptance.

- Install and run doctor. Confirm the installed global rule and exact waiter grant start the waiter under the normal user-selected policy, without modifying that policy. A restrictive policy that denies the waiter must be reported as a limitation, not silently overridden.
- Use two Antigravity conversations and one Claude Code conversation. Check distinct IDs, tool access, bidirectional direct messages, per-session meeting identity and unread state. Observe actual replies and MCP calls after idle waking, not only agentapi exit codes.
- Cover delivery while working, at Stop, during held listening Stop, and after Stop returns. Validate that each wake is delivered once, including with two waiters, and that `fullyIdle: false` from a live waiter does not block delivery after a turn ends.
- Disconnect and restore the host, restart it with the same data, and keep a conversation idle beyond the existing finite client-wait deadline. Verify bounded retry cadence, recovery and retained delivery state. A newly discovered host without the session must not cause a busy loop; its next real hook registers the session.
- Close and resume an interactive CLI conversation without relying on SessionStart. On the next prompt, PreInvocation must restore its waiter; subsequent external messages must wake it. Check streaming invocation separately and use hooks/transcript evidence when stdout is buffered.
- Uninstall in the documented order, preserve unrelated configuration, and confirm that a fresh conversation starts no waiter. Existing waiters may persist until their CLI closes; normal CLI exit must end the owned waiter. Verify cleanup by the PIDs created for the test.

If agentapi accepts a message but a model does not reply within the observation window, record hook arrival, model-output evidence, the window and any test cancellation separately. Do not classify slow model generation as failed transport or add a resend workaround without a reproduced delivery failure. The four diagnostic timings in §2.1 are not acceptance deadlines.

## 8. Implementation order and commit boundaries

The implementation followed these phases. Pushing, package versions, tags and release delivery are separate decisions of the user.

1. Contract, database migration and host changes (§4.1–4.3), with migration, Go and HTTP conformance coverage.
2. Client identity, hook normalization and persistent waiter (§4.2–4.4), with client and both-era MCP tests.
3. Installation, uninstallation and doctor (§4.5), with temporary-configuration and Windows command tests.

Phases 1–3 landed in one commit: the client reads the client list from `contract/hook.json` at run time (`doctor` iterates it), so the contract change of phase 1 fails the client checks until phases 2 and 3 are in.
4. Final repository-wide documentation consistency check (§5–6) and the complete automated gate (§7.1).
5. Installed Linux/WSL CLI and Windows IDE end-to-end acceptance (§7.2), reported as separate results.

Each implementation phase's planned commit includes its passing checks, the documentation it makes due and both changelog entries for user-visible changes. The final documentation phase is a consistency pass, not a reason to defer those updates. Keep the plan marked unimplemented until code exists; record outstanding acceptance explicitly until §7 is satisfied. Package versions, tags and release delivery remain the user's decisions.
