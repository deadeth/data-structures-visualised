import type { Concept } from '../types';

/**
 * A reading page that uses every block kind, for the renderer and the validation test.
 * Not loaded by the registry; in development it opens at #/c/fixture-reading.
 */
const page: Concept = {
  id: 'fixture-reading',
  title: 'Fixture: every block kind',
  group: 'Data',
  summary: 'A test page. It shows **bold**, `code` and a [link to the B+ tree](#/s/b-plus-tree) in a summary.',
  minutes: 3,
  sections: [
    {
      id: 'text',
      title: 'Text, lists and callouts',
      blocks: [
        { p: 'A paragraph with **bold words**, `inline_code <slot>` and links to a [structure](#/s/lsm-tree), a [design](#/d/ledger), a [design part](#/d/ledger/c/db), a [walkthrough-free design rehearsal](#/d/ledger/rehearse) and this page\'s [second section](#/c/fixture-reading/figures).' },
        { h: 'A subheading' },
        { list: ['One item with `code`.', 'Two items, the second **longer** than the first so it wraps on a phone screen at least once.'] },
        { list: ['First step.', 'Second step.'], ordered: true },
        { callout: 'Say the trade-off first, then the number: "a 10-second cache cuts origin reads from 1 million a second to 30".', kind: 'interview' },
        { callout: 'Counting a retried message twice.\n\nA second paragraph in the same callout.', kind: 'pitfall', title: 'Double counting' },
        { callout: 'Keep a hot row to one writer.', kind: 'rule' },
        { callout: '1,000 writes a second × 86,400 seconds = 86.4 million rows a day.', kind: 'example', title: 'Sizing a table' },
      ],
    },
    {
      id: 'figures',
      title: 'Figures',
      blocks: [
        {
          diagram: {
            w: 600,
            h: 400,
            groups: [{ label: 'eu-west-1', x: 190, y: 120, w: 410, h: 270 }],
            nodes: [
              { id: 'user', label: 'Customer app', sub: 'phone', x: 0, y: 20, kind: 'client' },
              { id: 'api', label: 'Payments API', sub: 'stateless', x: 230, y: 20, tone: 'follow' },
              { id: 'db', label: 'Ledger DB', sub: 'Postgres primary', x: 230, y: 160, kind: 'store', tone: 'ok', h: 64 },
              { id: 'replica', label: 'Replica', sub: 'async, 50 ms behind', x: 430, y: 160, kind: 'store', tone: 'compare', h: 64 },
              { id: 'log', label: 'ledger-events', sub: 'Kafka, 12 partitions', x: 230, y: 300, kind: 'queue', w: 160 },
              { id: 'dead', label: 'Old consumer', x: 456, y: 300, w: 140, tone: 'bad' },
              { id: 'note', label: 'Writes only', x: 20, y: 176, w: 110, h: 30, kind: 'note' },
              { id: 'cache', label: 'Cache', sub: 'Redis', x: 20, y: 300, w: 120, tone: 'muted' },
            ],
            edges: [
              { from: 'user', to: 'api', label: 'POST /pay', tone: 'follow' },
              { from: 'api', to: 'db', label: 'one transaction', tone: 'follow' },
              { from: 'db', to: 'replica', label: 'WAL', dashed: true },
              { from: 'db', to: 'log', label: 'outbox' },
              { from: 'log', to: 'dead', label: 'no ack', tone: 'bad' },
              { from: 'cache', to: 'log', both: true, tone: 'visited' },
            ],
          },
          caption: 'Follow the magenta payment: it is committed once in the green store, and the replica (amber) is what a stale read would compare against.',
        },
        {
          sequence: {
            actors: ['Client', 'API', 'Postgres', 'Kafka'],
            messages: [
              { from: 'Client', to: 'API', label: 'POST /pay key=k1', tone: 'follow' },
              { from: 'API', to: 'Postgres', label: 'INSERT … ON CONFLICT DO NOTHING', note: 'One transaction writes the row and the outbox.' },
              { from: 'Postgres', to: 'API', label: 'committed', tone: 'ok', dashed: true },
              { from: 'API', to: 'Client', label: 'timeout', tone: 'bad', note: 'The reply is lost; the client cannot tell.' },
              { from: 'Client', to: 'API', label: 'retry, same key k1', tone: 'follow' },
              { from: 'API', to: 'API', label: 'key seen: replay' },
              { from: 'API', to: 'Kafka', label: 'publish once', tone: 'visited' },
            ],
          },
          caption: 'The retry carries the same key, so the second request replays the first answer instead of paying twice.',
        },
        { design: { id: 'ledger', lit: ['api', 'ledger', 'db'], flows: ['post', 'txn', 'result'] }, caption: 'The payment path on the ledger design: API, ledger service, database.' },
      ],
    },
    {
      id: 'tables',
      title: 'Tables, code and links out',
      blocks: [
        { table: { head: ['Option', 'What it solves', 'What it costs', 'When to choose it'], rows: [['Cache-aside', 'Read load on the primary', 'Stale reads for up to the TTL', 'Read-heavy, tolerant of 10 s staleness'], ['Write-through', 'Stale reads', 'Every write pays two round trips', 'Small hot sets read right after writing']] }, caption: 'Two cache strategies side by side.' },
        { code: "SELECT currency, sum(amount_minor)\nFROM minute_totals\nWHERE bucket_minute >= now() - interval '24 hours'\nGROUP BY currency;", lang: 'sql', title: 'The 24-hour window' },
        { code: '{"key": "<fp>", "slot": 3}', lang: 'json' },
        { see: [{ href: '#/s/cache-strategies', label: 'Cache strategies', why: 'Shows a stale read after a write, step by step.' }, { href: '#/d/ledger', label: 'Ledger service', why: 'The design these patterns come from.' }, { href: '#/c/fixture-reading/text', label: 'This page', why: 'A link back to the first section.' }] },
      ],
    },
  ],
  unverified: ['That Redis is single-threaded for commands (true of the main loop; I/O threads exist).'],
};
export default page;
