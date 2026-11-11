"use client";

import { useEffect, useRef, useState } from "react";

import { SecretRequestModal } from "@/components/chat/SecretRequestModal";
import { LockIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import { answerSecretRequest, formatCountdown, secondsLeft } from "@/lib/chat/secret-prompt";
import { useNow } from "@/lib/use-now";
import type { ChatSecretRequest } from "@/types";

/**
 * The FG-37 `secret.request` surface in a chat thread: an inline card for the
 * paused turn that opens the masked `SecretRequestModal` (on arrival, and
 * again from the card after "Not now"). `onResolved` fires once the request
 * is answered or declined, with a status line that names the secret only.
 */
export function SecretRequestPrompt({
  request,
  profile,
  onResolved,
}: {
  request: ChatSecretRequest;
  profile?: string;
  onResolved(note: string): void;
}) {
  const t = useT("secretPrompt");
  // Opens on each new request; "Not now" hides it until reopened from the card.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const open = dismissedId !== request.requestId;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const now = useNow(request.expiresAt !== null);
  const left = secondsLeft(request.expiresAt, now);

  useEffect(() => {
    cardRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [request.requestId]);

  return (
    <>
      <div
        ref={cardRef}
        data-component="SecretRequestCard"
        role="group"
        aria-label={t("request.cardTitle")}
        className="my-2 rounded-2xl border border-[var(--color-accent)] bg-[var(--color-surface-2)] p-3"
      >
        <p className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-fg)]">
          <LockIcon className="text-[var(--color-accent)]" />
          {t("request.cardTitle")}
        </p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {t("request.cardBody", { label: request.label })}
          {left !== null && left > 0 ? ` · ${t("request.expiresIn", { time: formatCountdown(left) })}` : ""}
        </p>
        <button
          type="button"
          onClick={() => setDismissedId(null)}
          className="mt-2 rounded-xl bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-accent-fg)]"
        >
          {t("request.open")}
        </button>
      </div>
      {open ? (
        <SecretRequestModal
          key={request.requestId}
          mode="request"
          request={request}
          onSubmit={async (values) => {
            await answerSecretRequest({ requestId: request.requestId, values, profile });
            setDismissedId(request.requestId);
            onResolved(t("request.submitted", { name: request.name }));
          }}
          onDecline={async () => {
            await answerSecretRequest({ requestId: request.requestId, decline: true, profile });
            setDismissedId(request.requestId);
            onResolved(t("request.declined", { name: request.name }));
          }}
          onDismiss={() => setDismissedId(request.requestId)}
        />
      ) : null}
    </>
  );
}
