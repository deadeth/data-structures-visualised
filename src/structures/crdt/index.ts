import { LABEL_MAX, PROBE_H, SUB_ROOM, probeWidth } from '../../core/fit';
import { CELL_GAP, CELL_H, TRAY_PAD, cellWidth } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/Crdt.java?raw';
import python from './code/crdt.py?raw';
import { info } from './info';

/**
 * Three replicas, each holding two state-based CRDTs:
 *
 * - a PN-counter: `p[r]` counts the increments made at replica r, `n[r]` the
 *   decrements. A replica only ever writes its own slot. The value is
 *   sum(p) − sum(n). Merge takes the larger number in every slot.
 * - an add-wins observed-remove set, in its simplest correct form: every add
 *   makes an entry tagged with a unique dot (replica name and that replica's
 *   next sequence number), and a remove marks the dots it has seen as
 *   removed (a tombstone). Merge is the union of the entries and the union of
 *   the tombstones. An element is in the set while one of its dots is live.
 *
 * Merges are synchronous: one replica reads another's whole state. There is
 * no network, no delay and no lost message.
 */
export interface Entry {
  /** Unique tag of the add that made this entry, such as "A2". */
  dot: string;
  elem: number;
  /** A tombstone: this replica has seen the dot removed. */
  removed: boolean;
  /** Not part of the CRDT: the node this entry was copied from, so the drawing can fly it across. */
  from?: string;
}

export interface Replica {
  p: number[];
  n: number[];
  /** Sequence number of this replica's last dot. */
  seq: number;
  /** Entries in the order this replica learnt of them. */
  entries: Entry[];
}

export interface CrdtState {
  replicas: Replica[];
}

export const NAMES = ['A', 'B', 'C'] as const;
export const REPLICAS = NAMES.length;
/** Entries the page draws per replica. Every replica ends up holding every dot, so this bounds the dots in the whole system. */
export const MAX_ENTRIES = 5;
/** Largest number a counter slot may hold, so the cells stay readable. */
export const MAX_COUNT = 99;
export const MAX_ELEM = 99;

