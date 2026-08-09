/**
 * Golden eval corpus (COMPLEXITY §5, SEED_DATA.md): 3 demo cases
 * (maria_asthma / declined_cosmetic / deadline_rescue) + 12 golden cases with
 * ground-truth JSON (codes, dates, deadlines, winning-clause locators).
 * Everything is SYNTHETIC and deterministic; dates are anchored to the fixed
 * demo instant DEMO_NOW = 2026-07-14T09:00:00Z.
 *
 * `expected_*` fields are the docket-engine answers computed BY HAND from the
 * fixture rulepacks (TX/CA/NY internal L1 = 180 days) and the letter-stated
 * windows — the eval asserts the engine reproduces them exactly (±0 days).
 *
 * golden_11 is the POISONED case: its draft citation quote alters one word of
 * the real §4.3 clause ("under age 12" → "under age 14"). The CitationVerifier
 * must catch it and the pipeline must fail closed (hallucination-catch metric).
 */
import type { USState } from '../core/types';
import { buildDenialLetter, type LetterPii } from './letters';
import { AETNA_43_TEXT, PLAN_AETNA_PPO, PLAN_BLUECREST_HMO } from './plans';

export const TRIAGE_ACCEPT_THRESHOLD = 0.3;

export interface WinningClause {
  doc_id: string;
  section: string;
  page: number;
  quote: string;
}

export interface GroundTruth {
  payer: string;
  denial_code: string;
  denial_reason: string;
  service: string;
  denial_date: string; // ISO
  stated_deadline: string | null; // ISO — as printed in the letter
  us_state: USState;
  plan_doc_id: string;
  expect_accept: boolean;
  p_win: number;
  triage_reason: string;
  winning: WinningClause | null;
  poisoned_citation: boolean;
  policy_note: string | null;
  // Docket-engine expectations as of DEMO_NOW (computed by hand):
  expected_binding_deadline: string;
  expected_basis: 'letter_stated' | 'rulepack';
  expected_days_remaining: number;
  expected_rush: boolean;
  pii: LetterPii;
}

export interface CaseFixture {
  id: string;
  kind: 'demo' | 'golden';
  format: 0 | 1 | 2 | 3;
  truth: GroundTruth;
}

const AETNA = 'Aetna Health (SYNTHETIC FIXTURE)';
const BLUECREST = 'BlueCrest Community HMO (SYNTHETIC FIXTURE)';
const A_PLAN = PLAN_AETNA_PPO.doc_id;
const B_PLAN = PLAN_BLUECREST_HMO.doc_id;

const A_43: WinningClause = { doc_id: A_PLAN, section: '§4.3', page: 87, quote: AETNA_43_TEXT };
const A_39: WinningClause = {
  doc_id: A_PLAN,
  section: '§3.9',
  page: 45,
  quote: PLAN_AETNA_PPO.clauses.find((c) => c.section === '§3.9')!.text,
};
const A_44: WinningClause = {
  doc_id: A_PLAN,
  section: '§4.4',
  page: 88,
  quote: PLAN_AETNA_PPO.clauses.find((c) => c.section === '§4.4')!.text,
};
const B_42: WinningClause = {
  doc_id: B_PLAN,
  section: '§4.2',
  page: 18,
  quote: PLAN_BLUECREST_HMO.clauses.find((c) => c.section === '§4.2')!.text,
};
const B_51: WinningClause = {
  doc_id: B_PLAN,
  section: '§5.1',
  page: 22,
  quote: PLAN_BLUECREST_HMO.clauses.find((c) => c.section === '§5.1')!.text,
};
const B_64: WinningClause = {
  doc_id: B_PLAN,
  section: '§6.4',
  page: 31,
  quote: PLAN_BLUECREST_HMO.clauses.find((c) => c.section === '§6.4')!.text,
};

/** The one deliberately-wrong quote (single-token mutation of the real §4.3). */
export const POISONED_43_QUOTE = AETNA_43_TEXT.replace('under age 12', 'under age 14');
if (POISONED_43_QUOTE === AETNA_43_TEXT) throw new Error('poisoned quote failed to mutate');
const A_43_POISONED: WinningClause = { ...A_43, quote: POISONED_43_QUOTE };

function pii(
  patient_name: string,
  member_id: string,
  dob: string,
  phoneSuffix: string,
  emailUser: string,
  ssn: string | null = null,
): LetterPii {
  return {
    patient_name,
    member_id,
    dob,
    phone: `(512) 555-${phoneSuffix}`,
    email: `${emailUser}@example.test`,
    ssn,
  };
}

