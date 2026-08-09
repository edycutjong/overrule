/**
 * Docket sweep — invariant I1: no deadline may pass without a ledgered action.
 *
 * The sweep (production: Cloud Scheduler 2×/day, double-redundant per
 * PRODUCTION_PLAN) walks every active case and:
 *   - ACTS on every un-acted item due within the look-ahead horizon, so items
 *     are normally actioned BEFORE they fall due;
 *   - if an item is already PAST due when the sweep reaches it (a missed
 *     deadline), it still acts on it AND triggers the SLA bond: the treasury
 *     agent auto-refunds 100% through the mandate gate (COMPLEXITY §3), once
 *     per case, all ledgered;
 *   - follow-up clocks re-arm (recheck_days) until max_silent_followups, then
 *     the case escalates to the state DOI — only with mandate consent (I5);
 *     without consent the follow-up clock re-arms instead (the case may never
 *     go silent).
 *
 * `unactionedPastDue` is the invariant checker: after a sweep it must be empty.
 */
import { hashCanonical } from '../canonical';
import type { DecisionLedger } from '../ledger/ledger';
import { MandateError } from '../mandate/mandate';
import type { MandateGate } from '../mandate/middleware';
import { compareIso } from '../docket/dates';
import type { Rulepack } from '../docket/rulepack';
import type { CaseRecord, Clock, DocketItem, USState } from '../types';
import { CaseMachine } from './machine';

export interface SweepOptions {
  /** Act on items due within this many hours (act BEFORE deadlines fall due). */
  actAheadHours: number;
}
export const DEFAULT_SWEEP_OPTIONS: SweepOptions = { actAheadHours: 24 };

export interface SweepActionRecord {
  case_id: string;
  item_id: string;
  kind: DocketItem['kind'];
  late: boolean;
  action: string;
}

export interface SweepReport {
  at: string;
  cases_scanned: number;
  actions: SweepActionRecord[];
  sla_credits: string[]; // case ids credited this sweep
  escalations: string[]; // case ids escalated this sweep
  escalations_blocked: string[]; // consent missing — followup re-armed instead
  violations_after: PastDueViolation[]; // MUST be empty (I1)
}

export interface PastDueViolation {
  case_id: string;
  item_id: string;
  kind: DocketItem['kind'];
  due_at: string;
}

export interface SweepDeps {
  machine: CaseMachine;
  gate: MandateGate;
  ledger: DecisionLedger;
  clock: Clock;
  rulepacks: Map<USState, Rulepack>;
  options?: SweepOptions;
}

