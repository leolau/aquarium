"use client";

/**
 * WhatsApp (Get ready item 5, also Settings → In&Out): each person links
 * their own phone. Step 1 add a bridge, step 2 scan its QR, step 3 send a
 * test to the phone's own number. Only the bridge's person gets its QR and
 * controls (enforced in hermes_cli/wa_bridge_api.py); owner/admin also see
 * other people's bridges as a status only. The QR renders server-side as SVG
 * — the raw payload never reaches client JS.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  useWhatsAppT,
  type WhatsAppKey,
} from "@/components/settings/whatsappStrings";
import type {
  WaBridge,
  WaBridgeOther,
  WaBridgeStatus,
  WaBridgesResponse,
} from "@/types";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
//: Baileys rotates the QR payload about every 60s; poll often enough to
//: show a live code without hammering the box.
const QR_POLL_MS = 20_000;

type QrState = { svg: string; ageSeconds: number; stale: boolean };
type Action = "restart" | "stop" | "rebind";

export function bridgeStatus(b: WaBridge): WaBridgeStatus {
  if (b.status) return b.status;
  if (b.active === "active") {
    if (b.qr_pending) return "waiting_for_qr";
    return b.paired ? "connected" : "not_linked";
  }
  if (b.active === "activating") return "restarting";
  return b.active === "failed" ? "failed" : "stopped";
}

/** Get ready item 5 state from the caller's own bridges. */
export function whatsAppItemState(
  bridges: WaBridge[],
): "done" | "attention" | "not_started" {
  if (bridges.length === 0) return "not_started";
  return bridges.some((b) => bridgeStatus(b) === "connected")
    ? "done"
    : "attention";
}

const TONE: Record<WaBridgeStatus, string> = {
  connected: "text-green-400",
  waiting_for_qr: "text-[var(--color-warn-text)]",
  restarting: "text-[var(--color-warn-text)]",
  not_linked: "text-[var(--color-warn-text)]",
  stopped: "text-red-400",
  failed: "text-red-400",
};

