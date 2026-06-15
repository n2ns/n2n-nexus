# Security Policy

## Supported Versions

Security fixes target the latest published version of n2n-nexus.

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

n2n-nexus runs a local HTTP daemon that stores coordination data under `~/.n2n-nexus` by default. It does not send project data to remote services.

Key boundaries to be aware of:

- **Daemon network exposure**: The daemon binds to `127.0.0.1` by default. Using `--host 0.0.0.0` exposes it to your local network. There is no authentication layer in the open-source baseline — only expose the daemon beyond localhost on networks you control.
- **Sensitive content in coordination data**: Project manifests, internal docs, meeting messages, and global documents are stored in plaintext on the local filesystem. Do not store secrets, credentials, or customer data in these fields.
- **Project assets**: Binary assets uploaded via `upload_project_asset` are stored under the daemon root. Treat them as local files with the same access controls.
- **API key for MCP**: The MCP adapter connects to the daemon over plain HTTP. If you expose the daemon to a remote host, consider adding a reverse proxy with TLS in front of it.
