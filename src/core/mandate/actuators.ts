/**
 * Actuator adapter interfaces + deterministic in-memory fakes.
 * Real adapters (Stripe live, Lob live) are Week-3 production work
 * (BUILD_PLAN) — NOT implemented in this offline core; the interfaces are the
 * contract they will satisfy. Fakes are deterministic (counter-based IDs) so
 * demos and tests are byte-reproducible.
 */
import type { DocketItem, DocketPlan, USState } from '../types';

// ---------------------------------------------------------------------------
// Adapter contracts
// ---------------------------------------------------------------------------
export interface StripeRefundParams {
  case_id: string;
  amount_usd_cents: number;
  reason: 'triage_decline' | 'sla_credit';
}
export interface StripeRefundResult {
  refund_id: string;
  amount_usd_cents: number;
}

export interface LobSendParams {
  case_id: string;
  /** sha256 of the VERIFIED draft artifact — content itself stays in the vault. */
  artifact_hash: string;
  mail_class: 'certified' | 'first_class';
  destination_state: USState;
}
export interface LobSendResult {
  tracking_number: string;
  mail_class: string;
}

export interface DocketSetParams {
  case_id: string;
  plan: DocketPlan;
}
export interface DocketSetResult {
  items: DocketItem[];
}

export interface EscalateDoiParams {
  case_id: string;
  state: USState;
  reason: string;
}
export interface EscalateDoiResult {
  reference: string;
}

export interface Actuators {
  stripe_refund(p: StripeRefundParams): Promise<StripeRefundResult>;
  lob_send(p: LobSendParams): Promise<LobSendResult>;
  docket_set(p: DocketSetParams): Promise<DocketSetResult>;
  escalate_doi(p: EscalateDoiParams): Promise<EscalateDoiResult>;
}

/** Fixture cost of a certified letter through the fake Lob (cents). */
export const FAKE_LOB_CERTIFIED_COST_CENTS = 899;

// ---------------------------------------------------------------------------
// Deterministic in-memory fakes
// ---------------------------------------------------------------------------
export class FakeStripe {
  refunds: (StripeRefundParams & StripeRefundResult)[] = [];
  private n = 0;
  async refund(p: StripeRefundParams): Promise<StripeRefundResult> {
    if (!Number.isInteger(p.amount_usd_cents) || p.amount_usd_cents <= 0) {
      throw new Error(`FakeStripe: invalid refund amount ${p.amount_usd_cents}`);
    }
    const result = { refund_id: `re_fake_${String(++this.n).padStart(4, '0')}`, amount_usd_cents: p.amount_usd_cents };
    this.refunds.push({ ...p, ...result });
    return result;
  }
}

export class FakeLob {
  sends: (LobSendParams & LobSendResult)[] = [];
  private n = 0;
  async send(p: LobSendParams): Promise<LobSendResult> {
    if (!/^[0-9a-f]{64}$/.test(p.artifact_hash)) {
      throw new Error('FakeLob: artifact_hash must be sha256 hex (mail only VERIFIED artifacts)');
    }
    const result = {
      tracking_number: `94001111FAKE${String(++this.n).padStart(8, '0')}`,
      mail_class: p.mail_class,
    };
    this.sends.push({ ...p, ...result });
    return result;
  }
}

export class FakeDocketRegistry {
  items: DocketItem[] = [];
  private n = 0;
  async set(p: DocketSetParams): Promise<DocketSetResult> {
    const items = p.plan.items.map((it) => ({
      ...it,
      id: `dkt_${String(++this.n).padStart(4, '0')}`,
      case_id: p.case_id,
      acted_at: null,
      action: null,
    }));
    this.items.push(...items);
    return { items };
  }
}

export class FakeDoi {
  escalations: (EscalateDoiParams & EscalateDoiResult)[] = [];
  private n = 0;
  async escalate(p: EscalateDoiParams): Promise<EscalateDoiResult> {
    const result = { reference: `doi_${p.state.toLowerCase()}_${String(++this.n).padStart(4, '0')}` };
    this.escalations.push({ ...p, ...result });
    return result;
  }
}

export interface FakeActuatorSet extends Actuators {
  fakes: { stripe: FakeStripe; lob: FakeLob; docket: FakeDocketRegistry; doi: FakeDoi };
}

export function makeFakeActuators(): FakeActuatorSet {
  const stripe = new FakeStripe();
  const lob = new FakeLob();
  const docket = new FakeDocketRegistry();
  const doi = new FakeDoi();
  return {
    fakes: { stripe, lob, docket, doi },
    stripe_refund: (p) => stripe.refund(p),
    lob_send: (p) => lob.send(p),
    docket_set: (p) => docket.set(p),
    escalate_doi: (p) => doi.escalate(p),
  };
}
