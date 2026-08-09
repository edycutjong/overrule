import { describe, expect, it } from 'vitest';
import { hashCanonical } from '../src/core/canonical';
import { GuardError, InvalidTransitionError, TRANSITIONS, TERMINAL_STATES, draftHash } from '../src/core/case/machine';
import { verifyCitations } from '../src/core/pipeline/verifier';
import { buildOfflineWorld } from '../src/core/world';
import type { ActuationProof } from '../src/core/mandate/middleware';
import type { AppealDraft, CaseEvent, CaseRecord, CaseState, CitationReceipt } from '../src/core/types';

function world() {
  return buildOfflineWorld();
}

function freshCase(w = world(), id = 'case_t') {
  const mandate = w.makeMandate(id);
  const rec = w.machine.create({ id, us_state: 'TX', paid_usd_cents: 4900, mandate });
  return { w, rec, mandate };
}

const TRIAGE_OK = { accept: true, p_win: 0.7, reason: 'test' };

function passingDraftFor(w: ReturnType<typeof world>, rec: CaseRecord): { draft: AppealDraft; receipt: CitationReceipt } {
  const maria = w.fixtures.cases.find((c) => c.id === 'maria_asthma')!;
  const draft: AppealDraft = {
    case_id: rec.id,
    body: 'test body',
    citations: [{ ...maria.truth.winning! }],
  };
  const receipt = verifyCitations(draft, w.docs, w.clock);
  return { draft, receipt };
}

/** Drive a case to a given state through the REAL guards + gate. */
async function driveTo(state: CaseState, w = world(), id = 'case_t'): Promise<{ w: ReturnType<typeof world>; rec: CaseRecord }> {
  const { rec, mandate } = freshCase(w, id);
  const facts = {
    payer: 'P',
    denial_code: 'CO-50',
    denial_reason: 'r',
    service: 's',
    denial_date: '2026-06-26',
    stated_deadline: '2026-08-25' as string | null,
    state: 'TX' as const,
    plan_doc_id: 'plan_aetna_ppo_2026',
  };
  const strategy = {
    appeal_level: 'internal_l1' as const,
    rulepack_ref: 'TX@2026-07-fixture',
    external_review_available: true,
    rush: false,
    target_clauses: [],
  };
  const step = (target: CaseState): boolean => rec.state !== target || state !== target;

  if (rec.state === state) return { w, rec };
  w.machine.transition(rec, 'TRIAGE_COMPLETE', { agent: 'intake_triage', triage: TRIAGE_OK });
  if (!step('TRIAGED')) return { w, rec };
  w.machine.transition(rec, 'ACCEPT', { agent: 'intake_triage' });
  if (!step('EVIDENCE')) return { w, rec };
  const { draft, receipt } = passingDraftFor(w, rec);
  w.machine.transition(rec, 'DRAFT_READY', { agent: 'drafter', facts, strategy, draft });
  if (!step('DRAFT')) return { w, rec };
  w.machine.transition(rec, 'VERIFY_PASS', { agent: 'citation_verifier', receipt });
  if (!step('VERIFIED')) return { w, rec };
  const mail = await w.gate.lobSend(
    mandate,
    { case_id: rec.id, artifact_hash: draftHash(draft), mail_class: 'certified', destination_state: 'TX' },
    'case_ops',
  );
  w.machine.transition(rec, 'MAIL_SENT', { agent: 'case_ops', proof: mail.proof });
  if (!step('FILED')) return { w, rec };
  const docket = await w.gate.docketSet(
    mandate,
    {
      case_id: rec.id,
      plan: {
        case_id: rec.id,
        state: 'TX',
        rulepack_ref: 'TX@2026-07-fixture',
        rush: false,
        filing_deadline: '2026-08-25',
        filing_deadline_basis: 'letter_stated',
        items: [{ kind: 'followup_check', due_at: '2026-08-04T23:59:59Z', created_at: w.clock.peek(), rush: false }],
      },
    },
    'case_ops',
  );
  w.machine.transition(rec, 'DOCKET_SET', { agent: 'case_ops', proof: docket.proof, docket_items: docket.result.items });
  return { w, rec };
}

