import "server-only";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { mergeTrees, type MessageTree, type Messages } from "@/i18n/translate";

/**
 * Strings live in `src/i18n/messages/<locale>/<namespace>.json` and are read
 * from disk on the server (never fetched over the network). Adding a feature's
 * strings is just adding its two JSON files — no registry to edit. The release
 * build traces the folder into the standalone server (see next.config.mjs).
 */
const CANDIDATES = [
  path.join(process.cwd(), "src", "i18n", "messages"),
  path.join(process.cwd(), "agent-home", "src", "i18n", "messages"),
];

export function messagesDir(): string {
  const found = CANDIDATES.find((dir) => existsSync(dir));
  if (!found) throw new Error("agent-home i18n: messages folder not found");
  return found;
}

/** Every namespace for one locale, exactly as written on disk. */
export function readLocaleFiles(locale: Locale, dir = messagesDir()): Messages {
  const folder = path.join(dir, locale);
  const out: Messages = {};
  if (!existsSync(folder)) return out;
  for (const file of readdirSync(folder)) {
    if (!file.endsWith(".json")) continue;
    out[file.slice(0, -".json".length)] = JSON.parse(
      readFileSync(path.join(folder, file), "utf8"),
    ) as MessageTree;
  }
  return out;
}

const cache = new Map<Locale, Messages>();

/** All namespaces for `locale`, with English filling any missing string. */
export function loadMessages(locale: Locale): Messages {
  const hit = process.env.NODE_ENV === "production" ? cache.get(locale) : undefined;
  if (hit) return hit;
  const base = readLocaleFiles(DEFAULT_LOCALE);
  const messages: Messages = { ...base };
  if (locale !== DEFAULT_LOCALE) {
    for (const [ns, tree] of Object.entries(readLocaleFiles(locale))) {
      messages[ns] = mergeTrees(base[ns] ?? {}, tree);
    }
  }
  cache.set(locale, messages);
  return messages;
}
