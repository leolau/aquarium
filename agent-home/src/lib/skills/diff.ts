/** Line diff for the "Review & save" dialog. */

export type DiffOp = { type: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

/** Above this many cells the middle is shown as a block replace instead of an LCS. */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const middle: Array<{ type: DiffOp["type"]; text: string }> = [];
  if (am.length * bm.length > MAX_CELLS) {
    for (const t of am) middle.push({ type: "del", text: t });
    for (const t of bm) middle.push({ type: "add", text: t });
  } else {
    const n = am.length;
    const m = bm.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        middle.push({ type: "same", text: am[i] });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) middle.push({ type: "del", text: am[i++] });
      else middle.push({ type: "add", text: bm[j++] });
    }
  }
  const ops: DiffOp[] = [];
  let oldNo = 1;
  let newNo = 1;
  const push = (type: DiffOp["type"], text: string) => {
    if (type === "same") ops.push({ type, text, oldNo: oldNo++, newNo: newNo++ });
    else if (type === "del") ops.push({ type, text, oldNo: oldNo++ });
    else ops.push({ type, text, newNo: newNo++ });
  };
  for (const t of a.slice(0, pre)) push("same", t);
  for (const op of middle) push(op.type, op.text);
  for (const t of a.slice(a.length - suf)) push("same", t);
  return ops;
}

/** Lines changed, counting a replaced line once. */
export function changedLineCount(ops: DiffOp[]): number {
  let total = 0;
  let adds = 0;
  let dels = 0;
  for (const op of [...ops, { type: "same" as const, text: "" }]) {
    if (op.type === "add") adds++;
    else if (op.type === "del") dels++;
    else {
      total += Math.max(adds, dels);
      adds = dels = 0;
    }
  }
  return total;
}

export type Hunk = { ops: DiffOp[] } | { skipped: number };

/** Changed lines with `context` unchanged lines around them; long unchanged runs collapse. */
export function hunks(ops: DiffOp[], context = 3): Hunk[] {
  const keep = ops.map(() => false);
  ops.forEach((op, k) => {
    if (op.type === "same") return;
    for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = true;
  });
  const out: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (keep[k]) {
      const run: DiffOp[] = [];
      while (k < ops.length && keep[k]) run.push(ops[k++]);
      out.push({ ops: run });
    } else {
      let skipped = 0;
      while (k < ops.length && !keep[k]) {
        skipped++;
        k++;
      }
      out.push({ skipped });
    }
  }
  return out;
}