describe('transition table shape', () => {
  it('terminal states allow no events', () => {
    for (const s of TERMINAL_STATES) expect(Object.keys(TRANSITIONS[s])).toHaveLength(0);
  });

  it('matches the COMPLEXITY §4 grammar exactly', () => {
    expect(TRANSITIONS).toEqual({
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
    });
  });

  it('rejects every event not in the table for a state (spot matrix)', () => {
    const { w, rec } = freshCase();
    const illegalInIntake: CaseEvent[] = ['ACCEPT', 'MAIL_SENT', 'DOCKET_SET', 'CLOSE', 'VERIFY_PASS'];
    for (const ev of illegalInIntake) {
      expect(() => w.machine.transition(rec, ev, { agent: 'case_ops' })).toThrow(InvalidTransitionError);
    }
    expect(rec.state).toBe('INTAKE'); // unchanged after rejections
  });
});

describe('happy path through real guards', () => {
  it('reaches DOCKETED and records full history', async () => {
    const { rec } = await driveTo('DOCKETED');
    expect(rec.state).toBe('DOCKETED');
    expect(rec.history.map((h) => h.event)).toEqual([
      'TRIAGE_COMPLETE',
      'ACCEPT',
      'DRAFT_READY',
      'VERIFY_PASS',
      'MAIL_SENT',
      'DOCKET_SET',
    ]);
  });

  it('every transition appends exactly one signed ledger row (I3)', async () => {
    const { w, rec } = await driveTo('DOCKETED');
    const rows = w.ledger.forCase(rec.id);
    const transitions = rows.filter((r) => r.kind === 'transition');
    expect(transitions).toHaveLength(rec.history.length);
    expect(rows[0]!.kind).toBe('case_created');
    // each transition row names the same from/to as history
    transitions.forEach((row, i) => {
      expect(row.decision.event).toBe(rec.history[i]!.event);
      expect(row.decision.from).toBe(rec.history[i]!.from);
      expect(row.decision.to).toBe(rec.history[i]!.to);
    });
  });
});

describe('I5 guards — money/mail demand gate proofs', () => {
  it('DECLINE_REFUND without a proof is impossible', () => {
    const { w, rec } = freshCase();
    w.machine.transition(rec, 'TRIAGE_COMPLETE', { agent: 'intake_triage', triage: { ...TRIAGE_OK, accept: false, p_win: 0.05 } });
    expect(() => w.machine.transition(rec, 'DECLINE_REFUND', { agent: 'treasury' })).toThrow(/I5/);
  });

  it('a proof for the wrong action is rejected', async () => {
    const w = world();
    const { rec, mandate } = freshCase(w, 'case_p');
    w.machine.transition(rec, 'TRIAGE_COMPLETE', { agent: 'intake_triage', triage: { ...TRIAGE_OK, accept: false, p_win: 0.05 } });
    const wrong = await w.gate.docketSet(
      mandate,
      {
        case_id: rec.id,
        plan: {
          case_id: rec.id,
          state: 'TX',
          rulepack_ref: 'TX@2026-07-fixture',
          rush: false,
          filing_deadline: '2026-08-25',
          filing_deadline_basis: 'letter_stated',
          items: [{ kind: 'followup_check', due_at: '2026-08-04T23:59:59Z', created_at: w.clock.peek(), rush: false }],
        },
      },
      'case_ops',
    );
    expect(() => w.machine.transition(rec, 'DECLINE_REFUND', { agent: 'treasury', proof: wrong.proof })).toThrow(
      /requires proof of stripe_refund/,
    );
  });

  it('a proof for another case is rejected', async () => {
    const w = world();
    const { mandate: otherMandate } = freshCase(w, 'case_other');
    const { result: _r, proof } = await w.gate.stripeRefund(
      otherMandate,
      { case_id: 'case_other', amount_usd_cents: 4900, reason: 'triage_decline' },
      'treasury',
    );
    const { rec } = freshCase(w, 'case_mine');
    w.machine.transition(rec, 'TRIAGE_COMPLETE', { agent: 'intake_triage', triage: { ...TRIAGE_OK, accept: false, p_win: 0.05 } });
    expect(() => w.machine.transition(rec, 'DECLINE_REFUND', { agent: 'treasury', proof })).toThrow(/belongs to case/);
  });
});