/** I1 checker: every docket item past due must carry an action. */
export function unactionedPastDue(cases: readonly CaseRecord[], nowIso: string): PastDueViolation[] {
  const out: PastDueViolation[] = [];
  for (const rec of cases) {
    for (const item of rec.docket) {
      if (item.acted_at === null && compareIso(item.due_at, nowIso) < 0) {
        out.push({ case_id: rec.id, item_id: item.id, kind: item.kind, due_at: item.due_at });
      }
    }
  }
  return out;
}

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function sweepDockets(cases: CaseRecord[], deps: SweepDeps): Promise<SweepReport> {
  const opts = deps.options ?? DEFAULT_SWEEP_OPTIONS;
  const now = deps.clock.now();
  const horizon = addHours(now, opts.actAheadHours);

  const report: SweepReport = {
    at: now,
    cases_scanned: 0,
    actions: [],
    sla_credits: [],
    escalations: [],
    escalations_blocked: [],
    violations_after: [],
  };

  for (const rec of cases) {
    if (rec.state !== 'DOCKETED' && rec.state !== 'FOLLOWUP') continue;
    report.cases_scanned += 1;
    const rulepack = deps.rulepacks.get(rec.us_state);
    if (!rulepack) throw new Error(`sweep: no rulepack for state ${rec.us_state}`);

    // Snapshot: sweep acts on items present at scan time (re-armed clocks are next sweep's work).
    const due = rec.docket.filter((it) => it.acted_at === null && compareIso(it.due_at, horizon) <= 0);

    for (const item of due) {
      const late = compareIso(item.due_at, now) < 0;

      // --- act on the item (the deadline is now actioned, whatever else happens) ---
      const action = actFor(item);
      item.acted_at = now;
      item.action = action;
      report.actions.push({ case_id: rec.id, item_id: item.id, kind: item.kind, late, action });

      // --- SLA bond on a missed deadline (once per case) ---
      if (late && !rec.sla_credited) {
        if (!rec.mandate) throw new Error(`sweep: case ${rec.id} has no mandate for SLA credit`);
        const { proof } = await deps.gate.stripeRefund(
          rec.mandate,
          { case_id: rec.id, amount_usd_cents: rec.paid_usd_cents, reason: 'sla_credit' },
          'treasury',
        );
        rec.sla_credited = true;
        report.sla_credits.push(rec.id);
        deps.ledger.append({
          case_id: rec.id,
          agent: 'treasury',
          kind: 'sla_credit',
          decision: {
            missed_item_id: item.id,
            missed_kind: item.kind,
            due_at: item.due_at,
            acted_at: now,
            amount_usd_cents: rec.paid_usd_cents,
            refund_proof_gseq: proof.ledger_gseq,
          },
          inputs_hash: hashCanonical({ item_id: item.id, due_at: item.due_at }),
          output_hash: hashCanonical({ sla_credited: true }),
        });
      }

      // --- lifecycle consequences per item kind ---
      if (item.kind === 'followup_check' || item.kind === 'payer_response_check') {
        const silentLimitReached = rec.followups_done + 1 >= rulepack.follow_up.max_silent_followups;
        deps.machine.transition(rec, 'FOLLOWUP_DONE', {
          agent: 'case_ops',
          decision: { item_id: item.id, item_kind: item.kind, late, action },
        });

        if (silentLimitReached) {
          // escalate — only through the gate (consent enforced there, I5)
          try {
            const { proof } = await deps.gate.escalateDoi(
              rec.mandate!,
              { case_id: rec.id, state: rec.us_state, reason: 'payer_silent_after_followups' },
              'case_ops',
            );
            deps.machine.transition(rec, 'ESCALATE', {
              agent: 'case_ops',
              proof,
              decision: { after_followups: rec.followups_done },
            });
            report.escalations.push(rec.id);
          } catch (err) {
            if (err instanceof MandateError && err.code === 'NO_ESCALATION_CONSENT') {
              // No consent: the clock re-arms — the case may never go silent (I1).
              rearmFollowup(rec, item, addDaysIso(now, rulepack.follow_up.recheck_days));
              report.escalations_blocked.push(rec.id);
            } else {
              throw err;
            }
          }
        } else {
          rearmFollowup(rec, item, addDaysIso(now, rulepack.follow_up.recheck_days));
        }
      }
      // internal_l1_file / external_review_window: acting + (if late) SLA credit is
      // the sweep's whole job here; filing itself is the pipeline's responsibility.
    }
  }

  // Sweep heartbeat row on the system chain — continuous-operation evidence.
  deps.ledger.append({
    case_id: '_system',
    agent: 'scheduler',
    kind: 'docket_sweep',
    decision: {
      cases_scanned: report.cases_scanned,
      actions: report.actions.length,
      sla_credits: report.sla_credits.length,
      escalations: report.escalations.length,
    },
    inputs_hash: hashCanonical({ at: now }),
    output_hash: hashCanonical({ actions: report.actions.length }),
  });

  report.violations_after = unactionedPastDue(cases, now);
  return report;
}

function actFor(item: DocketItem): string {
  switch (item.kind) {
    case 'followup_check':
      return 'followup_inquiry_sent';
    case 'payer_response_check':
      return 'payer_response_inquiry_sent';
    case 'internal_l1_file':
      return 'filing_deadline_checkpoint';
    case 'external_review_window':
      return 'external_review_window_checkpoint';
  }
}

function rearmFollowup(rec: CaseRecord, prev: DocketItem, dueAt: string): void {
  rec.docket.push({
    id: `${prev.id}_r${rec.followups_done}`,
    case_id: rec.id,
    kind: 'followup_check',
    due_at: dueAt,
    created_at: prev.acted_at ?? dueAt,
    acted_at: null,
    action: null,
    rush: prev.rush,
  });
}
