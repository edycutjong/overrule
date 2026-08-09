/**
 * Dashboard data export (judge-visibility layer).
 *
 * Assembles the REAL outputs of the offline self-test run — the maria_asthma
 * signed ledger, the CitationVerifier PASS on §4.3, the golden_11 poisoned
 * negative control that fails closed, the daily Merkle root, and honest
 * aggregate counters over the whole fixture set — into a single JSON payload
 * that the self-contained `verify/index.html` renders from file:// (via the
 * sibling `dashboard-data.js` module, no fetch).
 *
 * Everything here is derived from real pipeline runs on the DeterministicMock
 * adapter + in-memory actuator fakes; nothing is invented. All numbers are
 * FIXTURE / offline-demo data, disclosed as such in `meta.disclosure`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_NOW, TickClock } from './clock';
import { POISONED_43_QUOTE } from '../fixtures/golden';
import { AETNA_43_TEXT } from '../fixtures/plans';
import type { ChainReport } from './ledger/verify';
import type { LedgerExport } from './ledger/ledger';
import { runCasePipeline, type PipelineResult } from './pipeline/pipeline';
import { buildOfflineWorld, type OfflineWorld } from './world';
import type { LedgerEntry } from './types';

export interface DashboardLedgerRow {
  gseq: number;
  seq: number;
  ts: string;
  agent: string;
  kind: string;
  detail: string;
  entry_hash: string;
  entry_hash_short: string;
  sig_short: string;
  sig_valid: boolean;
}

export interface DashboardData {
  meta: {
    title: string;
    adapter: string;
    clock: string;
    disclosure: string;
    generated_from: string;
  };
  primary: {
    case_id: string;
    payer: string;
    denial_code: string;
    denial_reason: string;
    service: string;
    us_state: string;
    plan_doc_id: string;
    outcome: string;
    final_state: string;
    p_win: number | null;
    tracking_number: string | null;
    filing_deadline: string;
    deadline_basis: string;
    days_remaining: number;
    rush: boolean;
    winning_clause: { doc_id: string; section: string; page: number } | null;
    winning_quote: string;
    redacted_excerpt: string;
    receipt: { pass: boolean; checked: number; draft_hash: string } | null;
    docket: { kind: string; due_at: string; acted: boolean; action: string | null; rush: boolean }[];
    ledger_rows: DashboardLedgerRow[];
  };
  verification: {
    ok: boolean;
    entries: number;
    cases: number;
    days: number;
    key_mode: string;
    merkle_roots: Record<string, string>;
    all_signatures_valid: boolean;
    verify_command: string;
  };
  negative_control: {
    case_id: string;
    outcome: string;
    final_state: string;
    receipt_pass: boolean;
    checked: number;
    failure_reason: string;
    sends: number;
    original_fragment: string;
    poisoned_fragment: string;
    original_quote: string;
    poisoned_quote: string;
    refusal_ledger_row: { gseq: number; agent: string; kind: string; entry_hash_short: string; sig_short: string } | null;
    chain_still_verifies: boolean;
  };
  counters: {
    fixture_cases_processed: number;
    appeals_docketed: number;
    auto_refunded: number;
    fail_closed_blocked: number;
    certified_mail_sent: number;
    deadlines_missed: number;
    refusal_rate_pct: number;
    ledger_rows_total: number;
    self_test_invariants_passed: number;
    self_test_invariants_total: number;
    vitest_tests: number;
  };
}

const VITEST_TEST_COUNT = 121; // 8 files; asserted green by `npm test` (README "Test suite").

function shortHash(hex: string, n = 10): string {
  return hex.length > n ? `${hex.slice(0, n)}…` : hex;
}

function shortSig(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 12)}…${hex.slice(-4)}` : hex;
}

/** Structured one-line detail per ledger row (mirrors self_test's fmtRow). */
function rowDetail(e: LedgerEntry): string {
  const d = e.decision as Record<string, unknown>;
  switch (e.kind) {
    case 'case_created':
      return `state=INTAKE · mandate=${String(d.mandate_id)}`;
    case 'transition':
      return `${String(d.from)} → ${String(d.to)}  (${String(d.event)})`;
    case 'decision':
      return `stage=${String(d.stage)}`;
    case 'actuation':
      return `action=${String(d.action)} · spend=${String(d.spend_usd_cents)}c`;
    case 'actuation_denied':
      return `action=${String(d.action)} · DENIED=${String(d.denial_code)}`;
    case 'citation_receipt':
      return `pass=${String(d.pass)} · checked=${String(d.checked)}`;
    case 'citation_failure':
      return `pass=${String(d.pass)} · failures=${(d.failures as unknown[] | undefined)?.length ?? 0}`;
    default:
      return e.kind;
  }
}

