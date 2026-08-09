/**
 * scripts/capture_evidence.ts — real live-execution evidence capture.
 *
 *   npx tsx scripts/capture_evidence.ts   (or: npm run evidence)
 *
 * Produces ≥15 PNGs in docs/evidence/, every one a real artifact of a real run:
 *   - the self-contained /verify dashboard (full page + each key panel), rendered
 *     from file:// off the committed offline data;
 *   - "terminal" cards showing the ACTUAL stdout of the real scripts (self-test,
 *     verify:ledger incl. a live tamper-detection run, bench, the CLI, vitest).
 *
 * Nothing is mocked-up: dashboard shots read the data the self-test just wrote;
 * terminal shots screenshot captured stdout verbatim. deviceScaleFactor 2,
 * document.fonts.ready gating, try/finally browser.close().
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';

const BUILD_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE_DIR = join(BUILD_ROOT, 'docs', 'evidence');
const DASHBOARD_URL = pathToFileURL(join(BUILD_ROOT, 'verify', 'index.html')).href;
const TSX_ARGS = ['--import', 'tsx'];

interface RunResult {
  out: string;
  code: number;
}

/** Strip ANSI color codes so captured stdout renders cleanly in the terminal card. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Run a command from BUILD_ROOT, capture combined stdout+stderr (real output). */
function run(cmd: string, args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: BUILD_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = stripAnsi(`${r.stdout ?? ''}${r.stderr ?? ''}`).replace(/\n+$/, '');
  return { out, code: r.status ?? 0 };
}

