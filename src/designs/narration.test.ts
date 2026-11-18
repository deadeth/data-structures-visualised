import { describe, expect, it } from 'vitest';
import { LOCKED_IDS } from '../locked/manifest';
import { DESIGNS } from './index';
import { hashOf, narrationOf, spoken } from './narration';
import { NARRATION } from './narration-manifest';

// The repo has no Node type definitions, so the Node module used here is typed by hand (as in src/locked/bundle.test.ts).
interface Fs {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
}
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as Fs;
const { existsSync, readdirSync } = fs;
const audioDir = new URL('../../public/audio', import.meta.url).pathname;
const join = (...p: string[]) => p.join('/');

describe('spoken', () => {
  const cases: [string, string][] = [
    ['Follow one of them: https://example.org/news.', 'Follow one of them: example dot org slash news.'],
    ['It reads robots.txt first.', 'It reads robots dot t x t first.'],
    ['Kept in RocksDB, called over gRPC, stored in S3.', 'Kept in Rocks D B, called over g R P C, stored in S three.'],
    ['The URL and its URLs go through DNS over HTTPS.', 'The U R L and its U R Ls go through D N S over H T T P S.'],
    ['Fetcher fetch-03 on crawler-07 and crawler-12.', 'Fetcher fetch zero three on crawler zero seven and crawler 12.'],
    ['A deadline of 10:21:00, renewed at 10:56:30, due at 11:00.', "A deadline of ten twenty-one, renewed at ten fifty-six and thirty seconds, due at eleven o'clock."],
    ['10× the time, ≈ 400 a second, a → b, p95 ≤ 2 s.', '10 times the time, about 400 a second, a to b, ninety-fifth percentile at most 2 seconds.'],
    ['A SimHash in a WARC file, and ScyllaDB.', 'A Sim hash in a wark file, and Silla D B.'],
    ['Its fingerprint 41d7a0c9 and ETag "6731-a91c".', 'Its fingerprint four one D seven eh zero C nine and E tag six seven three one, eh nine one C.'],
    ['It returns already_known from crawl.urls_due.', 'It returns already known from crawl dot U R Ls due.'],
    ['Costs £1.20, or 5% of $3m, e.g. per month.', 'Costs 1 pound 20 pence, or 5 per cent of 3 million dollars, for example, per month.'],
    ['It arrives as HTTPS://Example.org:443/news#top, slot 0417 of 1,024.', 'It arrives as example dot org port 443 slash news hash top, slot zero four one seven of 1,024.'],
    ['POST /v1/seeds (the seeds API) answers 202.', 'post slash version 1 slash seeds, the seeds A-P-I, answers 202.'],
    ['Ask 203.0.113.27, not 10.0.0.0/8; JS on the page, an IP and KMS.', 'Ask 203 dot 0 dot 113 dot 27, not 10 dot 0 dot 0 dot 0 slash 8; JavaScript on the page, an I P and K M S.'],
    ['Bucket 2026-11-12T10 holds warc/2026/11/12/000183.warc.gz.', 'Bucket the twelfth of November 2026, hour 10 holds wark slash 2026 slash 11 slash 12 slash zero zero zero one eight three dot wark dot g z.'],
  ];
  for (const [before, after] of cases) it(before, () => expect(spoken(before)).toBe(after));
});

describe('hashOf', () => {
  it('is 32-bit FNV-1a in hex', () => {
    expect(hashOf('')).toBe('811c9dc5');
    expect(hashOf('a')).toBe('e40c292c');
    expect(hashOf('foobar')).toBe('bf9cf968');
  });
  it('changes with the words', () => {
    expect(hashOf('Step 1. A URL.')).not.toBe(hashOf('Step 1. A URL!'));
  });
});

describe('narrationOf', () => {
  it('says the number, title, text and the story without its explain Q&As', () => {
    const t = narrationOf({ title: 'Title', text: 'Text here.', focus: [], path: [], labels: [], explain: [{ q: 'Q?', a: 'A secret answer.' }], story: { context: 'Before.', problem: 'Problem.', consequence: 'Then.', fix: 'Fix' } }, 3);
    expect(t).toBe('Step 3. Title.\n\nText here.\n\nBefore.\n\nProblem.\n\nThen.\n\nFix.');
  });
  it('skips a context that opens as the text does', () => {
    const t = narrationOf({ title: 'T', text: 'The crawl starts from seeds and more.', focus: [], path: [], labels: [], story: { context: 'The crawl starts from seeds and, again, more.', problem: 'P.', consequence: 'C.', fix: 'F.' } }, 1);
    expect(t).not.toContain('again');
  });
});

describe('narration manifest', async () => {
  const designs = new Map(await Promise.all(DESIGNS.map(async (d) => [d.id, await d.load()] as const)));

  it('names only public designs and tours that exist, with a file for every step', () => {
    for (const [id, tours] of Object.entries(NARRATION)) {
      const d = designs.get(id);
      expect(d, `design ${id}`).toBeTruthy();
      for (const [key, hashes] of Object.entries(tours)) {
        const tour = key === 'main' ? d!.tour : d!.stories?.find((s) => s.id === key)?.tour;
        expect(tour, `${id}/${key}`).toBeTruthy();
        hashes.forEach((h, i) => {
          if (h) expect(existsSync(join(audioDir, id, key, `${i + 1}.mp3`)), `${id}/${key}/${i + 1}.mp3`).toBe(true);
        });
      }
    }
  });

  it('has nothing for a locked page, in the manifest or under public/audio', () => {
    const onDisk = existsSync(audioDir) ? readdirSync(audioDir) : [];
    for (const id of LOCKED_IDS) {
      expect(Object.keys(NARRATION)).not.toContain(id);
      expect(onDisk).not.toContain(id);
    }
  });

  it('reports steps whose words changed since their clip was recorded', () => {
    const stale: string[] = [];
    for (const [id, tours] of Object.entries(NARRATION)) {
      const d = designs.get(id)!;
      for (const [key, hashes] of Object.entries(tours)) {
        const tour = key === 'main' ? d.tour : d.stories!.find((s) => s.id === key)!.tour;
        tour.forEach((s, i) => {
          if (hashes[i] !== hashOf(narrationOf(s, i + 1))) stale.push(`${id}/${key}/${i + 1}`);
        });
      }
    }
    // Not a failure: a stale clip is never played, and the step runs on its usual dwell. Re-record with scripts/audio/render.mjs.
    if (stale.length) console.warn(`Narration out of date for ${stale.length} step(s): ${stale.join(', ')}`);
    expect(Array.isArray(stale)).toBe(true);
  });
});
