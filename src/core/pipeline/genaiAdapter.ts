/**
 * GoogleGenAiAdapter — the REAL Gemini implementation of GeminiAdapter
 * (ARCHITECTURE: `@google/genai`, AI Studio key; 2.5 Flash for volume stages,
 * 2.5 Pro for extraction/strategy/drafting).
 *
 * HONEST STATUS: implemented against the published @google/genai v1 surface
 * (dynamic import, responseMimeType + responseSchema JSON output), but NOT
 * exercised in this offline build — no live key is used here, tests never load
 * this module, and createGeminiAdapterFromEnv() returns null without
 * GEMINI_API_KEY. Live-call validation is Week-2 online work (BUILD_PLAN).
 * PDF multimodal ingestion and context caching are likewise online-path work;
 * this adapter takes extracted text like the rest of the offline core.
 */
import type { Citation, ClauseLocator, DenialFacts, PiiSpan, TriageResult } from '../types';
import type {
  ClauseInput,
  DraftInput,
  DraftOutput,
  EvidenceInput,
  GeminiAdapter,
  TriageInput,
} from './adapter';

const FLASH = 'gemini-2.5-flash';
const PRO = 'gemini-2.5-pro';

interface GenAiClientLike {
  models: {
    generateContent(req: {
      model: string;
      contents: string;
      config?: Record<string, unknown>;
    }): Promise<{ text?: string }>;
  };
}

export class GoogleGenAiAdapter implements GeminiAdapter {
  readonly name = 'google-genai';

  private constructor(private readonly ai: GenAiClientLike) {}

  static async create(apiKey: string): Promise<GoogleGenAiAdapter> {
    // Dynamic import so the SDK never loads in offline/test runs.
    const { GoogleGenAI } = await import('@google/genai');
    return new GoogleGenAiAdapter(new GoogleGenAI({ apiKey }) as unknown as GenAiClientLike);
  }

  private async json<T>(model: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
    const res = await this.ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0,
      },
    });
    const text = res.text;
    if (!text) throw new Error(`gemini ${model}: empty response`);
    return JSON.parse(text) as T;
  }

  async findPiiSpans(rawText: string): Promise<PiiSpan[]> {
    const out = await this.json<{ spans: { start: number; end: number; kind: string }[] }>(
      FLASH,
      'You extract PII spans (personal names, addresses) from insurance letters. Return exact character offsets into the given text.',
      `TEXT START\n${rawText}\nTEXT END\nReturn every span of a person name or postal address.`,
      {
        type: 'object',
        properties: {
          spans: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                start: { type: 'integer' },
                end: { type: 'integer' },
                kind: { type: 'string', enum: ['name', 'address'] },
              },
              required: ['start', 'end', 'kind'],
            },
          },
        },
        required: ['spans'],
      },
    );
    return out.spans.filter((s) => s.kind === 'name' || s.kind === 'address') as PiiSpan[];
  }

  async triage(input: TriageInput): Promise<TriageResult> {
    return this.json<TriageResult>(
      FLASH,
      'You triage health-insurance denial appeals. Estimate a calibrated win probability and accept/decline.',
      `Redacted denial letter:\n${input.redacted_letter}\nReturn accept (p_win >= 0.30), p_win in [0,1], and a one-sentence reason.`,
      {
        type: 'object',
        properties: {
          accept: { type: 'boolean' },
          p_win: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['accept', 'p_win', 'reason'],
      },
    );
  }

  async extractEvidence(input: EvidenceInput): Promise<DenialFacts> {
    return this.json<DenialFacts>(
      PRO,
      'You extract structured facts from redacted denial letters. Dates must be ISO YYYY-MM-DD; stated_deadline is null when the letter names no explicit date.',
      `Redacted letter:\n${input.redacted_letter}\n\nPlan document id must be echoed from the SYNTHETIC-DOC-ID line of the plan text:\n${input.plan_text.slice(0, 2000)}`,
      {
        type: 'object',
        properties: {
          payer: { type: 'string' },
          denial_code: { type: 'string' },
          denial_reason: { type: 'string' },
          service: { type: 'string' },
          denial_date: { type: 'string' },
          stated_deadline: { type: 'string', nullable: true },
          state: { type: 'string', enum: ['TX', 'CA', 'NY'] },
          plan_doc_id: { type: 'string' },
        },
        required: ['payer', 'denial_code', 'denial_reason', 'service', 'denial_date', 'state', 'plan_doc_id'],
      },
    );
  }

  async suggestClauses(input: ClauseInput): Promise<ClauseLocator[]> {
    const out = await this.json<{ clauses: ClauseLocator[] }>(
      PRO,
      'You find the plan clauses most likely to overturn a denial. Cite section labels and 1-based page numbers exactly as printed.',
      `Facts: ${JSON.stringify(input.facts)}\nPlan document:\n${input.plan_text}`,
      {
        type: 'object',
        properties: {
          clauses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                doc_id: { type: 'string' },
                section: { type: 'string' },
                page: { type: 'integer' },
              },
              required: ['doc_id', 'section', 'page'],
            },
          },
        },
        required: ['clauses'],
      },
    );
    return out.clauses;
  }

  async draftAppeal(input: DraftInput): Promise<DraftOutput> {
    const out = await this.json<{ body: string; citations: Citation[] }>(
      PRO,
      'You draft clause-cited insurance appeals. Every citation quote MUST be copied byte-for-byte from the plan document — a deterministic verifier rejects any deviation.',
      `Facts: ${JSON.stringify(input.facts)}\nStrategy: ${JSON.stringify(input.strategy)}\nPlan document:\n${input.plan_text}\nRedacted letter:\n${input.redacted_letter}`,
      {
        type: 'object',
        properties: {
          body: { type: 'string' },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                doc_id: { type: 'string' },
                section: { type: 'string' },
                page: { type: 'integer' },
                quote: { type: 'string' },
              },
              required: ['doc_id', 'section', 'page', 'quote'],
            },
          },
        },
        required: ['body', 'citations'],
      },
    );
    return out;
  }
}

/** Null unless GEMINI_API_KEY is set — tests run entirely on the mock adapter. */
export async function createGeminiAdapterFromEnv(): Promise<GoogleGenAiAdapter | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return GoogleGenAiAdapter.create(key);
}
