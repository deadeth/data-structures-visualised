import type { Practice } from '../types';

const page: Practice = {
  id: 'rate-limiter',
  title: 'Rate limiter',
  summary:
    'Write `allow(service)` for a gateway: at most 3 requests in any 10 seconds, counted for each service on its own.',
  minutes: 35,
  core: 3,
  testing: {
    intro:
      'The code is short: by the end of stage 3 you have 41 lines of your own, 7 of them comments. What counts is what you ask about the gaps in the brief, where you keep the state and how you use the 35 minutes.',
    points: [
      'Asking before you type whether "any 10 seconds" slides and whether a refused request counts: each answer changes a line of `allow`.',
      'Getting the plain fixed window passing first, then showing with a red test that it lets 6 through across an edge before replacing it.',
      'Deciding once that a request exactly 10,000 ms old has left, and testing 9,999 against 10,000 with the supplied clock and no sleeping.',
    ],
  },
  use: 'Drill "Ask first" and stages 1 to 3 until you can type them without the page. Stages 4 and 5 and the last ten minutes are things to say, and to code only if the clock allows.',
  brief: [
    '"Our gateway sits in front of several internal services. Each service can take only so many requests. Write a rate limiter with one method, `boolean allow(String service)`, that says whether a request to that service may go ahead right now."',
    '"Start with one rule for everyone: at most 3 requests in any 10 seconds."',
    'That is all you get. It does not say whether "any 10 seconds" slides, whether a refused request counts, or what happens exactly 10 seconds after a request.',
  ],
  given: [
    'A `Clock`, and a `FakeClock` the tests move by hand. Read time only through the clock, never `System.currentTimeMillis()`.',
    '`record Limit(int maxRequests, long windowMillis)`, which refuses anything below 1, so you never validate a limit.',
    'An empty `RateLimiter`: five stubs that throw, and a constructor that keeps nothing yet.',
    "Every stage's tests, each on a new clock at 0 with a default of 3 per 10,000 ms. Results read `y` for allowed and `n` for refused: `yyyn`.",
    'The stage 5 tests use `Thread.ofPlatform()`, so pick Java 21 in the editor before you paste.',
  ],
  ask: [
    {
      q: 'Does "any 10 seconds" mean any span of 10 seconds, or fixed 10-second blocks on the clock?',
      why: 'It picks the algorithm: fixed blocks need one count for each service, any span needs the time of every allowed request.',
      assume:
        "Fixed blocks to start, because they can be running in ten minutes. Say now that this lets 6 through across a block edge and that you'll replace it.",
    },
    {
      q: 'Does a refused request count against the limit?',
      why: 'If it does, a client retrying in a loop keeps its own count full and never gets back in.',
      assume: 'No. The limit is on work sent to the service, and a refused request sends none.',
    },
    {
      q: 'A request arrives exactly 10,000 ms after an earlier one. Is the earlier one still inside the window?',
      why: 'It is one comparison, `<=` or `<`, and the tests probe it at 9,999 and 10,000.',
      assume:
        'It has left: the window is the last 10,000 ms, not including the instant exactly 10,000 ms ago. Fixed blocks agree, since 10,000 starts a new block.',
    },
    {
      q: 'What should happen for a service I have never seen, or for a null or blank name?',
      why: 'New services appear without warning, so an unknown name is normal. A missing name is a bug in the caller, and a `HashMap` counts a `null` key without complaint.',
      assume: 'An unknown service gets the default limit with no registration. A null or blank name throws `IllegalArgumentException`.',
    },
    {
      q: 'Is this called from many threads, and is there one gateway instance or several?',
      why: 'Many threads means the check and the record must happen as one step. Several instances each count only their own traffic, and no lock fixes that.',
      assume:
        'Many threads in one process: write it for one thread first and add the lock as its own step. Several instances is a conversation, not code.',
    },
  ],
  outline: `keep the clock and the default limit
limits: for each service given its own limit, that limit
logs: for each service, its allowed request times, oldest first
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
      regions: ['state', 'fixed-window'],
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
      choice:
        "Decide how a window ends. Keep one pair for each service, a private `record Window(long number, int count)`, in a `HashMap`. The number is the time divided by 10,000, and `long` division rounds down: 9,999 gives 0 and 10,000 gives 1. A stored pair with a different number belongs to a finished window, so its count reads 0. **Nothing ever resets a counter**, where the obvious version has a `windowStart` field, a reset and a second boundary to get wrong. Type the fields and the constructor first, since the starter's keeps nothing. Refuse on `>=`, not `>`: the fourth request finds a count of 3.",
      say: "I'm keeping a window number and a count for each service, so an old window is one whose number doesn't match and nothing needs resetting.",
      trace: {
        caption:
          'At 10,000 the window number is 1, the stored pair is from window 0, and the count reads 0 with no reset step.',
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
      pitfalls: [
        'Writing `>` for `>=`: a fourth request gets through, and "fourth request in a window is refused" prints `yyyy`.',
        'Reading the count without a null check: `get` returns `null` for a new service, and all five tests fail with `NullPointerException`.',
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
      regions: ['own-limits', 'lookups', 'allow-with-own-limit', 'set-limit'],
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
      choice:
        'Decide where a limit lives: in a second map, `limits`, read on every call and never copied beside the count. **Because it is read fresh each time, `setLimit` applies on the next call with no extra code**, and the count survives: after `yyyn`, raising the limit to 5 gives `yyn`. Write two helpers first. `limitFor` is `limits.getOrDefault(service, defaultLimit)`, so an unknown service needs no registration. `requireName` tests `service == null || service.isBlank()`, null first, or `isBlank()` itself throws `NullPointerException`. Skip the check and nothing crashes: the `null` key is counted like any service.',
      say: "The limit is configuration, so it lives in its own map and I look it up fresh on every call.",
      trace: {
        caption:
          '`search` has its own limit of 5 per 1,000 ms, so at 1,000 ms it starts again while `orders`, on the default, is still in its window 0.',
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
        note: 'The first seven rows are the test "a service uses its own limit", which expects `yyyyyny`.',
      },
      pitfalls: [
        'Copying the limit into the counting state when a service is first seen: `setLimit` then does nothing for a service already called, and "a lowered limit applies on the next call" prints `yyy`.',
        'Clearing the count inside `setLimit`: the service gets a fresh allowance whenever its limit is touched, and "a raised limit applies on the next call" prints `yyynyyy`.',
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
      regions: ['log-state', 'sliding-log', 'drop-expired'],
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
      choice:
        'Decide what to store: the time of every allowed request, in a `Map<String, Deque<Long>>` of `ArrayDeque`, fetched with `computeIfAbsent`, which creates the empty log when there is none. Time moves forwards, so new times join at the back and expired ones leave from the front, both O(1). The boundary is one line of `dropExpired`, `log.peekFirst() <= cutoff`, with the cutoff at now minus 10,000 ms: a request exactly 10,000 ms old has left. Test the size before `addLast(now)`, so a refusal is never recorded. **Run the new tests on the stage 2 code first** and show the red `got yyyyyy`.',
      say: "A count can't tell me these six are two seconds apart, so I'm keeping the time of each allowed request in a deque, and dropping the old ones from the front.",
      sketch: {
        caption:
          'Each fixed window sees 3 of the six requests. Any 10 seconds that spans the edge sees all six.',
        text: `time (s)    0                   10                  20
fixed       |===== window 0 ====|===== window 1 ====|
requests                     xxx|xxx
            3 in each window, so all six pass

sliding         (------------xxx|xxx]
            one span of 10 s holds all six: 3 pass`,
      },
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
      pitfalls: [
        'Adding to the log before checking its size: refusals hold slots, and "refused requests are not counted" prints `yyynnnn`.',
        'Writing `<` for `<=` at the cutoff: a time stays 1 ms too long, and "a slot frees exactly one window after its request" prints `yyynnnyn`.',
        'Using a `TreeSet` for the log: three requests in the same millisecond are stored once, and "fourth request in a window is refused" prints `yyyy`.',
        'Leaving out `!log.isEmpty()`: `peekFirst()` returns `null` on a new log, and 12 of the 13 tests fail with `NullPointerException`.',
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
      regions: ['retry-after'],
      pseudocode: `retry after(service):
  require a name; limit = limit for(service); now = clock
  log = the service's log; if it has none: answer 0
  drop expired(log, now, limit)
  must leave = size of log - maximum + 1
  if must leave is 0 or less: answer 0
  blocker = the must-leave-th oldest time in the log
  answer blocker + window - now`,
      verbal: [
        'I count how many of the oldest requests must leave before one more fits: 1 for a full log, more after a lowered limit.',
        'The wait is the time of the last of those plus the window minus now, or 0 if there is room.',
        'I never call `allow` to find out, so asking uses no slot.',
      ],
      choice:
        'Decide which request has to leave before a slot is free. `oldest + 10,000 - now` is a fair first answer, right only while the log holds exactly the limit. With times 0, 1,000 and 2,000 logged and the limit cut to 2, two must leave. So compute `mustLeave = log.size() - limit.maxRequests() + 1` and take that one, counting from the oldest, with `log.stream().skip(mustLeave - 1).findFirst().get()`, because `ArrayDeque` has no `get(i)`. Fetch the log with `logs.get`, not `computeIfAbsent`, so asking about an unknown service leaves no empty log behind. **No test catches that.**',
      say: "The answer is exact: at that moment the blocking request is exactly one window old, and my cutoff says that one has left.",
      trace: {
        caption:
          'Both runs start with requests allowed at 0, 1,000 and 2,000. With the limit lowered to 2, the time 0 leaves at 10,000 and the request is still refused: the slot opens when 1,000 leaves, at 11,000.',
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
        note: 'Rows 1 to 3 are the test "a full service waits until its oldest request leaves", `5000 ny`. Rows 4, 6 and 7 are "a lowered limit waits for enough requests to leave", `9000 ny`. Row 5 is an extra call.',
      },
      pitfalls: [
        'Returning oldest plus window with no count: right until a limit is lowered, then "a lowered limit waits for enough requests to leave" prints `8000 ny`.',
        'Padding the answer by 1 ms to be safe: the caller waits longer than it needs to, and "a full service waits until its oldest request leaves" prints `5001 yn`.',
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
      regions: ['locked-allow', 'locked-set-limit', 'locked-retry-after', 'eviction'],
      pseudocode: `hold one lock for the whole of allow, set limit,
  retry after, evict idle and tracked services

evict idle():
  now = the clock, read once; dropped = 0
  for each service and its log:
    drop expired(log, now, limit for(service))
    if the log is empty: forget the service; dropped + 1
  answer dropped

tracked services(): how many logs are held`,
      verbal: [
        "I'd put `synchronized` on all five methods, one lock for the whole limiter, so the size check and the add happen as one step.",
        '`evictIdle` runs under the same lock, drops the expired times from each log and removes the logs left empty.',
        'That loses nothing, because the next `allow` starts a new empty log and behaves the same.',
      ],
      caveat:
        'The two parallel tests catch a missing lock on most runs, not all: with `synchronized` taken off `allow`, the first failed in 92 runs of 100 in one measurement and 74 of 100 in another, both on 2-core machines.',
      choice:
        'Decide how much to lock, and the answer is everything: `synchronized` on all five methods, one word each, one lock on the limiter. Two steps must each happen as one: check the size then add in `allow`, and check for empty then remove in `evictIdle`. `ConcurrentHashMap` alone is not enough, because the `ArrayDeque` inside it and the check-then-add stay unsafe. In `evictIdle`, loop over `logs.entrySet().iterator()` and remove with `it.remove()`: calling `logs.remove(...)` inside a for-each over the same map throws `ConcurrentModificationException`.',
      say: "Eviction can't live inside `allow`, because `allow` always leaves a log with something in it, so a separate sweep prunes every log and drops the empty ones.",
      trace: {
        caption:
          'At 10,000 the request `orders` made at 0 is exactly one window old, so its log empties and it is dropped. `payments` keeps its request from 9,000, which still counts after the sweep.',
        head: ['Time (ms)', 'Call', 'Answer', 'Logs after the call', 'Services tracked'],
        rows: [
          ['0', '`allow("orders")`', 'allowed', 'orders `[0]`', '1'],
          ['9000', '`allow("payments")`', 'allowed', 'orders `[0]`, payments `[9000]`', '2'],
          ['10000', '`evictIdle()`', '1', 'payments `[9000]`', '1'],
          ['10000', '`allow("payments")`', 'allowed', 'payments `[9000, 10000]`', '1'],
          ['10000', '`allow("payments")`', 'allowed', 'payments `[9000, 10000, 10000]`', '1'],
          ['10000', '`allow("payments")`', 'refused', 'payments `[9000, 10000, 10000]`', '1'],
        ],
        note: 'This is the test "a service with recent requests is kept", which expects `1 1 yyn`.',
      },
      pitfalls: [
        'Locking `allow` and nothing else: `evictIdle` and `setLimit` then change a plain `HashMap` while `allow` reads it. Only "eviction during traffic loses no request" can show it, and in one measurement it did in 6 runs of 40.',
        'Swapping in `ConcurrentHashMap` and dropping the lock: in one measurement it failed 30 runs of 40, with results such as `got [100, 133, 138]`.',
        'Testing for an empty log without dropping expired times first: nothing is ever evicted, and "idle services are evicted" prints `0 2`.',
      ],
    },
  ],
  followUps: [
    {
      q: 'Why start with a fixed window when you knew it lets a burst through?',
      a: "It's one count for each service and passes in about ten minutes, so I have something working to change. Designing the log first risks nothing running when half the time has gone.",
    },
    {
      q: 'How do you test a rate limiter without sleeping?',
      a: "I inject the clock: the tests move a fake one by hand, so 9,999 against 10,000 is exact. Threads start together from a latch, for 20 rounds. That can show a race but can't prove there isn't one, so I argue safety from the lock.",
    },
    {
      q: 'What does the gateway send back when it refuses?',
      a: '`429 Too Many Requests` with a `Retry-After` header in whole seconds, rounded up from `retryAfterMillis`. Callers should back off with jitter, or they all return at the stated instant as one burst.',
    },
    {
      q: 'Why not a token bucket?',
      a: 'The brief is a count, at most 3 in any 10 seconds, and a token bucket promises a rate with a burst on top. A bucket of 3 refilled at 3 per 10 seconds lets a fourth request through 3,334 ms after a burst of three. I\'d pick it for "100 a second, bursts of 200".',
    },
    {
      q: 'Which would you choose from fixed window, sliding log, sliding window counter and token bucket?',
      a: 'It depends on what the limit protects. A fixed window is one count but allows twice the limit across an edge, fine for a daily quota; the sliding log is exact and stores a time for each allowed request, right for a small limit that must hold. The sliding window counter estimates from two counts, and the token bucket is two numbers that limit a rate, not a count.',
    },
    {
      q: 'What would you change before this went to production?',
      a: "Something has to call `evictIdle`: here only the tests do, so I'd add a scheduled task. A limit can't be removed once set, and a limit of 0, to block a service, can't be expressed because `Limit` refuses it. I'd add metrics on refusals too.",
    },
    {
      q: 'The limit becomes 10,000 a minute for each of 10,000 clients. Does the log still work?',
      a: "No. One time for each allowed request is 100 million entries at full use, about 2.8 GB at roughly 28 bytes an entry in an `ArrayDeque<Long>`. A `long[]` ring buffer at 8 bytes a time is about 0.8 GB, and past that I'd use the sliding window counter and give up exactness.",
    },
    {
      q: 'What happens if the clock goes backwards?',
      a: "The log assumes it never does: an older time joins behind newer ones and stays too long, which fails towards refusing. A jump forwards is the unsafe direction, because times expire early. On one machine I'd read a monotonic clock such as `System.nanoTime()`, and with a shared store I'd take the time from the store.",
    },
    {
      q: 'How would you add a limit for each client as well as each service?',
      a: "A record of service and client as a second map key, with its own limit. I'd check both limits before recording in either, or a request the second refuses has used a slot in the first. Memory now grows with the number of clients, so eviction stops being optional.",
    },
    {
      q: 'Where does the single lock hurt, and what would you do then?',
      a: "At very high request rates on one instance, and during a sweep over millions of keys, which holds the lock while every caller waits. I'd move to `ConcurrentHashMap.compute` for each key and sweep a slice at a time. The cost is a rule that's easy to break: nothing touches a deque outside a `compute` lambda.",
    },
    {
      q: 'The gateway runs as four instances. What changes?',
      a: "Each instance counts only its own traffic, so four let through four times the limit. I'd move the state to a shared store such as Redis and do the drop, the count and the add as one atomic script, which costs a round trip on every request. The cheap alternative is a quarter of the limit each, where a busy instance refuses early.",
    },
    {
      q: 'The shared store is down. Do you allow or refuse?',
      a: "For a limit that protects capacity I'd allow, falling back to the in-memory limiter on each instance at its share of the limit, and raise an alert. Refusing turns a limiter outage into a full outage. Where the limit protects money or security, such as login attempts, I'd refuse.",
    },
  ],
  see: [
    { href: '#/s/token-bucket', label: 'Token bucket' },
    { href: '#/s/token-manager', label: 'Token manager' },
    { href: '#/s/queue', label: 'Ring buffer queue' },
    { href: '#/c/resilience-patterns/rate-limiting-and-shedding', label: 'Rate limiting and load shedding' },
    { href: '#/s/retries-breaker', label: 'Retries, backoff and circuit breakers' },
  ],
  unverified: [
    'About 28 bytes for each `ArrayDeque<Long>` entry: one measurement on OpenJDK 21 with default settings. The 2.8 GB and 0.8 GB figures are worked from it and from 8 bytes for a `long`.',
    'How often the parallel tests catch a missing lock (92 of 100, 74 of 100, 6 of 40, 30 of 40): single measurements on 2-core machines.',
    'From memory, not checked against a source: `429 Too Many Requests` with `Retry-After` in seconds; a shared store such as Redis running the drop, the count and the add as one atomic script; `System.nanoTime()` never going backwards; `ConcurrentHashMap.compute` being atomic for its key; `Thread.ofPlatform()` needing Java 21 (the files were run on JDK 21 only).',
    'The sliding window counter and the token bucket were described from memory and not run. The 3,334 ms is arithmetic on a bucket of 3 refilled at 3 per 10,000 ms that allows a request once it holds 1 whole token.',
    'Failing open or closed and backing off with jitter are common practice as the writer understands it, not measured here.',
  ],
};

export default page;
