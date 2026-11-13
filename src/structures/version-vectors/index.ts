import { LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_GAP, CELL_H, TRAY_PAD } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/VersionVectors.java?raw';
import python from './code/version_vectors.py?raw';
import { info } from './info';

/**
 * Multi-leader replication of one key, with version vectors.
 *
 * Three replicas, A, B and C, each accept writes and replicate to each other
 * asynchronously, when asked. The key is a shopping cart: a write reads the
 * cart at one replica, adds or removes one item, and writes it back there.
 *
 * Every version carries a version vector, one counter per replica: entry i
 * says how many of replica i's writes this version has seen. Comparing two
 * vectors entry by entry says whether one version happened before the other
 * or whether they are concurrent. Concurrent versions are kept side by side as
 * siblings, or, under last write wins, one is silently dropped by timestamp.
 *
 * The page keeps a real clock, `now`, that moves one tick per write. Each
 * replica stamps a write with its own wall clock, `now + skew`; C's runs slow.
 */
export interface Version {
  /** v0, v1, ... in the order they were written. Names are never reused. */
  name: string;
  /** Items in the cart, in menu order. */
  cart: string[];
  /** One counter per replica. */
  vv: number[];
  /** Wall-clock timestamp, from the writing replica's clock. */
  ts: number;
  /** Index of the replica that wrote it, or -1 for the starting version. */
  writer: number;
}

export type Policy = 'siblings' | 'lww';

export interface Replica {
  /** One version, or several siblings: versions none of which has seen another. */
  versions: Version[];
}

export interface VVState {
  policy: Policy;
  /** Real time, in ticks. Moves one tick per write. */
  now: number;
  /** Versions written so far, for naming. */
  made: number;
  replicas: Replica[];
  /** Page only: a version on its way into a replica, drawn below what it holds. */
  inbound: { at: number; v: Version; id: string; from: string } | null;
  /** Page only: where a node that is new this frame grows from. */
  origin: Record<string, string>;
  lost: number;
}

export const LETTERS = ['A', 'B', 'C'] as const;
/** How far each replica's wall clock is off real time. C runs 3 ticks slow. */
export const SKEW = [0, 0, -3];
export const MENU = ['egg', 'tea', 'jam', 'fig'] as const;
export const START_TIME = 10;
export const START: Version = { name: 'v0', cart: [], vv: [0, 0, 0], ts: 0, writer: -1 };

export function create(policy: Policy = 'siblings'): VVState {
  return {
    policy,
    now: START_TIME,
    made: 0,
    replicas: LETTERS.map(() => ({ versions: [START] })),
    inbound: null,
    origin: {},
    lost: 0,
  };
}

export type Order = 'equal' | 'ahead' | 'behind' | 'concurrent';

/** Entry by entry: is v ahead of w, behind it, level with it, or concurrent? */
export function order(v: Version, w: Version): Order {
  let ahead = false;
  let behind = false;
  v.vv.forEach((n, i) => {
    if (n > w.vv[i]) ahead = true;
    else if (n < w.vv[i]) behind = true;
  });
  if (ahead && behind) return 'concurrent';
  if (ahead) return 'ahead';
  return behind ? 'behind' : 'equal';
}

/** Last write wins: the later timestamp, ties to the later replica. */
export function newer(v: Version, w: Version): boolean {
  return v.ts !== w.ts ? v.ts > w.ts : v.writer > w.writer;
}

export const clock = (s: VVState, r: number) => s.now + SKEW[r];

export function asReplica(raw: number | string): number | null {
  const i = LETTERS.indexOf(String(raw).trim().toUpperCase() as (typeof LETTERS)[number]);
  return i < 0 ? null : i;
}

export function asItem(raw: number | string): string | null {
  const t = String(raw).trim().toLowerCase();
  return (MENU as readonly string[]).includes(t) ? t : null;
}

export function asPolicy(raw: number | string): Policy | null {
  const t = String(raw).trim().toLowerCase().replace(/[\s_-]/g, '');
  if (t === 'siblings' || t === 'sibling') return 'siblings';
  if (t === 'lww' || t === 'lastwritewins') return 'lww';
  return null;
}

