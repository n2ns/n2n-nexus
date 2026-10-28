#!/usr/bin/env bash
# End-to-end check of hook-delivered direct messages with the real `claude` and `codex` CLIs.
# Not part of `npm test`: it needs both CLIs logged in and spends model tokens. Re-run it after
# upgrading either client, since the identity it relies on (hook stdin `session_id`, Claude's
# `_meta["claudecode/toolUseId"]`, Codex's `_meta.sessionId`) is client behaviour.
#
# Usage: go build -o host/bin/ ./host/cmd/n2n-nexus-host && npm run build && tests/e2e/hooks-e2e.sh
#        (E2E_PORT overrides the host port, default 5799; NEXUS_HOST_BIN the host executable,
#        default host/bin/n2n-nexus-host). Needs the sqlite3 command-line tool to inspect the host database.
#
# Automated (headless): 1. send / notify / read / reply between Claude and Codex
#                       2+3. a message arriving during a tool call (PostToolUse), then Stop continuing once
#                       5. notifyWhenIdle
# Manual (interactive), against the environment this script prints when run with KEEP=1:
#   4. listen: in `CODEX_HOME=<dir>/codex-home codex resume <B> --dangerously-bypass-approvals-and-sandbox
#      --dangerously-bypass-hook-trust`, ask it to turn listen on and end its turn; send it a message from
#      Claude; it must continue by itself, and Esc must end the wait (status idle).
#   6. /clear: in an interactive `CLAUDE_CONFIG_DIR=<dir>/claude-home claude`, call peers, run /clear, send a
#      message; peers shows the old id offline and the message comes from the new id.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-5799}"
ENDPOINT="http://127.0.0.1:$PORT"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/n2n-nexus-e2e.XXXXXX")"
NODE="$(command -v node)"
HOST_BIN="${NEXUS_HOST_BIN:-$REPO/host/bin/n2n-nexus-host}"
HOST_PID=""

