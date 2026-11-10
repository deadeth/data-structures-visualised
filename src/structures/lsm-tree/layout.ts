import { CHAR_W, cellsWidth } from '../../core/geometry';
import type { Cell, Decor, Scene, SceneNode } from '../../core/types';
import { MEM, MEM_CAP, VISIBLE, entryText, tid, type Entry, type LsmState } from './lsm';

/** Tables start to the right of the lane labels. */
const X0 = 108;
const PITCH = 88;
const BAND_H = 78;
/** Node centre below the top of its band. Leaves room above for the probe chip. */
const NODE_DY = 48;
const TABLE_GAP = 12;
const RUN_GAP = 3;
const PAD = 12;
const BASE_W = 804;

const cellW = (text: string) => (text.length <= 2 ? 36 : Math.ceil(text.length * CHAR_W) + 12);
const narrowW = (text: string) => (text.length <= 2 ? 28 : Math.ceil(text.length * CHAR_W) + 8);

function entryCell(e: Entry): Cell {
  const text = entryText(e);
  return e.del ? { text, w: cellW(text), tone: 'bad' } : { text, w: cellW(text) };
}

/** One lane for the memtable, then one per level. The tree starts with three levels and adds more as it fills. */
function lanes(levels: number): { title: string; sub: string[] }[] {
  const out = [
    { title: 'Memtable', sub: ['in memory'] },
    { title: 'L0', sub: ['newest first', 'may overlap'] },
  ];
  for (let lv = 1; lv < levels; lv++) out.push({ title: `L${lv}`, sub: ['sorted run', lv === levels - 1 ? 'last level' : 'no overlaps'] });
  return out;
}

export function layout(s: LsmState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  let right = BASE_W - PAD;
  const top = (lane: number) => lane * PITCH;
  const cy = (lane: number) => top(lane) + NODE_DY;
  const rows = lanes(s.levels.length);
  const notes: string[][] = rows.map((l) => l.sub);

  // Memtable: its entries, then the free slots, so the reader can see it fill up.
  const memCells: Cell[] = s.mem.map(entryCell);
  for (let i = s.mem.length; i < MEM_CAP; i++) memCells.push({ text: '', w: 36, tone: 'dim' });
  const memW = cellsWidth(memCells);
  nodes.push({ id: MEM, x: X0 + memW / 2, y: cy(0), cells: memCells });
  decor.push({
    id: 'mem-hint',
    type: 'label',
    x: X0 + memW + 18,
    y: cy(0),
    text: `Every write lands here first. At ${MEM_CAP} entries it is flushed to disk.`,
  });

  const merge = s.merge;
  for (let lv = 0; lv < s.levels.length; lv++) {
    const lane = lv + 1;
    const y = cy(lane);
    let x = X0;

    if (merge && merge.phase === 'run' && lv === merge.to) {
      // The merged run takes the place of this level's old tables: one cell per entry, tinted by the input it came from.
      const avail = BASE_W - PAD - X0;
      const full = (width: (t: string) => number) => merge.run.reduce((sum, c) => sum + width(c.text) + RUN_GAP, -RUN_GAP);
      const width = full(cellW) <= avail ? cellW : narrowW;
      let shown = merge.run.length;
      if (full(width) > avail) {
        // Still too long: show what fits and say how many more there are.
        let used = 0;
        shown = 0;
        for (const c of merge.run) {
          const w = width(c.text) + RUN_GAP;
          if (used + w > avail - 52) break;
          used += w;
          shown++;
        }
      }
      for (let i = 0; i < shown; i++) {
        const c = merge.run[i];
        const w = width(c.text);
        const cell: Cell = c.del ? { text: c.text, w, tone: 'bad' } : { text: c.text, w };
        nodes.push({ id: `r${merge.seq}-${i}`, x: x + w / 2, y, cells: [cell], hue: c.hue, from: `t${c.src}` });
        x += w + RUN_GAP;
      }
      if (shown < merge.run.length) {
        const text = `+${merge.run.length - shown}`;
        const w = Math.ceil(text.length * CHAR_W) + 14;
        nodes.push({ id: `r${merge.seq}-more`, x: x + w / 2, y, cells: [{ text, w, tone: 'dim' }] });
        x += w + RUN_GAP;
        notes[lane][1] = `${shown} of ${merge.run.length} shown`;
      }
      right = Math.max(right, x - RUN_GAP);
      continue;
    }

    const tables = s.levels[lv];
    if (!tables.length) {
      decor.push({ id: `empty-${lv}`, type: 'label', x: X0 + 2, y, text: 'empty' });
      continue;
    }
    const start = Math.min(Math.max(s.view[lv] ?? 0, 0), Math.max(0, tables.length - VISIBLE));
    const end = Math.min(tables.length, start + VISIBLE);
    for (let i = start; i < end; i++) {
      const t = tables[i];
      const cells = t.entries.map(entryCell);
      const w = cellsWidth(cells);
      const id = tid(t);
      const node: SceneNode = { id, x: x + w / 2, y, cells };
      const from = s.born.get(id);
      if (from) node.from = from;
      if (merge && merge.hue.has(t.id)) node.hue = merge.hue.get(t.id);
      nodes.push(node);
      x += w + TABLE_GAP;
    }
    right = Math.max(right, x - TABLE_GAP);
    if (tables.length > VISIBLE) notes[lane][1] = `${start + 1} to ${end} of ${tables.length}`;
  }

  const bandW = right + PAD;
  const bands: Decor[] = [];
  rows.forEach((l, lane) => {
    const y = top(lane);
    bands.push({ id: `band-${lane}`, type: 'band', x: 0, y, w: bandW, h: BAND_H });
    bands.push({ id: `title-${lane}`, type: 'label', x: 12, y: y + 20, text: l.title, strong: true });
    notes[lane].forEach((text, i) => bands.push({ id: `note-${lane}-${i}`, type: 'label', x: 12, y: y + 39 + i * 17, text }));
  });
  return { nodes, edges: [], decor: [...bands, ...decor] };
}
