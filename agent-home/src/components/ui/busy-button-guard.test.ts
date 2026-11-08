/**
 * Guard: a component that sends a change to the server (POST/PUT/PATCH/DELETE)
 * must start it through `ActionButton` or `useAction`, so the button shows it
 * is working and a second click cannot send the request again.
 *
 * It also covers the paths a per-file import check can't see:
 *  - `.ts` helpers that send changes (their importers must lock, or the helper
 *    must serialise itself and be listed in SELF_LOCKED with the reason);
 *  - `sendJson(...)`, which hides the method literal;
 *  - `<form onSubmit>` handlers and Enter-key handlers, which must route
 *    through a `useAction` / `useProjectAction` lock rather than calling the
 *    sending function directly.
 *
 * PENDING lists the components not converted yet (plan:
 * docs/plans/2026-10-20-busy-buttons-plan.md). Each area PR removes its
 * entries; the list must only shrink.
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

const PENDING = new Set<string>([
  // PR 4 — Settings, People
  // PR 5 — Sign-in, first-run, Account, Get ready
  // PR 6 — Files, Memory, Models, other
]);

const SENDS_CHANGE =
  /method:\s*"(POST|PUT|PATCH|DELETE)"|^\s*method,\s*$|method: method|\bsendJson(<[^>]*>)?\(/m;

// `.ts` helpers that send a change but serialise themselves, so callers may
// fire them without a busy button. Each entry says how.
const SELF_LOCKED: Record<string, string> = {
  "components/projects/task/saveViewMode.ts": "one PUT in flight per device; later taps coalesce",
};
// `useProjectAction` takes the same synchronous lock (plus an idempotency key)
// and pairs with `projects/ActionButton` for the busy look.
const USES_BUSY_BUTTON =
  /from "@\/components\/ui\/ActionButton"|from "@\/lib\/use-action"|from "@\/components\/projects\/useProjectAction"/;

function sourceFiles(ext: ".ts" | ".tsx"): string[] {
  return ["components", "app"].flatMap((dir) =>
    (readdirSync(path.join(SRC, dir), { recursive: true }) as string[])
      .map((f) => path.posix.join(dir, f.split(path.sep).join("/")))
      // Route handlers and server modules proxy upstream; they have no button.
      .filter((f) => f.endsWith(ext) && !f.includes(".test.") && !f.startsWith("app/api/"))
      .filter((f) => ext === ".tsx" || !/^import "server-only"/m.test(read(f))),
  );
}

const cache = new Map<string, string>();
function read(f: string): string {
  if (!cache.has(f)) cache.set(f, readFileSync(path.join(SRC, f), "utf8"));
  return cache.get(f)!;
}

/** The text inside the bracket that opens at `open` (inclusive of nesting). */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { "{": "}", "(": ")" };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Names bound to a synchronous lock: `const x = useAction(…)`, `{ run: x } = useAction(…)`. */
function lockedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*use(?:Project)?Action\(/g)) names.add(`${m[1]}.run`);
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*use(?:Project)?Action\(/g)) {
    const run = /\brun(?:\s*:\s*(\w+))?/.exec(m[1]);
    if (run) names.add(run[1] ?? "run");
  }
  return names;
}

/** The body of a local function or arrow bound to `name`, if the file defines one. */
function localBody(src: string, name: string): string | null {
  const def = new RegExp(`(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=\\s*(?:useCallback\\()?(?:async\\s*)?\\()`).exec(src);
  if (!def) return null;
  if (def[0].startsWith("function")) return balanced(src, src.indexOf("{", def.index + def[0].length));
  const arrow = src.indexOf("=>", def.index);
  if (arrow < 0) return null;
  const start = arrow + 2 + (/^\s*/.exec(src.slice(arrow + 2))?.[0].length ?? 0);
  // A brace body, or an expression body (`const patch = (…) => action.run(…)`).
  return src[start] === "{" ? balanced(src, start) : src.slice(start, src.indexOf(";\n", start));
}

/** Does this handler code reach a lock (directly or through one local function)? */
function routesThroughLock(src: string, code: string, locks: Set<string>, depth = 0): boolean {
  const calls = [...code.matchAll(/([\w.]+)\s*\(/g)].map((m) => m[1]);
  if (calls.some((c) => locks.has(c) || c.endsWith(".run"))) return true;
  if (depth > 1) return false;
  return calls.some((c) => {
    const body = localBody(src, c);
    return body !== null && body !== code && routesThroughLock(src, body, locks, depth + 1);
  });
}

/** Handlers that start work without a click on a button: form submits and Enter keys. */
function directHandlers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/onSubmit=\{/g)) out.push(balanced(src, m.index! + "onSubmit=".length));
  for (const m of src.matchAll(/onKeyDown=\{/g)) {
    const code = balanced(src, m.index! + "onKeyDown=".length);
    if (/"Enter"/.test(code)) out.push(code);
  }
  return out;
}

