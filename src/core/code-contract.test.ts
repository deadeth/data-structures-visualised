import { describe, expect, it } from 'vitest';
import { CATALOG, isReady, loadStructure } from '../catalog';
import { LANGS, codeProblems, listing } from './code';
import { Recorder } from './recorder';
import type { OpDef, StructureDef } from './types';

/**
 * Every structure that ships example code must keep it in step with its
 * animation: each operation has a listing in both languages, both listings
 * carry the same anchors, and every frame names anchors its listing has.
 */
const ids = CATALOG.map((c) => c.id).filter(isReady);

describe.each(ids)('%s: code listings', (id) => {
  it('stay in step with the animation', async () => {
    const def: StructureDef = await loadStructure(id);
    if (!def.source) return;
    const find = (opId: string) => def.ops.find((o) => o.id === opId) as OpDef<unknown>;

    for (const op of def.ops) expect(op.code?.length, `${id}.${op.id} has no code regions`).toBeGreaterThan(0);
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source[lang], lang, op.code!);
        expect(l.lines.length).toBeGreaterThan(1);
        expect(l.anchors.size, `${id}.${op.id} ${lang} listing has no anchors`).toBeGreaterThan(0);
        for (const line of l.lines) expect(line.length, `${id}.${op.id} ${lang}: line too long: ${line}`).toBeLessThanOrEqual(80);
      }
    }

    for (const params of paramSets(def)) {
      const state = def.create(params);
      for (const [opId, ...args] of def.seed) find(opId).run(state, args, new Recorder(state, def.layout, false));
      const used = new Map<string, Set<string>>();
      const run = (opId: string, args: (number | string)[]) => {
        const rec = new Recorder(state, def.layout, true);
        find(opId).run(state, args, rec);
        const set = used.get(opId) ?? new Set<string>();
        used.set(opId, set);
        rec.frames.forEach((f, i) => {
          expect(f.lines?.length, `${id}.${opId} frame ${i + 1} ("${f.message.slice(0, 60)}") names no code line`).toBeGreaterThan(0);
          for (const a of f.lines ?? []) set.add(a);
        });
      };
      for (const [opId, ...args] of def.tour) run(opId, args);
      // Then whatever each operation suggests for itself, a few times over, to reach more paths.
      for (let round = 0; round < 12; round++) {
        for (const op of def.ops) run(op.id, op.suggest?.(state) ?? []);
      }
      expect(codeProblems(def.source, def.ops, used)).toEqual([]);
    }
  });
});

function paramSets(def: StructureDef): Record<string, number>[] {
  const base: Record<string, number> = {};
  for (const p of def.params ?? []) base[p.id] = p.default;
  const sets = [base];
  for (const p of def.params ?? []) for (const o of p.options) if (o.value !== p.default) sets.push({ ...base, [p.id]: o.value });
  return sets;
}
