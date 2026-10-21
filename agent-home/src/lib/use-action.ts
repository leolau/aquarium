"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Run a backend action at most once at a time.
 *
 * `pending` drives the busy look (spinner, label, `disabled`). The ref lock is
 * what actually stops a second request: React applies `disabled` only after
 * the next render, and a fast double-click or double Enter lands before that.
 * The lock is taken synchronously inside the first click, so the second call
 * returns `undefined` without calling `fn`.
 */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
): { run: (...args: A) => Promise<R | undefined>; pending: boolean } {
  const lock = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(fn);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (lock.current) return undefined;
    lock.current = true;
    setPending(true);
    try {
      return await latest.current(...args);
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { run, pending };
}