function StepNum({ n, state }: { n: number; state: "done" | "attention" | "todo" }) {
  const cls =
    state === "done"
      ? "bg-emerald-500 text-[#06281d]"
      : state === "attention"
        ? "bg-[var(--color-warn)] text-[#2a1a00]"
        : "bg-[var(--color-surface-2)]";
  return (
    <span
      className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[13px] font-semibold ${cls}`}
      aria-hidden
    >
      {state === "done" ? "✓" : n}
    </span>
  );
}

const BTN =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-fg)] disabled:cursor-not-allowed disabled:opacity-50";
const GHOST = "min-h-9 rounded-lg px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50";
const INPUT =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm";

async function errorDetail(res: Response): Promise<string | undefined> {
  const data = (await res.json().catch(() => ({}))) as { detail?: string };
  return data.detail;
}

export function WhatsAppBridges() {
  const t = useWhatsAppT();
  const [bridges, setBridges] = useState<WaBridge[]>([]);
  const [others, setOthers] = useState<WaBridgeOther[]>([]);
  const [canAdd, setCanAdd] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [qr, setQr] = useState<QrState | null>(null);
  const [newName, setNewName] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ name: string; action: "stop" | "rebind" } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const apply = useCallback((data: WaBridgesResponse) => {
    setBridges(data.bridges ?? []);
    setOthers(data.others ?? []);
    setCanAdd(data.can_add !== false);
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/wa-bridges");
      if (res.ok) {
        apply((await res.json()) as WaBridgesResponse);
        setError(null);
      } else {
        setError("errLoad");
      }
    } catch {
      setError("errLoad");
    }
    setLoaded(true);
  }, [apply]);

  const fetchQr = useCallback(
    async (name: string) => {
      const res = await fetch(`/api/wa-bridges/${encodeURIComponent(name)}/qr`);
      if (res.ok) {
        const data = (await res.json()) as { svg: string; age_seconds: number; stale: boolean };
        setQr({ svg: data.svg, ageSeconds: data.age_seconds, stale: data.stale });
        return;
      }
      // 404 = no pending QR — usually the phone just scanned it.
      setQr(null);
      setQrFor(null);
      if (res.status !== 404) setError("errQr");
      await reload();
    },
    [reload],
  );

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (qrFor) pollRef.current = setInterval(() => void fetchQr(qrFor), QR_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [qrFor, fetchQr]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [reload]);

  const openQrSoon = useCallback(
    (name: string) => {
      // The bridge needs a few seconds to emit its first QR.
      setQrFor(name);
      setQr(null);
      setTimeout(() => void fetchQr(name), 4000);
    },
    [fetchQr],
  );

  const act = useCallback(
    async (name: string, action: Action) => {
      setBusy(`${name}:${action}`);
      setError(null);
      try {
        const res = await fetch(`/api/wa-bridges/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) setError((await errorDetail(res)) ?? t("errAction", { name }));
      } catch {
        setError(t("errAction", { name }));
      }
      setBusy(null);
      await reload();
      if (action === "rebind") openQrSoon(name);
    },
    [reload, openQrSoon, t],
  );

  const add = useCallback(async () => {
    const name = newName.trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      setError("errName");
      return;
    }
    setBusy("add");
    setError(null);
    try {
      const res = await fetch("/api/wa-bridges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError((await errorDetail(res)) ?? "errAdd");
      } else {
        setNewName("");
        openQrSoon(name);
      }
    } catch {
      setError("errAdd");
    }
    setBusy(null);
    await reload();
  }, [newName, reload, openQrSoon]);

  const sendTest = useCallback(
    async (name: string) => {
      setBusy(`${name}:test`);
      setError(null);
      setSent(null);
      try {
        const res = await fetch(`/api/wa-bridges/${encodeURIComponent(name)}/test`, {
          method: "POST",
        });
        if (res.ok) {
          const data = (await res.json()) as { to: string | null };
          setSent(data.to ?? "");
        } else {
          setError((await errorDetail(res)) ?? "errTest");
        }
      } catch {
        setError("errTest");
      }
      setBusy(null);
    },
    [],
  );

  const statuses = bridges.map(bridgeStatus);
  const step2 = statuses.includes("connected")
    ? "done"
    : bridges.length
      ? "attention"
      : "todo";
  const errorText =
    error && error in KEYS ? t(error as WhatsAppKey) : error;

  return (
    <section data-component="WhatsAppBridges" className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="text-xs text-[var(--color-muted)]">{t("intro")}</p>
      </div>

      {errorText && (
        <p role="alert" className="text-xs text-red-400">
          {errorText}
        </p>
      )}

      <div className="flex items-start gap-3">
        <StepNum n={1} state={bridges.length ? "done" : "attention"} />
        <p className="pt-1 text-sm">{t("step1")}</p>
      </div>
      <div className="flex items-start gap-3">
        <StepNum n={2} state={step2} />
        <p className="pt-1 text-sm">{t("step2")}</p>
      </div>

      <div className="space-y-2 rounded-lg border border-[var(--color-surface-2)] p-2 sm:ml-10">
        <p className="text-sm font-semibold">{t("bridgesHead")}</p>
        <ul className="space-y-2">
          {loaded && bridges.length === 0 && (
            <li className="text-xs text-[var(--color-muted)]">{t("none")}</li>
          )}
          {bridges.map((b, i) => {
            const status = statuses[i];
            return (
              <li
                key={b.name}
                data-bridge={b.name}
                className="rounded-lg border border-[var(--color-surface-2)] p-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-[150px] text-xs font-semibold">
                    {b.name}{" "}
                    <span className={`font-normal ${TONE[status]}`}>
                      {t(`status.${status}` as WhatsAppKey)}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {b.qr_pending && (
                      <button
                        type="button"
                        className={`${GHOST} text-[var(--color-accent)]`}
                        onClick={() => {
                          const open = qrFor !== b.name;
                          setQrFor(open ? b.name : null);
                          setQr(null);
                          if (open) void fetchQr(b.name);
                        }}
                      >
                        {qrFor === b.name ? t("hideQr") : t("showQr")}
                      </button>
                    )}
                    <button
                      type="button"
                      className={GHOST}
                      disabled={busy !== null}
                      onClick={() => void act(b.name, "restart")}
                    >
                      {busy === `${b.name}:restart` ? t("working") : t("restart")}
                    </button>
                    <button
                      type="button"
                      className={`${GHOST} text-[var(--color-accent)]`}
                      disabled={busy !== null}
                      onClick={() => setConfirm({ name: b.name, action: "rebind" })}
                    >
                      {busy === `${b.name}:rebind` ? t("working") : t("rebind")}
                    </button>
                    <button
                      type="button"
                      className={`${GHOST} text-red-400`}
                      disabled={busy !== null || b.active !== "active"}
                      onClick={() => setConfirm({ name: b.name, action: "stop" })}
                    >
                      {busy === `${b.name}:stop` ? t("working") : t("stop")}
                    </button>
                  </span>
                </div>
                {qrFor === b.name && (
                  <div className="mt-2 space-y-1">
                    {qr ? (
                      <>
                        {/* SVG rendered server-side from the pairing payload. */}
                        <div
                          className="inline-block rounded bg-white p-2"
                          dangerouslySetInnerHTML={{ __html: qr.svg }}
                        />
                        <p className="text-xs text-[var(--color-muted)]">
                          {t("qrAge", { seconds: qr.ageSeconds })}
                          {qr.stale && t("qrStale")}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-[var(--color-muted)]">{t("qrWaiting")}</p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {canAdd ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("newName")}
              aria-label={t("newName")}
              className={`${INPUT} max-w-[240px]`}
            />
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy !== null || !newName.trim()}
              onClick={() => void add()}
            >
              {busy === "add" ? t("adding") : t("add")}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={busy !== null}
              onClick={() => void reload()}
            >
              {t("refresh")}
            </button>
          </div>
        ) : (
          <p className="text-xs text-[var(--color-muted)]">{t("noHelper")}</p>
        )}
      </div>

      <div className="flex items-start gap-3">
        <StepNum n={3} state={sent !== null ? "done" : "todo"} />
        <p className="pt-1 text-sm">{t("step3")}</p>
      </div>
      <div className="space-y-2 sm:ml-10">
        {bridges.filter((_, i) => statuses[i] === "connected").map((b) => (
          <div key={b.name} className="flex flex-wrap items-center gap-2">
            <span className="text-xs">
              {t("sendsTo", { name: b.name, number: b.number ?? "" })}
            </span>
            <button
              type="button"
              className={BTN}
              disabled={busy !== null}
              onClick={() => void sendTest(b.name)}
            >
              {busy === `${b.name}:test` ? t("sending") : t("sendTest")}
            </button>
          </div>
        ))}
        {!statuses.includes("connected") && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} disabled>
              {t("sendTest")}
            </button>
            <span className="text-xs text-[var(--color-muted)]">{t("availableAfter")}</span>
          </div>
        )}
        {sent !== null && (
          <p
            role="status"
            className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-200"
          >
            ✓ {t("sent", { number: sent })}
          </p>
        )}
      </div>

      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-[var(--color-warn-text)]">
        ⚠ {t("warn")}
      </p>

      {others.length > 0 && (
        <div data-testid="wa-others" className="space-y-1">
          <p className="text-sm font-semibold">{t("othersHead")}</p>
          <p className="text-xs text-[var(--color-muted)]">{t("othersNote")}</p>
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="text-[var(--color-muted)]">
                <tr>
                  {(["colPerson", "colBridge", "colStatus"] as const).map((k) => (
                    <th
                      key={k}
                      className="resize-x overflow-hidden border-b border-[var(--color-border)] px-2 py-1 font-medium"
                    >
                      {t(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {others.map((o) => (
                  <tr key={o.name} className="border-b border-[var(--color-surface-2)]">
                    <td className="truncate px-2 py-1">{o.person_display}</td>
                    <td className="truncate px-2 py-1">{o.name}</td>
                    <td className={`px-2 py-1 ${TONE[o.status]}`}>
                      {t(`status.${o.status}` as WhatsAppKey)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={t(confirm.action === "rebind" ? "confirmRebindTitle" : "confirmStopTitle")}
          body={t(confirm.action === "rebind" ? "confirmRebindBody" : "confirmStopBody", {
            name: confirm.name,
          })}
          confirmLabel={t(confirm.action === "rebind" ? "rebind" : "stop")}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { name, action } = confirm;
            setConfirm(null);
            void act(name, action);
          }}
        />
      )}
    </section>
  );
}

const KEYS: Record<string, true> = {
  errLoad: true,
  errQr: true,
  errName: true,
  errAdd: true,
  errTest: true,
};