const toggle = (cart: string[], item: string) => MENU.filter((i) => cart.includes(i) !== (i === item));
const union = (carts: string[][]) => MENU.filter((i) => carts.some((c) => c.includes(i)));
export const cartText = (cart: string[]) => (cart.length ? cart.join(' ') : 'empty');
const braces = (cart: string[]) => (cart.length ? `{${cart.join(', ')}}` : 'the empty cart');
export const vec = (vv: number[]) => `[${vv.join(', ')}]`;
const names = (vs: Version[]) => (vs.length === 1 ? vs[0].name : `${vs.slice(0, -1).map((v) => v.name).join(', ')} and ${vs[vs.length - 1].name}`);
const others = (r: number) => LETTERS.filter((_l, i) => i !== r).join(' and ');
const policyName = (p: Policy) => (p === 'lww' ? 'last write wins' : 'keep siblings');
/** Real time a version was written: its timestamp with its writer's skew taken off. */
const realTime = (v: Version) => v.ts - (v.writer >= 0 ? SKEW[v.writer] : 0);

// ---- ids --------------------------------------------------------------------

export const nid = (r: number, v: Version) => `${LETTERS[r].toLowerCase()}-${v.name}`;

/** Tray and cart cell in one tone: the vector cells stay free for comparisons. */
function markVersion(rec: Rec, id: string, tone: Tone): void {
  rec.mark(id, tone);
  rec.markCell(id, 0, tone);
}

/** Every cell too, for a version being dropped. */
function dropVersion(rec: Rec, id: string): void {
  rec.mark(id, 'bad');
  for (let i = 0; i < 4; i++) rec.markCell(id, i, 'bad');
}

function make(s: VVState, cart: string[], vv: number[], r: number): Version {
  s.now += 1;
  s.made += 1;
  return { name: `v${s.made}`, cart, vv, ts: clock(s, r), writer: r };
}

const stampNote = (v: Version) =>
  SKEW[v.writer] === 0
    ? `${LETTERS[v.writer]}'s clock stamps it t${v.ts}.`
    : `${LETTERS[v.writer]}'s clock runs ${-SKEW[v.writer]} ticks slow, so it stamps it t${v.ts} although the real time is ${realTime(v)}.`;

// ---- operations ---------------------------------------------------------------

const ASK_REPLICA = `There are three replicas on this page: a, b and c.`;
const ASK_ITEM = `The cart can hold ${MENU.slice(0, -1).join(', ')} or ${MENU[MENU.length - 1]}. Enter one of those.`;

/** A client reads the cart at one replica, toggles one item and writes it back there. */
export function write(s: VVState, at: number | string, item: number | string, rec: Rec, lead: string[] = []): Version | null {
  s.origin = lead.length ? s.origin : {};
  const L = (...a: string[]) => rec.line(...lead, ...a);
  const r = asReplica(at);
  const it = asItem(item);
  rec.vars();
  L('check');
  if (r === null) {
    rec.step(ASK_REPLICA);
    return null;
  }
  if (it === null) {
    rec.step(ASK_ITEM);
    return null;
  }
  const R = LETTERS[r];
  const rep = s.replicas[r];
  rec.vars({ r: R, item: it, 'len(rep.versions)': rep.versions.length });
  if (rep.versions.length > 1) {
    for (const v of rep.versions) rec.mark(nid(r, v), 'compare');
    L('check', 'refuse');
    rec.step(
      `Replica ${R} holds ${rep.versions.length} siblings, ${names(rep.versions)}. A client that reads ${R} gets all of them, and writing over them would quietly pick a side. Resolve ${R} first, then write.`,
    );
    for (const v of rep.versions) rec.unmark(nid(r, v));
    return null;
  }

  const base = rep.versions[0];
  const baseId = nid(r, base);
  const adds = !base.cart.includes(it);
  rec.mark(baseId, 'path');
  rec.vars({ r: R, item: it, base: base.name });
  L('read');
  rec.step(
    `A client reads the cart at replica ${R}: ${base.name}, ${braces(base.cart)}, vector ${vec(base.vv)}. It ${adds ? `adds ${it}` : `takes ${it} out`} and writes the cart back to ${R}.`,
  );

  const vv = [...base.vv];
  vv[r] += 1;
  const v = make(s, toggle(base.cart, it), vv, r);
  const id = nid(r, v);
  rep.versions.push(v);
  s.origin[id] = baseId;
  markVersion(rec, id, 'key');
  const probe: Probe = { text: v.name, at: id, cell: r + 1 };
  rec.vars({ r: R, item: it, base: base.name, cart: v.cart, vv: v.vv, v: v.name });
  L('cart', 'bump', 'stamp');
  rec.step(
    `New version ${v.name}: ${braces(v.cart)}. Its vector is ${base.name}'s ${vec(base.vv)} with ${R}'s own entry raised by one: ${vec(v.vv)}. ${stampNote(v)}`,
    { probe },
  );

  dropVersion(rec, baseId);
  L('replace');
  rec.step(
    `The client read ${base.name} before writing, so ${v.name} has seen everything ${base.name} had: it is ahead or level on every entry. ${base.name} happened before ${v.name}, and ${v.name} replaces it.`,
    { probe },
  );
  rep.versions = [v];
  rec.unmark(baseId);
  rec.count('writes');

  markVersion(rec, id, 'ok');
  L('written');
  rec.step(
    `Written at ${R} alone. No other replica was asked, which is why a leader can take writes while it is cut off. ${others(r)} still hold what they had until ${R} replicates to them.`,
    { probe },
  );
  rec.unmark(id);
  return v;
}

