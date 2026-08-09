/**
 * Policy-enforcement middleware (COMPLEXITY §3, invariant I5): the ONLY path
 * from agents to money/mail side effects. Every invocation
 *   1. validates the signed mandate (signature, expiry, case, action, spend cap),
 *   2. appends a signed ledger row (actuation or actuation_denied),
 *   3. only then calls the underlying actuator adapter,
 * and returns an ActuationProof the state machine requires for money/mail
 * transitions — so a transition without a gate-validated mandate is impossible.
 */
import { hashCanonical } from '../canonical';
import type { DecisionLedger } from '../ledger/ledger';
import type { ActuatorAction, AgentName, Clock, PolicyMandate } from '../types';
import {
  FAKE_LOB_CERTIFIED_COST_CENTS,
  type Actuators,
  type DocketSetParams,
  type DocketSetResult,
  type EscalateDoiParams,
  type EscalateDoiResult,
  type LobSendParams,
  type LobSendResult,
  type StripeRefundParams,
  type StripeRefundResult,
} from './actuators';
import { MandateError, validateMandate } from './mandate';

export interface ActuationProof {
  action: ActuatorAction;
  case_id: string;
  mandate_id: string;
  ledger_gseq: number;
  result_hash: string;
}

export class MandateGate {
  /** Cumulative spend per mandate_id (spend-cap enforcement is stateful). */
  private spent = new Map<string, number>();

  constructor(
    private readonly actuators: Actuators,
    private readonly customerPublicKeys: Record<string, string>,
    private readonly ledger: DecisionLedger,
    private readonly clock: Clock,
  ) {}

  spentUnder(mandateId: string): number {
    return this.spent.get(mandateId) ?? 0;
  }

  async stripeRefund(
    mandate: PolicyMandate,
    params: StripeRefundParams,
    agent: AgentName,
  ): Promise<{ result: StripeRefundResult; proof: ActuationProof }> {
    return this.guarded('stripe_refund', mandate, params, params.amount_usd_cents, agent, (p) =>
      this.actuators.stripe_refund(p),
    );
  }

  async lobSend(
    mandate: PolicyMandate,
    params: LobSendParams,
    agent: AgentName,
  ): Promise<{ result: LobSendResult; proof: ActuationProof }> {
    return this.guarded('lob_send', mandate, params, FAKE_LOB_CERTIFIED_COST_CENTS, agent, (p) =>
      this.actuators.lob_send(p),
    );
  }

  async docketSet(
    mandate: PolicyMandate,
    params: DocketSetParams,
    agent: AgentName,
  ): Promise<{ result: DocketSetResult; proof: ActuationProof }> {
    return this.guarded('docket_set', mandate, params, 0, agent, (p) => this.actuators.docket_set(p));
  }

  async escalateDoi(
    mandate: PolicyMandate,
    params: EscalateDoiParams,
    agent: AgentName,
  ): Promise<{ result: EscalateDoiResult; proof: ActuationProof }> {
    return this.guarded('escalate_doi', mandate, params, 0, agent, (p) => this.actuators.escalate_doi(p));
  }

  private async guarded<P extends { case_id: string }, R>(
    action: ActuatorAction,
    mandate: PolicyMandate,
    params: P,
    spendCents: number,
    agent: AgentName,
    run: (p: P) => Promise<R>,
  ): Promise<{ result: R; proof: ActuationProof }> {
    const now = this.clock.now();
    try {
      validateMandate(mandate, this.customerPublicKeys, {
        case_id: params.case_id,
        action,
        spend_usd_cents: spendCents,
        prior_spend_usd_cents: this.spentUnder(mandate.mandate_id),
        now,
      });
    } catch (err) {
      const code = err instanceof MandateError ? err.code : 'MALFORMED';
      this.ledger.append({
        case_id: params.case_id,
        agent,
        kind: 'actuation_denied',
        decision: {
          action,
          mandate_id: mandate.mandate_id ?? null,
          denial_code: code,
          detail: (err as Error).message,
        },
        inputs_hash: hashCanonical({ action, params: params as unknown as Record<string, unknown> }),
        output_hash: hashCanonical({ denied: code }),
      });
      throw err;
    }

    const result = await run(params);
    this.spent.set(mandate.mandate_id, this.spentUnder(mandate.mandate_id) + spendCents);

    const entry = this.ledger.append({
      case_id: params.case_id,
      agent,
      kind: 'actuation',
      decision: {
        action,
        mandate_id: mandate.mandate_id,
        spend_usd_cents: spendCents,
        params: params as unknown as Record<string, unknown>,
        result: result as unknown as Record<string, unknown>,
      },
      inputs_hash: hashCanonical({ action, params: params as unknown as Record<string, unknown> }),
      output_hash: hashCanonical(result),
    });

    return {
      result,
      proof: {
        action,
        case_id: params.case_id,
        mandate_id: mandate.mandate_id,
        ledger_gseq: entry.gseq,
        result_hash: hashCanonical(result),
      },
    };
  }
}
