# Protocol contract

The HTTP contract between `n2n-nexus-host` and the `n2n-nexus` clients (MCP adapter, hooks). These files are the single source: the Go host embeds them, the TypeScript client reads `hook.json` at run time, and the conformance tests in `tests/conformance/` check a host against them.

- `tools.json`: every tool's name, title, description, annotations, input and output JSON Schema; `publishOutputSchema` says whether `GET /api/tools` includes the output schema.
- `hook.json`: hook clients, request fields (every event also carries `machine`, see `schemas.hookMachine`), `_meta` keys, the LAN discovery query (`discoveryQuery`), timings, limits, notification texts and the request schemas of `POST /api/hook` and `POST /api/tools/call`.
- `errors.json`: endpoints, error body and status codes.

Bump `contractVersion` in all three files when a change breaks an older client or host.