export function create(): CrdtState {
  return {
    replicas: NAMES.map(() => ({ p: [0, 0, 0], n: [0, 0, 0], seq: 0, entries: [] })),
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const value = (r: Replica) => sum(r.p) - sum(r.n);
/** Elements with at least one live dot, smallest first, so replicas that agree read alike. */
export function elements(r: Replica): number[] {
  const out: number[] = [];
  for (const e of r.entries) if (!e.removed && !out.includes(e.elem)) out.push(e.elem);
  return out.sort((a, b) => a - b);
}
/** Every dot anywhere in the system. */
export function allDots(s: CrdtState): Set<string> {
  return new Set(s.replicas.flatMap((r) => r.entries.map((e) => e.dot)));
}

/** A replica's state with page-only fields left out and the entries in a fixed order: equal CRDT states give equal results. */
export function canonical(r: Replica): string {
  const entries = [...r.entries].sort((a, b) => (a.dot < b.dot ? -1 : a.dot > b.dot ? 1 : 0)).map((e) => `${e.dot}:${e.elem}:${e.removed ? 'x' : 'o'}`);
  return `p${r.p.join(',')} n${r.n.join(',')} {${entries.join(' ')}}`;
}

export function converged(s: CrdtState): boolean {
  const first = canonical(s.replicas[0]);
  return s.replicas.every((r) => canonical(r) === first);
}

/** Read a replica name, a to c, or its index. */
export function asReplica(raw: number | string): number | null {
  const t = String(raw).trim().toUpperCase();
  const i = NAMES.indexOf(t as (typeof NAMES)[number]);
  return i >= 0 ? i : null;
}

// ---- ids and words -----------------------------------------------------------

const rid = (i: number) => `rep${i}`;
const pid = (i: number) => `p${i}`;
const nid = (i: number) => `n${i}`;
const vid = (i: number) => `v${i}`;
const sid = (i: number) => `read${i}`;
const eid = (i: number, dot: string) => `e${i}-${dot}`;
const minus = (n: number) => (n < 0 ? `−${-n}` : String(n));
const setText = (els: number[]) => `{${els.join(', ')}}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sumText = (r: Replica) => `(${r.p.join(' + ')}) − (${r.n.join(' + ')}) = ${minus(value(r))}`;
const slotName = (which: 'p' | 'n', j: number) => `${which.toUpperCase()}[${NAMES[j]}]`;
const entryName = (e: Entry) => `${e.elem} ${e.dot}`;
const status = (e: Entry | undefined) => (!e ? 'missing' : e.removed ? 'removed' : 'live');
const BAD_REPLICA = 'There are three replicas on this page, A, B and C. Enter a, b or c.';

// ---- counter -------------------------------------------------------------------

/** Count one increment (+1) or decrement (−1) at a replica. Returns false when the page's limit stops it. */
export function bump(s: CrdtState, raw: number | string, which: 'p' | 'n', rec: Rec): boolean {
  const i = asReplica(raw);
  rec.vars();
  rec.line(which === 'p' ? 'inc' : 'dec');
  if (i === null) {
    rec.step(BAD_REPLICA);
    return false;
  }
  const r = s.replicas[i];
  const R = NAMES[i];
  const vec = r[which];
  const node = which === 'p' ? pid(i) : nid(i);
  const text = which === 'p' ? '+1' : '−1';
  const probe = { text, at: node, cell: i };
  if (vec[i] >= MAX_COUNT) {
    rec.step(`Sorry, this page keeps each slot at ${MAX_COUNT} or less so the cells stay readable, and ${slotName(which, i)} at ${R} is there already. A real counter slot is a 64-bit integer.`, { probe });
    return false;
  }
  const before = vec[i];
  vec[i]++;
  rec.vars({ self: R, [`${which}[${R}]`]: vec[i] });
  rec.count('writes');
  rec.markCell(node, i, 'key');
  rec.step(
    `${R} ${which === 'p' ? 'increments' : 'decrements'}. It adds 1 to its own slot, ${slotName(which, i)}, ${before} → ${vec[i]}. A replica only ever writes its own slot, so no two replicas ever write the same number, and no lock or leader is needed.`,
    { probe },
  );
  rec.markCell(node, i, 'ok');
  rec.line('value');
  rec.vars({ self: R, p: r.p, n: r.n, 'value()': value(r) });
  const others = s.replicas.flatMap((o, j) => (j === i ? [] : [`${NAMES[j]} still reads ${minus(value(o))}`]));
  rec.step(`${R} reads sum(P) − sum(N) = ${sumText(r)}. ${others.join(' and ')}: they find out at their next merge. 1 slot written, nothing sent.`, { probe });
  rec.clearMarks();
  return true;
}

// ---- set -----------------------------------------------------------------------

/** Add an element at a replica under a new dot. Returns the dot, or null when the page's limit stops it. */
export function add(s: CrdtState, raw: number | string, elem: number, rec: Rec): string | null {
  const i = asReplica(raw);
  rec.vars();
  rec.line('dot');
  if (i === null) {
    rec.step(BAD_REPLICA);
    return null;
  }
  const r = s.replicas[i];
  const R = NAMES[i];
  const probe = { text: String(elem), at: rid(i) };
  if (!Number.isInteger(elem) || elem < 0 || elem > MAX_ELEM) {
    rec.step(`Elements on this page are whole numbers from 0 to ${MAX_ELEM}.`, { probe });
    return null;
  }
  const dots = allDots(s).size;
  if (dots >= MAX_ENTRIES) {
    rec.step(
      `Sorry, this page draws at most ${MAX_ENTRIES} entries per replica, and the replicas already hold ${MAX_ENTRIES} dots between them. After a sync every replica would hold every one. Remove an element, sync, and run Collect tombstones to make room. Real sets have no such limit, but the same growth is why they need collecting.`,
      { probe },
    );
    return null;
  }
  const already = r.entries.filter((e) => e.elem === elem && !e.removed).map((e) => e.dot);
  r.seq++;
  const dot = `${R}${r.seq}`;
  rec.vars({ self: R, element: elem, seq: r.seq, dot });
  rec.step(
    `${R} adds ${elem}. It tags this add with a new dot, ${dot}: its own name and its next sequence number. No other replica can make a dot called ${dot}, so this add can always be told apart from every other add of ${elem}.`,
    { probe },
  );
  r.entries.push({ dot, elem, removed: false });
  rec.count('writes');
  const at = { text: String(elem), at: eid(i, dot) };
  rec.mark(eid(i, dot), 'key');
  rec.line('store');
  rec.step(
    `Store the entry (${elem}, ${dot}). ` +
      (already.length
        ? `${elem} was already in ${R}'s set under ${already.join(' and ')}, and ${R} still makes a fresh dot. If another replica is removing ${elem} right now, it has seen only the old dots, and this new one is what lets the add win.`
        : `${R} reads ${setText(elements(r))}. The other replicas learn of it at their next merge.`),
    { probe: at },
  );
  rec.mark(eid(i, dot), 'ok');
  rec.line('read');
  rec.vars({ self: R, element: elem, dot, 'elements()': elements(r) });
  rec.step(`${R} reads ${setText(elements(r))}. 1 entry written, nothing sent, nobody asked.`, { probe: at });
  rec.clearMarks();
  return dot;
}

