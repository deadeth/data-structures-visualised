import { describe, expect, it } from 'vitest';
import { DESIGNS, design } from '../designs';
import { WALKTHROUGHS, READING_FILES } from '../reading';
import { ITERATIONS, open, seal } from './crypto';
import { LOCKED } from './manifest';
import { registerPayload, type LockedPayload } from './unlock';

// The repo has no Node type definitions, so the one Node module used here is typed by hand.
const { existsSync, readFileSync } = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { existsSync(p: URL): boolean; readFileSync(p: URL, enc: 'utf8'): string };

const PASSWORD = 'test-only-fixture-password';
const fixture = { hello: 'a tiny fixture', n: [1, 2, 3], unicode: '£1,000 → €1,150' };

describe('locked pages: encryption', () => {
  it('opens what it sealed, with the full iteration count', async () => {
    const sealed = await seal(JSON.stringify(fixture), PASSWORD);
    expect(sealed).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS });
    expect(ITERATIONS).toBe(600_000);
    expect(JSON.parse(await open(sealed, PASSWORD))).toEqual(fixture);
  });

  it('refuses a wrong password and a damaged file', async () => {
    const sealed = await seal('secret words', PASSWORD, 1000);
    await expect(open(sealed, 'not the password')).rejects.toThrow();
    const ct = sealed.ct.startsWith('A') ? `B${sealed.ct.slice(1)}` : `A${sealed.ct.slice(1)}`;
    await expect(open({ ...sealed, ct }, PASSWORD)).rejects.toThrow();
    await expect(open({ ...sealed, v: 2 as 1 }, PASSWORD)).rejects.toThrow();
  });

  it('uses a fresh salt and IV each time, and never holds the plain text', async () => {
    const a = await seal('secret words', PASSWORD, 1000);
    const b = await seal('secret words', PASSWORD, 1000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(JSON.stringify(a)).not.toContain('secret');
  });

  it('every manifest entry has a sealed file in public/ in the expected format', () => {
    for (const e of LOCKED) {
      const file = new URL(`../../public/${e.blob}`, import.meta.url);
      expect(existsSync(file), e.blob).toBe(true);
      const sealed = JSON.parse(readFileSync(file, 'utf8'));
      expect(sealed).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS });
      expect(Object.keys(sealed).sort()).toEqual(['ct', 'iter', 'iv', 'kdf', 'salt', 'v']);
      // A neutral name: the file's address gives nothing away.
      expect(e.blob).toMatch(/^locked\/[a-z0-9]+\.bin$/);
      expect(e.label).toBe('Locked page');
    }
    expect(existsSync(new URL('../../locked/source.bin', import.meta.url))).toBe(true);
  });

  it('no locked id is in the public registries', () => {
    for (const id of LOCKED.flatMap((e) => e.ids)) {
      expect(design(id)).toBeUndefined();
      expect(WALKTHROUGHS.has(id)).toBe(false);
    }
  });
});

describe('locked pages: registering an opened file', () => {
  it('adds the design, its extras and its walkthrough to the site registries', async () => {
    const before = DESIGNS.length;
    const d = { id: 'fixture-locked', name: 'Fixture design', blurb: 'b', tour: [], components: [], flows: [] };
    const payload = {
      designs: [d],
      extras: { 'fixture-locked': { opening: ['hi'], pushes: [] } },
      walkthroughs: { 'fixture-locked': { id: 'fixture-locked', title: 'Fixture walk', summary: 's', minutes: 1, sections: [] } },
      entries: [{ id: 'fixture-locked', name: 'Fixture (real name)', hint: 'h', question: 'q?' }],
    } as unknown as LockedPayload;
    // Through the same seal and open the site uses.
    const opened = JSON.parse(await open(await seal(JSON.stringify(payload), PASSWORD, 1000), PASSWORD)) as LockedPayload;
    registerPayload(opened);
    try {
      const e = design('fixture-locked')!;
      expect(e.name).toBe('Fixture (real name)');
      expect(e.question).toBe('q?');
      expect((await e.load()).name).toBe('Fixture design');
      expect((await e.extras!()).opening).toEqual(['hi']);
      expect(WALKTHROUGHS.get('fixture-locked')?.title).toBe('Fixture walk');
      expect(READING_FILES.some((f) => f.file === 'locked/fixture-locked.ts')).toBe(true);
      // Registering again replaces, not duplicates.
      registerPayload(opened);
      expect(DESIGNS.length).toBe(before + 1);
    } finally {
      DESIGNS.splice(DESIGNS.findIndex((x) => x.id === 'fixture-locked'), 1);
      WALKTHROUGHS.delete('fixture-locked');
      READING_FILES.splice(READING_FILES.findIndex((f) => f.file === 'locked/fixture-locked.ts'), 1);
    }
  });
});
