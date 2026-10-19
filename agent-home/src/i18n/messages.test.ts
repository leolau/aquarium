/** Every English string has a Traditional Chinese twin (and the same {placeholders}). */
import { describe, expect, it } from "vitest";

import { LOCALES } from "@/i18n/config";
import { readLocaleFiles } from "@/i18n/load";
import { flattenKeys, type MessageTree } from "@/i18n/translate";

const en = readLocaleFiles("en");

function lookup(tree: MessageTree, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as MessageTree)[part] : undefined),
    tree,
  );
}

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("i18n message files", () => {
  it("ships the namespaces the shell needs", () => {
    for (const ns of ["common", "nav", "login", "setup", "settings"]) {
      expect(Object.keys(en)).toContain(ns);
    }
  });

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    const other = readLocaleFiles(locale);
    it(`${locale} has every namespace file that en has`, () => {
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
    });
    for (const [ns, tree] of Object.entries(en)) {
      it(`${locale}/${ns}.json has every key in en/${ns}.json`, () => {
        const missing = flattenKeys(tree).filter(
          (key) => typeof lookup(other[ns] ?? {}, key) !== "string",
        );
        expect(missing).toEqual([]);
      });
      it(`${locale}/${ns}.json keeps the same placeholders and no blanks`, () => {
        for (const key of flattenKeys(tree)) {
          const theirs = lookup(other[ns] ?? {}, key);
          if (typeof theirs !== "string") continue;
          expect(theirs.trim(), `${ns}.${key}`).not.toBe("");
          expect(placeholders(theirs), `${ns}.${key}`).toEqual(
            placeholders(lookup(tree, key) as string),
          );
        }
      });
    }
  }
});
