import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/canonical';
import { TickClock } from '../src/core/clock';
import { Keyring } from '../src/core/ledger/keys';
import { DecisionLedger } from '../src/core/ledger/ledger';
import { makeFakeActuators, FAKE_LOB_CERTIFIED_COST_CENTS } from '../src/core/mandate/actuators';
import { MandateError, issueMandate, validateMandate } from '../src/core/mandate/mandate';
import { MandateGate } from '../src/core/mandate/middleware';
import type { PolicyMandate, PolicyMandateBody } from '../src/core/types';

const NOW = '2026-07-14T09:00:00Z';

function setup(bodyOverrides: Partial<PolicyMandateBody> = {}) {
  const customerKeys = Keyring.fixture(['cust_1']);
  const body: PolicyMandateBody = {
    mandate_id: 'mnd_1',
    case_id: 'case_1',
    customer_id: 'cus_1',
    max_spend_usd_cents: 11800,
    allowed_actions: ['stripe_refund', 'lob_send', 'docket_set', 'escalate_doi'],
    refund_policy: 'full_on_decline',
    escalation_consent: true,
    issued_at: '2026-07-14T08:00:00Z',
    expires_at: '2027-01-10T08:00:00Z',
    ...bodyOverrides,
  };
  const mandate = issueMandate(customerKeys, 'cust_1', body);
  const publicKeys = { cust_1: customerKeys.get('cust_1').publicKeyHex };
  return { mandate, publicKeys };
}

function ctx(overrides: Partial<Parameters<typeof validateMandate>[2]> = {}) {
  return {
    case_id: 'case_1',
    action: 'stripe_refund' as const,
    spend_usd_cents: 4900,
    prior_spend_usd_cents: 0,
    now: NOW,
    ...overrides,
  };
}

describe('validateMandate', () => {
  it('accepts a valid signed mandate', () => {
    const { mandate, publicKeys } = setup();
    expect(() => validateMandate(mandate, publicKeys, ctx())).not.toThrow();
  });

  it('rejects a tampered body (BAD_SIGNATURE)', () => {
    const { mandate, publicKeys } = setup();
    const forged: PolicyMandate = { ...mandate, max_spend_usd_cents: 99_999_900 };
    expect(() => validateMandate(forged, publicKeys, ctx())).toThrow(/BAD_SIGNATURE/);
  });

  it('rejects unknown customer keys (UNKNOWN_KEY)', () => {
    const { mandate } = setup();
    expect(() => validateMandate(mandate, {}, ctx())).toThrow(/UNKNOWN_KEY/);
  });

  it('rejects expired and not-yet-valid mandates', () => {
    const { mandate, publicKeys } = setup();
    expect(() => validateMandate(mandate, publicKeys, ctx({ now: '2028-01-01T00:00:00Z' }))).toThrow(/EXPIRED/);
    expect(() => validateMandate(mandate, publicKeys, ctx({ now: '2026-07-14T07:00:00Z' }))).toThrow(/NOT_YET_VALID/);
  });

  it('rejects cross-case use (WRONG_CASE)', () => {
    const { mandate, publicKeys } = setup();
    expect(() => validateMandate(mandate, publicKeys, ctx({ case_id: 'case_2' }))).toThrow(/WRONG_CASE/);
  });

  it('rejects actions outside allowed_actions', () => {
    const { mandate, publicKeys } = setup({ allowed_actions: ['docket_set'] });
    expect(() => validateMandate(mandate, publicKeys, ctx())).toThrow(/ACTION_NOT_ALLOWED/);
  });

  it('rejects escalation without consent (NO_ESCALATION_CONSENT)', () => {
    const { mandate, publicKeys } = setup({ escalation_consent: false });
    expect(() =>
      validateMandate(mandate, publicKeys, ctx({ action: 'escalate_doi', spend_usd_cents: 0 })),
    ).toThrow(/NO_ESCALATION_CONSENT/);
  });

  it('enforces the cumulative spend cap (SPEND_CAP_EXCEEDED)', () => {
    const { mandate, publicKeys } = setup({ max_spend_usd_cents: 5000 });
    expect(() => validateMandate(mandate, publicKeys, ctx({ prior_spend_usd_cents: 200 }))).toThrow(
      /SPEND_CAP_EXCEEDED/,
    );
    expect(() => validateMandate(mandate, publicKeys, ctx({ prior_spend_usd_cents: 100 }))).not.toThrow();
  });

  it('rejects malformed spends and malformed mandates', () => {
    const { mandate, publicKeys } = setup();
    expect(() => validateMandate(mandate, publicKeys, ctx({ spend_usd_cents: -1 }))).toThrow(/MALFORMED/);
    const broken = { ...mandate, allowed_actions: 'all' } as unknown as PolicyMandate;
    expect(() => validateMandate(broken, publicKeys, ctx())).toThrow(/MALFORMED/);
  });
});

