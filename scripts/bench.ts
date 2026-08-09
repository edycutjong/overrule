/**
 * scripts/bench.ts — p50/p95/mean/min/max per pipeline stage over the golden
 * set (COMPLEXITY §5), using the DeterministicMockAdapter.
 *
 * HONEST FRAMING: these timings measure the pipeline MECHANICS (redaction
 * regexes, hashing, signing, state machine, verifier byte-matching) — the mock
 * adapter answers instantly. Real-model latencies are the online path and are
 * benchmarked separately in Week 2+ (BUILD_PLAN).
 */
import { TickClock, DEMO_NOW } from '../src/core/clock';
import { runCasePipeline, type StageName } from '../src/core/pipeline/pipeline';
import { buildOfflineWorld } from '../src/core/world';

const STAGES: StageName[] = ['redact', 'triage', 'evidence', 'strategy', 'draft', 'verify', 'case_ops'];

function pct(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return NaN;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return sortedMs[idx]!;
}

function fmt(n: number): string {
  return Number.isNaN(n) ? '   -  ' : n.toFixed(2).padStart(7);
}

async function main(): Promise<void> {
  const world = buildOfflineWorld({ clock: new TickClock(DEMO_NOW) });
  const perStage = new Map<StageName, number[]>(STAGES.map((s) => [s, []]));
  const endToEnd: number[] = [];
  let cases = 0;
  const outcomes: Record<string, number> = {};

  for (const c of world.fixtures.cases) {
    const t0 = performance.now();
    const result = await runCasePipeline(world.makeInput(c.id), world);
    endToEnd.push(performance.now() - t0);
    cases += 1;
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
    for (const [stage, ms] of Object.entries(result.stage_ms)) {
      perStage.get(stage as StageName)!.push(ms);
    }
  }

  console.log(`bench: ${cases} fixture cases through the full pipeline (DeterministicMockAdapter)`);
  console.log(`outcomes: ${JSON.stringify(outcomes)}`);
  console.log('');
  console.log('stage      n     p50     p95    mean     min     max   (ms)');
  console.log('─────────────────────────────────────────────────────────────');
  for (const stage of STAGES) {
    const samples = [...perStage.get(stage)!].sort((a, b) => a - b);
    const n = samples.length;
    const mean = n ? samples.reduce((a, b) => a + b, 0) / n : NaN;
    console.log(
      `${stage.padEnd(9)}${String(n).padStart(3)} ${fmt(pct(samples, 50))} ${fmt(pct(samples, 95))} ${fmt(mean)} ${fmt(samples[0] ?? NaN)} ${fmt(samples[n - 1] ?? NaN)}`,
    );
  }
  const e2e = [...endToEnd].sort((a, b) => a - b);
  const e2eMean = e2e.reduce((a, b) => a + b, 0) / e2e.length;
  console.log('─────────────────────────────────────────────────────────────');
  console.log(
    `${'end-to-end'.padEnd(9)}${String(e2e.length).padStart(3)} ${fmt(pct(e2e, 50))} ${fmt(pct(e2e, 95))} ${fmt(e2eMean)} ${fmt(e2e[0]!)} ${fmt(e2e[e2e.length - 1]!)}`,
  );
  console.log('');
  console.log(`ledger rows appended: ${world.ledger.length}`);
  console.log('note: mock-adapter timings — pipeline mechanics only, not model latency.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
