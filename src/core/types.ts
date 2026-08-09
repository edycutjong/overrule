/**
 * Shared domain types for the Overrule offline core.
 * Maps to COMPLEXITY.md §1 (pipeline), §4 (state machine + invariants I1–I5).
 * All fixture data flowing through these types is SYNTHETIC.
 */

// ---------------------------------------------------------------------------
// Case lifecycle (COMPLEXITY §4)
// INTAKE → TRIAGED → {REFUNDED | EVIDENCE → DRAFT → VERIFIED → FILED
//   → DOCKETED → FOLLOWUP* → {ESCALATED | CLOSED}}
// ---------------------------------------------------------------------------
export type CaseState =
  | 'INTAKE'
  | 'TRIAGED'
  | 'REFUNDED'
  | 'EVIDENCE'
  | 'DRAFT'
  | 'VERIFIED'
  | 'FILED'
  | 'DOCKETED'
  | 'FOLLOWUP'
  | 'ESCALATED'
  | 'CLOSED';

export type USState = 'TX' | 'CA' | 'NY';

export type AgentName =
  | 'redaction'
  | 'intake_triage'
  | 'evidence_extractor'
  | 'strategy_planner'
  | 'drafter'
  | 'citation_verifier'
  | 'case_ops'
  | 'treasury'
  | 'scheduler';

// ---------------------------------------------------------------------------
// Ledger (COMPLEXITY §2)
// ---------------------------------------------------------------------------

/** Fields covered by entry_hash. `prev_hash` is also prepended per the spec formula. */
export interface LedgerEntryBody {
  /** global append-order sequence (whole ledger) */
  gseq: number;
  /** per-case chain sequence, contiguous from 0 */
  seq: number;
  case_id: string;
  ts: string; // ISO-8601 UTC
  agent: AgentName;
  kind: LedgerKind;
  /** Redacted, structured decision payload. PHI guard rejects raw PII here (I4). */
  decision: Record<string, unknown>;
  inputs_hash: string; // sha256 hex of canonical_json(stage input)
  output_hash: string; // sha256 hex of canonical_json(stage output)
  prev_hash: string; // previous entry_hash in this case chain, or GENESIS_HASH
}

export interface LedgerEntry extends LedgerEntryBody {
  entry_hash: string; // SHA-256(prev_hash ∥ canonical_json(body)) hex
  sig: string; // Ed25519 signature over entry_hash bytes, hex
  key_id: string; // agent key identifier (agent name in this build)
}

export type LedgerKind =
  | 'case_created'
  | 'transition'
  | 'decision'
  | 'actuation'
  | 'actuation_denied'
  | 'citation_receipt'
  | 'citation_failure'
  | 'sla_credit'
  | 'docket_sweep'
  | 'heartbeat';

// ---------------------------------------------------------------------------
// Redaction (COMPLEXITY §2 — redaction-before-persistence invariant, I4)
// ---------------------------------------------------------------------------
export type PiiKind = 'ssn' | 'dob' | 'member_id' | 'phone' | 'email' | 'name' | 'address';

export interface PiiSpan {
  start: number;
  end: number; // exclusive
  kind: PiiKind;
}

// ---------------------------------------------------------------------------
// Evidence / strategy / draft (pipeline stage outputs)
// ---------------------------------------------------------------------------
export interface DenialFacts {
  payer: string;
  denial_code: string; // e.g. CO-50, CO-197, PR-204, ST-01, EX-20
  denial_reason: string;
  service: string;
  denial_date: string; // ISO date (date of the denial notice)
  /** Deadline explicitly stated in the letter, if any (ISO date). */
  stated_deadline: string | null;
  state: USState;
  plan_doc_id: string;
}

export interface TriageResult {
  accept: boolean;
  p_win: number; // calibrated win probability [0,1]
  reason: string;
}

export interface StrategyPlan {
  appeal_level: 'internal_l1' | 'internal_l2' | 'external_review';
  rulepack_ref: string; // e.g. "TX@2026-07-fixture"
  external_review_available: boolean;
  rush: boolean;
  target_clauses: ClauseLocator[];
}

