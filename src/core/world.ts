/**
 * Composition root for the offline world: fixture keyrings (DEV keys), ledger,
 * state machine, mandate gate over in-memory fakes, TX/CA/NY rulepacks, plan
 * docs, and the DeterministicMockAdapter. Scripts and tests build everything
 * through here so the wiring itself is under test.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateFixtureSet, getCase, type FixtureSet } from '../fixtures/index';
import { CaseMachine } from './case/machine';
import { TickClock, DEMO_NOW } from './clock';
import { loadRulepacksFromDir, type Rulepack } from './docket/rulepack';
import { Keyring } from './ledger/keys';
import { DecisionLedger } from './ledger/ledger';
import { makeFakeActuators, type FakeActuatorSet } from './mandate/actuators';
import { issueMandate } from './mandate/mandate';
import { MandateGate } from './mandate/middleware';
import { DeterministicMockAdapter } from './pipeline/mockAdapter';
import type { CaseInput, World } from './pipeline/pipeline';
import { makeDocStore } from './pipeline/verifier';
import type { AgentName, PolicyMandate, PolicyMandateBody, USState } from './types';

export const AGENTS: readonly AgentName[] = [
  'redaction',
  'intake_triage',
  'evidence_extractor',
  'strategy_planner',
  'drafter',
  'citation_verifier',
  'case_ops',
  'treasury',
  'scheduler',
];

export const RULEPACK_DIR = fileURLToPath(new URL('../../fixtures/rulepacks', import.meta.url));

export const DEFAULT_PRICE_USD_CENTS = 4900; // $49 self-serve appeal (PRD)

export interface OfflineWorld extends World {
  clock: TickClock;
  actuators: FakeActuatorSet;
  agentKeys: Keyring;
  customerKeys: Keyring;
  customerPublicKeys: Record<string, string>;
  fixtures: FixtureSet;
  rulepacks: Map<USState, Rulepack>;
  makeMandate(caseId: string, overrides?: Partial<PolicyMandateBody>): PolicyMandate;
  makeInput(fixtureId: string, overrides?: Partial<CaseInput>): CaseInput;
}

export interface BuildWorldOptions {
  clock?: TickClock;
  escalationConsent?: boolean;
}

export function buildOfflineWorld(opts: BuildWorldOptions = {}): OfflineWorld {
  const clock = opts.clock ?? new TickClock(DEMO_NOW);
  const agentKeys = Keyring.fixture(AGENTS);
  const customerKeys = new Keyring('FIXTURE_DEV_KEYS');
  const ledger = new DecisionLedger(agentKeys, clock);
  const machine = new CaseMachine(ledger, clock);
  const actuators = makeFakeActuators();
  const fixtures = generateFixtureSet();
  const rulepacks = loadRulepacksFromDir(RULEPACK_DIR);
  const docs = makeDocStore(fixtures.docs);
  const adapter = new DeterministicMockAdapter(fixtures);

  const customerPublicKeys: Record<string, string> = {};
  const gate = new MandateGate(actuators, customerPublicKeys, ledger, clock);

  const ensureCustomerKey = (keyId: string): void => {
    if (!customerKeys.has(keyId)) {
      customerKeys.addFromSeed(keyId, createHash('sha256').update(`overrule-customer:${keyId}`).digest());
      customerPublicKeys[keyId] = customerKeys.get(keyId).publicKeyHex;
    }
  };

  const makeMandate = (caseId: string, overrides: Partial<PolicyMandateBody> = {}): PolicyMandate => {
    const keyId = `cust_${caseId}`;
    ensureCustomerKey(keyId);
    const issuedAt = new Date(Date.parse(clock.peek()) - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const expiresAt = new Date(Date.parse(clock.peek()) + 180 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const body: PolicyMandateBody = {
      mandate_id: `mnd_${caseId}`,
      case_id: caseId,
      customer_id: `cus_${caseId}`,
      // Cap covers the $49 fee refund (decline OR SLA credit) + certified mail costs.
      max_spend_usd_cents: DEFAULT_PRICE_USD_CENTS * 2 + 2000,
      allowed_actions: ['stripe_refund', 'lob_send', 'docket_set', 'escalate_doi'],
      refund_policy: 'full_on_decline',
      escalation_consent: opts.escalationConsent ?? true,
      issued_at: issuedAt,
      expires_at: expiresAt,
      ...overrides,
    };
    return issueMandate(customerKeys, keyId, body);
  };

  const makeInput = (fixtureId: string, overrides: Partial<CaseInput> = {}): CaseInput => {
    const f = getCase(fixtures, fixtureId);
    return {
      case_id: f.id,
      us_state: f.truth.us_state,
      raw_letter: f.raw_letter,
      plan_doc_id: f.truth.plan_doc_id,
      paid_usd_cents: DEFAULT_PRICE_USD_CENTS,
      mandate: makeMandate(f.id),
      ...overrides,
    };
  };

  return {
    adapter,
    ledger,
    machine,
    gate,
    rulepacks,
    docs,
    clock,
    actuators,
    agentKeys,
    customerKeys,
    customerPublicKeys,
    fixtures,
    makeMandate,
    makeInput,
  };
}
