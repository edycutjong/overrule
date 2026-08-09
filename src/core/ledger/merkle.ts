/**
 * Daily Merkle root over ledger entries (COMPLEXITY §2).
 *
 * Leaves: entry_hash (hex → bytes) of every entry whose UTC day matches,
 * in global append order (gseq ascending).
 * Parent: SHA-256(left ∥ right) over raw 32-byte nodes.
 * Odd node: PROMOTED unchanged to the next level (no duplication — avoids the
 * classic duplicate-leaf ambiguity).
 * Empty day: defined as sha256 of the empty string, tagged constant below.
 */
import { createHash } from 'node:crypto';

export const EMPTY_TREE_ROOT = createHash('sha256').update('').digest('hex');

export function merkleRoot(leafHexes: readonly string[]): string {
  if (leafHexes.length === 0) return EMPTY_TREE_ROOT;
  let level: Buffer[] = leafHexes.map((h) => {
    const b = Buffer.from(h, 'hex');
    if (b.length !== 32 || b.toString('hex') !== h.toLowerCase()) {
      throw new Error(`merkleRoot: leaf is not 32-byte hex: ${h}`);
    }
    return b;
  });
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right ? createHash('sha256').update(Buffer.concat([left, right])).digest() : left);
    }
    level = next;
  }
  return level[0]!.toString('hex');
}

/** Group entry hashes by UTC day ("YYYY-MM-DD") and compute a root per day. */
export function dailyMerkleRoots(
  entries: readonly { ts: string; entry_hash: string; gseq: number }[],
): Record<string, string> {
  const byDay = new Map<string, { gseq: number; hash: string }[]>();
  for (const e of entries) {
    const day = e.ts.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`dailyMerkleRoots: bad ts ${e.ts}`);
    const bucket = byDay.get(day) ?? [];
    bucket.push({ gseq: e.gseq, hash: e.entry_hash });
    byDay.set(day, bucket);
  }
  const out: Record<string, string> = {};
  for (const [day, bucket] of byDay) {
    bucket.sort((a, b) => a.gseq - b.gseq);
    out[day] = merkleRoot(bucket.map((b) => b.hash));
  }
  return out;
}