export interface ClauseLocator {
  doc_id: string; // fixture document id
  section: string; // e.g. "§4.3"
  page: number; // 1-based page in the fixture document
}

export interface Citation {
  doc_id: string;
  section: string;
  page: number;
  /** Must byte-match the source fixture text or CitationVerifier fails closed. */
  quote: string;
}

export interface AppealDraft {
  case_id: string;
  body: string; // full letter text (artifact — stored in vault, only hashed into ledger)
  citations: Citation[];
}

export interface CitationReceipt {
  draft_hash: string; // sha256 of canonical_json({body, citations})
  checked: number;
  pass: boolean;
  failures: { index: number; reason: string }[];
  ts: string;
}

// ---------------------------------------------------------------------------
// Docket engine (I1: no deadline may pass without a ledgered action)
// ---------------------------------------------------------------------------
export type DocketKind =
  | 'internal_l1_file' // appeal must be filed by dueAt
  | 'payer_response_check' // expect payer decision; follow up if silent
  | 'followup_check' // recurring follow-up clock
  | 'external_review_window'; // external review must be requested by dueAt

export interface DocketItem {
  id: string;
  case_id: string;
  kind: DocketKind;
  due_at: string; // ISO date-time UTC
  created_at: string;
  acted_at: string | null;
  action: string | null; // what was done when acted
  rush: boolean;
}

export interface DocketPlan {
  case_id: string;
  state: USState;
  rulepack_ref: string;
  rush: boolean;
  items: Omit<DocketItem, 'id' | 'case_id' | 'acted_at' | 'action'>[];
  /** Which basis produced the binding filing deadline. */
  filing_deadline_basis: 'letter_stated' | 'rulepack';
  filing_deadline: string; // ISO date
}

// ---------------------------------------------------------------------------
// Policy mandate (COMPLEXITY §3 — bounded money authority, I5)
// ---------------------------------------------------------------------------
export type ActuatorAction = 'stripe_refund' | 'lob_send' | 'docket_set' | 'escalate_doi';

export interface PolicyMandateBody {
  mandate_id: string;
  case_id: string;
  customer_id: string;
  max_spend_usd_cents: number;
  allowed_actions: ActuatorAction[];
  refund_policy: 'full_on_decline' | 'none';
  escalation_consent: boolean;
  issued_at: string; // ISO
  expires_at: string; // ISO
}

export interface PolicyMandate extends PolicyMandateBody {
  sig: string; // Ed25519 over sha256(canonical_json(body)), hex — customer key
  key_id: string;
}

// ---------------------------------------------------------------------------
// Case record
// ---------------------------------------------------------------------------
export interface CaseRecord {
  id: string;
  state: CaseState;
  us_state: USState;
  created_at: string;
  paid_usd_cents: number;
  mandate: PolicyMandate | null;
  /** Redacted intake text (post-scrub). Raw text lives only in the (out-of-scope) KMS vault. */
  redacted_letter: string | null;
  p_win: number | null;
  facts: DenialFacts | null;
  strategy: StrategyPlan | null;
  draft: AppealDraft | null;
  receipt: CitationReceipt | null;
  docket: DocketItem[];
  history: { from: CaseState; to: CaseState; event: string; ts: string }[];
  followups_done: number;
  /** SLA bond (COMPLEXITY §3): set once when a docketed deadline was missed and auto-credited. */
  sla_credited: boolean;
}

export type CaseEvent =
  | 'TRIAGE_COMPLETE'
  | 'DECLINE_REFUND'
  | 'ACCEPT'
  | 'DRAFT_READY'
  | 'REDRAFT' // CitationVerifier fail → Drafter loop (COMPLEXITY §1 CITE→DRAFT edge)
  | 'VERIFY_PASS'
  | 'VERIFY_FAIL'
  | 'MAIL_SENT'
  | 'DOCKET_SET'
  | 'FOLLOWUP_DONE'
  | 'ESCALATE'
  | 'CLOSE';

/** Injectable clock so fixtures and demos are byte-deterministic. */
export interface Clock {
  now(): string; // ISO-8601 UTC
}

export const GENESIS_HASH = '0'.repeat(64);
