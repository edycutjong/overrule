/**
 * The agent pipeline (COMPLEXITY §1): IntakeTriage → EvidenceExtractor →
 * StrategyPlanner → Drafter → CitationVerifier → CaseOps, orchestrated over
 * the state machine, the mandate gate, and the ledger. Every stage appends a
 * signed decision row; every state change appends a transition row (I3);
 * raw text reaches ONLY the redaction span extractor (I4); money/mail happen
 * ONLY through the mandate gate (I5); nothing unverified mails (I2).
 */
import { performance } from 'node:perf_hooks';
import { hashCanonical, sha256Hex } from '../canonical';
import { CaseMachine, draftHash } from '../case/machine';
import { assertIsoDate } from '../docket/dates';
import { buildDocketPlan, filingDeadline } from '../docket/engine';
import { rulepackRef, type Rulepack } from '../docket/rulepack';
import type { DecisionLedger } from '../ledger/ledger';
import type { MandateGate } from '../mandate/middleware';
import { scrubWithProvider } from '../redact/scrubber';
import type {
  CaseRecord,
  CitationReceipt,
  Clock,
  DenialFacts,
  PiiSpan,
  PolicyMandate,
  StrategyPlan,
  USState,
} from '../types';
import type { GeminiAdapter } from './adapter';
import { verifyCitations, type DocStore } from './verifier';

export interface World {
  adapter: GeminiAdapter;
  ledger: DecisionLedger;
  machine: CaseMachine;
  gate: MandateGate;
  rulepacks: Map<USState, Rulepack>;
  docs: DocStore;
  clock: Clock;
}

export interface CaseInput {
  case_id: string;
  us_state: USState;
  raw_letter: string;
  /** Uploaded alongside the letter at intake (production: vaulted plan PDF). */
  plan_doc_id: string;
  paid_usd_cents: number;
  mandate: PolicyMandate;
}

export type PipelineOutcome = 'REFUNDED' | 'DOCKETED' | 'VERIFY_FAILED';

export type StageName = 'redact' | 'triage' | 'evidence' | 'strategy' | 'draft' | 'verify' | 'case_ops';

export interface PipelineResult {
  outcome: PipelineOutcome;
  record: CaseRecord;
  redacted_letter: string;
  refund_id?: string;
  tracking_number?: string;
  receipt?: CitationReceipt;
  stage_ms: Partial<Record<StageName, number>>;
}

export interface PipelineOptions {
  /** How many times the Drafter may retry after a citation failure. */
  maxRedrafts: number;
}
export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = { maxRedrafts: 1 };

export class FactsValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FactsValidationError';
  }
}

const DENIAL_CODE_RE = /^[A-Z]{2}-\d{1,3}$/;

export function validateFacts(facts: DenialFacts, expectedState: USState, expectedPlanDoc: string): void {
  if (!DENIAL_CODE_RE.test(facts.denial_code)) {
    throw new FactsValidationError(`denial_code ${JSON.stringify(facts.denial_code)} does not match XX-NNN`);
  }
  assertIsoDate(facts.denial_date);
  if (facts.stated_deadline !== null) assertIsoDate(facts.stated_deadline);
  if (facts.state !== expectedState) {
    throw new FactsValidationError(`extracted state ${facts.state} ≠ case state ${expectedState}`);
  }
  if (facts.plan_doc_id !== expectedPlanDoc) {
    throw new FactsValidationError(`extracted plan_doc_id ${facts.plan_doc_id} ≠ uploaded ${expectedPlanDoc}`);
  }
  if (!facts.payer || !facts.service || !facts.denial_reason) {
    throw new FactsValidationError('payer/service/denial_reason must be non-empty');
  }
}

function spanCounts(spans: PiiSpan[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of spans) out[s.kind] = (out[s.kind] ?? 0) + 1;
  return out;
}

