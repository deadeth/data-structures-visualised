/**
 * The practice page's count-up clock, without the DOM: its saved state, the time on it, and the words shown.
 * Kept in `sessionStorage` as `dsv.practice.clock.<page id>`, so a reload keeps it and a new tab starts fresh.
 */

export interface ClockState {
  /** When the clock was last started (epoch ms), or null while it is stopped. */
  since: number | null;
  /** Time run before `since`, in ms. */
  before: number;
}

export const CLOCK_KEY = (id: string): string => `dsv.practice.clock.${id}`;

export const IDLE: ClockState = { since: null, before: 0 };

/** Time on the clock at `now`, in ms. Never negative, whatever the saved state says. */
export function elapsed(s: ClockState, now: number): number {
  return Math.max(0, s.before + (s.since === null ? 0 : Math.max(0, now - s.since)));
}

export const start = (s: ClockState, now: number): ClockState => (s.since === null ? { since: now, before: s.before } : s);
export const stop = (s: ClockState, now: number): ClockState => (s.since === null ? s : { since: null, before: elapsed(s, now) });

/** What the saved string holds, or the idle clock for anything missing or malformed. */
export function parseClock(raw: string | null | undefined): ClockState {
  if (!raw) return IDLE;
  try {
    const v = JSON.parse(raw) as Partial<ClockState>;
    const before = typeof v.before === 'number' && Number.isFinite(v.before) && v.before >= 0 ? v.before : 0;
    const since = typeof v.since === 'number' && Number.isFinite(v.since) ? v.since : null;
    return { since, before };
  } catch {
    return IDLE;
  }
}

/** Minutes and seconds, "12:40". Past an hour the minutes run on ("72:05"), to match "of 40:00". */
export function mmss(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The clock's line: "12:40 of 40:00". */
export const clockText = (ms: number, minutes: number): string => `${mmss(ms)} of ${mmss(minutes * 60_000)}`;

/** How far past the target, or null while within it. Exactly at the target is not over. */
export function overBy(ms: number, minutes: number): string | null {
  const over = Math.floor(ms / 1000) - minutes * 60;
  return over > 0 ? mmss(over * 1000) : null;
}

/** Words for a screen reader, in full: "12 minutes 40 seconds of 40 minutes". */
export function spoken(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return m && s ? `${part(m, 'minute')} ${part(s, 'second')}` : m ? part(m, 'minute') : part(s, 'second');
}
