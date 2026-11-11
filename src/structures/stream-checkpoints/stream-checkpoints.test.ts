import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { KEYS, LOGS, SLOTS, TASKS, checkpoint, crash, create, keyAt, layout, process, recover, windowStart, type JobState } from './index';

const quiet = (s: JobState) => new Recorder(s, layout, false);
const loud = (s: JobState) => new Recorder(s, layout, true);

function boxes(scene: Scene) {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, a probe on a real node, code lines, plain tags, magenta only on the followed record, nothing overlapping, a scene that fits. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const byId = new Map(f.scene.nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(byId.has(f.probe.at), `probe at ${f.probe.at}: ${f.message}`).toBe(true);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') {
        expect(n.tone).toBeUndefined();
        expect(n.cells[0].tone).toBeUndefined();
      }
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      for (const c of n.cells) if (c.tone === 'key') expect(c.text).toBe(f.probe?.text);
    }
    const bs = boxes(f.scene);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) expect.fail(`${a.id} overlaps ${b.id}`);
      }
    }
    const b = sceneBounds(f.scene)!;
    expect(b.bw).toBeLessThanOrEqual(940);
    expect(b.bh).toBeLessThanOrEqual(430);
  }
}

/** Replays what the page's recover does, on a job that never crashes, and checks the two agree. */
function agree(job: JobState, model: JobState): void {
  expect(job.counts).toEqual(model.counts);
  expect(job.offsets).toEqual(model.offsets);
  expect(job.table).toEqual(model.table);
  // The two-phase sink: readers see exactly what a job without crashes would have committed.
  expect(job.committed).toEqual(model.committed);
  // The log sink: the same results, plus repeats, never fewer.
  const firsts = job.appended.filter((r) => !r.dup).map((r) => [r.key, r.n]);
  expect(firsts).toEqual(model.appended.map((r) => [r.key, r.n]));
  expect(job.done.offsets).toEqual(model.done.offsets);
  expect(job.done.counts).toEqual(model.done.counts);
}

