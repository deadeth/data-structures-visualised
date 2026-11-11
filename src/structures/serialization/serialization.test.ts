import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import type { Frame, Scene } from '../../core/types';
import def, {
  BREAK_WORDS,
  FORMATS,
  SCENE,
  avro,
  breakIt,
  create,
  decode,
  encode,
  encodeAvro,
  encodeJson,
  encodeProto,
  evolve,
  hex,
  layout,
  unzigzag,
  varintBytes,
  zigzag,
  type SerState,
} from './index';

const quiet = (s: SerState) => new Recorder(s, layout, false);
const loud = (s: SerState) => new Recorder(s, layout, true);
const bytesOf = (s: SerState) => s.groups.flatMap((g) => g.bytes.map((b) => b.v));
const hexes = (b: number[]) => b.map(hex).join(' ');

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = f.scene.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|\[object/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
    }
    if (f.compare) expect(f.probe, 'a comparison follows a field').toBeDefined();
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < SCENE.left - 0.5 || a.x2 > SCENE.right + 0.5 || a.y1 < SCENE.top || a.y2 > SCENE.bottom + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    // Magenta is only for the field or byte being followed, and only while a probe is out.
    const magenta = f.scene.nodes.some((n) => n.tone === 'key' || n.cells.some((c) => c.tone === 'key'));
    if (magenta) expect(f.probe, f.message).toBeDefined();
    for (const n of f.scene.nodes) if (n.shape === 'tag') expect(n.tone).toBeUndefined();
  }
}

