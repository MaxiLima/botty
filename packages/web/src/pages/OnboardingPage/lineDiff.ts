/** One line of a computed line diff. */
export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/**
 * Minimal LCS-based line diff. Quadratic time/space — fine here: the Review
 * step diffs config-sized markdown/JSON files, not code trees.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i * w + j] = LCS length of a[i..] vs b[j..], flattened.
  const w = m + 1;
  const lcs = new Array<number>((n + 1) * w).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      out.push({ type: 'del', text: a[i] ?? '' });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] ?? '' });
      j += 1;
    }
  }
  for (; i < n; i++) out.push({ type: 'del', text: a[i] ?? '' });
  for (; j < m; j++) out.push({ type: 'add', text: b[j] ?? '' });
  return out;
}