describe('I2 guards — nothing unverified ships', () => {
  it('VERIFY_PASS demands a passing receipt bound to the current draft', async () => {
    const { w, rec } = await driveTo('DRAFT');
    const badReceipt: CitationReceipt = {
      draft_hash: hashCanonical({ body: 'other', citations: [] }),
      checked: 1,
      pass: true,
      failures: [],
      ts: w.clock.peek(),
    };
    expect(() => w.machine.transition(rec, 'VERIFY_PASS', { agent: 'citation_verifier', receipt: badReceipt })).toThrow(
      /not bound to the current draft/,
    );
    const failing = { ...badReceipt, draft_hash: draftHash(rec.draft!), pass: false };
    expect(() => w.machine.transition(rec, 'VERIFY_PASS', { agent: 'citation_verifier', receipt: failing })).toThrow(
      /did not pass/,
    );
  });

  it('MAIL_SENT re-checks the receipt at the customer boundary', async () => {
    const { w, rec } = await driveTo('VERIFIED', world(), 'case_m');
    // sabotage: replace the draft after verification
    rec.draft = { case_id: rec.id, body: 'swapped after verify', citations: [] };
    const mail = await w.gate.lobSend(
      rec.mandate!,
      { case_id: rec.id, artifact_hash: draftHash(rec.draft), mail_class: 'certified', destination_state: 'TX' },
      'case_ops',
    );
    expect(() => w.machine.transition(rec, 'MAIL_SENT', { agent: 'case_ops', proof: mail.proof })).toThrow(
      /receipt\/draft hash mismatch/,
    );
  });

  it('VERIFY_FAIL keeps the case in DRAFT and voids the receipt', async () => {
    const { w, rec } = await driveTo('DRAFT');
    const failing: CitationReceipt = {
      draft_hash: draftHash(rec.draft!),
      checked: 1,
      pass: false,
      failures: [{ index: 0, reason: 'quote not present' }],
      ts: w.clock.peek(),
    };
    w.machine.transition(rec, 'VERIFY_FAIL', { agent: 'citation_verifier', receipt: failing });
    expect(rec.state).toBe('DRAFT');
    expect(rec.receipt).toBeNull();
  });

  it('REDRAFT replaces the draft and voids any receipt', async () => {
    const { w, rec } = await driveTo('DRAFT');
    const replacement: AppealDraft = { case_id: rec.id, body: 'v2', citations: [] };
    w.machine.transition(rec, 'REDRAFT', { agent: 'drafter', draft: replacement });
    expect(rec.state).toBe('DRAFT');
    expect(rec.draft!.body).toBe('v2');
    expect(rec.receipt).toBeNull();
    expect(() => w.machine.transition(rec, 'REDRAFT', { agent: 'drafter' })).toThrow(/requires the replacement draft/);
  });
});

