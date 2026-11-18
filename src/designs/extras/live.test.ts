import { describe, expect, it } from 'vitest';
import { bitRate, duration, parseNumber, resolve, said, size, tokens, words } from './live';
import { extras } from './web-crawler';

const crib = extras.crib!;
const live = crib.live!;
const defaults = Object.fromEntries(live.inputs.map((x) => [x.id, x.value]));
const derive = (over: Record<string, number> = {}) => live.derive({ ...defaults, ...over });

describe('parseNumber', () => {
  const cases: [string, number][] = [
    ['1,000,000', 1e6],
    ['1000000', 1e6],
    ['1e9', 1e9],
    ['5bn', 5e9],
    ['5b', 5e9],
    ['5 billion', 5e9],
    ['5 Billion', 5e9],
    ['500m', 5e8],
    ['500 million', 5e8],
    ['250k', 250_000],
    ['250 thousand', 250_000],
    ['2.5 billion', 2.5e9],
    ['1 million', 1e6],
    [' 3 M ', 3e6],
    ['0.5', 0.5],
    ['100', 100],
  ];
  for (const [t, n] of cases) it(`reads "${t}"`, () => expect(parseNumber(t)).toBeCloseTo(n, 6));
  for (const t of ['', 'abc', '5 zillion', '1..2', '-5', '5 billion pages', 'e9', '1,000x']) it(`rejects "${t}"`, () => expect(parseNumber(t)).toBeNaN());
});

describe('formatters', () => {
  it('said', () => {
    expect(said(385.8)).toBe('400');
    expect(said(1929)).toBe('2,000');
    expect(said(1000)).toBe('1,000');
    expect(said(20_000)).toBe('20,000');
    expect(said(330)).toBe('330');
    expect(said(0.3858)).toBe('0.4');
  });
  it('words', () => {
    expect(words(1e9)).toBe('1 billion');
    expect(words(5e8)).toBe('500 million');
    expect(words(2.5e9)).toBe('2.5 billion');
    expect(words(250_000)).toBe('250,000');
    expect(words(1e6)).toBe('1 million');
    expect(words(1.2345e9)).toBe('1.23 billion');
    expect(words(129_600_000, 2)).toBe('130 million');
    expect(words(50)).toBe('50');
    expect(words(0.5)).toBe('0.5');
  });
  it('size', () => {
    expect(size(1e14)).toBe('100 TB');
    expect(size(1e15)).toBe('1 PB');
    expect(size(8e10)).toBe('80 GB');
    expect(size(4e11)).toBe('400 GB');
    expect(size(1.5e5)).toBe('150 KB');
  });
  it('bit rate', () => {
    expect(bitRate(320)).toBe('320 Mbit/s');
    expect(bitRate(3200)).toBe('3.2 Gbit/s');
  });
  it('duration', () => {
    expect(duration(1e6)).toBe('11.6 days');
    expect(duration(1e5)).toBe('28 hours');
    expect(duration(1.5e6)).toBe('17.4 days');
    expect(duration(150_000)).toBe('42 hours');
    expect(duration(1e7)).toBe('116 days');
    expect(duration(3600)).toBe('60 minutes');
    expect(duration(30)).toBe('30 seconds');
  });
  it('tokens', () => {
    expect(tokens('at {rate} a second')).toEqual([{ text: 'at ' }, { id: 'rate' }, { text: ' a second' }]);
    expect(tokens('{a}{b}')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

describe('the web crawler sheet', () => {
  it('gives the page’s own figures with the defaults', () => {
    expect(derive()).toMatchObject({
      rate: '400',
      pagesSaid: '1 billion',
      build: '1,000',
      machines: '20',
      perSiteDay: '86,400',
      requests: 'request',
      monthBytes: '100 TB',
      mbit: '320 Mbit/s',
      seenChecks: '20,000',
      known: '10 billion',
      fingerprints: '80 GB',
      slotsEach: '51',
      smallSaid: '1 million',
      smallTime: '11.6 days',
      fastRate: '10',
      fastTime: '28 hours',
      smallBytes: '100 GB',
      perMachineMonth: '130 million',
    });
  });

  it('recalculates for 5 billion pages of 200 KB', () => {
    expect(derive({ pages: 5e9, pageKB: 200 })).toMatchObject({
      rate: '2,000',
      build: '5,000',
      machines: '100',
      monthBytes: '1 PB',
      mbit: '3.2 Gbit/s',
      seenChecks: '100,000',
      known: '50 billion',
      fingerprints: '400 GB',
      slotsEach: '10',
    });
  });

  it('recalculates for one site of 3 million pages at 2 a second', () => {
    expect(derive({ smallPages: 3e6, siteRate: 2 })).toMatchObject({ smallTime: '17.4 days', fastRate: '20', fastTime: '42 hours', perSiteDay: '172,800', requests: 'requests' });
  });

  const all = [crib.idea, ...(crib.late ? [crib.late] : []), ...crib.hour.flatMap((s) => [s.title, ...s.lines]), ...crib.numbers.flatMap((n) => [n.figure, n.what]), ...crib.remember, ...crib.asked.flatMap((g) => [g.about, ...g.items.flatMap((x) => [x.q, x.a])])];

  it('names only inputs and derived values', () => {
    const known = new Set([...live.inputs.map((x) => x.id), ...Object.keys(derive())]);
    const used = all.flatMap((t) => tokens(t).flatMap((k) => ('id' in k ? [k.id] : [])));
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) expect(known.has(id), id).toBe(true);
  });

  it('leaves no brace in any resolved string', () => {
    for (const t of all) {
      expect(resolve(crib, t), t).not.toMatch(/[{}]/);
      expect(resolve(crib, t, { ...defaults, pages: 5e9 }), t).not.toMatch(/[{}]/);
    }
  });

  it('reads as before with the defaults', () => {
    expect(resolve(crib, crib.numbers[3].what)).toBe('A page. 1 billion a month is 100 TB, about 320 Mbit/s.');
    expect(resolve(crib, crib.numbers[0].what)).toBe('1 billion pages a month. Build for 1,000 a second.');
    expect(resolve(crib, crib.hour[1].lines[0])).toBe('1 million pages at 1 a second takes 11.6 days. At 10 a second, if the site allows, about 28 hours.');
  });
});