/**
 * Send every version one replica holds to another. Each one is compared with
 * every version already there, entry by entry. Returns how many were stored.
 */
export function replicate(s: VVState, from: number | string, to: number | string, rec: Rec, lead: string[] = []): number {
  s.origin = lead.length ? s.origin : {};
  const L = (...a: string[]) => rec.line(...lead, ...a);
  const x = asReplica(from);
  const y = asReplica(to);
  rec.vars();
  L('each');
  if (x === null || y === null) {
    rec.step(ASK_REPLICA);
    return 0;
  }
  if (x === y) {
    rec.step(`A replica does not replicate to itself. Choose two different replicas.`);
    return 0;
  }
  const X = LETTERS[x];
  const Y = LETTERS[y];
  const src = s.replicas[x];
  const dst = s.replicas[y];
  const sending = [...src.versions];
  rec.vars({ src: X, dst: Y });
  rec.step(
    `Replicate ${X} to ${Y}. ${X} sends ${sending.length === 1 ? `the one version it holds, ${sending[0].name}` : `all ${sending.length} siblings it holds, ${names(sending)}`}. ${Y} compares each with every version it has, entry by entry.`,
  );

  let stored = 0;
  let pairs = 0;
  const lost: Version[] = [];
  for (const v of sending) {
    const srcId = nid(x, v);
    const clash = dst.versions.some((w) => w.name === v.name);
    const inId = clash ? `${nid(y, v)}-in` : nid(y, v);
    s.inbound = { at: y, v, id: inId, from: srcId };
    rec.clearMarks();
    rec.mark(srcId, 'path');
    markVersion(rec, inId, 'key');
    rec.vars({ src: X, dst: Y, v: v.name, keep: true });
    L('each');
    rec.step(
      `${v.name} arrives at ${Y}: ${braces(v.cart)}, vector ${vec(v.vv)}, stamped t${v.ts}.`,
      { probe: { text: v.name, at: inId } },
    );

    let keep = true;
    for (const w of [...dst.versions]) {
      const wid = nid(y, w);
      pairs++;
      rec.mark(wid, 'compare');
      const aheadOn: string[] = [];
      const behindOn: string[] = [];
      for (let i = 0; i < LETTERS.length; i++) {
        const E = LETTERS[i];
        const a = v.vv[i];
        const b = w.vv[i];
        rec.markCell(wid, i + 1, 'compare');
        rec.markCell(inId, i + 1, 'compare');
        const probe: Probe = { text: v.name, at: wid, cell: i + 1 };
        rec.vars({ v: v.name, w: w.name, mine: a, theirs: b, ahead: aheadOn.length > 0 || a > b, behind: behindOn.length > 0 || a < b });
        const left = `${v.name} ${E}: ${a}`;
        const right = `${w.name} ${E}: ${b}`;
        if (a > b) {
          aheadOn.push(E);
          L('against', 'entry', 'ahead');
          rec.compare(left, '>', right, `${v.name} ahead on ${E}`, {
            probe,
            message: `Entry ${E}: ${v.name} has seen ${a} of ${E}'s writes and ${w.name} only ${b}. ${v.name} knows something ${w.name} does not.`,
          });
        } else if (a < b) {
          behindOn.push(E);
          L('against', 'entry', 'elif', 'behind');
          rec.compare(left, '<', right, `${v.name} behind on ${E}`, {
            probe,
            message: `Entry ${E}: ${v.name} has seen ${a} of ${E}'s writes and ${w.name} ${b}. ${w.name} knows something ${v.name} does not.`,
          });
        } else {
          L('against', 'entry', 'elif');
          rec.compare(left, '=', right, `level on ${E}`, {
            probe,
            message: `Entry ${E}: both have seen ${a} of ${E}'s writes. Level here.`,
          });
        }
        rec.markCell(wid, i + 1, 'idle');
        rec.markCell(inId, i + 1, 'idle');
      }
      const atW: Probe = { text: v.name, at: wid };
      const atIn: Probe = { text: v.name, at: inId };
      const ord = !aheadOn.length ? (behindOn.length ? 'behind' : 'equal') : behindOn.length ? 'concurrent' : 'ahead';
      rec.vars({ v: v.name, w: w.name, ahead: aheadOn.length > 0, behind: behindOn.length > 0, order: ord, keep: !!aheadOn.length });

      if (!aheadOn.length) {
        // Equal or behind: Y already has v, or something that has seen it.
        rec.mark(inId, 'dim');
        rec.markCell(inId, 0, 'dim');
        L('covered', 'known');
        rec.step(
          behindOn.length
            ? `${w.name} is ahead or level on every entry, so it has already seen ${v.name}: ${v.name} happened before ${w.name}. ${Y} drops the old copy. Nothing is lost, because ${w.name} was written by a client that had read it.`
            : `Every entry is level: ${w.name} is ${v.name}, which ${Y} already holds. The copy is dropped.`,
          { probe: atIn },
        );
        keep = false;
        break;
      }
      if (!behindOn.length) {
        dropVersion(rec, wid);
        L('dominates', 'supersede');
        rec.step(
          `${v.name} is ahead or level on every entry, so it has seen everything ${w.name} had: ${w.name} happened before ${v.name}. ${Y} drops ${w.name}. Nothing is lost, because the client that wrote ${v.name} had read it.`,
          { probe: atW },
        );
        dst.versions = dst.versions.filter((u) => u !== w);
        rec.unmark(wid);
        continue;
      }

      // Concurrent: each has seen a write the other has not.
      const why = `${v.name} is ahead on ${aheadOn.join(' and ')}, and ${w.name} is ahead on ${behindOn.join(' and ')}. Each has seen a write the other has not, so neither happened before the other: they are concurrent.`;
      if (s.policy === 'siblings') {
        rec.mark(wid, 'path');
        L('concurrent', 'sibling');
        rec.step(`${why} ${Y} keeps both. Neither may silently overwrite the other.`, { probe: atW });
        continue;
      }
      L('concurrent', 'lww');
      rec.step(`${why} Under last write wins, the wall-clock timestamps decide which one survives.`, { probe: atW });
      const vWins = newer(v, w);
      const [win, lose] = vWins ? [v, w] : [w, v];
      const skewed = realTime(lose) > realTime(win);
      rec.vars({ v: v.name, w: w.name, order: ord, 'v.ts': v.ts, 'w.ts': w.ts, 'newer(v, w)': vWins });
      L('lww');
      rec.compare(`${v.name} t${v.ts}`, v.ts > w.ts ? '>' : v.ts < w.ts ? '<' : '=', `${w.name} t${w.ts}`, `keep ${win.name}, drop ${lose.name}`, {
        probe: atW,
        message:
          `${v.name} was stamped t${v.ts} by ${LETTERS[v.writer]}'s clock and ${w.name} t${w.ts} by ${LETTERS[w.writer]}'s. ` +
          (v.ts === w.ts ? `A tie: the later replica letter wins, ${LETTERS[win.writer]}. ` : `The later stamp wins: ${win.name}. `) +
          (skewed
            ? `But ${LETTERS[lose.writer]}'s clock runs ${-SKEW[lose.writer]} ticks slow: ${lose.name} was really written at ${realTime(lose)}, after ${win.name} at ${realTime(win)}. The newer write loses.`
            : `Without skew this picks the later write, and still throws the other away.`),
      });
      rec.count('lost');
      s.lost++;
      lost.push(lose);
      if (vWins) {
        dropVersion(rec, wid);
        L('lww', 'lost_old');
        rec.step(
          `${w.name}, ${braces(w.cart)}, is dropped from ${Y}. No error and no sibling: its client was told the write succeeded. Once ${v.name} reaches every replica, it is gone everywhere.`,
          { probe: atW },
        );
        dst.versions = dst.versions.filter((u) => u !== w);
        rec.unmark(wid);
        continue;
      }
      dropVersion(rec, inId);
      rec.vars({ v: v.name, w: w.name, order: ord, 'v.ts': v.ts, 'w.ts': w.ts, keep: false });
      L('lww', 'lost_new');
      rec.step(
        `${v.name}, ${braces(v.cart)}, is thrown away at ${Y}. No error and no sibling: its client was told the write succeeded. ${X} keeps it until ${w.name} replicates back and wins there too.`,
        { probe: atIn },
      );
      keep = false;
      break;
    }

    if (keep) {
      dst.versions.push(v);
      s.inbound = null;
      s.origin[inId] = srcId;
      stored++;
      const sibs = dst.versions.length > 1;
      if (sibs) rec.count('siblings');
      markVersion(rec, inId, 'ok');
      rec.vars({ src: X, dst: Y, v: v.name, keep: true });
      L('keep');
      rec.step(
        sibs
          ? `${Y} stores ${v.name} beside ${names(dst.versions.filter((u) => u !== v))}. It now holds ${dst.versions.length} siblings. A read at ${Y} returns all of them, and the client must merge them.`
          : `${Y} stores ${v.name}. It is the only version at ${Y}.`,
        { probe: { text: v.name, at: inId } },
      );
    } else {
      s.inbound = null;
    }
  }

  s.inbound = null;
  rec.clearMarks();
  L('done');
  const held = dst.versions;
  rec.vars({ src: X, dst: Y, 'target.versions': held.map((u) => u.name) });
  rec.step(
    `${Y} now holds ${held.length === 1 ? held[0].name : `${held.length} siblings, ${names(held)}`}. ` +
      `${pairs === 1 ? '1 pair of vectors' : `${pairs} pairs of vectors`} compared, 3 entries each: the cost grows with the number of replicas, not with the data.` +
      (lost.length ? ` Lost: ${lost.map((v) => `${v.name}, ${braces(v.cart)}`).join(' and ')}. Nobody was told.` : ``),
    { probe: { text: sending[sending.length - 1].name, at: nid(y, held[held.length - 1]) } },
  );
  return stored;
}