describe('exactly-once with checkpoints', () => {
  it('matches a job that never crashes, through thousands of random operations', () => {
    for (const seed of [1, 2, 3]) {
      const rnd = makeRng(20261111 + seed);
      const job = create();
      const model = create();
      let crashes = 0;
      let replayed = 0;
      for (let i = 0; i < 3000; i++) {
        const roll = rnd();
        if (roll < 0.6) {
          const p = Math.floor(rnd() * 2);
          const got = process(job, p, quiet(job));
          if (job.running) expect(got).toBe(process(model, p, quiet(model)));
          else expect(got).toBeNull();
        } else if (roll < 0.8) {
          const got = checkpoint(job, quiet(job));
          if (job.running) expect(got).toBe(checkpoint(model, quiet(model)));
          else expect(got).toBeNull();
        } else if (roll < 0.9) {
          if (crash(job, quiet(job))) crashes++;
          expect(job.running).toBe(false);
        } else {
          const rec = quiet(job);
          const wasDown = !job.running;
          const n = recover(job, rec);
          if (wasDown) {
            replayed += n;
            expect(rec.counters.replayed ?? 0).toBe(n);
          } else expect(n).toBe(0);
        }
        if (job.running) agree(job, model);
        // Count's state only ever holds what the log says: every key's count is the reads of that key.
        if (job.running && i % 100 === 0) {
          const want = KEYS.map((k) => LOGS.reduce((sum, _log, p) => sum + Array.from({ length: job.offsets[p] }, (_x, o) => keyAt(p, o)).filter((x) => x === k).length, 0));
          expect(job.counts).toEqual(want);
        }
      }
      expect(crashes).toBeGreaterThan(50);
      expect(replayed).toBeGreaterThan(50);
    }
  }, 60_000);

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    for (let i = 0; i < 500; i++) {
      const on = loud(a);
      const off = quiet(b);
      const roll = rnd();
      if (roll < 0.55) {
        const p = Math.floor(rnd() * 2);
        expect(process(a, p, on)).toBe(process(b, p, off));
      } else if (roll < 0.75) expect(checkpoint(a, on)).toBe(checkpoint(b, off));
      else if (roll < 0.87) expect(crash(a, on)).toBe(crash(b, off));
      else expect(recover(a, on)).toBe(recover(b, off));
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('aligns barriers: holds channel 0, snapshots the state before the barrier, then counts the held record', () => {
    const s = create();
    process(s, 0, quiet(s));
    process(s, 1, quiet(s));
    const rec = loud(s);
    expect(checkpoint(s, rec)).toBe(1);
    checkFrames(rec.frames);
    const hold = rec.frames.find((f) => f.lines!.includes('hold'))!;
    const held = hold.scene.nodes.find((n) => n.id === 'held')!;
    expect(held.cells[0].text).toBe(String(keyAt(0, 1)));
    const e0 = hold.scene.edges.find((e) => e.id === 'e0')!;
    expect(e0).toMatchObject({ dashed: true, tone: 'bad' });
    const align = rec.frames.find((f) => f.compare && f.lines!.includes('align'))!;
    expect(align.compare).toMatchObject({ left: 'B1 seen 2', op: '=', right: 'inputs 2' });
    const complete = rec.frames.find((f) => f.lines!.includes('complete') && f.compare)!;
    expect(complete.compare).toMatchObject({ left: `B1 acks ${TASKS}`, op: '=', right: `tasks ${TASKS}` });
    // The snapshot has the counts before the held record; the live state has it.
    expect(s.done).toMatchObject({ id: 1, offsets: [1, 1], counts: [1, 0, 1], txn: 1 });
    expect(s.counts).toEqual([1, 0, 2]);
    expect(s.offsets).toEqual([2, 1]);
    // Transaction 1 was committed with the checkpoint; the held record's result waits in transaction 2.
    expect(s.committed.map((r) => `${r.key}=${r.n}`)).toEqual(['7=1', '42=1']);
    expect(s.txn.map((r) => `${r.key}=${r.n}`)).toEqual(['42=2']);
    expect(s.txnId).toBe(2);
    // The barrier is followed until the checkpoint completes.
    expect(rec.frames.filter((f) => f.probe?.text === 'B1').length).toBeGreaterThan(6);
  });

  it('runs the tour: duplicates at the log sink, none at the two-phase sink, counts as before the crash', () => {
    const s = def.create({});
    for (const [id, ...args] of def.seed) {
      const rec = quiet(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      expect(rec.counters.reads ?? 0).toBeGreaterThanOrEqual(0);
    }
    expect(s.done.id).toBe(1);
    const used = new Map<string, Set<string>>();
    const outcomes: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      checkFrames(rec.frames);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
      outcomes.push(`${id}: ${s.running ? s.counts.join(',') : 'down'}; dups ${rec.counters.duplicates ?? 0}; replayed ${rec.counters.replayed ?? 0}`);
      if (id === 'recover') {
        const cmp = rec.frames.find((f) => f.compare)!;
        expect(cmp.compare).toMatchObject({ op: '=', verdict: 'state is exactly-once' });
        // The duplicates are drawn red at the log sink.
        const last = rec.frames[rec.frames.length - 1].scene.nodes.find((n) => n.id === 'alo')!;
        expect(last.cells.filter((c) => c.tone === 'bad').length).toBe(3);
        // The upsert table went back for a moment and was said to.
        expect(rec.frames.some((f) => /goes back from 13=2 to 13=1/.test(f.message))).toBe(true);
      }
    }
    expect(outcomes).toEqual([
      'process: 2,0,2; dups 0; replayed 0',
      'checkpoint: 2,1,2; dups 0; replayed 0',
      'process: 2,2,2; dups 0; replayed 0',
      'process: 3,2,2; dups 0; replayed 0',
      'crash: down; dups 0; replayed 0',
      'recover: 3,2,2; dups 3; replayed 3',
      'checkpoint: 3,2,3; dups 0; replayed 0',
    ]);
    // Committed output has each result once, in the order a job without a crash would give.
    const committed = s.committed.map((r) => `${r.key}=${r.n}`);
    expect(new Set(committed).size).toBe(committed.length);
    expect(committed).toEqual(['7=1', '42=1', '42=2', '7=2', '13=1', '13=2', '7=3']);
    expect(def.status!(s)).toEqual([
      { label: 'Job', value: 'running' },
      { label: 'Restart point', value: 'checkpoint 3' },
      { label: 'Source offsets', value: 'S0 6, S1 2' },
      { label: 'Duplicates in the log sink', value: '3' },
    ]);
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
  });

  it('refuses work while down and recovers only when down, changing nothing', () => {
    const s = create();
    process(s, 0, quiet(s));
    let rec = loud(s);
    expect(recover(s, rec)).toBe(0);
    expect(rec.frames.length).toBe(1);
    crash(s, quiet(s));
    const before = JSON.stringify(s);
    for (const run of [(r: Recorder<JobState>) => process(s, 1, r), (r: Recorder<JobState>) => checkpoint(s, r), (r: Recorder<JobState>) => crash(s, r), (r: Recorder<JobState>) => process(s, 5, r)]) {
      rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBe(1);
      expect(rec.counters).toEqual({});
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
    // With no completed checkpoint, recovery starts from the very beginning and replays everything.
    rec = loud(s);
    expect(recover(s, rec)).toBe(1);
    checkFrames(rec.frames);
    expect(s.counts).toEqual([1, 0, 0]);
  });

  it('draws the chk and next tags under the offsets they hold, and every offset in order', () => {
    const rnd = makeRng(99);
    const s = create();
    for (let i = 0; i < 400; i++) {
      const roll = rnd();
      if (roll < 0.6) process(s, Math.floor(rnd() * 2), quiet(s));
      else if (roll < 0.8) checkpoint(s, quiet(s));
      else if (roll < 0.9) crash(s, quiet(s));
      else recover(s, quiet(s));
      const scene = layout(s);
      for (let p = 0; p < 2; p++) {
        const start = windowStart(s, p);
        const slots = scene.nodes.filter((n) => n.id.startsWith(`p${p}o`)).sort((a, b) => a.x - b.x);
        expect(slots.length).toBe(SLOTS);
        slots.forEach((n, i) => expect(n.cells[0]).toMatchObject({ sub: String(start + i), text: String(keyAt(p, start + i)) }));
        // Each tag sits on its own row, centred under the slot it names.
        const slotAt = (id: string) => {
          const tag = scene.nodes.find((m) => m.id === id)!;
          const hit = slots.find((n) => Math.abs(n.x - tag.x) < 1);
          expect(tag.y).toBeGreaterThan(slots[0].y);
          return hit ? Number(hit.cells[0].sub) : NaN;
        };
        if (s.done.offsets[p] >= start) expect(slotAt(`t${p}chk`)).toBe(s.done.offsets[p]);
        else expect(scene.nodes.find((m) => m.id === `t${p}chk`)!.cells[0].text).toBe('‹chk');
        if (s.running) expect(slotAt(`t${p}next`)).toBe(s.offsets[p]);
      }
      const b = sceneBounds(scene)!;
      expect(b.bw).toBeLessThanOrEqual(940);
    }
  });

  it('every operation has a listing in both languages with lines that fit the panel', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        expect(l.anchors.size).toBeGreaterThan(0);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
  });
});
