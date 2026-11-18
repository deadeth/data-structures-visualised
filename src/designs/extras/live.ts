/**
 * Live numbers on a cheat sheet: strings in a crib may name `{id}` placeholders, each either a number the reader can
 * type over (an input) or a figure that follows from those (a derived value). This module has no DOM: it parses what
 * the reader types, formats numbers for reading aloud, and fills placeholders in a string.
 */
import type { Crib } from './types';

/** Words that multiply a number, as typed: "5bn", "500 million", "250k". */
const SCALES: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

/**
 * A number as someone might type it: "1,000,000", "1e9", "5bn", "5 billion", "250k", "2.5 billion". Case, spaces
 * and thousands commas don't matter. Anything else gives NaN.
 */
export function parseNumber(text: string): number {
  const t = text.toLowerCase().replace(/[\s, _]/g, '');
  const m = /^(\d+(?:\.\d*)?|\.\d+)(e[+-]?\d+)?([a-z]*)$/.exec(t);
  if (!m) return NaN;
  const scale = m[3] ? SCALES[m[3]] : 1;
  if (scale === undefined) return NaN;
  const n = Number(m[1] + (m[2] ?? '')) * scale;
  return Number.isFinite(n) ? n : NaN;
}

/** x rounded to `sf` significant figures. */
export function roundSig(x: number, sf: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const p = Math.pow(10, sf - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * p) / p;
}

/** A number with thousands commas and no trailing zeros: 86400 gives "86,400", 2.50 gives "2.5". */
export function commas(x: number): string {
  const neg = x < 0;
  const [int, frac] = String(Math.abs(Number(x.toPrecision(12)))).split('.');
  const body = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
  return (neg ? '-' : '') + body;
}

/** A number trimmed to at most `sf` significant figures, with commas: 2.5, 10, 0.25. */
export function trim(x: number, sf = 3): string {
  return commas(roundSig(x, sf));
}

/**
 * A rate or count as it would be said: to 1 significant figure if that is within 5 per cent, otherwise to 2.
 * 385.8 gives "400", 1,929 gives "2,000".
 */
export function saidValue(x: number): number {
  const one = roundSig(x, 1);
  return Math.abs(one - x) <= 0.05 * Math.abs(x) ? one : roundSig(x, 2);
}
export function said(x: number): string {
  return commas(saidValue(x));
}

const BIG: [number, string][] = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
];

/**
 * A count in words from a million up, at most `sf` significant figures: "1 billion", "2.5 billion", "500 million".
 * Below a million, digits with commas: "250,000".
 */
export function words(x: number, sf = 3): string {
  const r = roundSig(x, sf);
  for (const [n, w] of BIG) if (Math.abs(r) >= n) return `${commas(r / n)} ${w}`;
  return Math.abs(r) >= 1000 ? commas(Math.round(x)) : trim(x, sf);
}

const SIZES = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
/** A size in bytes, 1 KB = 1,000 bytes, to at most 3 significant figures: "100 TB", "1 PB", "400 GB". */
export function size(bytes: number): string {
  let v = roundSig(bytes, 3);
  let i = 0;
  while (Math.abs(v) >= 1000 && i < SIZES.length - 1) {
    v /= 1000;
    i++;
  }
  return `${trim(v, 3)} ${SIZES[i]}`;
}

/** A bit rate given in Mbit/s: "320 Mbit/s", from 1,000 up "3.2 Gbit/s". */
export function bitRate(mbit: number): string {
  const r = roundSig(mbit, 3);
  return r >= 1000 ? `${trim(r / 1000, 3)} Gbit/s` : `${trim(r, 3)} Mbit/s`;
}

const plural = (n: number, one: string) => `${commas(n)} ${one}${n === 1 ? '' : 's'}`;
/**
 * A length of time given in seconds: from 48 hours up, days (one decimal place under 100, whole above); under 48
 * hours, whole hours; under 2 hours, whole minutes; under 2 minutes, whole seconds.
 */
export function duration(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 48) {
    const days = seconds / 86400;
    return days < 100 ? `${commas(Math.round(days * 10) / 10)} days` : `${commas(Math.round(days))} days`;
  }
  if (hours >= 2) return plural(Math.round(hours), 'hour');
  if (seconds >= 120) return plural(Math.round(seconds / 60), 'minute');
  return plural(Math.round(seconds), 'second');
}

/** A piece of a crib string: plain text, or the id of a placeholder. */
export type Token = { text: string } | { id: string };

/** A string split into plain text and placeholders: "at {rate} a second" gives text, id "rate", text. */
export function tokens(text: string): Token[] {
  const out: Token[] = [];
  text.split(/\{(\w+)\}/).forEach((p, i) => {
    if (i % 2) out.push({ id: p });
    else if (p) out.push({ text: p });
  });
  return out;
}

/** The page's own values of a crib's inputs. */
export function defaults(crib: Crib): Record<string, number> {
  return Object.fromEntries((crib.live?.inputs ?? []).map((x) => [x.id, x.value]));
}

/** How an input's value is shown, in its field and in resolved text: in words from a million up. */
export const shown = (n: number): string => words(n);

/**
 * Every placeholder's text for these values (the defaults when none are given): inputs as `shown`, derived values
 * as the crib's `derive` gives them.
 */
export function texts(crib: Crib, values?: Record<string, number>): Record<string, string> {
  if (!crib.live) return {};
  const v = { ...defaults(crib), ...(values ?? {}) };
  const ins = Object.fromEntries(crib.live.inputs.map((x) => [x.id, shown(v[x.id])]));
  return { ...crib.live.derive(v), ...ins };
}

/** A crib string with its placeholders filled, from these values or the defaults. An unknown id is left as written. */
export function resolve(crib: Crib, text: string, values?: Record<string, number>): string {
  if (!text.includes('{')) return text;
  const t = texts(crib, values);
  return text.replace(/\{(\w+)\}/g, (all, id: string) => t[id] ?? all);
}
