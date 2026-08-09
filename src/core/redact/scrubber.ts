/**
 * Redaction scrubber (COMPLEXITY §2 — redaction-before-persistence, I4).
 *
 * Two layers:
 *  1. Deterministic regex layer for machine-shaped PII: SSN, DOB (labeled),
 *     member IDs (labeled), phone numbers, emails.
 *  2. A pluggable SpanProvider interface for LLM-extracted spans (names,
 *     addresses — things regexes cannot catch). The DeterministicMockAdapter
 *     supplies fixture spans in tests; the real Gemini adapter supplies
 *     structured span extraction in production.
 *
 * Replacement is typed and stable: `[REDACTED:SSN]`, `[REDACTED:DOB]`, …
 * `detectPhi` is the guard the ledger uses to fail closed (PhiLeakError).
 *
 * Deliberate scope notes (honest):
 *  - Bare dates NOT labeled as DOB survive — denial dates and deadlines are
 *    case-critical facts, so only birth-labeled dates are scrubbed.
 *  - Unlabeled names/addresses are the LLM layer's job; the regex layer makes
 *    no claim to catch them.
 */
import type { PiiKind, PiiSpan } from '../types';

export interface SpanProvider {
  /** Return PII spans over the RAW text (the only place raw text is allowed). */
  findSpans(text: string): Promise<PiiSpan[]>;
}

export const REDACTION_PLACEHOLDER = /\[REDACTED:[A-Z_]+\]/;

interface PatternDef {
  kind: PiiKind;
  re: RegExp;
  /** If set, only this capture group index is redacted (label survives). */
  group?: number;
}

// NOTE: all regexes are applied with /g in a fresh lastIndex pass each call.
const PATTERNS: PatternDef[] = [
  // SSN: 123-45-6789 or labeled bare 9 digits ("SSN: 123456789")
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'ssn', re: /\b(?:SSN|Social Security(?: Number| No\.?)?)[:# ]\s*(\d{9})\b/gi, group: 1 },
  // DOB: only when labeled — bare dates must survive (deadlines!).
  {
    kind: 'dob',
    re: /\b(?:DOB|Date of Birth|Born)[:\s]+((?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4})|(?:\d{4}-\d{2}-\d{2})|(?:[A-Z][a-z]+ \d{1,2},? \d{4}))/g,
    group: 1,
  },
  // Member / subscriber IDs: labeled alphanumeric tokens.
  {
    kind: 'member_id',
    re: /\b(?:Member ID|Member No\.?|Subscriber ID|Policy ID|Member #)[:\s]+([A-Z0-9][A-Z0-9-]{5,17})\b/gi,
    group: 1,
  },
  // Phones: (512) 555-0142 · 512-555-0142 · +1 512 555 0142
  { kind: 'phone', re: /(?:\+1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b/g },
  // Emails
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

function placeholderFor(kind: PiiKind): string {
  return `[REDACTED:${kind.toUpperCase()}]`;
}

/** Regex layer: find machine-shaped PII spans in raw text. */
export function findRegexSpans(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const def of PATTERNS) {
    def.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = def.re.exec(text)) !== null) {
      if (def.group !== undefined) {
        const g = m[def.group];
        if (g === undefined) continue;
        const start = m.index + m[0].indexOf(g);
        spans.push({ start, end: start + g.length, kind: def.kind });
      } else {
        spans.push({ start: m.index, end: m.index + m[0].length, kind: def.kind });
      }
      if (m[0].length === 0) def.re.lastIndex++; // safety against zero-width loops
    }
  }
  return spans;
}

/** Merge overlapping spans; on overlap the earlier-starting (then longer) span wins. */
export function mergeSpans(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: PiiSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end); // absorb overlap (kind of first span kept)
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Apply spans right-to-left so indices stay valid. */
export function applySpans(text: string, spans: PiiSpan[]): string {
  const merged = mergeSpans(spans);
  let result = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const s = merged[i]!;
    result = result.slice(0, s.start) + placeholderFor(s.kind) + result.slice(s.end);
  }
  return result;
}

/** Deterministic scrub (regex layer only). */
export function scrub(text: string): { text: string; spans: PiiSpan[] } {
  const spans = mergeSpans(findRegexSpans(text));
  return { text: applySpans(text, spans), spans };
}

/** Full scrub: regex layer + pluggable LLM span provider. */
export async function scrubWithProvider(
  text: string,
  provider: SpanProvider,
): Promise<{ text: string; spans: PiiSpan[] }> {
  const llmSpans = await provider.findSpans(text);
  for (const s of llmSpans) {
    if (s.start < 0 || s.end > text.length || s.start >= s.end) {
      throw new Error(`span provider returned invalid span ${s.start}..${s.end} (${s.kind})`);
    }
  }
  const spans = mergeSpans([...findRegexSpans(text), ...llmSpans]);
  return { text: applySpans(text, spans), spans };
}

/**
 * PHI detector used by the ledger's fail-closed guard (I4).
 * Returns the first hit, or null when clean. Placeholders are not hits.
 */
export function detectPhi(text: string): { kind: PiiKind } | null {
  const spans = findRegexSpans(text);
  return spans.length > 0 ? { kind: spans[0]!.kind } : null;
}
