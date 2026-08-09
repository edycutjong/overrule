/**
 * Tamper matrix for the offline verifier: every class of mutation against a
 * real export must be detected (COMPLEXITY §2 — "fails on any mutation").
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/canonical';
import { TickClock } from '../src/core/clock';
import { Keyring } from '../src/core/ledger/keys';
import { DecisionLedger, bodyOf, type LedgerManifest } from '../src/core/ledger/ledger';
import { verifyLedgerExport } from '../src/core/ledger/verify';
import type { LedgerEntry } from '../src/core/types';

function makeExport(): { jsonl: string; manifest: LedgerManifest } {
  const keys = Keyring.fixture(['case_ops', 'treasury', 'scheduler']);
  const ledger = new DecisionLedger(keys, new TickClock('2026-07-14T09:00:00Z'));
  for (let i = 0; i < 6; i++) {
    ledger.append({
      case_id: i % 2 === 0 ? 'case_a' : 'case_b',
      agent: i % 3 === 0 ? 'treasury' : 'case_ops',
      kind: 'decision',
      decision: { stage: 'test', i },
      inputs_hash: sha256Hex(`in${i}`),
      output_hash: sha256Hex(`out${i}`),
    });
  }
  return ledger.export();
}

function editLine(jsonl: string, index: number, edit: (e: LedgerEntry) => LedgerEntry): string {
  const lines = jsonl.trim().split('\n');
  lines[index] = JSON.stringify(edit(JSON.parse(lines[index]!) as LedgerEntry));
  return lines.join('\n') + '\n';
}

describe('verifyLedgerExport', () => {
  it('accepts an untampered export', () => {
    const { jsonl, manifest } = makeExport();
    const report = verifyLedgerExport(jsonl, manifest);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.entries).toBe(6);
    expect(report.cases).toBe(2);
    expect(report.days).toBe(1);
  });

  it('detects an edited decision payload (entry hash breaks)', () => {
    const { jsonl, manifest } = makeExport();
    const tampered = editLine(jsonl, 2, (e) => ({ ...e, decision: { stage: 'test', i: 999 } }));
    const report = verifyLedgerExport(tampered, manifest);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('ENTRY_HASH');
  });

  it('detects a recomputed-hash forgery (signature + chain break instead)', () => {
    const { jsonl, manifest } = makeExport();
    // Attacker edits the payload AND recomputes entry_hash — without the agent
    // key the signature fails, and the next row's prev_hash no longer links.
    const tampered = editLine(jsonl, 2, (e) => {
      const forgedBody = bodyOf({ ...e, decision: { stage: 'test', i: 999 } });
      return { ...e, decision: forgedBody.decision, entry_hash: DecisionLedger.entryHash(forgedBody) };
    });
    const report = verifyLedgerExport(tampered, manifest);
    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('SIGNATURE');
    expect(codes).toContain('PREV_HASH');
    // Merkle roots also stop matching the manifest.
    expect(codes).toContain('MERKLE_MISMATCH');
  });

  it('detects a dropped line', () => {
    const { jsonl, manifest } = makeExport();
    const lines = jsonl.trim().split('\n');
    lines.splice(3, 1);
    const report = verifyLedgerExport(lines.join('\n') + '\n', manifest);
    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('GSEQ_ORDER');
    expect(codes).toContain('ENTRY_COUNT');
  });

  it('detects reordered lines', () => {
    const { jsonl, manifest } = makeExport();
    const lines = jsonl.trim().split('\n');
    [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    const report = verifyLedgerExport(lines.join('\n') + '\n', manifest);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('GSEQ_ORDER');
  });

  it('detects a swapped signature', () => {
    const { jsonl, manifest } = makeExport();
    const lines = jsonl.trim().split('\n');
    const donor = JSON.parse(lines[1]!) as LedgerEntry;
    const tampered = editLine(jsonl, 2, (e) => ({ ...e, sig: donor.sig }));
    const report = verifyLedgerExport(tampered, manifest);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('SIGNATURE');
  });

  it('detects a forged manifest merkle root', () => {
    const { jsonl, manifest } = makeExport();
    const forged = {
      ...manifest,
      merkle_roots: { ...manifest.merkle_roots, '2026-07-14': sha256Hex('forged') },
    };
    const report = verifyLedgerExport(jsonl, forged);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('MERKLE_MISMATCH');
  });

  it('detects a manifest root for a day with no entries', () => {
    const { jsonl, manifest } = makeExport();
    const forged = {
      ...manifest,
      merkle_roots: { ...manifest.merkle_roots, '2030-01-01': sha256Hex('ghost-day') },
    };
    const report = verifyLedgerExport(jsonl, forged);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('MERKLE_EXTRA_DAY');
  });

  it('detects a key missing from the manifest keyring', () => {
    const { jsonl, manifest } = makeExport();
    const { treasury: _dropped, ...rest } = manifest.keyring;
    const report = verifyLedgerExport(jsonl, { ...manifest, keyring: rest });
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('UNKNOWN_KEY');
  });

  it('detects a substituted keyring (attacker cannot swap in their own keys)', () => {
    const { jsonl, manifest } = makeExport();
    const attacker = Keyring.fixture(['case_ops'], 'attacker-namespace');
    const forged = {
      ...manifest,
      keyring: { ...manifest.keyring, case_ops: attacker.get('case_ops').publicKeyHex },
    };
    const report = verifyLedgerExport(jsonl, forged);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('SIGNATURE');
  });

  it('reports unparseable lines', () => {
    const { jsonl, manifest } = makeExport();
    const lines = jsonl.trim().split('\n');
    lines[0] = '{not json';
    const report = verifyLedgerExport(lines.join('\n') + '\n', manifest);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('PARSE');
  });
});
