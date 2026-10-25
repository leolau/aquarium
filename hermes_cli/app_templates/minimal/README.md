# {{name}}

An in-house Hermes tool: a Next.js app running in its own Node process that
exposes a **web UI** (humans) and a **thin MCP server** (the agent).

## Web UI

```bash
npm install
npm run dev        # serves the UI on http://127.0.0.1:{{port}}
```

## MCP server (agent interface)

```bash
npm run mcp        # node mcp/server.mjs — JSON-RPC over stdio, no deps
```

The Hermes tool registry records this tool's MCP endpoint (via FG-11) so future
agent sessions can reach it. Configuration lives in `tool.config.json` and the
registry row's `config_json` — never in a `HERMES_*` env var (secrets only, in
this tool's own `.env`).
