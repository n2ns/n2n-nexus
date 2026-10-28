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
- [ ] A cleanup mechanism for expired data, such as direct messages and meeting records; otherwise long-term use leaves garbage behind. Whether to clean up automatically, rotate or archive is to be discussed

### Future
- [ ] Code signing for the Go host binaries — the first releases ship unsigned (Windows SmartScreen / Defender warnings; macOS avoided with a Homebrew formula built from source). Windows: apply for free open-source signing at SignPath.io (n2n-nexus is Apache-2.0), or buy a Certum open-source code signing certificate; macOS notarization needs the Apple Developer Program ($99/year). Signing adds one release step and changes nothing else
- [ ] Authentication layer — API key for host access (production deployments)
- [ ] Cross-machine live sync — host-to-host bridge (beyond baseline scope)
- [ ] IDE sidebar integration — optional SSE endpoint for real-time message display
- [ ] Streaming task progress — periodic progress notifications