/** Remove an element at a replica: tombstone every live dot of it that this replica has seen. Returns how many. */
export function remove(s: CrdtState, raw: number | string, elem: number, rec: Rec): number {
  const i = asReplica(raw);
  rec.vars();
  rec.line('scan');
  if (i === null) {
    rec.step(BAD_REPLICA);
    return 0;
  }
  const r = s.replicas[i];
  const R = NAMES[i];
  rec.vars({ self: R, element: elem });
  rec.step(
    `${R} removes ${elem}. An observed remove: ${R} looks through its own entries and tombstones each live dot of ${elem} it finds. Dots it has not seen are not touched.`,
    { probe: { text: String(elem), at: rid(i) } },
  );
  const gone: string[] = [];
  for (const e of r.entries) {
    const node = eid(i, e.dot);
    const probe = { text: String(elem), at: node };
    rec.mark(node, 'compare');
    rec.line('scan', 'test');
    rec.vars({ self: R, element: elem, dot: e.dot, e: e.elem, 'dot in removed': e.removed });
    if (e.elem !== elem) {
      rec.compare(String(elem), '≠', `${e.elem} ${e.dot}`, 'not this element, keep', { probe });
      rec.unmark(node);
      continue;
    }
    if (e.removed) {
      rec.compare(String(elem), '=', `${e.elem} ${e.dot}`, 'already removed, skip', { probe });
      rec.unmark(node);
      continue;
    }
    rec.compare(String(elem), '=', `${e.elem} ${e.dot}`, `tombstone ${e.dot}`, { probe });
    e.removed = true;
    rec.vars({ self: R, element: elem, dot: e.dot, e: e.elem, 'dot in removed': true });
    gone.push(e.dot);
    rec.count('writes');
    rec.mark(node, 'bad');
    rec.line('tomb');
    rec.step(`Mark ${e.dot} removed. The entry stays, as a tombstone, so a merge can pass the removal on and an older copy of ${e.dot} cannot bring ${elem} back.`, { probe });
    rec.unmark(node);
  }
  rec.line('read');
  rec.vars({ self: R, element: elem, 'elements()': elements(r) });
  rec.step(
    gone.length
      ? `${R} removed ${elem}: ${plural(gone.length, 'dot')} tombstoned (${gone.join(', ')}), and ${R} reads ${setText(elements(r))}. The remove covers only these dots. An add of ${elem} at another replica that ${R} has not seen has a different dot and will survive the merge: add wins.`
      : `${R} has no live dot of ${elem}, so there is nothing to remove. A replica can only remove what it has observed. ${R} reads ${setText(elements(r))}.`,
  );
  return gone.length;
}

// ---- merge ---------------------------------------------------------------------

export interface MergeResult {
  /** Counter slots raised, as "P[B] 1 → 2". */
  slots: string[];
  /** Dots copied in. */
  copied: string[];
  /** Dots newly tombstoned. */
  tombed: string[];
  comparisons: number;
}

/**
 * Merge `from` into `into`, slot by slot and entry by entry. With `loud` the
 * recorder gets a frame for every comparison; without it only the counters move.
 */