/** A client reads every sibling at a replica, merges them, and writes one version that has seen them all. */
export function resolve(s: VVState, at: number | string, rec: Rec): Version | null {
  s.origin = {};
  const r = asReplica(at);
  rec.vars();
  rec.line('check');
  if (r === null) {
    rec.step(ASK_REPLICA);
    return null;
  }
  const R = LETTERS[r];
  const rep = s.replicas[r];
  const sibs = [...rep.versions];
  rec.vars({ r: R, sibs: sibs.map((u) => u.name) });
  if (sibs.length < 2) {
    rec.line('check', 'nothing');
    rec.step(
      s.policy === 'lww'
        ? `Replica ${R} holds one version, ${sibs[0].name}. Under last write wins there are never siblings to merge: the timestamps already chose, and threw the rest away.`
        : `Replica ${R} holds one version, ${sibs[0].name}. There are no siblings to merge.`,
    );
    return null;
  }
  for (const v of sibs) rec.mark(nid(r, v), 'path');
  rec.step(
    `A client reads replica ${R} and gets ${sibs.length} siblings, ${names(sibs)}. The database cannot know what the merge should be. The application does: for a cart, keep every item from every sibling.`,
  );

  const vv = [0, 0, 0];
  for (let i = 0; i < LETTERS.length; i++) {
    for (const v of sibs) rec.markCell(nid(r, v), i + 1, 'compare');
    vv[i] = Math.max(...sibs.map((v) => v.vv[i]));
    rec.vars({ r: R, sibs: sibs.map((u) => u.name), i, vv: vv.slice(0, i + 1) });
    rec.line('max');
    rec.step(`Entry ${LETTERS[i]}: max(${sibs.map((v) => v.vv[i]).join(', ')}) = ${vv[i]}. The merged version has seen every write from ${LETTERS[i]} that any sibling had.`);
    for (const v of sibs) rec.markCell(nid(r, v), i + 1, 'idle');
  }
  const cart = union(sibs.map((v) => v.cart));
  for (const v of sibs) rec.markCell(nid(r, v), 0, 'compare');
  rec.vars({ r: R, sibs: sibs.map((u) => u.name), vv, cart });
  rec.line('union');
  rec.step(`Cart: the union of ${sibs.map((v) => braces(v.cart)).join(' and ')} is ${braces(cart)}.`);
  for (const v of sibs) rec.markCell(nid(r, v), 0, 'idle');

  const before = [...vv];
  vv[r] += 1;
  const v = make(s, cart, vv, r);
  const id = nid(r, v);
  rep.versions.push(v);
  s.origin[id] = nid(r, sibs[0]);
  markVersion(rec, id, 'key');
  const probe: Probe = { text: v.name, at: id, cell: r + 1 };
  rec.vars({ r: R, sibs: sibs.map((u) => u.name), vv: v.vv, cart, v: v.name });
  rec.line('bump', 'stamp');
  rec.step(`Raise ${R}'s own entry, since this is a new write at ${R}: ${vec(before)} becomes ${vec(v.vv)}. ${stampNote(v)}`, { probe });

  for (const u of sibs) dropVersion(rec, nid(r, u));
  rec.line('replace');
  rec.step(`${v.name} is ahead or level on every entry against each sibling, so it has seen all of them. It replaces ${names(sibs)}.`, { probe });
  rep.versions = [v];
  for (const u of sibs) rec.unmark(nid(r, u));
  rec.count('writes');

  markVersion(rec, id, 'ok');
  rec.line('merged');
  rec.step(
    `Resolved at ${R}: one version again. When ${R} replicates, ${v.name} replaces any of ${names(sibs)} it meets, because it has seen them all. A merge is a write like any other, so it can itself race with another write.`,
    { probe },
  );
  rec.unmark(id);
  return v;
}

