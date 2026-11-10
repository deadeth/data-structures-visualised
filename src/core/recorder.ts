import type { Compare, Frame, Probe, Rec, Scene, Tone } from './types';

/**
 * Collects frames while an operation runs.
 *
 * Marks are sticky highlights keyed by id. They are overlaid on whatever the
 * structure's layout() returns, so operations never have to thread highlight
 * state through their layout code. Marks stay until unmarked or cleared.
 *
 * With recording off, step() does nothing and only the counters move. The
 * head-to-head page uses that to run thousands of operations quickly.
 */
export class Recorder<S> implements Rec {
  readonly frames: Frame[] = [];
  readonly counters: Record<string, number> = {};
  private nodeMarks = new Map<string, Tone>();
  private cellMarks = new Map<string, Tone>();
  private edgeMarks = new Map<string, Tone>();

  constructor(
    private readonly state: S,
    private readonly layout: (state: S) => Scene,
    readonly recording = true,
  ) {}

  count(counter: string, by = 1): void {
    this.counters[counter] = (this.counters[counter] ?? 0) + by;
  }

  mark(nodeId: string, tone: Tone): void {
    if (this.recording) this.nodeMarks.set(nodeId, tone);
  }

  markCell(nodeId: string, cell: number, tone: Tone): void {
    if (!this.recording) return;
    // Marking a cell idle clears its mark, so the node's own tone shows through again.
    if (tone === 'idle') this.cellMarks.delete(`${nodeId}#${cell}`);
    else this.cellMarks.set(`${nodeId}#${cell}`, tone);
  }

  markEdge(edgeId: string, tone: Tone): void {
    if (this.recording) this.edgeMarks.set(edgeId, tone);
  }

  /** Remove the node mark and any cell marks on that node. */
  unmark(nodeId: string): void {
    this.nodeMarks.delete(nodeId);
    for (const k of [...this.cellMarks.keys()]) if (k.startsWith(`${nodeId}#`)) this.cellMarks.delete(k);
  }

  clearMarks(): void {
    this.nodeMarks.clear();
    this.cellMarks.clear();
    this.edgeMarks.clear();
  }

  /** Record a comparison: bumps the `comparisons` counter and snapshots a frame. */
  compare(
    left: string | number,
    op: Compare['op'],
    right: string | number,
    verdict: string,
    extra: { probe?: Probe; message?: string } = {},
  ): void {
    this.count('comparisons');
    if (!this.recording) return;
    const cmp: Compare = { left, op, right, verdict };
    // The readout shows the comparison itself, so the sentence beside it only needs to say what it means.
    const sentence = verdict.charAt(0).toUpperCase() + verdict.slice(1) + (/[.!?]$/.test(verdict) ? '' : '.');
    this.step(extra.message ?? sentence, { probe: extra.probe, compare: cmp });
  }

  step(message: string, extra: { probe?: Probe; compare?: Compare } = {}): void {
    if (!this.recording) return;
    const scene = this.layout(this.state);
    for (const n of scene.nodes) {
      const tone = this.nodeMarks.get(n.id);
      if (tone) n.tone = tone;
      if (this.cellMarks.size) {
        n.cells = n.cells.map((c, i) => {
          const t = this.cellMarks.get(`${n.id}#${i}`);
          return t ? { ...c, tone: t } : c;
        });
      }
    }
    for (const e of scene.edges) {
      const tone = this.edgeMarks.get(e.id);
      if (tone) e.tone = tone;
    }
    this.frames.push({ scene, message, probe: extra.probe, compare: extra.compare, counters: { ...this.counters } });
  }
}

/** Run one operation and return its frames and final counters. */
export function record<S>(
  state: S,
  layout: (state: S) => Scene,
  run: (rec: Rec) => void,
  recording = true,
): { frames: Frame[]; counters: Record<string, number> } {
  const rec = new Recorder(state, layout, recording);
  run(rec);
  return { frames: rec.frames, counters: rec.counters };
}
