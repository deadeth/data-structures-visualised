import type { Practice } from '../types';

const page: Practice = {
  id: 'currency-converter',
  title: 'Currency converter',
  summary:
    "Write `convert(amount, from, to)` over a rate provider that charges for every call and is sometimes down. It starts as arithmetic with `BigDecimal`; by stage 3 it is testing what your service does when its supplier is slow, costly or unavailable.",
  minutes: 40,
  core: 3,
  brief: [
    '"Write a currency conversion service. `convert(amount, from, to)` returns the amount in the target currency. Exchange rates come from a third-party provider, which is stubbed for you. Assume the provider charges per call and is sometimes slow or down. Money is `BigDecimal`, never `double`."',
    'The first two sentences are one multiplication. The fourth is the task. "Charges per call" becomes a cache in stage 2, and "sometimes down" becomes the decision in stage 3: what your callers get when you cannot get a rate. Ask about both before you type.',
  ],
  given: [
    '`MINOR_UNITS`, a map from currency code to decimal places: GBP 2, USD 2, EUR 2, JPY 0, KWD 3. It is also the list of currencies you support. Any other code is unknown.',
    '`RateProvider`, with one method: `rate(from, to)` is how many units of `to` one unit of `from` buys. So you multiply the amount by it. Every call is charged.',
    'Two unchecked exceptions the provider throws. `ProviderDownException`: it is down or timed out, and trying again may work. `UnknownPairException`: it does not quote that pair, and trying again will not help. They are separate types so that you can retry one and not the other.',
    '`Clock`, with `millis()`, and `FakeClock`, which starts at 0 and moves only when a test calls `advance(ms)`. Read time from the clock you are given and nowhere else.',
    '`FakeProvider`, a table of quotes. `calls()` counts every call, failed ones included. `failNext(n)` makes the next n calls throw `ProviderDownException`. `holdCalls(gate)` makes calls wait on a latch for the concurrency stage.',
    'In your part of the file, already written: `record Conversion(BigDecimal amount, BigDecimal rate, long rateAgeMillis, boolean stale)`, which is what `convert` returns, and `RateUnavailableException(message, cause)` for stage 3. Use them as they are.',
    '`CurrencyConverter` with both constructors done and four fields stored: the provider, the clock, `ttlMillis` (60,000 by default) and `staleLimitMillis` (600,000). `convert` is a stub that throws `UnsupportedOperationException`. No later stage changes a signature.',
    'The tests of all five stages. Each test gets a new clock, provider and converter. The provider quotes GBP/USD 1.2534, USD/GBP 0.7978, GBP/JPY 191.237 and USD/KWD 0.30712 unless the test calls `quotes(...)`. Every expectation ends in ` calls N`, the number of provider calls so far, so the cost of your code is checked in every test.',
    'Wildcard imports for `java.math`, `java.util` and `java.util.concurrent`. You add no import in any stage. Set `STAGE` and run `main`: with the starter untouched, all four stage 1 tests fail and nothing crashes.',
  ],
  ask: [
    {
      q: 'How should I round, and to how many places?',
      why: 'JPY has no minor unit and KWD has three, so "two decimal places" is wrong for two of the five currencies in the table. The rounding mode decides which way an exact half goes, and so who keeps the fraction.',
      assume: "Round once, at the end, to the target currency's minor units from `MINOR_UNITS`, half to even.",
    },
    {
      q: 'How fresh does a rate have to be?',
      why: 'The answer is the time to live of the cache, and it sets what you pay: at 60 seconds, at most one call a minute for each pair, however many conversions arrive.',
      assume: '60 seconds, passed to the constructor so a test can use 1 second.',
    },
    {
      q: 'If the provider is down, may I answer with the last rate I have, and how old may it be?',
      why: 'It is a business decision between refusing customers and quoting an old price. It also decides the return type: if old rates are served, the result has to say how old.',
      assume: "Yes, for up to 10 minutes, with the result flagged stale and carrying the rate's age so the caller can refuse it. Past 10 minutes the conversion fails.",
    },
    {
      q: 'What counts as bad input, and how should it fail?',
      why: 'A negative amount is a refund in some systems and a bug in others. The answer fixes the first lines of `convert`, and whether a bad request can cost a provider call.',
      assume:
        '`IllegalArgumentException` for a null or negative amount and for a null or unknown code, before any provider call. Codes are case-sensitive, so `gbp` is unknown. Zero is allowed. The same currency on both sides returns the amount unchanged, with no call.',
    },
    {
      q: 'Which failures should I retry, and how many times?',
      why: 'Every attempt is charged. Retrying a provider that timed out can work. Retrying a pair it does not quote spends three calls on an answer that cannot change.',
      assume: 'Retry `ProviderDownException` only, 3 attempts in all, with no wait between them in this exercise. Never retry `UnknownPairException`.',
    },
    {
      q: 'Does the provider quote every pair?',
      why: 'If it does not, you need a rule for deriving a rate: 1 over the opposite quote, or two quotes multiplied through a common currency. Each derived rate is extra calls and extra precision to look after.',
      assume: 'No. Use the direct quote when there is one, then the inverse, then go through USD.',
    },
    {
      q: 'Will this be called from many threads?',
      why: 'A plain map is fine on one thread. With many, a cold cache lets every thread miss at once, and each one pays for the same rate.',
      assume: "One thread to start with. I'll make the cache safe, with one fetch for each pair, once the rest works.",
    },
  ],
  outline: `convert(amount, from, to):
  refuse a missing or negative amount
  refuse a currency that is missing or not in the table
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
      regions: ['convert', 'require-known'],
      explain: [
        'Do all the arithmetic in `BigDecimal` and round exactly once, on the last line. `multiply` is exact: the scales add, so `10.00` times `1.2534` is `12.534000` with nothing lost. `setScale` is then the only place a digit is dropped, and it drops to the target currency\'s places from `MINOR_UNITS`: 2 for USD, 0 for JPY, 3 for KWD. The obvious alternative is `double`, and it is wrong in a way no exception reports: `Math.round(1.005 * 100) / 100.0` is 1.0, not 1.01. Build every `BigDecimal` from a string.',
        'The mode is `HALF_EVEN`. It changes one case only, an exact half, and sends it to the neighbour whose last digit is even: `1.12500` goes down to 1.12 and `1.13500` goes up to 1.14. `HALF_UP` gives 1.13 and 1.14. The code uses half to even because halves then go down as often as up. Take the 100 amounts 1.005, 1.015 and so on to 1.995: they sum to 150.000. Rounded half up they sum to 150.50, half a penny gained on every one. Rounded half to even they sum to 150.00. Anything that is not an exact half rounds the same under both.',
        '`convert` returns a `Conversion`: the amount, the rate used, the rate\'s age in milliseconds and a stale flag. The starter fixed that type before any code was written, and you should be ready to defend it when asked "why not just return a `BigDecimal`?". By stage 3 the answer can rest on a rate that is ten minutes old, and a bare number cannot say so. Fixing the type now means stage 3 changes no signature and no earlier test. In this stage you fill in the rate, 0 and `false`.',
        'Check before you spend. Both guards run before the provider is touched, so a bad request costs no call, and the test expects `calls 0`. The same currency returns early with the amount exactly as given, `10.00` back as `10.00`, and rate `BigDecimal.ONE`. `signum() < 0` rejects negatives and lets zero through.',
        'Type it in this order: the amount guard, `requireKnown` and its two calls, the same-currency return, then the three lines of arithmetic. Each conversion costs one provider call. That is the problem stage 2 exists to fix.',
      ],
      lines: [
        {
          code: 'if (amount == null || amount.signum() < 0) {',
          note: '`signum()` is the sign as -1, 0 or 1, so this reads "negative" with no second `BigDecimal` to compare against. Zero passes.',
        },
        {
          code: '.setScale(MINOR_UNITS.get(to), RoundingMode.HALF_EVEN);',
          note: 'The one place rounding happens. The mode is not optional: `setScale(2)` with no mode throws `ArithmeticException` as soon as a digit would be lost, which is the first conversion.',
        },
        {
          code: 'return new Conversion(amount, BigDecimal.ONE, 0, false);',
          note: 'Same currency: the amount as given, rate 1, and no call. Without this line the fake provider is asked for GBP/GBP and throws `UnknownPairException`.',
        },
        {
          code: 'if (currency == null || !MINOR_UNITS.containsKey(currency)) {',
          note: 'The null check has to come first. A map made by `Map.of` throws `NullPointerException` from `containsKey(null)`, and the test wants `IllegalArgumentException`.',
        },
      ],
      trace: {
        caption:
          'The product column is exact and only the result is rounded. JPY loses all five decimals. The two halves go opposite ways: `1.12500` down to 1.12, `1.13500` up to 1.14. The last two rows cost no call.',
        head: ['Call', 'Provider call', 'Exact product', 'Result', 'Calls so far'],
        rows: [
          ['convert 10.00 GBP to JPY', 'rate(GBP, JPY) = 191.237', '`1912.37000`', '`1912`', '1'],
          ['convert 10.00 GBP to USD', 'rate(GBP, USD) = 1.2534', '`12.534000`', '`12.53`', '2'],
          ['convert 1.00 GBP to EUR', 'rate(GBP, EUR) = 1.125', '`1.12500`', '`1.12`', '3'],
          ['convert 1.00 USD to EUR', 'rate(USD, EUR) = 1.135', '`1.13500`', '`1.14`', '4'],
          ['convert 10.00 GBP to GBP', 'none', 'none', '`10.00`, rate 1', '4'],
          ['convert -0.01 GBP to USD', 'none', 'none', 'threw IllegalArgumentException', '4'],
        ],
        note: 'One converter, with a provider quoting GBP/USD 1.2534, GBP/JPY 191.237, GBP/EUR 1.125 and USD/EUR 1.135. Rows 3 and 4 are the test "a half rounds to the even neighbour". Rows 1 and 2 are two of the three conversions in "each currency rounds to its minor units".',
      },
      say: "I'll keep everything in BigDecimal and round once, at the end, to the target currency's minor units, half to even so the halves don't all go one way. I'm returning a small result record and not a bare amount, because later the caller will need to know which rate was used and how old it was.",
      pitfalls: [
        'Using `double` anywhere, including `new BigDecimal(0.1)`: nothing throws, and a result is a penny out, as with `Math.round(1.005 * 100) / 100.0` giving 1.0.',
        'Rounding every currency to 2 places: the first test prints `12.53 1912.37 3.07` where it expects `12.53 1912 3.071`.',
        'Leaving the rounding mode out of `setScale`: the first two tests print `threw ArithmeticException`.',
        'Calling the provider before the guards: the bad-input test reports `calls 5` where it expects `calls 0`, and GBP to GBP throws `UnknownPairException` because the fake has no such quote.',
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
      regions: ['pair-and-cached-rate', 'cache', 'convert', 'apply', 'fresh-rate', 'fetch'],
      explain: [
        'The decision is what the map holds. The key is the ordered pair and the value is the rate with **the time it was fetched**, not the time it expires. One timestamp then answers three things: whether the rate is fresh (this stage), whether it is too old to serve at all (stage 3), and its age for the result. An expiry time answers only the first. Both are records. `Pair` gets `equals` and `hashCode` for free, which is what makes it usable as a `HashMap` key, and it cannot be built wrong by a typo in a separator the way a `"GBP/USD"` string key can.',
        'A rate is fresh while `now - fetchedAt < ttlMillis`. At 59,999 ms it is reused; at 60,000 it is fetched again. An expired entry is not removed. The next successful fetch writes over it, and until then it stays in the map, because stage 3 will need it.',
        'Read the clock once at the top of `convert` and pass `now` down. The freshness check, the new entry\'s timestamp and the age in the result then all describe one instant. Use the clock you were given: with `System.currentTimeMillis()` the tests cannot move time and nothing ever expires.',
        'What changed since stage 1: the arithmetic moved into `apply`, and `convert` ends in three lines that build the pair, read the clock and call `apply(amount, to, freshRate(pair, now), now, false)`. `apply` takes the stale flag as an argument already, so stage 3 calls it with `true` and changes nothing inside. `fetch` is one line around the provider. It looks pointless now. It is where stage 3 puts the retry loop and stage 4 puts the routes, and `freshRate` is untouched by both.',
        'Cost: one `HashMap` lookup for each conversion, and one entry for each pair ever asked for, which is at most 20 with five currencies. The price of caching is in the trace: at 59,999 ms the provider already quotes 1.30 and the caller is still given 12.53.',
      ],
      lines: [
        {
          code: 'if (cached != null && now - cached.fetchedAt() < ttlMillis) {',
          note: 'Strictly less than, so "exactly the time to live" is expired. With `<=` the test "rate is fetched again at exactly the ttl" gets `12.53 age 1000 stale false calls 1` where it expects `13.00 age 0 stale false calls 2`.',
        },
        {
          code: 'private record Pair(String from, String to) {}',
          note: 'The ordered pair as a key. A record compares by its fields, so two `Pair`s with the same codes are the same key, and GBP/USD is a different key from USD/GBP.',
        },
        {
          code: 'long now = clock.millis();',
          note: 'The only reading of the clock in a conversion. Everything below takes `now` as an argument.',
        },
        {
          code: 'now - r.fetchedAt(), stale);',
          note: 'The age in the result is worked out here from the stored fetch time. A hit a millisecond before expiry reports `age 59999`.',
        },
      ],
      trace: {
        caption:
          'Row 4 is the cost of caching: the provider already quotes 1.30 and the answer is still 12.53. One millisecond later the entry has expired, and the same call costs a second provider call and returns 13.00.',
        head: ['t (ms)', 'Event', 'Cache lookup', 'Result', 'Calls', 'Cache after'],
        rows: [
          ['0', 'convert 10.00 GBP to USD', 'miss', '`12.53 age 0`', '1', 'GBP/USD = 1.2534 @0'],
          ['59999', 'convert 10.00 GBP to USD', 'age 59999 < ttl, hit', '`12.53 age 59999`', '1', 'unchanged'],
          ['59999', 'provider now quotes GBP/USD 1.30', '', '', '', ''],
          ['59999', 'convert 10.00 GBP to USD', 'age 59999 < ttl, hit', '`12.53 age 59999`', '1', 'unchanged'],
          ['60000', 'convert 10.00 GBP to USD', 'age 60000 >= ttl, expired', '`13.00 age 0`', '2', 'GBP/USD = 1.30 @60000'],
          ['60000', 'convert 10.00 USD to GBP', 'miss', '`7.98 age 0`', '3', '+ USD/GBP = 0.7978 @60000'],
        ],
        note: 'One converter with the default 60,000 ms time to live. Rows 1 and 2 are the test "rate is reused a millisecond before the ttl". The test "rate is fetched again at exactly the ttl" does what rows 3 to 5 do, with a time to live of 1,000 ms. The last row is the second conversion in "reverse pair is a separate entry".',
      },
      say: "I'll key the cache by the ordered pair and store the rate with the time I fetched it, not an expiry time, because I'll want its age later. Fresh means strictly younger than the time to live, so at exactly 60 seconds I fetch again.",
      pitfalls: [
        'Trusting two passes out of three: with no cache at all, "rate is fetched again at exactly the ttl" and "reverse pair is a separate entry" both pass. Only "rate is reused a millisecond before the ttl" shows a cache is there.',
        'Keying the map by an unordered pair, or by `from` alone: 10.00 USD to GBP is answered with the GBP/USD rate, and the test prints `12.53 calls 1` where it expects `7.98 calls 2`.',
        'Calling `System.currentTimeMillis()` in place of the injected clock: advancing the fake clock does nothing, no entry expires, and two of the three tests fail, one of them on the age alone.',
        'Storing an expiry time, or deleting an entry once it has expired: this stage passes, and stage 3 then has no age to report and no last rate to fall back on.',
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
      regions: ['retry-limit', 'convert', 'fetch'],
      explain: [
        'Up to here the task was arithmetic and a map. **This is the stage it was set for**: your supplier fails, and you decide what your own callers get. There are three possible answers. Fail every conversion. Serve the old rate and say nothing. Serve the old rate and say so. This code takes the third, and "stale" has an exact meaning in it: the rate is past its 60-second time to live, a refresh was tried 3 times and failed, and this is the last rate the provider did give. An expired rate is never served just because it is there. `convert` always tries to refresh first.',
        'There are two time limits and their boundaries differ. The time to live is exclusive: a rate is fresh while its age is under 60,000 ms, and at exactly 60,000 it is fetched again. The stale limit is inclusive: an old rate may be served while its age is at most 600,000 ms, and at 600,001 the conversion fails. So from 60 seconds to 10 minutes a rate is served only when the provider is down, and after 10 minutes not at all. Age runs from the last successful fetch. A failed refresh leaves the entry untouched, so an outage cannot make an old rate look newer.',
        "The result carries the rate's age because whether an old rate will do is the caller's decision, not the converter's. A screen showing an indicative price can show it with \"rate from 61 seconds ago\". A payment can read `stale` and refuse. Both use the same method. This is where stage 1's return type earns its place: `stale` and `rateAgeMillis` were already in `Conversion`, so no signature and no earlier test changes. With a bare `BigDecimal` you would now be choosing between a new method and a stale answer nobody can detect.",
        '`fetch` makes up to 3 attempts and catches `ProviderDownException` only. `UnknownPairException` is not caught, so it leaves on the first attempt: the provider will not start quoting the pair because you asked again, and each attempt is charged. After the third failure `fetch` rethrows the last one. `convert` catches it and looks in the cache, which already is the store of last good rates, so there is no second map. If nothing usable is there it throws `RateUnavailableException` with the pair in the message and the original failure as the cause.',
        'The cost shows in the trace. Nothing remembers that the provider is down, so every conversion during an outage makes 3 failed calls before it answers: the count goes 1, 4, then 5, 8, 11. There is no wait between attempts either; a comment marks where real code would back off. Say both aloud. The fix for the first is a circuit breaker, and it is the usual follow-up.',
      ],
      lines: [
        {
          code: 'for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {',
          note: 'Three attempts in all: counting from 1 needs `<=`. With `<` there are 2 attempts, and four of the five tests fail, three of them only on the call count.',
        },
        {
          code: '} catch (ProviderDownException e) {',
          note: 'Name the one failure that can recover. Catching `RuntimeException` here would retry an unknown pair 3 times and report it as "try later". No test would notice.',
        },
        {
          code: 'if (last == null || now - last.fetchedAt() > staleLimitMillis) {',
          note: 'The null check covers "down with nothing cached". `>` makes the limit inclusive, the opposite sense to the `<` of the time to live: at exactly 600,000 ms the rate is still served.',
        },
        {
          code: '"no usable rate for " + from + "/" + to, e);',
          note: 'The pair goes in the message and the `ProviderDownException` goes in as the cause, so whoever reads the log sees which pair failed and why.',
        },
      ],
      trace: {
        caption:
          'Every answer during an outage costs 3 failed calls: 1 to 4, 5 to 8, 8 to 11. Age is counted from the last successful fetch, at t = 61000, and one millisecond separates a stale answer at age 600000 from a failure at 600001.',
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
        note: 'One converter with the default limits, converting 10.00 GBP to USD each time. Rows 1 to 4 are the test "down provider serves a stale rate, then a fresh one". The two limit tests reach ages 600000 and 600001 on a new converter by advancing the clock from 0.',
      },
      say: "This one's a business decision and I'd confirm it: if the provider's down I'll serve the last rate for up to 10 minutes, flagged stale and with its age, so the caller decides whether that's good enough. I retry only the failure that can recover, three attempts in all, and I never retry an unknown pair.",
      pitfalls: [
        'Reading `last.fetchedAt()` with nothing cached: "down with nothing cached fails after 3 calls" reports `threw NullPointerException` where it expects `threw RateUnavailableException`.',
        'Writing `attempt < MAX_ATTEMPTS` from 1: "two failures then a success is fresh" prints `threw RateUnavailableException`, and three more tests are one call short.',
        'Using `>=` for the stale limit because the time to live used `<`: "stale rate is served at exactly the stale limit" prints `threw RateUnavailableException`.',
        'Catching `RuntimeException` in the retry loop: all five tests still pass, an unquoted pair costs 3 paid calls, and the caller is told to try again later for a pair that will never work.',
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
      regions: ['base-currency', 'fetch', 'lookup'],
      explain: [
        'Derive a rate, not an amount. `lookup` returns one rate for the pair that was asked for, with every digit it has, and the single rounding in `apply` stays the only one. The obvious alternative converts the amount leg by leg and rounds in the middle. Take 7 JPY to EUR with JPY/USD at 0.0066 and USD/EUR at 0.92. Leg by leg, 7 JPY is 0.0462 USD, which rounds to 0.05 USD, which is 0.0460 EUR, which rounds to 0.05. As one rate, 0.0066 times 0.92 is 0.006072, 7 times that is 0.042504, and the answer is 0.04.',
        'The inverse is a division, and `BigDecimal` division needs to be told when to stop. `BigDecimal.ONE.divide(x)` with one argument throws `ArithmeticException` when the result has no exact decimal form, and 1 over 0.75 has none. `MathContext.DECIMAL128` gives 34 significant digits. Those digits are doing work: 300.00 GBP at 1 over 0.75 should be 400.00 USD, and it is with 34 digits. Cut the inverse to 1.3333 and it is 399.99.',
        'The order is direct, then inverse, then through USD, where each of the two legs may itself be direct or inverse. Direct comes first because a quoted rate is the provider\'s price for that pair. When one side is already USD there is no third route, so the `UnknownPairException` is rethrown. It is still never retried.',
        'What changed since stage 3: one line of `fetch`, which now calls `lookup` where it called the provider, plus the two new methods and the `BASE` constant. The cache, the retry loop and the stale path are untouched. The retry wraps the whole lookup, so a `ProviderDownException` on any leg starts the route again. The derived rate is stored under the pair that was asked for, and `Conversion.rate` reports it: 187.65375 for GBP to JPY from 1.25 and 150.123.',
        'Cost, in paid calls: 2 for an inverse, 4 for a cross rate (the direct quote, its inverse, then two legs), and up to 6 when both legs need inverting. A pair with no route costs 4 calls and throws `UnknownPairException`. Only the asked pair is cached, so a second GBP to JPY costs nothing, and GBP to JPY and GBP to EUR each pay for their own GBP/USD leg.',
      ],
      lines: [
        {
          code: 'return lookup(pair.from(), pair.to());',
          note: 'The only line of `fetch` that changed. Everything above `fetch` still sees one rate for one pair.',
        },
        {
          code: 'return BigDecimal.ONE.divide(provider.rate(to, from),',
          note: 'The arguments are swapped on purpose: `to, from` asks for the opposite quote. The next line passes the `MathContext`; without it this throws on the first rate such as 0.75.',
        },
        {
          code: 'if (from.equals(BASE) || to.equals(BASE)) {',
          note: 'With USD on one side, "through USD" is the pair that has just failed in both directions. Without this guard the code asks for it twice more and pays for both calls. No test notices.',
        },
        {
          code: '.multiply(directOrInverse(BASE, to));',
          note: 'An exact product of the two legs with no `setScale`. Rounding here is the mistake the third test is written to catch.',
        },
      ],
      trace: {
        caption:
          'The rate column keeps every digit and only the result is rounded. The two comparison rows show what early rounding costs: 0.05 where the answer is 0.04, and 399.99 where it is 400.00. The last row is a pair with no route: 4 paid calls, then the failure, with no retry.',
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
        note: 'Each row starts a new converter and provider except row 3. Rows 2 and 3 are the test "cross rate goes through usd and is cached" and row 4 is "intermediate amount is not rounded". The two comparison rows are arithmetic, not runs of this code. No test covers the last row.',
      },
      say: "I'll derive one rate for the pair and not convert the amount in steps, so nothing is rounded until the end. Direct quote first, then one over the inverse to 34 digits, then through US dollars, and I cache the derived rate under the pair I was asked for.",
      pitfalls: [
        'Dividing with no `MathContext`: "inverse pair is used when the direct one is missing" prints `threw ArithmeticException`.',
        'Rounding the inverse to a few places to make it look tidy: the same test prints `13.33 399.99` where it expects `13.33 400.00`.',
        'Converting to USD, rounding to cents, then converting again: 7 JPY becomes 0.05 EUR where the answer is 0.04, and "intermediate amount is not rounded" fails.',
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
      regions: ['cache', 'fresh-rate', 'convert'],
      explain: [
        "The decision is where \"look, then load\" becomes one step. In stage 4's `freshRate` a thread reads the map, finds nothing and goes to fetch. A hundred threads all do the read before any of them has stored a rate, so the stage 4 code made 100 provider calls on a cold cache. A thread-safe map alone does not help: each `get` and each `put` is safe, and the gap between them is still there. `cache.compute(pair, fn)` on a `ConcurrentHashMap` closes the gap. It runs `fn` for that key while other `compute` calls on the same key wait, so the first thread fetches and the other 99 then find a fresh entry and return it. One call.",
        'It has to be `compute`, not `computeIfAbsent`, which runs its function only when the key has no entry. An expired rate is still an entry, so it would never be refreshed. `compute` hands the function the old entry and lets it decide. When the function throws, `compute` passes the exception on and leaves the old entry as it was, which is exactly what the stale path in `convert` needs: `cache.get(pair)` still finds the last good rate.',
        "Two alternatives are worth naming aloud. `synchronized` on `convert` is correct, is the least code and passes all three tests, but one slow GBP/USD fetch then blocks every other pair, cache hits included. A map of `CompletableFuture`s, where the first caller starts the fetch and the rest wait on its future with a timeout, is what production wants and is too much to type here. `compute` sits between them, and it has a cost of its own: every caller of a pair waits while one thread makes up to 3 slow attempts, including callers who would have been happy with a stale rate.",
        '**This stage was changed after its tests first passed, because a race was found.** Take a cold cache and a provider that is down for exactly 3 calls. Thread A loads, fails 3 times, leaves `compute` and heads for the stale path. Before A reads `cache.get(pair)`, thread B loads and succeeds. A finds B\'s brand-new rate. The first version passed `true` there, as stages 3 and 4 do, so A returned a rate fetched an instant earlier flagged stale with age 0. In 300 runs of that scenario, 149 produced one such answer. The fix is one line on the stale path, `boolean stale = now - last.fetchedAt() >= ttlMillis;`, which applies the same rule as the fresh path: stale means at least 60 seconds old, whoever loaded the rate. After the fix, none of 300 runs produced it: in 150 all 100 threads got a fresh 12.53, and in 150 it was 99 fresh and one `RateUnavailableException`, which is right when A looks before anyone has loaded. Every run made 4 provider calls.',
        'No deterministic test covers that fix. Which outcome you get depends on which thread reaches the map first, and the fake clock and the latch cannot force the order. So the three tests of this stage all use a healthy provider, and the fix rests on reading the code and on that 300-run experiment. If you are asked how you know stage 5 is right, say that: the call counts are tested, the failing-load case is reasoned and measured, not tested.',
      ],
      lines: [
        {
          code: 'private final Map<Pair, CachedRate> cache = new ConcurrentHashMap<>();',
          note: 'The one-at-a-time promise comes from this class. `HashMap` has a `compute` too, and on a `HashMap` nothing stops two threads running it together.',
        },
        {
          code: 'return cache.compute(pair, (key, old) ->',
          note: '`old` is the current entry, or null when there is none. Whatever the function returns becomes the entry and is also what `compute` returns.',
        },
        {
          code: 'old != null && now - old.fetchedAt() < ttlMillis',
          note: 'The same freshness test as stage 2, now made inside the atomic step. The 99 threads that waited run it, see the new entry and keep it.',
        },
        {
          code: 'boolean stale = now - last.fetchedAt() >= ttlMillis;',
          note: 'The race fix. `>=` here is the exact opposite of the `<` above, so every entry is fresh by one test or stale by the other, and never both.',
        },
      ],
      trace: {
        caption:
          'Read the calls column. The stage 4 code pays 100 and then 99; the stage 5 code pays 1 each time. In the two scenarios where a load fails, the answers differ from run to run, the calls do not, and no answer is flagged stale at age 0.',
        head: ['Code', 'Scenario, 100 threads', 'Answers', 'Provider calls', 'Loader ran on'],
        rows: [
          ['stage 4', 'cold cache, GBP to USD', '100 × `12.53 age 0 stale false`', '100', '100 threads'],
          ['stage 4', 'same converter at t = 60000 (expired)', '100 × `12.53 age 0 stale false`', '199 (99 more)', '99 threads'],
          ['stage 5', 'cold cache, GBP to USD', '100 × `12.53 age 0 stale false`', '1', 'thread 98 only'],
          ['stage 5', 'same converter at t = 60000 (expired)', '100 × `12.53 age 0 stale false`', '2 (1 more)', 'thread 2 only'],
          ['stage 5', 'new converter; 50 threads GBP to USD, 50 USD to GBP', '50 × `12.53 age 0 stale false`, 50 × `7.98 age 0 stale false`', '2', 'thread 1 (GBP/USD), thread 2 (USD/GBP)'],
          ['stage 5', 'new converter, cold; provider down for 3 calls', '99 × `12.53 age 0 stale false`, 1 × threw RateUnavailableException', '4', 'thread 1 (3 failures), thread 98 (success)'],
          ['stage 5', 'the same scenario, another run', '100 × `12.53 age 0 stale false`', '4', 'thread 1 (3 failures), thread 100 (success)'],
          ['stage 5', 'new converter, rate cached at t = 0; at t = 61000 provider down for 3 calls', '100 × `12.53 age 0 stale false`', '5', 'thread 1 (3 failures), thread 100 (success)'],
          ['stage 5', 'the same scenario, another run', '99 × `12.53 age 0 stale false`, 1 × `12.53 age 61000 stale true`', '5', 'thread 1 (3 failures), thread 100 (success)'],
        ],
        note: 'Taken from the stage 5 file as it stands now, and the stage 4 file for the first two rows, each with a temporary print in the loader. Threads are numbered 1 to 100 in the order they were started; which thread loads varies between runs. Rows 3 to 5 are the three tests. No test covers rows 6 to 9. In row 9 the thread whose load failed read the map before another thread had refreshed it, so it served the old rate, correctly flagged; in row 8 it read afterwards.',
      },
      say: "A thread-safe map isn't enough here, because the check and the load have to be one atomic step for each pair. I'll use compute on a ConcurrentHashMap so one thread loads and the rest wait for its result. The cost is that the waiters block while the provider is slow.",
      pitfalls: [
        'Swapping in `ConcurrentHashMap` and keeping `get` then `put`: nothing throws, every answer is right, and the first test reports `calls 100` where it expects `calls 1`.',
        'Using `computeIfAbsent`: the cold-cache test passes and an expired rate is never refreshed, so "an expired rate is refreshed by one call" reports `calls 1` and four tests from stages 2 and 3 fail with it.',
        'Declaring `convert` `synchronized` and stopping: all 18 tests pass, and in production one slow fetch holds up every conversion of every pair.',
        'Leaving `true` on the stale path: all 18 tests pass, and now and then a rate loaded a moment ago by another thread goes out flagged stale with age 0.',
      ],
    },
  ],
  followUps: [
    {
      q: 'How did you test expiry and failure without sleeping?',
      a: [
        'The clock and the provider are both passed in. The fake clock moves only when a test advances it, and the fake provider counts calls and fails on demand.',
        'That lets me test each limit at the exact millisecond: 59,999 and 60,000 for the time to live, 600,000 and 600,001 for the stale limit.',
        "For threads I use latches with a bounded wait, and I'd run the test a couple of hundred times before I trusted it.",
      ],
    },
    {
      q: 'Why half to even, and who keeps the rounding remainder?',
      a: [
        'Half to even sends an exact half to the even neighbour, so over many conversions the halves go down as often as up and neither side gains.',
        "On any one conversion somebody still keeps a fraction of a penny. I'd want that decided and written down, and the difference posted to a rounding account so the books balance.",
        "If the product or a regulator names a mode, I use theirs. Whichever it is, it's set in one place and used everywhere.",
      ],
    },
    {
      q: 'Why not always derive the rate through USD, even when there is a direct quote?',
      a: [
        "Because the direct quote is the provider's price for that pair, and two quotes multiplied together are a different number.",
        "Each leg carries its own spread, so GBP to USD times USD to EUR won't in general equal a quoted GBP to EUR.",
        "So I derive only when there's no direct quote, and I'd record on the result that the rate was derived. The cost is more to fetch: 20 ordered pairs for five currencies, against 4 rates from one base.",
      ],
    },
    {
      q: 'The provider is down for an hour. What does this code do?',
      a: [
        'For the first 10 minutes every pair it has seen is answered with a stale rate. After that every conversion fails.',
        'The weakness is cost. Nothing remembers that the provider is down, so each conversion makes 3 failed calls before it answers.',
        "I'd add a circuit breaker: after a few failures stop calling for a short while and go straight to the stale rate, then let one trial call through. I'd also wait between retries, longer each time and with jitter.",
      ],
    },
    {
      q: 'How would you use several providers?',
      a: [
        "I'd put them behind the same `RateProvider` interface as one provider that tries each in order, with a timeout and a breaker for each.",
        "It fails over when a provider is down or too slow. The stale rate stays as the last resort, after all of them have failed.",
        "The cost is that providers disagree by a little, so I'd record which one each rate came from, and I wouldn't switch a customer between them in the middle of one purchase.",
      ],
    },
    {
      q: 'At 10,000 conversions a second, would you still fetch when a request arrives?',
      a: [
        "No. Rates change far more slowly than requests arrive, so I'd fetch every rate on a timer, every few seconds, into one snapshot in memory and serve every request from that.",
        'Provider cost then follows the timer and not the traffic, and no request waits on the provider.',
        'The cost is paying for pairs nobody asks for. The staleness rule stays: if the refresh keeps failing, the snapshot is served flagged, up to the same 10-minute limit.',
      ],
    },
    {
      q: 'And with several instances of the service?',
      a: [
        'Left alone, each instance fetches for itself: N times the cost, and N slightly different rates for the same pair at the same moment.',
        "I'd have one fetcher publish each snapshot, with an id and a time, to a shared store or a topic, and every instance reads that.",
        'The cost is one more moving part, so each instance keeps its last snapshot and applies the stale limit to it if the feed stops.',
      ],
    },
    {
      q: 'A customer disputes a conversion next month. What did you need to store?',
      a: [
        'With the transaction: the rate, which provider it came from, when it was fetched, whether it was stale or derived and from which legs, the rounding mode and the unrounded amount.',
        '`Conversion` already carries the rate, its age and the stale flag. Production adds the source and an id.',
        "Without those I can't show the customer how the number was reached, and I can't check it myself.",
      ],
    },
    {
      q: 'A customer sees a quote, then pays twenty seconds later. Which rate are they charged?',
      a: [
        "The one they were shown. I'd never convert again at payment time with whatever the cache holds by then.",
        'So a quote becomes a stored record: an id, the pair, the rate, both amounts and an expiry of, say, 30 seconds. The payment names the quote id and uses its rate.',
        'After the expiry the payment is refused and the customer is quoted again. The cost is a quote store, and the business carries any movement in the rate for those 30 seconds.',
      ],
    },
    {
      q: 'What is wrong with `compute` in production?',
      a: [
        "It holds every caller of a pair while one thread loads, through up to 3 slow attempts, and a waiting caller can't give up or take the stale rate.",
        "I'd store a `CompletableFuture` for each pair. The first caller starts the fetch, and the rest wait on the same future with a timeout and fall back to the last rate.",
        "That's more code, and a failed future has to be removed or the failure is cached. I'd also add a stress test to the build, because the race I fixed in this version is covered by an experiment and not by a test.",
      ],
    },
  ],
  mistakes: [
    'Starting on the cache before the four stage 1 tests pass. The first ten minutes go on the scale, the rounding mode and the null check, and none of it gets easier with a map on top.',
    'Using `double` to get one test green and meaning to change it later. The brief said never, and every expected string has to be checked again once you switch.',
    'Redesigning the result. `Conversion` and both constructors are fixed in the starter, and a changed signature breaks tests in every stage.',
    'Building the inverse and USD routes before the stale path works. Stage 3 is what counts as done; stages 4 and 5 are extras.',
    'Adding a sleep, a backoff schedule or a circuit breaker to stage 3. One comment where the wait would go, said aloud, takes five seconds and is what the tests allow.',
    'Guessing at a failing boundary test. Every expectation ends in ` calls N`: read the count first, because it says whether the cache was hit, refreshed or skipped.',
  ],
  see: [
    {
      href: '#/s/cache-strategies',
      label: 'Cache read and write strategies',
      why: 'A miss, the fill and the hit that follows, one step at a time. Stage 2 is the read half of cache-aside with a provider in place of the database.',
    },
    {
      href: '#/c/caching/ttl-stampede',
      label: 'Caching: TTLs, jitter and stampedes',
      why: "Stage 5's hundred threads on one expired key, drawn as a sequence: the first request fetches and the rest join the call in flight.",
    },
    {
      href: '#/s/retries-breaker',
      label: 'Retries, backoff and circuit breakers',
      why: "What stage 3's retry loop leaves out: waiting longer between attempts, and a breaker that stops paying for calls to a provider that is down.",
    },
    {
      href: '#/c/resilience-patterns/degradation',
      label: 'Resilience patterns: fallbacks',
      why: 'Serving the last known rate, marked with its age, is a fallback. This section sets it beside calls that must have none.',
    },
  ],
  simplified: [
    'Nothing tests that a pair with no route fails without retrying. That test was dropped to keep the starter short. The behaviour is in the stage 4 trace: 4 calls, `UnknownPairException`, no retry.',
    'No deterministic test covers the stage 5 race fix. It was checked by reading the code and by 300 runs of one scenario before and after.',
    'One rate for each pair. Real foreign exchange has a buying and a selling rate, and a spread or a fee on top.',
    'Currencies are strings checked against a five-entry map, not `java.util.Currency`, and the minor units are typed in. The real table comes from ISO 4217.',
    'Retries are immediate: no backoff, no jitter, no timeout on a call. There is no circuit breaker, so a provider that is down costs 3 calls for every conversion.',
    'The cache never evicts. It grows to one entry for each pair asked for, at most 20 here.',
    'Cross rates go through one fixed base, USD. Only the asked pair is cached and the legs are not, so two cross rates that share a leg each pay for it.',
    'A cached rate is used for any amount. There are no quote ids, no quote expiry and no audit trail.',
    'A same-currency amount is returned as given and is not checked against the minor units: 1.005 GBP to GBP returns 1.005.',
    'A zero rate from the provider is not handled. Inverting it would throw `ArithmeticException`.',
    'In stage 5 callers wait while a slow load runs, with no timeout. The stale flag also compares this thread\'s `now` with a fetch time another thread may have stamped. With one fake clock they agree; with a real clock the age could come out slightly negative, and that is not handled.',
  ],
  unverified: [
    'The minor units in the table (JPY 0, KWD 3, the others 2) are the starter\'s values, and that ISO 4217 is where the real table comes from is general knowledge. Neither was checked against the standard.',
    'That some products or regulators require a particular rounding mode: general knowledge, not checked against a source.',
    'That a direct quote and a rate derived through USD differ because each leg carries its own spread: how foreign exchange is usually described, not checked against a source or shown by this code, which has one rate for each pair.',
    'About `ConcurrentHashMap.compute`: that it runs one function at a time for a key, and that a function that throws leaves the entry unchanged, were both seen in runs here (one call under 100 threads; the stale path finding the old entry after a failed load). That a plain `HashMap` gives no such promise is from memory of the JDK documentation.',
    'The follow-up answers (a circuit breaker, several providers behind one interface, a timer-driven snapshot, one fetcher for many instances, stored quotes with an expiry, a rounding account, per-key futures) are common designs described from memory. None was built or run here, and the 30-second quote expiry is an example figure.',
    'The race counts in stage 5 (149 of 300 runs before the fix, none after) come from one experiment on one machine and depend on timing. A repeat of the same experiment gave 156 of 300 before the fix and none after.',
  ],
};

export default page;
