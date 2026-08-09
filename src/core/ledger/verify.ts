/**
 * Offline verification of a ledger export (COMPLEXITY §2/§5):
 * recomputes every per-case hash chain, every Ed25519 signature, and every
 * daily Merkle root from the JSONL alone, then compares against the manifest.
 * Any mutation — edited field, dropped line, reordered line, swapped signature,
 * forged root — must surface as a failure. scripts/verify_ledger.ts wraps this.
 */
import type { LedgerEntry } from '../types';
import { GENESIS_HASH } from '../types';
import { verifyWithPublicKeyHex } from './keys';
import { DecisionLedger, bodyOf, type LedgerManifest } from './ledger';
import { dailyMerkleRoots } from './merkle';

export interface VerifyIssue {
  gseq: number | null;
  code:
    | 'PARSE'
    | 'GSEQ_ORDER'
    | 'CASE_SEQ'
    | 'PREV_HASH'
    | 'ENTRY_HASH'
    | 'SIGNATURE'
    | 'UNKNOWN_KEY'
    | 'ENTRY_COUNT'
    | 'MERKLE_MISMATCH'
    | 'MERKLE_MISSING_DAY'
    | 'MERKLE_EXTRA_DAY';
  detail: string;
}

export interface ChainReport {
  ok: boolean;
  entries: number;
  cases: number;
  days: number;
  issues: VerifyIssue[];
}

export function parseJsonl(jsonl: string): { entries: LedgerEntry[]; issues: VerifyIssue[] } {
  const entries: LedgerEntry[] = [];
  const issues: VerifyIssue[] = [];
  const lines = jsonl.split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch (err) {
      issues.push({ gseq: null, code: 'PARSE', detail: `line ${i + 1}: ${(err as Error).message}` });
    }
  });
  return { entries, issues };
}

export function verifyLedgerExport(jsonl: string, manifest: LedgerManifest): ChainReport {
  const { entries, issues } = parseJsonl(jsonl);

  // 1. Global order: gseq must be exactly 0..n-1 in file order.
  entries.forEach((e, i) => {
    if (e.gseq !== i) {
      issues.push({ gseq: e.gseq, code: 'GSEQ_ORDER', detail: `expected gseq ${i} at line ${i + 1}, got ${e.gseq}` });
    }
  });

  // 2. Per-case chains: contiguous seq from 0, prev_hash links, entry_hash recomputes.
  const heads = new Map<string, { seq: number; hash: string }>();
  for (const e of entries) {
    const head = heads.get(e.case_id);
    const expectedSeq = head ? head.seq + 1 : 0;
    const expectedPrev = head ? head.hash : GENESIS_HASH;
    if (e.seq !== expectedSeq) {
      issues.push({ gseq: e.gseq, code: 'CASE_SEQ', detail: `case ${e.case_id}: expected seq ${expectedSeq}, got ${e.seq}` });
    }
    if (e.prev_hash !== expectedPrev) {
      issues.push({ gseq: e.gseq, code: 'PREV_HASH', detail: `case ${e.case_id} seq ${e.seq}: prev_hash does not match chain head` });
    }
    let recomputed: string | null = null;
    try {
      recomputed = DecisionLedger.entryHash(bodyOf(e));
    } catch (err) {
      issues.push({ gseq: e.gseq, code: 'ENTRY_HASH', detail: `hash recompute failed: ${(err as Error).message}` });
    }
    if (recomputed !== null && recomputed !== e.entry_hash) {
      issues.push({ gseq: e.gseq, code: 'ENTRY_HASH', detail: `entry_hash mismatch (recomputed ${recomputed?.slice(0, 12)}…, stored ${e.entry_hash?.slice(0, 12)}…)` });
    }
    // Chain forward on the STORED hash so a single corruption doesn't cascade
    // into every later row (the mismatch itself is already reported).
    heads.set(e.case_id, { seq: e.seq, hash: e.entry_hash });

    // 3. Signature against the manifest keyring.
    const pub = manifest.keyring[e.key_id];
    if (!pub) {
      issues.push({ gseq: e.gseq, code: 'UNKNOWN_KEY', detail: `key_id ${e.key_id} not in manifest keyring` });
    } else if (!verifyWithPublicKeyHex(pub, Buffer.from(e.entry_hash, 'hex'), e.sig)) {
      issues.push({ gseq: e.gseq, code: 'SIGNATURE', detail: `Ed25519 signature invalid for agent ${e.agent}` });
    }
  }

  // 4. Entry count.
  if (entries.length !== manifest.entry_count) {
    issues.push({ gseq: null, code: 'ENTRY_COUNT', detail: `manifest says ${manifest.entry_count} entries, export has ${entries.length}` });
  }

  // 5. Daily Merkle roots recomputed from the export.
  let recomputedRoots: Record<string, string> = {};
  try {
    recomputedRoots = dailyMerkleRoots(entries);
  } catch (err) {
    issues.push({ gseq: null, code: 'MERKLE_MISMATCH', detail: `root recompute failed: ${(err as Error).message}` });
  }
  for (const [day, root] of Object.entries(recomputedRoots)) {
    const claimed = manifest.merkle_roots[day];
    if (claimed === undefined) {
      issues.push({ gseq: null, code: 'MERKLE_MISSING_DAY', detail: `day ${day} present in export but missing from manifest` });
    } else if (claimed !== root) {
      issues.push({ gseq: null, code: 'MERKLE_MISMATCH', detail: `day ${day}: manifest root ${claimed.slice(0, 12)}… ≠ recomputed ${root.slice(0, 12)}…` });
    }
  }
  for (const day of Object.keys(manifest.merkle_roots)) {
    if (!(day in recomputedRoots)) {
      issues.push({ gseq: null, code: 'MERKLE_EXTRA_DAY', detail: `manifest claims a root for ${day} but export has no entries that day` });
    }
  }

  return {
    ok: issues.length === 0,
    entries: entries.length,
    cases: new Set(entries.map((e) => e.case_id)).size,
    days: Object.keys(recomputedRoots).length,
    issues,
  };
}
