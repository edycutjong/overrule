import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical, sha256Hex } from '../src/core/canonical';

describe('canonicalJson', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys recursively in nested objects', () => {
    expect(canonicalJson({ z: { d: 1, c: [{ b: 2, a: 3 }] }, a: 0 })).toBe('{"a":0,"z":{"c":[{"a":3,"b":2}],"d":1}}');
  });

  it('is insensitive to property insertion order', () => {
    const x: Record<string, unknown> = {};
    x.later = 1;
    x.earlier = 2;
    const y: Record<string, unknown> = {};
    y.earlier = 2;
    y.later = 1;
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it('encodes primitives and empty containers', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('serializes -0 as 0', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  it('omits undefined object properties (like JSON.stringify)', () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
  });

  it('rejects undefined inside arrays', () => {
    expect(() => canonicalJson([1, undefined, 3])).toThrow(TypeError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
  });

  it('rejects bigint, function and symbol', () => {
    expect(() => canonicalJson(1n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol('x'))).toThrow(TypeError);
  });

  it('rejects cyclic structures', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/cyclic/);
  });

  it('rejects Dates, Maps and Sets (must be pre-encoded)', () => {
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => canonicalJson(new Set())).toThrow(TypeError);
  });

  it('allows the same (acyclic) object to appear twice', () => {
    const shared = { k: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"k":1},{"k":1}]');
  });

  it('preserves unicode content through JSON escaping rules', () => {
    expect(canonicalJson({ s: '§4.3 — ünïcode' })).toBe('{"s":"§4.3 — ünïcode"}');
  });
});

describe('sha256 helpers', () => {
  it('sha256Hex matches the known empty-string digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashCanonical is stable across key order', () => {
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
  });
});
