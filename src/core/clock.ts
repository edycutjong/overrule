/**
 * Injectable clocks. TickClock gives byte-deterministic demos: it starts at a
 * fixed instant and advances by a fixed step on every read, so ledger rows get
 * strictly monotonic, reproducible timestamps (seed --check depends on this).
 */
import type { Clock } from './types';

function isoNoMillis(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class TickClock implements Clock {
  private t: number;
  constructor(
    startIso: string,
    private readonly stepMs = 1000,
  ) {
    const t = Date.parse(startIso);
    if (Number.isNaN(t)) throw new Error(`TickClock: invalid start ${startIso}`);
    this.t = t;
  }

  now(): string {
    const current = this.t;
    this.t += this.stepMs;
    return isoNoMillis(current);
  }

  /** Peek without advancing. */
  peek(): string {
    return isoNoMillis(this.t);
  }

  advanceTo(iso: string): void {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new Error(`TickClock: invalid instant ${iso}`);
    if (t < this.t) throw new Error(`TickClock: cannot go backwards (${iso} < ${this.peek()})`);
    this.t = t;
  }

  advanceDays(days: number): void {
    this.t += days * 86_400_000;
  }

  advanceHours(hours: number): void {
    this.t += hours * 3_600_000;
  }
}

export class SystemClock implements Clock {
  now(): string {
    return isoNoMillis(Date.now());
  }
}

/** The fixed demo instant every offline artifact is anchored to (SEED_DATA). */
export const DEMO_NOW = '2026-07-14T09:00:00Z';
