# Auto-recover from a stale-bundle chunk-load failure

## Incident

An installed iOS PWA, left open (or backgrounded) across three
production deploys in one session, threw:

> Application error: a client-side exception has occurred while loading
> <agent-home-host> (see the browser console for more information).

Root cause: Next.js content-hashes every JS file per build. A tab that's
been open since before a deploy still holds references to the OLD
hashes; the next dynamic import or route-chunk fetch 404s, which surfaces
as an uncaught exception with no error boundary and no recovery — on
Chrome as `ChunkLoadError` ("Loading chunk N failed"), on Safari/WebKit
as "Importing a module script failed" (the exact wording this incident
hit). A fresh page load sidesteps it entirely, which is why desktop (a
fresh tab) was fine while the already-open mobile PWA wasn't.

## Fix

`agent-home/src/lib/chunk-reload.ts` — the pure logic, no DOM required to
test:

- `isChunkLoadError(error)` — matches webpack's own `ChunkLoadError` name
  plus the browser-specific message wordings (Chrome, Firefox, Safari).
- `reloadOnceForChunkError(error, win?)` — reloads exactly once per
  "session" (a `sessionStorage` flag) when `error` looks like a stale
  bundle; never loops. Takes an injectable `win` so tests don't need a
  real `window`.
- `markAppHealthy(win?)` — clears that flag once something has actually
  rendered, so a *later* deploy's stale chunk still gets its own single
  retry instead of being silently blocked by an old flag stuck from
  today.

Wired into two places for full coverage — a chunk failure can surface
either inside or outside React's render:

- `app/global-error.tsx` (new) — the App Router's root error boundary,
  catches a `React.lazy`/dynamic import throwing *during render*. Reloads
  silently on a stale-bundle error (nothing useful to show for the
  instant before the reload lands); otherwise renders a plain, honest
  fallback ("Something went wrong" + Reload/Try again) instead of Next's
  generic, dead-end "Application error" page — the one this report
  screenshotted.
- `components/ChunkErrorListener.tsx` (new), mounted in the root layout
  alongside `ServiceWorkerRegister` — `window` `error`/`unhandledrejection`
  listeners, for the other half: a background route prefetch's import
  failing outside React's tree entirely, which never reaches the error
  boundary.

## Explicitly not built

- No banner telling the user a new version is available before they hit
  the error (a "soft" update prompt) — that's a nicer UX than a silent
  auto-reload, but a materially bigger change (needs the SW to notify the
  page of a waiting update). This fix is the safety net for when that
  doesn't happen; worth revisiting separately if silent reloads ever feel
  surprising in practice.
- No change to the service worker's own caching strategy — `sw.js`
  already explicitly never caches `/api/*` and treats navigations
  network-first, so it wasn't a factor in this incident.
