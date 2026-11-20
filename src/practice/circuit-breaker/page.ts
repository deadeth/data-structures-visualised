import type { Practice } from '../types';

const page: Practice = {
  id: 'circuit-breaker',
  title: 'Circuit breaker',
  summary:
    'Wrap a web client so that three failures from a downstream service within ten minutes stop calls to it for five minutes, then let one trial call through. The code is short. What it tests is time: a window that slides, two boundaries that are one comparison each, and three states, all checked with a fake clock and no sleeping.',
  minutes: 40,
  core: 3,
  brief: [
    '"Here is a small web client. Service A uses it to call two downstream services, B and C. The remote calls are simulated for you. Implement `execute` so that when a downstream service keeps failing we stop calling it for a while: three failures within ten minutes means no calls to that service for the next five minutes. After that, try again."',
    'A blocked call must not reach the remote. It returns `Response.BLOCKED` at once: status 503 with the `blocked` flag set.',
    'That leaves out what a failure is, whether the ten minutes slide, and how much "try again" lets through. Ask before you type.',
  ],
  given: [
    '`record Request(String service, String path)`. The request names the service it is for. A record gives you the accessors `service()` and `path()`; there is no `getService()`. Only the tests use the path.',
    '`record Response(int status, boolean blocked)`, with `Response.of(status)` for an ordinary answer and the constant `Response.BLOCKED`, which is 503 with `blocked` set. Records compare by value, so the tests can compare whole responses.',
    'Two one-method interfaces: `Remote`, with `Response call(Request request)`, and `Clock`, with `long millis()`. Read the time from the clock you are given and never from `System.currentTimeMillis()`.',
    '`FakeRemote` and `FakeClock`. `respond(service, status)` sets what a service answers from then on (200 until told; `-1` makes it throw `IllegalStateException`), and `calls(service)` counts the calls that really reached it. The clock starts at 0 and moves only when a test calls `advance`. Nothing sleeps.',
    'The `WebClient` shell: two constructors and five fields, `remote`, `clock`, `maxFailures`, `windowMillis` and `cooldownMillis`. The defaults are 3, ten minutes and five minutes, already turned into milliseconds. Use the fields: you never type 3, 600000 or 300000.',
    'Two stubs that throw `UnsupportedOperationException`: `execute(Request)` for stage 1 and `replay(List<String>)` for stage 4. No stage changes either signature.',
    'The imports, including `java.util.*` and `java.util.concurrent.*`. `ArrayDeque`, `HashMap` and `ConcurrentHashMap` need no import line.',
    'The tests of all five stages and their helper, `Env`: `answer(service, status, times)` sets the answer and calls that many times, `trip(service)` makes three 500 calls and then sets the service to answer 200, `after(millis)` moves the clock, `hit(service)` makes one call. Set `STAGE` and run `main`. With the starter untouched the four stage 1 tests fail with `threw java.lang.UnsupportedOperationException: stage 1` and nothing crashes.',
  ],
  ask: [
    {
      q: 'What counts as a failure: any 5xx, a 4xx, an exception?',
      why: "It decides what opens the breaker. A 400 or a 404 means the caller sent something wrong and the service is healthy, so counting it lets one caller's bad input block everyone's good calls. In the code the whole answer is one comparison, `status >= 500`, and one `catch`.",
      assume: 'A 5xx answer or an exception is a failure, and a timeout would arrive as an exception. A 2xx or a 4xx is not.',
    },
    {
      q: 'Is "three failures within ten minutes" any three inside a sliding ten minutes, or three in a row? Does a success in between reset the count?',
      why: 'It picks the data structure. Three in a row is one `int` that a success sets back to 0. Three inside a sliding ten minutes needs the time of each recent failure, because the oldest has to drop out alone at the moment it turns ten minutes old.',
      assume: "A sliding window by time, and a success in between resets nothing. I'll keep the times of recent failures and count the ones under ten minutes old.",
    },
    {
      q: 'After the five minutes, does everything go through again, or one call first to see?',
      why: '"Try again" can mean either. If every waiting caller goes through at once, a service that has only just come back takes the whole backlog and can fall over again. One trial call means a third state, and you have to say what a failed trial does.',
      assume: 'One trial call. If it succeeds, the breaker closes and forgets its old failures. If it fails, the breaker stays open for another full five minutes, counted from the trial.',
    },
    {
      q: 'Is the count kept for each downstream service, or one for the whole client?',
      why: 'The brief says "that service", so B failing should not cut off C. Confirm it now because it decides where the state lives: put it in a small class of its own and "per service" later becomes a map of that class.',
      assume: "Per service, keyed by the service name on the request. I'll get one service right first and key it afterwards.",
    },
    {
      q: 'On the two edges: is a failure exactly ten minutes old still in the window, and is a call exactly five minutes after opening blocked or let through?',
      why: 'Each answer is one comparison operator, `>=` or `>`, and the tests sit on those exact milliseconds. Asking takes ten seconds and turns the operator from a guess into a decision you made aloud.',
      assume: 'A failure exactly ten minutes old no longer counts, and exactly five minutes after opening counts as after, so the trial goes. Both are `>=` on an age.',
    },
    {
      q: 'If the remote throws, do you want the exception passed on to the caller?',
      why: 'The breaker has to count it either way. Swallowing it, or inventing a response for it, changes what every caller of the client sees. Counting it and rethrowing keeps the client transparent apart from blocking.',
      assume: 'Count it as a failure and rethrow it unchanged.',
    },
    {
      q: 'Will `execute` be called from several threads at once?',
      why: 'It decides whether the check and the update need a lock, and whether two callers can both become the trial. Raising it early also lets you say that a remote call must never sit inside a lock.',
      assume: "One thread for now. I'll keep each service's state in one object so a lock can go on it later.",
    },
  ],
  outline: `for each service, keep one breaker:
  a state: closed, open or half-open
  when it last opened
  the times of its recent failures, oldest first

execute a request:
  find the breaker for the request's service, or make one
  ask it "may this call go?" now; if no, answer BLOCKED
  call the remote, holding no lock
  tell the breaker the time now and whether the call failed:
    it threw (pass the exception on), or status 500 or more

may this call go?
  closed: yes
  open for five minutes or more: become half-open; yes,
    and this call is the trial
  otherwise: no

the call came back:
  half-open and it failed: open again, from now
  half-open and it worked: close, forget every failure
  closed and it failed: add the time to the failures,
    drop the ones ten minutes old or more;
    if 3 are left: open, from now
  anything else: nothing to do

replay a line of "time service status":
  the same two questions, with the line's time and status`,
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
      regions: ['execute', 'one-breaker', 'breaker'],
      explain: [
        'Keep the time of each recent failure in a deque, oldest first. On each failure add the new time at the back, drop times from the front while they are ten minutes old or more, and count what is left. The ten minutes slide, so the oldest failure has to leave alone, at its own moment, and only a list of times can do that. `ArrayDeque` is the idiom: `addLast`, `peekFirst` and `removeFirst` each take constant time.',
        'A counter is the obvious alternative, and it is wrong whichever way you write it. A bare `int` never forgets. Failures at minutes 0, 9, 18 and 27 are four spread over thirty minutes with never more than 2 inside any ten, yet the counter reads 3 at minute 18 and opens. The deque holds 2 at that moment and stays closed. Give the counter a reset and you have to say when. Reset it on a ten-minute timer and failures at minutes 8, 9 and 11 fall either side of the reset at minute 10: the counter reads 2, then 1, and stays closed with three failures inside three minutes. Reset it on a success and you have written a different rule, three in a row. No supplied test catches that last one, so it stays hidden until somebody asks.',
        'The cost is small and bounded. Reaching 3 opens the breaker and nothing is added while it is open, so a service never holds more than **3 timestamps**. Each time is added once and removed at most once, so a failure costs constant work on average, and a success never touches the deque. The boundary is the comparison in the loop, `now - failures.peekFirst() >= windowMillis`. With `>=` a failure exactly ten minutes old is dropped: the window is the last ten minutes with its far edge left out. The fourth test sits on that millisecond.',
        'The state lives in a small inner class, `Breaker`, although there is only one of it. That is what makes stage 3 a one-field change. It is an inner class and not a static one, so it reads the client\'s `maxFailures` and `windowMillis` without being handed them. The breaker never reads the clock: `execute` reads `clock.millis()` and passes the time in. Keep to that, because it is why the same class can later be driven by times that arrive as data. In this stage an open breaker never closes again; that is stage 2.',
        "Type it in this order. First make `execute` the one line `return remote.call(request);` and run. Two of the four tests pass, which shows the editor compiles your code and which two tests are about the breaker. Then write `execute` in full against two methods that don't exist yet, `breaker.allow()` and `breaker.record(time, failed)`: ask, call, tell. Then write `Breaker` to satisfy them, starting with the deque.",
      ],
      lines: [
        {
          code: 'private final Deque<Long> failures = new ArrayDeque<>();',
          note: 'The idiom for a queue you trim from the front. `addLast` puts the newest at the back, so the oldest is always the one `peekFirst` returns.',
        },
        {
          code: 'while (now - failures.peekFirst() >= windowMillis) {',
          note: "The boundary. `>=` drops a failure exactly ten minutes old; with `>` it stays, and the fourth test gets BLOCKED where it expects a 500. `peekFirst()` can't return `null` here: `now` went in on the line above and its age is 0, so the loop stops there at the latest.",
        },
        {
          code: 'breaker.record(clock.millis(), response.status() >= 500);',
          note: 'The whole definition of a failed response: 500 and up. A 404 is below it. The clock is read again here, after the call, because a failure happens when the answer comes back and not when the call set off.',
        },
        {
          code: 'throw e;',
          note: 'The exception was counted on the line above and still reaches the caller unchanged. Catching `RuntimeException` is enough, because `Remote.call` declares no checked exceptions.',
        },
      ],
      trace: {
        caption:
          'At 600000 ms, exactly ten minutes, both failures from time 0 leave together. The third failure overall is alone in the window, and it takes two more to open.',
        head: ['Time (ms)', 'Remote answers', 'Outcome', 'Open after', 'Failure times after'],
        rows: [
          ['0', '500', 'called', 'false', '`[0]`'],
          ['0', '500', 'called', 'false', '`[0, 0]`'],
          ['600000', '500', 'called', 'false', '`[600000]`'],
          ['600000', '500', 'called', 'false', '`[600000, 600000]`'],
          ['600000', '500', 'called', 'true', '`[600000, 600000, 600000]`'],
          ['600000', 'not called', 'BLOCKED', 'true', '`[600000, 600000, 600000]`'],
        ],
        note: 'Every call is to B. Rows 1 to 4 are the test "failure exactly ten minutes old no longer counts". Rows 5 and 6 add one more failure and one more call, to show the breaker open.',
      },
      say: "I'll keep the time of each failure in a deque, oldest first, because the ten minutes slide and a counter can't forget one failure at a time. A failure is a 5xx or an exception, and one that's exactly ten minutes old has dropped out.",
      pitfalls: [
        'Counting a 4xx. With `>= 400`, three 404s open the breaker and the second test gets BLOCKED where it expects the 404 back.',
        'Writing `>` in the window loop, or leaving the loop out. Both keep a failure that is exactly ten minutes old, and the fourth test gets BLOCKED where it expects a 500.',
        'Catching the exception without rethrowing, or rethrowing without recording. The third test fails either way: `expected 3, got 0` in the first case, `threw java.lang.IllegalStateException: no route to service` in the second.',
        'Calling the remote before asking the breaker. A blocked call still reaches the service, and the first test counts 4 calls where it expects 3.',
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
      regions: ['states', 'breaker-with-cooldown', 'execute-with-time'],
      explain: [
        'The decision is three named states where stage 1 had one boolean: `CLOSED`, `OPEN` and `HALF_OPEN`, with `openedAt` beside them. You could keep the boolean and add a second for "a trial is out", but two booleans make four combinations and one of them means nothing. The enum makes half-open a thing you can point at, and half-open is the state people leave out.',
        'Each move between states has one home. `allow(now)` makes the only move that time causes: OPEN to HALF_OPEN once `now - openedAt >= cooldownMillis`, and the call that asked is the trial. `record` makes the three moves an answer causes: CLOSED to OPEN on the third failure, HALF_OPEN to CLOSED on a good trial, HALF_OPEN back to OPEN on a bad one. Nothing runs on a timer. The breaker learns that five minutes have passed only when a call asks, by comparing two numbers.',
        "The move to HALF_OPEN happens when the trial is handed out, before the remote is called, and not when its answer comes back. With one thread you can't see the difference. It is there for stage 5: a second caller who arrives while the trial is still out finds HALF_OPEN, which `allow` refuses, so only one trial goes.",
        '**Clear the failure times when the trial succeeds.** The three failures that opened the breaker are five minutes old at that point, still inside the ten-minute window. Leave them in and the first failure after recovery makes four in the window, so the breaker opens again on one failure where the rule says three. The test `recovery forgets earlier failures` opens the breaker, recovers, then fails three times and expects the third call to come back as a 500. Without `failures.clear()` it gets BLOCKED, because the first of the three already reopened the breaker.',
        'A failed trial calls `open(now)`, which sets `openedAt` again, so "another five minutes" runs from the trial and not from the first time it opened. Since stage 1, `boolean open` became `state` and `openedAt`, `allow` takes the time, `record` gained a branch at the top, and `execute` changed by one argument. Type the enum line first, then `open(now)`, then `allow`, then the new branch in `record`, and last pass `clock.millis()` to `allow`.',
      ],
      lines: [
        {
          code: 'if (state == State.OPEN && now - openedAt >= cooldownMillis) {',
          note: '`>=` makes exactly five minutes count as after: the first test is blocked at 299999 ms and let through at 300000. The test for `State.OPEN` is also what refuses a second caller during the trial, because HALF_OPEN falls through to `return false`.',
        },
        {
          code: 'state = State.HALF_OPEN;',
          note: 'Set inside `allow`, before the remote is called. The trial is marked as out at the moment it is handed over.',
        },
        {
          code: 'failures.clear();',
          note: 'The line that is easy to forget. Only a successful trial reaches it. While the breaker is open the old times stay in the deque and nothing reads them.',
        },
        {
          code: 'openedAt = now;',
          note: 'Runs when the breaker first opens and again on a failed trial, so the next five minutes are measured from the trial.',
        },
      ],
      trace: {
        caption:
          'Follow the state through both outcomes of a trial. The trial at 300000 fails and moves the opening time to 300000, so 599999 is still blocked and the next trial goes at 600000. That one succeeds, and only then are the three old failure times cleared.',
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
        note: 'Every call is to B. Rows 1 to 6 are the test "failed trial opens it for another cooldown"; row 7 is one more call, an ordinary one now that the breaker is closed. "State during the call" is the state between `allow` and `record`.',
      },
      say: "Three states: closed, open, half-open, and the breaker goes half-open the moment it hands out the trial, so nobody else gets through while it's out. If the trial works I close and clear the old failures, because they're still inside the ten minutes and one more would open it again; if it fails, the five minutes start again from now.",
      pitfalls: [
        'Leaving out `failures.clear()`. The breaker recovers, then opens again on the very next failure, and `recovery forgets earlier failures` gets BLOCKED where it expects a 500.',
        'Writing `>` at the cooldown. The call at exactly 300000 ms is blocked, and all three stage 2 tests fail, because each of them calls at exactly five minutes.',
        'Closing the breaker and clearing it as soon as five minutes pass, with no trial state. A failed first call then counts as 1 of 3 and the next caller goes straight through: `failed trial opens it for another cooldown` gets a 200 where it expects BLOCKED.',
        'Setting the state on a failed trial but not `openedAt`. The five minutes still run from the first opening, the call at 599999 goes through, and the same test gets the same 200.',
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
      pseudocode: `the client holds:
  breakers: a map from service name to that service's breaker

execute(request):
  breaker = breakers[the request's service]
    if there is none yet: make a closed one and store it
  then exactly stage 2, on that breaker`,
      regions: ['breakers-by-service', 'breaker-for', 'execute-per-service'],
      explain: [
        'The decision is what the map holds: one `Breaker` for each service name, and not three maps side by side for failure times, states and opening times. Everything about one service stays in one object, so nothing inside `Breaker` changes, and "per service" is stage 2 run once for each name. In stage 5 that object is also the thing you lock.',
        'The key is `request.service()`. Keying by path would put B and C on one breaker whenever they share a path, and would split one sick service across many breakers, each seeing too few failures to open. No public signature changes, because the request already names its service.',
        '`computeIfAbsent` is the idiom. It returns the breaker for the key; if there is none it runs the lambda, stores the new closed breaker and returns that. One line replaces a `get`, a null check and a `put`. The lookup takes constant time. Memory is one breaker for each service name ever seen, each with at most 3 timestamps, and none is ever removed. That is fine for B and C and would not be for names that come from user input.',
        'This stage is three edits if stage 1 put the state in its own class. Change the field to a `Map<String, Breaker>` holding a `HashMap`. Add `breakerFor`. Put `Breaker breaker = breakerFor(request.service());` as the first line of `execute`. The local variable has the old field\'s name, so the rest of the method stays as it is. If your state is loose fields on `WebClient`, stop and move it into a class first: that move is this stage.',
      ],
      lines: [
        {
          code: 'private final Map<String, Breaker> breakers = new HashMap<>();',
          note: 'A plain `HashMap` is right for one thread. Stage 5 changes this one word.',
        },
        {
          code: 'return breakers.computeIfAbsent(service, s -> new Breaker());',
          note: 'The first call to a new service creates a closed breaker for it. Every later call gets the same object back.',
        },
        {
          code: 'Breaker breaker = breakerFor(request.service());',
          note: 'The only new line in `execute`. The local takes the name the field had, so the lines below it compile unchanged.',
        },
      ],
      trace: {
        caption:
          "Two sets of five minutes run side by side. B opened at 0 and C at 180000, so at 300000 B's trial goes while C, two minutes into its own five, is blocked. C's trial goes at 480000. C's three calls at 180000 reach the remote although B is open.",
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
      say: "The breaker class doesn't change: I keep a map from service name to breaker and look it up, or create it, at the top of execute. B and C each get their own window and their own five minutes.",
      pitfalls: [
        'Keying the map by path. Every test here calls B and C on the same path, so they share one breaker and all three tests fail, the first with BLOCKED for a healthy C.',
        "Keeping one shared list of failures tagged by service. Clearing it when B recovers wipes C's two failures, and `recovery of b leaves the failures of c alone` gets a 500 where it expects BLOCKED.",
        'Changing `execute` to take the service as a second argument. Every test calls `execute(request)`, so the file stops compiling.',
      ],
    },
    {
      id: 'replay',
      title: 'Time arrives as data',
      stage: 4,
      ask: 'Same rules, but now time comes in the input. Each line is "timestampMillis service statusCode": what that service would answer at that moment. For each line tell me ALLOWED or BLOCKED, using the same breaker. A line you cannot read gives INVALID and changes nothing.',
      tests: [
        'replay blocks after the trip and keeps services apart',
        'replay applies the window and the cooldown',
        'unreadable lines are invalid and change nothing',
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
      regions: ['replay', 'replay-line'],
      explain: [
        'Some versions of this exercise give you no clock at all. Time arrives in the input, a line at a time, and you say what the breaker would have done. **The same `Breaker` serves both, untouched**, because `allow` and `record` take the time as an argument and never read a clock. That choice was made in stage 1, when `execute` read `clock.millis()` and passed it in. Here `replayLine` passes the line\'s timestamp where `execute` passes the clock\'s.',
        'So the decision is to drive the breaker directly and not to go through `execute`. The obvious alternative builds a fake clock and a fake remote from the lines and calls `execute` once for each. It works, but it puts test doubles inside the real class and is far more to type. `replay` never calls the remote and never reads the clock; the first test checks that the fake remote saw 0 calls.',
        'Decide what a bad line does and say it. Here it gives `INVALID` in that position, touches no breaker and carries on, so the output always has one entry for each input line. Read everything before you touch a breaker: both numbers are parsed first and only then does `breakerFor` run, so a half-good line such as `3 B 500 x` cannot count as a failure. Throwing on the first bad line is a fair choice for a strict batch job. It loses the whole replay to one bad log line.',
        'Two things in the output are easy to misread. The line that opens the breaker is itself ALLOWED: it was let through, and its answer opened the breaker. And on a BLOCKED line the status is never used, because a blocked call has no answer. The work is one pass over the lines with constant work for each.',
        "Type `replay` first, as a loop that adds `replayLine(line)` to a list. Then `replayLine` from the top: the split, the length check, the two parses inside one `try`, and last the same three breaker calls `execute` makes: `breakerFor`, `allow`, `record`. If you're handed this version from the start, with no `Clock` and no `Remote`, build `Breaker` exactly as in stages 1 and 2 and write `replayLine` in place of `execute`.",
      ],
      lines: [
        {
          code: 'String[] parts = line.trim().split("\\\\s+");',
          note: 'The pattern is one or more whitespace characters, with the backslash doubled inside a Java string. An empty line still splits into one empty piece, so the length check below catches it. `trim()` comes first because a leading space would give an empty first piece and make a good line look like four.',
        },
        {
          code: 'if (parts.length != 3) {',
          note: '`!=` and not `<`: a line with a fourth piece is unreadable too. With `<`, the line `3 B 500 x` counts as a failure and the third test sees the breaker open one line early.',
        },
        {
          code: 'if (!breaker.allow(at)) {',
          note: "The line's own time goes in where `execute` passes `clock.millis()`. This call is the whole reason the breaker takes time as an argument.",
        },
        {
          code: 'breaker.record(at, status >= 500);',
          note: 'The same failure rule as `execute`, written a second time. If the rule grew, it would move into one method that both call.',
        },
      ],
      trace: {
        caption:
          'Both boundaries in one run. At 600000 the failure from 0 is exactly ten minutes old and drops out, so that line makes 2 and the next makes 3. 900000 is 1 ms short of five minutes after 600001 and is blocked; 900001 is the trial. The line that opens the breaker reads ALLOWED.',
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
        note: 'Rows 1 to 7 are the lines of the test "replay applies the window and the cooldown". Row 8 is one bad line added to the run: it returns INVALID and no breaker is touched.',
      },
      say: "The breaker already takes the time as an argument, so I'll feed it each line's timestamp and status directly, with no clock and no remote. A line I can't read gives INVALID in its place and changes nothing, so the output lines up with the input.",
      pitfalls: [
        'Copying the window and the cooldown into `replay`. Now there are two copies of both boundaries to keep in step, and the next change lands in only one of them.',
        'Throwing on a bad line, or skipping it with no output. The third test reports the exception in the first case and a list of 4 results for 8 lines in the second.',
        'Reading `clock.millis()` inside `replay`. The fake clock stands at 0 for the whole test, so no failure ages and the five minutes never end: the second test shows BLOCKED from the fourth line on.',
        'Assuming the lines are in time order without saying so. The deque is oldest first only if times never go backwards, and nothing in the code checks.',
      ],
    },
    {
      id: 'threads',
      title: 'Many threads',
      stage: 5,
      ask: 'Now many threads call `execute` at the same time. No failure may be lost. When the five minutes end, exactly one trial goes out and the rest stay blocked until it reports. And a slow call must not hold up the others.',
      tests: [
        'no failure is lost under contention',
        'exactly one trial after the cooldown',
        'a slow call does not hold up the next one',
      ],
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
      regions: ['concurrent-map', 'allow-locked', 'record-locked'],
      explain: [
        'The decision is where the lock goes and, above all, where it does not. Put `synchronized` on `allow` and on `record`, which locks the one `Breaker` they belong to, and leave `execute` alone so that **the remote call runs with no lock held**. The obvious alternative is `synchronized` on `execute`. It counts correctly and breaks the third requirement: every call through the client queues behind the slowest one, and a blocked call, which should return at once, waits for a remote call to finish.',
        "Each decision reads and writes several fields as one step: add a time, trim, compare the size, set the state, set `openedAt`. Or: check the state and the five minutes, then become HALF_OPEN. An `AtomicInteger` or a `volatile` field protects one variable at a time and can't make that sequence one step. `synchronized` can, in one word and with no `try` and `finally`. One lock for each breaker means B and C never wait for each other. The map becomes a `ConcurrentHashMap`, whose `computeIfAbsent` creates exactly one breaker for a name even when two threads ask together.",
        'Letting go of the lock around the call means the state can change between `allow` and `record`, so the code has to say what happens to an answer that arrives late. Two rules cover it. The trial is chosen inside `allow`: the first thread to find OPEN with five minutes passed sets HALF_OPEN under the lock, and every thread after it finds HALF_OPEN and is refused. And `record` ignores an answer that arrives while the breaker is OPEN. It belongs to a call let through before the breaker opened, and without the rule its failure would start the five minutes again. That is the one changed condition in `record`: `!failed` became `state != State.CLOSED || !failed`.',
        'Be exact about what the three tests show. A lock that is too wide fails the second and third. A missing lock on `record` loses failures, and the first test catches that on most runs, not every run: with every `synchronized` removed it failed in 47 runs of 50 on a 2-CPU machine. With `synchronized` taken off `allow` alone, 30 runs of 30 passed, because two threads have to reach the same few instructions together. And no supplied test covers the late-answer rule. Those two are in the code because you can read the race, and that is what to say.',
        "Type three things. `HashMap` becomes `ConcurrentHashMap`; its import is already at the top of the file. Add `synchronized` to `allow` and to `record`. Widen the early return in `record`. Don't touch `execute`. Raise `STAGE` to 5 before any of it and run: on the unlocked stage 4 code the first test failed on each of 30 runs here and the other two passed, which tells you those two are there for the lock that is too wide.",
      ],
      lines: [
        {
          code: 'private final Map<String, Breaker> breakers = new ConcurrentHashMap<>();',
          note: "With a plain `HashMap` two threads can each create a breaker for B and split its failures between them. Don't count on the tests to say so: with both locks kept and only this line wrong, 18 runs of 30 passed on a 2-CPU machine.",
        },
        {
          code: 'synchronized boolean allow(long now) {',
          note: 'The lock is the `Breaker` object itself, so each service has its own. Finding OPEN and setting HALF_OPEN happen as one step, which is what makes it exactly one trial.',
        },
        {
          code: 'synchronized void record(long now, boolean failed) {',
          note: 'The same lock as `allow`. Without it two threads add to the `ArrayDeque` at once, and a failure is lost or the deque is left broken.',
        },
        {
          code: 'if (state != State.CLOSED || !failed) {',
          note: "Stage 4's `if (!failed)` with one more case. An answer that arrives while the breaker is OPEN came from a call let through before it opened, and is dropped. HALF_OPEN never reaches this line, because the branch above returned.",
        },
      ],
      trace: {
        caption:
          "Five threads call at the five-minute mark while the test holds the trial at the remote. Four come back BLOCKED while the trial is still out, and the state they find is HALF_OPEN. Thread-0's answer arrives only after the test lets it go, between rows 7 and 8, and closes the breaker.",
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
        note: 'Every call is to B. A smaller run of the test "exactly one trial after the cooldown", with 5 threads where the test uses 20, and one more call at the end. The order of the four blocked threads changes from run to run. Thread-0 was the trial in each run made, which the code does not promise.',
      },
      say: "I'll lock each breaker's two decisions, allow and record, and not the remote call, so a slow service can't hold up anyone else, not even the calls I'm blocking. The trial is chosen inside allow, under the lock, so only one thread gets it, and an answer that comes back after the breaker has opened is ignored.",
      pitfalls: [
        '`synchronized` on `execute`. The counts are right, but the lock is held across the remote call, so the 19 threads that should come back BLOCKED wait behind the trial, and the second and third tests fail with `expected true, got false`.',
        'Locking `record` and not `allow`. No failure is lost, but two threads can both find OPEN with five minutes passed and both go out as the trial. The tests passed 30 runs of 30 with this bug in, so only reading the code finds it.',
        'Making `state` and `openedAt` `volatile` in place of a lock. Each read is fresh, but check-then-set is still two steps and another thread can run between them.',
        'A `get`, a null check and a `put` on the map in place of `computeIfAbsent`. Two threads can both find nothing and each store a breaker of its own, even on a `ConcurrentHashMap`.',
      ],
    },
  ],
  followUps: [
    {
      q: 'Why does a blocked call come back as a `Response` and not as an exception?',
      a: [
        "Because being blocked is an expected outcome while a service is down, and I want callers to handle it on the same path as any other answer.",
        "503 already means try later, so code that only reads the status does something sensible, and the `blocked` flag tells my refusal apart from a 503 the service itself sent.",
        "An exception is a fair choice too. Its cost is that one forgotten `catch` turns a blocked call into a crash.",
      ],
    },
    {
      q: 'What should count as a failure?',
      a: [
        'Whatever says the service is unhealthy: connection errors, timeouts and 5xx answers.',
        "A 4xx is the caller's mistake and the service is fine, so counting it would let one bad client block everyone.",
        "In production I'd also count a call that succeeds but is far too slow, and I'd treat a 429 on its own, since it means slow down more than it means broken. That makes the rule configuration, which this code doesn't have.",
      ],
    },
    {
      q: 'What should a caller do with a blocked call?',
      a: [
        'It depends on what the call was for, so the caller decides and the breaker only reports.',
        "If there's a sensible stand-in, serve it: a cached value, a default, the page without that panel. If the work can wait and is safe to repeat, queue it. Otherwise fail fast with a clear error to its own caller.",
        "What it mustn't do is retry at once in a loop. That's busy-waiting on a breaker that won't change for five minutes.",
      ],
    },
    {
      q: 'Three in a row, three in a window, or a failure rate: which would you use?',
      a: [
        "A failure rate for anything with real traffic. The count in a window that I've written is right for the task as set.",
        'Three in a row is simplest, but one success resets it, so a service failing half its calls may never open. A count in a window ignores successes, so at high traffic a tiny error rate reaches 3.',
        'A rate, say over half of at least 20 calls in the last minute, scales with traffic. It costs counts of both outcomes, kept in time buckets.',
      ],
    },
    {
      q: 'How would you choose the 3, the ten minutes and the five minutes?',
      a: [
        "From the dependency's own numbers, and as configuration for each dependency, never as constants.",
        'The count has to sit above its normal background of errors, the window has to be long enough to show a pattern, and the five minutes should be close to how long it usually takes to recover.',
        "I'd start cautious, record every open and close, and tune from that. Too sensitive and I block a healthy service; too slow and callers queue on a dead one.",
      ],
    },
    {
      q: 'How do retries interact with the breaker?',
      a: [
        "Badly, unless they're designed together, because retries multiply load on a service that's already struggling. Three layers each trying three times turn one request into 27.",
        "I'd put the retry outside the breaker, so the breaker sees every attempt and a blocked answer ends the retry loop at once.",
        'Each attempt is a real call, so each failure counts: with these numbers one request that fails three attempts opens the breaker by itself. So retries need backoff with jitter and a budget, as on the [retries and breakers page](#/s/retries-breaker).',
      ],
    },
    {
      q: 'You run ten instances of service A with no shared store. What happens?',
      a: [
        "Each instance has its own breakers and opens on its own evidence, and I'd usually accept that.",
        'The cost is that B can take up to 30 failed calls before all ten have opened, where one breaker would stop at 3, and after the five minutes up to ten trials go out where I wanted one.',
        'A shared breaker in a cache or a database opens sooner, but it adds a network hop to every call and a new dependency that can itself fail.',
      ],
    },
    {
      q: 'Why `synchronized`, and why not hold the lock across the remote call?',
      a: [
        "`synchronized` because each decision touches several fields at once: the failure times, the state and when it opened. Atomics guard one variable each.",
        "Not across the call, because then every call to that service waits behind the slowest one, and a call I'm blocking can't return until a remote call finishes.",
        "The cost of letting go is that the state can change while a call is out. So the trial is chosen inside `allow`, and an answer that arrives while the breaker is open is ignored.",
      ],
    },
    {
      q: 'What do your concurrency tests prove?',
      a: [
        "Less than they seem to. They do prove the lock isn't too wide: a slow call doesn't hold up the next one, and blocked callers return while the trial is still out.",
        'They usually catch a lost update: with every lock removed, the contention test failed in 47 runs of 50 on a 2-CPU machine.',
        "They don't catch a missing lock on `allow`: 30 runs of 30 passed without it. That lock I'd defend by reading the code.",
      ],
    },
    {
      q: 'A call that set off before the breaker opened is still running five minutes later and answers during the trial. What does your code do?',
      a: [
        "It gets it wrong, and I left that in on purpose. While the breaker is half-open, `record` takes the next answer to arrive as the trial's, whoever sent it.",
        "So a late success closes the breaker while the real trial is still out, and a late failure reopens it for five more minutes.",
        "It needs a call that runs for longer than five minutes, so any timeout shorter than that rules it out. The proper fix is a permit from `allow` that marks the trial, so that `record` acts on half-open only for that call.",
      ],
    },
  ],
  mistakes: [
    'Typing before asking what a failure is and whether the ten minutes slide. Both answers change the first data structure you write.',
    "Counting with an `int` and adding resets as tests fail. The deque of times is about ten lines and right the first time; the counter can't be made right.",
    'Putting the state in loose fields on `WebClient`. Stages 1 and 2 pass, and then stage 3 means moving every field into a class with the clock running.',
    'Starting a timer or a background thread to close the breaker after five minutes. Nothing needs to run: the next call compares two numbers.',
    'Polishing stage 1 past minute 20. Stage 2 is about twenty lines and stage 3 is three edits, but only if they get the second half of the 40 minutes.',
    'Working out the three states in your head when a test fails. Print the state and the failure times after each call; the run tables on this page are that output.',
  ],
  see: [
    {
      href: '#/s/retries-breaker',
      label: 'Retries, backoff and circuit breakers',
      why: 'The same breaker, animated: 3 failures within 10 ticks open it, calls fail fast, and after 4 ticks one probe decides. It also shows the retry storm from the follow-up question.',
    },
    {
      href: '#/c/resilience-patterns',
      label: 'Resilience patterns',
      why: 'Where a breaker sits among timeouts, retries, bulkheads and fallbacks. Its circuit breakers section argues for a failure rate with a minimum call count over a raw count like this one.',
    },
    {
      href: '#/s/fifo-queue',
      label: 'Queue',
      why: 'How the failure times are held: join at the back, leave from the front, oldest first.',
    },
    {
      href: '#/s/token-bucket',
      label: 'Token bucket',
      why: 'The retry budget named in the retries answer is one of these: calls earn tokens and retries spend them.',
    },
  ],
  simplified: [
    'No timeout on the remote call. The simulated remote answers at once. A real call needs one, and stage 5 assumes it is shorter than the five minutes.',
    'A gap kept on purpose in stage 5: while the breaker is half-open, `record` takes the next answer to arrive as the trial\'s. An ordinary call that set off before the breaker opened and is still running five minutes later can therefore close it, or reopen it, in place of the real trial. A timeout shorter than five minutes rules that out. An earlier draft of this solution closed the gap by having `allow` return a permit marked ordinary or trial. It worked, and it was dropped because it added an enum and a parameter for a case the timeout already covers.',
    'A trial that never answers leaves the breaker half-open for good and every later call blocked, because only an answer moves it on. So does a trial that ends in a `java.lang.Error`, which `execute` does not catch.',
    'One trial call. There is no setting for several trials, or for closing only when enough of them succeed.',
    'A count of failures in a window. No failure rate, no minimum number of calls, no rule for slow calls.',
    'A failure is fixed as a status of 500 or more, or any `RuntimeException`. Nothing can be set by status or by exception type.',
    'Breakers are never removed from the map.',
    '`replay` shares its breakers with `execute` on the same client, trusts the lines to be in time order, and accepts any whole number as a status: `-5` parses and counts as a success.',
    'A blocked response says nothing about when to try again.',
    'No metrics, no logging and no events when the state changes.',
    'The stage 5 tests can pass on wrong code; the run counts are in that stage. No supplied test covers the rule that ignores an answer arriving while the breaker is open. It was checked for this page with a one-off run: with the rule a call at five minutes is the trial, and without it the same call is blocked.',
  ],
  unverified: [
    'That some versions of this exercise give time in the input and no clock is as reported to the writer, not checked.',
    'Production practice in the follow-up answers is general knowledge, not checked against a source: breakers that judge a failure rate with a minimum call count, slow calls counted as failures, 429 treated apart from 5xx, several trial calls, and a retry budget.',
    'The run counts in stage 5 each come from one 2-CPU machine under load, and they change with both. One was not repeatable: a separate set of 30 runs with a plain `HashMap` failed every time, where the set quoted on this page failed 12 times.',
    'The minute marks in "How people lose time" (stage 1 by minute 20) are a judgement. Nobody was timed.',
    'That a missing lock on `record` can leave the `ArrayDeque` broken, as well as losing an entry, is inferred from runs in which far fewer than 4000 calls were made. The cause was not traced.',
    "The follow-up answers on ten instances, on retries and on choosing the numbers were reasoned from this code's rules; none was built or measured.",
  ],
};

export default page;
