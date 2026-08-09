/**
 * scripts/verify_ledger.ts — the judge-runnable proof (COMPLEXITY §2/§5).
 * Recomputes every per-case hash chain, every Ed25519 signature, and every
 * daily Merkle root from a JSONL export + manifest, and exits NON-ZERO on any
 * mutation (edited/dropped/reordered rows, swapped signatures, forged roots).
 *
 *   npx tsx scripts/verify_ledger.ts [ledger.jsonl] [ledger_manifest.json]
 *   (defaults: out/ledger.jsonl out/ledger_manifest.json — produced by self_test)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerManifest } from '../src/core/ledger/ledger';
import { verifyLedgerExport } from '../src/core/ledger/verify';

const BUILD_ROOT = fileURLToPath(new URL('..', import.meta.url));
const jsonlPath = process.argv[2] ?? join(BUILD_ROOT, 'out', 'ledger.jsonl');
const manifestPath = process.argv[3] ?? join(BUILD_ROOT, 'out', 'ledger_manifest.json');

let jsonl: string;
let manifest: LedgerManifest;
try {
  jsonl = readFileSync(jsonlPath, 'utf8');
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LedgerManifest;
} catch (err) {
  console.error(`verify_ledger: cannot read inputs: ${(err as Error).message}`);
  console.error('hint: run `npx tsx scripts/self_test.ts` first to produce out/ledger.jsonl');
  process.exit(2);
}

const report = verifyLedgerExport(jsonl, manifest);

console.log('── ledger verification ─────────────────────────────');
console.log(`entries          ${report.entries}`);
console.log(`case chains      ${report.cases}`);
console.log(`days (merkle)    ${report.days}`);
console.log(`key mode         ${manifest.key_mode}`);
for (const [day, root] of Object.entries(manifest.merkle_roots)) {
  console.log(`merkle ${day}  ${root}`);
}
if (report.ok) {
  console.log('RESULT: OK — chain + signatures + merkle roots all recompute');
  process.exit(0);
}
console.error(`RESULT: TAMPER DETECTED — ${report.issues.length} issue(s)`);
for (const issue of report.issues) {
  console.error(`  [${issue.code}] gseq=${issue.gseq ?? '-'} ${issue.detail}`);
}
process.exit(1);
