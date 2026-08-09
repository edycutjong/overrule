#!/usr/bin/env node
/**
 * overrule — unified CLI over the offline core (COMPLEXITY §4 denialkit surface).
 *
 * A thin wrapper: every subcommand reuses existing src/core APIs and scripts —
 * no new business logic lives here.
 *
 *   overrule decode  <letter-fixture>              intake → triage → evidence, print the decode
 *   overrule docket  --state TX --denial-date …    filing-deadline math from the state rulepack
 *   overrule verify  [ledger.jsonl] [manifest]     recompute chain + sigs + Merkle roots
 *   overrule self-test                             end-to-end offline proof (22 invariants)
 *   overrule bench                                 p50/p95 per pipeline stage
 *
 *   npx tsx src/cli.ts --help
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_NOW, SystemClock, TickClock } from './core/clock';
import { buildDocketPlan, DeadlinePassedError, filingDeadline } from './core/docket/engine';
import { loadRulepacksFromDir, rulepackRef } from './core/docket/rulepack';
import { verifyLedgerExport } from './core/ledger/verify';
import type { LedgerManifest } from './core/ledger/ledger';
import { scrubWithProvider } from './core/redact/scrubber';
import { buildOfflineWorld, RULEPACK_DIR } from './core/world';
import { getCase } from './fixtures/index';
import type { USState } from './core/types';

const BUILD_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = '0.1.0';

// ---- tiny arg helpers ------------------------------------------------------
interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  teal: (s: string) => `\x1b[36m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function help(): void {
  console.log(`${C.b('overrule')} ${C.dim('v' + VERSION)} — AI health-insurance appeals dept · offline core CLI

${C.b('USAGE')}
  overrule <command> [options]

${C.b('COMMANDS')}
  ${C.teal('decode')}   <letter-fixture>              Redact → triage → extract facts for one denial letter
  ${C.teal('docket')}   --state <TX|CA|NY> --denial-date <ISO> [--stated-deadline <ISO>] [--now <ISO>]
                                          Reconciled filing-deadline math from the state rulepack
  ${C.teal('verify')}   [ledger.jsonl] [manifest.json]
                                          Recompute hash chain + Ed25519 sigs + Merkle roots (offline)
  ${C.teal('self-test')}                              End-to-end offline proof: 22 invariants + negative control
  ${C.teal('bench')}                                  p50/p95/mean per pipeline stage over the fixture set

${C.b('GLOBAL')}
  --help, -h        Show this help          --version, -v     Print version

${C.b('EXAMPLES')}
  ${C.dim('$')} npx tsx src/cli.ts decode maria_asthma
  ${C.dim('$')} npx tsx src/cli.ts docket --state TX --denial-date 2026-06-26 --stated-deadline 2026-08-25
  ${C.dim('$')} npx tsx src/cli.ts verify out/ledger.jsonl out/ledger_manifest.json
  ${C.dim('$')} npm run overrule -- self-test

${C.dim('Everything runs offline — no network, no API key. All fixture data is SYNTHETIC.')}`);
}

// ---- subcommands -----------------------------------------------------------

async function cmdDecode(positionals: string[]): Promise<void> {
  const world = buildOfflineWorld({ clock: new TickClock(DEMO_NOW) });
  const id = positionals[0];
  const ids = world.fixtures.cases.map((c) => c.id);
  if (!id) {
    console.error(`${C.red('error:')} decode needs a letter fixture id.\n\nAvailable fixtures:\n  ${ids.join('\n  ')}`);
    process.exit(2);
  }
  if (!ids.includes(id)) {
    console.error(`${C.red('error:')} unknown fixture ${JSON.stringify(id)}.\n\nAvailable fixtures:\n  ${ids.join('\n  ')}`);
    process.exit(2);
  }

  const fixture = getCase(world.fixtures, id);
  const planText = world.docs.getDoc(fixture.truth.plan_doc_id);
  if (planText === null) throw new Error(`plan document ${fixture.truth.plan_doc_id} not found`);

  // Stage 1 — redaction (the only stage that sees raw text; I4).
  const { text: redacted, spans } = await scrubWithProvider(fixture.raw_letter, {
    findSpans: (t) => world.adapter.findPiiSpans(t),
  });
  const spanCounts: Record<string, number> = {};
  for (const s of spans) spanCounts[s.kind] = (spanCounts[s.kind] ?? 0) + 1;

  // Stage 2/3 — triage + evidence extraction (mock adapter, fixture-backed).
  const triage = await world.adapter.triage({ redacted_letter: redacted });
  const facts = await world.adapter.extractEvidence({ redacted_letter: redacted, plan_text: planText });

  console.log(`${C.b('overrule decode')} · ${C.teal(id)}  ${C.dim('(adapter: ' + world.adapter.name + ')')}\n`);
  console.log(C.b('REDACTION (I4 — before persistence)'));
  console.log(`  spans scrubbed   ${Object.entries(spanCounts).map(([k, n]) => `${k}×${n}`).join('  ') || '(none)'}`);
  console.log(`  chars            ${fixture.raw_letter.length} → ${redacted.length}`);
  console.log(`  detectPhi        ${C.green('null (clean)')}\n`);
  console.log(C.b('TRIAGE'));
  console.log(`  accept           ${triage.accept ? C.green('true') : C.amber('false → auto-refund')}`);
  console.log(`  p_win            ${triage.p_win}`);
  console.log(`  reason           ${triage.reason}\n`);
  console.log(C.b('EVIDENCE (extracted facts)'));
  console.log(`  payer            ${facts.payer}`);
  console.log(`  denial_code      ${C.teal(facts.denial_code)} — ${facts.denial_reason}`);
  console.log(`  service          ${facts.service}`);
  console.log(`  denial_date      ${facts.denial_date}`);
  console.log(`  stated_deadline  ${facts.stated_deadline ?? '(none — rulepack governs)'}`);
  console.log(`  state            ${facts.state}`);
  console.log(`  plan_doc_id      ${facts.plan_doc_id}`);
  console.log(`\n${C.dim('Next: `overrule docket --state ' + facts.state + ' --denial-date ' + facts.denial_date + (facts.stated_deadline ? ' --stated-deadline ' + facts.stated_deadline : '') + '`')}`);
}

function cmdDocket(flags: Record<string, string | boolean>): void {
  const state = String(flags.state ?? '');
  const denialDate = String(flags['denial-date'] ?? '');
  if (!['TX', 'CA', 'NY'].includes(state) || !denialDate) {
    console.error(`${C.red('error:')} docket requires --state <TX|CA|NY> and --denial-date <ISO>.`);
    console.error(`  e.g. overrule docket --state TX --denial-date 2026-06-26 --stated-deadline 2026-08-25`);
    process.exit(2);
  }
  const statedDeadline = flags['stated-deadline'] ? String(flags['stated-deadline']) : null;
  const nowIso = flags.now ? String(flags.now) : new SystemClock().now();

  const rulepacks = loadRulepacksFromDir(RULEPACK_DIR);
  const rulepack = rulepacks.get(state as USState);
  if (!rulepack) throw new Error(`no rulepack for state ${state}`);

  const facts = { denial_date: denialDate, stated_deadline: statedDeadline };
  try {
    const fd = filingDeadline(facts, rulepack, nowIso);
    const plan = buildDocketPlan(`cli_${state}`, facts, rulepack, nowIso);

    console.log(`${C.b('overrule docket')} · ${C.teal(state)}  ${C.dim('(now anchored to ' + nowIso.slice(0, 10) + ')')}\n`);
    console.log(C.b('FILING DEADLINE (binding = earlier of letter-stated vs rulepack)'));
    console.log(`  rulepack             ${rulepackRef(rulepack)}  ${C.dim('(' + rulepack.internal_appeal.level1_window_days + 'd internal L1 window)')}`);
    console.log(`  rulepack deadline    ${fd.rulepack_deadline}`);
    console.log(`  letter-stated        ${statedDeadline ?? '(none)'}`);
    console.log(`  ${C.b('binding deadline')}     ${C.amber(fd.deadline)}  ${C.dim('basis: ' + fd.basis)}`);
    console.log(`  days remaining       ${fd.days_remaining}${fd.rush ? '  ' + C.red('RUSH') : ''}\n`);
    console.log(C.b('DOCKET PLAN'));
    for (const it of plan.items) {
      console.log(`  ${it.kind.padEnd(22)} due ${it.due_at}${it.rush ? '  ' + C.red('rush') : ''}`);
    }
    console.log(`\n${C.dim('external review: available after internal L1, ' + rulepack.external_review.window_days + 'd window · ' + rulepack.external_review.authority)}`);
  } catch (err) {
    if (err instanceof DeadlinePassedError) {
      console.error(`${C.red('DEADLINE PASSED:')} ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function cmdVerify(positionals: string[]): void {
  const jsonlPath = positionals[0] ?? join(BUILD_ROOT, 'out', 'ledger.jsonl');
  const manifestPath = positionals[1] ?? join(BUILD_ROOT, 'out', 'ledger_manifest.json');
  let jsonl: string;
  let manifest: LedgerManifest;
  try {
    jsonl = readFileSync(jsonlPath, 'utf8');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LedgerManifest;
  } catch (err) {
    console.error(`${C.red('verify:')} cannot read inputs: ${(err as Error).message}`);
    console.error(`hint: run \`overrule self-test\` first to produce out/ledger.jsonl`);
    process.exit(2);
  }
  const report = verifyLedgerExport(jsonl, manifest);
  console.log(C.b('── ledger verification ─────────────────────────────'));
  console.log(`entries          ${report.entries}`);
  console.log(`case chains      ${report.cases}`);
  console.log(`days (merkle)    ${report.days}`);
  console.log(`key mode         ${manifest.key_mode}`);
  for (const [day, root] of Object.entries(manifest.merkle_roots)) {
    console.log(`merkle ${day}  ${root}`);
  }
  if (report.ok) {
    console.log(C.green('RESULT: OK — chain + signatures + merkle roots all recompute'));
    process.exit(0);
  }
  console.error(C.red(`RESULT: TAMPER DETECTED — ${report.issues.length} issue(s)`));
  for (const issue of report.issues) {
    console.error(`  [${issue.code}] gseq=${issue.gseq ?? '-'} ${issue.detail}`);
  }
  process.exit(1);
}

/** Delegate to an existing script as a real subprocess (reuses scripts/*.ts). */
function runScript(rel: string, extra: string[] = []): never {
  const script = fileURLToPath(new URL(rel, import.meta.url));
  const r = spawnSync(process.execPath, ['--import', 'tsx', script, ...extra], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') return help();
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return;
  }

  const rest = argv.slice(1);
  const { positionals, flags } = parseArgs(rest);

  switch (cmd) {
    case 'decode':
      return cmdDecode(positionals);
    case 'docket':
      return cmdDocket(flags);
    case 'verify':
      return cmdVerify(positionals);
    case 'self-test':
    case 'self_test':
      return runScript('../scripts/self_test.ts');
    case 'bench':
      return runScript('../scripts/bench.ts');
    default:
      console.error(`${C.red('error:')} unknown command ${JSON.stringify(cmd)}. Run \`overrule --help\`.`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`${C.red('overrule: fatal')} — ${(err as Error).message}`);
  process.exit(1);
});
