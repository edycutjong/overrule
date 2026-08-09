/**
 * Case lifecycle state machine (COMPLEXITY §4):
 *
 *   INTAKE → TRIAGED → { REFUNDED
 *                      | EVIDENCE → DRAFT → VERIFIED → FILED → DOCKETED
 *                        → FOLLOWUP* → { ESCALATED | CLOSED } }
 *
 * Invariants enforced here:
 *   I2 — DRAFT→VERIFIED requires a passing CitationReceipt bound (by hash) to
 *        the exact draft; VERIFIED→FILED re-checks it before mail.
 *   I3 — every transition appends a signed, hash-chained ledger row.
 *   I5 — money/mail transitions (DECLINE_REFUND, MAIL_SENT, DOCKET_SET,
 *        ESCALATE) require an ActuationProof, which only the MandateGate can
 *        produce — i.e. only after signed-mandate validation.
 * (I1 lives in sweep.ts; I4 lives in the ledger's PHI guard.)
 */
import { hashCanonical } from '../canonical';
import type { DecisionLedger } from '../ledger/ledger';
import type { ActuationProof } from '../mandate/middleware';
import type {
  AgentName,
  AppealDraft,
  CaseEvent,
  CaseRecord,
  CaseState,
  CitationReceipt,
  Clock,
  DenialFacts,
  DocketItem,
  PolicyMandate,
  StrategyPlan,
  TriageResult,
  USState,
} from '../types';

export class InvalidTransitionError extends Error {
  constructor(state: CaseState, event: CaseEvent) {
    super(`invalid transition: event ${event} is not legal in state ${state}`);
    this.name = 'InvalidTransitionError';
  }
}

export class GuardError extends Error {
  constructor(
    public readonly invariant: 'I2' | 'I5' | 'DATA',
    detail: string,
  ) {
    super(`transition guard failed [${invariant}]: ${detail}`);
    this.name = 'GuardError';
  }
}

/** The full transition table — exported so tests can enumerate it. */
export const TRANSITIONS: Readonly<Record<CaseState, Partial<Record<CaseEvent, CaseState>>>> = {
  INTAKE: { TRIAGE_COMPLETE: 'TRIAGED' },
  TRIAGED: { DECLINE_REFUND: 'REFUNDED', ACCEPT: 'EVIDENCE' },
  EVIDENCE: { DRAFT_READY: 'DRAFT' },
  DRAFT: { VERIFY_PASS: 'VERIFIED', VERIFY_FAIL: 'DRAFT', REDRAFT: 'DRAFT' },
  VERIFIED: { MAIL_SENT: 'FILED' },
  FILED: { DOCKET_SET: 'DOCKETED' },
  DOCKETED: { FOLLOWUP_DONE: 'FOLLOWUP', ESCALATE: 'ESCALATED', CLOSE: 'CLOSED' },
  FOLLOWUP: { FOLLOWUP_DONE: 'FOLLOWUP', ESCALATE: 'ESCALATED', CLOSE: 'CLOSED' },
  ESCALATED: { CLOSE: 'CLOSED' },
  REFUNDED: {},
  CLOSED: {},
};

export const TERMINAL_STATES: readonly CaseState[] = ['REFUNDED', 'CLOSED'];

export interface TransitionContext {
  agent: AgentName;
  /** PHI-safe decision payload for the ledger row. */
  decision?: Record<string, unknown>;
  /** Proof from the MandateGate — REQUIRED for money/mail events (I5). */
  proof?: ActuationProof;
  triage?: TriageResult;
  facts?: DenialFacts;
  strategy?: StrategyPlan;
  draft?: AppealDraft;
  receipt?: CitationReceipt;
  docket_items?: DocketItem[];
  note?: string;
}

const PROOF_REQUIRED: Partial<Record<CaseEvent, ActuationProof['action']>> = {
  DECLINE_REFUND: 'stripe_refund',
  MAIL_SENT: 'lob_send',
  DOCKET_SET: 'docket_set',
  ESCALATE: 'escalate_doi',
};

export function draftHash(draft: AppealDraft): string {
  return hashCanonical({ body: draft.body, citations: draft.citations });
}

/** Mark every still-open docket item as superseded (I1 hygiene on ESCALATE/CLOSE). */
function supersedeOpenItems(rec: CaseRecord, ts: string, action: string): void {
  for (const item of rec.docket) {
    if (item.acted_at === null) {
      item.acted_at = ts;
      item.action = action;
    }
  }
}

export class CaseMachine {
  constructor(
    private readonly ledger: DecisionLedger,
    private readonly clock: Clock,
  ) {}

  create(input: {
    id: string;
    us_state: USState;
    paid_usd_cents: number;
    mandate: PolicyMandate | null;
  }): CaseRecord {
    const rec: CaseRecord = {
      id: input.id,
      state: 'INTAKE',
      us_state: input.us_state,
      created_at: this.clock.now(),
      paid_usd_cents: input.paid_usd_cents,
      mandate: input.mandate,
      redacted_letter: null,
      p_win: null,
      facts: null,
      strategy: null,
      draft: null,
      receipt: null,
      docket: [],
      history: [],
      followups_done: 0,
      sla_credited: false,
    };
    this.ledger.append({
      case_id: rec.id,
      agent: 'case_ops',
      kind: 'case_created',
      decision: {
        us_state: rec.us_state,
        paid_usd_cents: rec.paid_usd_cents,
        mandate_id: rec.mandate?.mandate_id ?? null,
      },
      inputs_hash: hashCanonical({ id: input.id }),
      output_hash: hashCanonical({ state: rec.state }),
    });
    return rec;
  }

