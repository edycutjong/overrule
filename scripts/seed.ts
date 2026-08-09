/**
 * scripts/seed.ts — deterministic fixtures (SEED_DATA.md).
 *
 *   npx tsx scripts/seed.ts          # write fixtures/generated/** + fixtures/manifest.json
 *   npx tsx scripts/seed.ts --check  # regenerate in memory, re-hash everything on disk,
 *                                    # exit non-zero on ANY drift (byte-identical demos)
 *
 * The generator is pure (no randomness, no wall clock): letters, plan docs and
 * ground truth are constant-folded, so two runs are byte-identical. Rulepack
 * fixtures are static source files; their hashes are pinned in the manifest too.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/core/canonical';
import { fixtureFiles, generateFixtureSet, manifestOf } from '../src/fixtures/index';

const BUILD_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GENERATED_DIR = join(BUILD_ROOT, 'fixtures', 'generated');
const RULEPACK_DIR = join(BUILD_ROOT, 'fixtures', 'rulepacks');
const MANIFEST_PATH = join(BUILD_ROOT, 'fixtures', 'manifest.json');

interface Manifest {
  schema: 'overrule-fixture-manifest@1';
  note: string;
  generated: Record<string, string>; // fixtures/generated/<rel> → sha256
  rulepacks: Record<string, string>; // fixtures/rulepacks/<file> → sha256
}

function buildManifest(): { manifest: Manifest; files: Record<string, string> } {
  const files = fixtureFiles(generateFixtureSet());
  const rulepacks: Record<string, string> = {};
  for (const f of readdirSync(RULEPACK_DIR).filter((f) => f.endsWith('.json')).sort()) {
    rulepacks[f] = sha256Hex(readFileSync(join(RULEPACK_DIR, f), 'utf8'));
  }
  return {
    files,
    manifest: {
      schema: 'overrule-fixture-manifest@1',
      note: 'SYNTHETIC fixtures — deterministic generator output; seed --check re-hashes for byte-identical demos.',
      generated: manifestOf(files),
      rulepacks,
    },
  };
}

function writeMode(): void {
  const { manifest, files } = buildManifest();
  for (const [rel, content] of Object.entries(files)) {
    const path = join(GENERATED_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`seed: wrote ${Object.keys(files).length} generated fixture files -> ${GENERATED_DIR}`);
  console.log(`seed: pinned ${Object.keys(manifest.rulepacks).length} rulepack hashes`);
  console.log(`seed: manifest -> ${MANIFEST_PATH}`);
}

function checkMode(): void {
  const problems: string[] = [];
  const { manifest: fresh } = buildManifest();

  if (!existsSync(MANIFEST_PATH)) {
    console.error('seed --check: fixtures/manifest.json missing — run `npx tsx scripts/seed.ts` first');
    process.exit(1);
  }
  const pinned = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

  // 1. generator drift vs pinned manifest
  for (const [rel, hash] of Object.entries(fresh.generated)) {
    if (pinned.generated[rel] === undefined) problems.push(`manifest missing entry: ${rel}`);
    else if (pinned.generated[rel] !== hash) problems.push(`generator drift: ${rel}`);
  }
  for (const rel of Object.keys(pinned.generated)) {
    if (fresh.generated[rel] === undefined) problems.push(`manifest has stale entry: ${rel}`);
  }
  // 2. disk drift vs pinned manifest
  for (const [rel, hash] of Object.entries(pinned.generated)) {
    const path = join(GENERATED_DIR, rel);
    if (!existsSync(path)) problems.push(`file missing on disk: ${rel}`);
    else if (sha256Hex(readFileSync(path, 'utf8')) !== hash) problems.push(`disk drift: ${rel}`);
  }
  // 3. rulepack drift
  for (const [f, hash] of Object.entries(pinned.rulepacks)) {
    if (fresh.rulepacks[f] === undefined) problems.push(`rulepack missing: ${f}`);
    else if (fresh.rulepacks[f] !== hash) problems.push(`rulepack drift: ${f}`);
  }
  for (const f of Object.keys(fresh.rulepacks)) {
    if (pinned.rulepacks[f] === undefined) problems.push(`rulepack not pinned: ${f}`);
  }

  if (problems.length > 0) {
    console.error(`seed --check: FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `seed --check: OK — ${Object.keys(pinned.generated).length} generated files + ${Object.keys(pinned.rulepacks).length} rulepacks byte-identical`,
  );
}

if (process.argv.includes('--check')) checkMode();
else writeMode();
