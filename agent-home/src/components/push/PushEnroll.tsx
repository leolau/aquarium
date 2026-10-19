"use client";

/**
 * Settings opt-in for the app channel's Web Push notifications (the toggle
 * the plan settled on: permission is only ever requested from this explicit
 * user gesture). Enrolling stores the device's PushSubscription server-side;
 * deliveries into chat topics then notify this device, and tapping the
 * notification opens straight into the topic.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/i18n";

type PushSupport = "checking" | "supported" | "unsupported";
type EnrollState = "off" | "on" | "busy" | "denied" | "unavailable";

/** The browser wants the applicationServerKey as a Uint8Array, not b64url text. */
function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export function PushEnroll() {
  const tSettings = useT("settings");
  const [support, setSupport] = useState<PushSupport>("checking");
  const [state, setState] = useState<EnrollState>("off");

  useEffect(() => {
    const t = setTimeout(() => {
      const supported =
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window;
      setSupport(supported ? "supported" : "unsupported");
      if (!supported) return;
      // Reflect any existing enrollment (e.g. enrolled before a reload).
      void (async () => {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = await reg?.pushManager.getSubscription();
          if (sub && Notification.permission === "granted") setState("on");
        } catch {
          // Leave it off.
        }
      })();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const enable = useCallback(async () => {
    setState("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }
      const keyRes = await fetch("/api/notifications/vapid-public-key");
      if (!keyRes.ok) {
        setState("unavailable");
        return;
      }
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const json = subscription.toJSON();
      const res = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
        }),
      });
      setState(res.ok ? "on" : "unavailable");
    } catch {
      setState("unavailable");
    }
  }, []);

  const disable = useCallback(async () => {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = sub?.endpoint;
      await sub?.unsubscribe();
      if (endpoint) {
        await fetch("/api/notifications/subscribe", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      }
      setState("off");
    } catch {
      setState("off");
    }
  }, []);

  if (support === "checking") return null;

  return (
    <section>
      <h2 className="text-sm font-semibold">{tSettings("notifications")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        When the agent delivers a report into a chat topic, this device gets a
        notification that opens straight into that topic.
      </p>
      {support === "unsupported" ? (
        <p className="text-xs text-[var(--color-muted)]">
          This browser doesn&apos;t support web notifications.
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={state === "on"}
            disabled={state === "busy"}
            onClick={() => void (state === "on" ? disable() : enable())}
            className={`relative h-7 w-12 rounded-full transition-colors ${
              state === "on" ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)]"
            }`}
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${
                state === "on" ? "left-6" : "left-1"
              }`}
            />
          </button>
          <span className="text-xs">
            {state === "busy"
              ? "Working…"
              : state === "on"
                ? "On for this device"
                : state === "denied"
                  ? "Blocked — allow notifications in the browser settings"
                  : state === "unavailable"
                    ? "Not available on this box right now"
                    : "Off"}
          </span>
        </div>
      )}
    </section>
  );
}
