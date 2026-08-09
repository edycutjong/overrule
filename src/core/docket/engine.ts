/**
 * Docket engine — deadline math from versioned rulepacks (COMPLEXITY §1 CaseOps,
 * §4 invariant I1). Produces the DocketPlan CaseOps registers via the
 * mandate-gated `docket_set` actuator.
 *
 * Filing-deadline reconciliation: denial letters often state their own appeal
 * window; the binding deadline is the EARLIER of the letter-stated date and the
 * rulepack-computed date (never trust the later one), with the basis recorded.
 */
import type { DenialFacts, DocketPlan } from '../types';
import { addDays, assertIsoDate, daysBetween, datePart, endOfDayUtc, minDate } from './dates';
import { rulepackRef, type Rulepack } from './rulepack';

export interface DocketEngineOptions {
  /** Deadlines closer than this many days ⇒ rush handling. */
  rushThresholdDays: number;
  /** File this many days before the true deadline (safety margin for mail). */
  fileLeadDays: number;
  /** Grace days on top of the payer's decision window before we chase. */
  payerResponseGraceDays: number;
}

export const DEFAULT_DOCKET_OPTIONS: DocketEngineOptions = {
  rushThresholdDays: 14,
  fileLeadDays: 7,
  payerResponseGraceDays: 3,
};

export interface FilingDeadline {
  deadline: string; // ISO date
  basis: 'letter_stated' | 'rulepack';
  rulepack_deadline: string;
  days_remaining: number;
  rush: boolean;
}

/** The binding internal-L1 filing deadline for a case, reconciled + rush-flagged. */
export function filingDeadline(
  facts: Pick<DenialFacts, 'denial_date' | 'stated_deadline'>,
  rulepack: Rulepack,
  nowIso: string,
  opts: DocketEngineOptions = DEFAULT_DOCKET_OPTIONS,
): FilingDeadline {
  assertIsoDate(facts.denial_date);
  const rulepackDeadline = addDays(facts.denial_date, rulepack.internal_appeal.level1_window_days);
  let deadline = rulepackDeadline;
  let basis: FilingDeadline['basis'] = 'rulepack';
  if (facts.stated_deadline !== null) {
    assertIsoDate(facts.stated_deadline);
    const earlier = minDate(facts.stated_deadline, rulepackDeadline);
    if (earlier === facts.stated_deadline && facts.stated_deadline !== rulepackDeadline) {
      basis = 'letter_stated';
    }
    deadline = earlier;
  }
  const today = datePart(nowIso);
  const days_remaining = daysBetween(today, deadline);
  if (days_remaining < 0) {
    throw new DeadlinePassedError(`internal appeal deadline ${deadline} already passed as of ${today}`);
  }
  return {
    deadline,
    basis,
    rulepack_deadline: rulepackDeadline,
    days_remaining,
    rush: days_remaining < opts.rushThresholdDays,
  };
}

export class DeadlinePassedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DeadlinePassedError';
  }
}

/**
 * Build the docket plan at filing time (case_ops calls this the moment the
 * appeal is mailed). `filedAtIso` anchors the payer-response and follow-up clocks.
 */
export function buildDocketPlan(
  caseId: string,
  facts: Pick<DenialFacts, 'denial_date' | 'stated_deadline'>,
  rulepack: Rulepack,
  filedAtIso: string,
  opts: DocketEngineOptions = DEFAULT_DOCKET_OPTIONS,
): DocketPlan {
  const fd = filingDeadline(facts, rulepack, filedAtIso, opts);
  const filedDate = datePart(filedAtIso);

  // File-by target: lead-days before the binding deadline, but never in the past.
  const fileByTarget = addDays(fd.deadline, -opts.fileLeadDays);
  const fileBy = daysBetween(filedDate, fileByTarget) < 0 ? filedDate : fileByTarget;

  const payerResponseBy = addDays(filedDate, rulepack.internal_appeal.payer_decision_days + opts.payerResponseGraceDays);
  const firstFollowup = addDays(filedDate, rulepack.follow_up.first_check_days);

  return {
    case_id: caseId,
    state: rulepack.state,
    rulepack_ref: rulepackRef(rulepack),
    rush: fd.rush,
    filing_deadline: fd.deadline,
    filing_deadline_basis: fd.basis,
    items: [
      {
        kind: 'internal_l1_file',
        due_at: endOfDayUtc(fileBy),
        created_at: filedAtIso,
        rush: fd.rush,
      },
      {
        kind: 'followup_check',
        due_at: endOfDayUtc(firstFollowup),
        created_at: filedAtIso,
        rush: fd.rush,
      },
      {
        kind: 'payer_response_check',
        due_at: endOfDayUtc(payerResponseBy),
        created_at: filedAtIso,
        rush: fd.rush,
      },
    ],
  };
}

/** External-review window once the payer's final adverse determination lands. */
export function externalReviewDeadline(finalAdverseDate: string, rulepack: Rulepack): string {
  assertIsoDate(finalAdverseDate);
  return addDays(finalAdverseDate, rulepack.external_review.window_days);
}