describe('serialisation', () => {
  it('writes the bytes the protobuf library and fastavro write for this record', () => {
    expect(hexes(encodeProto('v1'))).toBe('08 B9 0A 12 03 41 64 61 22 02 03 07');
    expect(hexes(encodeAvro('v1'))).toBe('F2 14 06 41 64 61 00 04 06 0E 00');
    expect(encodeJson('v1')).toBe('{"id":1337,"name":"Ada","scores":[3,7]}');
    expect(encodeJson('v1').length).toBe(39);
    expect(encodeProto('v2').length).toBe(17);
    expect(hexes(encodeProto('sint')).slice(0, 8)).toBe('08 F2 14');
    // The example in the protobuf documentation: 150 is 96 01.
    expect(hexes(varintBytes(150))).toBe('96 01');
  });

  it('varint and zigzag agree with a simple model', () => {
    for (let i = 0; i < 5000; i++) {
      const n = Math.floor(Math.random() * 2 ** 31);
      const b = varintBytes(n);
      let back = 0;
      b.forEach((x, k) => (back += (x & 127) * 128 ** k));
      expect(back).toBe(n);
      expect(b.slice(0, -1).every((x) => x >= 128)).toBe(true);
      expect(b[b.length - 1]).toBeLessThan(128);
      const m = n - 2 ** 30;
      expect(unzigzag(zigzag(m))).toBe(m);
      expect(zigzag(m)).toBeGreaterThanOrEqual(0);
    }
  });

  it('encode in protobuf: the key, the varint of 1337 as two comparisons, and the size against JSON', () => {
    const s = create('protobuf');
    const rec = loud(s);
    encode(s, rec);
    checkFrames(rec.frames);
    expect(hexes(bytesOf(s))).toBe('08 B9 0A 12 03 41 64 61 22 02 03 07');
    expect(rec.counters.written).toBe(12);
    const cmp = rec.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(cmp.slice(0, 3)).toEqual([
      { left: 'id key: 8', op: '<', right: 128, verdict: 'last byte: top bit clear' },
      { left: 'id: 1337', op: '≥', right: 128, verdict: 'more bytes follow: top bit set' },
      { left: 'id: 10', op: '<', right: 128, verdict: 'last byte: top bit clear' },
    ]);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toMatch(/12 bytes\. The same record as JSON is 39 bytes/);
    expect(rec.frames.some((f) => /email, is unset/.test(f.message))).toBe(true);
  });

  it('decode in protobuf reads back the record', () => {
    const s = create('protobuf');
    encode(s, quiet(s));
    const rec = loud(s);
    decode(s, rec);
    checkFrames(rec.frames);
    expect(rec.counters.read).toBe(12);
    expect(s.read).toMatchObject({ id: { text: '1337', tone: 'ok' }, name: { text: 'Ada' }, email: { text: 'unset' }, scores: { text: '[3,7]' } });
  });

  it('an old reader skips the new field by its wire type; a new reader takes a default', () => {
    const s = create('protobuf');
    encode(s, quiet(s));
    const rec = loud(s);
    expect(evolve(s, 'old', rec)).toBe(true);
    checkFrames(rec.frames);
    expect(rec.counters.skipped).toBe(1);
    expect(rec.counters.read).toBe(17);
    expect(s.groups.find((g) => g.field.name === 'plan')!.state).toBe('skipped');
    expect(rec.frames.some((f) => f.lines!.includes('s_jump'))).toBe(true);
    const back = loud(s);
    evolve(s, 'new', back);
    checkFrames(back.frames);
    expect(s.read.plan).toEqual({ text: '""', def: true, tone: undefined });
    expect(back.counters.skipped ?? 0).toBe(0);
  });

  it('a reused field number and an incompatible type change are misread in red, with no error', () => {
    const s = create('protobuf');
    const rec = loud(s);
    breakIt(s, 'reuse', rec);
    checkFrames(rec.frames);
    expect(s.read.scores).toEqual({ text: '[65,100,97]', tone: 'bad' });
    const r2 = loud(s);
    breakIt(s, 'type', r2);
    expect(s.read.id).toEqual({ text: '2674', tone: 'bad' });
  });

  it('Avro resolves by name: drops a field the reader lacks and defaults one the writer lacks', () => {
    const s = create('protobuf');
    encode(s, quiet(s));
    const rec = loud(s);
    avro(s, rec);
    checkFrames(rec.frames);
    expect(s.format).toBe('avro');
    expect(hexes(bytesOf(s))).toBe('F2 14 06 41 64 61 00 04 06 0E 00');
    expect(s.read).toMatchObject({ id: { text: '1337', tone: 'ok' }, name: { text: 'Ada' }, scores: { text: '[3,7]' }, plan: { text: 'free', def: true } });
    expect(rec.counters.skipped).toBe(1);
    const cmp = rec.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(cmp.map((c) => c.op)).toEqual(['=', '=', '≠', '=']);
  });

  it('Avro mistakes: reading without the writer schema misreads; a field with no default fails', () => {
    const s = create('avro');
    encode(s, quiet(s));
    const rec = loud(s);
    breakIt(s, 'noschema', rec);
    checkFrames(rec.frames);
    expect(s.read.scores.tone).toBe('bad');
    expect(s.read.plan.tone).toBe('bad');
    const r2 = loud(s);
    breakIt(s, 'nodefault', r2);
    checkFrames(r2.frames);
    expect(s.read.plan).toEqual({ text: 'error', tone: 'bad' });
  });

  it('JSON: an unknown key is ignored, a renamed one silently lost, a string where a number belongs kept', () => {
    const s = create('json');
    encode(s, quiet(s));
    expect(bytesOf(s).length).toBe(39);
    evolve(s, 'old', quiet(s));
    expect(s.groups.find((g) => g.field.name === 'plan')!.state).toBe('skipped');
    breakIt(s, 'rename', quiet(s));
    expect(s.read.name.tone).toBe('bad');
    breakIt(s, 'type', quiet(s));
    expect(s.read.id).toEqual({ text: '"1337"', tone: 'bad' });
  });

  it('bad words are answered, not ignored', () => {
    for (const fmt of FORMATS) {
      const s = create(fmt);
      encode(s, quiet(s));
      const a = loud(s);
      expect(evolve(s, 'sideways', a)).toBe(false);
      expect(breakIt(s, 'nope', a)).toBe(false);
      expect(a.frames.length).toBe(2);
      checkFrames(a.frames);
    }
  });

  it('counts the same with recording on and off, in every format, for every operation', () => {
    for (const fmt of FORMATS) {
      const a = create(fmt);
      const b = create(fmt);
      const runs: [string, (s: SerState, r: Recorder<SerState>) => unknown][] = [
        ['encode', (s, r) => encode(s, r)],
        ['decode', (s, r) => decode(s, r)],
        ['old', (s, r) => evolve(s, 'old', r)],
        ['new', (s, r) => evolve(s, 'new', r)],
        ['decode', (s, r) => decode(s, r)],
        ...BREAK_WORDS[fmt].map((w) => [w, (s: SerState, r: Recorder<SerState>) => breakIt(s, w, r)] as [string, (s: SerState, r: Recorder<SerState>) => unknown]),
        ['decode', (s, r) => decode(s, r)],
        ['encode', (s, r) => encode(s, r)],
        ['avro', (s, r) => avro(s, r)],
        ['decode', (s, r) => decode(s, r)],
      ];
      for (const [, run] of runs) {
        const on = loud(a);
        const off = quiet(b);
        run(a, on);
        run(b, off);
        expect(on.counters).toEqual(off.counters);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
      }
    }
  });

  it('seed, tour and suggestions run through the definition with code lines that exist', () => {
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    for (const p of def.params![0].options) {
      const s = def.create({ format: p.value });
      for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
      expect(s.groups.length).toBeGreaterThan(0);
      const used = new Map<string, Set<string>>();
      const run = (id: string, args: (number | string)[]) => {
        const rec = loud(s);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        checkFrames(rec.frames);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
      };
      for (const [id, ...args] of def.tour) run(id, args);
      for (let round = 0; round < 6; round++) for (const op of def.ops) run(op.id, op.suggest?.(s) ?? []);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
    for (const { id: lang } of LANGS)
      for (const op of def.ops) for (const line of listing(def.source![lang], lang, op.code!).lines) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('the scene stays inside about 940 by 460', () => {
    expect(SCENE.right - SCENE.left).toBeLessThanOrEqual(940);
    const s: Scene = layout(create());
    expect(s.nodes.length).toBeGreaterThan(0);
    expect(SCENE.bottom - SCENE.top).toBeLessThanOrEqual(460);
  });
});
