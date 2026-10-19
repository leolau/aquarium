import { MobileShell } from "@/components/MobileShell";
import { FilesTabs } from "@/components/files/FilesTabs";
import { FilesView } from "@/components/files/FilesView";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { FileAssetsResponse, FileSurfacesResponse } from "@/types";

// Per-principal HTML — never cached.
export const dynamic = "force-dynamic";

/**
 * `/files` — every file that arrived, from any surface, with its provenance.
 *
 * The counterpart to `/memory`: that page shows what the agent *remembers*,
 * this one shows what it *received*. A file appears here on arrival and only
 * crosses into memory when the user asks or a triage skill decides.
 *
 * First paint is RSC (principal + first page + surface counts); filtering and
 * paging are client-side refetches through `src/app/api/files/*`.
 */
export default async function Page() {
  await requirePrincipal();

  let first: FileAssetsResponse | null = null;
  let surfaces: FileSurfacesResponse = { surfaces: [] };
  let error: string | null = null;
  let noPrincipal = false;

  try {
    const client = await apiClientForRequest();
    [first, surfaces] = await Promise.all([
      client.files({ limit: 50 }),
      client.fileSurfaces(),
    ]);
  } catch (err) {
    // The status, not the message: `HermesApiError.message` embeds the request
    // path, so matching "409" in the string can fire on a path.
    if (err instanceof HermesApiError && err.status === 409) {
      noPrincipal = true;
    } else {
      error = err instanceof Error ? err.message : "Failed to load files";
    }
  }

  return (
    <MobileShell title="Files">
      <FilesTabs />
      {noPrincipal ? (
        <div
          data-component="FilesNoPrincipal"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Your login isn&apos;t linked to a principal yet. Ask the owner to
          enrol you with <code className="font-mono">hermes owner alias</code>.
        </div>
      ) : error || !first ? (
        <div
          data-component="FilesLoadError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load your files ({error}).
        </div>
      ) : (
        <FilesView initial={first} surfaces={surfaces.surfaces} />
      )}
    </MobileShell>
  );
}