/** Two clients write at two replicas within a tick of each other, then the first replicates to the second. */
export function concurrent(s: VVState, x: number | string, itemX: number | string, y: number | string, itemY: number | string, rec: Rec): number {
  s.origin = {};
  const a = asReplica(x);
  const b = asReplica(y);
  const ia = asItem(itemX);
  const ib = asItem(itemY);
  rec.vars();
  rec.line('first');
  if (a === null || b === null) {
    rec.step(ASK_REPLICA);
    return 0;
  }
  if (a === b) {
    rec.step(`Choose two different replicas: the point is two leaders taking writes at once.`);
    return 0;
  }
  if (ia === null || ib === null) {
    rec.step(ASK_ITEM);
    return 0;
  }
  const busy = [a, b].find((r) => s.replicas[r].versions.length > 1);
  if (busy !== undefined) {
    rec.step(`Replica ${LETTERS[busy]} holds siblings. Resolve it first, so each client reads one cart.`);
    return 0;
  }
  const A = LETTERS[a];
  const B = LETTERS[b];
  rec.vars({ x: A, item_x: ia, y: B, item_y: ib });
  rec.step(
    `Two clients write within a tick of each other: one at ${A} (${ia}), one at ${B} (${ib}). Replication is asynchronous, so neither replica has heard of the other's write when it takes its own.`,
  );
  write(s, A, ia, rec, ['first']);
  write(s, B, ib, rec, ['second']);
  return replicate(s, A, B, rec, ['sync']);
}

