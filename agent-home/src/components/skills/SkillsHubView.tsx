"use client";

import { useEffect, useRef, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { Pill, type Tone } from "@/components/ui/Pill";
import { inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import type {
  SkillHubInstalledEntry,
  SkillHubPreview,
  SkillHubResult,
  SkillHubScan,
  SkillHubSearchResponse,
  SkillHubSourcesResponse,
} from "@/types";

const TRUST_TONE: Record<string, Tone> = { builtin: "accent", trusted: "success", community: "muted" };

export function verdictVisual(verdict: string): { tone: Tone; label: string } {
  switch (verdict) {
    case "safe":
      return { tone: "success", label: "Safe" };
    case "caution":
      return { tone: "warning", label: "Caution" };
    case "dangerous":
      return { tone: "danger", label: "Dangerous" };
    default:
      return { tone: "muted", label: verdict };
  }
}

/** What Install does for a scanned skill: go, ask first, or refuse. */
export function installDecision(scan: SkillHubScan | undefined): "allow" | "ask" | "block" | "unknown" {
  if (!scan) return "unknown";
  if (scan.policy === "block" || scan.verdict === "dangerous") return "block";
  if (scan.policy === "ask" || scan.verdict === "caution") return "ask";
  return "allow";
}

/**
 * The Skills hub: search the connected hubs, see trust and the security scan,
 * preview, and install into the selected profile. Mirrors the dashboard:
 * "dangerous" is blocked, "caution" asks first. The hub installer re-scans
 * and applies the same policy server-side, so the page is never the gate.
 */
export function SkillsHubView({ profile, onInstalled }: { profile: string; onInstalled(): Promise<void> }) {
  const q = profileQuery(profile);
  const [sources, setSources] = useState<SkillHubSourcesResponse["sources"]>([]);
  const [results, setResults] = useState<SkillHubResult[]>([]);
  const [installed, setInstalled] = useState<Record<string, SkillHubInstalledEntry>>({});
  const [query, setQuery] = useState("");
  const [scans, setScans] = useState<Record<string, SkillHubScan | "error">>({});
  const [preview, setPreview] = useState<SkillHubPreview | null>(null);
  const [confirm, setConfirm] = useState<SkillHubResult | null>(null);
  const [started, setStarted] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const scanRun = useRef(0);

  useEffect(() => {
    let live = true;
    getJson<SkillHubSourcesResponse>(`/api/skills/hub/sources${q ? `?${q}` : ""}`)
      .then((d) => {
        if (!live) return;
        setSources(d.sources ?? []);
        setInstalled(d.installed ?? {});
        setResults((r) => (r.length ? r : (d.featured ?? [])));
      })
      .catch((err) => live && setMessage({ tone: "error", text: errorText(err) }));
    return () => {
      live = false;
    };
  }, [q]);

  // Scan the listed skills one at a time so each row shows its verdict.
  useEffect(() => {
    const run = ++scanRun.current;
    void (async () => {
      for (const r of results) {
        if (scanRun.current !== run) return;
        if (scans[r.identifier]) continue;
        let scan: SkillHubScan | "error";
        try {
          scan = await getJson<SkillHubScan>(`/api/skills/hub/scan?identifier=${encodeURIComponent(r.identifier)}`);
        } catch {
          scan = "error";
        }
        if (scanRun.current !== run) return;
        setScans((s) => ({ ...s, [r.identifier]: scan }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rescan only when the list changes
  }, [results]);

  async function search() {
    setMessage(null);
    try {
      const res = await getJson<SkillHubSearchResponse>(
        `/api/skills/hub/search?q=${encodeURIComponent(query.trim())}${q ? `&${q}` : ""}`,
      );
      setResults(res.results);
      setInstalled(res.installed ?? {});
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }

  async function openPreview(r: SkillHubResult) {
    setMessage(null);
    try {
      setPreview(await getJson<SkillHubPreview>(`/api/skills/hub/preview?identifier=${encodeURIComponent(r.identifier)}`));
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }

  async function install(r: SkillHubResult) {
    setMessage(null);
    try {
      await sendJson("/api/skills/hub/install", "POST", { identifier: r.identifier, ...(q ? { profile } : {}) });
      setStarted((s) => new Set(s).add(r.identifier));
      setConfirm(null);
      setMessage({ tone: "ok", text: `Installing ${r.name} into ${profile}… it appears in the list when done.` });
      await onInstalled();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }

  const scanOf = (id: string) => {
    const s = scans[id];
    return s && s !== "error" ? s : undefined;
  };

  return (
    <div data-component="SkillsHubView" className="space-y-3">
      {sources.length ? (
        <p className="text-sm text-[var(--color-muted)]">
          Connected hubs: {sources.map((s) => s.label).join(" · ")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <input
          aria-label="Search the skills hub"
          className={inputClass}
          placeholder="Search the hub…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) void search();
          }}
        />
        <ActionButton className={primaryButtonClass} disabled={!query.trim()} busyLabel="Searching…" onAction={search}>
          Search
        </ActionButton>
      </div>

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "error" ? "text-red-300" : "text-emerald-300"}`}>
          {message.text}
        </p>
      ) : null}

      <ul className="divide-y divide-[var(--color-border)] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        {results.map((r) => {
          const raw = scans[r.identifier];
          const scan = scanOf(r.identifier);
          const decision = installDecision(scan);
          const isInstalled = Boolean(installed[r.identifier]) || started.has(r.identifier);
          return (
            <li key={r.identifier} data-component="HubRow" data-identifier={r.identifier} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{r.name}</span>
                  <Pill tone={TRUST_TONE[r.trust_level] ?? "muted"}>{r.trust_level}</Pill>
                  {scan ? (
                    <Pill tone={verdictVisual(scan.verdict).tone}>scan: {verdictVisual(scan.verdict).label}</Pill>
                  ) : (
                    <Pill>{raw === "error" ? "scan failed" : "scanning…"}</Pill>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">
                  {r.description}
                  {r.source ? ` · ${r.source}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <ActionButton className={secondaryButtonClass} busyLabel="Loading…" onAction={() => openPreview(r)}>
                  Preview
                </ActionButton>
                {isInstalled ? (
                  <span className="px-2 py-1.5 text-xs text-[var(--color-muted)]">installed</span>
                ) : decision === "block" ? (
                  <button type="button" disabled className={secondaryButtonClass} title={scan?.policy_reason}>
                    Install blocked
                  </button>
                ) : decision === "ask" ? (
                  <button type="button" className={primaryButtonClass} onClick={() => setConfirm(r)}>
                    Install
                  </button>
                ) : (
                  <ActionButton
                    className={primaryButtonClass}
                    disabled={decision === "unknown"}
                    busyLabel="Installing…"
                    onAction={() => install(r)}
                  >
                    Install
                  </ActionButton>
                )}
              </div>
            </li>
          );
        })}
        {results.length === 0 ? (
          <li className="p-4 text-sm text-[var(--color-muted)]">Search the hub to find skills.</li>
        ) : null}
      </ul>
      <p className="text-xs text-[var(--color-muted)]">
        Each skill is security-scanned before install. &ldquo;Dangerous&rdquo; can&apos;t be installed from here;
        &ldquo;Caution&rdquo; asks for confirmation.
      </p>

      {preview ? (
        <Sheet component="HubPreview" title={`Preview · ${preview.name}`} wide onClose={() => setPreview(null)}>
          <pre className="whitespace-pre-wrap font-mono text-xs">{preview.skill_md}</pre>
        </Sheet>
      ) : null}

      {confirm ? (
        <Sheet
          component="HubCautionConfirm"
          title={`Install ${confirm.name}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <span className="flex-1" />
              <button type="button" className={secondaryButtonClass} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <ActionButton className={primaryButtonClass} busyLabel="Installing…" onAction={() => install(confirm)}>
                Install anyway
              </ActionButton>
            </>
          }
        >
          <p className="text-sm">
            The security scan flagged this skill as <strong>Caution</strong>.{" "}
            {scanOf(confirm.identifier)?.summary ?? ""}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[var(--color-muted)]">
            {(scanOf(confirm.identifier)?.findings ?? []).slice(0, 6).map((f, i) => (
              <li key={i}>
                {f.severity}: {f.description}
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
    </div>
  );
}
