/**
 * Synthetic plan documents (SEED_DATA.md): text stand-ins for the 90-page plan
 * PDFs — PDF ingestion is the real-Gemini path (deferred); the offline core
 * operates on extracted text. Every doc is watermarked SYNTHETIC.
 *
 * Pages are delimited with `===== PAGE n =====` markers; the CitationVerifier
 * checks quotes against the exact page segment, so clause placement (e.g. §4.3
 * on page 87) is load-bearing, not decorative.
 */

export interface PlanClause {
  page: number;
  section: string; // e.g. "§4.3"
  heading: string;
  /** Full clause text — golden quotes are substrings of this by construction. */
  text: string;
}

export interface PlanDocDef {
  doc_id: string;
  title: string;
  pages: number;
  clauses: PlanClause[];
}

import { pageMarker, pageText as corePageText } from '../core/docformat';

export const PAGE_MARKER = pageMarker;
export const pageText = corePageText;

const WATERMARK =
  '=== SYNTHETIC FIXTURE — generated test document for the Overrule offline core. ' +
  'Not a real insurance plan; all provisions are fictitious. ===';

/** Deterministic filler so 90-page docs are realistic-shaped without randomness. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const FILLER_POOL = [
  'Benefits described in this section are subject to the exclusions and limitations set out in Section 7 and to the definitions in Section 1.',
  'Coverage determinations are made in accordance with the medical policy bulletins in effect on the date of service.',
  'Members must use participating providers except where this document states otherwise or where emergency care applies.',
  'Cost sharing amounts, including copayments, coinsurance and deductibles, are listed in the Schedule of Benefits.',
  'Services must be medically necessary as defined in Section 1.14 unless this document expressly provides otherwise.',
  'Prior authorization requirements for the services in this section are listed in the Utilization Management Addendum.',
  'Nothing in this section limits the member’s right to appeal an adverse benefit determination under Section 9.',
  'Benefit limits are applied per calendar year unless a different period is stated for a specific service.',
];

function fillerParagraph(docId: string, page: number, i: number): string {
  return FILLER_POOL[fnv1a(`${docId}:${page}:${i}`) % FILLER_POOL.length]!;
}

export function buildPlanDoc(def: PlanDocDef): string {
  const byPage = new Map<number, PlanClause[]>();
  for (const c of def.clauses) {
    if (c.page < 1 || c.page > def.pages) throw new Error(`clause ${c.section} page ${c.page} outside 1..${def.pages}`);
    byPage.set(c.page, [...(byPage.get(c.page) ?? []), c]);
  }
  const parts: string[] = [WATERMARK, `SYNTHETIC-DOC-ID: ${def.doc_id}`, ''];
  for (let p = 1; p <= def.pages; p++) {
    parts.push(PAGE_MARKER(p), '');
    if (p === 1) parts.push(`${def.title} (SYNTHETIC)`, '');
    for (const clause of byPage.get(p) ?? []) {
      parts.push(`${clause.section} ${clause.heading}`, clause.text, '');
    }
    parts.push(fillerParagraph(def.doc_id, p, 0), '', fillerParagraph(def.doc_id, p, 1), '');
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// The two synthetic plan documents (SEED_DATA: 2 synthetic plan PDFs)
// ---------------------------------------------------------------------------

/** The maria_asthma winning clause — §4.3, page 87 of 90 (SEED_DATA verbatim intent). */
export const AETNA_43_TEXT =
  'Nebulized corticosteroid therapy, including budesonide inhalation suspension, is a covered benefit for ' +
  'members under age 12 with a documented diagnosis of pediatric persistent asthma, when prescribed by the ' +
  'treating physician after at least one course of inhaled corticosteroid therapy delivered by metered-dose ' +
  'inhaler with spacer has been tried, and subject to the utilization criteria referenced in the payer’s ' +
  'clinical policy bulletin for pediatric respiratory care.';

export const PLAN_AETNA_PPO: PlanDocDef = {
  doc_id: 'plan_aetna_ppo_2026',
  title: 'AETNA OPEN CHOICE PPO — EVIDENCE OF COVERAGE, PLAN YEAR 2026',
  pages: 90,
  clauses: [
    {
      page: 12,
      section: '§2.8',
      heading: 'Inhaler devices and spacers.',
      // Vocabulary-gap decoy (SEED_DATA): member vocabulary lives on an early page,
      // the winning payer-vocabulary clause is buried on page 87.
      text:
        'Asthma inhalers (metered-dose inhaler devices) and spacer attachments are covered under the durable ' +
        'medical equipment benefit when dispensed by a participating pharmacy. This section does not address ' +
        'nebulized medication therapy, which is described in Section 4.',
    },
    {
      page: 45,
      section: '§3.9',
      heading: 'Prior authorization — imaging and specialty pharmacy.',
      text:
        'Failure by a participating provider to obtain prior authorization shall not be grounds to deny an ' +
        'otherwise covered service to the member; in such cases the plan shall conduct a retrospective review ' +
        'of medical necessity and may not impose the authorization penalty on the member.',
    },
    {
      page: 87,
      section: '§4.3',
      heading: 'Respiratory care — nebulized therapy.',
      text: AETNA_43_TEXT,
    },
    {
      page: 88,
      section: '§4.4',
      heading: 'Step therapy exceptions.',
      text:
        'A step therapy protocol shall be waived where the member’s treating physician documents that the ' +
        'protocol-required drug has been ineffective for the member in the previous 180 days, or is reasonably ' +
        'expected to be ineffective or to cause harm based on the member’s documented clinical history.',
    },
  ],
};

export const PLAN_BLUECREST_HMO: PlanDocDef = {
  doc_id: 'plan_bluecrest_hmo_2026',
  title: 'BLUECREST COMMUNITY HMO — MEMBER HANDBOOK AND EVIDENCE OF COVERAGE 2026',
  pages: 40,
  clauses: [
    {
      page: 18,
      section: '§4.2',
      heading: 'Retrospective authorization review.',
      text:
        'Where a service requiring precertification was rendered without precertification, the plan shall, upon ' +
        'appeal, review the service under the same medical necessity criteria that would have applied to a ' +
        'timely precertification request, and shall not deny the claim solely for absence of precertification ' +
        'where the service was medically necessary and precertification would have been granted.',
    },
    {
      page: 22,
      section: '§5.1',
      heading: 'Experimental and investigational services — exceptions.',
      text:
        'A service shall not be treated as experimental or investigational where it has been approved by the ' +
        'federal Food and Drug Administration for the condition being treated, or where its use for that ' +
        'condition is supported by at least two peer-reviewed published studies and is recognized in a national ' +
        'compendium referenced in the plan’s clinical policy.',
    },
    {
      page: 31,
      section: '§6.4',
      heading: 'Out-of-network services — medical necessity.',
      text:
        'Services from a non-participating provider are covered at the participating benefit level where no ' +
        'participating provider with the training and experience to treat the member’s condition is available ' +
        'within the access standards of Section 6.2, subject to medical necessity review.',
    },
  ],
};

export const PLAN_DEFS: PlanDocDef[] = [PLAN_AETNA_PPO, PLAN_BLUECREST_HMO];

export function buildAllPlanDocs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of PLAN_DEFS) out[def.doc_id] = buildPlanDoc(def);
  return out;
}
