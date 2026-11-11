import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A call over a network can fail for reasons that pass in a moment, so callers retry. Done carelessly, retries multiply the load on a service that is already struggling and keep it down. Backoff with jitter spreads retries out in time, a circuit breaker stops calling a service that keeps failing, and a retry budget and a deadline put a ceiling on how much extra work retries can ever add.',
  watch: [
    'The timeline has one lane per client. Each box is one attempt at the tick it was sent: A2 is client A\'s second attempt. Green was served, red failed, A× failed fast at an open breaker without sending anything, and a dashed empty box is a retry waiting for its tick. The row underneath counts what the downstream received in each tick.',
    'The tour\'s first storm uses immediate retries. Four clients send 4 requests in every tick while the service is down: 16 requests for 4 calls, and the burst on its first tick back knocks its recovery count back to 0.',
    'Exponential backoff without jitter waits 2, 4, then 6 ticks (8, capped at 6). Every client works out the same numbers, so the retries still arrive as waves of 4, against a service that can take 2 a tick while it recovers.',
    'With full jitter each client draws its own wait, from 1 to the backoff. The same 4 calls arrive 1 or 2 a tick and none is shed. Compare the peaks and the shed boxes in the load row, storm by storm.',
    'Trip a breaker: 3 failures within 10 ticks open it. While it is open, calls fail fast, marked ×, and the downstream sees nothing from that client. After 4 ticks it goes half-open and lets one probe through. The probe decides: closed again, or open for another 4 ticks.',
    'Budget gives every call a deadline and every client a token bucket of retries. Watch the comparison now + delay against the deadline: a retry that would arrive after the caller has stopped waiting is not made at all. Run Budget again with a deadline of 6 and the deadline lets the chain go on, but the retry budget can run dry first: 2 saved tokens pay for 2 retries.',
    'Set the policy to none and the breaker off, then run a storm. Nothing is retried, so nothing is amplified, but half the calls that could have succeeded a tick later simply fail.',
  ],
  complexity: [
    { op: 'Retry decision', average: 'O(1)', worst: 'O(1)', note: 'Compare the attempt with the maximum, compute base × 2^n capped, draw the jitter, check the deadline and the budget.' },
    { op: 'Breaker check', average: 'O(1)', worst: 'O(1)', note: 'One state read before each call. A count-based window is a ring buffer of the last N outcomes; a time-based one keeps a counter per time slice.' },
    { op: 'Extra load from retries', average: 'Up to × attempts', worst: 'attempts^layers', note: 'With 4 attempts a call can cost the service 4 requests. Three layers each making 3 attempts turn one user request into 3 × 3 × 3 = 27 at the bottom.' },
    { op: 'Retry budget', average: 'O(1)', worst: 'O(1)', note: 'A token bucket per client: each call earns a fraction of a token, each retry spends one.' },
  ],
  space:
    'O(1) per client and downstream: a breaker state, a failure count or a small window, an open-until time and a token count. A call in flight holds its attempt number, its next due time and its deadline. Even a large fleet keeps only a few bytes per pair of caller and callee.',
  usedIn: [
    {
      name: 'AWS Architecture Blog',
      how: 'Marc Brooker\'s post "Exponential Backoff and Jitter" (2015, updated 2023) simulated many clients contending for one resource. Backoff without jitter was the clear loser. Full jitter did the least work and decorrelated jitter finished slightly sooner; equal jitter lost among the jittered ones. With 100 clients, jitter cut the number of calls by more than half.',
    },
    {
      name: 'Envoy',
      how: 'A route can retry with a retry policy, and a cluster can set a retry budget that limits retries in flight to a share of active and pending requests: budget_percent defaults to 20% and min_retry_concurrency to 3. Outlier detection plays the breaker\'s part per host, ejecting a host that keeps returning errors from the load-balancing pool for a while.',
    },
    {
      name: 'Resilience4j',
      how: 'The Java library behind many Spring services. Its CircuitBreaker has CLOSED, OPEN and HALF_OPEN states and judges a failure rate over a sliding window, count-based or time-based. It also has Retry, with exponential backoff and randomised waits, plus Bulkhead and RateLimiter. It took over from Netflix Hystrix, which is in maintenance mode.',
    },
    {
      name: 'Polly (.NET)',
      how: 'Retry with backoff and jitter, circuit breaker, timeout, bulkhead and fallback as policies that wrap a call, composed in a pipeline. The same set of ideas as this page, in one library.',
    },
    {
      name: 'HTTP',
      how: '503 Service Unavailable and 429 Too Many Requests can carry a Retry-After header saying how long to wait. A client that honours it needs no guess at all. 400, 404 and 422 mean the request itself is wrong, and sending it again will fail again.',
    },
    {
      name: 'Stripe and payment APIs',
      how: 'A payment request carries an Idempotency-Key header, so a retry after a timeout returns the first result instead of charging twice. That is what makes a POST safe to retry. See the Idempotency keys page on this site.',
    },
    {
      name: 'The token bucket page on this site',
      how: 'A retry budget is a token bucket where calls earn tokens and retries spend them. The same lazy refill and the same cap: the cap is the burst of retries allowed, and the earning rate is the share of traffic retries may reach.',
    },
  ],
  reachFor: [
    'Any call across a network to something that can fail: another service, a database, a queue, a third-party API.',
    'Exponential backoff with full jitter as the default retry policy. Cap the wait, cap the attempts (3 or 4 in total is typical), and never retry without some randomness.',
    'A circuit breaker in front of each dependency that can fail on its own, so one dead service costs microseconds per call instead of a full timeout per call.',
    'A retry budget per client, or a token bucket, when many callers share a service: under a long outage it holds retries to a small share, such as 10% or 20%, of normal traffic.',
    'A deadline set at the edge and passed down with the request, so every layer knows how long the user will still wait and stops when it is spent.',
  ],
  costs: [
    'Only retry what is safe to repeat. A GET, a PUT of a whole value or a DELETE is idempotent; a POST that moves money is not, unless it carries an idempotency key. A timeout does not mean the work was not done: the server may have charged the card and lost the reply.',
    'Only retry errors that may pass: timeouts, connection resets, 503, and 429 after its Retry-After. Never a 400, 404 or 422. Retrying a validation error triples the load for the same answer.',
    'Retry at one layer only, usually the one closest to the user or the one nearest the failing dependency. Three layers each making 3 attempts send 27 requests to the bottom for one at the top, exactly when the bottom is weakest.',
    'Backoff makes callers wait. With a cap of 6 ticks and 4 attempts, the last try comes 12 ticks after the first. Keep the total under the caller\'s own timeout, or the work is wasted.',
    'A breaker turns some calls that would have worked into errors. A threshold set too low opens on a blip; too high and it opens after the damage is done. Judge a rate over a window with a minimum number of calls, not a raw count.',
    'A fallback is not free. A cached value can be stale, a default can mislead, a queue for later needs someone to drain it. Some calls must never have a fallback: a payment that "succeeds" from a default never moved any money.',
    'Simplified on this page: time is whole ticks and every attempt is answered in its own tick, so a half-open breaker never has two probes in flight. Jitter draws a whole number of ticks from 1 up; real full jitter draws a time from 0. The breaker counts failures in the last 10 ticks rather than a failure rate. Storms set breakers aside so you see retries alone, and each client makes one call at a time.',
  ],
  interview: [
    'Say the three rules in one breath: "Retry only idempotent operations, only on errors that may pass, and with capped exponential backoff plus jitter." Then add the budget: "and cap retries at about 10% of traffic per client, so an outage cannot triple our load."',
    'Explain why jitter matters with numbers. A thousand clients that fail at the same moment and all wait exactly 2, 4 and 8 seconds come back as three spikes of a thousand. Full jitter spreads each wave over its whole window: sleep = random(0, min(cap, base × 2^attempt)).',
    'Know the three jitter variants from the AWS post. Full: random between 0 and the backoff. Equal: half the backoff plus random up to the other half, so never under half. Decorrelated: random between the base and three times the last sleep, capped. Full did the least work in its simulation; no jitter was clearly worst.',
    'Draw the breaker as a state machine. Closed: count failures over a window. Open when the failure rate passes a threshold, say 50% of at least 20 calls in 10 seconds. Open: fail fast for a cool-off, say 30 seconds. Half-open: let a few probes through; success closes, failure reopens.',
    'Name the companions. Timeouts on every call, set from the dependency\'s p99 latency, not a round number. Bulkheads: a separate pool of threads or connections per dependency, so one slow service cannot take every thread. Load shedding on the server: refuse early with 503 rather than queue work that will time out anyway.',
    'Propagate deadlines. The edge sets "answer within 800 ms"; each hop passes the remaining time down, as gRPC does with its deadline. A service that sees 20 ms left does not start a 200 ms query, and a client does not retry when the retry would land after the deadline.',
    'Mention where it lives. In a client library (Resilience4j, Polly, the AWS SDKs\' standard retry mode) it is per process and needs code in each language. In a service mesh (Envoy, with retry policies, retry budgets and outlier detection) it is configuration and the same for every language, but it cannot know which calls are idempotent unless you tell it.',
    'Have a fallback story per call. Product recommendations: serve cached or popular items. Feature flags: last known value. Writes that can wait: put them on a queue. Payments: no fallback, fail clearly and let the caller retry with the same idempotency key.',
  ],
};