cleanup() {
    [ -n "$HOST_PID" ] && kill "$HOST_PID" 2>/dev/null || true
    if [ "${KEEP:-0}" = 1 ]; then echo "Kept $DIR"; else rm -rf "$DIR"; fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

# One SQL query against the test host's database, printed as JSON rows.
query() {
    sqlite3 -readonly -json "$DIR/nexus-root/nexus.db" "$1"
}

claude_run() {   # claude_run <workdir> [--resume <id>] <prompt>  → prints the session id
    local work="$1"; shift
    (cd "$work" && env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_PID -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR/claude-home" \
        claude -p --permission-mode bypassPermissions --output-format json "$@" </dev/null) \
        | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).session_id))'
}

codex_run() {    # codex_run <log> [resume <id>] <prompt>
    local log="$1"; shift
    (cd "$DIR/work-b" && CODEX_HOME="$DIR/codex-home" codex exec --dangerously-bypass-approvals-and-sandbox \
        --dangerously-bypass-hook-trust --skip-git-repo-check "$@" </dev/null >"$DIR/$log" 2>&1)
}

# --- Environment -------------------------------------------------------------------------------
mkdir -p "$DIR/nexus-root" "$DIR/claude-home" "$DIR/codex-home" "$DIR/work-a" "$DIR/work-b"
cp "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" "$DIR/claude-home/"
cp "${CODEX_HOME:-$HOME/.codex}/auth.json" "$DIR/codex-home/"
printf '[projects."%s"]\ntrust_level = "trusted"\n' "$DIR/work-b" > "$DIR/codex-home/config.toml"
CLAUDE_CONFIG_DIR="$DIR/claude-home" "$NODE" "$REPO/build/index.js" install claude --endpoint "$ENDPOINT" >/dev/null
CODEX_HOME="$DIR/codex-home" "$NODE" "$REPO/build/index.js" install codex --endpoint "$ENDPOINT" >/dev/null 2>&1
[ -x "$HOST_BIN" ] || fail "no host executable at $HOST_BIN (go build -o host/bin/ ./host/cmd/n2n-nexus-host)"
command -v sqlite3 >/dev/null || fail "the sqlite3 command-line tool is required"
"$HOST_BIN" serve --root "$DIR/nexus-root" --port "$PORT" >"$DIR/host.log" 2>&1 &
HOST_PID=$!
for _ in $(seq 1 50); do curl -sf "$ENDPOINT/health" >/dev/null && break; sleep 0.1; done
curl -sf "$ENDPOINT/health" >/dev/null || fail "host did not start (see $DIR/host.log)"

# --- 1. send / notify / read / reply -----------------------------------------------------------
codex_run b1.log "Call the n2n-nexus peers tool and tell me your own session id."
B=$(sed -n 's/^session id: //p' "$DIR/b1.log" | head -1)
[ -n "$B" ] || fail "no Codex session id in b1.log"
A=$(claude_run "$DIR/work-a" "Use the n2n-nexus send tool to send the session codex:$B the text 'Hello from Claude. Please reply with the word PONG.'")
[ "$(query "SELECT COUNT(*) AS n FROM agent_messages WHERE from_id = 'claude:$A' AND to_id = 'codex:$B'")" = '[{"n":1}]' ] \
    || fail "Claude's message was not stored under its own identity"
# An unrelated prompt: Codex learns of the message only from the notification, and replies on its own.
codex_run b2.log resume "$B" "What is 17 times 3?"
[ "$(query "SELECT status FROM agent_messages WHERE to_id = 'codex:$B'")" = '[{"status":"read"}]' ] || fail "Codex did not read the message"
[ "$(query "SELECT COUNT(*) AS n FROM agent_messages WHERE from_id = 'codex:$B' AND reply_to IS NOT NULL")" = '[{"n":1}]' ] \
    || fail "Codex did not reply"
claude_run "$DIR/work-a" --resume "$A" "Any news?" >/dev/null
[ "$(query "SELECT status FROM agent_messages WHERE to_id = 'claude:$A'")" = '[{"status":"read"}]' ] || fail "Claude did not read the reply"
pass "1. Claude → Codex message, notification on the next turn, read and reply back"

# --- 2+3. a message during a tool call; Stop continues once ------------------------------------
codex_run b3.log resume "$B" "Run the shell command 'sleep 40 && echo slept' and tell me what it printed." &
CODEX_JOB=$!
for _ in $(seq 1 60); do grep -q "sleep 40" "$DIR/b3.log" 2>/dev/null && break; sleep 1; done
"$NODE" -e '
    fetch(process.argv[1] + "/api/hook", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "claude", input: { hook_event_name: "PreToolUse", session_id: process.argv[2], tool_use_id: "toolu_e2e", machine: { hostname: "e2e", platform: "linux", utcOffset: 0 } } }) })
    .then(() => fetch(process.argv[1] + "/api/tools/call", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "send", args: { to: "codex:" + process.argv[3], text: "Status check while you are busy." }, instanceId: "e2e", caller: { client: "claude", toolUseId: "toolu_e2e" } }) }))
    .then(r => r.json()).then(r => { if (!r.ok) { console.error(r); process.exit(1); } })
' "$ENDPOINT" "$A" "$B"
wait "$CODEX_JOB"
grep -q "hook: PostToolUse" "$DIR/b3.log" || fail "no PostToolUse hook in b3.log"
NOTIFIED=$(query "SELECT notified_at, read_at FROM agent_messages WHERE text = 'Status check while you are busy.'")
echo "$NOTIFIED" | grep -q '"read_at":"' || fail "busy message not read: $NOTIFIED"
pass "2+3. busy recipient notified after its tool call and read the message before finishing ($NOTIFIED)"

# --- 5. notifyWhenIdle ---------------------------------------------------------------------------
claude_run "$DIR/work-a" --resume "$A" "Use the n2n-nexus send tool to send codex:$B the text 'FYI only, no reply needed.' with notifyWhenIdle set to true." >/dev/null
codex_run b4.log resume "$B" "What is 2 + 2?"
[ "$(query "SELECT COUNT(*) AS n FROM agent_notices WHERE session_id = 'claude:$A' AND text LIKE '%finished its turn.%'")" = '[{"n":1}]' ] \
    || fail "no idle notice for Claude"
claude_run "$DIR/work-a" --resume "$A" "Any news?" >/dev/null
[ "$(query "SELECT COUNT(*) AS n FROM agent_notices WHERE session_id = 'claude:$A' AND notified_at IS NOT NULL")" = '[{"n":1}]' ] \
    || fail "Claude was not shown the idle notice"
pass "5. notifyWhenIdle notice created when Codex finished and shown to Claude on its next turn"

echo "All automated scenarios passed. Interactive scenarios 4 and 6: see the header of this script."
