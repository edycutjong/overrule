/**
 * Append-only Decision Ledger (COMPLEXITY §2).
 *
 *   entry_hash = SHA-256( prev_hash ∥ canonical_json(body) )
 *
 * where body = every field except entry_hash/sig/key_id (prev_hash is a body
 * field AND the hash prefix, matching the spec formula literally), and
 * prev_hash chains per-case (Firestore model: cases/{id}/ledger/{seq}).
 * Signature: Ed25519 over the raw 32-byte entry_hash, by the acting agent's key.
 *
 * Invariants enforced here:
 *  - I3: append is the only mutation; entries are frozen; hashes chain per case.
 *  - I4: a PHI guard scans every decision payload before append and throws if
 *        raw PII patterns are present (redaction must happen upstream).
 */
import { canonicalJson, sha256Hex } from '../canonical';
import { detectPhi } from '../redact/scrubber';
import type { AgentName, Clock, LedgerEntry, LedgerEntryBody, LedgerKind } from '../types';
import { GENESIS_HASH } from '../types';
import type { Keyring } from './keys';
import { dailyMerkleRoots } from './merkle';

export class PhiLeakError extends Error {
  constructor(reason: string) {
    super(`I4 violation: raw PHI must never reach ledger rows (${reason})`);
    this.name = 'PhiLeakError';
  }
}

export interface AppendInput {
  case_id: string;
  agent: AgentName;
  kind: LedgerKind;
  decision: Record<string, unknown>;
  inputs_hash: string;
  output_hash: string;
}

export type PhiGuard = (text: string) => string | null; // returns reason when PHI found

export interface LedgerExport {
  jsonl: string; // one entry per line, global append order
  manifest: LedgerManifest;
}

export interface LedgerManifest {
  format: 'overrule-ledger-manifest@1';
  key_mode: string;
  entry_count: number;
  keyring: Record<string, string>; // key_id → SPKI DER hex
  merkle_roots: Record<string, string>; // UTC day → root hex
}

const defaultPhiGuard: PhiGuard = (text) => {
  const hit = detectPhi(text);
  return hit ? `${hit.kind} pattern detected` : null;
};

export class DecisionLedger {
  private entries: LedgerEntry[] = [];
  private heads = new Map<string, { seq: number; hash: string }>(); // per-case chain head
  private readonly phiGuard: PhiGuard;

  constructor(
    private readonly keyring: Keyring,
    private readonly clock: Clock,
    opts: { phiGuard?: PhiGuard } = {},
  ) {
    this.phiGuard = opts.phiGuard ?? defaultPhiGuard;
  }

  /** Compute the chain hash for a body (also used by the verifier). */
  static entryHash(body: LedgerEntryBody): string {
    return sha256Hex(body.prev_hash + canonicalJson(bodyOf(body)));
  }

  append(input: AppendInput): LedgerEntry {
    // Snapshot the decision at append time. Once a row is hashed + signed its
    // content must be immutable (I3: "append is the only mutation; entries are
    // frozen"), but Object.freeze is shallow — a caller that keeps a reference
    // to a nested object (e.g. actuator result items the pipeline marks acted
    // moments later) could otherwise silently change a sealed row and break the
    // chain on re-verification. Deep-copying here seals the payload deeply.
    const decision = structuredClone(input.decision);
    // I4 gate — scan the decision payload as it will be serialized.
    const serializedDecision = canonicalJson(decision);
    const phiReason = this.phiGuard(serializedDecision);
    if (phiReason) throw new PhiLeakError(phiReason);
    if (!this.keyring.has(input.agent)) throw new Error(`no signing key for agent ${input.agent}`);

    const head = this.heads.get(input.case_id);
    const body: LedgerEntryBody = {
      gseq: this.entries.length,
      seq: head ? head.seq + 1 : 0,
      case_id: input.case_id,
      ts: this.clock.now(),
      agent: input.agent,
      kind: input.kind,
      decision,
      inputs_hash: input.inputs_hash,
      output_hash: input.output_hash,
      prev_hash: head ? head.hash : GENESIS_HASH,
    };
    const entry_hash = DecisionLedger.entryHash(body);
    const sig = this.keyring.sign(input.agent, Buffer.from(entry_hash, 'hex'));
    const entry: LedgerEntry = Object.freeze({ ...body, entry_hash, sig, key_id: input.agent });

    this.entries.push(entry);
    this.heads.set(input.case_id, { seq: body.seq, hash: entry_hash });
    return entry;
  }

  get length(): number {
    return this.entries.length;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  forCase(caseId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.case_id === caseId);
  }

  tail(n: number): LedgerEntry[] {
    return this.entries.slice(-n);
  }

  merkleRoots(): Record<string, string> {
    return dailyMerkleRoots(this.entries);
  }

  /** JSONL export + manifest — the artifact scripts/verify_ledger.ts consumes. */
  export(): LedgerExport {
    const jsonl = this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
    return {
      jsonl,
      manifest: {
        format: 'overrule-ledger-manifest@1',
        key_mode: this.keyring.mode,
        entry_count: this.entries.length,
        keyring: this.keyring.exportPublic(),
        merkle_roots: this.merkleRoots(),
      },
    };
  }
}

/** Strip non-body fields so verifier and appender hash identical structures. */
export function bodyOf(e: LedgerEntryBody | LedgerEntry): LedgerEntryBody {
  return {
    gseq: e.gseq,
    seq: e.seq,
    case_id: e.case_id,
    ts: e.ts,
    agent: e.agent,
    kind: e.kind,
    decision: e.decision,
    inputs_hash: e.inputs_hash,
    output_hash: e.output_hash,
    prev_hash: e.prev_hash,
  };
}
