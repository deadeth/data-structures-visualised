import './design.css';
import { h, tableRoles } from '../core/dom';
import type { Component, Design, Flow } from '../designs/types';

const NS = 'http://www.w3.org/2000/svg';
const W = 1120;
const H = 590;
const SPEEDS = [0.5, 1, 2] as const;
/** Token travel at 1x, in diagram units a second. */
const PACE = 260;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (cls) e.setAttribute('class', cls);
  return e;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ICON = {
  restart: 'M6 5v14M19 5l-9 7 9 7V5z',
  back: 'M15 5l-8 7 8 7V5z',
  play: 'M8 5l11 7-11 7V5z',
  pause: 'M8 5v14M16 5v14',
  next: 'M9 5l8 7-8 7V5z',
};

function icon(name: keyof typeof ICON): SVGSVGElement {
  const svg = el('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' });
  svg.append(el('path', { d: ICON[name], fill: name === 'pause' || name === 'restart' ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

/**
 * A system design as an interactive diagram: a guided tour that follows one
 * URL round the loop, and boxes that open to explain themselves.
 */
export async function mountDesign(host: HTMLElement, design: Design): Promise<() => void> {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const flowById = new Map(design.flows.map((f) => [f.id, f]));

  // ---- diagram ---------------------------------------------------------------
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `${design.name}: components and the flows between them` }, 'hld-svg');
  const defs = el('defs');
  for (const [id, cls] of [['hld-arrow', 'hld-head'], ['hld-arrow-live', 'hld-head live'], ['hld-arrow-linked', 'hld-head linked']] as const) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0,0 L10,5 L0,10 z' }, cls));
    defs.append(m);
  }
  svg.append(defs);

  const f = design.frame;
  svg.append(el('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: 16 }, 'hld-frame'));
  const frameLabel = el('text', { x: f.x + 16, y: f.y + 24 }, 'hld-frame-label');
  frameLabel.textContent = f.label;
  svg.append(frameLabel);

  const flowEls = new Map<string, SVGPathElement>();
  const flowLayer = el('g');
  const labelLayer = el('g');
  for (const fl of design.flows) {
    const p = el('path', { d: fl.d }, `hld-flow${fl.dashed ? ' dashed' : ''}`);
    flowEls.set(fl.id, p);
    flowLayer.append(p);
    if (fl.label && fl.lx != null && fl.ly != null) {
      const t = el('text', { x: fl.lx, y: fl.ly, 'text-anchor': 'middle' }, 'hld-flow-label');
      t.textContent = fl.label;
      t.dataset.flow = fl.id;
      labelLayer.append(t);
    }
  }
  svg.append(flowLayer, labelLayer);

  const nodeEls = new Map<string, SVGGElement>();
  for (const c of design.components) {
    const w = c.w ?? 156;
    const hh = c.h ?? 54;
    const g = el('g', { transform: `translate(${c.x - w / 2},${c.y - hh / 2})`, tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': `${c.name}. ${c.tech}. Show details.` }, `hld-node kind-${c.kind}`);
    g.append(el('rect', { width: w, height: hh, rx: c.kind === 'input' ? 27 : 10 }, 'hld-box'));
    if (c.kind === 'store') g.append(el('path', { d: `M10,${hh - 7} H${w - 10}` }, 'hld-shelf'));
    const top = c.lines ? 26 : hh / 2 - 3;
    const name = el('text', { x: w / 2, y: top, 'text-anchor': 'middle' }, 'hld-name');
    name.textContent = c.name;
    const tech = el('text', { x: w / 2, y: top + 18, 'text-anchor': 'middle' }, 'hld-tech');
    tech.textContent = c.tech;
    g.append(name, tech);
    (c.lines ?? []).forEach((line, i) => {
      const t = el('text', { x: 16, y: top + 42 + i * 18 }, 'hld-line');
      t.textContent = line;
      g.append(t);
    });
    g.addEventListener('click', () => select(c.id, true));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        select(c.id, true);
      }
    });
    nodeEls.set(c.id, g);
    svg.append(g);
  }

  // The thing being followed: one URL, drawn in the colour this site keeps for the followed key.
  const token = el('g', { 'aria-hidden': 'true' }, 'hld-token');
  const tokenBox = el('rect', { y: -13, height: 26, rx: 13 });
  const tokenText = el('text', { y: 5, 'text-anchor': 'middle' });
  token.append(tokenBox, tokenText);
  token.style.display = 'none';
  svg.append(token);

  const canvas = h('div.hld-canvas', null);
  canvas.append(svg);

  // ---- tour bar ----------------------------------------------------------------
  const stepTitle = h('h2.hld-step-title', null, 'Take the tour, or open any box');
  const stepText = h('p.hld-step-text', null, design.blurb);
  const status = h('p.visually-hidden', { role: 'status', 'aria-live': 'polite' });
  const readout = h('div.hld-readout', null, stepTitle, stepText, status);

  const playLabel = h('span', null, 'Play the tour');
  const btn = (name: keyof typeof ICON, label: string, fn: () => void) => h('button.hld-icon', { type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(name));
  const restartBtn = btn('restart', 'Back to the start', () => go(0, true));
  const backBtn = btn('back', 'Previous step', () => go(step - 1, true));
  const nextBtn = btn('next', 'Next step', () => go(step + 1, true));
  const playBtn = h('button.hld-play', { type: 'button', onclick: () => toggle() }, icon('play'), playLabel);
  const counter = h('span.hld-count', null, `${design.tour.length} steps`);
  const exploreBtn = h('button.hld-quiet', { type: 'button', onclick: () => leaveTour() }, 'Leave the tour');
  const speedBtns: HTMLButtonElement[] = [];
  const speedGroup = h('div.hld-speed', { role: 'group', 'aria-label': 'Tour speed' }, h('span', null, 'Speed'));
  for (const s of SPEEDS) {
    const b = h('button', { type: 'button', 'aria-pressed': String(s === 1), onclick: () => setSpeed(s) }, `${s}×`) as HTMLButtonElement;
    speedBtns.push(b);
    speedGroup.append(b);
  }
  const transport = h('div.hld-transport', null, h('div.hld-nav', null, restartBtn, backBtn, playBtn, nextBtn), counter, exploreBtn, speedGroup);

  // ---- detail ------------------------------------------------------------------
  const index = h('div.hld-index', { role: 'group', 'aria-label': 'Components' });
  const indexBtns = new Map<string, HTMLButtonElement>();
  for (const c of design.components) {
    const b = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => select(c.id, false) }, c.name) as HTMLButtonElement;
    indexBtns.set(c.id, b);
    index.append(b);
  }
  const detailBody = h('div.hld-detail-body', null);
  const detail = h('section.hld-detail', { 'aria-label': 'Component details', tabIndex: -1 }, h('h2', null, 'Components'), index, detailBody);

  const stage = h('section.hld', { 'aria-label': 'Interactive design diagram' }, readout, transport, canvas);

  // ---- written sections ------------------------------------------------------------
  const list = (items: string[]) => h('ul', null, items.map((t) => h('li', null, t)));
  const table = (head: string[], rows: string[][], cls: string) =>
    h(
      'div.table-wrap', null,
      // `stack` is the site's rule for restacking a table into labelled blocks on a phone.
      tableRoles(
        h(
          `table.${cls}.stack`, null,
          h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows.map((r) => h('tr', null, r.map((t, i) => (i === 0 ? h('th', { scope: 'row' }, t) : h('td', { 'data-label': head[i] }, t)))))),
        ),
      ),
    );
  const notes = h(
    'div.notes', null,
    ...design.brief.map((b) => h('section.note', null, h('h2', null, b.heading), list(b.points))),
    h('section.note.wide', null, h('h2', null, 'Numbers to have ready'), table(['Quantity', 'Assumption', 'Result'], design.numbers.map((n) => [n.what, n.assumption, n.result]), 'hld-table')),
    h(
      'section.note.wide', null,
      h('h2', null, 'Three versions of the question'),
      h('div.hld-framings', null, design.framings.map((x) => h('div', null, h('h3', null, x.name), h('p.hld-scale', null, x.scale), h('p', null, x.shape)))),
    ),
    h('section.note.wide', null, h('h2', null, 'Decisions worth defending'), table(['Choice', 'One way', 'The other way', 'The call here'], design.decisions.map((d) => [d.choice, d.a, d.b, d.call]), 'hld-table')),
    h('section.note.wide', null, h('h2', null, 'Failure drills'), h('dl.hld-drills', null, design.drills.flatMap((d) => [h('dt', null, d.name), h('dd', null, d.what)]))),
    h('section.note.wide.interview', null, h('h2', null, 'Say this in the interview'), list(design.interview)),
    h(
      'section.note.wide', null,
      h('h2', null, 'Sources'),
      h('ul.hld-sources', null, design.sources.map((s) => h('li', null, s.href ? h('a', { href: s.href, rel: 'noopener' }, s.label) : h('span.hld-source', null, s.label), ` ${s.note}`))),
    ),
  );

  const page = h('article.design', null, h('header.page-head', null, h('h1', null, design.name), h('p.lede', null, design.blurb)), stage, detail, notes);
  host.append(page);

  // ---- state ---------------------------------------------------------------------
  let step = -1;
  let playing = false;
  let speed = 1;
  let selected: string | null = null;
  let raf = 0;
  let timer = 0;
  let alive = true;

  function renderDetail(c: Component | null): void {
    if (!c) {
      detailBody.replaceChildren(h('p.hld-hint', null, 'Select a box in the diagram, or a name above, to see what it does, why it is separate, how it fails and what you could use instead.'));
      return;
    }
    const alt = (a: Component['alternatives'][number]) =>
      h(
        `li${a.chosen ? '.chosen' : ''}`, null,
        h('p.hld-alt-name', null, a.name, a.chosen ? h('span.hld-used', null, 'used here') : null),
        h('p', null, h('span.hld-k', null, 'For: '), a.good),
        h('p', null, h('span.hld-k', null, 'Against: '), a.cost),
      );
    detailBody.replaceChildren(
      h('div.hld-detail-head', null, h('h3', null, c.name), h('p.hld-detail-tech', null, c.tech)),
      h(
        'div.hld-detail-grid', null,
        h(
          'div', null,
          h('h4', null, 'What it does'), h('p', null, c.what),
          h('h4', null, 'Why it is its own box'), h('p', null, c.why),
          c.numbers?.length ? h('h4', null, 'Numbers') : null,
          c.numbers?.length ? list(c.numbers) : null,
          h('h4', null, 'When it fails'), h('p', null, c.fails),
        ),
        h('div', null, h('h4', null, 'Alternatives'), h('ul.hld-alts', null, c.alternatives.map(alt))),
      ),
      h('p.hld-say', null, h('span.hld-k', null, 'Say: '), c.say),
      ...(c.see?.length
        ? [h('p.hld-see', null, 'The data structure inside: ', c.see.flatMap((s, i) => [i ? ', ' : '', h('a', { href: `#/s/${s.id}` }, s.label)]))]
        : []),
    );
  }

  function select(id: string | null, fromDiagram: boolean): void {
    if (playing) pause();
    selected = selected === id ? null : id;
    for (const [nid, g] of nodeEls) {
      g.classList.toggle('selected', nid === selected);
      g.setAttribute('aria-pressed', String(nid === selected));
    }
    for (const [nid, b] of indexBtns) b.setAttribute('aria-pressed', String(nid === selected));
    paintFlows();
    renderDetail(selected ? byId.get(selected)! : null);
    if (selected && fromDiagram) {
      // Bring the explanation into view without losing the diagram entirely.
      detail.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function paintFlows(): void {
    const live = new Set(step >= 0 ? design.tour[step].path.map((p) => p.replace(/^</, '')) : []);
    for (const fl of design.flows) {
      const p = flowEls.get(fl.id)!;
      const linked = selected != null && (fl.from === selected || fl.to === selected);
      p.classList.toggle('live', live.has(fl.id));
      p.classList.toggle('linked', linked && !live.has(fl.id));
    }
    for (const t of Array.from(labelLayer.children) as SVGTextElement[]) {
      const fl = flowById.get(t.dataset.flow!) as Flow;
      t.classList.toggle('live', live.has(fl.id) || (selected != null && (fl.from === selected || fl.to === selected)));
    }
  }

  function sync(): void {
    const inTour = step >= 0;
    const s = inTour ? design.tour[step] : null;
    stepTitle.textContent = s ? s.title : 'Take the tour, or open any box';
    stepText.textContent = s ? s.text : design.blurb;
    counter.textContent = inTour ? `Step ${step + 1} of ${design.tour.length}` : `${design.tour.length} steps`;
    const focus = new Set(s?.focus ?? []);
    for (const [id, g] of nodeEls) {
      g.classList.toggle('lit', focus.has(id));
      g.classList.toggle('quiet', inTour && !focus.has(id));
    }
    stage.classList.toggle('touring', inTour);
    const atEnd = step === design.tour.length - 1;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'), playLabel);
    playLabel.textContent = playing ? 'Pause' : !inTour ? 'Play the tour' : atEnd ? 'Replay' : 'Play';
    restartBtn.disabled = backBtn.disabled = step <= 0;
    nextBtn.disabled = atEnd;
    exploreBtn.hidden = !inTour;
    paintFlows();
  }

  function place(x: number, y: number, label: string): void {
    const w = Math.max(44, label.length * 9.2 + 22);
    tokenBox.setAttribute('x', String(-w / 2));
    tokenBox.setAttribute('width', String(w));
    tokenText.textContent = label;
    token.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    token.style.display = '';
    // On a narrow screen the diagram scrolls sideways: keep the token in view.
    if (canvas.scrollWidth > canvas.clientWidth + 1) {
      const scale = svg.getBoundingClientRect().width / W;
      const px = x * scale;
      const margin = Math.min(140, canvas.clientWidth / 3);
      if (px < canvas.scrollLeft + margin) canvas.scrollLeft = Math.max(0, px - margin);
      else if (px > canvas.scrollLeft + canvas.clientWidth - margin) canvas.scrollLeft = px - canvas.clientWidth + margin;
    }
  }

  /** Where the token rests when a step has no path: beside the first box in focus. */
  function restAt(id: string): { x: number; y: number } {
    const c = byId.get(id)!;
    return { x: c.x, y: c.y - (c.h ?? 54) / 2 - 18 };
  }

  function run(i: number, animate: boolean): void {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    const s = design.tour[i];
    const label = s.token ?? 'URL';
    const segs = s.path.map((p) => ({ el: flowEls.get(p.replace(/^</, ''))!, back: p.startsWith('<') }));
    const lens = segs.map((sg) => sg.el.getTotalLength());
    const total = lens.reduce((a, b) => a + b, 0);
    const dwell = () => {
      if (!playing) return;
      const read = Math.min(11000, Math.max(4200, s.text.length * 42)) / speed;
      timer = window.setTimeout(() => {
        if (!alive || !playing) return;
        if (i < design.tour.length - 1) go(i + 1, false);
        else pause();
      }, read);
    };
    if (!segs.length) {
      const r = restAt(s.focus[0]);
      place(r.x, r.y, label);
      dwell();
      return;
    }
    const end = () => {
      const last = segs[segs.length - 1];
      const pt = last.el.getPointAtLength(last.back ? 0 : lens[lens.length - 1]);
      place(pt.x, pt.y, label);
    };
    if (!animate || reducedMotion()) {
      end();
      dwell();
      return;
    }
    const ms = Math.max(700, (total / (PACE * speed)) * 1000);
    const t0 = performance.now();
    const tick = (now: number) => {
      if (!alive) return;
      const k = Math.min(1, (now - t0) / ms);
      // Ease in and out over the whole trip, then find which segment that lands in.
      const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      let d = eased * total;
      let n = 0;
      while (n < segs.length - 1 && d > lens[n]) d -= lens[n++];
      const pt = segs[n].el.getPointAtLength(segs[n].back ? lens[n] - d : d);
      place(pt.x, pt.y, label);
      if (k < 1) raf = requestAnimationFrame(tick);
      else dwell();
    };
    raf = requestAnimationFrame(tick);
  }

  function go(i: number, manual: boolean): void {
    if (i < 0 || i >= design.tour.length) return;
    step = i;
    sync();
    run(i, true);
    if (manual && !playing) status.textContent = `Step ${i + 1} of ${design.tour.length}. ${design.tour[i].title}. ${design.tour[i].text}`;
  }

  function pause(): void {
    playing = false;
    clearTimeout(timer);
    sync();
  }

  function toggle(): void {
    if (playing) {
      pause();
      return;
    }
    playing = true;
    if (step < 0 || step === design.tour.length - 1) {
      go(0, false);
      stage.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    } else {
      sync();
      run(step, false);
    }
  }

  function leaveTour(): void {
    playing = false;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    step = -1;
    token.style.display = 'none';
    sync();
  }

  function setSpeed(s: number): void {
    speed = s;
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === s)));
    if (playing && step >= 0) run(step, false);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (playing) pause();
      go(step + 1, true);
    } else if (e.key === 'ArrowLeft' && step > 0) {
      e.preventDefault();
      if (playing) pause();
      go(step - 1, true);
    } else if (e.key === ' ' && !t.closest('button, a, summary, [role="button"]')) {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && selected) {
      select(selected, false);
    }
  };
  document.addEventListener('keydown', onKey);

  renderDetail(null);
  sync();

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey);
    page.remove();
  };
}
