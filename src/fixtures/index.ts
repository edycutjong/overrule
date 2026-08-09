/**
 * Deterministic fixture set assembly (scripts/seed.ts wraps this for disk).
 * Pure string construction from constants — two calls yield byte-identical
 * output, which is what `seed --check` re-hashes (SEED_DATA.md).
 */
import { sha256Hex } from '../core/canonical';
import { CASE_FIXTURES, buildLetter, type CaseFixture } from './golden';
import { buildAllPlanDocs } from './plans';

export interface FixtureCase extends CaseFixture {
  raw_letter: string;
}

export interface FixtureSet {
  cases: FixtureCase[];
  /** doc_id → full text of the synthetic plan document. */
  docs: Record<string, string>;
}

export function generateFixtureSet(): FixtureSet {
  return {
    cases: CASE_FIXTURES.map((f) => ({ ...f, raw_letter: buildLetter(f) })),
    docs: buildAllPlanDocs(),
  };
}

export function getCase(set: FixtureSet, id: string): FixtureCase {
  const c = set.cases.find((c) => c.id === id);
  if (!c) throw new Error(`no fixture case ${id}`);
  return c;
}

/** Files seed.ts writes under fixtures/generated/ (relative path → content). */
export function fixtureFiles(set: FixtureSet): Record<string, string> {
  const files: Record<string, string> = {};
  for (const c of set.cases) files[`letters/${c.id}.txt`] = c.raw_letter;
  for (const [docId, text] of Object.entries(set.docs)) files[`plans/${docId}.txt`] = text;
  files['ground_truth.json'] =
    JSON.stringify(
      {
        schema: 'overrule-ground-truth@1',
        note: 'SYNTHETIC FIXTURES — generated test data; all persons, payers and determinations are fictitious.',
        anchored_to: '2026-07-14T09:00:00Z',
        cases: Object.fromEntries(set.cases.map((c) => [c.id, { kind: c.kind, ...c.truth }])),
      },
      null,
      2,
    ) + '\n';
  return files;
}

/** relative path → sha256 of content. */
export function manifestOf(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of Object.keys(files).sort()) out[p] = sha256Hex(files[p]!);
  return out;
}