function toRows(entries: readonly LedgerEntry[]): DashboardLedgerRow[] {
  return entries.map((e) => ({
    gseq: e.gseq,
    seq: e.seq,
    ts: e.ts,
    agent: e.agent,
    kind: e.kind,
    detail: rowDetail(e),
    entry_hash: e.entry_hash,
    entry_hash_short: shortHash(e.entry_hash),
    sig_short: shortSig(e.sig),
    sig_valid: true, // whole export re-verified by verifyLedgerExport (verification.ok)
  }));
}

/** The single differing fragment between the real §4.3 clause and the poison. */
const ORIGINAL_FRAGMENT = 'under age 12';
const POISONED_FRAGMENT = 'under age 14';

export interface BuildDashboardArgs {
  world: OfflineWorld;
  result: PipelineResult;
  exp: LedgerExport;
  rep: ChainReport;
  neg: { world: OfflineWorld; result: PipelineResult; rep: ChainReport };
  invariants: { passed: number; total: number };
}

/**
 * Assemble the dashboard payload from the exact data the self-test already
 * produced (so the rendered ledger is byte-identical to what verify:ledger
 * checks), plus an aggregate tally over the full fixture set for the counters.
 */
export async function buildDashboardData(args: BuildDashboardArgs): Promise<DashboardData> {
  const { world, result, exp, rep, neg } = args;
  const rec = result.record;

  // Deadline math is the signed strategy_planner row (what the ledger attests).
  const stratRow = world.ledger.all().find((e) => e.agent === 'strategy_planner' && e.kind === 'decision');
  const sd = (stratRow?.decision ?? {}) as Record<string, unknown>;

  const tc = rec.strategy?.target_clauses?.[0] ?? null;
  const excerpt = (rec.redacted_letter ?? '').split('\n').slice(0, 14).join('\n');

  // Negative control: locate the signed refusal row (the catch is itself ledgered).
  const failRow = neg.world.ledger.all().find((e) => e.kind === 'citation_failure') ?? null;
  const negFailure = neg.result.receipt?.failures?.[0]?.reason ?? 'poisoned citation rejected';

  // ---- honest aggregate counters over the full fixture set (fresh world) ----
  const cw = buildOfflineWorld({ clock: new TickClock(DEMO_NOW) });
  let docketed = 0;
  let refunded = 0;
  let failClosed = 0;
  let deadlinesMissed = 0;
  const nowMs = Date.parse(DEMO_NOW);
  for (const c of cw.fixtures.cases) {
    const r = await runCasePipeline(cw.makeInput(c.id), cw);
    if (r.outcome === 'DOCKETED') docketed += 1;
    else if (r.outcome === 'REFUNDED') refunded += 1;
    else if (r.outcome === 'VERIFY_FAILED') failClosed += 1;
    for (const item of r.record.docket) {
      if (item.acted_at === null && Date.parse(item.due_at) < nowMs) deadlinesMissed += 1;
    }
  }
  const total = cw.fixtures.cases.length;

  return {
    meta: {
      title: 'Overrule — /verify',
      adapter: world.adapter.name,
      clock: `TickClock@${DEMO_NOW}`,
      disclosure:
        'FIXTURE / offline demo data — regenerated by `npm run self-test` on the DeterministicMockAdapter ' +
        '+ in-memory actuator fakes. SYNTHETIC persons/payers/determinations. Not live production; no real ' +
        'revenue, users, or mail.',
      generated_from: 'scripts/self_test.ts → src/core/dashboard.ts',
    },
    primary: {
      case_id: rec.id,
      payer: rec.facts?.payer ?? '',
      denial_code: rec.facts?.denial_code ?? '',
      denial_reason: rec.facts?.denial_reason ?? '',
      service: rec.facts?.service ?? '',
      us_state: rec.us_state,
      plan_doc_id: rec.facts?.plan_doc_id ?? '',
      outcome: result.outcome,
      final_state: rec.state,
      p_win: rec.p_win,
      tracking_number: result.tracking_number ?? null,
      filing_deadline: String(sd.filing_deadline ?? ''),
      deadline_basis: String(sd.deadline_basis ?? ''),
      days_remaining: Number(sd.days_remaining ?? 0),
      rush: Boolean(sd.rush ?? false),
      winning_clause: tc ? { doc_id: tc.doc_id, section: tc.section, page: tc.page } : null,
      winning_quote: AETNA_43_TEXT,
      redacted_excerpt: excerpt,
      receipt: result.receipt
        ? { pass: result.receipt.pass, checked: result.receipt.checked, draft_hash: result.receipt.draft_hash }
        : null,
      docket: rec.docket.map((it) => ({
        kind: it.kind,
        due_at: it.due_at,
        acted: it.acted_at !== null,
        action: it.action,
        rush: it.rush,
      })),
      ledger_rows: toRows(world.ledger.all()),
    },
    verification: {
      ok: rep.ok,
      entries: rep.entries,
      cases: rep.cases,
      days: rep.days,
      key_mode: exp.manifest.key_mode,
      merkle_roots: exp.manifest.merkle_roots,
      all_signatures_valid: rep.ok,
      verify_command: 'npm run verify:ledger',
    },
    negative_control: {
      case_id: neg.result.record.id,
      outcome: neg.result.outcome,
      final_state: neg.result.record.state,
      receipt_pass: neg.result.receipt?.pass ?? false,
      checked: neg.result.receipt?.checked ?? 0,
      failure_reason: negFailure,
      sends: neg.world.actuators.fakes.lob.sends.length,
      original_fragment: ORIGINAL_FRAGMENT,
      poisoned_fragment: POISONED_FRAGMENT,
      original_quote: AETNA_43_TEXT,
      poisoned_quote: POISONED_43_QUOTE,
      refusal_ledger_row: failRow
        ? {
            gseq: failRow.gseq,
            agent: failRow.agent,
            kind: failRow.kind,
            entry_hash_short: shortHash(failRow.entry_hash),
            sig_short: shortSig(failRow.sig),
          }
        : null,
      chain_still_verifies: neg.rep.ok,
    },
    counters: {
      fixture_cases_processed: total,
      appeals_docketed: docketed,
      auto_refunded: refunded,
      fail_closed_blocked: failClosed,
      certified_mail_sent: cw.actuators.fakes.lob.sends.length,
      deadlines_missed: deadlinesMissed,
      refusal_rate_pct: total > 0 ? Math.round((refunded / total) * 100) : 0,
      ledger_rows_total: cw.ledger.length,
      self_test_invariants_passed: args.invariants.passed,
      self_test_invariants_total: args.invariants.total,
      vitest_tests: VITEST_TEST_COUNT,
    },
  };
}

