# Security Policy

[中文版](docs/SECURITY_zh.md)

## Supported Versions

Security fixes target the latest published versions of n2n-nexus (npm client) and n2n-nexus-host.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Report security concerns through GitHub private vulnerability reporting for this repository, or contact Datafrog through the security channel listed on the organization profile.

When reporting, include:

- A description of the vulnerability.
- Steps to reproduce or a proof of concept.
- Affected versions or commit hashes.
- Any known impact or mitigation.

We aim to acknowledge reports within 5 business days.

## Security Model

n2n-nexus runs a local HTTP host, `n2n-nexus-host`, that stores coordination data in `nexus.db` in its data directory (`%LOCALAPPDATA%\n2n-nexus`, `~/Library/Application Support/n2n-nexus` or `~/.local/share/n2n-nexus` by default). It does not send project data to remote services.

Key boundaries to be aware of:

- **Unsigned binaries**: The `n2n-nexus-host` release binaries are not code-signed yet. Verify a download with the release's `SHA256SUMS` and `gh attestation verify <file> --repo n2ns/n2n-nexus` (build provenance), or install through Homebrew, which builds from source.
- **Local trust model**: Every process running as the same operating-system user is trusted. The host has no authentication; such a process can call it directly or read and write `nexus.db` and the client transcripts under `~/.claude`, `~/.codex`, `~/.pi` and `~/.gemini`. Conversation IDs, Claude tool-use bindings and pi process IDs route direct messages between conversations; they are not credentials, so an AI session with shell access can act as another conversation of the same user. Checks inside the host cannot prevent that while the data stays readable to that user. The Antigravity message waiter passes the agentapi credentials Antigravity gives it (`ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_LS_ADDRESS`) only to `agy agentapi`, never to the host, and never prints them. The barrier that matters is the client's permission to run commands, which the user controls. To isolate agents from each other, run them as different operating-system users, each with its own host and data directory.

- **Host network exposure**: The host binds to `127.0.0.1` by default. LAN access (the tray's **Allow LAN access**, `"host": "0.0.0.0"` in `settings.json`, or `--host 0.0.0.0`) exposes it to your local network, and it then answers LAN discovery on UDP `discoveryPort`. There is no authentication layer in the open-source baseline — only expose the host beyond localhost on networks you control.
- **Browser requests**: The host has no authentication, so it refuses requests that carry a browser `Origin` header or a cross-site `Sec-Fetch-Site` header (403), requires `Content-Type: application/json` on POST (415) and caps request bodies at 16 MB (413). It also rejects any `Host` header that is not an IP literal, `localhost`, `host.docker.internal` or a name listed in `allowedHosts` in `settings.json`, which closes DNS-rebinding attacks where a page reaches the host as a same-origin request under the attacker's domain. MCP adapters and scripts are unaffected.
- **Rate limiting**: Tool calls are limited per conversation, or per instance ID when no conversation is identified (default 20/s, burst 60, set with `rateLimit` / `rateBurst` in `settings.json`) and, because instance and session IDs are self-declared, per client address at five times that. Tool calls that name neither a conversation nor an instance ID are limited only per address. Hooks (`POST /api/hook`) are limited per conversation and per client address in buckets of their own. Over the limit the host answers `429` with `Retry-After`; `/health` and `GET /api/tools` are exempt.
- **Malformed requests**: Invalid request URLs or Host headers return 400 without terminating the host. Validly formed requests still pass through the browser and Host checks above.
- **Sensitive content in coordination data**: Project manifests, internal docs, meeting messages, and global documents are stored in plaintext in the host's local database. Do not store secrets, credentials, or customer data in these fields.
- **Destructive tools**: Destructive tools such as project deletion should be used through explicit review workflows.
- **Project assets**: Binary assets uploaded via `upload_project_asset` are stored in the host's database in its data directory. Treat them as local files with the same access controls.
- **API key for MCP**: The MCP adapter connects to the host over plain HTTP. If you expose the host to other machines, consider adding a reverse proxy with TLS in front of it.