/** Page only: switch the conflict policy and put every replica back to v0, so the same writes can be replayed. */
export function setPolicy(s: VVState, raw: number | string, rec: Rec): boolean {
  s.origin = {};
  const p = asPolicy(raw);
  rec.vars({ policy: p ?? String(raw) });
  rec.line('policy');
  if (!p) {
    rec.step(`The policies are siblings and lww (last write wins). Enter one of those.`);
    return false;
  }
  if (p === s.policy) {
    rec.step(`The policy is already ${policyName(p)}. Nothing changes.`);
    return false;
  }
  s.policy = p;
  rec.step(
    p === 'lww'
      ? `Switch to last write wins. When two versions are concurrent, the one with the later wall-clock timestamp is kept and the other is dropped. No sibling ever reaches a client.`
      : `Switch to keep siblings. When two versions are concurrent, both are kept, and the next client to read them must merge.`,
  );
  for (const rep of s.replicas) rep.versions = [START];
  rec.vars({ policy: p, 'rep.versions': ['v0'] });
  rec.line('reset');
  rec.step(
    `So the same writes can be replayed under the new policy, every replica goes back to v0, the empty cart. The clocks keep running. A real cluster is not reset like this; it is a convenience of the page.`,
  );
  return true;
}

// ---- layout -----------------------------------------------------------------

