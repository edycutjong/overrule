/**
 * Canonical JSON serialization — the byte-stable encoding under every
 * entry_hash, signature, and fixture manifest in the ledger (COMPLEXITY §2).
 *
 * Rules:
 *  - object keys sorted lexicographically (code-unit order), recursively
 *  - no insignificant whitespace
 *  - numbers must be finite (NaN/Infinity rejected); -0 serializes as "0"
 *  - undefined object properties are OMITTED (mirrors JSON.stringify)
 *  - undefined inside arrays is REJECTED (would be ambiguous)
 *  - functions, symbols, bigints, and cyclic structures are REJECTED
 */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return encode(value, new WeakSet());
}

function encode(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${value}`);
      }
      return JSON.stringify(value); // -0 → "0"
    case 'undefined':
      throw new TypeError('canonicalJson: undefined is not encodable at top level or in arrays');
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('canonicalJson: cyclic structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => {
        if (item === undefined) throw new TypeError('canonicalJson: undefined inside array');
        return encode(item, seen);
      });
      return `[${parts.join(',')}]`;
    }
    if (obj instanceof Date || obj instanceof Map || obj instanceof Set) {
      throw new TypeError('canonicalJson: encode Dates/Maps/Sets explicitly (use ISO strings / plain objects)');
    }
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${encode(record[k], seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 hex of the canonical JSON encoding of a value. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
