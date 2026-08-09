/**
 * DeterministicMockAdapter — fixture-driven GeminiAdapter. Identifies the case
 * by the SYNTHETIC-FIXTURE-ID watermark in the letter and answers from ground
 * truth. Zero I/O, zero randomness: tests and demos are byte-reproducible.
 *
 * Honesty note: with this adapter, extraction "accuracy" measures the harness
 * and fixtures, not model quality — the golden evals lock the offline
 * contract; real-adapter evals are the deferred online path (README).
 */
import { extractFixtureId } from '../../fixtures/letters';
import type { FixtureCase, FixtureSet } from '../../fixtures/index';
import type { Citation, ClauseLocator, DenialFacts, PiiSpan, TriageResult } from '../types';
import type {
  ClauseInput,
  DraftInput,
  DraftOutput,
  EvidenceInput,
  GeminiAdapter,
  TriageInput,
} from './adapter';

export class DeterministicMockAdapter implements GeminiAdapter {
  readonly name = 'deterministic-mock';

  constructor(private readonly fixtures: FixtureSet) {}

  private byLetter(text: string): FixtureCase {
    const id = extractFixtureId(text);
    if (!id) throw new Error('mock adapter: letter has no SYNTHETIC-FIXTURE-ID watermark');
    const c = this.fixtures.cases.find((c) => c.id === id);
    if (!c) throw new Error(`mock adapter: unknown fixture id ${id}`);
    return c;
  }

  /** Name spans: every occurrence of the patient's full name (regexes can't do names). */
  async findPiiSpans(rawText: string): Promise<PiiSpan[]> {
    const c = this.byLetter(rawText);
    const spans: PiiSpan[] = [];
    const needle = c.truth.pii.patient_name;
    let from = 0;
    for (;;) {
      const i = rawText.indexOf(needle, from);
      if (i === -1) break;
      spans.push({ start: i, end: i + needle.length, kind: 'name' });
      from = i + needle.length;
    }
    return spans;
  }

  async triage(input: TriageInput): Promise<TriageResult> {
    const c = this.byLetter(input.redacted_letter);
    return { accept: c.truth.expect_accept, p_win: c.truth.p_win, reason: c.truth.triage_reason };
  }

  async extractEvidence(input: EvidenceInput): Promise<DenialFacts> {
    const c = this.byLetter(input.redacted_letter);
    return {
      payer: c.truth.payer,
      denial_code: c.truth.denial_code,
      denial_reason: c.truth.denial_reason,
      service: c.truth.service,
      denial_date: c.truth.denial_date,
      stated_deadline: c.truth.stated_deadline,
      state: c.truth.us_state,
      plan_doc_id: c.truth.plan_doc_id,
    };
  }

  async suggestClauses(input: ClauseInput): Promise<ClauseLocator[]> {
    const c = this.byFacts(input.facts);
    if (!c.truth.winning) return [];
    const { doc_id, section, page } = c.truth.winning;
    return [{ doc_id, section, page }];
  }

  async draftAppeal(input: DraftInput): Promise<DraftOutput> {
    const c = this.byLetter(input.redacted_letter);
    const citations: Citation[] = c.truth.winning ? [{ ...c.truth.winning }] : [];
    const cite = citations[0];
    const body = [
      'RE: Appeal of adverse benefit determination — SYNTHETIC DRAFT (fixture pipeline output)',
      '',
      `Denial code ${input.facts.denial_code} (${input.facts.denial_reason}) is contested on the following grounds.`,
      cite
        ? `The member's plan, ${cite.section} (page ${cite.page}), provides: "${cite.quote}"`
        : 'The determination misapplies the plan terms.',
      c.truth.policy_note ?? '',
      `The service at issue — ${input.facts.service} — satisfies the quoted terms; the determination should be reversed.`,
      '',
      'This document was generated as part of an offline test fixture. Not legal or medical advice.',
    ]
      .filter((l) => l !== '')
      .join('\n');
    return { body, citations };
  }

  private byFacts(facts: DenialFacts): FixtureCase {
    // Deterministic reverse lookup used where only structured facts flow.
    const c = this.fixtures.cases.find(
      (c) =>
        c.truth.denial_code === facts.denial_code &&
        c.truth.denial_date === facts.denial_date &&
        c.truth.service === facts.service,
    );
    if (!c) throw new Error('mock adapter: no fixture matches the given facts');
    return c;
  }
}