function join(s: CrdtState, t: number, f: number, rec: Rec, loud: boolean): MergeResult {
  const into = s.replicas[t];
  const from = s.replicas[f];
  const T = NAMES[t];
  const F = NAMES[f];
  const out: MergeResult = { slots: [], copied: [], tombed: [], comparisons: 0 };

  for (const which of ['p', 'n'] as const) {
    const node = which === 'p' ? pid : nid;
    for (let j = 0; j < REPLICAS; j++) {
      const a = into[which][j];
      const b = from[which][j];
      const name = slotName(which, j);
      const probe = { text: name, at: node(f), cell: j };
      out.comparisons++;
      if (loud) {
        rec.markCell(node(f), j, 'key');
        rec.markCell(node(t), j, 'compare');
        rec.line(which === 'p' ? 'max_p' : 'max_n');
        rec.vars({ self: T, other: F, r: NAMES[j], [`other.${which}[r]`]: b, [`self.${which}[r]`]: a });
        rec.compare(`${F}: ${b}`, b > a ? '>' : b === a ? '=' : '<', `${T}: ${a}`, b > a ? `${T} takes ${b}` : b === a ? 'equal, keep' : `${T} keeps ${a}`, {
          probe,
          message:
            b > a
              ? `${name} counts ${NAMES[j]}'s ${which === 'p' ? 'increments' : 'decrements'}. ${F} has seen ${b} of them and ${T} only ${a}, so ${T} has missed some. Take the larger number.`
              : b === a
                ? `${name}: both have seen ${a}. Nothing to take.`
                : `${name}: ${T} has seen ${a} and ${F} only ${b}. ${F}'s number is older news, so ${T} keeps its own. Taking the larger number never undoes a count.`,
        });
      } else rec.count('comparisons');
      if (b > a) {
        into[which][j] = b;
        out.slots.push(`${name} ${a} → ${b}`);
        rec.count('writes');
        if (loud) {
          rec.markCell(node(t), j, 'ok');
          rec.line(which === 'p' ? 'take_p' : 'take_n');
          rec.vars({ self: T, other: F, r: NAMES[j], [`other.${which}[r]`]: b, [`self.${which}[r]`]: b });
          rec.step(`${T}'s ${name} becomes ${b}. ${T} now reads ${sumText(into)}.`, { probe: { text: name, at: node(t), cell: j } });
        }
      } else if (loud) rec.markCell(node(t), j, 'idle');
      if (loud) rec.markCell(node(f), j, 'idle');
    }
  }

  const before = elements(into);
  for (const e of from.entries) {
    const mine = into.entries.find((x) => x.dot === e.dot);
    const ours = status(mine);
    const theirs = status(e);
    const probe = { text: entryName(e), at: eid(f, e.dot) };
    out.comparisons++;
    if (loud) {
      rec.mark(eid(f, e.dot), 'key');
      if (mine) rec.mark(eid(t, e.dot), 'compare');
      rec.line('has', 'gone');
      rec.vars({ self: T, dot: e.dot, e: e.elem, 'dot in self.entries': !!mine, 'dot in other.removed': e.removed });
      const verdict = !mine ? (e.removed ? `copy it in, removed` : `copy it in`) : e.removed && !mine.removed ? `remove it at ${T} too` : mine.removed && !e.removed ? `stays removed` : 'same, keep';
      rec.compare(`${F}: ${theirs}`, ours === theirs ? '=' : '≠', `${T}: ${ours}`, verdict, {
        probe,
        message: !mine
          ? `${T} has never seen dot ${e.dot}. Copy the entry in${e.removed ? `, with its tombstone, so ${T} also knows it was removed` : ''}.`
          : e.removed && !mine.removed
            ? `${F} has seen dot ${e.dot} removed and ${T} has not. A remove only ever covers a dot after it was added, so the tombstone wins for this dot.`
            : mine.removed && !e.removed
              ? `${T} has already seen dot ${e.dot} removed. ${F} has not heard yet, so its live copy is older news. ${T} keeps the tombstone.`
              : `Both hold dot ${e.dot} as ${ours}. Nothing to do.`,
      });
    } else rec.count('comparisons');
    if (!mine) {
      const fresh: Entry = { dot: e.dot, elem: e.elem, removed: e.removed, from: eid(f, e.dot) };
      into.entries.push(fresh);
      out.copied.push(e.dot);
      rec.count('writes');
      if (loud) {
        const node = eid(t, e.dot);
        rec.unmark(eid(f, e.dot));
        if (!e.removed) rec.mark(node, 'ok');
        rec.line('copy');
        rec.vars({ self: T, dot: e.dot, e: e.elem, 'dot in self.entries': true, 'dot in other.removed': e.removed });
        const lostHere = !e.removed && !before.includes(e.elem) && into.entries.some((x) => x.elem === e.elem && x.removed && x.dot !== e.dot);
        rec.step(
          e.removed
            ? `${T} now holds ${e.dot} as a tombstone. It reads the same as before, but it will pass the removal on.`
            : lostHere
              ? `${e.elem} is back in ${T}'s set. ${T} removed ${e.elem} earlier, but that remove covered only the dots ${T} had seen. ${e.dot} is a dot ${T} never saw, so no remove covers it: the add wins.`
              : `${T} now holds (${e.elem}, ${e.dot}) and reads ${setText(elements(into))}.`,
          { probe: { text: entryName(e), at: node } },
        );
      }
    } else if (e.removed && !mine.removed) {
      mine.removed = true;
      out.tombed.push(e.dot);
      rec.count('writes');
      if (loud) {
        rec.mark(eid(t, e.dot), 'bad');
        rec.line('tomb_in');
        rec.vars({ self: T, dot: e.dot, e: e.elem, 'dot in self.entries': true, 'dot in other.removed': true });
        const still = elements(into).includes(e.elem);
        rec.step(
          `${T} marks ${e.dot} removed. ` +
            (still
              ? `But ${T} still reads ${e.elem}: another dot of it is live, from an add the remover never saw.`
              : `${e.elem} has no live dot left at ${T}, so ${T} no longer reads it.`),
          { probe: { text: entryName(e), at: eid(t, e.dot) } },
        );
      }
    }
    if (loud) {
      rec.unmark(eid(f, e.dot));
      rec.unmark(eid(t, e.dot));
    }
  }
  return out;
}

