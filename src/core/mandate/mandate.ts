/**
 * Signed policy mandates — bounded money authority (COMPLEXITY §3, invariant I5).
 * The customer signs a policy JSON at checkout: max spend, allowed actions,
 * refund policy, escalation consent, validity window. Agents can move money or
 * mail ONLY through the mandate gate (middleware.ts), which validates against
 * this signature. Machine-enforced delegation, every decision ledgered.
 */
import { canonicalJson, sha256Hex } from '../canonical';
import type { Keyring } from '../ledger/keys';
import { verifyWithPublicKeyHex } from '../ledger/keys';
import type { ActuatorAction, PolicyMandate, PolicyMandateBody } from '../types';

export type MandateDenialCode =
  | 'BAD_SIGNATURE'
  | 'UNKNOWN_KEY'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'WRONG_CASE'
  | 'ACTION_NOT_ALLOWED'
  | 'SPEND_CAP_EXCEEDED'
  | 'NO_ESCALATION_CONSENT'
  | 'MALFORMED';

export class MandateError extends Error {
  constructor(
    public readonly code: MandateDenialCode,
    detail: string,
  ) {
    super(`mandate denied [${code}]: ${detail}`);
    this.name = 'MandateError';
  }
}

export function mandateBodyOf(m: PolicyMandate): PolicyMandateBody {
  return {
    mandate_id: m.mandate_id,
    case_id: m.case_id,
    customer_id: m.customer_id,
    max_spend_usd_cents: m.max_spend_usd_cents,
    allowed_actions: m.allowed_actions,
    refund_policy: m.refund_policy,
    escalation_consent: m.escalation_consent,
    issued_at: m.issued_at,
    expires_at: m.expires_at,
  };
}

/** What the customer key signs: sha256(canonical_json(body)) as raw bytes. */
export function mandateDigest(body: PolicyMandateBody): Buffer {
  return Buffer.from(sha256Hex(canonicalJson(body)), 'hex');
}

/** Issue (sign) a mandate with the customer's key — checkout does this. */
export function issueMandate(customerKeys: Keyring, keyId: string, body: PolicyMandateBody): PolicyMandate {
  return { ...body, sig: customerKeys.sign(keyId, mandateDigest(body)), key_id: keyId };
}

export interface MandateContext {
  case_id: string;
  action: ActuatorAction;
  spend_usd_cents: number;
  /** Total already spent under this mandate (gate tracks it). */
  prior_spend_usd_cents: number;
  now: string; // ISO
}

/**
 * Validate a mandate against a requested actuation. Throws MandateError with a
 * machine-readable code; returns void on success.
 * `customerPublicKeys`: key_id → SPKI DER hex (trusted registry).
 */
export function validateMandate(
  mandate: PolicyMandate,
  customerPublicKeys: Record<string, string>,
  ctx: MandateContext,
): void {
  if (
    typeof mandate.mandate_id !== 'string' ||
    typeof mandate.sig !== 'string' ||
    typeof mandate.key_id !== 'string' ||
    !Array.isArray(mandate.allowed_actions) ||
    !Number.isInteger(mandate.max_spend_usd_cents) ||
    mandate.max_spend_usd_cents < 0
  ) {
    throw new MandateError('MALFORMED', 'mandate is missing required fields');
  }
  const pub = customerPublicKeys[mandate.key_id];
  if (!pub) throw new MandateError('UNKNOWN_KEY', `no registered key ${mandate.key_id}`);
  if (!verifyWithPublicKeyHex(pub, mandateDigest(mandateBodyOf(mandate)), mandate.sig)) {
    throw new MandateError('BAD_SIGNATURE', 'signature does not match mandate body');
  }
  const now = Date.parse(ctx.now);
  if (Number.isNaN(now)) throw new MandateError('MALFORMED', `invalid now: ${ctx.now}`);
  if (now < Date.parse(mandate.issued_at)) throw new MandateError('NOT_YET_VALID', `mandate valid from ${mandate.issued_at}`);
  if (now > Date.parse(mandate.expires_at)) throw new MandateError('EXPIRED', `mandate expired ${mandate.expires_at}`);
  if (mandate.case_id !== ctx.case_id) {
    throw new MandateError('WRONG_CASE', `mandate is for case ${mandate.case_id}, not ${ctx.case_id}`);
  }
  if (!mandate.allowed_actions.includes(ctx.action)) {
    throw new MandateError('ACTION_NOT_ALLOWED', `${ctx.action} not in allowed_actions`);
  }
  if (ctx.action === 'escalate_doi' && !mandate.escalation_consent) {
    throw new MandateError('NO_ESCALATION_CONSENT', 'customer did not consent to DOI escalation');
  }
  if (ctx.spend_usd_cents < 0 || !Number.isInteger(ctx.spend_usd_cents)) {
    throw new MandateError('MALFORMED', `invalid spend amount ${ctx.spend_usd_cents}`);
  }
  if (ctx.prior_spend_usd_cents + ctx.spend_usd_cents > mandate.max_spend_usd_cents) {
    throw new MandateError(
      'SPEND_CAP_EXCEEDED',
      `spend ${ctx.prior_spend_usd_cents}+${ctx.spend_usd_cents} exceeds cap ${mandate.max_spend_usd_cents}`,
    );
  }
}
