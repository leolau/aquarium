"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_FILE_ROLE,
  fileIdentity,
  newFilesOnly,
  roleToLinkKind,
  type FileRole,
} from "@/components/projects/inputs/inputKinds";
import {
  uploadProjectFile,
  type UploadFn,
  type UploadedLink,
} from "@/components/projects/inputs/uploadProjectFile";
import { newIdempotencyKey } from "@/components/projects/useProjectAction";

export type UploadStatus = "queued" | "uploading" | "done" | "failed";

/**
 * Files sent at once per queue. Each upload holds several database
 * connections in turn on the server, and the box's pool is small (20), so
 * sending 100+ files at once made most of them fail with a 500.
 */
export const MAX_PARALLEL_UPLOADS = 3;

export interface UploadItem {
  id: string;
  identity: string;
  file: File;
  role: FileRole;
  status: UploadStatus;
  /** 0..1 while uploading. */
  progress: number;
  /** Started but waiting for a free upload slot. */
  waiting?: boolean;
  error: string | null;
  /** Fixed per file: a retry re-sends the same key. */
  key: string;
  link: UploadedLink | null;
}

export interface UploadQueue {
  items: UploadItem[];
  /** Queue files; the same file dropped again is ignored. Returns what was added. */
  add: (files: Iterable<File>, role?: FileRole) => UploadItem[];
  setRole: (id: string, role: FileRole) => void;
  /** Drop a file that is not uploading or uploaded. */
  remove: (id: string) => void;
  /** Upload everything not yet uploaded (queued or failed). Resolves true when all are done. */
  uploadPending: (slug: string) => Promise<boolean>;
  retry: (id: string, slug: string) => Promise<boolean>;
  uploading: boolean;
  failedCount: number;
}

/**
 * At most {@link MAX_PARALLEL_UPLOADS} files go up at once; the rest wait
 * their turn. One upload per file, ever: each file has a synchronous in-flight lock and a
 * fixed idempotency key, a finished file is never sent again, and a second
 * drop of the same file is ignored. With `autoUploadSlug` files go up as soon
 * as they are added (the Inputs tab); without it they wait for
 * `uploadPending(slug)` (the wizard, which has no project yet).
 */
export function useUploadQueue({
  upload = uploadProjectFile,
  autoUploadSlug,
  onUploaded,
  dropDone = false,
}: {
  upload?: UploadFn;
  autoUploadSlug?: string;
  onUploaded?: (link: UploadedLink, item: UploadItem) => void;
  /** Remove a file from the queue once it is uploaded (the list shows it instead). */
  dropDone?: boolean;
} = {}): UploadQueue {
  const itemsRef = useRef<UploadItem[]>([]);
  const inFlight = useRef(new Map<string, Promise<boolean>>());
  const activeUploads = useRef(0);
  const slotWaiters = useRef<(() => void)[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const onUploadedRef = useRef(onUploaded);
  useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);

  const commit = useCallback((next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, change: Partial<UploadItem>) => {
      commit(itemsRef.current.map((item) => (item.id === id ? { ...item, ...change } : item)));
    },
    [commit],
  );

  const sendOne = useCallback(
    async (slug: string, id: string, item: UploadItem): Promise<boolean> => {
      const res = await upload({
        slug,
        file: item.file,
        kind: roleToLinkKind(item.role),
        idempotencyKey: item.key,
        onProgress: (fraction) => patch(id, { progress: fraction }),
      });
      if (!res.ok || !res.data) {
        patch(id, { status: "failed", error: res.error ?? "Could not upload the file." });
        return false;
      }
      const link = res.data;
      const done = { ...item, status: "done" as const, progress: 1, error: null, link };
      if (dropDone) {
        commit(itemsRef.current.filter((i) => i.id !== id));
      } else {
        patch(id, { status: "done", progress: 1, error: null, link });
      }
      onUploadedRef.current?.(link, done);
      return true;
    },
    [commit, dropDone, patch, upload],
  );

  const uploadOne = useCallback(
    (slug: string, id: string): Promise<boolean> => {
      const running = inFlight.current.get(id);
      if (running) return running;
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return Promise.resolve(false);
      if (item.status === "done") return Promise.resolve(true);
      const mustWait = activeUploads.current >= MAX_PARALLEL_UPLOADS;
      patch(id, { status: "uploading", progress: 0, error: null, waiting: mustWait });
      const promise = (async () => {
        try {
          if (mustWait) {
            // A finishing upload hands its slot straight to the next waiter.
            await new Promise<void>((resolve) => slotWaiters.current.push(resolve));
            patch(id, { waiting: false });
          } else {
            activeUploads.current += 1;
          }
          try {
            return await sendOne(slug, id, item);
          } finally {
            const next = slotWaiters.current.shift();
            if (next) next();
            else activeUploads.current -= 1;
          }
        } finally {
          inFlight.current.delete(id);
        }
      })();
      inFlight.current.set(id, promise);
      return promise;
    },
    [patch, sendOne],
  );

  const add = useCallback(
    (files: Iterable<File>, role: FileRole = DEFAULT_FILE_ROLE) => {
      const fresh = newFilesOnly(
        itemsRef.current.map((i) => i.identity),
        files,
      ).map(
        (file): UploadItem => ({
          id: newIdempotencyKey(),
          identity: fileIdentity(file),
          file,
          role,
          status: "queued",
          progress: 0,
          error: null,
          key: newIdempotencyKey(),
          link: null,
        }),
      );
      if (fresh.length === 0) return [];
      commit([...itemsRef.current, ...fresh]);
      if (autoUploadSlug) {
        for (const item of fresh) void uploadOne(autoUploadSlug, item.id);
      }
      return fresh;
    },
    [autoUploadSlug, commit, uploadOne],
  );

  const setRole = useCallback(
    (id: string, role: FileRole) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item || item.status === "uploading" || item.status === "done") return;
      patch(id, { role });
    },
    [patch],
  );

  const remove = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item || item.status === "uploading" || item.status === "done") return;
      commit(itemsRef.current.filter((i) => i.id !== id));
    },
    [commit],
  );

  const uploadPending = useCallback(
    async (slug: string) => {
      const ids = itemsRef.current.filter((i) => i.status !== "done").map((i) => i.id);
      const results = await Promise.all(ids.map((id) => uploadOne(slug, id)));
      return results.every(Boolean);
    },
    [uploadOne],
  );

  const retry = useCallback((id: string, slug: string) => uploadOne(slug, id), [uploadOne]);

  return {
    items,
    add,
    setRole,
    remove,
    uploadPending,
    retry,
    uploading: items.some((i) => i.status === "uploading"),
    failedCount: items.filter((i) => i.status === "failed").length,
  };
}