export async function runCasePipeline(
  input: CaseInput,
  world: World,
  opts: PipelineOptions = DEFAULT_PIPELINE_OPTIONS,
): Promise<PipelineResult> {
  const { adapter, ledger, machine, gate, clock, docs } = world;
  const stage_ms: PipelineResult['stage_ms'] = {};
  const timed = async <T>(name: StageName, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      stage_ms[name] = (stage_ms[name] ?? 0) + (performance.now() - t0);
    }
  };

  const rulepack = world.rulepacks.get(input.us_state);
  if (!rulepack) throw new Error(`no rulepack for state ${input.us_state}`);
  const planText = docs.getDoc(input.plan_doc_id);
  if (planText === null) throw new Error(`plan document ${input.plan_doc_id} not found`);

  const rec = machine.create({
    id: input.case_id,
    us_state: input.us_state,
    paid_usd_cents: input.paid_usd_cents,
    mandate: input.mandate,
  });

  // ---- Redaction (the ONLY stage that sees raw text — I4) ----
  const redacted = await timed('redact', async () => {
    const { text, spans } = await scrubWithProvider(input.raw_letter, {
      findSpans: (t) => adapter.findPiiSpans(t),
    });
    ledger.append({
      case_id: rec.id,
      agent: 'redaction',
      kind: 'decision',
      decision: {
        stage: 'redact',
        spans_by_kind: spanCounts(spans),
        chars_before: input.raw_letter.length,
        chars_after: text.length,
      },
      inputs_hash: sha256Hex(input.raw_letter),
      output_hash: sha256Hex(text),
    });
    return text;
  });
  rec.redacted_letter = redacted;

  // ---- IntakeTriage ----
  const triage = await timed('triage', () => adapter.triage({ redacted_letter: redacted }));
  ledger.append({
    case_id: rec.id,
    agent: 'intake_triage',
    kind: 'decision',
    decision: { stage: 'triage', accept: triage.accept, p_win: triage.p_win, reason: triage.reason },
    inputs_hash: sha256Hex(redacted),
    output_hash: hashCanonical(triage),
  });
  machine.transition(rec, 'TRIAGE_COMPLETE', { agent: 'intake_triage', triage });

  if (!triage.accept) {
    // Decline-and-refund economics (COMPLEXITY §3): full auto-refund via mandate gate.
    const { result, proof } = await gate.stripeRefund(
      input.mandate,
      { case_id: rec.id, amount_usd_cents: input.paid_usd_cents, reason: 'triage_decline' },
      'treasury',
    );
    machine.transition(rec, 'DECLINE_REFUND', {
      agent: 'treasury',
      proof,
      decision: { refund_id: result.refund_id, p_win: triage.p_win },
    });
    return { outcome: 'REFUNDED', record: rec, redacted_letter: redacted, refund_id: result.refund_id, stage_ms };
  }
  machine.transition(rec, 'ACCEPT', { agent: 'intake_triage', decision: { p_win: triage.p_win } });

  // ---- EvidenceExtractor ----
  const facts = await timed('evidence', () =>
    adapter.extractEvidence({ redacted_letter: redacted, plan_text: planText }),
  );
  validateFacts(facts, input.us_state, input.plan_doc_id);
  ledger.append({
    case_id: rec.id,
    agent: 'evidence_extractor',
    kind: 'decision',
    decision: { stage: 'evidence', facts: { ...facts } },
    inputs_hash: sha256Hex(redacted),
    output_hash: hashCanonical(facts),
  });

  // ---- StrategyPlanner (deadline math is deterministic; clause targeting is LLM) ----
  const strategy = await timed('strategy', async (): Promise<StrategyPlan> => {
    const fd = filingDeadline(facts, rulepack, clock.now());
    const clauses = await adapter.suggestClauses({ facts, plan_text: planText });
    const plan: StrategyPlan = {
      appeal_level: 'internal_l1',
      rulepack_ref: rulepackRef(rulepack),
      external_review_available: rulepack.external_review.available_after === 'internal_l1',
      rush: fd.rush,
      target_clauses: clauses,
    };
    ledger.append({
      case_id: rec.id,
      agent: 'strategy_planner',
      kind: 'decision',
      decision: {
        stage: 'strategy',
        appeal_level: plan.appeal_level,
        rulepack_ref: plan.rulepack_ref,
        filing_deadline: fd.deadline,
        deadline_basis: fd.basis,
        days_remaining: fd.days_remaining,
        rush: fd.rush,
        external_review_available: plan.external_review_available,
        clause_count: clauses.length,
      },
      inputs_hash: hashCanonical(facts),
      output_hash: hashCanonical(plan),
    });
    return plan;
  });

  // ---- Drafter ⇄ CitationVerifier loop (fail closed — I2) ----
  let receipt: CitationReceipt | undefined;
  for (let attempt = 0; ; attempt++) {
    const draftOut = await timed('draft', () =>
      adapter.draftAppeal({ facts, strategy, plan_text: planText, redacted_letter: redacted }),
    );
    const draft = { case_id: rec.id, body: draftOut.body, citations: draftOut.citations };
    ledger.append({
      case_id: rec.id,
      agent: 'drafter',
      kind: 'decision',
      decision: {
        stage: 'draft',
        attempt,
        body_sha256: sha256Hex(draft.body),
        citations: draft.citations.map((c) => ({
          doc_id: c.doc_id,
          section: c.section,
          page: c.page,
          quote_sha256: sha256Hex(c.quote),
        })),
      },
      inputs_hash: hashCanonical({ facts, strategy }),
      output_hash: draftHash(draft),
    });
    if (attempt === 0) {
      machine.transition(rec, 'DRAFT_READY', { agent: 'drafter', facts, strategy, draft });
    } else {
      machine.transition(rec, 'REDRAFT', { agent: 'drafter', draft, decision: { attempt } });
    }

    receipt = await timed('verify', async () => verifyCitations(draft, docs, clock));
    ledger.append({
      case_id: rec.id,
      agent: 'citation_verifier',
      kind: receipt.pass ? 'citation_receipt' : 'citation_failure',
      decision: {
        stage: 'verify',
        pass: receipt.pass,
        checked: receipt.checked,
        draft_hash: receipt.draft_hash,
        failures: receipt.failures.map((f) => ({ index: f.index, reason: f.reason })),
      },
      inputs_hash: draftHash(draft),
      output_hash: hashCanonical(receipt),
    });

    if (receipt.pass) {
      machine.transition(rec, 'VERIFY_PASS', { agent: 'citation_verifier', receipt });
      break;
    }
    machine.transition(rec, 'VERIFY_FAIL', {
      agent: 'citation_verifier',
      receipt,
      decision: { failures: receipt.failures.length, attempt },
    });
    if (attempt >= opts.maxRedrafts) {
      // Fail closed: no unverified artifact may ship (I2). Case parks in DRAFT.
      return { outcome: 'VERIFY_FAILED', record: rec, redacted_letter: redacted, receipt, stage_ms };
    }
  }

  // ---- CaseOps: certified mail + docket (both mandate-gated — I5) ----
  const { tracking } = await timed('case_ops', async () => {
    const mail = await gate.lobSend(
      input.mandate,
      {
        case_id: rec.id,
        artifact_hash: draftHash(rec.draft!),
        mail_class: rulepack.mail.method,
        destination_state: input.us_state,
      },
      'case_ops',
    );
    machine.transition(rec, 'MAIL_SENT', {
      agent: 'case_ops',
      proof: mail.proof,
      decision: { tracking_number: mail.result.tracking_number, mail_class: mail.result.mail_class },
    });

    const filedAt = clock.now();
    const plan = buildDocketPlan(rec.id, facts, rulepack, filedAt);
    const docket = await gate.docketSet(input.mandate, { case_id: rec.id, plan }, 'case_ops');
    // The filing item is satisfied by the certified mail we just sent — record that.
    for (const item of docket.result.items) {
      if (item.kind === 'internal_l1_file') {
        item.acted_at = filedAt;
        item.action = 'appeal_filed_certified_mail';
      }
    }
    machine.transition(rec, 'DOCKET_SET', {
      agent: 'case_ops',
      proof: docket.proof,
      docket_items: docket.result.items,
      decision: {
        item_count: docket.result.items.length,
        filing_deadline: plan.filing_deadline,
        filing_deadline_basis: plan.filing_deadline_basis,
        rush: plan.rush,
      },
    });
    return { tracking: mail.result.tracking_number };
  });

  return {
    outcome: 'DOCKETED',
    record: rec,
    redacted_letter: redacted,
    tracking_number: tracking,
    receipt,
    stage_ms,
  };
}
