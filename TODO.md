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
- [ ] A cleanup mechanism for expired data, such as direct messages and meeting records; otherwise long-term use leaves garbage behind. Decided so far (meeting 20261028212543-n2n-nexus-dac6, retention set by the user afterwards):
  - Delete by age only: no count-based rotation, no automatic archive.
  - Two host `settings.json` fields, at least 1 day each: `meetingRetentionDays` (default 30) for meetings closed or archived that long ago (messages, decisions, stances, members and approvers go with them), also the days without a message after which an active meeting is closed with endReason `expired`; `retentionDays` (default 7) for read or expired direct messages, delivered notices, events, finished tasks and sessions offline that long (with their read cursors, tool-use bindings and idle subscriptions; a session that a direct message still references waits), and adapter instances not seen that long.
  - Meeting messages, global chat, meeting members, stances and approvers store the sender's display name and machine when written, and show those instead of looking up the session.
  - Every cleanup writes a `maintenance.cleanup` event with the counts; `host_maintenance` gains "clean up now" (with a dry run listing what would go) and "export a meeting as markdown".
  - Selection and deletion in one transaction, re-checking the state; tests for every boundary and for running the cleanup twice.
  - Still open: how to fill the snapshot columns of the records already in the database (backfill with the names found at migration time, or reset the database again).
- [ ] Meetings, from the feedback of the sessions in meetings 20261028195736-n2n-nexus-jseh and 20261028212543-n2n-nexus-dac6 (to be discussed, nothing decided):
  - Concurrent posts: two sessions answering each other at the same moment swapped positions three times. Proposed: `send_message` reports the meeting messages posted since the caller last read (or refuses until it reads them).
  - Notifications of meeting news carry only counts, so every new message costs a `read_messages` call; proposed: carry the texts like direct messages (cut at `notifyTextChars`).
  - Every ordinary message wakes every active member, which floods the user with progress reports; proposed: wake at once only for a draft, a decision, an objection or a message naming the member, and deliver the rest at the next tool call.
  - Consensus closes the meeting as decided although the user has not approved anything; proposed: an option to end in an "awaiting user" state that `list_meetings` shows.
  - Sessions do not learn that a meeting started unless invited; proposed: tell every online session (without waking it) when a meeting starts.
  - `join_meeting` refuses a closed meeting; proposed: say in the error that `read_messages(meetingId)` reads it.
  - The notes of endorsements reach only the draft's author; proposed: show them in the `stance` result and in `list_meetings`.
  - A participant's position is spread over several messages that retract each other; proposed: show each member's latest stance and the open objections in one place.

### Future
- [ ] Code signing for the Go host binaries — the first releases ship unsigned (Windows SmartScreen / Defender warnings; macOS avoided with a Homebrew formula built from source). Windows: apply for free open-source signing at SignPath.io (n2n-nexus is Apache-2.0), or buy a Certum open-source code signing certificate; macOS notarization needs the Apple Developer Program ($99/year). Signing adds one release step and changes nothing else
- [ ] Authentication layer — API key for host access (production deployments)
- [ ] Cross-machine live sync — host-to-host bridge (beyond baseline scope)
- [ ] IDE sidebar integration — optional SSE endpoint for real-time message display
- [ ] Streaming task progress — periodic progress notifications
