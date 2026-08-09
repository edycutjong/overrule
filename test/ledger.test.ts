import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/core/canonical';
import { TickClock } from '../src/core/clock';
import { Keyring, verifyWithPublicKeyHex } from '../src/core/ledger/keys';
import { DecisionLedger, PhiLeakError, bodyOf, type AppendInput } from '../src/core/ledger/ledger';
import { GENESIS_HASH } from '../src/core/types';

const AGENTS = ['case_ops', 'treasury', 'scheduler'] as const;

function makeLedger(): { ledger: DecisionLedger; keys: Keyring } {
  const keys = Keyring.fixture(AGENTS);
  return { ledger: new DecisionLedger(keys, new TickClock('2026-07-14T09:00:00Z')), keys };
}

function entry(caseId: string, n = 0): AppendInput {
  return {
    case_id: caseId,
    agent: 'case_ops',
    kind: 'decision',
    decision: { stage: 'test', n },
    inputs_hash: sha256Hex(`in${n}`),
    output_hash: sha256Hex(`out${n}`),
  };
}

describe('Ed25519 keyring', () => {
  it('fixture keyrings are deterministic across processes (same seeds ⇒ same keys)', () => {
    const a = Keyring.fixture(['case_ops']);
    const b = Keyring.fixture(['case_ops']);
    expect(a.get('case_ops').publicKeyHex).toBe(b.get('case_ops').publicKeyHex);
    expect(a.mode).toBe('FIXTURE_DEV_KEYS');
  });

  it('different agents get different keys', () => {
    const ring = Keyring.fixture(['case_ops', 'treasury']);
    expect(ring.get('case_ops').publicKeyHex).not.toBe(ring.get('treasury').publicKeyHex);
  });

  it('sign/verify round-trips and rejects the wrong signer', () => {
    const ring = Keyring.fixture(['case_ops', 'treasury']);
    const msg = Buffer.from('deadbeef', 'hex');
    const sig = ring.sign('case_ops', msg);
    expect(ring.verify('case_ops', msg, sig)).toBe(true);
    expect(ring.verify('treasury', msg, sig)).toBe(false);
  });

  it('verifyWithPublicKeyHex works standalone and fails safe on junk keys', () => {
    const ring = Keyring.fixture(['case_ops']);
    const msg = Buffer.from('00ff00ff', 'hex');
    const sig = ring.sign('case_ops', msg);
    expect(verifyWithPublicKeyHex(ring.get('case_ops').publicKeyHex, msg, sig)).toBe(true);
    expect(verifyWithPublicKeyHex('deadbeef', msg, sig)).toBe(false);
  });

  it('ephemeral keyrings differ run to run', () => {
    const a = Keyring.ephemeral(['x']);
    const b = Keyring.ephemeral(['x']);
    expect(a.get('x').publicKeyHex).not.toBe(b.get('x').publicKeyHex);
  });

  it('rejects duplicate key ids and unknown lookups', () => {
    const ring = Keyring.fixture(['x']);
    expect(() => ring.addFromSeed('x', Buffer.alloc(32, 7))).toThrow(/duplicate/);
    expect(() => ring.get('nope')).toThrow(/unknown key/);
    expect(() => ring.addFromSeed('short', Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('DecisionLedger — hash chain (I3)', () => {
  it('genesis entry links to the all-zero hash', () => {
    const { ledger } = makeLedger();
    const e = ledger.append(entry('case_a'));
    expect(e.prev_hash).toBe(GENESIS_HASH);
    expect(e.seq).toBe(0);
    expect(e.gseq).toBe(0);
  });

  it('entry_hash = SHA-256(prev_hash ∥ canonical_json(body)) exactly', () => {
    const { ledger } = makeLedger();
    const e = ledger.append(entry('case_a'));
    expect(e.entry_hash).toBe(sha256Hex(e.prev_hash + canonicalJson(bodyOf(e))));
  });

  it('per-case chains are independent; gseq is global', () => {
    const { ledger } = makeLedger();
    const a0 = ledger.append(entry('case_a', 0));
    const b0 = ledger.append(entry('case_b', 1));
    const a1 = ledger.append(entry('case_a', 2));
    expect(a0.seq).toBe(0);
    expect(b0.seq).toBe(0);
    expect(a1.seq).toBe(1);
    expect(a1.prev_hash).toBe(a0.entry_hash);
    expect(b0.prev_hash).toBe(GENESIS_HASH);
    expect([a0.gseq, b0.gseq, a1.gseq]).toEqual([0, 1, 2]);
  });

  it('signatures verify against the acting agent key over the raw entry_hash', () => {
    const { ledger, keys } = makeLedger();
    const e = ledger.append({ ...entry('case_a'), agent: 'treasury' });
    expect(e.key_id).toBe('treasury');
    expect(keys.verify('treasury', Buffer.from(e.entry_hash, 'hex'), e.sig)).toBe(true);
    expect(keys.verify('case_ops', Buffer.from(e.entry_hash, 'hex'), e.sig)).toBe(false);
  });

  it('entries are frozen (append-only, no in-place mutation)', () => {
    const { ledger } = makeLedger();
    const e = ledger.append(entry('case_a'));
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as { ts: string }).ts = '1999-01-01T00:00:00Z';
    }).toThrow();
  });

  it('rejects agents without signing keys', () => {
    const { ledger } = makeLedger();
    expect(() => ledger.append({ ...entry('c'), agent: 'drafter' })).toThrow(/no signing key/);
  });

  it('timestamps are monotonic under the tick clock and byte-deterministic', () => {
    const build = (): string[] => {
      const keys = Keyring.fixture(AGENTS);
      const led = new DecisionLedger(keys, new TickClock('2026-07-14T09:00:00Z'));
      led.append(entry('case_a', 0));
      led.append(entry('case_a', 1));
      return led.all().map((e) => JSON.stringify(e));
    };
    const run1 = build();
    const run2 = build();
    expect(run1).toEqual(run2); // fixture keys + tick clock ⇒ identical bytes
  });
});

describe('DecisionLedger — PHI guard (I4)', () => {
  it.each([
    ['SSN', { note: 'member ssn 123-45-6789' }],
    ['email', { contact: 'maria.delgado@example.test' }],
    ['phone', { contact: 'call (512) 555-0142' }],
    ['labeled DOB', { line: 'DOB: 03/14/2019' }],
    ['labeled member id', { line: 'Member ID: W00482210' }],
  ])('fails closed when raw %s appears in a decision payload', (_kind, decision) => {
    const { ledger } = makeLedger();
    expect(() => ledger.append({ ...entry('case_a'), decision })).toThrow(PhiLeakError);
    expect(ledger.length).toBe(0); // nothing was appended
  });

  it('accepts redacted placeholders and case facts (dates, hashes, amounts)', () => {
    const { ledger } = makeLedger();
    const e = ledger.append({
      ...entry('case_a'),
      decision: {
        member: '[REDACTED:NAME]',
        contact: '[REDACTED:PHONE] [REDACTED:EMAIL]',
        denial_date: '2026-06-26',
        deadline: '2026-08-25',
        amount_usd_cents: 4900,
        artifact: sha256Hex('draft'),
      },
    });
    expect(e.seq).toBe(0);
  });
});

describe('DecisionLedger — export', () => {
  it('exports JSONL (one parseable entry per line) + manifest with keyring and roots', () => {
    const { ledger } = makeLedger();
    ledger.append(entry('case_a', 0));
    ledger.append(entry('case_b', 1));
    const { jsonl, manifest } = ledger.export();
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).case_id).toBe('case_a');
    expect(manifest.entry_count).toBe(2);
    expect(manifest.key_mode).toBe('FIXTURE_DEV_KEYS');
    expect(Object.keys(manifest.keyring).sort()).toEqual([...AGENTS].sort());
    expect(Object.keys(manifest.merkle_roots)).toEqual(['2026-07-14']);
  });

  it('tail/forCase/merkleRoots helpers behave', () => {
    const { ledger } = makeLedger();
    ledger.append(entry('a', 0));
    ledger.append(entry('b', 1));
    ledger.append(entry('a', 2));
    expect(ledger.tail(2).map((e) => e.case_id)).toEqual(['b', 'a']);
    expect(ledger.forCase('a')).toHaveLength(2);
    expect(Object.keys(ledger.merkleRoots())).toHaveLength(1);
  });
});
