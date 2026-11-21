import type { Practice } from '../types';

const page: Practice = {
  id: 'circuit-breaker',
  title: 'Circuit breaker',
  summary:
    'Build a small circuit breaker around a web client, so that three failures from a downstream service inside a sliding ten-minute window stop calls to it for five minutes, then one trial call tests whether it has recovered.',
  minutes: 40,
  core: 3,
  testing: {
    intro:
      'The code is short, 59 lines of your own by the end of stage 3, and none of it is a clever algorithm. The task shows how you handle what the brief leaves out, how cleanly you hold state, and how you work with someone against a clock.',
    points: [
      'You ask what counts as a failure, whether the ten minutes slide and how recovery works before you touch the keyboard.',
      'You use the supplied clock to test exact millisecond boundaries, `>=` against `>`, with no sleeping.',
      'You put the state in a small `Breaker` class early, so that going from one service to many changes one field and adds one lookup.',
    ],
  },
  use: 'Drill "Ask first" and stages 1 to 3 until they feel natural. Treat thread safety and the last ten minutes as things to say in the final ten minutes, not to code up front.',
  brief: [
    '"Here is a small web client. Service A uses it to call two downstream services, B and C. The remote calls are simulated for you. Implement `execute` so that when a downstream service keeps failing we stop calling it for a while: three failures within ten minutes means no calls to that service for the next five minutes. After that, try again."',
    'A blocked call must not reach the remote. It returns `Response.BLOCKED` at once: status 503 with the `blocked` flag set.',
  ],
  given: [
    '`Request(service, path)` and `Response(status, blocked)` are records, read with `request.service()` and `response.status()`.',
    '`Response.BLOCKED` is the answer for a blocked call, and `Response.of(status)` makes an ordinary one.',
    '`Remote` and `Clock` have one method each, with fakes the tests drive: the clock starts at 0 and moves only when a test says so.',
    'The `WebClient` shell has `remote` and `clock`, and `maxFailures`, `windowMillis` and `cooldownMillis` already set to 3, 600000 and 300000, so you never type the numbers.',
    'Stubs for `execute` (stage 1) and `replay` (stage 5), the imports and every test are there: set `STAGE` and run `main`.',
  ],
  ask: [
    {
      q: 'What counts as a failure: any 5xx, a 4xx, an exception?',
      why: "A 404 means the caller sent something wrong and the service is healthy, so counting it lets one caller's bad input block everyone's good calls.",
      assume: 'A 5xx answer or an exception is a failure; a 2xx or a 4xx is not. An exception is counted and rethrown unchanged.',
    },
    {
      q: 'Is "three failures within ten minutes" any three inside a sliding ten minutes, or three in a row? Does a success in between reset the count?',
      why: 'It picks the data structure: three in a row is one `int` that a success sets back to 0, but a sliding ten minutes needs the time of each failure, because the oldest has to drop out alone.',
      assume: 'A sliding window by time, and a success in between resets nothing.',
    },
    {
      q: 'After the five minutes, does everything go through again, or one call first to see?',
      why: 'If every waiting caller goes through at once, a service that has only just come back takes the whole backlog and can fall over again.',
      assume: 'One trial call. If it succeeds, the breaker closes and forgets its old failures; if it fails, it stays open for another five minutes, counted from the trial.',
    },
    {
      q: 'Is the count kept for each downstream service, or one for the whole client?',
      why: 'The brief says "that service", so B failing should not cut off C, and the answer decides where the state lives.',
      assume: "Per service, keyed by the service name on the request. I'll get one service right first and key it afterwards.",
    },
    {
      q: 'Is a failure exactly ten minutes old still in the window, and is a call exactly five minutes after opening blocked or let through?',
      why: 'Each answer is one comparison operator, `>=` or `>`, and the tests sit on those exact milliseconds.',
      assume: 'Exactly ten minutes old no longer counts, and exactly five minutes after opening the trial goes. Both are `>=` on an age.',
    },
    {
      q: 'Will `execute` be called from several threads at once?',
      why: 'It decides whether the check and the update need a lock, and whether two callers can both become the trial.',
      assume: "One thread for now. I'll keep each service's state in one object so a lock can go on it later.",
    },
  ],
  outline: `for each service, keep one breaker:
  state: CLOSED, OPEN or HALF_OPEN
  openedAt: when it last opened
  failures: the times of recent failures, oldest first

execute(request):
  find the breaker for the request's service, or make one
  if not allow(now): answer BLOCKED, call nothing
  call the remote, holding no lock
  record(now, failed): it threw (rethrow), or status >= 500

allow(now), under the breaker's lock:
  CLOSED: yes
  OPEN for 5 minutes or more: HALF_OPEN; yes, the trial
  otherwise: no

record(now, failed), under the breaker's lock:
  HALF_OPEN and failed: OPEN again, from now
  HALF_OPEN and worked: CLOSED, forget every failure
  CLOSED and failed: add now, drop times 10 minutes old
    or more; if 3 are left: OPEN, from now
  anything else: nothing to do

replay(a line of "time service status"):
  the same allow and record, with the line's time and status`,
  parts: [
    {
      id: 'count',
      title: 'Count failures and open',
      stage: 1,
      ask: 'Calls go through to the remote. A 5xx answer or an exception is a failure; a 4xx is not. Three failures within ten minutes open the breaker, and from then on every call is blocked without reaching the remote. Leave the five-minute retry for the next step.',
      tests: [
        'third failure opens the breaker',
        '4xx answers pass through and are not failures',
        'exceptions count and are rethrown',
        'failure exactly ten minutes old no longer counts',
      ],
      regions: ['execute', 'one-breaker', 'breaker'],
      pseudocode: `the breaker holds:
  failures: the times of recent failures, oldest first
  open: no

execute(request):
  if the breaker is open: answer BLOCKED, call nothing
  call the remote
    if it throws: record a failure at the time now, rethrow
  record at the time now: failed if the status is 500 or more
  answer the response

record(now, failed):
  if not failed: nothing to do
  add now to the back of failures
  while the front failure is 10 minutes old or more:
    drop it
  if 3 or more failures are left: open`,
      choice:
        "Keep each failure's time in an `ArrayDeque`, oldest first, not a counter. On a failure, `addLast(now)`, drop from the front while `now - failures.peekFirst() >= windowMillis`, then open if 3 are left. With `>=`, a failure exactly ten minutes old has gone. A counter can't forget one failure at a time: failures at minutes 0, 9 and 18 make it read 3 and open, though no ten minutes held more than 2. Clearing the deque on a success is three in a row, a different rule that no supplied test notices. Put it in a small inner class, `Breaker`, that is handed the time and never reads the clock.",
      say: "I'll keep the time of each failure in a deque, oldest first, because the ten minutes slide and a counter can't forget one failure at a time.",
      trace: {
        caption:
          'At 600000 ms, exactly ten minutes, both failures from time 0 leave together, so the third failure overall is alone in the window and it takes two more to open.',
        head: ['Time (ms)', 'Remote answers', 'Outcome', 'Open after', 'Failure times after'],
        rows: [
          ['0', '500', 'called', 'false', '`[0]`'],
          ['0', '500', 'called', 'false', '`[0, 0]`'],
          ['600000', '500', 'called', 'false', '`[600000]`'],
          ['600000', '500', 'called', 'false', '`[600000, 600000]`'],
          ['600000', '500', 'called', 'true', '`[600000, 600000, 600000]`'],
          ['600000', 'not called', 'BLOCKED', 'true', '`[600000, 600000, 600000]`'],
        ],
        note: 'Every call is to B. Rows 1 to 4 are the test "failure exactly ten minutes old no longer counts"; rows 5 and 6 are added to show the breaker open.',
      },
      pitfalls: [
        'With `>= 400` three 404s open the breaker, and the second test gets BLOCKED where it expects the 404 back.',
        'With `>` in the window loop a failure exactly ten minutes old still counts, and the fourth test gets BLOCKED where it expects a 500.',
        'Swallow the exception and the third test fails with `expected 3, got 0`; rethrow it without recording and it fails with `threw java.lang.IllegalStateException: no route to service`.',
        'Call the remote before asking the breaker and a blocked call still reaches the service: the first test counts 4 calls where it expects 3.',
      ],
    },
    {
      id: 'trial',
      title: 'Cool down, then one trial',
      stage: 2,
      ask: 'Five minutes after the breaker opens, let one call through as a trial. If it succeeds, close the breaker and forget the old failures. If it fails, stay open for another five minutes.',
      tests: [
        'trial at exactly five minutes closes it on success',
        'failed trial opens it for another cooldown',
        'recovery forgets earlier failures',
      ],
      regions: ['states', 'breaker-with-cooldown', 'execute-with-time'],
      sketch: {
        caption:
          '`record` opens the breaker on the third failure inside ten minutes; `allow` makes the first call to arrive five minutes or more after that the trial; a trial that succeeds closes the breaker and clears the failure times, and one that fails opens it again for five minutes counted from the trial.',
        text: `CLOSED --3 failures in 10 min--> OPEN --5 min pass--> HALF_OPEN
  ^                               ^                     |   |
  |                               +-----trial fails-----+   |
  +---------------------trial succeeds----------------------+`,
      },
      pseudocode: `the breaker holds:
  state: CLOSED, OPEN or HALF_OPEN; it starts CLOSED
  openedAt: when it last opened
  failures: as before

allow(now):
  CLOSED: yes
  OPEN and now - openedAt is 5 minutes or more:
    state = HALF_OPEN; yes, this call is the trial
  otherwise: no

record(now, failed):
  if HALF_OPEN, this is the trial's answer:
    failed: state = OPEN, openedAt = now
    worked: state = CLOSED, forget every failure
    stop here
  if not failed: nothing to do
  add now; drop failures 10 minutes old or more
  if 3 or more are left: state = OPEN, openedAt = now

execute: as before, but ask allow(the time now)`,
      choice:
        'Add a third state. `HALF_OPEN` means one trial is out, and `allow` sets it before the remote is called, on the first call where `now - openedAt >= cooldownMillis`. A second boolean would allow a fourth, meaningless combination. **Clear the failure times when the trial succeeds.** The three that opened the breaker can be only five minutes old, inside the ten, so without `failures.clear()` the next single failure makes four in the window and opens it again. `recovery forgets earlier failures` catches that: it gets BLOCKED where it expects a 500. A failed trial calls `open(now)`, which sets `openedAt` again, so the next five minutes run from the trial.',
      say: "Three states, closed, open and half-open, and the breaker goes half-open the moment it hands out the trial, so nobody else gets through while it's out.",
      trace: {
        caption:
          'The trial at 300000 fails and moves the opening time, so 599999 is still blocked. The trial at 600000 succeeds, and only then are the three old failure times cleared.',
        head: ['Time (ms)', 'Remote answers', 'Outcome', 'State during the call', 'State after', 'Failure times after'],
        rows: [
          ['0', '500', 'called', 'CLOSED', 'CLOSED', '`[0]`'],
          ['0', '500', 'called', 'CLOSED', 'CLOSED', '`[0, 0]`'],
          ['0', '500', 'called', 'CLOSED', 'OPEN, opened at 0', '`[0, 0, 0]`'],
          ['300000', '500', 'called', 'HALF_OPEN', 'OPEN, opened at 300000', '`[0, 0, 0]`'],
          ['599999', 'not called', 'BLOCKED', 'not called', 'OPEN, opened at 300000', '`[0, 0, 0]`'],
          ['600000', '200', 'called', 'HALF_OPEN', 'CLOSED', '`[]`'],
          ['600000', '200', 'called', 'CLOSED', 'CLOSED', '`[]`'],
        ],
        note: 'Every call is to B. Rows 1 to 6 are the test "failed trial opens it for another cooldown". "State during the call" is the state between `allow` and `record`.',
      },
      pitfalls: [
        'With `>` at the cooldown the call at exactly 300000 ms is blocked, and all three stage 2 tests fail, because each calls at exactly five minutes.',
        'Close the breaker as soon as five minutes pass, with no trial state, and a failed first call is only 1 of 3: `failed trial opens it for another cooldown` gets a 200 where it expects BLOCKED.',
        'Set the state on a failed trial but not `openedAt` and the five minutes still run from the first opening, so the same test gets the same 200 at 599999.',
        'A timer or a background thread to close the breaker brings shared state into code that needs none: the next call only has to compare two numbers.',
      ],
    },
    {
      id: 'per-service',
      title: 'One breaker for each service',
      stage: 3,
      ask: 'A calls both B and C through this one client. Keep them apart: B failing must not block C, and each service has its own failure count and its own five minutes.',
      tests: [
        'open breaker on b does not block c',
        'each service has its own cooldown',
        'recovery of b leaves the failures of c alone',
      ],
      regions: ['breakers-by-service', 'breaker-for', 'execute-per-service'],
      pseudocode: `the client holds:
  breakers: a map from service name to that service's breaker

execute(request):
  breaker = breakers[the request's service]
    if there is none yet: make a closed one and store it
  then exactly stage 2, on that breaker`,
      choice:
        "Keep a `Map<String, Breaker>` keyed by `request.service()`: one whole breaker for each name, and not three maps of failure times, states and opening times. `Breaker` itself doesn't change, which is why the stage is so small. The field becomes the map, and `execute` gains a first line, `Breaker breaker = breakerFor(request.service());`, whose local has the old field's name, so the rest compiles as it stands. `breakerFor` is one call, `breakers.computeIfAbsent(service, s -> new Breaker())`: it returns the breaker stored for that name, or runs the lambda, stores the new closed breaker and returns that. With loose fields on `WebClient`, this stage starts by moving them all into a class.",
      say: "The breaker class doesn't change: I keep a map from service name to breaker and look it up, or create it, at the top of execute.",
      trace: {
        caption:
          "B opened at 0 and C at 180000, so at 300000 B's trial goes while C, two minutes into its own five, is blocked. C's calls at 180000 reach the remote although B is open.",
        head: ['Time (ms)', 'Service', 'Remote answers', 'Outcome', "That service's state after", 'Its failure times after'],
        rows: [
          ['0', 'B', '500', 'called', 'CLOSED', '`[0]`'],
          ['0', 'B', '500', 'called', 'CLOSED', '`[0, 0]`'],
          ['0', 'B', '500', 'called', 'OPEN, opened at 0', '`[0, 0, 0]`'],
          ['180000', 'C', '500', 'called', 'CLOSED', '`[180000]`'],
          ['180000', 'C', '500', 'called', 'CLOSED', '`[180000, 180000]`'],
          ['180000', 'C', '500', 'called', 'OPEN, opened at 180000', '`[180000, 180000, 180000]`'],
          ['300000', 'B', '200', 'called', 'CLOSED', '`[]`'],
          ['300000', 'C', 'not called', 'BLOCKED', 'OPEN, opened at 180000', '`[180000, 180000, 180000]`'],
          ['480000', 'C', '200', 'called', 'CLOSED', '`[]`'],
        ],
        note: 'The test "each service has its own cooldown".',
      },
      pitfalls: [
        'Key the map by path and B and C share one breaker, since every test calls both on the same path: all three tests fail, the first with BLOCKED for a healthy C.',
        "Keep one shared list of failures tagged by service and B's recovery wipes C's two failures: `recovery of b leaves the failures of c alone` gets a 500 where it expects BLOCKED.",
        'Change `execute` to take the service as a second argument and the file stops compiling, because every test calls `execute(request)`.',
      ],
    },
    {
      id: 'threads',
      title: 'Many threads',
      stage: 4,
      ask: 'Now many threads call `execute` at the same time. No failure may be lost. When the five minutes end, exactly one trial goes out and the rest stay blocked until it reports. And a slow call must not hold up the others.',
      tests: [
        'no failure is lost under contention',
        'exactly one trial after the cooldown',
        'a slow call does not hold up the next one',
      ],
      regions: ['concurrent-map', 'allow-locked', 'record-locked'],
      verbal: [
        "I'd make the map of breakers a `ConcurrentHashMap`, so two threads asking for the same service get one breaker.",
        "I'd put `synchronized` on the breaker's `allow` and `record`, so each decision is atomic for one service and only one caller becomes the trial.",
        "I'd never hold that lock across the remote call, because a slow service would then hold up every other call to it, even the ones I'm blocking.",
      ],
      caveat:
        'The threading tests catch a missing lock on most runs and not all: with every `synchronized` removed the first test failed in 47 runs of 50 on a 2-CPU machine, and with it removed from `allow` alone all 30 runs of 30 passed.',
      pseudocode: `breakers: a concurrent map, one breaker for each service

allow(now), holding this breaker's lock:
  as stage 2

record(now, failed), holding this breaker's lock:
  if HALF_OPEN: as stage 2, the trial's answer
  if not CLOSED, or the call worked: nothing to do
    (a late answer from before it opened is ignored)
  add now, drop old failures, open at 3: as before

execute: unchanged
  allow takes the lock and lets go of it
  the remote call runs with no lock held
  record takes the lock again`,
      choice:
        "Lock each breaker's two decisions and never the call between them. `synchronized` on `allow` and `record` locks the one `Breaker`, so B and C don't wait for each other, and it makes several fields change as one step, which an `AtomicInteger` or a `volatile` can't. `synchronized` on `execute` would count correctly and queue every call behind the slowest. Letting go of the lock means the state can change while a call is out, so `record` now returns early on `state != State.CLOSED || !failed`: an answer that arrives while the breaker is OPEN came from a call let through earlier, and is ignored. No supplied test covers that rule.",
      say: 'Because I let go of the lock around the call, the state can change while a call is out, so the trial is chosen inside allow and an answer that comes back after the breaker has opened is ignored.',
      trace: {
        caption:
          "Five threads call at the five-minute mark while the test holds the trial at the remote. Four come back BLOCKED while it is still out, finding HALF_OPEN. Thread-0's answer arrives only when the test lets it go, between rows 7 and 8, and closes the breaker.",
        head: ['Thread', 'Time (ms)', 'Remote answers', 'Outcome', 'State after', 'Failure times after'],
        rows: [
          ['main', '0', '500', 'called', 'CLOSED', '`[0]`'],
          ['main', '0', '500', 'called', 'CLOSED', '`[0, 0]`'],
          ['main', '0', '500', 'called', 'OPEN, opened at 0', '`[0, 0, 0]`'],
          ['Thread-4', '300000', 'not called', 'BLOCKED', 'HALF_OPEN, opened at 0', '`[0, 0, 0]`'],
          ['Thread-3', '300000', 'not called', 'BLOCKED', 'HALF_OPEN, opened at 0', '`[0, 0, 0]`'],
          ['Thread-2', '300000', 'not called', 'BLOCKED', 'HALF_OPEN, opened at 0', '`[0, 0, 0]`'],
          ['Thread-1', '300000', 'not called', 'BLOCKED', 'HALF_OPEN, opened at 0', '`[0, 0, 0]`'],
          ['Thread-0', '300000', '200', 'called', 'CLOSED', '`[]`'],
          ['main', '300000', '200', 'called', 'CLOSED', '`[]`'],
        ],
        note: 'Every call is to B. A smaller run of the test "exactly one trial after the cooldown": 5 threads where the test uses 20, and one more call at the end. The order of the four blocked threads changes from run to run, and nothing promises that Thread-0 is the trial.',
      },
      pitfalls: [
        '`synchronized` on `execute` holds the lock across the remote call, so the 19 threads that should come back BLOCKED wait behind the trial, and the second and third tests fail with `expected true, got false`.',
        'Lock `record` and not `allow` and two threads can both find OPEN with five minutes passed and both go out as the trial.',
        '`volatile` on `state` and `openedAt` keeps each read fresh but leaves check-then-set as two steps, with room for another thread between them.',
        'A `get`, a null check and a `put` in place of `computeIfAbsent` lets two threads each store a breaker for B, even on a `ConcurrentHashMap`.',
      ],
    },
    {
      id: 'replay',
      title: 'Time arrives as data',
      stage: 5,
      variant: true,
      ask: 'Same rules, but now time comes in the input. Each line is "timestampMillis service statusCode": what that service would answer at that moment. For each line tell me ALLOWED or BLOCKED, using the same breaker. A line you cannot read gives INVALID and changes nothing.',
      tests: [
        'replay blocks after the trip and keeps services apart',
        'replay applies the window and the cooldown',
        'unreadable lines are invalid and change nothing',
      ],
      regions: ['replay', 'replay-line'],
      verbal: [
        'Because `allow(now)` and `record(now, failed)` take the time as an argument, the same `Breaker` serves when time arrives as lines of input and there is no clock.',
        "`replayLine` passes each line's timestamp where `execute` passes `clock.millis()`, and it never calls the remote.",
      ],
      pseudocode: `replay(lines):
  one result for each line, in order

for one line:
  trim it and split it on whitespace
  if there are not exactly 3 pieces: INVALID
  time = the first piece as a whole number
  status = the third piece as a whole number
    if either is not a number: INVALID
  breaker = breakers[the second piece], made if missing
  if not breaker.allow(time): BLOCKED
  breaker.record(time, failed if status is 500 or more)
  ALLOWED`,
      choice:
        'Drive the breaker directly and not through `execute`: a clock and a remote that replay the lines would work, but they put test doubles inside the real class. Read the whole line before touching a breaker. It needs exactly three pieces (`parts.length != 3`, so `3 B 500 x` is refused too) and two numbers that parse, or the answer is `INVALID` in that position and no breaker changes. The line that opens the breaker is itself ALLOWED, because its answer did the opening.',
      say: "The breaker already takes the time as an argument, so I'll feed it each line's timestamp and status directly, and a line I can't read gives INVALID in its place and changes nothing.",
      trace: {
        caption:
          'At 600000 the failure from 0 is exactly ten minutes old and drops out, so that line makes 2 and the next makes 3. 900000 is 1 ms short of five minutes after 600001 and is blocked; 900001 is the trial.',
        head: ['Line', 'Result', "B's state after", "B's failure times after"],
        rows: [
          ['`0 B 500`', 'ALLOWED', 'CLOSED', '`[0]`'],
          ['`60000 B 500`', 'ALLOWED', 'CLOSED', '`[0, 60000]`'],
          ['`600000 B 500`', 'ALLOWED', 'CLOSED', '`[60000, 600000]`'],
          ['`600001 B 500`', 'ALLOWED', 'OPEN, opened at 600001', '`[60000, 600000, 600001]`'],
          ['`900000 B 200`', 'BLOCKED', 'OPEN, opened at 600001', '`[60000, 600000, 600001]`'],
          ['`900001 B 200`', 'ALLOWED', 'CLOSED', '`[]`'],
          ['`900002 B 500`', 'ALLOWED', 'CLOSED', '`[900002]`'],
          ['`x B 500`', 'INVALID', 'unchanged', 'unchanged'],
        ],
        note: 'Rows 1 to 7 are the test "replay applies the window and the cooldown". Row 8 is a bad line added to the run.',
      },
      pitfalls: [
        'Copy the window and the cooldown into `replay` and there are two copies of both boundaries to keep in step.',
        'Throw on a bad line, or skip it with no output, and the third test reports the exception in the first case and 4 results for 8 lines in the second.',
        'Read `clock.millis()` inside `replay` and time stands at 0, so the second test shows BLOCKED from the fourth line on.',
        'The deque is oldest first only if the lines are in time order, and nothing in the code checks, so say that you assume it.',
      ],
    },
  ],
  followUps: [
    {
      q: 'Why does a blocked call come back as a `Response` and not as an exception?',
      a: "Because being blocked is an expected outcome while a service is down, so callers handle it on the same path as any other answer. The `blocked` flag tells my refusal apart from a 503 the service itself sent. An exception is a fair choice too, but one forgotten `catch` turns a blocked call into a crash.",
    },
    {
      q: 'What should a caller do with a blocked call?',
      a: "That's the caller's decision; the breaker only reports. Serve a stand-in such as a cached value or a default, queue the work if it can wait and is safe to repeat, or fail fast with a clear error. Never retry at once in a loop, and in production I'd add to the blocked answer how long until the next trial.",
    },
    {
      q: 'What would you measure?',
      a: "Every change of state for each dependency, plus counts of blocked calls, failures by kind and trial outcomes. I'd alert on a breaker that stays open, or one that flaps open and closed. This code records none of it.",
    },
    {
      q: 'How would you choose the 3, the ten minutes and the five minutes?',
      a: "From the dependency's own figures, as configuration for each dependency and never as constants. The count has to sit above its normal background of errors, the window long enough to show a pattern, and the five minutes close to how long it usually takes to recover. I'd start cautious and tune from the record of opens and closes.",
    },
    {
      q: 'Three in a row, three in a window, or a failure rate: which would you use?',
      a: 'A failure rate for anything with real traffic; a count in a window is right for the task as set. Three in a row resets on one success, so a service failing half its calls may never open, and a plain count reaches 3 on a tiny error rate at high traffic. A rate, say over half of at least 20 calls in the last minute, costs counts of both outcomes in time buckets.',
    },
    {
      q: 'What about timeouts and slow calls?',
      a: "Every remote call needs a timeout, and this code has none because the simulated remote answers at once. A timeout arrives as an exception, so it already counts as a failure. In production I'd also count a call that succeeds but is far too slow, which makes the failure rule configuration where here it's fixed.",
    },
    {
      q: 'How do retries interact with the breaker?',
      a: "Badly unless they're designed together: three layers each trying three times turn one request into 27 on a service that's already struggling. I'd put the retry outside the breaker, so every attempt counts and a blocked answer ends the loop at once. Retries also need backoff with jitter and a budget, as on the [retries and breakers page](#/s/retries-breaker).",
    },
    {
      q: 'What grows in memory?',
      a: "Only the map. Each breaker holds at most 3 failure times, because reaching 3 opens it and nothing is added while it's open. The map gains a breaker for every service name it sees and never removes one: fine for B and C, but it needs a bound or an expiry if names come from user input.",
    },
    {
      q: 'You run ten instances of service A with no shared store. What happens?',
      a: "Each instance opens on its own evidence, and I'd usually accept that. B can take up to 30 failed calls before all ten have opened, where one breaker would stop at 3, and after the five minutes up to ten trials go out. A shared breaker in a cache opens sooner, but adds a network hop to every call and a dependency that can itself fail.",
    },
    {
      q: 'What happens if the trial call never answers?',
      a: "The breaker stays half-open and blocks every later call for good, because only the trial's answer moves it on. A timeout on the call fixes that. In production I'd also send several trials and close only when enough of them succeed.",
    },
    {
      q: 'A call that set off before the breaker opened is still running five minutes later and answers during the trial. What does your code do?',
      a: "It gets it wrong, and I left that in on purpose: while the breaker is half-open, `record` takes the next answer to arrive as the trial's, whoever sent it. So a late success closes the breaker and a late failure reopens it for five more minutes. Any timeout shorter than five minutes rules it out; the proper fix is a permit from `allow` that marks the trial.",
    },
  ],
  see: [
    { href: '#/s/retries-breaker', label: 'Retries, backoff and circuit breakers' },
    { href: '#/c/resilience-patterns', label: 'Resilience patterns' },
  ],
  unverified: [
    'That this task is also set with time in the input and no clock, which is why stage 5 is kept as a variant, is as reported to the writer, not checked.',
    'Production practice in the follow-up answers is general knowledge, not checked against a source: breakers that judge a failure rate with a minimum call count, slow calls counted as failures, several trial calls, a retry budget, and what to measure and alert on.',
    'The run counts in the stage 4 caveat (47 of 50, and 30 of 30) each come from one 2-CPU machine under load, and they change with both. A re-run on 20 November on the present `solution/s4` gave 29 failing runs of 30 with every `synchronized` removed, and 30 passing runs of 30 with it removed from `allow` alone.',
    'How often the tests catch a plain `HashMap` in stage 4 was measured twice with different results (30 failing runs of 30, and 12 of 30), so the page quotes no figure for it.',
    "The follow-up answers on ten instances, on retries and on choosing the numbers were reasoned from this code's rules; none was built or measured.",
    'The page calls one service becoming many a two-line change. In `solution/s3` it is one changed field, one new line in `execute` and a three-line helper, `breakerFor`; it is two lines only with the `computeIfAbsent` call written inline.',
    'The 59 lines in `testing.intro` are the lines of the "Your code" section of `solution/s3` that the starter does not have, less blank lines and region markers. One of the 59 is a comment.',
  ],
};

export default page;