  /** Validate guards, apply the transition, append the ledger row (I3). */
  transition(rec: CaseRecord, event: CaseEvent, ctx: TransitionContext): CaseRecord {
    const target = TRANSITIONS[rec.state]?.[event];
    if (target === undefined) throw new InvalidTransitionError(rec.state, event);

    // ----- I5: money/mail events demand a gate-produced proof -----
    const requiredAction = PROOF_REQUIRED[event];
    if (requiredAction !== undefined) {
      if (!ctx.proof) throw new GuardError('I5', `${event} requires an ActuationProof from the mandate gate`);
      if (ctx.proof.action !== requiredAction) {
        throw new GuardError('I5', `${event} requires proof of ${requiredAction}, got ${ctx.proof.action}`);
      }
      if (ctx.proof.case_id !== rec.id) {
        throw new GuardError('I5', `proof belongs to case ${ctx.proof.case_id}, not ${rec.id}`);
      }
    }

    // ----- event-specific guards + record mutations -----
    switch (event) {
      case 'TRIAGE_COMPLETE': {
        if (!ctx.triage) throw new GuardError('DATA', 'TRIAGE_COMPLETE requires a TriageResult');
        if (ctx.triage.p_win < 0 || ctx.triage.p_win > 1) {
          throw new GuardError('DATA', `p_win out of range: ${ctx.triage.p_win}`);
        }
        rec.p_win = ctx.triage.p_win;
        break;
      }
      case 'ACCEPT': {
        if (rec.p_win === null) throw new GuardError('DATA', 'ACCEPT requires a recorded p_win from triage');
        break;
      }
      case 'DECLINE_REFUND': {
        if (rec.p_win === null) throw new GuardError('DATA', 'DECLINE_REFUND requires a recorded p_win from triage');
        break;
      }
      case 'DRAFT_READY': {
        if (!ctx.facts || !ctx.strategy || !ctx.draft) {
          throw new GuardError('DATA', 'DRAFT_READY requires facts + strategy + draft');
        }
        rec.facts = ctx.facts;
        rec.strategy = ctx.strategy;
        rec.draft = ctx.draft;
        rec.receipt = null; // any prior receipt is void for a new draft
        break;
      }
      case 'REDRAFT': {
        if (!ctx.draft) throw new GuardError('DATA', 'REDRAFT requires the replacement draft');
        rec.draft = ctx.draft;
        rec.receipt = null; // a new draft voids any prior receipt (I2)
        break;
      }
      case 'VERIFY_PASS': {
        if (!ctx.receipt) throw new GuardError('DATA', 'VERIFY_PASS requires a CitationReceipt');
        if (!ctx.receipt.pass) throw new GuardError('I2', 'receipt did not pass — cannot enter VERIFIED');
        if (!rec.draft) throw new GuardError('DATA', 'no draft on record');
        if (ctx.receipt.draft_hash !== draftHash(rec.draft)) {
          throw new GuardError('I2', 'receipt is not bound to the current draft (hash mismatch)');
        }
        rec.receipt = ctx.receipt;
        break;
      }
      case 'VERIFY_FAIL': {
        if (!ctx.receipt) throw new GuardError('DATA', 'VERIFY_FAIL requires the failing CitationReceipt');
        if (ctx.receipt.pass) throw new GuardError('DATA', 'VERIFY_FAIL with a passing receipt');
        rec.receipt = null;
        break;
      }
      case 'MAIL_SENT': {
        // I2 re-check at the customer-visible boundary: only verified artifacts mail.
        if (!rec.receipt?.pass) throw new GuardError('I2', 'cannot mail: no passing CitationReceipt on record');
        if (!rec.draft || rec.receipt.draft_hash !== draftHash(rec.draft)) {
          throw new GuardError('I2', 'cannot mail: receipt/draft hash mismatch');
        }
        break;
      }
      case 'DOCKET_SET': {
        if (!ctx.docket_items || ctx.docket_items.length === 0) {
          throw new GuardError('DATA', 'DOCKET_SET requires at least one docket item');
        }
        rec.docket.push(...ctx.docket_items);
        break;
      }
      case 'FOLLOWUP_DONE': {
        rec.followups_done += 1;
        break;
      }
      case 'ESCALATE': {
        // Proof requirement already enforced above (gate checked consent, I5).
        // Open docket items are superseded by the escalation, so no clock is
        // left to fall due unactioned on a case that moved past them (I1).
        supersedeOpenItems(rec, this.clock.now(), 'superseded_by_escalation');
        break;
      }
      case 'CLOSE': {
        if (!ctx.note) throw new GuardError('DATA', 'CLOSE requires a note (reason)');
        supersedeOpenItems(rec, this.clock.now(), 'superseded_by_close');
        break;
      }
      default:
        break;
    }

    const from = rec.state;
    const ts = this.clock.now();
    rec.state = target;
    rec.history.push({ from, to: target, event, ts });

    this.ledger.append({
      case_id: rec.id,
      agent: ctx.agent,
      kind: 'transition',
      decision: {
        event,
        from,
        to: target,
        ...(ctx.proof ? { proof: { ...ctx.proof } as unknown as Record<string, unknown> } : {}),
        ...(ctx.decision ?? {}),
      },
      inputs_hash: hashCanonical({ from, event }),
      output_hash: hashCanonical({ to: target }),
    });
    return rec;
  }
}