const CART_W = 158;
const VV_W = 36;
const NODE_W = TRAY_PAD * 2 + CART_W + LETTERS.length * (VV_W + CELL_GAP);
const NODE_H = CELL_H + TRAY_PAD * 2;
const GAP = 24;
const COL = NODE_W + GAP;
/** Room above each version for the probe chip. */
const CHIP = PROBE_H + 8;
export const ROW = NODE_H + SUB_ROOM + CHIP;
/** Three siblings and one version on its way in. */
export const MAX_ROWS = 4;
const HEAD_Y = -NODE_H / 2 - CHIP - 12;
const TOP = HEAD_Y - LABEL_MAX * 0.65;
const BOTTOM = (MAX_ROWS - 1) * ROW + NODE_H / 2 + SUB_ROOM;
export const SCENE_W = (LETTERS.length - 1) * COL + NODE_W;

const colX = (r: number) => r * COL + NODE_W / 2;

function header(s: VVState, r: number): string {
  const c = `Replica ${LETTERS[r]}, clock ${clock(s, r)}`;
  return SKEW[r] ? `${c}, ${-SKEW[r]} slow` : c;
}

function versionNode(v: Version, id: string, x: number, y: number, from?: string): SceneNode {
  const cells: Cell[] = [
    { text: cartText(v.cart), w: CART_W, sub: v.writer < 0 ? `${v.name}, start` : `${v.name}, ${LETTERS[v.writer]} at t${v.ts}`, subValue: true },
    ...v.vv.map((n, i) => ({ text: String(n), w: VV_W, sub: LETTERS[i] })),
  ];
  return { id, x, y, cells, from };
}