export const CASE_FIXTURES: CaseFixture[] = [
  // ------------------------------------------------------------- demo cases
  {
    id: 'maria_asthma',
    kind: 'demo',
    format: 0,
    truth: {
      payer: AETNA,
      denial_code: 'CO-50',
      denial_reason: 'These are non-covered services because this is not deemed medically necessary by the payer',
      service: 'Budesonide inhalation suspension (nebulized), 90-day supply',
      denial_date: '2026-06-26',
      stated_deadline: '2026-08-25', // 60-day letter window; SEED_DATA: Aug 25, 2026 / 42 days
      us_state: 'TX',
      plan_doc_id: A_PLAN,
      expect_accept: true,
      p_win: 0.74,
      triage_reason: 'plan covers nebulized budesonide for pediatric persistent asthma (§4.3); documented step history',
      winning: A_43,
      poisoned_citation: false,
      policy_note: 'Payer clinical policy CPB-0121 rev.14 (FIXTURE) pediatric criteria are met by the enclosed history.',
      expected_binding_deadline: '2026-08-25',
      expected_basis: 'letter_stated', // rulepack 180d ⇒ 2026-12-23; letter is earlier
      expected_days_remaining: 42,
      expected_rush: false,
      pii: pii('Leo Delgado', 'W00482210', '03/14/2019', '0142', 'maria.delgado', '000-45-6789'),
    },
  },
  {
    id: 'declined_cosmetic',
    kind: 'demo',
    format: 1,
    truth: {
      payer: BLUECREST,
      denial_code: 'PR-204',
      denial_reason: 'This service is not covered under the member’s current benefit plan',
      service: 'Rhinoplasty revision (cosmetic indication)',
      denial_date: '2026-07-01',
      stated_deadline: '2026-08-30',
      us_state: 'TX',
      plan_doc_id: B_PLAN,
      expect_accept: false,
      p_win: 0.06,
      triage_reason: 'cosmetic exclusion is explicit and no reconstructive indication is documented — declining and refunding',
      winning: null,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-08-30',
      expected_basis: 'letter_stated',
      expected_days_remaining: 47,
      expected_rush: false,
      pii: pii('Rowan Ashford', 'BC-4471-0032', '11/02/1985', '0167', 'rowan.ashford'),
    },
  },
  {
    id: 'deadline_rescue',
    kind: 'demo',
    format: 2,
    truth: {
      payer: BLUECREST,
      denial_code: 'CO-197',
      denial_reason: 'Precertification/authorization absent for the service rendered',
      service: 'CT angiography, chest, with contrast',
      denial_date: '2026-05-20',
      stated_deadline: '2026-07-19', // 60-day window ⇒ 5 days from DEMO_NOW ⇒ rush
      us_state: 'NY',
      plan_doc_id: B_PLAN,
      expect_accept: true,
      p_win: 0.61,
      triage_reason: 'plan §4.2 requires retrospective medical-necessity review despite missing precertification',
      winning: B_42,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-07-19',
      expected_basis: 'letter_stated',
      expected_days_remaining: 5,
      expected_rush: true,
      pii: pii('Imani Okafor', 'BC-0091-7745', '07/30/1968', '0188', 'imani.okafor'),
    },
  },
  // ----------------------------------------------------------- golden cases
  {
    id: 'golden_01',
    kind: 'golden',
    format: 1,
    truth: {
      payer: AETNA,
      denial_code: 'CO-50',
      denial_reason: 'Not deemed medically necessary under applicable clinical criteria',
      service: 'Budesonide inhalation suspension (nebulized), 30-day supply',
      denial_date: '2026-06-10',
      stated_deadline: '2026-08-09',
      us_state: 'TX',
      plan_doc_id: A_PLAN,
      expect_accept: true,
      p_win: 0.71,
      triage_reason: 'coverage clause §4.3 squarely applies',
      winning: A_43,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-08-09',
      expected_basis: 'letter_stated',
      expected_days_remaining: 26,
      expected_rush: false,
      pii: pii('Tobias Vance', 'W00517733', '01/22/2020', '0101', 'p.vance', '000-12-4455'),
    },
  },
  {
    id: 'golden_02',
    kind: 'golden',
    format: 2,
    truth: {
      payer: AETNA,
      denial_code: 'CO-50',
      denial_reason: 'Service does not meet medical necessity criteria per clinical review',
      service: 'Continuous glucose monitor with sensors, 90-day supply',
      denial_date: '2026-07-02',
      stated_deadline: '2026-08-31',
      us_state: 'CA',
      plan_doc_id: A_PLAN,
      expect_accept: true,
      p_win: 0.68,
      triage_reason: 'documented clinical criteria met; payer applied wrong criteria set',
      winning: A_43, // same clause family used as fixture leverage for this synthetic case
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-08-31',
      expected_basis: 'letter_stated',
      expected_days_remaining: 48,
      expected_rush: false,
      pii: pii('Sun-Hee Park', 'W00822901', '05/09/2011', '0119', 'sunhee.park'),
    },
  },
  {
    id: 'golden_03',
    kind: 'golden',
    format: 3,
    truth: {
      payer: BLUECREST,
      denial_code: 'CO-197',
      denial_reason: 'Precertification was not obtained prior to the date of service',
      service: 'Outpatient knee arthroscopy with meniscal repair',
      denial_date: '2026-06-30',
      stated_deadline: '2026-08-29',
      us_state: 'NY',
      plan_doc_id: B_PLAN,
      expect_accept: true,
      p_win: 0.66,
      triage_reason: 'retrospective authorization clause §4.2 bars denial solely for absent precertification',
      winning: B_42,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-08-29',
      expected_basis: 'letter_stated',
      expected_days_remaining: 46,
      expected_rush: false,
      pii: pii('Casimir Nowak', 'BC-2210-4419', '09/17/1979', '0126', 'c.nowak'),
    },
  },
  {
    id: 'golden_04',
    kind: 'golden',
    format: 0,
    truth: {
      payer: BLUECREST,
      denial_code: 'PR-204',
      denial_reason: 'This service is not covered under the member’s current benefit plan',
      service: 'IV vitamin infusion therapy, wellness indication',
      denial_date: '2026-07-05',
      stated_deadline: '2026-09-03',
      us_state: 'TX',
      plan_doc_id: B_PLAN,
      expect_accept: false,
      p_win: 0.09,
      triage_reason: 'wellness infusion exclusion is categorical; no covered indication documented — declining and refunding',
      winning: null,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-09-03',
      expected_basis: 'letter_stated',
      expected_days_remaining: 51,
      expected_rush: false,
      pii: pii('Delphine Marchetti', 'BC-8804-1266', '02/28/1990', '0133', 'd.marchetti'),
    },
  },
  {
    id: 'golden_05',
    kind: 'golden',
    format: 1,
    truth: {
      payer: BLUECREST,
      denial_code: 'EX-20',
      denial_reason: 'Service is considered experimental or investigational for the reported condition',
      service: 'Transcranial magnetic stimulation (TMS), 30 sessions',
      denial_date: '2026-06-20',
      stated_deadline: null, // letter silent ⇒ rulepack governs (CA 180d)
      us_state: 'CA',
      plan_doc_id: B_PLAN,
      expect_accept: true,
      p_win: 0.57,
      triage_reason: 'FDA-approved for the condition ⇒ §5.1 exception to experimental exclusion applies',
      winning: B_51,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-12-17',
      expected_basis: 'rulepack',
      expected_days_remaining: 156,
      expected_rush: false,
      pii: pii('Yusuf Demir', 'BC-3319-8802', '12/05/1972', '0147', 'y.demir'),
    },
  },
  {
    id: 'golden_06',
    kind: 'golden',
    format: 2,
    truth: {
      payer: AETNA,
      denial_code: 'ST-01',
      denial_reason: 'Step therapy protocol requires trial of preferred agent before the requested drug',
      service: 'Adalimumab biosimilar, specialty pharmacy, 12-week supply',
      denial_date: '2026-07-08',
      stated_deadline: '2026-09-06',
      us_state: 'NY',
      plan_doc_id: A_PLAN,
      expect_accept: true,
      p_win: 0.63,
      triage_reason: 'prior agent documented ineffective within 180 days ⇒ §4.4 waiver applies',
      winning: A_44,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-09-06',
      expected_basis: 'letter_stated',
      expected_days_remaining: 54,
      expected_rush: false,
      pii: pii('Priya Raghavan', 'W00190288', '04/11/1988', '0152', 'p.raghavan'),
    },
  },
  {
    id: 'golden_07',
    kind: 'golden',
    format: 3,
    truth: {
      payer: AETNA,
      denial_code: 'CO-197',
      denial_reason: 'Authorization was not requested before the imaging service was performed',
      service: 'MRI lumbar spine without contrast',
      denial_date: '2026-06-15',
      stated_deadline: '2026-08-14',
      us_state: 'TX',
      plan_doc_id: A_PLAN,
      expect_accept: true,
      p_win: 0.69,
      triage_reason: 'provider failure to obtain prior auth cannot be charged to the member under §3.9',
      winning: A_39,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-08-14',
      expected_basis: 'letter_stated',
      expected_days_remaining: 31,
      expected_rush: false,
      pii: pii('Marisol Quintero', 'W00663104', '08/23/1964', '0161', 'm.quintero'),
    },
  },
  {
    id: 'golden_08',
    kind: 'golden',
    format: 0,
    truth: {
      payer: AETNA,
      denial_code: 'PR-204',
      denial_reason: 'Requested item is excluded from coverage under the member’s plan',
      service: 'Custom compression garments, athletic use',
      denial_date: '2026-07-03',
      stated_deadline: '2026-09-01',
      us_state: 'CA',
      plan_doc_id: A_PLAN,
      expect_accept: false,
      p_win: 0.12,
      triage_reason: 'athletic-use exclusion applies and no medical indication is documented — declining and refunding',
      winning: null,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-09-01',
      expected_basis: 'letter_stated',
      expected_days_remaining: 49,
      expected_rush: false,
      pii: pii('Anders Lindqvist', 'W00918820', '06/06/1996', '0174', 'a.lindqvist'),
    },
  },
  {
    id: 'golden_09',
    kind: 'golden',
    format: 1,
    truth: {
      payer: BLUECREST,
      denial_code: 'CO-50',
      denial_reason: 'Out-of-network service not deemed medically necessary at the requested level',
      service: 'Pediatric occupational therapy, 24 visits, out-of-network specialist',
      denial_date: '2026-07-10',
      stated_deadline: '2026-09-08',
      us_state: 'NY',
      plan_doc_id: B_PLAN,
      expect_accept: true,
      p_win: 0.64,
      triage_reason: 'no in-network provider within access standards ⇒ §6.4 parity clause applies',
      winning: B_64,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-09-08',
      expected_basis: 'letter_stated',
      expected_days_remaining: 56,
      expected_rush: false,
      pii: pii('Nikolai Petrov', 'BC-5527-9910', '10/19/2017', '0180', 'e.petrova'),
    },
  },
  {
    id: 'golden_10',
    kind: 'golden',
    format: 2,
    truth: {
      payer: BLUECREST,
      denial_code: 'EX-20',
      denial_reason: 'Service is considered investigational for the reported diagnosis',
      service: 'Percutaneous tibial nerve stimulation, 12 sessions',
      denial_date: '2026-07-06',
      stated_deadline: '2026-07-21', // short letter window ⇒ 7 days from DEMO_NOW ⇒ rush
      us_state: 'TX',
      plan_doc_id: B_PLAN,
      expect_accept: true,
      p_win: 0.59,
      triage_reason: 'peer-reviewed support + compendium recognition ⇒ §5.1 exception applies',
      winning: B_51,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-07-21',
      expected_basis: 'letter_stated',
      expected_days_remaining: 7,
      expected_rush: true,
      pii: pii('Halima Nasser', 'BC-6641-2205', '03/03/1958', '0195', 'h.nasser'),
    },
  },
  {
    id: 'golden_11',
    kind: 'golden',
    format: 3,
    truth: {
      payer: AETNA,
      denial_code: 'CO-50',
      denial_reason: 'Not deemed medically necessary under applicable clinical criteria',
      service: 'Budesonide inhalation suspension (nebulized), 30-day supply',
      denial_date: '2026-06-25',
      stated_deadline: '2026-08-24',
      us_state: 'CA',
      plan_doc_id: A_PLAN,
      expect_accept: true,
      p_win: 0.7,
      triage_reason: 'coverage clause §4.3 squarely applies',
      winning: A_43_POISONED, // POISONED: verifier must catch, pipeline must fail closed
      poisoned_citation: true,
      policy_note: null,
      expected_binding_deadline: '2026-08-24',
      expected_basis: 'letter_stated',
      expected_days_remaining: 41,
      expected_rush: false,
      pii: pii('Beatrix Oyelaran', 'W00274455', '07/07/2015', '0108', 'b.oyelaran'),
    },
  },
  {
    id: 'golden_12',
    kind: 'golden',
    format: 0,
    truth: {
      payer: AETNA,
      denial_code: 'ST-01',
      denial_reason: 'Preferred-agent trial required by step therapy protocol before requested therapy',
      service: 'Fremanezumab auto-injector, 3-month supply',
      denial_date: '2026-07-01',
      stated_deadline: null, // letter silent ⇒ rulepack governs (NY 180d)
      us_state: 'NY',
      plan_doc_id: A_PLAN,
      expect_accept: true,
      p_win: 0.62,
      triage_reason: 'documented harm risk from protocol agent ⇒ §4.4 waiver applies',
      winning: A_44,
      poisoned_citation: false,
      policy_note: null,
      expected_binding_deadline: '2026-12-28',
      expected_basis: 'rulepack',
      expected_days_remaining: 167,
      expected_rush: false,
      pii: pii('Wojciech Zielinski', 'W00348867', '11/11/1969', '0115', 'w.zielinski'),
    },
  },
];

export function buildLetter(f: CaseFixture): string {
  return buildDenialLetter({
    fixture_id: f.id,
    format: f.format,
    payer: f.truth.payer,
    pii: f.truth.pii,
    service: f.truth.service,
    denial_code: f.truth.denial_code,
    denial_reason: f.truth.denial_reason,
    denial_date_iso: f.truth.denial_date,
    stated_deadline_iso: f.truth.stated_deadline,
    state: f.truth.us_state,
  });
}
