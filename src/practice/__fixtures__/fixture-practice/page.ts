import type { Practice } from '../../types';

/**
 * A practice page that uses every field of the contract, for the renderer and the shape tests.
 * Not in the registry's list; in development it opens at #/p/fixture-practice.
 */
const page: Practice = {
  id: 'fixture-practice',
  title: 'Fixture: a counter with a limit',
  summary: 'A test page for the renderer. It counts calls and, from stage 2, refuses them at a limit, with **bold**, `code` and a [link to the token bucket](#/s/token-bucket).',
  minutes: 15,
  core: 1,
  brief: [
    'Build a `Counter` that counts calls to `hit`. Start from zero.',
    "Keep it small: one class, two methods. We'll add a rule once it works.",
  ],
  given: [
    'An `Audit` interface with one method, `refused(who, count)`, and a `ListAudit` that keeps what it is told.',
    'A test harness: set `STAGE` and run `main`.',
  ],
  ask: [
    { q: 'Is the limit inclusive?', why: 'It decides whether the comparison is `>=` or `>`, and that is the one line most people get wrong.', assume: 'A limit of 2 lets two calls in and refuses the third.' },
    { q: 'Is the counter used from more than one thread?', why: 'If it is, the read and the increment must happen under one lock or with an atomic.', assume: 'One thread for now; I will say what changes for many.' },
    { q: 'What should a refused call return: false, or an exception?', why: 'A return value keeps the caller in charge; an exception forces a try block at every call site.', assume: 'Return `false`.' },
  ],
  outline: `on hit(who):
  if count has reached the limit
    tell the audit who was refused, and the count
    answer no
  add one to count
  answer yes`,
  parts: [
    {
      id: 'count',
      title: 'Count the calls',
      stage: 1,
      ask: 'Give me a counter. Every call to `hit` adds one, and `count` tells me how many so far.',
      tests: ['a new counter is at zero', 'each hit adds one', 'a hit under the limit is let through'],
      pseudocode: `on hit(who):
  add one to count
  answer yes

on count():
  answer count`,
      regions: ['state', 'hit', 'count'],
      explain: [
        'One `int` field holds the state. Nothing else is needed until there is a rule to apply.',
        'The `hit` method returns `true` already, so stage 2 changes its body and never its signature. See [stage 2](#/p/fixture-practice/limit).',
      ],
      lines: [
        { code: 'count++;', note: 'The whole of stage 1. A field starts at 0 in Java, so the constructor sets nothing.' },
        { code: 'return true;', note: 'Fixed now so the tests of stage 2 can call the same method.' },
      ],
      trace: {
        caption: 'Four calls with a limit of 2: stage 1 lets every one through, so the count reaches 4.',
        head: ['Call', 'Answer', 'Count', 'Audit'],
        rows: [
          ['hit("ann")', 'true', '1', '[]'],
          ['hit("bob")', 'true', '2', '[]'],
          ['hit("cat")', 'true', '3', '[]'],
          ['hit("ann")', 'true', '4', '[]'],
        ],
      },
      say: "I'll keep the count in one int and get the tests green before adding the limit.",
      pitfalls: ['Writing the limit check in stage 1, before anyone asked for it: the stage 1 tests still pass, so nothing tells you it is wrong.'],
    },
    {
      id: 'limit',
      title: 'Refuse calls at the limit',
      stage: 2,
      ask: 'Now give it a limit. Once the count reaches it, refuse the call, do not count it, and tell the audit.',
      tests: ['the call after the limit is refused', 'a refused call is not counted', 'a refused call is reported', 'a limit of zero refuses the first call'],
      pseudocode: `on hit(who):
  if count >= limit
    audit.refused(who, count)
    answer no
  add one to count
  answer yes`,
      regions: ['limit', 'hit'],
      explain: [
        'The check comes **before** the increment, so a refused call never changes the count.',
        'The limit and the audit are `final`: they are set once, in the constructor, and the class has no setter for them.',
        'A limit of 0 refuses the first call. The `>=` makes that fall out with no special case.',
      ],
      lines: [
        { code: 'if (count >= limit) {', note: 'At the limit, not past it. With `>` a limit of 2 lets three calls in.' },
        { code: 'audit.refused(who, count);', note: 'Reported before returning, with the count as it stands.' },
      ],
      trace: {
        caption: 'The same four calls with the limit at 2: the third and fourth are refused, and the count stays at 2.',
        head: ['Call', 'Answer', 'Count', 'Audit'],
        rows: [
          ['hit("ann")', 'true', '1', '[]'],
          ['hit("bob")', 'true', '2', '[]'],
          ['hit("cat")', 'false', '2', '[cat@2]'],
          ['hit("ann")', 'false', '2', '[cat@2, ann@2]'],
        ],
        note: 'Run from a scratch class on the stage 2 file; the test "a refused call is reported" checks the same rule with a limit of 1.',
      },
      say: 'I check before I count, so a refused call leaves the count alone, and the limit is inclusive.',
      pitfalls: [
        'Counting first and checking after: the count passes the limit and the test "a refused call is not counted" fails with 2 for 1.',
        'Using `>` for the comparison: one call too many gets through.',
      ],
    },
  ],
  followUps: [
    { q: 'How would you make it safe for many threads?', a: ['Put `hit` under one lock, or use an `AtomicInteger` with a compare-and-set loop.', 'The check and the increment must be one step, or two threads both see 1 and both get in.'] },
    { q: 'How would you reset it every minute?', a: ['Keep the start of the window and reset the count when a call arrives after it ends.', 'That is a fixed window; a [token bucket](#/s/token-bucket) smooths the edges.'] },
  ],
  mistakes: ['Reading the whole test file before writing stage 1.', 'Renaming the methods the tests call.'],
  see: [
    { href: '#/s/token-bucket', label: 'Token bucket', why: 'A limit that refills over time.' },
    { href: '#/c/resilience-patterns', label: 'Resilience patterns', why: 'Where a limit like this sits in a service.' },
    { href: '#/d/web-crawler', label: 'Web crawler', why: 'A per-host budget, the same idea at scale.' },
  ],
  simplified: ['One thread only.', 'No time window: the count never goes down.'],
  unverified: ['A fixture claim, listed so the foot of the page has something to show.'],
};

export default page;