export function layout(s: VVState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  s.replicas.forEach((rep, r) => {
    const x = colX(r);
    decor.push({ id: `head-${r}`, type: 'label', x, y: HEAD_Y, text: header(s, r), anchor: 'middle', strong: true });
    const list = rep.versions.map((v) => ({ v, id: nid(r, v) }));
    if (s.inbound && s.inbound.at === r) list.push({ v: s.inbound.v, id: s.inbound.id });
    list.forEach((e, i) => nodes.push(versionNode(e.v, e.id, x, i * ROW, s.origin[e.id] ?? (s.inbound?.id === e.id ? s.inbound.from : undefined))));
  });
  // Two empty labels pin the corners, so the view keeps its size as siblings come and go.
  decor.push({ id: 'corner-a', type: 'label', x: 0, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: SCENE_W, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------------

const REPLICA = (label: string, name = 'replica') => ({ name, label, kind: 'word' }) as const;
const ITEM = (name = 'item') => ({ name, label: 'Item (egg, tea, jam or fig)', kind: 'word' }) as const;
const lower = (r: number) => LETTERS[r].toLowerCase();

/** A version at x that y has not seen yet, if there is one. */
function behindPairs(s: VVState): [number, number][] {
  const out: [number, number][] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      if (x === y) continue;
      const fresh = s.replicas[x].versions.some((v) => !s.replicas[y].versions.some((w) => ['equal', 'behind'].includes(order(v, w))));
      if (fresh) out.push([x, y]);
    }
  }
  return out;
}

function suggestReplicate(s: VVState): string[] {
  const pairs = behindPairs(s);
  if (pairs.length) {
    const [x, y] = pick(pairs);
    return [lower(x), lower(y)];
  }
  const x = randomInt(0, 2);
  return [lower(x), lower((x + randomInt(1, 2)) % 3)];
}

function singles(s: VVState): number[] {
  return [0, 1, 2].filter((r) => s.replicas[r].versions.length === 1);
}

function suggestWrite(s: VVState): string[] {
  const ok = singles(s);
  return [lower(ok.length ? pick(ok) : randomInt(0, 2)), pick(MENU)];
}

function suggestConcurrent(s: VVState): string[] {
  const ok = singles(s);
  const [x, y] = ok.length >= 2 ? [...ok].sort(() => Math.random() - 0.5) : [1, 2];
  const ix = pick(MENU);
  const iy = pick(MENU.filter((i) => i !== ix));
  return [lower(x), ix, lower(y), iy];
}

function suggestResolve(s: VVState): string[] {
  const busy = [0, 1, 2].filter((r) => s.replicas[r].versions.length > 1);
  return [lower(busy.length ? pick(busy) : randomInt(0, 2))];
}

const def: StructureDef<VVState> = {
  id: 'version-vectors',
  params: [
    {
      id: 'policy',
      label: 'Starting policy',
      default: 0,
      options: [
        { value: 0, label: 'Keep siblings' },
        { value: 1, label: 'Last write wins' },
      ],
    },
  ],
  create: (params) => create(params.policy === 1 ? 'lww' : 'siblings'),
  // Every replica holds v1, {egg}, so the tour starts from one agreed cart.
  seed: [
    ['write', 'a', 'egg'],
    ['replicate', 'a', 'b'],
    ['replicate', 'a', 'c'],
  ],
  ops: [
    {
      id: 'write',
      label: 'Write',
      intent: 'primary',
      args: [REPLICA('Replica (a, b or c)'), ITEM()],
      code: ['write', 'stamp'],
      run: (s, [r, item], rec) => void write(s, r, item, rec),
      suggest: suggestWrite,
    },
    {
      id: 'replicate',
      label: 'Replicate',
      args: [REPLICA('From (a, b or c)', 'from'), REPLICA('To (a, b or c)', 'to')],
      code: ['replicate', 'compare', 'newer'],
      run: (s, [x, y], rec) => void replicate(s, x, y, rec),
      suggest: suggestReplicate,
    },
    {
      id: 'concurrent',
      label: 'Concurrent writes',
      args: [REPLICA('First replica', 'first'), ITEM('firstItem'), REPLICA('Second replica', 'second'), ITEM('secondItem')],
      code: ['concurrent', 'write', 'stamp', 'replicate', 'compare', 'newer'],
      run: (s, [x, ix, y, iy], rec) => void concurrent(s, x, ix, y, iy, rec),
      suggest: suggestConcurrent,
    },
    {
      id: 'resolve',
      label: 'Resolve',
      args: [REPLICA('Replica (a, b or c)')],
      code: ['resolve', 'stamp'],
      run: (s, [r], rec) => void resolve(s, r, rec),
      suggest: suggestResolve,
    },
    {
      id: 'policy',
      label: 'Switch policy',
      intent: 'danger',
      args: [{ name: 'policy', label: 'Policy (siblings or lww)', kind: 'word' }],
      code: ['set_policy'],
      run: (s, [p], rec) => void setPolicy(s, p, rec),
      suggest: (s) => [s.policy === 'lww' ? 'siblings' : 'lww'],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Versions written' },
    { key: 'siblings', label: 'Siblings kept' },
    { key: 'lost', label: 'Writes lost' },
  ],
  status: (s) => [
    { label: 'Policy', value: policyName(s.policy) },
    ...s.replicas.map((rep, r) => ({
      label: `Replica ${LETTERS[r]}`,
      value: rep.versions.length === 1 ? `${rep.versions[0].name} ${vec(rep.versions[0].vv)}` : `${rep.versions.length} siblings: ${rep.versions.map((v) => v.name).join(', ')}`,
    })),
  ],
  tour: [
    ['write', 'a', 'tea'],
    ['replicate', 'a', 'b'],
    ['concurrent', 'b', 'jam', 'c', 'fig'],
    ['resolve', 'c'],
    ['policy', 'lww'],
    ['concurrent', 'b', 'jam', 'c', 'fig'],
  ],
  source: { python, java },
  info,
};

export default def;
