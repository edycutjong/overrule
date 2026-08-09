/**
 * Versioned state rulepacks (COMPLEXITY §4 / ARCHITECTURE data model:
 * rulepacks/state_doi/{state}@{version}). Fixture packs for TX/CA/NY live in
 * fixtures/rulepacks/ and are explicitly marked `fixture: true` — values are
 * fixture-realistic, NOT verified legal data (see fixture_note in each file).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { USState } from '../types';

export interface Rulepack {
  schema: 'overrule-rulepack@1';
  state: USState;
  version: string;
  fixture: boolean;
  fixture_note?: string;
  internal_appeal: {
    level1_window_days: number;
    window_basis: 'denial_notice_date';
    payer_decision_days: number;
    expedited_decision_days: number;
  };
  external_review: {
    available_after: 'internal_l1';
    window_days: number;
    authority: string;
    request_channel: 'form' | 'portal' | 'mail';
  };
  follow_up: {
    first_check_days: number;
    recheck_days: number;
    max_silent_followups: number;
  };
  mail: { method: 'certified' | 'first_class' };
}

export class RulepackError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RulepackError';
  }
}

function fail(path: string, msg: string): never {
  throw new RulepackError(`${path}: ${msg}`);
}

function needPositiveInt(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(path, `expected positive integer, got ${JSON.stringify(v)}`);
  return v;
}

function needString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(path, `expected non-empty string, got ${JSON.stringify(v)}`);
  return v;
}

function needEnum<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(path, `expected one of ${allowed.join('|')}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

/** Validate an untrusted object into a Rulepack, or throw RulepackError. */
export function validateRulepack(raw: unknown): Rulepack {
  if (typeof raw !== 'object' || raw === null) fail('$', 'rulepack must be an object');
  const r = raw as Record<string, unknown>;
  if (r.schema !== 'overrule-rulepack@1') fail('schema', `unsupported schema ${JSON.stringify(r.schema)}`);
  const state = needEnum(r.state, ['TX', 'CA', 'NY'] as const, 'state');
  const version = needString(r.version, 'version');
  if (typeof r.fixture !== 'boolean') fail('fixture', 'must be boolean');
  if (r.fixture === true && typeof r.fixture_note !== 'string') {
    fail('fixture_note', 'fixture packs must carry a fixture_note explaining their provenance');
  }

  const ia = (r.internal_appeal ?? fail('internal_appeal', 'missing')) as Record<string, unknown>;
  const er = (r.external_review ?? fail('external_review', 'missing')) as Record<string, unknown>;
  const fu = (r.follow_up ?? fail('follow_up', 'missing')) as Record<string, unknown>;
  const mail = (r.mail ?? fail('mail', 'missing')) as Record<string, unknown>;

  return {
    schema: 'overrule-rulepack@1',
    state,
    version,
    fixture: r.fixture,
    ...(typeof r.fixture_note === 'string' ? { fixture_note: r.fixture_note } : {}),
    internal_appeal: {
      level1_window_days: needPositiveInt(ia.level1_window_days, 'internal_appeal.level1_window_days'),
      window_basis: needEnum(ia.window_basis, ['denial_notice_date'] as const, 'internal_appeal.window_basis'),
      payer_decision_days: needPositiveInt(ia.payer_decision_days, 'internal_appeal.payer_decision_days'),
      expedited_decision_days: needPositiveInt(ia.expedited_decision_days, 'internal_appeal.expedited_decision_days'),
    },
    external_review: {
      available_after: needEnum(er.available_after, ['internal_l1'] as const, 'external_review.available_after'),
      window_days: needPositiveInt(er.window_days, 'external_review.window_days'),
      authority: needString(er.authority, 'external_review.authority'),
      request_channel: needEnum(er.request_channel, ['form', 'portal', 'mail'] as const, 'external_review.request_channel'),
    },
    follow_up: {
      first_check_days: needPositiveInt(fu.first_check_days, 'follow_up.first_check_days'),
      recheck_days: needPositiveInt(fu.recheck_days, 'follow_up.recheck_days'),
      max_silent_followups: needPositiveInt(fu.max_silent_followups, 'follow_up.max_silent_followups'),
    },
    mail: { method: needEnum(mail.method, ['certified', 'first_class'] as const, 'mail.method') },
  };
}

export function rulepackRef(rp: Rulepack): string {
  return `${rp.state}@${rp.version}${rp.fixture ? '-fixture' : ''}`;
}

/** Load and validate all rulepack JSON files from a directory. */
export function loadRulepacksFromDir(dir: string): Map<USState, Rulepack> {
  const out = new Map<USState, Rulepack>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const rp = validateRulepack(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (out.has(rp.state)) throw new RulepackError(`duplicate rulepack for state ${rp.state}`);
    out.set(rp.state, rp);
  }
  return out;
}