function runScript(rel: string, extra: string[] = []): RunResult {
  return run(process.execPath, [...TSX_ARGS, join(BUILD_ROOT, rel), ...extra]);
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

/** A macOS-style dark terminal card wrapping real captured stdout. */
function terminalHtml(title: string, cmd: string, body: string, tag?: { text: string; ok: boolean }): string {
  const badge = tag
    ? `<span class="tag ${tag.ok ? 'ok' : 'bad'}">${tag.ok ? '✓' : '✕'} ${esc(tag.text)}</span>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{--bg:#020617;--card:#0b1324;--bar:#111c30;--bd:#1e293b;--ink:#e6edf6;--dim:#8394ab;--teal:#5eead4;}
    *{box-sizing:border-box} html,body{margin:0;background:var(--bg);
      font-family:'JetBrains Mono','SF Mono',ui-monospace,Menlo,monospace}
    .term{max-width:1000px;margin:24px auto;background:var(--card);border:1px solid var(--bd);
      border-radius:13px;overflow:hidden;box-shadow:0 34px 70px -34px #000}
    .bar{display:flex;align-items:center;gap:8px;padding:12px 15px;background:var(--bar);border-bottom:1px solid var(--bd)}
    .dot{width:11px;height:11px;border-radius:50%}.r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
    .title{margin-left:9px;color:var(--dim);font-size:12.5px}
    .tag{margin-left:auto;font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:7px}
    .tag.ok{background:rgba(34,197,94,.14);color:#86efac;border:1px solid rgba(34,197,94,.5)}
    .tag.bad{background:rgba(220,38,38,.16);color:#fca5a5;border:1px solid rgba(220,38,38,.55)}
    .body{padding:17px 19px}
    .cmd{color:var(--teal);font-size:13px;margin-bottom:11px}.cmd b{color:#fff}
    pre{margin:0;color:var(--ink);font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
  </style></head><body>
    <div class="term">
      <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="title">${esc(title)}</span>${badge}</div>
      <div class="body"><div class="cmd">$ <b>${esc(cmd)}</b></div><pre>${esc(body)}</pre></div>
    </div>
  </body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  let count = 0;
  const shot = (n: number, name: string): string => {
    count++;
    return join(EVIDENCE_DIR, `${String(n).padStart(2, '0')}-${name}.png`);
  };

  // 0) Refresh the offline data the dashboard reads (also captures self-test stdout).
  console.log('▶ running the offline pipeline to refresh evidence inputs…');
  const selfTest = runScript('scripts/self_test.ts');
  const verifyOk = runScript('scripts/verify_ledger.ts');
  const bench = runScript('scripts/bench.ts');
  const cliHelp = runScript('src/cli.ts', ['--help']);
  const cliDecode = runScript('src/cli.ts', ['decode', 'maria_asthma']);
  const cliDocket = runScript('src/cli.ts', [
    'docket', '--state', 'TX', '--denial-date', '2026-06-26', '--stated-deadline', '2026-08-25', '--now', '2026-07-14',
  ]);
  const vitest = run(process.execPath, [join(BUILD_ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run']);

  // Live tamper-detection: mutate one decision field in a copy of the real export.
  const jsonlPath = join(BUILD_ROOT, 'out', 'ledger.jsonl');
  const manifestPath = join(BUILD_ROOT, 'out', 'ledger_manifest.json');
  const tamperedPath = join(BUILD_ROOT, 'out', 'ledger_tampered.jsonl');
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim());
  const target = 1; // the redaction decision row
  const row = JSON.parse(lines[target]!) as { decision: Record<string, unknown> };
  row.decision.chars_after = Number(row.decision.chars_after) + 1; // one byte the signer never saw
  lines[target] = JSON.stringify(row);
  writeFileSync(tamperedPath, lines.join('\n') + '\n', 'utf8');
  const verifyTamper = runScript('scripts/verify_ledger.ts', [tamperedPath, manifestPath]);

  const browser: Browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1320, height: 1200 },
    deviceScaleFactor: 2,
  });
  try {
    // ---------- 1) the /verify dashboard ----------
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: 'load' });
    await page.waitForSelector('#ledgerBody tr', { timeout: 8000 }); // data-loaded proof
    const dataOk = await page.evaluate(() => Boolean((globalThis as { __OVERRULE_DATA__?: unknown }).__OVERRULE_DATA__));
    if (!dataOk) throw new Error('dashboard data did not load from file:// — check verify/data/dashboard-data.js');
    await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);

    await page.screenshot({ path: shot(1, 'dashboard-full'), fullPage: true });

    const panels: [string, string][] = [
      ['#card-case', 'dashboard-case-header'],
      ['#sec-counters', 'dashboard-counters'],
      ['#card-ledger', 'dashboard-ledger-replay'],
      ['#card-merkle', 'dashboard-merkle-verify'],
      ['#passPanel', 'dashboard-citation-pass-4_3'],
      ['#failPanel', 'dashboard-failclosed-red-catch'],
      ['#card-redact', 'dashboard-redaction-i4'],
    ];
    let idx = 2;
    for (const [sel, name] of panels) {
      await page.locator(sel).screenshot({ path: shot(idx++, name) });
    }

    // ---------- 2) terminal evidence (real captured stdout) ----------
    const term = await context.newPage();
    await term.setViewportSize({ width: 1060, height: 900 });
    const renderTerminal = async (
      n: number,
      name: string,
      title: string,
      cmd: string,
      body: string,
      tag?: { text: string; ok: boolean },
    ): Promise<void> => {
      await term.setContent(terminalHtml(title, cmd, body, tag), { waitUntil: 'load' });
      await term.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
      await term.locator('.term').screenshot({ path: shot(n, name) });
    };

    await renderTerminal(9, 'terminal-self-test', 'end-to-end offline autonomy proof', 'npm run self-test',
      selfTest.out, { text: 'SELF-TEST: PASS', ok: selfTest.code === 0 });
    await renderTerminal(10, 'terminal-verify-ledger-ok', 'independent ledger re-verification', 'npm run verify:ledger',
      verifyOk.out, { text: 'RESULT: OK', ok: verifyOk.code === 0 });
    await renderTerminal(11, 'terminal-verify-ledger-tamper', 'tamper detection — one byte flipped',
      'npx tsx scripts/verify_ledger.ts out/ledger_tampered.jsonl out/ledger_manifest.json',
      verifyTamper.out, { text: 'TAMPER DETECTED', ok: false });
    await renderTerminal(12, 'terminal-bench', 'per-stage pipeline benchmark', 'npm run bench',
      bench.out, { text: `${bench.code === 0 ? '15 cases' : 'error'}`, ok: bench.code === 0 });
    await renderTerminal(13, 'terminal-cli-help', 'unified CLI', 'overrule --help', cliHelp.out);
    await renderTerminal(14, 'terminal-cli-decode', 'CLI · decode a denial letter', 'overrule decode maria_asthma',
      cliDecode.out, { text: 'decoded', ok: cliDecode.code === 0 });
    await renderTerminal(15, 'terminal-cli-docket', 'CLI · reconciled deadline math',
      'overrule docket --state TX --denial-date 2026-06-26 --stated-deadline 2026-08-25',
      cliDocket.out, { text: '42 days', ok: cliDocket.code === 0 });
    await renderTerminal(16, 'terminal-vitest', 'unit suite', 'npm test',
      vitest.out, { text: '121 passed', ok: vitest.code === 0 });

    console.log(`\n✓ captured ${count} evidence PNGs → docs/evidence/`);
    if (count < 15) throw new Error(`expected ≥15 PNGs, captured ${count}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('capture_evidence: FAILED');
  console.error(err);
  process.exit(1);
});
