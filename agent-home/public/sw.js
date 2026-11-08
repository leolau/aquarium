/*
 * agent-home service worker (FG-20 Wave A1) — installable PWA + offline shell.
 *
 * Strategy, deliberately conservative for an auth'd BFF:
 *   - Precache a tiny app shell (the offline fallback + icons).
 *   - Navigations: network-first, falling back to the cached offline shell so
 *     a cold/offline launch still renders something (never a browser error).
 *   - Same-origin static assets (Next's /_next/static/* are content-hashed):
 *     stale-while-revalidate.
 *   - NEVER cache API/auth responses or cross-origin requests — those carry
 *     per-principal data and must always hit the network.
 */
const VERSION = "agent-home-v3";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept dynamic/authenticated endpoints.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((r) => r || Response.error()),
      ),
    );
    return;
  }

  if (isStaticAsset(url)) {
    // Network-first for content-hashed assets: the URL changes when the
    // content changes, so stale cache has zero benefit and only risks
    // serving an old bundle after a deploy (which broke Folder Bridge
    // keepalive pings until the user hard-refreshed). Fall back to cache
    // only when the network is unreachable (offline).
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          const cached = await cache.match(request);
          return cached || Response.error();
        }
      }),
    );
  }
});

/*
 * App-channel Web Push. The Python sender's payload is
 * {title, body, url, icon, badge, tag} — `url` deep-links into the chat
 * topic the delivery landed in (/chat?session=<id>).
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || "Hermes", {
        body: data.body || "",
        icon: data.icon || "/icons/icon-192.png",
        badge: data.badge || "/icons/icon-192.png",
        tag: data.tag || undefined,
        data: { url: data.url || "/" },
      }),
      // Open tabs re-read their "Needs you" list now instead of on the
      // next poll (useNeedsYou listens for this).
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          for (const client of clients) client.postMessage({ type: "needs-you:refresh" });
        })
        .catch(() => {}),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => "focus" in c);
        if (existing) {
          existing.focus();
          if ("navigate" in existing) return existing.navigate(target);
          return undefined;
        }
        return self.clients.openWindow(target);
      }),
  );
});
