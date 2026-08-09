import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays, assertIsoDate, daysBetween, endOfDayUtc, minDate } from '../src/core/docket/dates';
import {
  DeadlinePassedError,
  buildDocketPlan,
  externalReviewDeadline,
  filingDeadline,
} from '../src/core/docket/engine';
import { RulepackError, loadRulepacksFromDir, rulepackRef, validateRulepack } from '../src/core/docket/rulepack';
import { RULEPACK_DIR } from '../src/core/world';

const NOW = '2026-07-14T09:00:00Z';

function loadTx(): ReturnType<typeof validateRulepack> {
  return validateRulepack(JSON.parse(readFileSync(join(RULEPACK_DIR, 'TX@2026-07.json'), 'utf8')));
}

describe('date math', () => {
  it('addDays handles month and year rollovers', () => {
    expect(addDays('2026-06-26', 60)).toBe('2026-08-25'); // the maria letter window
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
    expect(addDays('2026-07-14', -14)).toBe('2026-06-30');
  });

  it('addDays handles leap years', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('daysBetween is signed and exact', () => {
    expect(daysBetween('2026-07-14', '2026-08-25')).toBe(42);
    expect(daysBetween('2026-08-25', '2026-07-14')).toBe(-42);
    expect(daysBetween('2026-07-14', '2026-07-14')).toBe(0);
  });

  it('assertIsoDate rejects malformed and non-existent dates', () => {
    expect(() => assertIsoDate('2026-02-30')).toThrow(/non-existent/);
    expect(() => assertIsoDate('26-02-01')).toThrow(/ISO date/);
    expect(() => assertIsoDate('2026-13-01')).toThrow();
  });

  it('endOfDayUtc and minDate behave', () => {
    expect(endOfDayUtc('2026-08-25')).toBe('2026-08-25T23:59:59Z');
    expect(minDate('2026-08-25', '2026-12-23')).toBe('2026-08-25');
    expect(minDate('2026-12-23', '2026-08-25')).toBe('2026-08-25');
  });
});

describe('rulepack schema', () => {
  it('loads and validates the three fixture packs (TX/CA/NY)', () => {
    const packs = loadRulepacksFromDir(RULEPACK_DIR);
    expect([...packs.keys()].sort()).toEqual(['CA', 'NY', 'TX']);
    const tx = packs.get('TX')!;
    expect(tx.fixture).toBe(true);
    expect(tx.internal_appeal.level1_window_days).toBe(180);
    expect(rulepackRef(tx)).toBe('TX@2026-07-fixture');
  });

  it('rejects wrong schema tag, bad state, and missing sections', () => {
    const good = JSON.parse(readFileSync(join(RULEPACK_DIR, 'TX@2026-07.json'), 'utf8'));
    expect(() => validateRulepack({ ...good, schema: 'v2' })).toThrow(RulepackError);
    expect(() => validateRulepack({ ...good, state: 'FL' })).toThrow(/state/);
    const { internal_appeal: _ia, ...missing } = good;
    expect(() => validateRulepack(missing)).toThrow(/internal_appeal/);
  });

  it('rejects non-positive windows and fixture packs without a provenance note', () => {
    const good = JSON.parse(readFileSync(join(RULEPACK_DIR, 'TX@2026-07.json'), 'utf8'));
    expect(() =>
      validateRulepack({ ...good, internal_appeal: { ...good.internal_appeal, level1_window_days: 0 } }),
    ).toThrow(/positive integer/);
    const { fixture_note: _note, ...noNote } = good;
    expect(() => validateRulepack(noNote)).toThrow(/fixture_note/);
  });
});

describe('filingDeadline — letter vs rulepack reconciliation', () => {
  it('maria_asthma: letter-stated 60-day window beats the 180-day rulepack (42 days left)', () => {
    const fd = filingDeadline({ denial_date: '2026-06-26', stated_deadline: '2026-08-25' }, loadTx(), NOW);
    expect(fd.deadline).toBe('2026-08-25');
    expect(fd.basis).toBe('letter_stated');
    expect(fd.rulepack_deadline).toBe('2026-12-23');
    expect(fd.days_remaining).toBe(42);
    expect(fd.rush).toBe(false);
  });

  it('silent letter ⇒ rulepack basis', () => {
    const fd = filingDeadline({ denial_date: '2026-06-20', stated_deadline: null }, loadTx(), NOW);
    expect(fd.deadline).toBe('2026-12-17');
    expect(fd.basis).toBe('rulepack');
  });

  it('letter-stated LATER than the rulepack is never trusted (earlier wins)', () => {
    const fd = filingDeadline({ denial_date: '2026-06-20', stated_deadline: '2027-06-20' }, loadTx(), NOW);
    expect(fd.deadline).toBe('2026-12-17');
    expect(fd.basis).toBe('rulepack');
  });

  it('rush boundary values are exact (<14 days ⇒ rush; exactly 14 ⇒ not)', () => {
    const at13 = filingDeadline({ denial_date: '2026-07-01', stated_deadline: '2026-07-27' }, loadTx(), NOW);
    expect(at13.days_remaining).toBe(13);
    expect(at13.rush).toBe(true);
    const at14 = filingDeadline({ denial_date: '2026-07-01', stated_deadline: '2026-07-28' }, loadTx(), NOW);
    expect(at14.days_remaining).toBe(14);
    expect(at14.rush).toBe(false);
  });

  it('throws DeadlinePassedError when the binding deadline already passed', () => {
    expect(() => filingDeadline({ denial_date: '2026-01-02', stated_deadline: '2026-03-03' }, loadTx(), NOW)).toThrow(
      DeadlinePassedError,
    );
  });
});

describe('buildDocketPlan', () => {
  it('produces filing + follow-up + payer-response clocks anchored to filing time', () => {
    const plan = buildDocketPlan('case_x', { denial_date: '2026-06-26', stated_deadline: '2026-08-25' }, loadTx(), NOW);
    const byKind = Object.fromEntries(plan.items.map((i) => [i.kind, i]));
    expect(plan.items).toHaveLength(3);
    expect(plan.filing_deadline).toBe('2026-08-25');
    expect(plan.filing_deadline_basis).toBe('letter_stated');
    expect(plan.rush).toBe(false);
    expect(byKind.internal_l1_file!.due_at).toBe('2026-08-18T23:59:59Z'); // deadline − 7d lead
    expect(byKind.followup_check!.due_at).toBe('2026-08-04T23:59:59Z'); // filed + 21d
    expect(byKind.payer_response_check!.due_at).toBe('2026-08-16T23:59:59Z'); // filed + 30d + 3d grace
  });

  it('rush case: file-by target in the past clamps to the filing date (deadline_rescue shape)', () => {
    const plan = buildDocketPlan('case_r', { denial_date: '2026-05-20', stated_deadline: '2026-07-19' }, loadTx(), NOW);
    expect(plan.rush).toBe(true);
    const filing = plan.items.find((i) => i.kind === 'internal_l1_file')!;
    expect(filing.due_at).toBe('2026-07-14T23:59:59Z'); // deadline−7d = Jul 12 (past) → clamp to today
    expect(filing.rush).toBe(true);
  });

  it('externalReviewDeadline adds the state window to the final adverse determination', () => {
    expect(externalReviewDeadline('2026-09-01', loadTx())).toBe('2026-12-30'); // TX fixture: 120d
  });
});
