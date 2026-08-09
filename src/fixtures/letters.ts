/**
 * Synthetic denial-letter generator (SEED_DATA.md: payer letter formats ×
 * reason codes). Letters deliberately contain synthetic PII (names, member
 * IDs, DOBs, phones, emails, one SSN variant) so the redaction layer is
 * exercised for real. Every letter is watermarked SYNTHETIC and carries a
 * SYNTHETIC-FIXTURE-ID line the DeterministicMockAdapter keys on.
 *
 * All identifiers are fabricated: SSNs use the invalid 000- prefix, phones use
 * the reserved 555-01XX range, emails use the reserved .test TLD.
 */

export interface LetterPii {
  patient_name: string;
  member_id: string;
  dob: string; // as printed, e.g. 03/14/1988
  phone: string;
  email: string;
  ssn: string | null; // rarely printed; exercised in two fixtures
}

export interface LetterParams {
  fixture_id: string;
  format: 0 | 1 | 2 | 3;
  payer: string;
  pii: LetterPii;
  service: string;
  denial_code: string;
  denial_reason: string;
  denial_date_iso: string; // date of the notice
  /** Explicit appeal-by date printed in the letter, or null (rulepack governs). */
  stated_deadline_iso: string | null;
  state: string;
}

const WATERMARK =
  '=== SYNTHETIC FIXTURE — generated test letter for the Overrule offline core. ' +
  'All persons, identifiers, addresses and determinations are fictitious. ===';

function human(dateIso: string): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  return `${months[m - 1]} ${d}, ${y}`;
}

function deadlineSentence(p: LetterParams): string {
  if (p.stated_deadline_iso === null) {
    return 'Appeal rights and applicable time limits are described in your Evidence of Coverage and under the law of your state.';
  }
  return `If you disagree with this determination, your written appeal must be RECEIVED no later than ${human(p.stated_deadline_iso)}.`;
}

export function buildDenialLetter(p: LetterParams): string {
  const head = [WATERMARK, `SYNTHETIC-FIXTURE-ID: ${p.fixture_id}`, ''];
  const ssnLine = p.pii.ssn ? `SSN on file: ${p.pii.ssn}` : null;

  const blocks: Record<number, string[]> = {
    0: [
      `${p.payer.toUpperCase()} — NOTICE OF ADVERSE BENEFIT DETERMINATION`,
      `Date of notice: ${human(p.denial_date_iso)}`,
      '',
      `Member: ${p.pii.patient_name}`,
      `Member ID: ${p.pii.member_id}`,
      `DOB: ${p.pii.dob}`,
      `Contact on file: ${p.pii.phone} · ${p.pii.email}`,
      ...(ssnLine ? [ssnLine] : []),
      '',
      `This letter is to inform you that the following service has been DENIED: ${p.service}.`,
      `Reason code ${p.denial_code}: ${p.denial_reason}.`,
      '',
      deadlineSentence(p),
      `This determination was made under the terms of your plan and the laws of the State of ${p.state}.`,
    ],
    1: [
      `${p.payer}`,
      'EXPLANATION OF ADVERSE DETERMINATION',
      `Notice date: ${human(p.denial_date_iso)}`,
      '',
      `RE: ${p.pii.patient_name} (Member ID: ${p.pii.member_id}, DOB: ${p.pii.dob})`,
      `Requested service: ${p.service}`,
      '',
      `After clinical review, coverage is not approved. Determination basis — ${p.denial_code} (${p.denial_reason}).`,
      `Questions? Call the number on your card or ${p.pii.phone}. Written correspondence may also be sent to ${p.pii.email}.`,
      '',
      deadlineSentence(p),
      `State of jurisdiction: ${p.state}.`,
    ],
    2: [
      `NOTICE OF DENIAL — ${p.payer}`,
      '',
      `Patient: ${p.pii.patient_name}`,
      `Member ID: ${p.pii.member_id} · DOB: ${p.pii.dob}`,
      ...(ssnLine ? [ssnLine] : []),
      `Service under review: ${p.service}`,
      `Determination date: ${human(p.denial_date_iso)}`,
      '',
      `DETERMINATION: DENIED. Code ${p.denial_code} — ${p.denial_reason}.`,
      '',
      deadlineSentence(p),
      `You or your authorized representative may submit additional clinical information with your appeal. Member phone on file: ${p.pii.phone}. Email on file: ${p.pii.email}.`,
      `Issued in the State of ${p.state}.`,
    ],
    3: [
      `${p.payer} · UTILIZATION MANAGEMENT`,
      `ADVERSE BENEFIT DETERMINATION — ${human(p.denial_date_iso)}`,
      '',
      `Member name: ${p.pii.patient_name}`,
      `Member No.: ${p.pii.member_id}`,
      `Date of Birth: ${p.pii.dob}`,
      '',
      `The service listed below does not meet the criteria for coverage and is denied.`,
      `  Service: ${p.service}`,
      `  Reason:  ${p.denial_code} — ${p.denial_reason}`,
      '',
      deadlineSentence(p),
      `For questions contact us, or the member at ${p.pii.phone} / ${p.pii.email}.`,
      `Governing state: ${p.state}.`,
    ],
  };

  return [...head, ...blocks[p.format]!, '', '— END OF SYNTHETIC FIXTURE —'].join('\n');
}

export function extractFixtureId(letterText: string): string | null {
  const m = /^SYNTHETIC-FIXTURE-ID: ([a-z0-9_]+)$/m.exec(letterText);
  return m ? m[1]! : null;
}