/** One replica merges another's whole state. Returns what changed. */
export function merge(s: CrdtState, intoRaw: number | string, fromRaw: number | string, rec: Rec): MergeResult | null {
  const t = asReplica(intoRaw);
  const f = asReplica(fromRaw);
  rec.vars();
  rec.line('start');
  if (t === null || f === null) {
    rec.step(BAD_REPLICA);
    return null;
  }
  const T = NAMES[t];
  const F = NAMES[f];
  if (t === f) {
    rec.step(`${T} merging with itself changes nothing: merge is idempotent, and a state joined with itself is the same state. Pick two different replicas.`);
    return null;
  }
  const into = s.replicas[t];
  const from = s.replicas[f];
  const tv = value(into);
  const fv = value(from);
  rec.vars({ self: T, other: F });
  const ahead = (x: Replica, y: Replica) => (['p', 'n'] as const).some((w) => x[w].some((v, j) => v > y[w][j]));
  const concurrent = ahead(into, from) && ahead(from, into);
  rec.step(
    `${T} merges ${F}'s state. ${F} sends everything it holds, and ${T} combines it with its own one slot and one entry at a time. Each step can only move a number up or add an entry or a tombstone, so nothing ${T} knows is ever lost.`,
    { probe: { text: `${F}→${T}`, at: rid(t) } },
  );
  const res = join(s, t, f, rec, true);
  rec.clearMarks();
  rec.line('value', 'read');
  rec.vars({ self: T, other: F, 'value()': value(into), 'elements()': elements(into) });
  const changes = res.slots.length + res.copied.length + res.tombed.length;
  const same = canonical(into) === canonical(from);
  const parts: string[] = [];
  if (!changes) parts.push(`Nothing changed: ${T} already knew everything ${F} knows. Merging the same state again, or an older one, is harmless. That is idempotence, and it is why a lost or repeated merge message does no damage.`);
  else parts.push(`${T} merged ${F}: ${plural(changes, 'change')} from ${plural(res.comparisons, 'comparison')}. ${T} reads ${minus(value(into))} and ${setText(elements(into))}.`);
  if (concurrent) {
    parts.push(
      `${T} and ${F} had both counted updates the other had not seen. Had each kept only a total, last write wins would have kept ${minus(tv)} or ${minus(fv)} and silently dropped the other's ${tv === fv ? 'update' : 'updates'}. One slot per replica keeps both, so the merged ${minus(value(into))} counts every one.`,
    );
  }
  if (same) parts.push(`${T} and ${F} now hold identical state.`);
  else if (changes) parts.push(`${F} has not changed: a merge is one way. ${F} needs to merge ${T} to catch up.`);
  rec.step(parts.join(' '));
  return res;
}

