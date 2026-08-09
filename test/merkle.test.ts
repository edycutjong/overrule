import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMPTY_TREE_ROOT, dailyMerkleRoots, merkleRoot } from '../src/core/ledger/merkle';

const h = (s: string): string => createHash('sha256').update(s).digest('hex');
const parent = (a: string, b: string): string =>
  createHash('sha256')
    .update(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')]))
    .digest('hex');

describe('merkleRoot', () => {
  const l1 = h('leaf1');
  const l2 = h('leaf2');
  const l3 = h('leaf3');

  it('empty input yields the documented empty-tree constant', () => {
    expect(merkleRoot([])).toBe(EMPTY_TREE_ROOT);
    expect(EMPTY_TREE_ROOT).toBe(h(''));
  });

  it('single leaf is its own root', () => {
    expect(merkleRoot([l1])).toBe(l1);
  });

  it('two leaves hash pairwise', () => {
    expect(merkleRoot([l1, l2])).toBe(parent(l1, l2));
  });

  it('odd leaf is PROMOTED (not duplicated)', () => {
    expect(merkleRoot([l1, l2, l3])).toBe(parent(parent(l1, l2), l3));
  });

  it('root is order-sensitive', () => {
    expect(merkleRoot([l1, l2])).not.toBe(merkleRoot([l2, l1]));
  });

  it('root changes when any leaf changes', () => {
    expect(merkleRoot([l1, l2, l3])).not.toBe(merkleRoot([l1, l2, h('leaf3-tampered')]));
  });

  it('rejects non-32-byte-hex leaves', () => {
    expect(() => merkleRoot(['abcd'])).toThrow(/32-byte hex/);
  });
});

describe('dailyMerkleRoots', () => {
  it('groups by UTC day and orders leaves by gseq', () => {
    const e = (gseq: number, ts: string, seed: string) => ({ gseq, ts, entry_hash: h(seed) });
    const roots = dailyMerkleRoots([
      e(2, '2026-07-14T23:59:59Z', 'c'),
      e(0, '2026-07-14T00:00:00Z', 'a'),
      e(1, '2026-07-14T12:00:00Z', 'b'),
      e(3, '2026-07-15T00:00:00Z', 'd'),
    ]);
    expect(Object.keys(roots).sort()).toEqual(['2026-07-14', '2026-07-15']);
    expect(roots['2026-07-14']).toBe(merkleRoot([h('a'), h('b'), h('c')]));
    expect(roots['2026-07-15']).toBe(h('d'));
  });

  it('rejects malformed timestamps', () => {
    expect(() => dailyMerkleRoots([{ gseq: 0, ts: 'not-a-date', entry_hash: h('x') }])).toThrow(/bad ts/);
  });
});