describe('MandateGate — the only path to side effects (I5)', () => {
  function gateSetup(bodyOverrides: Partial<PolicyMandateBody> = {}) {
    const { mandate, publicKeys } = setup(bodyOverrides);
    const agentKeys = Keyring.fixture(['treasury', 'case_ops', 'scheduler']);
    const ledger = new DecisionLedger(agentKeys, new TickClock(NOW));
    const actuators = makeFakeActuators();
    const gate = new MandateGate(actuators, publicKeys, ledger, new TickClock(NOW));
    return { mandate, gate, ledger, actuators };
  }

  it('valid refund: executes, ledgers an actuation row, returns a bound proof', async () => {
    const { mandate, gate, ledger, actuators } = gateSetup();
    const { result, proof } = await gate.stripeRefund(
      mandate,
      { case_id: 'case_1', amount_usd_cents: 4900, reason: 'triage_decline' },
      'treasury',
    );
    expect(result.refund_id).toBe('re_fake_0001');
    expect(actuators.fakes.stripe.refunds).toHaveLength(1);
    expect(proof).toMatchObject({ action: 'stripe_refund', case_id: 'case_1', mandate_id: 'mnd_1' });
    const row = ledger.all()[proof.ledger_gseq]!;
    expect(row.kind).toBe('actuation');
    expect(row.agent).toBe('treasury');
    expect(row.decision.action).toBe('stripe_refund');
    expect(gate.spentUnder('mnd_1')).toBe(4900);
  });

  it('denied refund: ledgers actuation_denied, throws, does NOT touch the actuator', async () => {
    const { mandate, gate, ledger, actuators } = gateSetup({ allowed_actions: ['docket_set'] });
    await expect(
      gate.stripeRefund(mandate, { case_id: 'case_1', amount_usd_cents: 4900, reason: 'triage_decline' }, 'treasury'),
    ).rejects.toThrow(MandateError);
    expect(actuators.fakes.stripe.refunds).toHaveLength(0);
    const denials = ledger.all().filter((e) => e.kind === 'actuation_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]!.decision.denial_code).toBe('ACTION_NOT_ALLOWED');
    expect(gate.spentUnder('mnd_1')).toBe(0);
  });

  it('spend cap is enforced cumulatively across calls', async () => {
    const { mandate, gate } = gateSetup({ max_spend_usd_cents: 9000 });
    await gate.stripeRefund(mandate, { case_id: 'case_1', amount_usd_cents: 4900, reason: 'triage_decline' }, 'treasury');
    await expect(
      gate.stripeRefund(mandate, { case_id: 'case_1', amount_usd_cents: 4900, reason: 'sla_credit' }, 'treasury'),
    ).rejects.toThrow(/SPEND_CAP_EXCEEDED/);
  });

  it('lob_send counts the fixture certified-mail cost against the cap', async () => {
    const { mandate, gate } = gateSetup();
    const artifact = sha256Hex('verified draft');
    await gate.lobSend(
      mandate,
      { case_id: 'case_1', artifact_hash: artifact, mail_class: 'certified', destination_state: 'TX' },
      'case_ops',
    );
    expect(gate.spentUnder('mnd_1')).toBe(FAKE_LOB_CERTIFIED_COST_CENTS);
  });

  it('escalate_doi respects consent through the gate', async () => {
    const noConsent = gateSetup({ escalation_consent: false });
    await expect(
      noConsent.gate.escalateDoi(noConsent.mandate, { case_id: 'case_1', state: 'TX', reason: 'payer_silent' }, 'case_ops'),
    ).rejects.toThrow(/NO_ESCALATION_CONSENT/);

    const consent = gateSetup();
    const { result } = await consent.gate.escalateDoi(
      consent.mandate,
      { case_id: 'case_1', state: 'TX', reason: 'payer_silent' },
      'case_ops',
    );
    expect(result.reference).toBe('doi_tx_0001');
  });

  it('fakes are deterministic and validate their inputs', async () => {
    const actuators = makeFakeActuators();
    const a = await actuators.lob_send({
      case_id: 'c',
      artifact_hash: sha256Hex('x'),
      mail_class: 'certified',
      destination_state: 'NY',
    });
    expect(a.tracking_number).toBe('94001111FAKE00000001');
    await expect(
      actuators.lob_send({ case_id: 'c', artifact_hash: 'not-a-hash', mail_class: 'certified', destination_state: 'NY' }),
    ).rejects.toThrow(/sha256/);
    await expect(actuators.stripe_refund({ case_id: 'c', amount_usd_cents: 0, reason: 'sla_credit' })).rejects.toThrow(
      /invalid refund amount/,
    );
    const d = await actuators.docket_set({
      case_id: 'c',
      plan: {
        case_id: 'c',
        state: 'TX',
        rulepack_ref: 'TX@2026-07-fixture',
        rush: false,
        filing_deadline: '2026-08-25',
        filing_deadline_basis: 'letter_stated',
        items: [
          { kind: 'followup_check', due_at: '2026-08-04T23:59:59Z', created_at: '2026-07-14T09:00:00Z', rush: false },
        ],
      },
    });
    expect(d.items[0]!.id).toBe('dkt_0001');
    expect(d.items[0]!.acted_at).toBeNull();
  });
});
