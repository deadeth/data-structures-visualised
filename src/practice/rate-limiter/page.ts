import type { Practice } from '../types';

const page: Practice = {
  id: 'rate-limiter',
  title: 'Rate limiter',
  summary:
    'Write `allow(service)` for a gateway: at most 3 requests in any 10 seconds, counted for each service. It tests whether you get a simple counter working first, then see that a fixed window lets 6 through across its edge and replace it with a log of request times.',
  minutes: 35,
  core: 3,
  brief: [
    '"Our gateway sits in front of several internal services. Each service can take only so many requests. Write a rate limiter with one method, `boolean allow(String service)`, that says whether a request to that service may go ahead right now."',
    '"Start with one rule for everyone: at most 3 requests in any 10 seconds."',
    'That is all you get. It does not say whether "any 10 seconds" slides, whether a refused request counts, or what happens exactly 10 seconds after a request. Ask.',
  ],
  given: [
    '`interface Clock { long millis(); }` gives the time now in milliseconds. Every reading of time goes through it. Never call `System.currentTimeMillis()`: the tests could not move it.',
    '`FakeClock` starts at 0 and `set(millis)` moves it. The tests use it, so nothing sleeps and a boundary such as 9,999 against 10,000 is exact.',
    '`record Limit(int maxRequests, long windowMillis)` means at most `maxRequests` in any `windowMillis`. Its constructor throws `IllegalArgumentException` unless both are at least 1, so you never validate a limit yourself, and a limit of 0 cannot be made.',
    'An empty `RateLimiter` with the constructor `RateLimiter(Clock clock, Limit defaultLimit)` and five stubs: `allow` (stage 1), `setLimit` (stage 2), `retryAfterMillis` (stage 4), `evictIdle` and `trackedServices` (stage 5). Each stub throws `UnsupportedOperationException` naming its stage. No later stage changes a signature. The constructor stub keeps nothing: storing the clock and the default limit is your first job.',
    'A test harness and the tests of all five stages. Each test gets a new clock at 0 and a new limiter with the default of 3 per 10,000 ms. Results print as a string of `y` (allowed) and `n` (refused), such as `yyyn`. `calls(limiter, service, n)` makes n calls at the current time. `tries(clock, limiter, service, times...)` sets the clock to each time and calls once.',
    'Set `STAGE` and run `main`. With the starter untouched, all five stage 1 tests fail with `UnsupportedOperationException: stage 1` and the run ends `5 FAILED`.',
    'The stage 5 helper makes its threads with `Thread.ofPlatform()`, so the file needs Java 21. If the editor offers a choice of Java version, pick 21 before you paste.',
  ],
  ask: [
    {
      q: 'Does "any 10 seconds" mean any span of 10 seconds, or fixed 10-second blocks on the clock?',
      why: 'It picks the algorithm. Fixed blocks need one count for each service. Any span needs the time of every allowed request, because a count cannot say how many of its requests are less than 10 seconds old.',
      assume:
        "Fixed 10-second blocks to start, because they are one count for each service and can be running in ten minutes. Say now that this lets 6 requests through across a block edge, and that you'll replace it once it passes.",
    },
    {
      q: 'Is the limit counted per service, per caller, or across the whole gateway?',
      why: 'It decides the key of the map. Per service is one entry for each service name. Per caller multiplies the entries by the number of callers and makes eviction urgent.',
      assume: 'Per service, each counted on its own. A limit for each caller would be a second key, later.',
    },
    {
      q: 'Does a refused request count against the limit?',
      why: 'If it does, a client that retries in a loop keeps its own count full and never gets back in. It also decides the order of two lines: check then record, or record then check.',
      assume: 'No. Only allowed requests are counted, because the limit is on work sent to the service and a refused request sends none.',
    },
    {
      q: 'A request arrives exactly 10,000 ms after an earlier one. Is the earlier one still inside the window?',
      why: 'It is one comparison, `<=` or `<`, and it is the off-by-one the tests probe at 9,999 and 10,000.',
      assume:
        'It has left. The window is the last 10,000 ms and does not include the instant exactly 10,000 ms ago. That matches fixed blocks, where 10,000 starts a new block.',
    },
    {
      q: 'What should happen for a service I have never seen, or for a null or blank name?',
      why: 'New services appear without warning, so an unknown name is normal. A missing name is a bug in the caller, and a `HashMap` accepts `null` as a key and counts it without complaint.',
      assume: 'An unknown service gets the default limit with no registration. A null or blank name throws `IllegalArgumentException`.',
    },
    {
      q: 'Is this called from many threads, and is there one gateway instance or several?',
      why: 'Many threads means the check and the record must happen as one step. Several instances means each one counts only its own traffic, and no lock fixes that.',
      assume:
        'Many threads in one process. Write it for one thread first and add the lock as its own step. Several instances is a design conversation, not code for today.',
    },
    {
      q: 'Roughly how many services are there, and how high can a limit go?',
      why: 'A log keeps one time for each allowed request in the window, so memory is the limit times the number of services. At 3 that is nothing. At 10,000 it decides the algorithm.',
      assume: 'Tens to thousands of services, with limits in the tens to thousands.',
    },
  ],
  outline: `keep the clock and the default limit
limits: for each service given its own limit, that limit
logs: for each service, the times of its allowed requests,
  oldest first
one lock around every public operation

limit for a service: its own if it has one, else the default
drop expired: while the oldest time in a log is at or before
  now - window: remove it

allow(service):
  refuse a missing or blank name
  find the limit; read the clock once
  take the service's log, or start an empty one
  drop expired
  if the log already holds the limit: say no, record nothing
  add now at the back; say yes
set limit(service, limit): refuse a bad name; store the limit

retry after(service):
  no log: answer 0
  drop expired
  must leave = size of log - limit + 1; 0 or less: answer 0
  answer (the must-leave-th oldest time) + window - now

evict idle: for each service: drop expired;
  if its log is empty: forget the service and count it`,
  parts: [
    {
      id: 'fixed-window',
      title: 'One rule, fixed windows',
      stage: 1,
      ask: 'One rule for every service, 3 requests per 10 seconds, counted in fixed windows: the window number is the time divided by the window length, and each new window starts again from zero. Count each service on its own.',
      tests: [
        'first request is allowed',
        'fourth request in a window is refused',
        'refused until the window ends',
        'count starts again at the window edge',
        'services are counted separately',
      ],
      pseudocode: `keep the clock and the default limit (3 per 10,000 ms)
keep, for each service, a pair: (window number, count)

allow(service):
  number = now / 10,000, rounded down
  pair = the service's pair, if it has one
  count = the pair's count if its number is this number,
          otherwise 0
  if count is 3 or more: say no
  store (number, count + 1) for the service
  say yes`,
      regions: ['state', 'fixed-window'],
      explain: [
        'The decision is how a window ends. Keep one pair for each service, a window number and a count, in a `HashMap`. The window number is the time divided by 10,000 and rounded down: 0 to 9,999 is window 0 and 10,000 is window 1. A stored pair with a different number belongs to a finished window, so its count reads as 0. **Nothing ever resets a counter**, so no reset can be forgotten.',
        'The obvious alternative is a mutable counter, a `windowStart` field and a reset when `now >= windowStart + 10_000`. It works. It is also two fields to keep in step and a second place to get the boundary wrong, typed while two people watch.',
        "Type the fields and the constructor first: the starter's constructor keeps nothing. The pair is a private record, `Window(long number, int count)`. A record is immutable, so each allowed call puts a new `Window` in the map. That is one small allocation for each allowed request, and a refused call writes nothing.",
        'The cost is one map entry for each service, holding a `long` and an `int`. Each call is one lookup and at most one put: O(1) time and O(services) memory.',
        'Say the flaw before anyone else does. Three requests at 9,999 and three at 10,000 are in different windows, so all six pass within 1 ms. Stage 3 is that conversation.',
      ],
      lines: [
        {
          code: 'long number = clock.millis() / defaultLimit.windowMillis();',
          note: 'Dividing one `long` by another rounds down, and that is the whole window calculation: 9,999 gives 0 and 10,000 gives 1.',
        },
        {
          code: 'int count = window != null && window.number() == number',
          note: 'This line is the reset. `get` returns `null` for a service never seen, so the null check comes first. A pair from an earlier window fails the second test. Either way the count is 0.',
        },
        {
          code: 'if (count >= defaultLimit.maxRequests()) {',
          note: '`>=`, not `>`. The fourth request arrives when the count is already 3, and 3 is not greater than 3.',
        },
      ],
      trace: {
        caption:
          'Three calls at 0 fill window 0. At 10,000 the window number is 1, the stored pair is from window 0, and the count reads 0 with no reset step. The seventh call finds a count of 3 and is refused.',
        head: ['Time (ms)', 'Window number', 'Count before', 'Result', 'Count after'],
        rows: [
          ['0', '0', '0', 'allowed', '1'],
          ['0', '0', '1', 'allowed', '2'],
          ['0', '0', '2', 'allowed', '3'],
          ['10000', '1', '0', 'allowed', '1'],
          ['10000', '1', '1', 'allowed', '2'],
          ['10000', '1', '2', 'allowed', '3'],
          ['10000', '1', '3', 'refused', '3'],
        ],
        note: 'This is the test "count starts again at the window edge", which expects `yyyyyyn`.',
      },
      say: "I'm keeping a window number and a count for each service, so an old window is one whose number doesn't match and nothing ever needs resetting. I know this lets a burst through at the window edge, and I'll come back to that once it passes.",
      pitfalls: [
        'Writing `>` for `>=`: a fourth request gets through, and "fourth request in a window is refused" prints `yyyy`.',
        'Keeping one count for the whole limiter: the second service inherits the first one\'s count, and "services are counted separately" prints `yyynnnnn`.',
        'Reading the count without the null check: the first call for any service throws, and all five tests fail with `NullPointerException`.',
        'Calling `System.currentTimeMillis()` out of habit: the tests can no longer move time, so the count never starts again in "count starts again at the window edge".',
      ],
    },
    {
      id: 'own-limits',
      title: 'A limit for each service',
      stage: 2,
      ask: 'Some services can take more than others: `setLimit(service, limit)` gives one service its own limit from its next call, and the rest keep the default. A null or blank service name is a bug in the caller, so throw `IllegalArgumentException`.',
      tests: [
        'a service uses its own limit',
        'other services keep the default',
        'a lowered limit applies on the next call',
        'a raised limit applies on the next call',
        'a null or blank service name is rejected',
      ],
      pseudocode: `keep, for each service given its own limit, that limit

limit for(service):
  its own limit if it has one, otherwise the default

require a name(service):
  if it is missing or blank: throw, "service name required"

allow(service):
  require a name
  limit = limit for(service)
  then as stage 1, with this limit's window and maximum

set limit(service, limit):
  require a name
  refuse a missing limit
  store the limit for the service`,
      regions: ['own-limits', 'lookups', 'allow-with-own-limit', 'set-limit'],
      explain: [
        "The decision is where a service's limit lives. Put it in a second map, `limits`, and look it up on every call. Don't copy it into the counting state. **Because the limit is read fresh each time, a change applies on the next call with no extra code**, and the count is untouched by the change.",
        'It is a setter, and not a map passed to the constructor, because the requirement says a limit can change while the limiter runs. An unknown service needs no registration: `getOrDefault` hands it the default of 3 per 10,000 ms. The cost is one more map lookup on each call and one entry for each service given its own limit.',
        'Type the two private helpers first, `limitFor` and `requireName`, because every later method starts with them. Then `allow` gets two new first lines and reads `limit` in the two places it read `defaultLimit`. The counting is the same as stage 1.',
        'The name check does more than it looks. `HashMap` accepts `null` as a key, so the stage 1 code counts a service called `null` and the test prints `expected true true, got false false`. `isBlank()` is true for an empty string and for one that is only whitespace. `setLimit` also refuses a null limit with `Objects.requireNonNull`, which throws `NullPointerException`. No test covers that.',
        'The test "a raised limit applies on the next call" shows the count surviving a change: four calls give `yyyn`, the limit goes up to 5, and the next three give `yyn` because the count is still 3. One thing to say if asked: with fixed windows, changing the window length changes the window number, so the stored pair usually stops matching and the count starts again from zero. No test covers that either.',
      ],
      lines: [
        {
          code: 'return limits.getOrDefault(service, defaultLimit);',
          note: 'The whole rule for an unknown service. `getOrDefault` returns its second argument when the key is missing, so there is no null to check.',
        },
        {
          code: 'if (service == null || service.isBlank()) {',
          note: 'Null first. Written the other way round, `isBlank()` is called on `null` and the test reports `threw java.lang.NullPointerException`, not the exception it wants.',
        },
        {
          code: 'Limit limit = limitFor(service);',
          note: 'Looked up on every call and never stored with the count. This line is why `setLimit` takes effect on the next call.',
        },
        {
          code: 'limits.put(service, Objects.requireNonNull(limit, "limit"));',
          note: '`Objects.requireNonNull` returns its argument, or throws `NullPointerException` with the message `limit`. The check and the put share a line.',
        },
      ],
      trace: {
        caption:
          '`search` has its own limit of 5 per 1,000 ms: five calls pass at time 0 and the sixth is refused. At 1,000 ms `search` is in its window 1 and starts again, while `orders`, on the default, is still in its window 0. Each service is counted against its own limit and its own window length.',
        head: ['Time (ms)', 'Service', 'Limit', 'Window number', 'Count before', 'Result'],
        rows: [
          ['0', 'search', '5 per 1000 ms', '0', '0', 'allowed'],
          ['0', 'search', '5 per 1000 ms', '0', '1', 'allowed'],
          ['0', 'search', '5 per 1000 ms', '0', '2', 'allowed'],
          ['0', 'search', '5 per 1000 ms', '0', '3', 'allowed'],
          ['0', 'search', '5 per 1000 ms', '0', '4', 'allowed'],
          ['0', 'search', '5 per 1000 ms', '0', '5', 'refused'],
          ['1000', 'search', '5 per 1000 ms', '1', '0', 'allowed'],
          ['1000', 'orders', '3 per 10000 ms', '0', '0', 'allowed'],
        ],
        note: 'The first seven rows are the test "a service uses its own limit", which expects `yyyyyny`. The run went on to call `orders` three more times at 1,000 ms: allowed twice, then refused, as in "other services keep the default".',
      },
      say: "The limit is configuration, so it gets its own map and I look it up on every call. That's what makes a change apply on the next call without touching the count.",
      pitfalls: [
        'Copying the limit into the counting state the first time a service is seen: `setLimit` then does nothing for a service already called, and "a lowered limit applies on the next call" prints `yyy`.',
        'Clearing the count inside `setLimit`: the service gets a fresh allowance every time its limit is touched, and "a raised limit applies on the next call" prints `yyynyyy`.',
        'Calling `service.isBlank()` before the null check: `allow(null)` throws the wrong exception, and the test line reads `threw java.lang.NullPointerException`.',
        'Leaving the name check out: nothing crashes, a `null` key is counted like any service, and the test prints `expected true true, got false false`.',
      ],
    },
    {
      id: 'sliding-log',
      title: 'The burst at the edge, and a sliding log',
      stage: 3,
      ask: 'Your fixed window lets a burst through at its edge: 3 requests just before it and 3 just after, 6 in two seconds. Make the limit hold over any 10 seconds: count only the requests allowed in the last 10 seconds.',
      tests: [
        'no burst of six across a window edge',
        'a slot frees exactly one window after its request',
        'refused requests are not counted',
      ],
      pseudocode: `replace the (window number, count) pairs with a log:
  for each service, the times of its allowed requests,
  oldest first

drop expired(log, now, limit):
  cutoff = now - window
  while the log's oldest time is at or before cutoff:
    remove it

allow(service):
  require a name; limit = limit for(service)
  now = the clock, read once
  log = the service's log; start an empty one if none
  drop expired(log, now, limit)
  if the log already holds the maximum (3): say no,
    and record nothing
  add now at the back of the log
  say yes`,
      regions: ['log-state', 'sliding-log', 'drop-expired'],
      explain: [
        'Before you change anything, set `STAGE = 3` and run. The stage 2 code prints `FAIL no burst of six across a window edge: expected yyynnn, got yyyyyy`. The requests at 9,000, 9,500 and 9,999 are in window 0, and those at 10,000, 10,500 and 11,000 are in window 1. Each window sees 3, so **six requests pass in 2 seconds under a rule of 3 in any 10**. Show that red line and say why it happens. Then fix it.',
        'The decision is what to store. A count cannot say how old its requests are, so keep the time of every allowed request: one log for each service, oldest first, in a `Map<String, Deque<Long>>` of `ArrayDeque`. Time moves forwards, so new times join at the back and expired ones are always at the front. Both ends are O(1). An `ArrayList` with `remove(0)` shifts every element. A `TreeSet` costs O(log n) and has a real bug: a set keeps one copy of each value, so three requests in the same millisecond count as one.',
        'Then the boundary. The window is the last 10,000 ms and does not include the instant exactly 10,000 ms ago, so `dropExpired` removes every time at or before `now - 10,000`. A request made at 0 has left by 10,000. That keeps the stage 1 edge test passing, and the test "a slot frees exactly one window after its request" pins it from both sides: refused at 9,999, allowed at 10,000.',
        'A refused request is not written to the log: `allow` returns before `addLast`. The limit is on work sent to the service, and a refused request sends none. If refusals were logged, a client retrying in a loop would keep its own log full. The test "refused requests are not counted" refuses three requests at 9,000 and expects the one at 10,000 to pass. It passes on the fixed window too. It is there to catch a log that records refusals, which prints `yyynnnn`.',
        'What to type: delete the `Window` record and the `windows` map, add `logs`, keep the first two lines of `allow` and rewrite the rest. Write `dropExpired` as its own method, because stages 4 and 5 call it. The cost is memory. Each service now holds up to 3 times, and in general one boxed `Long` for each allowed request in the window, measured at about 28 bytes each. Time is still O(1) amortised: one call can drop up to 3 entries, but each entry is dropped once.',
      ],
      lines: [
        {
          code: 'while (!log.isEmpty() && log.peekFirst() <= cutoff) {',
          note: '`<=` is the boundary: a request exactly 10,000 ms old leaves. With `<` it stays 1 ms too long and "count starts again at the window edge" prints `yyynnnn`. The empty check comes first because `peekFirst()` returns `null` on an empty deque.',
        },
        {
          code: 'logs.computeIfAbsent(service, s -> new ArrayDeque<>());',
          note: "`computeIfAbsent` returns the service's log, first creating and storing an empty one if there is none. It replaces a get, a null check and a put.",
        },
        {
          code: 'if (log.size() >= limit.maxRequests()) {',
          note: 'Checked before anything is added. The size is the number of allowed requests still inside the window: expired ones were dropped on the line above, and refusals were never added.',
        },
        {
          code: 'log.addLast(now);',
          note: 'The only line that records a request, and it comes after the check. Move it above the check and refusals start holding slots.',
        },
      ],
      trace: {
        caption:
          'The same six requests on both versions. The fixed window counts 3 in window 0 and 3 in window 1, so all six pass within 2 seconds. The log at 10,000 still holds three times, all newer than the cutoff of 0, so the fourth, fifth and sixth are refused. A refusal leaves the log exactly as it was.',
        head: ['Time (ms)', 'Stage 2, fixed window', 'Stage 3 drops times at or before', 'Log after dropping', 'Stage 3', 'Log after'],
        rows: [
          ['9000', 'window 0: allowed', '-1000', '`[]`', 'allowed', '`[9000]`'],
          ['9500', 'window 0: allowed', '-500', '`[9000]`', 'allowed', '`[9000, 9500]`'],
          ['9999', 'window 0: allowed', '-1', '`[9000, 9500]`', 'allowed', '`[9000, 9500, 9999]`'],
          ['10000', 'window 1: allowed', '0', '`[9000, 9500, 9999]`', 'refused', '`[9000, 9500, 9999]`'],
          ['10500', 'window 1: allowed', '500', '`[9000, 9500, 9999]`', 'refused', '`[9000, 9500, 9999]`'],
          ['11000', 'window 1: allowed', '1000', '`[9000, 9500, 9999]`', 'refused', '`[9000, 9500, 9999]`'],
        ],
        note: 'The stage 3 columns are the test "no burst of six across a window edge", which expects `yyynnn`. The stage 2 column is the same test on the stage 2 code, which prints `got yyyyyy`. On the log, the next request allowed is at 19,000, when the time 9,000 leaves.',
      },
      say: "A count can't tell me these six are two seconds apart, so I'll keep the time of each allowed request in a deque for each service. I drop the ones that are 10 seconds old from the front and allow if fewer than 3 are left, and a refused request never goes in.",
      pitfalls: [
        'Adding to the log before checking its size: refusals are recorded, and "refused requests are not counted" prints `yyynnnn`.',
        'Writing `<` for `<=` at the cutoff: a time stays 1 ms too long, and "a slot frees exactly one window after its request" prints `yyynnnyn`.',
        'Using a `TreeSet`, or any set, for the log: three requests in the same millisecond are stored once, and "fourth request in a window is refused" prints `yyyy`.',
        'Leaving out `!log.isEmpty()`: `peekFirst()` returns `null` on a new log, the comparison unboxes it, and 12 of the 13 tests fail with `NullPointerException`.',
      ],
    },
    {
      id: 'retry-after',
      title: 'When to come back',
      stage: 4,
      ask: 'When we refuse, the gateway wants to tell the caller when to come back: `retryAfterMillis(service)` is 0 if a request would be allowed now, otherwise how long until one would be. Asking must not use up a slot.',
      tests: [
        'nothing to wait for on a new service',
        'a full service waits until its oldest request leaves',
        'asking does not use a slot',
        'a lowered limit waits for enough requests to leave',
      ],
      pseudocode: `retry after(service):
  require a name; limit = limit for(service); now = clock
  log = the service's log; if it has none: answer 0
  drop expired(log, now, limit)
  must leave = size of log - maximum + 1
  if must leave is 0 or less: answer 0
  blocker = the must-leave-th oldest time in the log
  answer blocker + window - now`,
      regions: ['retry-after'],
      explain: [
        'The decision is which request has to leave before a slot is free. Usually it is the oldest: the log holds 3, and when the oldest is 10,000 ms old it is dropped. So the first answer is `oldest + 10,000 - now`, and it is right only while the log holds exactly the limit.',
        'A lowered limit breaks it. With requests at 0, 1,000 and 2,000 and the limit cut to 2, the log holds 3 against a limit of 2. When the time 0 leaves at 10,000 the log still holds 2, which is full. So count how many must leave, `size - max + 1`: 1 in the usual case, 2 here. Then wait for that many of the oldest. The test "a lowered limit waits for enough requests to leave" expects 9000, and the oldest-only version returns 8000. In an interview, oldest plus window is a fair first answer if you say when it holds.',
        'Asking must change nothing a caller can see. Start with the same three lines as `allow`, then read the log with `logs.get`, not `computeIfAbsent`, so a question about an unknown service creates no state. No test catches the difference, so it is yours to get right. Never call `allow` to find out, because that takes a slot. The method does drop expired times from an existing log, which only does early what the next `allow` would do.',
        'The answer is exact. At `now + answer` the blocker is exactly 10,000 ms old, and `dropExpired` removes times at or before the cutoff, so it has left. The test checks both sides: 1 ms early is refused and the stated time is allowed, `5000 ny`.',
        "`ArrayDeque` has no `get(i)`. `log.stream().skip(mustLeave - 1).findFirst().get()` reads the nth oldest, because a deque's stream runs from first to last. If that line won't come to you, walk an iterator and say you'd look the stream call up. It is O(1) when one must leave and O(mustLeave) after a lowered limit.",
      ],
      lines: [
        {
          code: 'Deque<Long> log = logs.get(service);',
          note: '`get`, not `computeIfAbsent`: asking about a service nobody has called answers 0 and leaves no empty log behind.',
        },
        {
          code: 'int mustLeave = log.size() - limit.maxRequests() + 1;',
          note: 'How many requests must leave before one more fits. With 3 in the log and a limit of 3 it is 1. With 3 in the log and a limit of 2 it is 2. Zero or less means there is room now.',
        },
        {
          code: 'long blocker = log.stream().skip(mustLeave - 1).findFirst().get();',
          note: 'The time of the request whose leaving frees the slot. `skip(mustLeave - 1)` passes over the older ones. `findFirst().get()` cannot fail, because `mustLeave` is never more than the size of the log.',
        },
        {
          code: 'return blocker + limit.windowMillis() - now;',
          note: 'Always above 0: expired times were dropped first, so the blocker is newer than `now - window`.',
        },
      ],
      trace: {
        caption:
          'Both runs start with requests allowed at 0, 1,000 and 2,000. With the limit at 3, one must leave, so the wait is for the time 0: 0 + 10,000 - 5,000. With the limit lowered to 2, two must leave. At 10,000 the time 0 has gone and the request is still refused. The slot opens when 1,000 leaves, at 11,000.',
        head: ['Limit', 'Time (ms)', 'Call', 'Log after the call', 'Must leave', 'Blocker', 'Answer'],
        rows: [
          ['3 per 10 s', '5000', '`retryAfterMillis`', '`[0, 1000, 2000]`', '1', '0', '5000'],
          ['3 per 10 s', '9999', '`allow`', '`[0, 1000, 2000]`', '', '', 'refused'],
          ['3 per 10 s', '10000', '`allow`', '`[1000, 2000, 10000]`', '', '', 'allowed'],
          ['lowered to 2 per 10 s', '2000', '`retryAfterMillis`', '`[0, 1000, 2000]`', '2', '1000', '9000'],
          ['lowered to 2 per 10 s', '10000', '`allow`', '`[1000, 2000]`', '', '', 'refused'],
          ['lowered to 2 per 10 s', '10999', '`allow`', '`[1000, 2000]`', '', '', 'refused'],
          ['lowered to 2 per 10 s', '11000', '`allow`', '`[2000, 11000]`', '', '', 'allowed'],
        ],
        note: 'Rows 1 to 3 are the test "a full service waits until its oldest request leaves", which expects `5000 ny`. Rows 4, 6 and 7 are "a lowered limit waits for enough requests to leave", `9000 ny`. Row 5 is one extra call that is not in the test, to show the oldest request leaving without freeing a slot.',
      },
      say: "A slot frees when enough of the oldest requests have left the window, and that's normally just the oldest one. I'm reading the log without creating one, so asking never changes what a caller sees.",
      pitfalls: [
        'Calling `allow` to find out: the question itself takes a slot, and "asking does not use a slot" fails.',
        'Returning oldest plus window with no count: right until a limit is lowered, then "a lowered limit waits for enough requests to leave" prints `8000 ny`.',
        'Padding the answer by 1 ms to be safe: the caller waits longer than it needs to, and "a full service waits until its oldest request leaves" prints `5001 yn`.',
        'Using `computeIfAbsent` here as in `allow`: every question about an unknown service leaves an empty log behind. All four tests still pass, so only you will notice.',
      ],
    },
    {
      id: 'threads-and-eviction',
      title: 'Many threads, and forgetting quiet services',
      stage: 5,
      ask: 'Many threads call the limiter at once; for one service exactly its limit may succeed. And services that go quiet must not stay in memory for ever: `evictIdle()` drops the services with nothing left in their window and says how many, and `trackedServices()` counts the rest.',
      tests: [
        'parallel callers get exactly the limit',
        'idle services are evicted',
        'a service with recent requests is kept',
        'eviction during traffic loses no request',
      ],
      pseudocode: `hold one lock for the whole of allow, set limit,
  retry after, evict idle and tracked services

evict idle():
  now = the clock, read once; dropped = 0
  for each service and its log:
    drop expired(log, now, limit for(service))
    if the log is empty: forget the service; dropped + 1
  answer dropped

tracked services(): how many logs are held`,
      regions: ['locked-allow', 'locked-set-limit', 'locked-retry-after', 'eviction'],
      explain: [
        'The decision is how much to lock, and the answer is everything: `synchronized` on all five methods, one lock for the whole limiter. Two steps must each happen as one. In `allow`, check the size then add: without a lock two threads both see 99 of 100 and both add. In `evictIdle`, check for empty then remove. One lock makes both safe, and eviction can never run in the middle of an `allow`. Each call holds it for a few deque operations.',
        'Name the alternative. `ConcurrentHashMap` alone is not enough: the map is safe, but the `ArrayDeque` inside it and the check-then-add are not. The version that works is `compute(service, ...)` for each key, which lets different services proceed in parallel. Then the answer of `allow` has to be carried out of a lambda, and every touch of a deque has to be inside one. That is more code and more ways to get it wrong with ten minutes left. Offer it as the next step if profiling shows the lock is hot.',
        'What to type: add one word to `allow`, `setLimit` and `retryAfterMillis`. `setLimit` needs it because `limits` is a plain `HashMap` that `allow` reads. Then write `evictIdle`. A service is idle when its log is empty **after expired times are dropped**, so prune first and test second. Removing an empty log loses nothing: the next `allow` starts a new empty one and behaves the same.',
        'Eviction cannot live inside `allow`. `allow` always leaves a log with something in it: it adds a time, or it refused because the log was full. Idle services are exactly the ones nobody calls, so something else must sweep. Here the tests call `evictIdle`. In production a scheduled task would, say once every 10 seconds. A sweep is O(services) with the lock held, so every caller waits for it.',
        'Know what the two parallel tests show. Each runs 20 rounds: a new limiter of 100 per 10 seconds, 8 threads calling it 50 times each, released together by a latch, and a count of how many of the 400 calls were allowed. The only right answer is 100 in every round. **A pass shows that no race was seen in 20 rounds. It does not prove there is none.** With `synchronized` taken off `allow`, the first test failed in 92 runs of 100 in one measurement and 74 of 100 in another, both on 2-core machines. Run it several times, and argue thread safety from the lock, not from the green line.',
      ],
      lines: [
        {
          code: 'synchronized boolean allow(String service) {',
          note: 'The whole change to `allow`. `synchronized` on an instance method locks the limiter object, so the five public methods share one lock and the check cannot be split from the add.',
        },
        {
          code: 'for (var it = logs.entrySet().iterator(); it.hasNext(); ) {',
          note: 'An explicit iterator, because the loop removes as it goes. Calling `logs.remove(...)` inside a for-each over the same map throws `ConcurrentModificationException` on the next step of the loop.',
        },
        {
          code: 'dropExpired(entry.getValue(), now, limitFor(entry.getKey()));',
          note: "Prune first, with that service's own limit, then test for empty. A quiet service's log stays full of old times until something drops them.",
        },
        {
          code: 'it.remove();',
          note: 'Removes the entry the iterator last returned from the map underneath, which is the one safe way to remove during the loop.',
        },
      ],
      trace: {
        caption:
          'At 10,000 the request `orders` made at 0 is exactly one window old. Its log empties and the service is dropped. `payments` keeps its request from 9,000, and that request still counts after the sweep: two more pass and the third is refused.',
        head: ['Time (ms)', 'Call', 'Answer', 'Logs after the call', 'Services tracked'],
        rows: [
          ['0', '`allow("orders")`', 'allowed', 'orders `[0]`', '1'],
          ['9000', '`allow("payments")`', 'allowed', 'orders `[0]`, payments `[9000]`', '2'],
          ['10000', '`evictIdle()`', '1', 'payments `[9000]`', '1'],
          ['10000', '`allow("payments")`', 'allowed', 'payments `[9000, 10000]`', '1'],
          ['10000', '`allow("payments")`', 'allowed', 'payments `[9000, 10000, 10000]`', '1'],
          ['10000', '`allow("payments")`', 'refused', 'payments `[9000, 10000, 10000]`', '1'],
        ],
        note: 'This is the test "a service with recent requests is kept", which expects `1 1 yyn`. On the same code both parallel tests printed `[100]`. With `synchronized` taken off `allow`, one run printed `got [100, 106]` and another threw `ConcurrentModificationException`.',
      },
      say: "The check and the add have to happen as one step, so I'm putting one lock around every public method; if it ever shows in a profile, per-key `compute` on a `ConcurrentHashMap` is the next step. For eviction I prune each log and drop the empty ones, which loses nothing because an empty log and no log behave the same.",
      pitfalls: [
        'Locking `allow` and nothing else: `evictIdle` and `setLimit` then change a plain `HashMap` while `allow` reads it. Only "eviction during traffic loses no request" can show it, and in one measurement it did in 6 runs of 40.',
        'Swapping `HashMap` for `ConcurrentHashMap` and dropping the lock: the map is safe, the `ArrayDeque` inside it is not, and two threads can both pass the size check. In one measurement it failed 30 runs of 40, with results such as `got [100, 133, 138]`.',
        'Testing for an empty log without dropping expired times first: nothing is ever evicted, and "idle services are evicted" prints `0 2`.',
        'Evicting a log that still holds times: the service forgets its recent requests, and "a service with recent requests is kept" prints `2 0 yyy`.',
      ],
    },
  ],
  followUps: [
    {
      q: 'How do you test a rate limiter without sleeping?',
      a: [
        'I inject the clock. These tests move a fake clock by hand, so 9,999 against 10,000 is exact and the whole file runs in well under a second.',
        'For threads I start them together with a latch, repeat the round 20 times and put a deadline on every wait.',
        "And I'd say plainly that a concurrency test catches a race on most runs, not all. It can show a bug. It can't prove there isn't one.",
      ],
    },
    {
      q: 'What does the gateway send back when it refuses?',
      a: [
        '`429 Too Many Requests`, with a `Retry-After` header in whole seconds, rounded up from `retryAfterMillis`.',
        'The request is not forwarded, so the service does no work for it.',
        'Callers should back off and add jitter. If they all return at the stated instant, the next window opens with a burst.',
      ],
    },
    {
      q: 'Why not a token bucket?',
      a: [
        'Because the brief is a count: at most 3 in any 10 seconds. A token bucket promises a rate with a burst on top, which is a different rule.',
        'A bucket of 3 refilled at 3 per 10 seconds lets a fourth request through 3,334 ms after a burst of three.',
        'It\'s what I\'d pick for "100 a second, bursts of 200": two numbers for each key and nothing stored for each request.',
      ],
    },
    {
      q: 'Which would you choose from fixed window, sliding log, sliding window counter and token bucket?',
      a: [
        'It depends on what the limit protects. A fixed window is one count for each key, but it allows twice the limit across an edge: fine for a daily quota.',
        'The sliding log is exact and stores a time for each allowed request, so it suits a small limit that must hold, like this one.',
        'The sliding window counter keeps two counts and weights the older one by how much of its window is still in view, which is constant memory and an estimate.',
        'The token bucket is two numbers and limits a rate with a burst, not a count in a window.',
      ],
    },
    {
      q: 'The limit becomes 10,000 a minute for each of 10,000 clients. Does the log still work?',
      a: [
        'No. The log keeps one time for each allowed request, so at full use that is 100 million entries.',
        'At about 28 bytes an entry in an `ArrayDeque<Long>`, that is about 2.8 GB.',
        "First I'd swap the deque for a `long[]` ring buffer: 8 bytes a time and no boxing, so about 0.8 GB.",
        "If that is still too much I'd move to the sliding window counter, two counts for each client, and give up exactness.",
      ],
    },
    {
      q: 'What happens if the clock goes backwards?',
      a: [
        'The log assumes it never does. An older time would be added behind newer ones, and `dropExpired` stops at the first time still in the window, so stale times behind it stay too long.',
        'That fails towards refusing: it can turn away requests it should allow. A jump forwards is the unsafe direction, because times expire early.',
        "On one machine I'd read a monotonic clock such as `System.nanoTime()`. With a shared store I'd take the time from the store, so every instance agrees.",
      ],
    },
    {
      q: 'How would you add a limit for each client as well as each service?',
      a: [
        'A composite key: a small record of service and client as the map key, with its own limit.',
        "A request must pass both limits, and I'd check both before recording either. If I record in the first and the second refuses, that request has used a slot for nothing.",
        'Memory now grows with the number of clients, so eviction stops being optional.',
      ],
    },
    {
      q: 'Where does the single lock hurt, and what would you do then?',
      a: [
        'Two places: very high request rates on one instance, and an eviction sweep over millions of keys, which holds the lock for the whole pass.',
        "I'd move to `ConcurrentHashMap.compute` for each key, so calls for different services stop waiting for each other, and sweep a slice at a time.",
        'The cost is more code and a rule that is easy to break: nothing touches a deque outside a `compute` lambda.',
      ],
    },
    {
      q: 'The gateway runs as four instances. What changes?',
      a: [
        'Each instance counts only its own traffic, so four instances let through four times the limit.',
        "I'd move the state to a shared store such as Redis and do the drop, the count and the add as one atomic step, in a script that runs on the store.",
        'That costs a network round trip on every request and makes the store something the gateway depends on.',
        'The cheap alternative is to give each instance a quarter of the limit. No coordination, but uneven load makes a busy instance refuse early.',
      ],
    },
    {
      q: 'The shared store is down. Do you allow or refuse?',
      a: [
        "For a limit that protects capacity I'd allow, but fall back to the in-memory limiter on each instance at its share of the limit, and raise an alert.",
        'Refusing turns a limiter outage into a full outage. Allowing with no fallback removes the protection exactly when something is already wrong.',
        "Where the limit protects money or security, such as login attempts, I'd refuse.",
      ],
    },
  ],
  mistakes: [
    'Designing the sliding log before anything runs. Get the fixed window passing in about ten minutes, say aloud that it lets 6 through at an edge, and let stage 3 ask for the fix.',
    'Not asking what "any 10 seconds" means. Stage 3 then arrives as a surprise, when it could have been something you predicted in the first two minutes.',
    'Skipping the red run at stage 3. Running the new tests on the old code takes seconds and prints `got yyyyyy`, which explains the bug better than you can.',
    'Nudging the boundary with `+ 1` and `- 1` until a test goes green. Decide once that a request exactly 10,000 ms old has left, write `<=` in `dropExpired`, and leave every other line alone.',
    'Typing `dropExpired` in silence. Which side of 10,000 a request falls on is the decision the two people watching want to hear.',
    'Reaching for `ConcurrentHashMap` and a lock for each key with ten minutes left. One `synchronized` on each public method is correct and is one word a method. Name the finer lock as the next step.',
  ],
  see: [
    {
      href: '#/s/token-bucket',
      label: 'Token bucket',
      why: "The alternative you'll be asked about, animated: two numbers for each key, a burst paid for from stored tokens, and a Retry-After worked out from the tokens missing.",
    },
    {
      href: '#/s/token-manager',
      label: 'Token manager',
      why: 'The same shape as the sliding log: a map for lookup beside a queue in time order, where the oldest entries are the first to expire.',
    },
    {
      href: '#/s/queue',
      label: 'Ring buffer queue',
      why: 'The fixed array with a head and a tail that would replace `ArrayDeque<Long>` and hold each time in 8 bytes.',
    },
    {
      href: '#/c/resilience-patterns/rate-limiting-and-shedding',
      label: 'Rate limiting and load shedding',
      why: 'Where a limiter sits among the other protections, and how refusing one caller differs from a server shedding load.',
    },
    {
      href: '#/s/retries-breaker',
      label: 'Retries, backoff and circuit breakers',
      why: 'What a caller should do with a refusal: wait, back off and add jitter, so the retries do not arrive as one wave.',
    },
  ],
  simplified: [
    'One process. Several gateway instances would each count on their own, and there is no shared store.',
    'Time is a `long` of milliseconds from an injected clock. Nothing handles a clock that goes backwards, which would put the log out of order.',
    'Nobody calls `evictIdle()`. The tests call it directly; real code needs a scheduled task.',
    'One lock guards everything, so calls for different services wait for each other.',
    '`ArrayDeque<Long>` boxes every time. A `long[]` ring buffer would hold the same log in 8 bytes a time.',
    'A limit, once set, cannot be removed, and a limit of 0, to block a service, cannot be expressed because `Limit` refuses it.',
    'Every request costs one slot. There are no weighted requests, no keys for each client, no HTTP response and no metrics.',
    "With the fixed windows of stages 1 and 2, changing a service's window length usually starts its count again from zero. No test covers it.",
  ],
  unverified: [
    'About 28 bytes for each entry of an `ArrayDeque<Long>` was measured once, on OpenJDK 21 with default settings. Other JVMs and settings differ. The 2.8 GB and 0.8 GB figures are worked from it and from 8 bytes for a `long`.',
    'How often the parallel tests catch a missing lock (92 of 100, 74 of 100, 6 of 40, 30 of 40) comes from single measurements on 2-core machines. Expect other numbers on other hardware.',
    '`429 Too Many Requests` and a `Retry-After` header in seconds are from memory, not checked against the HTTP specifications.',
    'That a shared store such as Redis can run the drop, the count and the add as one atomic script is from memory. Nothing here was run against one.',
    'The sliding window counter and the token bucket are described from memory and were not run. The token bucket figure of 3,334 ms is arithmetic on a bucket of 3 refilled at 3 per 10,000 ms that allows a request once it holds 1 whole token.',
    'That `System.nanoTime()` never goes backwards, and that `ConcurrentHashMap.compute` runs atomically for its key, are from memory of the Java documentation.',
    'That `Thread.ofPlatform()` needs Java 21 is from memory. The files were compiled and run on JDK 21 only.',
    'Advice on failing open or closed, on backing off with jitter and on sweeping once a window is common practice as the writer understands it, not something measured here.',
  ],
};

export default page;
