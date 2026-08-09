/**
 * UTC calendar-date math for docket deadlines. All deadlines are calendar-day
 * based (no business-day adjustment in v1 — documented simplification; the
 * rulepack schema leaves room for it later).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(d: string): void {
  if (!ISO_DATE.test(d)) throw new Error(`not an ISO date (YYYY-MM-DD): ${d}`);
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`invalid date: ${d}`);
  // reject silently-normalized dates like 2026-02-30
  if (new Date(t).toISOString().slice(0, 10) !== d) throw new Error(`non-existent calendar date: ${d}`);
}

/** date + n days (n may be negative), date-only ISO in/out. */
export function addDays(date: string, n: number): string {
  assertIsoDate(date);
  if (!Number.isInteger(n)) throw new Error(`addDays: n must be an integer, got ${n}`);
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (to - from). Both date-only ISO. */
export function daysBetween(from: string, to: string): number {
  assertIsoDate(from);
  assertIsoDate(to);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The UTC date part of an ISO datetime. */
export function datePart(isoDateTime: string): string {
  const d = isoDateTime.slice(0, 10);
  assertIsoDate(d);
  return d;
}

/** End of a calendar day as an ISO datetime — deadlines bind until midnight UTC. */
export function endOfDayUtc(date: string): string {
  assertIsoDate(date);
  return `${date}T23:59:59Z`;
}

export function compareIso(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) throw new Error(`compareIso: invalid instant ${a} / ${b}`);
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

export function minDate(a: string, b: string): string {
  return daysBetween(a, b) >= 0 ? a : b;
}