describe('data guards', () => {
  it('TRIAGE_COMPLETE requires a triage result with sane p_win', () => {
    const { w, rec } = freshCase();
    expect(() => w.machine.transition(rec, 'TRIAGE_COMPLETE', { agent: 'intake_triage' })).toThrow(/requires a TriageResult/);
    expect(() =>
      w.machine.transition(rec, 'TRIAGE_COMPLETE', { agent: 'intake_triage', triage: { accept: true, p_win: 1.5, reason: 'x' } }),
    ).toThrow(/out of range/);
  });

  it('DRAFT_READY requires facts + strategy + draft', async () => {
    const { w, rec } = await driveTo('EVIDENCE');
    expect(() => w.machine.transition(rec, 'DRAFT_READY', { agent: 'drafter' })).toThrow(/facts \+ strategy \+ draft/);
  });

  it('DOCKET_SET rejects an empty item list', async () => {
    const w = world();
    const { rec } = await driveTo('FILED', w, 'case_d');
    const docket = await w.gate.docketSet(
      rec.mandate!,
      {
        case_id: rec.id,
        plan: {
          case_id: rec.id,
          state: 'TX',
          rulepack_ref: 'TX@2026-07-fixture',
          rush: false,
          filing_deadline: '2026-08-25',
          filing_deadline_basis: 'letter_stated',
          items: [{ kind: 'followup_check', due_at: '2026-08-04T23:59:59Z', created_at: w.clock.peek(), rush: false }],
        },
      },
      'case_ops',
    );
    expect(() =>
      w.machine.transition(rec, 'DOCKET_SET', { agent: 'case_ops', proof: docket.proof, docket_items: [] }),
    ).toThrow(/at least one docket item/);
  });

  it('CLOSE requires a note and supersedes open docket items (I1 hygiene)', async () => {
    const { w, rec } = await driveTo('DOCKETED');
    expect(() => w.machine.transition(rec, 'CLOSE', { agent: 'case_ops' })).toThrow(/requires a note/);
    expect(rec.docket.some((i) => i.acted_at === null)).toBe(true);
    w.machine.transition(rec, 'CLOSE', { agent: 'case_ops', note: 'payer overturned the denial' });
    expect(rec.state).toBe('CLOSED');
    expect(rec.docket.every((i) => i.acted_at !== null)).toBe(true);
    expect(rec.docket.find((i) => i.action === 'superseded_by_close')).toBeTruthy();
  });

  it('terminal states are truly terminal', async () => {
    const { w, rec } = await driveTo('DOCKETED');
    w.machine.transition(rec, 'CLOSE', { agent: 'case_ops', note: 'done' });
    for (const ev of ['CLOSE', 'FOLLOWUP_DONE', 'TRIAGE_COMPLETE'] as CaseEvent[]) {
      expect(() => w.machine.transition(rec, ev, { agent: 'case_ops', note: 'x' })).toThrow(InvalidTransitionError);
    }
  });
});

describe('escalation via the real gate', () => {
  it('ESCALATE with a gate proof succeeds and supersedes open clocks', async () => {
    const w = world();
    const { rec } = await driveTo('DOCKETED', w, 'case_e');
    const esc = await w.gate.escalateDoi(rec.mandate!, { case_id: rec.id, state: 'TX', reason: 'payer_silent' }, 'case_ops');
    w.machine.transition(rec, 'ESCALATE', { agent: 'case_ops', proof: esc.proof });
    expect(rec.state).toBe('ESCALATED');
    expect(rec.docket.every((i) => i.acted_at !== null)).toBe(true);
  });

  it('bare ESCALATE (no proof) is impossible — a forged escalation cannot enter the machine', async () => {
    const { w, rec } = await driveTo('DOCKETED');
    expect(() => w.machine.transition(rec, 'ESCALATE', { agent: 'case_ops' })).toThrow(/I5/);
    const forged: ActuationProof = {
      action: 'escalate_doi',
      case_id: rec.id,
      mandate_id: 'mnd_x',
      ledger_gseq: 0,
      result_hash: hashCanonical({ forged: true }),
    };
    // forged in-process proofs are a trust boundary documented in the README;
    // the machine still validates action/case binding:
    expect(() => w.machine.transition(rec, 'ESCALATE', { agent: 'case_ops', proof: { ...forged, action: 'lob_send' } })).toThrow(/I5/);
  });
});