/** True when the handler only hands the event to a prop the parent owns. */
function delegates(src: string, code: string): boolean {
  const calls = [...code.matchAll(/([\w.]+)\s*\(/g)].map((m) => m[1]);
  return calls.every((c) => c === "e.preventDefault" || c === "evt.preventDefault" || /^on[A-Z]/.test(c) || localBody(src, c) === null);
}

/**
 * Exports of a `.ts` helper that send a change: `export function x` / `export
 * const x = …`, and for an exported object of methods, `obj.method`.
 */
function sendingExports(src: string): Set<string> {
  const out = new Set<string>();
  const decls = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)];
  decls.forEach((m, i) => {
    const body = src.slice(m.index!, decls[i + 1]?.index ?? src.length);
    if (!SENDS_CHANGE.test(body)) return;
    const members = [...body.matchAll(/^ {2}(?:async\s+)?(\w+)\s*(?:\(|:\s*(?:async\s*)?\()/gm)];
    if (/=\s*\{\s*$/m.test(body.split("\n")[0]) && members.length) {
      members.forEach((mm, j) => {
        const part = body.slice(mm.index!, members[j + 1]?.index ?? body.length);
        if (SENDS_CHANGE.test(part)) out.add(`${m[1]}.${mm[1]}`);
      });
    } else out.add(m[1]);
  });
  // An export that calls a sending export (e.g. a wrapper) sends too.
  decls.forEach((m, i) => {
    const body = src.slice(m.index!, decls[i + 1]?.index ?? src.length);
    if ([...out].some((n) => !n.includes(".") && n !== m[1] && new RegExp(`\\b${n}\\(`).test(body))) out.add(m[1]);
  });
  return out;
}

function componentFiles(): string[] {
  return sourceFiles(".tsx");
}

describe("busy buttons", () => {
  const files = componentFiles();
  const sending = files.filter((f) => SENDS_CHANGE.test(readFileSync(path.join(SRC, f), "utf8")));

  it("every component that sends a change uses ActionButton / useAction", () => {
    const missing = sending.filter(
      (f) => !PENDING.has(f) && !USES_BUSY_BUTTON.test(readFileSync(path.join(SRC, f), "utf8")),
    );
    expect(missing).toEqual([]);
  });

  it("form submits and Enter keys in sending components go through the lock", () => {
    const unlocked = sending.flatMap((f) => {
      const src = read(f);
      const locks = lockedNames(src);
      return directHandlers(src)
        .filter((code) => !routesThroughLock(src, code, locks) && !delegates(src, code))
        .map((code) => `${f}: ${code.replace(/\s+/g, " ").trim().slice(0, 80)}`);
    });
    expect(unlocked).toEqual([]);
  });

  it("every .ts helper that sends a change is locked by all its importers or serialises itself", () => {
    const helpers = sourceFiles(".ts").filter((f) => SENDS_CHANGE.test(read(f)));
    const unlocked = helpers.flatMap((helper) => {
      if (SELF_LOCKED[helper]) return [];
      const senders = sendingExports(read(helper));
      const spec = helper.replace(/\.ts$/, "");
      const base = path.posix.basename(spec);
      return componentFiles()
        .filter((f) => {
          const src = read(f);
          const from = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"(?:@/${spec}|\\./${base})"`).exec(src);
          if (!from || (from[0].includes(`"./${base}"`) && path.posix.dirname(f) !== path.posix.dirname(helper))) {
            return false;
          }
          const names = from[1].split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type "));
          return names.some((n) =>
            senders.has(n) || [...senders].some((s) => s.startsWith(`${n}.`) && src.includes(`${s}(`)),
          );
        })
        .filter((f) => !USES_BUSY_BUTTON.test(read(f)))
        .map((f) => `${helper} ← ${f}`);
    });
    expect(unlocked).toEqual([]);
  });

  it("SELF_LOCKED only lists helpers that exist and send a change", () => {
    const stale = Object.keys(SELF_LOCKED).filter((f) => {
      try {
        return !SENDS_CHANGE.test(read(f));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it("PENDING only lists components that still need converting", () => {
    const stale = [...PENDING].filter(
      (f) => !sending.includes(f) || USES_BUSY_BUTTON.test(readFileSync(path.join(SRC, f), "utf8")),
    );
    expect(stale).toEqual([]);
  });
});
