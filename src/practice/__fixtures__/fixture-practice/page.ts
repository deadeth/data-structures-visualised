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
  core: 2,
  testing: {
    intro: 'The code is short: 14 lines by stage 2. What counts is how you settle what the brief leaves out, where you keep the count, and how you test the edge at the limit.',
    points: [
      'Asking whether the limit is inclusive before typing, since it decides between `>=` and `>`.',
      'Testing a limit of 0 and a limit of 1, where an off-by-one shows at once.',
      'Keeping the count in one field of a small class, so a reset later is a one-line change.',
    ],
  },
  use: 'Drill "Ask first" and stages 1 and 2 until they feel natural. Treat stage 3, the variant and the last ten minutes as things to say, not to code up front.',
  brief: [
    'Build a `Counter` that counts calls to `hit`. Start from zero.',
    "Keep it small: one class, two methods. We'll add a rule once it works.",
  ],
  given: [
    'An `Audit` interface with one method, `refused(who, count)`.',
    'A `ListAudit` that keeps what it is told, for the tests.',
    'Empty stubs for `hit`, `count`, `reset` and `remaining`.',
    'A test harness: set `STAGE` and run `main`.',
  ],
  ask: [
    { q: 'Is the limit inclusive?', why: 'It decides whether the comparison is `>=` or `>`, and that is the one line most people get wrong.', assume: 'A limit of 2 lets two calls in and refuses the third.' },
    { q: 'Is the counter used from more than one thread?', why: 'If it is, the read and the increment must happen under one lock or with an atomic.', assume: 'One thread for now; I will say what changes for many.' },
    { q: 'What should a refused call return: false, or an exception?', why: 'A return value keeps the caller in charge; an exception forces a try block at every call site.', assume: 'Return `false`.' },
    { q: 'Is a refused call counted?', why: 'If it is, a caller who keeps trying never gets back under the limit.', assume: 'No: only calls let through are counted.' },
    { q: 'Can the limit change after the counter is made?', why: 'A fixed limit can be a `final` field set in the constructor; a changing one needs a setter and a rule for the count already past it.', assume: 'Fixed for the life of the counter.' },
  ],
  outline: `on hit(who):
  if count has reached the limit
    tell the audit who was refused, and the count
    answer no
  add one to count
  answer yes

on reset():
  set count to zero`,
  parts: [
    {
      id: 'count',
      title: 'Count the calls',
      stage: 1,
      ask: 'Give me a counter. Every call to `hit` adds one, and `count` tells me how many so far.',
      tests: ['a new counter is at zero', 'each hit adds one', 'a hit under the limit is let through'],
      regions: ['state', 'hit', 'count'],
      pseudocode: `on hit(who):
  add one to count
  answer yes

on count():
  answer count`,
      choice: 'Keep the state in one `int` field and nothing else. A field starts at 0 in Java, so the constructor sets nothing yet. Make `hit` return `true` now, though nobody has asked for an answer: stage 2 then changes its body and never its signature, and the stage 1 tests keep compiling. See [stage 2](#/p/fixture-practice/limit).',
      say: "I'll keep the count in one int and get the tests green before adding the limit.",
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
      pitfalls: [
        'Writing the limit check in stage 1, before anyone asked for it: the stage 1 tests still pass, so nothing tells you it is wrong.',
        'Returning `void` from `hit`: stage 2 then breaks every call site in the tests.',
      ],
    },
    {
      id: 'limit',
      title: 'Refuse calls at the limit',
      stage: 2,
      ask: 'Now give it a limit. Once the count reaches it, refuse the call, do not count it, and tell the audit.',
      tests: ['the call after the limit is refused', 'a refused call is not counted', 'a refused call is reported', 'a limit of zero refuses the first call'],
      regions: ['limit', 'hit'],
      pseudocode: `on hit(who):
  if count >= limit
    audit.refused(who, count)
    answer no
  add one to count
  answer yes`,
      choice: 'Check **before** the increment, so a refused call never changes the count. The comparison is `count >= limit`, at the limit and not past it: with `>` a limit of 2 lets three calls in. A limit of 0 then refuses the first call with no special case. The limit and the audit are `final` fields set once in the constructor, with no setter.',
      say: 'I check before I count, so a refused call leaves the count alone, and the limit is inclusive.',
      sketch: {
        caption: 'A limit of 2 on a line of calls: the third is the first refused.',
        text: `call:    1     2     3     4
count:   1     2     2     2
answer:  yes   yes   no    no
                     ^
                     count >= limit, so refuse`,
      },
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
      pitfalls: [
        'Counting first and checking after: the count passes the limit and the test "a refused call is not counted" fails with 2 for 1.',
        'Using `>` for the comparison: one call too many gets through.',
      ],
    },
    {
      id: 'reset',
      title: 'Start again from zero',
      stage: 3,
      ask: 'Add a `reset` that puts the count back to zero, so the limit applies again from there.',
      tests: ['reset sets the count to zero', 'after a reset the limit applies again'],
      regions: ['reset'],
      pseudocode: `on reset():
  set count to zero`,
      choice: 'Set the one field back to 0 and touch nothing else. The limit and the audit stay as they were, because they are configuration, not state. Do not make a new `Counter` instead: callers hold a reference to this one.',
      say: 'Reset clears the state and keeps the configuration.',
      verbal: [
        'I would add a `reset` method that sets the count back to zero.',
        'The limit and the audit stay as they are, since they are configuration and not state.',
        'Calling it on a timer every minute turns this into a fixed-window limiter.',
      ],
      caveat: 'The two tests run on one thread, so they cannot show a reset racing a hit.',
      trace: {
        caption: 'With a limit of 1, a reset lets the next call through again.',
        head: ['Call', 'Answer', 'Count', 'Audit'],
        rows: [
          ['hit("ann")', 'true', '1', '[]'],
          ['hit("bob")', 'false', '1', '[bob@1]'],
          ['reset()', '', '0', '[bob@1]'],
          ['hit("bob")', 'true', '1', '[bob@1]'],
        ],
      },
      pitfalls: [
        'Clearing the audit in `reset`: the record of who was refused is lost.',
        'Replacing the counter with a new one: callers still holding the old one never see the reset.',
      ],
    },
    {
      id: 'remaining',
      title: 'Say how many calls are left',
      stage: 4,
      variant: true,
      ask: 'Instead of a yes or no, tell me how many more calls would be let through.',
      tests: ['remaining starts at the limit', 'remaining falls with each hit', 'remaining is never below zero'],
      regions: ['remaining'],
      pseudocode: `on remaining():
  answer the larger of 0 and limit - count`,
      choice: 'Work it out from the two fields on each call rather than keeping a second counter that can drift. Clamp at 0 with `Math.max`, so a limit of 0 answers 0 and never a negative number.',
      say: 'Remaining is derived from the count, so there is only one thing to keep right.',
      verbal: [
        'The same counter answers "how many are left" as `limit - count`, clamped at 0, with no new state.',
      ],
      trace: {
        caption: 'A limit of 3: remaining falls by one with each call let through.',
        head: ['Call', 'Answer', 'Count', 'Remaining'],
        rows: [
          ['new Counter(3)', '', '0', '3'],
          ['hit("ann")', 'true', '1', '2'],
          ['hit("bob")', 'true', '2', '1'],
        ],
      },
      pitfalls: [
        'Keeping `remaining` as its own field: a reset that forgets it leaves the two disagreeing.',
        'Forgetting the clamp: a limit of 0 is fine, but a negative limit answers below zero.',
      ],
    },
  ],
  followUps: [
    { q: 'How would you make it safe for many threads?', a: 'Put `hit` under one lock, or use an `AtomicInteger` with a compare-and-set loop. The check and the increment must be one step, or two threads both see 1 and both get in.' },
    { q: 'How would you reset it every minute?', a: 'Keep the start of the window and reset the count when a call arrives after it ends. That is a fixed window; a [token bucket](#/s/token-bucket) smooths the edges.' },
    { q: 'Why return false rather than throw?', a: 'Being refused is an expected answer, not an error. A boolean keeps the caller in charge and costs nothing.' },
    { q: 'What would you change before this went to production?', a: 'A limit per caller, kept in a map, and a metric for refusals. I would also make the clock injectable before adding any window.' },
    { q: 'How would you test the threading?', a: 'Start many threads on a latch and have each call `hit` many times. The count must equal the limit exactly, run after run.' },
    { q: 'What if the audit is slow?', a: 'Every refused call waits for it. I would hand refusals to a queue and let another thread report them.' },
    { q: 'How does this compare with a token bucket?', a: 'This counter never refills on its own. A bucket adds tokens over time, so it allows bursts up to its size and a steady rate after.' },
    { q: 'What if the limit must be shared across machines?', a: 'The count has to live somewhere shared, such as Redis with an atomic increment. Each call then pays a network round trip.' },
  ],
  see: [
    { href: '#/s/token-bucket', label: 'Token bucket' },
    { href: '#/c/resilience-patterns', label: 'Resilience patterns' },
    { href: '#/d/web-crawler', label: 'Web crawler' },
  ],
  unverified: ['A fixture claim, kept in the data and never shown.'],
};

export default page;
