/** One namespace's strings; nested objects are addressed with dotted keys. */
export interface MessageTree {
  [key: string]: string | MessageTree;
}
/** Every namespace for one locale, keyed by namespace (= the JSON file name). */
export type Messages = Record<string, MessageTree>;

export type TranslateVars = Record<string, string | number>;

export interface Translator {
  /** The string for `key`, with `{name}` placeholders filled from `vars`.
   *  A missing key returns the key itself so a gap is visible, never blank. */
  (key: string, vars?: TranslateVars): string;
  /** Whether `key` exists in this namespace. */
  has(key: string): boolean;
}

/** A flat key that itself contains dots (`"status.done"`) wins over a nested path. */
export function lookup(tree: MessageTree | undefined, key: string): string | undefined {
  const flat = tree?.[key];
  if (typeof flat === "string") return flat;
  let node: string | MessageTree | undefined = tree;
  for (const part of key.split(".")) {
    if (!node || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(text: string, vars?: TranslateVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function createTranslator(messages: Messages, namespace: string): Translator {
  const tree = messages[namespace];
  const t = ((key: string, vars?: TranslateVars) => {
    const text = lookup(tree, key);
    return text === undefined ? `${namespace}.${key}` : interpolate(text, vars);
  }) as Translator;
  t.has = (key: string) => lookup(tree, key) !== undefined;
  return t;
}

/** `base` with every string in `over` laid on top (missing keys fall back). */
export function mergeTrees(base: MessageTree, over: MessageTree): MessageTree {
  const out: MessageTree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] =
      typeof value === "object" && typeof prev === "object" ? mergeTrees(prev, value) : value;
  }
  return out;
}

/** Every dotted key in a tree (used by the en ⇄ zh-Hant parity test). */
export function flattenKeys(tree: MessageTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [prefix + key] : flattenKeys(value, `${prefix}${key}.`),
  );
}
