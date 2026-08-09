/**
 * scripts/self_test.ts — end-to-end OFFLINE dry run (no network, no API key).
 *
 *   npx tsx scripts/self_test.ts
 *
 * Runs the SEED_DATA demo case `maria_asthma` through the entire agent pipeline
 * (redact → triage → evidence → strategy → draft → CitationVerifier → CaseOps)
 * on the DeterministicMockAdapter + in-memory actuator fakes, exercising the
 * mandate middleware (I5), the docket engine (I1), the case state machine and
 * the append-only Decision Ledger (I3). It then:
 *   - asserts the SEED_DATA verdict (CO-50, deadline 2026-08-25 / 42 days,
 *     winning clause §4.3 p.87) and every invariant I1–I5,
 *   - runs a NEGATIVE control (golden_11, a poisoned citation) to prove the
 *     verifier catches the hallucination and the pipeline fails closed,
 *   - writes out/ledger.jsonl + out/ledger_manifest.json (so `verify_ledger.ts`
 *     can independently re-prove the run),
 *   - prints the ledger tail and a final PASS/FAIL line, exiting non-zero on any
 *     failed check.
 *
 * Everything is deterministic (TickClock anchored to DEMO_NOW) — two runs are
 * byte-identical. All fixture data is SYNTHETIC.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_NOW, TickClock } from '../src/core/clock';
import { buildDashboardData, writeDashboardData } from '../src/core/dashboard';
import { getCase } from '../src/fixtures/index';
import { verifyLedgerExport } from '../src/core/ledger/verify';
import { runCasePipeline } from '../src/core/pipeline/pipeline';
import { detectPhi, REDACTION_PLACEHOLDER } from '../src/core/redact/scrubber';
import type { LedgerEntry } from '../src/core/types';
import { buildOfflineWorld } from '../src/core/world';

const BUILD_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(BUILD_ROOT, 'out');
const VERIFY_DATA_DIR = join(BUILD_ROOT, 'verify', 'data');

// ---- tiny check harness ---------------------------------------------------
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
}

// ---- readable one-line ledger row formatter -------------------------------
function fmtRow(e: LedgerEntry): string {
  const d = e.decision as Record<string, unknown>;
  let detail = '';
  switch (e.kind) {
    case 'case_created':
      detail = `state=INTAKE mandate=${String(d.mandate_id)}`;
      break;
    case 'transition':
      detail = `${String(d.from)} -> ${String(d.to)} (${String(d.event)})`;
      break;
    case 'decision':
      detail = `stage=${String(d.stage)}`;
      break;
    case 'actuation':
      detail = `action=${String(d.action)} spend=${String(d.spend_usd_cents)}c`;
      break;
    case 'actuation_denied':
      detail = `action=${String(d.action)} DENIED=${String(d.denial_code)}`;
      break;
    case 'citation_receipt':
      detail = `pass=${String(d.pass)} checked=${String(d.checked)}`;
      break;
    case 'citation_failure':
      detail = `pass=${String(d.pass)} failures=${(d.failures as unknown[] | undefined)?.length ?? 0}`;
      break;
    default:
      detail = '';
  }
  return `  #${String(e.gseq).padStart(2)} ${e.agent.padEnd(18)} ${e.kind.padEnd(17)} ${detail.padEnd(34)} ${e.entry_hash.slice(0, 10)}…`;
}

async function main(): Promise<void> {
  console.log('Overrule — offline self-test (no network, no API key)');

  // ================= primary: maria_asthma, full pipeline ==================
  const world = buildOfflineWorld({ clock: new TickClock(DEMO_NOW) });
  const truth = getCase(world.fixtures, 'maria_asthma').truth;
  console.log(`adapter: ${world.adapter.name} · clock: TickClock@${DEMO_NOW}\n`);
  console.log('▶ maria_asthma — redact → triage → evidence → strategy → draft → verify → case_ops');

  const result = await runCasePipeline(world.makeInput('maria_asthma'), world);
  console.log(
    `  outcome=${result.outcome}  state=${result.record.state}  p_win=${result.record.p_win}  ` +
      `tracking=${result.tracking_number}  receipt: pass=${result.receipt?.pass} checked=${result.receipt?.checked}`,
  );

  // ---- flow / triage ----
  check('[flow] pipeline reached DOCKETED', result.outcome === 'DOCKETED', `outcome=${result.outcome}`);
  check('[flow] case record in DOCKETED', result.record.state === 'DOCKETED', `state=${result.record.state}`);
  check(
    '[triage] accepted, calibrated p_win recorded',
    result.record.state !== 'REFUNDED' && result.record.p_win === truth.p_win && (result.record.p_win ?? 0) >= 0.3,
    `p_win=${result.record.p_win}`,
  );

  // ---- I2: nothing unverified ships ----
  check(
    '[I2] CitationVerifier receipt passed (1 quote checked)',
    result.receipt?.pass === true && result.receipt?.checked === 1,
    `pass=${result.receipt?.pass} checked=${result.receipt?.checked}`,
  );
  const evIdx = (ev: string): number => result.record.history.findIndex((h) => h.event === ev);
  check(
    '[I2] VERIFY_PASS precedes MAIL_SENT (mail only after verify)',
    evIdx('VERIFY_PASS') >= 0 && evIdx('MAIL_SENT') > evIdx('VERIFY_PASS'),
    `verify@${evIdx('VERIFY_PASS')} mail@${evIdx('MAIL_SENT')}`,
  );

  // ---- I4: redaction-before-persistence ----
  const redacted = result.redacted_letter;
  check('[I4] no machine-shaped PII survives redaction', detectPhi(redacted) === null, `detectPhi=${JSON.stringify(detectPhi(redacted))}`);
  check('[I4] redaction placeholders present', REDACTION_PLACEHOLDER.test(redacted));
  check('[I4] patient name scrubbed', !redacted.includes(truth.pii.patient_name), truth.pii.patient_name);
  check('[I4] SSN scrubbed', truth.pii.ssn !== null && !redacted.includes(truth.pii.ssn), String(truth.pii.ssn));
  check('[I4] member ID scrubbed', !redacted.includes(truth.pii.member_id), truth.pii.member_id);
  check('[I4] email scrubbed', !redacted.includes(truth.pii.email), truth.pii.email);

  // ---- I5 + economics: money/mail only through the mandate gate ----
  const sends = world.actuators.fakes.lob.sends;
  check(
    '[I5] certified mail sent through the mandate gate',
    sends.length === 1 && sends[0]!.mail_class === 'certified' && /^94001111FAKE\d{8}$/.test(result.tracking_number ?? ''),
    `sends=${sends.length} class=${sends[0]?.mail_class} tracking=${result.tracking_number}`,
  );
  const denied = world.ledger.all().filter((e) => e.kind === 'actuation_denied').length;
  check('[I5] mandate honored — zero actuation_denied rows', denied === 0, `denied=${denied}`);
  check('[econ] accepted case issued no refund', world.actuators.fakes.stripe.refunds.length === 0, `refunds=${world.actuators.fakes.stripe.refunds.length}`);

  // ---- I1: docket registered and the filing clock already actioned ----
  const fileItem = result.record.docket.find((d) => d.kind === 'internal_l1_file');
  check(
    '[I1] filing docket item registered AND actioned',
    result.record.docket.length >= 1 && !!fileItem && fileItem.acted_at !== null && fileItem.action === 'appeal_filed_certified_mail',
    `items=${result.record.docket.length} filing_acted=${fileItem?.acted_at !== null} action=${fileItem?.action}`,
  );

  // ---- SEED_DATA verdict: deadline math + winning clause locator ----
  const stratRow = world.ledger.all().find((e) => e.agent === 'strategy_planner' && e.kind === 'decision');
  const sd = (stratRow?.decision ?? {}) as Record<string, unknown>;
  check(
    '[verdict] filing deadline math matches ground truth (2026-08-25 / 42d / letter_stated)',
    sd.filing_deadline === truth.expected_binding_deadline &&
      sd.days_remaining === truth.expected_days_remaining &&
      sd.deadline_basis === truth.expected_basis,
    `deadline=${String(sd.filing_deadline)} days=${String(sd.days_remaining)} basis=${String(sd.deadline_basis)}`,
  );
  const tc = result.record.strategy?.target_clauses?.[0];
  check(
    '[verdict] winning clause §4.3 on p.87 targeted',
    !!tc && tc.section === '§4.3' && tc.page === 87,
    tc ? `${tc.section} p.${tc.page}` : 'none',
  );

  // ---- export + I3: the judge-runnable chain proof ----
  const exp = world.ledger.export();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'ledger.jsonl'), exp.jsonl, 'utf8');
  writeFileSync(join(OUT_DIR, 'ledger_manifest.json'), JSON.stringify(exp.manifest, null, 2) + '\n', 'utf8');

  const rep = verifyLedgerExport(exp.jsonl, exp.manifest);
  check('[I3] hash chain + Ed25519 signatures + Merkle roots recompute', rep.ok, `entries=${rep.entries} cases=${rep.cases} days=${rep.days} issues=${rep.issues.length}`);

  const piiNeedles = [truth.pii.patient_name, truth.pii.ssn, truth.pii.member_id, truth.pii.email].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const leak = piiNeedles.find((s) => exp.jsonl.includes(s));
  check('[I4] no raw PII in the exported ledger', leak === undefined, leak ? `leaked: ${leak}` : 'clean');

  // ---- ledger tail ----
  const tailN = Math.min(12, exp.manifest.entry_count);
  console.log(`\nDecision ledger (tail ${tailN} of ${exp.manifest.entry_count}):`);
  for (const e of world.ledger.tail(tailN)) console.log(fmtRow(e));

  // ============ negative control: poisoned citation must fail closed ========
  console.log('\n▶ negative control — golden_11 (single-word-mutated §4.3 quote) must fail closed');
  const pw = buildOfflineWorld({ clock: new TickClock(DEMO_NOW) });
  const pr = await runCasePipeline(pw.makeInput('golden_11'), pw);
  console.log(
    `  outcome=${pr.outcome}  state=${pr.record.state}  receipt: pass=${pr.receipt?.pass} failures=${pr.receipt?.failures.length}  ` +
      `mail_sent=${pw.actuators.fakes.lob.sends.length}`,
  );
  check(
    '[neg] poisoned citation caught → pipeline fails closed (VERIFY_FAILED / DRAFT)',
    pr.outcome === 'VERIFY_FAILED' && pr.record.state === 'DRAFT' && pr.receipt?.pass === false,
    `outcome=${pr.outcome} state=${pr.record.state} pass=${pr.receipt?.pass}`,
  );
  check('[neg] fail-closed case mailed nothing', pw.actuators.fakes.lob.sends.length === 0, `sends=${pw.actuators.fakes.lob.sends.length}`);
  const pexp = pw.ledger.export();
  const prep = verifyLedgerExport(pexp.jsonl, pexp.manifest);
  const caught = pw.ledger.all().some((e) => e.kind === 'citation_failure');
  check(
    '[neg] hallucination-catch logged AND fail-closed ledger still verifies',
    caught && prep.ok,
    `citation_failure_logged=${caught} chain_ok=${prep.ok}`,
  );

  // ============================ summary ====================================
  console.log('\nInvariant checks:');
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);

  const passed = checks.filter((c) => c.ok).length;
  const allOk = passed === checks.length;

  // ---- export the /verify dashboard data (judge-visibility layer) ----
  // Real outputs of the two runs above + an honest tally over the full fixture
  // set, written where the self-contained verify/index.html reads them (no fetch).
  const dashboard = await buildDashboardData({
    world,
    result,
    exp,
    rep,
    neg: { world: pw, result: pr, rep: prep },
    invariants: { passed, total: checks.length },
  });
  const written = writeDashboardData(VERIFY_DATA_DIR, dashboard, exp);
  console.log(`\n/verify dashboard data → verify/data/ (${written.length} files; open verify/index.html)`);

  console.log('');
  console.log('verify this run:  npx tsx scripts/verify_ledger.ts   (reads out/ledger.jsonl, out/ledger_manifest.json)');
  console.log(`checks: ${passed}/${checks.length} passed`);
  console.log(allOk ? 'SELF-TEST: PASS' : 'SELF-TEST: FAIL');
  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error('SELF-TEST: FAIL (threw)');
  console.error(err);
  process.exit(1);
});