/** Merge every replica into every other, in a fixed order. Returns the number of merges that changed something. */
export function sync(s: CrdtState, rec: Rec): number {
  rec.vars({ replicas: [...NAMES] });
  rec.line('pair');
  rec.step(`Sync: every replica merges every other one, A from B, A from C, then B, then C. 6 merges. Each is shown as one frame here; the comparisons are counted.`);
  let changed = 0;
  for (let t = 0; t < REPLICAS; t++) {
    for (let f = 0; f < REPLICAS; f++) {
      if (t === f) continue;
      const T = NAMES[t];
      const F = NAMES[f];
      const res = join(s, t, f, rec, false);
      const n = res.slots.length + res.copied.length + res.tombed.length;
      if (n) changed++;
      if (!rec.recording) continue;
      rec.vars({ replicas: [...NAMES], a: T, b: F });
      for (const sl of res.slots) {
        const which = sl.startsWith('P') ? pid : nid;
        rec.markCell(which(t), NAMES.indexOf(sl[2] as (typeof NAMES)[number]), 'ok');
      }
      for (const d of res.copied) if (!s.replicas[t].entries.find((e) => e.dot === d)!.removed) rec.mark(eid(t, d), 'ok');
      for (const d of res.tombed) rec.mark(eid(t, d), 'bad');
      const what = [
        ...res.slots,
        ...(res.copied.length ? [`${res.copied.join(', ')} copied in`] : []),
        ...(res.tombed.length ? [`${res.tombed.join(', ')} removed`] : []),
      ];
      const back = res.copied.filter((d) => {
        const e = s.replicas[t].entries.find((x) => x.dot === d)!;
        return !e.removed && s.replicas[t].entries.some((x) => x.elem === e.elem && x.removed && x.dot !== d);
      });
      rec.step(
        n
          ? `${T} merges ${F}: ${what.join('; ')}. ${T} reads ${minus(value(s.replicas[t]))} and ${setText(elements(s.replicas[t]))}.` +
              (back.length ? ` ${back.join(', ')} ${back.length === 1 ? 'is a dot' : 'are dots'} that no remove ever saw, so ${back.length === 1 ? 'its element stays' : 'their elements stay'} even though an older dot was removed: add wins.` : '')
          : `${T} merges ${F}: nothing new. ${T} already held everything ${F} holds, so the merge changed nothing.`,
        { probe: { text: `${F}→${T}`, at: rid(t) } },
      );
      rec.clearMarks();
    }
  }
  const r = s.replicas[0];
  rec.vars({ replicas: [...NAMES] });
  rec.line('pair');
  rec.step(
    `All three replicas hold identical state, and all read ${minus(value(r))} and ${setText(elements(r))}. ${plural(changed, 'merge')} of 6 changed something; the rest found nothing new. The order of merges did not matter, and repeating them would change nothing.`,
  );
  return changed;
}

/** Drop the dots every replica has seen removed. Returns how many dots were dropped. */
export function collect(s: CrdtState, rec: Rec): number {
  const first = s.replicas[0];
  const tombs = first.entries.filter((e) => e.removed);
  rec.vars({ first: 'A' });
  rec.line('each_tomb');
  rec.step(
    tombs.length
      ? `Collect tombstones. A tombstone can only be dropped once every replica has seen it, or a replica that still holds the dot live would hand it back at the next merge. Check each of A's ${plural(tombs.length, 'tombstone')}.`
      : `Collect tombstones. A holds no tombstones, so no dot has been seen removed by every replica. Nothing can be dropped yet.`,
  );
  let dropped = 0;
  for (const e of tombs) {
    const seen = s.replicas.filter((r) => r.entries.some((x) => x.dot === e.dot && x.removed)).length;
    const probe = { text: entryName(e), at: eid(0, e.dot) };
    for (let i = 0; i < REPLICAS; i++) if (s.replicas[i].entries.some((x) => x.dot === e.dot)) rec.mark(eid(i, e.dot), 'compare');
    rec.line('stable');
    rec.vars({ first: 'A', dot: e.dot, stable: seen === REPLICAS });
    const missing = NAMES.filter((_n, i) => !s.replicas[i].entries.some((x) => x.dot === e.dot && x.removed));
    rec.compare(`removed at ${seen}`, seen === REPLICAS ? '=' : '<', `all ${REPLICAS}`, seen === REPLICAS ? 'drop it everywhere' : `keep: ${missing.join(' and ')} not told yet`, { probe });
    if (seen === REPLICAS) {
      for (let i = 0; i < REPLICAS; i++) rec.mark(eid(i, e.dot), 'bad');
      for (const r of s.replicas) r.entries = r.entries.filter((x) => x.dot !== e.dot);
      dropped++;
      rec.count('writes', REPLICAS);
      rec.line('drop');
      rec.step(`Every replica has seen ${e.dot} removed, so none can bring it back. Delete it at all three. This needs knowledge of every replica, which is why real systems collect slowly, or keep a version vector instead of tombstones.`);
    }
    rec.clearMarks();
  }
  if (tombs.length) {
    rec.vars({ first: 'A' });
    rec.line('drop');
    rec.step(
      dropped
        ? `Dropped ${plural(dropped, 'tombstone')} at every replica. ${plural(allDots(s).size, 'dot')} left in the system. The reads did not change.`
        : `Nothing dropped: no tombstone had reached every replica yet. Sync first, then collect.`,
    );
  }
  return dropped;
}

