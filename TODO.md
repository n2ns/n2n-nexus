# Nexus Project TODO List

## Backlog

### Near-term
- [ ] winget: N2NS.n2n-nexus-host 0.9.0 is submitted (microsoft/winget-pkgs#460226); once merged, change "coming soon" in README / README_zh to `winget install N2NS.n2n-nexus-host`, and submit later versions from the `winget-manifests.zip` of each release
- [ ] Boot check of `service install` on Windows: the scheduled task's AtStartup trigger has not been tried with a reboot (install, restart and supervisor restart were checked on 2026-10-23)
- [ ] Codex messages left waiting after Codex restarts — the background wait ends with the Codex app and `codex queue` only starts a turn for a conversation loaded in the app, so messages wait until the user prompts that conversation; consider a per-machine waker that loads the conversation through the app-server
- [ ] Hide Codex background sessions (e.g. `codex@memories`) from peers and the SessionStart introduction; they never answer
- [ ] Tell automatic turns apart from user prompts by content instead of the one-minute window (see ARCHITECTURE known limits)
- [ ] Check whether Codex restarts the stdio adapter repeatedly when a chat opens (the HTTP probe saw a dozen short connections per chat) and whether the host sees instances flapping
- [ ] Consider showing Codex `client_type` (desktop app / CLI) from `_meta["x-codex-turn-metadata"]` in peers; store only that field
- [ ] Low findings of the 2026-10-29 review, left as they are:
  - A call without `instanceId` runs `join_meeting`, `send_message` and `stance` as the shared identity `unknown` (`host/internal/core/messages.go`, `api.Call.Actor`); only `read_messages` refuses. Two hand-written clients without it share one member row and one read cursor. Decide: refuse like `read_messages`, or keep.
  - Meeting news announced only in a sub-agent's PostToolUse context is marked announced (`notifyFresh(markNone)` → `cursors.Announced`), so the main conversation is neither held nor woken for it later (`host/internal/agents/agents.go`, `announce`). Matches "tool-call notifications stay unread" in the docs; confirm it is intended.
  - UDP discovery answers any 18-byte query with a ~70-byte reply to the unverified source address (`host/internal/discovery/discovery.go`): a ~4x reflection vector, LAN-scoped; the Windows firewall rules no longer apply to public networks.
  - The adapter pins `clientName` on its first request (`identifyClient` in `src/server/nexus.ts`); a client that omits `io.modelcontextprotocol/clientInfo` there never gets a `caller`. Not reproducible with the SDK client (its 2026-07-28 codec stamps clientInfo on every request), only with a hand-written one.
- [ ] Meetings, from the feedback of the sessions in meetings 20261028195736-n2n-nexus-jseh and 20261028212543-n2n-nexus-dac6, not covered by the user-seat plan ([docs/plans/human-seat-meetings.md](docs/plans/human-seat-meetings.md)) (to be discussed, nothing decided):
  - Sessions do not learn that a meeting started unless invited; proposed: tell every online session (without waking it) when a meeting starts.
  - `join_meeting` refuses a closed meeting; proposed: say in the error that `read_messages(meetingId)` reads it.
  - The notes of endorsements reach only the draft's author; proposed: show them in the `stance` result and in `list_meetings`.
  - A participant's position is spread over several messages that retract each other; proposed: show each member's latest stance and the open objections in one place.
  - Rounds instead of free posting: the chair opens a round, each member has one post in it, and the posts are released together when the round ends; free chat stays for small discussions.
  - A revised draft records which draft it replaces and shows the changed paragraphs; endorsements of unchanged parts carry over.
  - Messages addressed to members (`to` or @name): only those named are woken, the others see them at their next tool call.
  - At the end of a meeting, a markdown document of the topics, positions, decisions and open questions for the user, merged with the manual meeting export.
  - Show what a meeting cost: messages, reads, wakes and duration, so the user can tell what is worth a meeting.

### Future
- [ ] Code signing for the Go host binaries — the first releases ship unsigned (Windows SmartScreen / Defender warnings; macOS avoided with a Homebrew formula built from source). Windows: apply for free open-source signing at SignPath.io (n2n-nexus is Apache-2.0), or buy a Certum open-source code signing certificate; macOS notarization needs the Apple Developer Program ($99/year). Signing adds one release step and changes nothing else
- [ ] Authentication layer — API key for host access (production deployments)
- [ ] Cross-machine live sync — host-to-host bridge (beyond baseline scope)
- [ ] IDE sidebar integration — optional SSE endpoint for real-time message display
- [ ] Streaming task progress — periodic progress notifications
