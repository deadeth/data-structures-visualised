import type { Guide } from '../types';

/** A guide with every block kind, for the renderer. In development it opens at #/p/fixture-guide; never in a build. */
const guide: Guide = {
  title: 'Fixture: how to use these',
  summary: 'A test guide. It shows **bold**, `code` and a [link to the fixture page](#/p/fixture-practice).',
  sections: [
    {
      id: 'run',
      title: 'A timed run',
      blocks: [
        { p: 'Paste the starter, set `STAGE = 1`, start the clock and talk as you type.' },
        { list: ['Ask two questions.', 'Write stage 1.', 'Run the tests.'], ordered: true },
        { list: ['A plain list item.', 'Another, with a [link](#/p/fixture-practice/limit).'] },
        { table: { head: ['Minute', 'What you should have'], rows: [['5', 'Questions asked, plan said aloud'], ['20', 'Stage 1 green']] }, caption: 'Where a 40-minute run should be' },
        { callout: 'Say the assumption, then carry on.', title: 'If nobody answers' },
        { callout: 'A callout with no title.' },
      ],
    },
  ],
  order: ['fixture-practice'],
};

export default guide;
