# Rules for agents working on {{name}}

- Work on the `dev` branch and end every change with a commit. `main` moves
  only through promotion.
- `npm run check` must pass before you finish (tsc, eslint, tests,
  `npm audit`, `next build`). Commit `package-lock.json` with any dependency
  change.
- Every component's root element carries `data-component="<ComponentName>"`.
- Database changes are new files in `supabase/migrations/` named
  `<YYYYMMDDHHMMSS>_<name>.sql`. Migrations are forward-only: never edit or
  delete one that has been applied.
- Never edit or create `.env*` files and never print secret values. Secrets are
  read through `lib/env.ts` (`secret("NAME")`).
- Never put a secret in a `NEXT_PUBLIC_*` variable: those ship to the browser.
- Read the database through `lib/db.ts`; know the user through `getUser()` in
  `lib/auth.ts`.
- Agent tools live in `lib/mcp/tools.ts`. Read-only tools set
  `annotations.readOnlyHint`; any tool that changes data is named
  `action_<verb>` and sets `annotations.destructiveHint: true` so Aquarium asks
  the user first.
- The app is served under a base path (`basePath()` in `app.config.mjs`). Use
  `next/link` and relative URLs; never hard-code `/`-rooted links.
