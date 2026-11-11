import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A token bucket is a rate limiter made of two numbers: how many tokens are stored, and when that count was last correct. Tokens are earned at a steady rate up to a fixed capacity, and each request takes one or is turned away at once. The saved-up tokens allow a short burst; the refill rate sets the long-run average.',
  watch: [
    'Tick does nothing to the bucket. The clock moves and the stored count stays as it was. Compare "Tokens stored" with "Available if asked now" under the canvas.',
    'The refill happens inside the next request: elapsed = now − last, earned = elapsed × rate, tokens = min(capacity, tokens + earned). One subtraction, one multiplication, one min.',
    'The first request of the tour arrives 3 ticks after a full bucket was last touched. 5 + 3 = 8, and min(5, 8) keeps 5. Idle time cannot be banked beyond the capacity.',
    'A burst is paid for only with tokens already in the bucket. Send 5 at once against 4 tokens: 4 are allowed in the same tick and the fifth is rejected.',
    'A rejected request takes nothing and waits nowhere. The answer says how long to wait: 2 tokens missing at 1 per tick is a Retry-After of 2 ticks. Tick twice in the tour and the same request passes.',
    'Rebuild with capacity 3 and rate 3, then with capacity 8 and rate 1. The first allows a steady 3 per tick with almost no burst on top. The second allows a burst of 8 and then a trickle.',
    'Ask for more tokens than the capacity. The request can never succeed, however long it waits.',
  ],
  complexity: [
    { op: 'Request (allow or reject)', average: 'O(1)', worst: 'O(1)', note: 'A refill and one comparison. The cost does not depend on the rate, the capacity or how long the bucket sat idle.' },
    { op: 'Refill', average: 'O(1)', worst: 'O(1)', note: 'Worked out from the elapsed time when a request arrives. No timer and no background thread.' },
    { op: 'Time passing with no requests', average: 'No work', worst: 'No work', note: 'An idle bucket is never touched. A million idle clients cost memory only.' },
    { op: 'Sliding window log, for contrast', average: 'O(1) amortised', worst: 'O(limit)', note: 'Stores a timestamp per request and drops the old ones on each call.' },
  ],
  space:
    'O(1) per key: the token count and the time of the last refill, about 16 bytes. Capacity and rate are configuration, shared by every key. A million clients need about 16 MB plus the cost of the keys. A sliding window log for a limit of 1,000 per hour can hold 1,000 timestamps for one client.',
  usedIn: [
    {
      name: 'Stripe',
      how: 'Its API rate limiters use the token bucket algorithm with the state in Redis. They are wired in so that an error in the limiter, or Redis going down, fails open and the API keeps serving.',
    },
    {
      name: 'Amazon API Gateway',
      how: 'Throttles with a token bucket where one token is one request. The throttling rate is the tokens added per second and the throttling burst is the capacity of the bucket. A throttled client gets 429 Too Many Requests.',
    },
    {
      name: 'Envoy',
      how: 'The local rate limit filter keeps a token bucket in each proxy, set by max_tokens, tokens_per_fill and fill_interval. A separate global rate limit filter calls a shared service when the limit must hold across every proxy.',
    },
    {
      name: 'Go and Guava libraries',
      how: 'golang.org/x/time/rate is a token bucket of size b, initially full and refilled at r tokens per second. Guava RateLimiter works out its stored permits lazily from the clock when a caller asks; by default acquire() waits for a permit and tryAcquire() does not.',
    },
    {
      name: 'Linux traffic control',
      how: 'The tbf queueing discipline (token bucket filter) shapes outgoing traffic. A packet is sent when there are tokens for its size. Packets that must wait sit in a queue of limited length, so here the bucket delays before it drops.',
    },
    {
      name: 'NGINX, for contrast',
      how: 'limit_req uses the leaky bucket method. Requests over the rate are delayed so they leave at the set rate, up to burst waiting; beyond that they are refused, with status 503 unless limit_req_status says otherwise. The nodelay option serves the burst at once, which behaves much like a token bucket.',
    },
    {
      name: 'The web crawler design on this site',
      how: 'Politeness is a bucket per host with capacity 1, refilled once per gap, where the gap is the largest of 1 second, the Crawl-delay in robots.txt and ten times the last response time. Capacity 1 means no burst at all. Addresses that serve many sites get a shared bucket per IP as well.',
    },
  ],
  reachFor: [
    'An API limit that should forgive a short burst but hold a steady average: "100 a second, bursts of 200".',
    'Many keys, most of them idle. Each costs two numbers and no work until it is used.',
    'Requests with different weights. A search can cost 5 tokens and a read 1, against the same bucket.',
    'Being polite to someone else\'s server. A bucket per host with capacity 1 turns a crawl delay into a minimum gap between fetches.',
    'Limits at more than one level. A request can be made to pass a per-user bucket and a per-organisation bucket.',
  ],
  costs: [
    'It bounds a rate, not a count in a calendar window. For "1,000 calls a day, reset at midnight" a fixed window counter is simpler and matches what the customer is told.',
    'Bursts reach the backend. With capacity 200 the service behind it must survive 200 requests in the same instant. If it needs evenly spaced work, use a leaky bucket queue or set the capacity to 1.',
    'It does not limit concurrency. Ten slow requests that each took a token can all be running at once. Cap requests in flight with a semaphore or a connection limit.',
    'Two settings to tune, not one. Capacity too large and the limit means little for the first seconds; too small and well-behaved clients that batch their calls are rejected.',
    'Shared between servers, the read, the sum and the write must be one atomic step. Done as separate commands, two servers both read 1 token and both allow.',
    'It depends on a clock. A clock that jumps forward mints tokens. Use a monotonic clock on one machine, and one source of time when the state is shared.',
  ],
  interview: [
    'Define it in one breath: "Tokens arrive at r per second up to a capacity of b. A request takes a token or is rejected. So b is the burst and r is the sustained rate, and in any window of T seconds at most b + r × T requests pass." With b = 200 and r = 100, that is at most 1,200 in any 10 seconds.',
    'Say that refill is lazy. Store the token count and a timestamp; on each request add elapsed × rate, cap at b, then compare. No timers, O(1) time, two numbers per key.',
    'Against a leaky bucket: as a queue it lets requests out at a fixed rate, so the output is smooth, bursts wait, and a full queue drops. The token bucket never delays; it allows the burst now or rejects. Pick the leaky bucket when the thing behind it needs evenly spaced work.',
    'Against a fixed window counter: one counter per window is the simplest limiter, but a client can send a full limit just before the boundary and another just after, twice the limit in a moment. A token bucket has no boundary to game.',
    'Against sliding windows: a sliding log keeps a timestamp per request, exact but O(limit) memory per key. A sliding window counter weights the previous window\'s count against the current one, two counters per key and approximate. Cloudflare measured its version at 0.003% of requests wrongly allowed or limited, over 400 million requests.',
    'Where the state lives. One process: a map of key to bucket behind a lock. A fleet: Redis, with refill, compare and take in one Lua script, because Redis runs a script as a single atomic step. Give each key an expiry of capacity ÷ rate seconds: a bucket idle that long is full again, so forgetting it loses nothing.',
    'To avoid a network hop on every request, keep a local bucket in each node and share the budget. Splitting 1,000 a second evenly over 10 nodes is wrong when traffic is uneven. Better: each node leases tokens from the shared store in batches, say 50 at a time. The overshoot is bounded by nodes × batch.',
    'Say what the client gets back: 429 Too Many Requests with a Retry-After header in seconds, worked out as the missing tokens divided by the rate and rounded up. Clients should add jitter so that everyone who was rejected does not return at the same instant.',
    'Decide what happens when the limiter itself is down. An API usually fails open, as Stripe does, because the limiter protects capacity and is not a security check. The crawler on this site fails closed and falls back to a slow fixed rate, because the harm lands on someone else\'s server.',
    'For a crawler, the limit belongs to the site, not to you: one bucket per host with capacity 1 and a refill of one token per crawl delay. Crawl-delay is not part of the robots.txt standard, RFC 9309, and Googlebot ignores it, so cap absurd values and keep a default gap of your own.',
  ],
};
