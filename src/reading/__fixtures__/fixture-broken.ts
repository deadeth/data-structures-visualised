import type { Concept } from '../types';

/** A page with one of each fault the validation test must catch. Not loaded by the registry. */
const page: Concept = {
  id: 'fixture-broken',
  title: 'Broken fixture',
  group: 'Data',
  summary: 'A page that fails on purpose.',
  minutes: 1,
  sections: [
    {
      id: 'one',
      title: 'One',
      blocks: [
        { p: 'We leverage a robust cache. See [nothing](#/s/no-such-structure) and [no design](#/d/no-such-design).' },
        {
          diagram: {
            w: 400,
            h: 200,
            nodes: [
              { id: 'a', label: 'A', x: 10, y: 10 },
              { id: 'b', label: 'B', x: 100, y: 30 },
              { id: 'c', label: 'C', x: 300, y: 160 },
              { id: 'mid', label: 'Mid', x: 200, y: 100, w: 60, h: 40 },
              { id: 'far', label: 'Far', x: 260, y: 10, w: 40, h: 40 },
              { id: 's', label: 'Store', sub: 'a very long subtitle that will never fit in this small node at all', x: 330, y: 70, w: 60, h: 40, kind: 'store' },
            ],
            edges: [
              { from: 'a', to: 'ghost' },
              { from: 'b', to: 'far' },
              { from: 'a', to: 'c' },
            ],
          },
          caption: 'Overlaps, a node off the edge, a missing node and an edge through a box.',
        },
        { sequence: { actors: ['A', 'B'], messages: [{ from: 'A', to: 'C', label: 'hi' }] }, caption: 'An actor that is not listed.' },
        { design: { id: 'ledger', lit: ['api', 'nope'], flows: ['post', 'nope-flow'] }, caption: 'A missing component and flow.' },
        { design: { id: 'no-such-design', lit: [] }, caption: 'A missing design.' },
        { see: [{ href: '#/c/no-such-concept', label: 'Nothing', why: 'Missing.' }] },
      ],
    },
    { id: 'one', title: 'One again', blocks: [{ p: 'A repeated section id.' }] },
  ],
};
export default page;
