"use client";

import { useEffect, useState } from "react";

import { mediaRef } from "@/lib/chat/media-ref";
import type { ChatMediaUrlResponse } from "@/types";
import { newTabRel } from "@/lib/http/link-rel";

/**
 * One inline **non-image** attachment (PDF/DOC/XLS/…) from the private media
 * bucket, rendered as a download chip. Like {@link ChatMedia} it holds only the
 * durable object path and asks the BFF (`GET /api/chat/media?path=…`) for a
 * short-lived signed URL, re-checked against the principal before signing.
 */
export function ChatFile({ path, name }: { path: string; name: string }) {
  const [resolved, setResolved] = useState<{
    path: string;
    url: string | null;
    failed: boolean;
  }>({ path, url: null, failed: false });
  const { url, failed } =
    resolved.path === path ? resolved : { url: null, failed: false };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(mediaRef(path), { cache: "no-store" });
        const body = (await res.json()) as Partial<ChatMediaUrlResponse>;
        if (!active) return;
        setResolved({
          path,
          url: res.ok && body.url ? body.url : null,
          failed: !res.ok || !body.url,
        });
      } catch {
        if (active) setResolved({ path, url: null, failed: true });
      }
    })();
    return () => {
      active = false;
    };
  }, [path]);

  const chip =
    "mt-1 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs";

  if (url) {
    return (
      <a
        data-component="ChatFile"
        href={url}
        target="_blank"
        rel={newTabRel(url)}
        download={name}
        className={`${chip} underline underline-offset-2`}
      >
        <span aria-hidden="true">📎</span>
        <span className="truncate">{name}</span>
      </a>
    );
  }
  return (
    <span data-component="ChatFile" className={`${chip} text-[var(--color-muted)]`}>
      <span aria-hidden="true">📎</span>
      <span className="truncate">
        {failed ? `${name} — unavailable` : `${name}`}
      </span>
    </span>
  );
}