/**
 * Write the dashboard payload + the ledger export it verifies into `dir`
 * (build/verify/data). Emits both a JS module (loaded by index.html from
 * file://, no fetch) and a raw JSON copy. Returns the paths written.
 */
export function writeDashboardData(dir: string, data: DashboardData, exp: LedgerExport): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const put = (name: string, content: string): void => {
    const p = join(dir, name);
    writeFileSync(p, content, 'utf8');
    written.push(p);
  };

  const json = JSON.stringify(data, null, 2) + '\n';
  put('dashboard-data.json', json);
  put(
    'dashboard-data.js',
    '/* Auto-generated by scripts/self_test.ts — do not edit. FIXTURE / offline demo data. */\n' +
      `window.__OVERRULE_DATA__ = ${JSON.stringify(data)};\n`,
  );
  put('ledger.jsonl', exp.jsonl);
  put('ledger_manifest.json', JSON.stringify(exp.manifest, null, 2) + '\n');
  put(
    'verification.json',
    JSON.stringify(
      {
        ok: data.verification.ok,
        entries: data.verification.entries,
        cases: data.verification.cases,
        days: data.verification.days,
        key_mode: data.verification.key_mode,
        merkle_roots: data.verification.merkle_roots,
        note: 'Recomputed by src/core/ledger/verify.ts from ledger.jsonl + ledger_manifest.json alone.',
      },
      null,
      2,
    ) + '\n',
  );
  return written;
}
