import type { Guide } from './types';

/** The front page of the pairing practice section (`#/p`): how to use the task pages and their starters. */
const guide: Guide = {
  title: 'How to use the pairing tasks',
  summary:
    'Five small coding tasks in Java 21, each built a stage at a time against a clock, from a starter file that carries its own tests.',
  sections: [
    {
      id: 'what',
      title: 'What these are',
      blocks: [
        {
          p: "Five small stateful tasks of the kind set in a pair-programming interview, each built a stage at a time. Each has a starter file: supplied code, empty stubs and every stage's tests. The pages teach the shape of the answer and what to say. The starters are for timed runs.",
        },
      ],
    },
    {
      id: 'run',
      title: 'How to do a run',
      blocks: [
        {
          list: [
            'Open a task and press **Copy starter**.',
            "Paste it into the editor you'll be interviewed in, or into a plain text editor with `java Solution.java` in a terminal.",
            'Run it. Every stage 1 test should fail.',
            'Press **Start the clock**.',
            'Write stage 1 and run until its tests pass.',
            "Raise `STAGE` by one, read the requirement in the comment above that stage's tests, and write it.",
            'Repeat until the clock reaches the target, then stop.',
            'Read the page for the stage you got stuck on.',
          ],
          ordered: true,
        },
        {
          callout: "Stop whether or not you've finished. Where you stopped is what to read next, and an overrun hides it.",
          title: 'Stop at the target time',
        },
        {
          p: 'Each test prints a line starting `PASS` or `FAIL`, and a failure says what it expected and what it got. Each stage ends with a count such as `Stage 1: 4/6 passed`. The last line is `ALL PASSED`, or the number that failed.',
        },
        {
          p: 'From your second run at a task, switch on **Hide the code until I ask**. It folds the pseudocode and the Java away until you ask for them.',
        },
      ],
    },
    {
      id: 'order',
      title: 'Which to do first',
      blocks: [
        {
          table: {
            head: ['Task', 'Core stage', 'Target', 'What it trains'],
            rows: [
              ['[Circuit breaker](#/p/circuit-breaker)', 'Stage 3', '40 minutes', 'state that changes with time, kept for each service'],
              ['[Token manager](#/p/token-manager)', 'Stage 3', '35 minutes', 'caching a value and renewing it before it expires'],
              ['[Rate limiter](#/p/rate-limiter)', 'Stage 3', '35 minutes', 'counting requests in a moving window'],
              ['[Currency converter](#/p/currency-converter)', 'Stage 3', '40 minutes', 'exact money arithmetic and a provider that fails'],
              ['[Tic-tac-toe](#/p/tic-tac-toe)', 'Stage 2', '25 minutes', 'asking first and talking while you type'],
            ],
          },
        },
        {
          p: 'Do the circuit breaker first and most often, until its core takes well under 40 minutes from a blank stub. The rate limiter reuses two of its parts: a map keyed by service name, and timestamps in a window. The token manager reuses the third, a comparison of the time now with an expiry time. Tic-tac-toe is the warm-up for the habits below.',
        },
      ],
    },
    {
      id: 'first-five',
      title: 'The first five minutes',
      blocks: [
        {
          p: 'These hold for any pair-programming task. The first three fill the opening five minutes; the rest run to the end.',
        },
        {
          list: [
            "Read the supplied code before you type. It shows what you don't have to write.",
            'Ask the two or three questions whose answers change the code. State your assumptions for the rest.',
            'Say the plan in one breath.',
            'Write the least that passes the first test.',
            'Run early and run often.',
            "Say what you're deciding as you type, not what you're typing.",
            'When a new requirement arrives, say what it changes before you touch the keyboard.',
          ],
          ordered: true,
        },
        {
          p: 'This is pairing in general. Nothing here claims to know how any one employer marks it.',
        },
      ],
    },
    {
      id: 'before',
      title: 'Before the day',
      blocks: [
        {
          p: "Check five things in the real editor. The starters depend on them, and this site can't confirm any of them for you.",
        },
        {
          list: [
            "It offers Java 21. The thread helper in the token manager's and the rate limiter's tests needs it.",
            'A file with its own `main` runs.',
            'Several classes in one file compile.',
            "Whether suggestions appear as you type. If they don't, practise without them.",
            'How long a run may take. Compiled, every file here finished in under a second where it was checked, and none sleeps.',
          ],
        },
        {
          callout: 'Open a practice session in that editor and paste one starter in. That answers all five.',
        },
      ],
    },
    {
      id: 'limits',
      title: 'What these pages are not',
      blocks: [
        {
          p: "The briefs are written for practice, and a real brief will differ. Each solution is what fits in forty minutes, and each page lists what it leaves out. Every Java file was compiled and run on JDK 21 with every stage's tests. The follow-up answers about production systems are the writers' own knowledge, flagged on each page where unchecked.",
        },
      ],
    },
  ],
  order: ['circuit-breaker', 'token-manager', 'rate-limiter', 'currency-converter', 'tic-tac-toe'],
};

export default guide;
