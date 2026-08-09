/**
 * Golden eval runner (COMPLEXITY §5). Checks, per fixture case:
 *   1. redaction — NO ground-truth PII string survives scrubbing (real logic);
 *   2. triage accept/decline + p_win vs ground truth;
 *   3. extraction fields vs ground truth (payer/code/dates/state/service/plan);
 *   4. docket engine — binding deadline, basis, days-remaining, rush flag
 *      recomputed by the ENGINE and compared to hand-computed expectations
 *      (this is genuine deadline-math coverage, ±0 days tolerated);
 *   5. winning-clause locator (section + page) for accept cases.
 *
 * HONESTY NOTE: with the DeterministicMockAdapter, steps 2/3/5 measure the
 * harness + fixture integrity (the mock answers from ground truth), while
 * steps 1/4 exercise real scrubber/engine logic. Real-model F1 is the online
 * path (deferred). The report says which is which.
 */
import { filingDeadline } from './docket/engine';
import type { Rulepack } from './docket/rulepack';
import { findRegexSpans, scrubWithProvider } from './redact/scrubber';
import type { GeminiAdapter } from './pipeline/adapter';
import type { FixtureSet } from '../fixtures/index';
import type { USState } from './types';

export interface EvalCaseResult {
  id: string;
  ok: boolean;
  field_checks: number;
  field_matches: number;
  mismatches: string[];
  redaction_leaks: string[];
}

export interface EvalReport {
  cases: number;
  ok_cases: number;
  field_checks: number;
  field_matches: number;
  /** exact-match F1 over checked fields (precision == recall here). */
  f1: number;
  deadline_abs_err_days_max: number;
  redaction_leak_count: number;
  results: EvalCaseResult[];
}

export async function runGoldenEval(
  fixtures: FixtureSet,
  adapter: GeminiAdapter,
  rulepacks: Map<USState, Rulepack>,
  nowIso: string,
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  let deadlineErrMax = 0;

  for (const c of fixtures.cases) {
    const t = c.truth;
    const mismatches: string[] = [];
    const redaction_leaks: string[] = [];
    let checks = 0;
    let matches = 0;
    const check = (name: string, got: unknown, want: unknown): void => {
      checks += 1;
      if (Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)) matches += 1;
      else mismatches.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };

    // 1 — redaction (real scrubber + adapter spans)
    const { text: redacted } = await scrubWithProvider(c.raw_letter, {
      findSpans: (x) => adapter.findPiiSpans(x),
    });
    const piiValues: [string, string | null][] = [
      ['patient_name', t.pii.patient_name],
      ['member_id', t.pii.member_id],
      ['dob', t.pii.dob],
      ['phone', t.pii.phone],
      ['email', t.pii.email],
      ['ssn', t.pii.ssn],
    ];
    for (const [kind, value] of piiValues) {
      if (value !== null && redacted.includes(value)) redaction_leaks.push(`${kind} survived scrub`);
    }
    if (findRegexSpans(redacted).length > 0) redaction_leaks.push('regex detector still fires on scrubbed text');

    // 2 — triage
    const triage = await adapter.triage({ redacted_letter: redacted });
    check('triage.accept', triage.accept, t.expect_accept);
    check('triage.p_win', triage.p_win, t.p_win);

    // 3 — extraction fields
    const planText = fixtures.docs[t.plan_doc_id]!;
    const facts = await adapter.extractEvidence({ redacted_letter: redacted, plan_text: planText });
    check('facts.payer', facts.payer, t.payer);
    check('facts.denial_code', facts.denial_code, t.denial_code);
    check('facts.denial_date', facts.denial_date, t.denial_date);
    check('facts.stated_deadline', facts.stated_deadline, t.stated_deadline);
    check('facts.state', facts.state, t.us_state);
    check('facts.service', facts.service, t.service);
    check('facts.plan_doc_id', facts.plan_doc_id, t.plan_doc_id);

    // 4 — docket engine (REAL deadline math vs hand-computed truth)
    const rp = rulepacks.get(t.us_state);
    if (!rp) throw new Error(`eval: no rulepack for ${t.us_state}`);
    const fd = filingDeadline(facts, rp, nowIso);
    check('docket.binding_deadline', fd.deadline, t.expected_binding_deadline);
    check('docket.basis', fd.basis, t.expected_basis);
    check('docket.days_remaining', fd.days_remaining, t.expected_days_remaining);
    check('docket.rush', fd.rush, t.expected_rush);
    deadlineErrMax = Math.max(
      deadlineErrMax,
      Math.abs(
        (Date.parse(`${fd.deadline}T00:00:00Z`) - Date.parse(`${t.expected_binding_deadline}T00:00:00Z`)) / 86_400_000,
      ),
    );

    // 5 — winning-clause locator (accept cases)
    if (t.expect_accept && t.winning) {
      const clauses = await adapter.suggestClauses({ facts, plan_text: planText });
      check('clause.section', clauses[0]?.section, t.winning.section);
      check('clause.page', clauses[0]?.page, t.winning.page);
    }

    results.push({
      id: c.id,
      ok: mismatches.length === 0 && redaction_leaks.length === 0,
      field_checks: checks,
      field_matches: matches,
      mismatches,
      redaction_leaks,
    });
  }

  const field_checks = results.reduce((a, r) => a + r.field_checks, 0);
  const field_matches = results.reduce((a, r) => a + r.field_matches, 0);
  return {
    cases: results.length,
    ok_cases: results.filter((r) => r.ok).length,
    field_checks,
    field_matches,
    f1: field_checks === 0 ? 0 : field_matches / field_checks,
    deadline_abs_err_days_max: deadlineErrMax,
    redaction_leak_count: results.reduce((a, r) => a + r.redaction_leaks.length, 0),
    results,
  };
}
