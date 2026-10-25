# {{name}}

An Aquarium app: a Next.js web UI and an MCP server for the agent, both in
one Node process, with its own database.

```bash
npm ci
npm run dev      # http://127.0.0.1:{{port}} (under the app's base path)
npm run check    # tsc + eslint + tests + npm audit + next build
```

- Web UI: `app/page.tsx`.
- Health: `GET <base path>/api/health`.
- MCP for the agent: `POST <base path>/api/mcp` with `Authorization: Bearer <APP_MCP_TOKEN>`.
- Database: `supabase/migrations/*.sql` (forward-only), applied by Aquarium.
- Manifest: `tool.config.json` (non-secret settings only). Secret names are in `.env.example`.

Branches: work on `dev`; `main` only moves when the app is promoted.
