import { describe, expect, it } from 'vitest';
import {
  applySpans,
  detectPhi,
  findRegexSpans,
  mergeSpans,
  scrub,
  scrubWithProvider,
} from '../src/core/redact/scrubber';
import type { PiiSpan } from '../src/core/types';

describe('regex layer — machine-shaped PII', () => {
  it('scrubs hyphenated SSNs', () => {
    expect(scrub('ssn 123-45-6789 end').text).toBe('ssn [REDACTED:SSN] end');
  });

  it('scrubs labeled bare-9-digit SSNs but leaves unlabeled 9-digit numbers', () => {
    expect(scrub('SSN: 123456789').text).toContain('[REDACTED:SSN]');
    expect(scrub('claim number 123456789').text).toBe('claim number 123456789');
  });

  it('scrubs labeled DOBs in numeric and ISO forms', () => {
    expect(scrub('DOB: 03/14/2019').text).toBe('DOB: [REDACTED:DOB]');
    expect(scrub('Date of Birth: 2019-03-14').text).toBe('Date of Birth: [REDACTED:DOB]');
    expect(scrub('Born: January 3, 1990').text).toBe('Born: [REDACTED:DOB]');
  });

  it('leaves bare dates alone — deadlines are case-critical facts', () => {
    const s = 'appeal by August 25, 2026 or 2026-08-25 or 8/25/2026';
    expect(scrub(s).text).toBe(s);
  });

  it('scrubs labeled member IDs (several label variants) and keeps the label', () => {
    expect(scrub('Member ID: W00482210').text).toBe('Member ID: [REDACTED:MEMBER_ID]');
    expect(scrub('Member No.: BC-0091-7745').text).toBe('Member No.: [REDACTED:MEMBER_ID]');
    expect(scrub('Subscriber ID: AB12345XYZ').text).toBe('Subscriber ID: [REDACTED:MEMBER_ID]');
  });

  it('leaves unlabeled alphanumeric tokens alone', () => {
    expect(scrub('document W00482210 attached').text).toBe('document W00482210 attached');
  });

  it('scrubs phone number formats', () => {
    expect(scrub('call (512) 555-0142 now').text).toBe('call [REDACTED:PHONE] now');
    expect(scrub('call 512-555-0142 now').text).toBe('call [REDACTED:PHONE] now');
    expect(scrub('call +1 512 555 0142 now').text).toBe('call [REDACTED:PHONE] now');
  });

  it('scrubs emails', () => {
    expect(scrub('write maria.delgado@example.test today').text).toBe('write [REDACTED:EMAIL] today');
  });

  it('does not fire on ISO datelike or hash-like strings', () => {
    const s = 'row 2026-07-14T09:00:00Z hash e3b0c44298fc1c149afbf4c8996fb924 amount 4900';
    expect(findRegexSpans(s)).toEqual([]);
  });

  it('placeholders are not re-flagged (detector is placeholder-safe)', () => {
    const once = scrub('SSN 123-45-6789, phone (512) 555-0142, mail a@b.test').text;
    expect(detectPhi(once)).toBeNull();
    expect(scrub(once).text).toBe(once); // idempotent
  });
});

describe('span algebra', () => {
  it('mergeSpans absorbs overlaps (earlier-starting span wins)', () => {
    const merged = mergeSpans([
      { start: 5, end: 12, kind: 'name' },
      { start: 10, end: 20, kind: 'email' },
      { start: 30, end: 34, kind: 'ssn' },
    ]);
    expect(merged).toEqual([
      { start: 5, end: 20, kind: 'name' },
      { start: 30, end: 34, kind: 'ssn' },
    ]);
  });

  it('applySpans replaces right-to-left so indices stay valid', () => {
    const text = 'AA BBBB CC';
    const spans: PiiSpan[] = [
      { start: 0, end: 2, kind: 'name' },
      { start: 3, end: 7, kind: 'email' },
    ];
    expect(applySpans(text, spans)).toBe('[REDACTED:NAME] [REDACTED:EMAIL] CC');
  });
});

describe('pluggable LLM span provider', () => {
  it('merges provider spans (names) with regex spans', async () => {
    const text = 'Maria Delgado, SSN 123-45-6789';
    const provider = {
      findSpans: async (t: string): Promise<PiiSpan[]> => [
        { start: t.indexOf('Maria Delgado'), end: t.indexOf('Maria Delgado') + 'Maria Delgado'.length, kind: 'name' },
      ],
    };
    const { text: out } = await scrubWithProvider(text, provider);
    expect(out).toBe('[REDACTED:NAME], SSN [REDACTED:SSN]');
  });

  it('rejects invalid provider spans (fail closed, no silent clamping)', async () => {
    const bad = { findSpans: async (): Promise<PiiSpan[]> => [{ start: 5, end: 99999, kind: 'name' }] };
    await expect(scrubWithProvider('short text', bad)).rejects.toThrow(/invalid span/);
  });

  it('detectPhi reports the first hit kind and null when clean', () => {
    expect(detectPhi('nothing here, deadline 2026-08-25')).toBeNull();
    expect(detectPhi('reach me at x@y.test')).toEqual({ kind: 'email' });
  });
});