// ---- layout --------------------------------------------------------------------

const LABEL_W = 36;
const SLOT_W = 40;
const ENTRY_W = 52;
const ENTRY_GAP = 4;
const VALUE_W = 56;
const VEC_W = TRAY_PAD * 2 + SLOT_W * REPLICAS + CELL_GAP * (REPLICAS - 1);
const P_X = LABEL_W + 12;
const N_X = P_X + VEC_W + 12;
const V_X = N_X + VEC_W + 12;
const E_X = V_X + VALUE_W + 26;
const E_END = E_X + MAX_ENTRIES * ENTRY_W + (MAX_ENTRIES - 1) * ENTRY_GAP;
const READ_X = E_END + 12;
const TRAY_H = CELL_H + TRAY_PAD * 2;
/** How far a merge chip such as B→A hangs past the left of the replica's name. */
const CHIP_HANG = Math.ceil((probeWidth('B→A') - LABEL_W) / 2);
/** Each row: the probe's room, the tallest node and the labels under it. */
export const ROW_H = PROBE_H + 16 + TRAY_H + SUB_ROOM + 4;
const HEAD_Y = -TRAY_H / 2 - PROBE_H - 16 - 14;
const BOTTOM = (REPLICAS - 1) * ROW_H + TRAY_H / 2 + SUB_ROOM;
/** Widest read: five two-digit elements. */
const RIGHT = READ_X + cellWidth({ text: setText([10, 20, 30, 40, 50]) });

