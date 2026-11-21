import type { Practice } from '../types';

const page: Practice = {
  id: 'currency-converter',
  title: 'Currency converter',
  summary:
    "Write `convert(amount, from, to)` over a rate provider that charges for every call and is sometimes down: round once to the target currency's minor units, reuse a rate for 60 seconds, and serve the last one, flagged stale, for up to 10 minutes of outage.",
  minutes: 40,
  core: 3,
  testing: {
    intro:
      'The code is short: you write 57 lines by the end of stage 3. What counts is how you handle what the brief leaves out, where you put the state, and how you work against the clock.',
    points: [
      'You ask how to round, and whether an old rate may be served when the provider is down, before you type: the brief answers neither.',
      'You get both limits right to the millisecond with the supplied clock: reused at 59,999, fetched again at 60,000, served stale at 600,000, refused at 600,001.',
      'You store each rate with the time it was fetched, not its expiry, so the outage in stage 3 needs a retry loop and one catch block, and no second map.',
    ],
  },
  use: 'Drill "Ask first" and stages 1 to 3 until they take 40 minutes with no page, passing each stage\'s tests before you start the next. Stages 4 and 5 and the last ten minutes are things to say: code them only if there is time left.',
  brief: [
    '"Write a currency conversion service. `convert(amount, from, to)` returns the amount in the target currency. Exchange rates come from a third-party provider, which is stubbed for you. Assume the provider charges per call and is sometimes slow or down. Money is `BigDecimal`, never `double`."',
  ],
  given: [
    '`MINOR_UNITS`: decimal places for GBP 2, USD 2, EUR 2, JPY 0, KWD 3. Any other code is unknown.',
    '`RateProvider.rate(from, to)`: the units of `to` that one `from` buys, so you multiply. It throws `ProviderDownException` (retry) or `UnknownPairException` (never retry).',
    '`FakeClock`, which starts at 0 and moves only on `advance(ms)`, and `FakeProvider`, which counts every call.',
    '`record Conversion(amount, rate, rateAgeMillis, stale)`, `RateUnavailableException` and both constructors, storing `ttlMillis` 60,000 and `staleLimitMillis` 600,000. Only `convert` is a stub.',
    'All 18 tests and every import. Each expectation ends in ` calls N`, the provider calls so far: read it first when a test fails.',
  ],
  ask: [
    {
      q: 'How should I round, and to how many places?',
      why: 'JPY has no minor unit and KWD has three, so "two decimal places" is wrong for two of the five currencies. The mode decides who keeps an exact half.',
      assume: "Round once, at the end, to the target currency's minor units, half to even.",
    },
    {
      q: 'If the provider is down, may I answer with the last rate I have, and how old may it be?',
      why: 'It is a business decision between refusing customers and quoting an old price, and it decides the return type: a served old rate has to say how old it is.',
      assume: 'Yes, for up to 10 minutes, flagged stale with its age so the caller can refuse it. Past that, fail.',
    },
    {
      q: 'How fresh does a rate have to be?',
      why: 'It is the time to live of the cache and sets what you pay: at 60 seconds, at most one call a minute for each pair.',
      assume: '60 seconds, passed to the constructor so a test can use 1 second.',
    },
    {
      q: 'Which failures should I retry, and how many times?',
      why: 'Every attempt is charged. A timeout can pass on the next try; a pair the provider does not quote never will.',
      assume: 'Retry `ProviderDownException` only, 3 attempts in all, with no wait in this exercise.',
    },
    {
      q: 'What counts as bad input, and how should it fail?',
      why: 'A negative amount is a refund in some systems and a bug in others, and the answer decides whether a bad request can cost a provider call.',
      assume:
        '`IllegalArgumentException` for a null or negative amount and a null or unknown code, before any call. `gbp` is unknown, zero is allowed, and the same currency both sides returns the amount unchanged.',
    },
    {
      q: 'Can I start with one thread and a provider that quotes every pair?',
      why: 'Each is a later stage: an unquoted pair needs a derived rate, and many threads on a cold cache each pay for the same rate.',
      assume: "Yes to both. Once the core works I'll derive missing pairs, then make the cache safe with one fetch for each pair.",
    },
  ],
  outline: `convert(amount, from, to):
  refuse a missing or negative amount, or an unknown currency
  same currency both sides: the amount as given, rate 1
  read the clock once
  try to get a fresh rate for the pair: answer, not stale
  the provider is still down after every attempt:
    look at the last rate held for the pair
    none, or more than 10 minutes old: fail, "no usable rate"
    otherwise answer with it, stale if 60 seconds old or more

answer with a rate:
  amount times rate, rounded once, half to even,
    to the target currency's minor units
  with the rate and its age: now minus the time it was fetched

fresh rate for a pair, one thread at a time for each pair:
  held and under 60 seconds old: use it
  otherwise fetch, and hold the new rate with the time now
  a failed fetch leaves the old rate where it was

fetch: up to 3 attempts at the lookup, one after another
  retry only "provider down"; pass on the last failure

lookup: the direct quote; or 1 over the opposite quote;
  or, if neither side is USD: from into USD times USD into to`,
  parts: [
    {
      id: 'convert',
      title: 'Convert and round once',
      stage: 1,
      ask: "Return the amount in the target currency, rounded half to even to that currency's minor units. Reject a null or negative amount, and any currency code you don't know. The same currency needs no rate. Leave stale as false for now.",
      tests: [
        'each currency rounds to its minor units',
        'a half rounds to the even neighbour',
        'same currency returns the amount without a call',
        'null, negative and unknown inputs are rejected',
      ],
      regions: ['convert', 'require-known'],
      pseudocode: `convert(amount, from, to):
  if amount is missing or below zero: refuse
  if from or to is missing or not in the table: refuse
  if from and to are the same:
    answer the amount as given, rate 1, age 0, not stale
  rate = ask the provider for (from, to)
  converted = amount times rate, exact
  round converted once, half to even,
    to the minor units of the target currency
  answer converted, the rate, age 0, not stale`,
      choice:
        'Do all the arithmetic in `BigDecimal`, built from strings, and round once, on the last line. `multiply` is exact (`10.00` times `1.2534` is `12.534000`), so `setScale(MINOR_UNITS.get(to), RoundingMode.HALF_EVEN)` is the only place a digit is dropped: 2 places for USD, 0 for JPY, 3 for KWD. `double` is wrong and nothing reports it: `Math.round(1.005 * 100) / 100.0` is 1.0. `HALF_EVEN` sends an exact half to the even neighbour, where `HALF_UP` would make `1.12500` 1.13. Both guards run before the provider, so a bad request costs no call, and `signum() < 0` lets zero through.',
      say: "I'll keep everything in BigDecimal and round once, at the end, to the target currency's minor units, half to even so the halves don't all go one way.",
      trace: {
        caption:
          'Only the result is rounded: JPY loses all five decimals, and the two halves go opposite ways. The last two rows cost no call.',
        head: ['Call', 'Provider call', 'Exact product', 'Result', 'Calls so far'],
        rows: [
          ['convert 10.00 GBP to JPY', 'rate(GBP, JPY) = 191.237', '`1912.37000`', '`1912`', '1'],
          ['convert 10.00 GBP to USD', 'rate(GBP, USD) = 1.2534', '`12.534000`', '`12.53`', '2'],
          ['convert 1.00 GBP to EUR', 'rate(GBP, EUR) = 1.125', '`1.12500`', '`1.12`', '3'],
          ['convert 1.00 USD to EUR', 'rate(USD, EUR) = 1.135', '`1.13500`', '`1.14`', '4'],
          ['convert 10.00 GBP to GBP', 'none', 'none', '`10.00`, rate 1', '4'],
          ['convert -0.01 GBP to USD', 'none', 'none', 'threw IllegalArgumentException', '4'],
        ],
        note: 'Rows 3 and 4 are the test "a half rounds to the even neighbour".',
      },
      pitfalls: [
        'Rounding every currency to 2 places: the first test prints `12.53 1912.37 3.07` where it expects `12.53 1912 3.071`.',
        'Leaving the mode out of `setScale`: the first two tests print `threw ArithmeticException`.',
        'Calling `containsKey` before the null check: a `Map.of` map throws `NullPointerException` on a null key, and the test wants `IllegalArgumentException`.',
        'Calling the provider before the guards: the bad-input test reports `calls 5` where it expects `calls 0`, and GBP to GBP throws `UnknownPairException`.',
      ],
    },
    {
      id: 'cache',
      title: 'Cache the rate',
      stage: 2,
      ask: 'Every call to the provider costs money. Reuse a pair\'s rate for a time to live: 60 seconds unless the constructor says otherwise. At exactly 60 seconds it has expired. GBP to USD and USD to GBP are separate rates.',
      tests: [
        'rate is reused a millisecond before the ttl',
        'rate is fetched again at exactly the ttl',
        'reverse pair is a separate entry',
      ],
      regions: ['pair-and-cached-rate', 'cache', 'convert', 'apply', 'fresh-rate', 'fetch'],
      pseudocode: `the converter also holds:
  a map from (from, to) to (rate, time fetched)

convert(amount, from, to):
  the checks and the same-currency answer, as before
  now = read the clock, once
  entry = freshRate((from, to), now)
  answer apply(amount, to, entry, now, not stale)

freshRate(pair, now):
  entry = the map's entry for pair
  if there is one and now minus its time is under 60 s:
    answer it
  entry = (fetch(pair), now)
  store it under pair, over the old one
  answer it

fetch(pair): ask the provider for the pair

apply(amount, to, entry, now, stale):
  round amount times the entry's rate, as in stage 1
  answer it with the rate, the stale flag,
    and age = now minus the time fetched`,
      choice:
        'Key the map by the ordered pair and store the rate with **the time it was fetched**, not the time it expires: one timestamp then gives freshness now, the stale limit in stage 3 and the age in the result. Make both records, so `Pair` has `equals` and `hashCode` and works as a `HashMap` key. Fresh is `now - cached.fetchedAt() < ttlMillis`, strictly less, so at exactly 60,000 ms it is fetched again. Read the clock once in `convert` and pass `now` down. Leave an expired entry in the map, because stage 3 serves it, and keep `fetch` as its own one-line method, because the retry loop goes there.',
      say: "I'll key the cache by the ordered pair and store the rate with the time I fetched it, not an expiry time, because I'll want its age later.",
      trace: {
        caption:
          'Row 4 is the cost of caching: the provider already quotes 1.30 and the answer is still 12.53. One millisecond later the same call costs a second provider call and returns 13.00.',
        head: ['t (ms)', 'Event', 'Cache lookup', 'Result', 'Calls', 'Cache after'],
        rows: [
          ['0', 'convert 10.00 GBP to USD', 'miss', '`12.53 age 0`', '1', 'GBP/USD = 1.2534 @0'],
          ['59999', 'convert 10.00 GBP to USD', 'age 59999 < ttl, hit', '`12.53 age 59999`', '1', 'unchanged'],
          ['59999', 'provider now quotes GBP/USD 1.30', '', '', '', ''],
          ['59999', 'convert 10.00 GBP to USD', 'age 59999 < ttl, hit', '`12.53 age 59999`', '1', 'unchanged'],
          ['60000', 'convert 10.00 GBP to USD', 'age 60000 >= ttl, expired', '`13.00 age 0`', '2', 'GBP/USD = 1.30 @60000'],
          ['60000', 'convert 10.00 USD to GBP', 'miss', '`7.98 age 0`', '3', '+ USD/GBP = 0.7978 @60000'],
        ],
        note: 'The default 60,000 ms time to live. The test "rate is fetched again at exactly the ttl" does rows 3 to 5 with 1,000 ms.',
      },
      pitfalls: [
'Trusting two passes out of three: with no cache at all, only "rate is reused a millisecond before the ttl" fails.',
        'Writing `<=` at the time to live: "rate is fetched again at exactly the ttl" gets `12.53 age 1000 stale false calls 1` where it expects `13.00 age 0 stale false calls 2`.',
        'Keying by an unordered pair, or by `from` alone: USD to GBP is answered with the GBP/USD rate, `12.53 calls 1` where the test expects `7.98 calls 2`.',
      ],
    },
    {
      id: 'failure',
      title: 'When the provider is down',
      stage: 3,
      ask: "The provider is sometimes down. Retry at once, three attempts in all. If it's still down, serve the pair's last rate, marked stale, as long as it is no more than 10 minutes old. Past that, fail clearly.",
      tests: [
        'two failures then a success is fresh',
        'down provider serves a stale rate, then a fresh one',
        'stale rate is served at exactly the stale limit',
        'past the stale limit the conversion fails',
        'down with nothing cached fails after 3 calls',
      ],
      regions: ['retry-limit', 'convert', 'fetch'],
      pseudocode: `convert(amount, from, to):
  the checks and the same-currency answer, as before
  now = read the clock, once
  try:
    entry = freshRate(pair, now)
    answer apply(amount, to, entry, now, not stale)
  if the provider is still down after every attempt:
    last = the map's entry for pair
    if there is none, or it is more than 10 minutes old:
      fail: "no usable rate for from/to", keeping the cause
    answer apply(amount, to, last, now, stale)

fetch(pair):
  3 times:
    try: answer the provider's rate for the pair
    if the provider is down: remember the failure, go round
      (real code would wait here, longer each time)
  throw the last failure
  (an unknown pair is not caught: it leaves at once)`,
      choice:
        "Serve the old rate and say so; the alternatives are failing every conversion or quoting an old price in silence. `convert` always tries to refresh first, and only after `fetch` has failed 3 times does it read `cache.get(pair)`. **The two limits have opposite boundaries**: the time to live is exclusive (`< ttlMillis`, so 60,000 ms fetches again) and the stale limit inclusive (`> staleLimitMillis` fails, so 600,000 is served and 600,001 throws). Age runs from the last successful fetch, because a failed refresh leaves the entry alone. `fetch` catches `ProviderDownException` only: `UnknownPairException` leaves on the first attempt, since every attempt is charged.",
      say: "This is a business decision and I'd confirm it: if the provider's still down after three attempts I serve the last rate for up to 10 minutes, flagged stale with its age, and the caller decides.",
      trace: {
        caption:
          'Every answer during an outage costs 3 failed calls: 1 to 4, 5 to 8, 8 to 11. Age counts from the last successful fetch, at t = 61000, and one millisecond separates a stale answer from a failure.',
        head: ['t (ms)', 'Event', 'Inside', 'Result', 'Calls'],
        rows: [
          ['0', 'convert 10.00 GBP to USD', 'miss, fetching', '`12.53 age 0 stale false`', '1'],
          ['61000', 'provider down for next 3 calls', '', '', ''],
          ['61000', 'convert', 'expired (age 61000); attempts 1, 2, 3 fail; last cached @0, age 61000 vs limit 600000', '`12.53 age 61000 stale true`', '4'],
          ['61000', 'convert', 'expired (age 61000), fetching', '`12.53 age 0 stale false`', '5'],
          ['661000', 'provider down for next 3 calls', '', '', ''],
          ['661000', 'convert', 'expired (age 600000); 3 attempts fail; age 600000 vs limit 600000', '`12.53 age 600000 stale true`', '8'],
          ['661001', 'provider down for next 3 calls', '', '', ''],
          ['661001', 'convert', 'expired (age 600001); 3 attempts fail; age 600001 vs limit 600000', 'threw RateUnavailableException', '11'],
        ],
        note: 'Rows 1 to 4 are the test "down provider serves a stale rate, then a fresh one".',
      },
      pitfalls: [
        'Reading `last.fetchedAt()` with nothing cached: "down with nothing cached fails after 3 calls" reports `threw NullPointerException`.',
        'Writing `attempt < MAX_ATTEMPTS` from 1: "two failures then a success is fresh" prints `threw RateUnavailableException`, and three more tests are one call short.',
        'Using `>=` for the stale limit because the time to live used `<`: "stale rate is served at exactly the stale limit" prints `threw RateUnavailableException`.',
        'Catching `RuntimeException` in the retry loop: all five tests still pass, and an unquoted pair costs 3 paid calls where it should cost 1.',
      ],
    },
    {
      id: 'unquoted',
      title: 'Pairs the provider does not quote',
      stage: 4,
      ask: "The provider doesn't quote every pair. If the direct pair is missing, try the inverse and use 1 over it. If that's missing too, go through USD. Keep full precision until the final rounding.",
      tests: [
        'inverse pair is used when the direct one is missing',
        'cross rate goes through usd and is cached',
        'intermediate amount is not rounded',
      ],
      regions: ['base-currency', 'fetch', 'lookup'],
      pseudocode: `fetch(pair): as before, but each attempt is lookup(from, to)

lookup(from, to):
  try: answer directOrInverse(from, to)
  if the provider quotes neither direction:
    if from or to is USD: give up, unknown pair
    answer directOrInverse(from, USD)
      times directOrInverse(USD, to), exact, unrounded

directOrInverse(from, to):
  try: answer the provider's rate for (from, to)
  if it does not quote that pair:
    answer 1 divided by its rate for (to, from),
      to 34 significant digits`,
      verbal: [
        "I'd derive one rate for the pair and never convert the amount in steps, so the only rounding is still the last line.",
        "I'd try the direct quote, then 1 over the opposite quote to 34 digits, then two legs through USD multiplied exactly.",
        'An inverse costs 2 paid calls and a cross rate 4 to 6, and the derived rate is cached under the pair I was asked for.',
      ],
      choice:
        "`lookup` returns one rate for the asked pair with every digit it has, so the `setScale` in `apply` stays the only rounding; converting leg by leg rounds in the middle, and the trace shows that giving 0.05 where the answer is 0.04. The inverse is a division, and `BigDecimal.ONE.divide(x)` with one argument throws `ArithmeticException` on 1 over 0.75, so pass `MathContext.DECIMAL128` for 34 digits. With USD already on one side there is no third route, so the `UnknownPairException` is rethrown. One line of `fetch` changes, and the retry now wraps the whole `lookup`.",
      say: "Direct quote first, then one over the opposite quote, then through US dollars, and nothing is rounded until the end.",
      trace: {
        caption:
          'Only the result is rounded. The two comparison rows show what early rounding costs: 0.05 for 0.04, and 399.99 for 400.00. The last row has no route: 4 paid calls, then the failure, with no retry.',
        head: ['Event', 'Provider calls, in order', 'Rate used', 'Result', 'Calls'],
        rows: [
          ['only USD/GBP 0.75; convert 300.00 GBP to USD', 'rate(GBP, USD) unknown; rate(USD, GBP) = 0.75, inverted', '`1.333333333333333333333333333333333`', '`400.00`', '2'],
          ['GBP/USD 1.25, USD/JPY 150.123; convert 10.00 GBP to JPY', 'rate(GBP, JPY) unknown; rate(JPY, GBP) unknown; via USD: rate(GBP, USD) = 1.25; rate(USD, JPY) = 150.123', '`187.65375`', '`1877`', '4'],
          ['same converter, convert again', 'cache hit GBP/JPY', '`187.65375`', '`1877`', '4'],
          ['JPY/USD 0.0066, USD/EUR 0.92; convert 7 JPY to EUR', 'rate(JPY, EUR) unknown; rate(EUR, JPY) unknown; rate(JPY, USD) = 0.0066; rate(USD, EUR) = 0.92', '`0.006072`', '`0.04`', '4'],
          ['for comparison: round the USD amount first', '7 x 0.0066 = 0.0462 USD, rounded 0.05; x 0.92 = 0.0460', '', '`0.05`', ''],
          ['for comparison: inverse at 4 decimal places', '1.3333; 300.00 x 1.3333', '', '`399.99`', ''],
          ['nothing quoted; convert 10.00 GBP to EUR', 'rate(GBP, EUR) unknown; rate(EUR, GBP) unknown; rate(GBP, USD) unknown; rate(USD, GBP) unknown', '', 'threw UnknownPairException', '4'],
        ],
        note: 'Each row is a new converter except row 3. The comparison rows are arithmetic, not runs. No test covers the last row.',
      },
      pitfalls: [
        'Dividing with no `MathContext`: "inverse pair is used when the direct one is missing" prints `threw ArithmeticException`.',
        'Rounding the inverse to a few places: the same test prints `13.33 399.99` where it expects `13.33 400.00`.',
        'Catching `UnknownPairException` in the retry loop "to be safe": a pair with no route then costs 12 paid calls where it cost 4, and no test fails.',
      ],
    },
    {
      id: 'concurrency',
      title: 'One call for a hundred threads',
      stage: 5,
      ask: 'Now a hundred threads convert the same pair at the same moment. The provider is slow and it charges per call. I want one call, not a hundred, on a cold cache and when the rate expires.',
      tests: [
        'hundred threads on a cold cache make one call',
        'an expired rate is refreshed by one call',
        'two pairs at once make one call each',
      ],
      regions: ['cache', 'fresh-rate', 'convert'],
      pseudocode: `the map becomes one that is safe for many threads

freshRate(pair, now):
  in one atomic step for this pair
  (other threads asking for the same pair wait):
    if there is an entry under 60 s old: keep it
    otherwise: replace it with (fetch(pair), now)
    if fetch fails: change nothing, pass the failure on
  answer the entry

convert, when the provider is down:
  last = the map's entry for pair
  none, or more than 10 minutes old: fail as before
  stale = last is 60 s old or more
    (another thread may have loaded it a moment ago)
  answer apply(amount, to, last, now, stale)`,
      verbal: [
        "A thread-safe map isn't enough, because the check and the fetch have to be one atomic step for each pair.",
        "I'd use `compute` on a `ConcurrentHashMap`, so one thread fetches while the others asking for that pair wait and then find the fresh rate.",
        'The cost is that every caller of that pair waits through up to 3 slow attempts, with no timeout.',
      ],
      caveat:
        'The stale-flag fix has no deterministic test: a new rate went out flagged stale in 149 of 300 runs of the race before it, and in none of 300 after.',
      choice:
        "`cache.compute(pair, fn)` on a `ConcurrentHashMap` runs `fn` for a key while other `compute` calls on that key wait, which closes the gap that `get` then `put` leaves even on a thread-safe map. `computeIfAbsent` won't do, because an expired rate is still an entry and would never be refreshed. When `fn` throws, the old entry stays, and the stale path still finds it. That path now sets `stale = now - last.fetchedAt() >= ttlMillis`, the exact opposite of the fresh test, because another thread may have loaded a new rate since this fetch failed.",
      say: "I'm using compute so that the check and the load are one atomic step for each pair, and one thread loads while the rest wait.",
      trace: {
        caption:
          'The stage 4 code pays 100 calls and then 99; the stage 5 code pays 1 each time. Rows 6 and 7 are one scenario run twice, with a load that fails: the answers differ, the calls do not, and no answer is flagged stale at age 0.',
        head: ['Code', 'Scenario, 100 threads', 'Answers', 'Provider calls', 'Loader ran on'],
        rows: [
          ['stage 4', 'cold cache, GBP to USD', '100 × `12.53 age 0 stale false`', '100', '100 threads'],
          ['stage 4', 'same converter at t = 60000 (expired)', '100 × `12.53 age 0 stale false`', '199 (99 more)', '99 threads'],
          ['stage 5', 'cold cache, GBP to USD', '100 × `12.53 age 0 stale false`', '1', 'thread 98 only'],
          ['stage 5', 'same converter at t = 60000 (expired)', '100 × `12.53 age 0 stale false`', '2 (1 more)', 'thread 2 only'],
          ['stage 5', 'new converter; 50 threads GBP to USD, 50 USD to GBP', '50 × `12.53 age 0 stale false`, 50 × `7.98 age 0 stale false`', '2', 'thread 1 (GBP/USD), thread 2 (USD/GBP)'],
          ['stage 5', 'new converter, cold; provider down for 3 calls', '99 × `12.53 age 0 stale false`, 1 × threw RateUnavailableException', '4', 'thread 1 (3 failures), thread 98 (success)'],
          ['stage 5', 'the same scenario, another run', '100 × `12.53 age 0 stale false`', '4', 'thread 1 (3 failures), thread 100 (success)'],
        ],
        note: 'Rows 3 to 5 are the three tests; no test covers rows 6 and 7. Which thread loads varies between runs.',
      },
      pitfalls: [
        'Swapping in `ConcurrentHashMap` and keeping `get` then `put`: every answer is right, and the first test reports `calls 100` where it expects `calls 1`.',
        'Declaring `convert` `synchronized` and stopping: all 18 tests pass, and one slow fetch holds up every conversion of every pair.',
        'Leaving `true` on the stale path: all 18 tests pass, and now and then a rate loaded a moment ago by another thread goes out flagged stale with age 0.',
      ],
    },
  ],
  followUps: [
    {
      q: 'How did you test expiry and failure without sleeping?',
      a: "Both the clock and the provider are passed in, so a test moves time itself and makes the provider fail on demand, and each limit is checked at its exact millisecond. For threads I use latches with a bounded wait, and I'd run that test a couple of hundred times before trusting it.",
    },
    {
      q: 'Why does `convert` return a record and not a `BigDecimal`?',
      a: "Because by stage 3 the answer can rest on a rate that's ten minutes old, and a bare number can't say so. With the rate's age and a stale flag in the result, a price display can show it and a payment can refuse it, and the outage changed no signature.",
    },
    {
      q: 'Why half to even, and who keeps the rounding remainder?',
      a: "Halves then go down as often as up: the 100 amounts 1.005, 1.015 and so on to 1.995 sum to 150.00 that way and to 150.50 rounded half up. Somebody still keeps a fraction of a penny each time, so I'd want that decided and posted to a rounding account. If the product or a regulator names a mode, I use theirs.",
    },
    {
      q: 'The provider is down for an hour. What does this code do?',
      a: "For 10 minutes every pair it has seen is answered stale, then every conversion fails. Nothing remembers the provider is down, so each conversion pays for 3 failed calls with no wait between them. I'd add a [circuit breaker](#/p/circuit-breaker) that goes straight to the stale rate, and backoff with jitter and a timeout on each call.",
    },
    {
      q: 'Why not always derive the rate through USD?',
      a: "Because a direct quote is the provider's price for that pair, and each leg of a cross rate carries its own spread, so two quotes multiplied won't in general equal it. I derive only when there's no direct quote. Only the asked pair is cached, so GBP to JPY and GBP to EUR each pay for their own GBP/USD leg.",
    },
    {
      q: 'What would you change before this went to production?',
      a: "The money model first: a buying and a selling rate for each pair with a spread or a fee, and currency as a type such as `java.util.Currency`, with minor units loaded from the ISO 4217 table. Then the gaps: a zero rate throws `ArithmeticException` when inverted, and 1.005 GBP to GBP comes back as 1.005, unchecked against the minor units. The cache never evicts, which is fine at 20 pairs.",
    },
    {
      q: 'How would you use several providers?',
      a: "Behind the same `RateProvider` interface, as one provider that tries each in order with a timeout and a breaker for each; the stale rate stays the last resort. Providers disagree by a little, so I'd record which one each rate came from and never switch a customer between them in the middle of one purchase.",
    },
    {
      q: 'At 10,000 conversions a second on several instances, would you still fetch when a request arrives?',
      a: "No: rates change far more slowly than requests arrive, so one fetcher loads every rate on a timer, every few seconds, and publishes a snapshot that each instance serves from memory. Provider cost follows the timer, not the traffic, and every instance quotes the same rate. The cost is paying for pairs nobody asks for, and the 10-minute limit still applies if the feed stops.",
    },
    {
      q: 'A customer disputes a conversion next month. What did you need to store?',
      a: "With the transaction: the rate, which provider it came from, when it was fetched, whether it was stale or derived and from which legs, the rounding mode and the unrounded amount. `Conversion` already carries the rate, its age and the stale flag; production adds the source and an id.",
    },
    {
      q: 'A customer sees a quote, then pays twenty seconds later. Which rate are they charged?',
      a: "The one they were shown, never whatever the cache holds at payment time. A quote becomes a stored record with an id, the rate, both amounts and an expiry of, say, 30 seconds, and the payment names the quote id. After the expiry it is refused and quoted again, and the business carries any movement in the rate until then.",
    },
    {
      q: 'What is wrong with `compute` in production?',
      a: "It holds every caller of a pair through up to 3 slow attempts, and a waiter can't give up or take the stale rate. I'd keep a `CompletableFuture` for each pair, so callers wait with a timeout, and remove a failed one so the failure isn't cached. On a real clock another thread's fetch time can also be later than my `now`, giving a slightly negative age.",
    },
  ],
  see: [
    { href: '#/s/cache-strategies', label: 'Cache read and write strategies' },
    { href: '#/c/caching/ttl-stampede', label: 'Caching: TTLs, jitter and stampedes' },
    { href: '#/s/retries-breaker', label: 'Retries, backoff and circuit breakers' },
    { href: '#/c/resilience-patterns/degradation', label: 'Resilience patterns: fallbacks' },
    { href: '#/p/circuit-breaker', label: 'Practice: circuit breaker' },
  ],
  unverified: [
    "Minor units (JPY 0, KWD 3, the others 2) are the starter's values, and ISO 4217 as the source of the real table is general knowledge: neither was checked against the standard.",
    'Regulators or products requiring a rounding mode, and a rounding account for remainders: general knowledge, not checked.',
    'Each leg of a cross rate carrying its own spread: how foreign exchange is usually described, not checked and not shown by this code.',
    '`ConcurrentHashMap.compute` running one function at a time for a key, and leaving the entry alone when the function throws: both seen in runs here, not checked against the JDK documentation.',
    'The follow-up designs (circuit breaker, backoff with jitter, several providers, a timer-driven snapshot from one fetcher, stored quotes, a future for each pair, buying and selling rates, `java.util.Currency`) are from memory; none was built here, and the 30-second quote expiry is an example figure.',
    'The stage 5 race counts (149 of 300 runs before the fix, none after) are one experiment on one machine; a repeat gave 156 of 300 before and none after.',
    'A slightly negative age on a real clock is reasoned from the stage 5 code, not seen in a run.',
  ],
};

export default page;
