/**
 * GeminiAdapter — the seam between deterministic pipeline mechanics and LLM
 * judgment calls (ARCHITECTURE: every LLM call is Gemini). Two implementations:
 *   - DeterministicMockAdapter (mockAdapter.ts): fixture-driven; the ONLY
 *     adapter tests use — tests never touch the network.
 *   - GoogleGenAiAdapter (genaiAdapter.ts): real @google/genai calls, built
 *     only when GEMINI_API_KEY is set. Never required by tests.
 *
 * Raw (pre-redaction) text may flow ONLY into findPiiSpans — every other
 * method receives redacted text; the pipeline enforces this and tests spy on it.
 */
import type { Citation, ClauseLocator, DenialFacts, PiiSpan, StrategyPlan, TriageResult } from '../types';

export interface TriageInput {
  redacted_letter: string;
}

export interface EvidenceInput {
  redacted_letter: string;
  plan_text: string;
}

export interface ClauseInput {
  facts: DenialFacts;
  plan_text: string;
}

export interface DraftInput {
  facts: DenialFacts;
  strategy: StrategyPlan;
  plan_text: string;
  redacted_letter: string;
}

export interface DraftOutput {
  body: string;
  citations: Citation[];
}

export interface GeminiAdapter {
  readonly name: string;
  /** Redaction span extraction — the single stage allowed to see raw text. */
  findPiiSpans(rawText: string): Promise<PiiSpan[]>;
  triage(input: TriageInput): Promise<TriageResult>;
  extractEvidence(input: EvidenceInput): Promise<DenialFacts>;
  suggestClauses(input: ClauseInput): Promise<ClauseLocator[]>;
  draftAppeal(input: DraftInput): Promise<DraftOutput>;
}