export function layout(s: CrdtState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  s.replicas.forEach((r, i) => {
    const y = i * ROW_H;
    const R = NAMES[i];
    nodes.push({ id: rid(i), x: LABEL_W / 2, y, cells: [{ text: R, w: LABEL_W }], hue: i });
    for (const [which, x, id] of [['p', P_X, pid(i)], ['n', N_X, nid(i)]] as const) {
      nodes.push({ id, x: x + VEC_W / 2, y, cells: r[which].map((v, j) => ({ text: String(v), sub: `${which.toUpperCase()}${NAMES[j]}`, w: SLOT_W })) });
    }
    nodes.push({ id: vid(i), x: V_X + VALUE_W / 2, y, cells: [{ text: minus(value(r)), sub: `${R} value`, w: VALUE_W }] });
    decor.push({ id: `set${i}`, type: 'band', x: E_X - 6, y: y - CELL_H / 2 - 6, w: E_END - E_X + 12, h: CELL_H + 12 });
    r.entries.forEach((e, k) => {
      nodes.push({
        id: eid(i, e.dot),
        x: E_X + k * (ENTRY_W + ENTRY_GAP) + ENTRY_W / 2,
        y,
        cells: [{ text: String(e.elem), sub: e.dot, subValue: true, w: ENTRY_W }],
        tone: e.removed ? 'bad' : undefined,
        from: e.from,
      });
    });
    const read = setText(elements(r));
    const w = cellWidth({ text: read });
    nodes.push({ id: sid(i), x: READ_X + w / 2, y, cells: [{ text: read, sub: `${R} reads`, w }] });
  });
  decor.push({ id: 'h-p', type: 'label', x: P_X + VEC_W / 2, y: HEAD_Y, text: 'P, increments', anchor: 'middle', strong: true });
  decor.push({ id: 'h-n', type: 'label', x: N_X + VEC_W / 2, y: HEAD_Y, text: 'N, decrements', anchor: 'middle', strong: true });
  decor.push({ id: 'h-set', type: 'label', x: (E_X + E_END) / 2, y: HEAD_Y, text: 'OR-set: element, dot', anchor: 'middle', strong: true });
  // Two empty labels pin the corners, so the view keeps its size as entries come and go.
  decor.push({ id: 'corner-a', type: 'label', x: -CHIP_HANG, y: HEAD_Y - LABEL_MAX, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition ----------------------------------------------------------------

const REPLICA = { name: 'replica', label: 'Replica (a, b or c)', kind: 'word' } as const;
const ELEMENT = { name: 'element', label: 'Element', kind: 'int', min: 0, max: MAX_ELEM } as const;
const pick = <T,>(xs: T[]) => xs[randomInt(0, xs.length - 1)];
const anyReplica = () => NAMES[randomInt(0, REPLICAS - 1)].toLowerCase();

/** A replica that can still count, preferring one that is behind another. */
function suggestBump(s: CrdtState, which: 'p' | 'n'): string {
  const ok = NAMES.filter((_n, i) => s.replicas[i][which][i] < MAX_COUNT);
  return (ok.length ? pick([...ok]) : 'A').toLowerCase();
}

/** Half the time an element some replica is removing, to set up an add-wins race; otherwise a new one. */
function suggestAdd(s: CrdtState): [string, number] {
  const seen = [...new Set(s.replicas.flatMap((r) => r.entries.map((e) => e.elem)))];
  if (seen.length && randomInt(0, 1) === 0) return [anyReplica(), pick(seen)];
  return [anyReplica(), randomInt(1, MAX_ELEM)];
}

/** A replica and an element it holds live, if any. */
function suggestRemove(s: CrdtState): [string, number] {
  const live: [string, number][] = [];
  s.replicas.forEach((r, i) => elements(r).forEach((x) => live.push([NAMES[i].toLowerCase(), x])));
  return live.length ? pick(live) : [anyReplica(), randomInt(1, MAX_ELEM)];
}

/** Two replicas that differ, if any. */
function suggestMerge(s: CrdtState): [string, string] {
  const pairs: [string, string][] = [];
  for (let t = 0; t < REPLICAS; t++) for (let f = 0; f < REPLICAS; f++) if (t !== f && canonical(s.replicas[t]) !== canonical(s.replicas[f])) pairs.push([NAMES[t].toLowerCase(), NAMES[f].toLowerCase()]);
  if (pairs.length) return pick(pairs);
  const t = randomInt(0, REPLICAS - 1);
  return [NAMES[t].toLowerCase(), NAMES[(t + 1) % REPLICAS].toLowerCase()];
}

export const TOUR_ELEM = 42;

const def: StructureDef<CrdtState> = {
  id: 'crdt',
  create: () => create(),
  // Three replicas that have already synced once: they agree on a value of 2 and the set {42, 7}.
  seed: [
    ['inc', 'a'],
    ['inc', 'a'],
    ['inc', 'b'],
    ['dec', 'c'],
    ['add', 'a', TOUR_ELEM],
    ['add', 'c', 7],
    ['sync'],
  ],
  ops: [
    { id: 'inc', label: 'Increment', intent: 'primary', args: [REPLICA], code: ['inc', 'value'], run: (s, [r], rec) => void bump(s, r, 'p', rec), suggest: (s) => [suggestBump(s, 'p')] },
    { id: 'dec', label: 'Decrement', args: [REPLICA], code: ['dec', 'value'], run: (s, [r], rec) => void bump(s, r, 'n', rec), suggest: (s) => [suggestBump(s, 'n')] },
    { id: 'add', label: 'Add', args: [REPLICA, ELEMENT], code: ['add', 'read'], run: (s, [r, x], rec) => void add(s, r, Number(x), rec), suggest: (s) => suggestAdd(s) },
    { id: 'remove', label: 'Remove', args: [REPLICA, ELEMENT], code: ['remove', 'read'], run: (s, [r, x], rec) => void remove(s, r, Number(x), rec), suggest: (s) => suggestRemove(s) },
    {
      id: 'merge',
      label: 'Merge',
      args: [
        { name: 'into', label: 'Into replica', kind: 'word' },
        { name: 'from', label: 'From replica', kind: 'word' },
      ],
      code: ['merge', 'value', 'read'],
      run: (s, [t, f], rec) => void merge(s, t, f, rec),
      suggest: (s) => suggestMerge(s),
    },
    { id: 'sync', label: 'Sync all', args: [], code: ['sync', 'merge'], run: (s, _a, rec) => void sync(s, rec) },
    { id: 'collect', label: 'Collect tombstones', intent: 'danger', args: [], code: ['collect'], run: (s, _a, rec) => void collect(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Slots and entries written' },
  ],
  status: (s) => [
    { label: 'Values A, B, C', value: s.replicas.map((r) => minus(value(r))).join(', ') },
    { label: 'Sets A, B, C', value: s.replicas.map((r) => setText(elements(r))).join(' ') },
    { label: 'Converged', value: converged(s) ? 'yes' : 'no' },
    { label: 'Dots, tombstones', value: `${allDots(s).size}, ${s.replicas[0].entries.filter((e) => e.removed).length} at A` },
  ],
  tour: [
    ['inc', 'a'],
    ['inc', 'b'],
    ['merge', 'a', 'b'],
    ['remove', 'b', TOUR_ELEM],
    ['add', 'a', TOUR_ELEM],
    ['merge', 'b', 'a'],
    ['sync'],
  ],
  source: { python, java },
  info,
};

export default def;
