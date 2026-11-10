import { entry, loadStructure } from '../catalog';
import { costHtml, figures, h, maths, scrollRegion, tableRoles } from '../core/dom';
import { Recorder } from '../core/recorder';
import type { ArgDef, Frame, OpDef, StructureDef } from '../core/types';
import { Stage } from './stage';

const FILL_COUNT = 8;

function parseArg(def: ArgDef, raw: string): { value?: number | string; error?: string } {
  const text = raw.trim();
  if (def.kind === 'int') {
    const min = def.min ?? 0;
    const max = def.max ?? 999;
    if (!/^\d+$/.test(text)) return { error: `${def.label}: enter a whole number from ${min} to ${max}.` };
    const n = Number(text);
    if (n < min || n > max) return { error: `${def.label}: enter a whole number from ${min} to ${max}.` };
    return { value: n };
  }
  const word = text.toLowerCase();
  if (!/^[a-z]{1,12}$/.test(word)) return { error: `${def.label}: use 1 to 12 letters, a to z.` };
  return { value: word };
}

/** "Skip list" reads as "skip list" mid-sentence; names such as "B+ tree", "AVL tree" and "Bloom filter" keep their capital. */
function inSentence(name: string): string {
  return /^(Bloom\b|[A-Z]+\+?\s|[A-Z]{2})/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

export const LEGEND: { tone: string; label: string }[] = [
  { tone: 'key', label: 'The key you are following' },
  { tone: 'compare', label: 'Being compared now' },
  { tone: 'path', label: 'Visited on the way' },
  { tone: 'ok', label: 'Found or written' },
  { tone: 'bad', label: 'Removed or missed' },
];

export function legend(): HTMLElement {
  return h(
    'ul.legend', { 'aria-label': 'Colour key' },
    LEGEND.map((l) => h('li', null, h(`span.swatch.tone-${l.tone}`), l.label)),
  );
}

/** Build one structure's page. Returns a function that tears it down. */
export async function mountStructure(host: HTMLElement, id: string): Promise<() => void> {
  const meta = entry(id)!;
  const def: StructureDef = await loadStructure(id);

  const params: Record<string, number> = {};
  for (const p of def.params ?? []) params[p.id] = p.default;

  let state = def.create(params);
  let runToken = 0;
  let touring = false;

  const quiet = (opId: string, args: (number | string)[]) => {
    const op = def.ops.find((o) => o.id === opId);
    if (!op) throw new Error(`${def.id}: unknown op "${opId}"`);
    op.run(state, args, new Recorder(state, def.layout, false));
  };
  const seed = () => {
    state = def.create(params);
    for (const [opId, ...args] of def.seed) quiet(opId, args);
  };
  seed();

  // ---- page skeleton -------------------------------------------------------
  const error = h('p.form-error', { id: 'op-error', role: 'alert' });
  const opsBar = h('div.ops');
  const tools = h('div.tools');
  const stageHost = h('div');
  const facts = h('dl.facts');
  const page = h(
    'article.structure', null,
    h('header.page-head', null, h('h1', null, meta.name), h('p.lede', null, meta.blurb)),
    // Row one: the operations, with the line for input errors reserved under them. Row two: setup.
    h('div.controls', null, opsBar, error, tools),
    stageHost,
    h('div.under-stage', null, facts, legend()),
  );
  host.append(page);
  const stage = new Stage(stageHost, { counters: def.counters, name: inSentence(meta.name), code: !!def.source });

  const refreshFacts = () => {
    facts.replaceChildren();
    for (const f of def.status?.(state) ?? []) facts.append(h('div', null, h('dt', null, f.label), h('dd', null, figures(f.value))));
  };

  // At rest the code view shows the listing of the tour's first operation, unlit, so it is never an empty panel.
  const restOp = def.ops.find((o) => o.id === def.tour[0]?.[0] && o.code) ?? def.ops.find((o) => o.code);
  const rest = (message: string) => {
    stage.setCode(def.source, restOp?.code, { empty: 'Run an operation to see the code for it here.', rest: true });
    stage.still(def.layout(state), message);
    refreshFacts();
  };

  /**
   * Once an operation is on the stage, bring the readout, the canvas and the
   * transport into view. If that leaves keyboard focus on an operation button
   * that is no longer wholly on screen, move it to the play button, so Tab carries on
   * from the stage instead of jumping the page back up.
   */
  const reveal = () => {
    void stage.reveal().then(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !opsBar.contains(active) || active.tagName !== 'BUTTON') return;
      const r = active.getBoundingClientRect();
      // Not wholly on screen: the next Tab would scroll the page back up to it.
      if (r.top < 0 || r.bottom > window.innerHeight) stage.focusPlay();
    });
  };

  const runOp = async (op: OpDef<unknown>, args: (number | string)[], show: boolean): Promise<void> => {
    stage.finish();
    const token = ++runToken;
    const rec = new Recorder(state, def.layout, true);
    op.run(state, args, rec);
    let frames: Frame[] = rec.frames;
    if (!frames.length) frames = [{ scene: def.layout(state), message: `${op.label} finished.`, counters: { ...rec.counters } }];
    stage.setCode(def.source, op.code, { empty: `${op.label} has no code listing.` });
    const done = stage.play(frames);
    if (show) reveal();
    await done;
    if (token === runToken) refreshFacts();
  };

  // ---- operation groups ----------------------------------------------------
  // Consecutive ops that take the same arguments share one set of inputs.
  const groups: { args: ArgDef[]; ops: OpDef<unknown>[] }[] = [];
  for (const op of def.ops as OpDef<unknown>[]) {
    const sig = op.args.map((a) => `${a.name}:${a.kind}`).join(',');
    const last = groups[groups.length - 1];
    if (last && last.args.map((a) => `${a.name}:${a.kind}`).join(',') === sig) last.ops.push(op);
    else groups.push({ args: op.args, ops: [op] });
  }

  for (const group of groups) {
    const inputs: HTMLInputElement[] = [];
    // An input the reader has not typed in is "auto": each click refills it with a fresh suggestion.
    const auto: boolean[] = [];
    const fields = group.args.map((a, i) => {
      const input = h('input', {
        type: 'text',
        inputMode: a.kind === 'int' ? 'numeric' : 'text',
        autocomplete: 'off',
        spellcheck: false,
        placeholder: 'random',
        oninput: () => {
          auto[i] = input.value.trim() === '';
          clearError();
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') go(group.ops[0]);
        },
      });
      inputs.push(input);
      auto.push(true);
      return h('label.field', null, h('span', null, a.label), input);
    });
    const go = (op: OpDef<unknown>) => {
      stopTour();
      clearError();
      if (auto.some(Boolean) || inputs.some((i) => i.value.trim() === '')) {
        const suggestion = op.suggest?.(state) ?? [];
        inputs.forEach((input, i) => {
          if ((auto[i] || input.value.trim() === '') && suggestion[i] != null) {
            input.value = String(suggestion[i]);
            auto[i] = true;
          }
        });
      }
      const args: (number | string)[] = [];
      for (let i = 0; i < group.args.length; i++) {
        const parsed = parseArg(group.args[i], inputs[i].value);
        if (parsed.error) {
          error.textContent = parsed.error;
          inputs[i].setAttribute('aria-invalid', 'true');
          inputs[i].setAttribute('aria-describedby', error.id);
          inputs[i].focus();
          return;
        }
        args.push(parsed.value!);
      }
      void runOp(op, args, true);
    };
    const buttons = group.ops.map((op) =>
      h(`button.btn.${op.intent ?? 'neutral'}`, { type: 'button', onclick: () => go(op) }, op.label),
    );
    opsBar.append(h('div.op-group', null, ...fields, h('div.op-buttons', null, ...buttons)));
  }

  function clearError(): void {
    error.textContent = '';
    for (const input of opsBar.querySelectorAll('input[aria-invalid]')) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }

  // ---- tools ---------------------------------------------------------------
  const tourBtn = h('button.btn.quiet', { type: 'button', onclick: () => (touring ? stopTour() : void playTour()) }, 'Play the tour');
  function stopTour(): void {
    if (!touring) return;
    touring = false;
    runToken++;
    tourBtn.textContent = 'Play the tour';
  }
  async function playTour(): Promise<void> {
    stage.finish();
    clearError();
    seed();
    rest('Starting the tour from the original contents.');
    touring = true;
    tourBtn.textContent = 'Stop the tour';
    let first = true;
    for (const [opId, ...args] of def.tour) {
      if (!touring) return;
      const op = def.ops.find((o) => o.id === opId) as OpDef<unknown> | undefined;
      if (!op) continue;
      // Keep each step in view, unless the reader has scrolled away from the stage altogether.
      await runOp(op, args, first || stage.onScreen);
      first = false;
      if (!touring) return;
      await new Promise((r) => setTimeout(r, 900 / stage.speed));
    }
    touring = false;
    tourBtn.textContent = 'Play the tour';
  }
  tools.append(tourBtn);
  // Show the example code with the steps. Remembered across pages.
  if (stage.codeToggle) tools.append(stage.codeToggle);

  if (def.fill) {
    tools.append(
      h('button.btn.quiet', {
        type: 'button',
        onclick: () => {
          stopTour();
          stage.finish();
          runToken++;
          for (let i = 0; i < FILL_COUNT; i++) {
            const [opId, ...args] = def.fill!(state);
            quiet(opId, args);
          }
          rest(`Added up to ${FILL_COUNT} random keys without animating them. Keys that would not fit were skipped.`);
        },
      }, `Add ${FILL_COUNT} random keys`),
    );
  }
  tools.append(
    h('button.btn.quiet', {
      type: 'button',
      onclick: () => {
        stopTour();
        stage.finish();
        runToken++;
        seed();
        rest('Reset to the starting contents.');
      },
    }, 'Reset'),
  );
  for (const p of def.params ?? []) {
    const select = h(
      'select', {
        onchange: () => {
          stopTour();
          stage.finish();
          runToken++;
          params[p.id] = Number(select.value);
          seed();
          rest(`Rebuilt with ${p.label.toLowerCase()} set to ${select.selectedOptions[0].textContent}.`);
        },
      },
      p.options.map((o) => h('option', { value: String(o.value), selected: o.value === p.default }, o.label)),
    );
    // As wide as the chosen option, not the longest one: "1" should not sit in a box sized for "3 (virtual nodes)".
    const fitSelect = () => select.style.setProperty('--chars', String(select.selectedOptions[0]?.textContent?.length ?? 2));
    select.addEventListener('change', fitSelect);
    fitSelect();
    tools.append(h('label.field.param', null, h('span', null, p.label), select));
  }

  rest('Pick an operation above, or play the tour. Leave a box empty for a random key.');

  if (import.meta.env.DEV) {
    // Hook for scripts/shot.mjs: run an op, then park on any frame for a screenshot.
    (window as unknown as Record<string, unknown>).__dsv = {
      tour: def.tour,
      run(opId: string, args: (number | string)[]): number {
        const op = def.ops.find((o) => o.id === opId) as OpDef<unknown>;
        // Starts the way a click does, including bringing the stage into view.
        void runOp(op, args, true);
        stage.pause();
        return stage.length;
      },
      seek: (i: number) => stage.seek(i),
    };
  }

  // ---- written content -----------------------------------------------------
  const info = def.info;
  const list = (items: string[]) => h('ul', null, items.map((t) => h('li', null, t)));
  page.append(
    h(
      'div.notes', null,
      h('section.note', null, h('h2', null, 'What it is'), h('p', null, info.summary)),
      h('section.note', null, h('h2', null, 'What to watch'), list(info.watch)),
      h(
        'section.note.wide', null,
        h('h2', null, 'Cost of each operation'),
        scrollRegion(h(
          'div.table-wrap', null,
          tableRoles(h(
            'table.complexity.stack', null,
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Operation'), h('th', { scope: 'col' }, 'Average'), h('th', { scope: 'col' }, 'Worst case'), h('th', { scope: 'col' }, 'Why'))),
            h(
              'tbody', null,
              info.complexity.map((r) =>
                h(
                  'tr', null,
                  h('th', { scope: 'row' }, r.op),
                  h('td.num', { 'data-label': 'Average', html: costHtml(r.average) }),
                  h('td.num', { 'data-label': 'Worst case', html: costHtml(r.worst) }),
                  h('td', { 'data-label': 'Why' }, r.note ?? ''),
                ),
              ),
            ),
          )),
        ), 'Cost of each operation'),
        h('p.space', null, h('strong', null, 'Space: '), h('span', { html: maths(info.space) })),
      ),
      h(
        'section.note', null,
        h('h2', null, 'Where it runs in production'),
        h('dl.used-in', null, info.usedIn.map((u) => h('div', null, h('dt', null, u.name), h('dd', null, u.how)))),
      ),
      h(
        'div.note-stack', null,
        h('section.note', null, h('h2', null, 'Reach for it when'), list(info.reachFor)),
        h('section.note', null, h('h2', null, 'What it costs you'), list(info.costs)),
      ),
      h('section.note.wide.interview', null, h('h2', null, 'Say this in the interview'), list(info.interview)),
    ),
  );

  return () => {
    runToken++;
    touring = false;
    stage.destroy();
    page.remove();
  };
}
