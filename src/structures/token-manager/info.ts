import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'The task: build a manager with a fixed time to live (ttl) and three calls. generate(tokenId, now) issues a token that expires at now + ttl. renew(tokenId, now) moves a live token\'s expiry to now + ttl, and does nothing for an unknown or expired id. countUnexpiredTokens(now) returns how many tokens are live. A token is expired at exactly its expiry time, so every test is expiry > now. A map from id to expiry is the whole answer for small inputs. A queue of (expiry, id) entries in expiry order makes the count cheap, as long as a count skips entries that a renewal has left out of date.',
  watch: [
    'A token is expired at exactly its expiry time. b is issued at tick 1 with a ttl of 5, so it expires at 6, and a renew at tick 6 is refused. This is the edge case most likely to be tested.',
    'Renew pushes a second entry for a and dims the first. The first is stale: it no longer matches the map. Taking it out of the middle of the queue would cost O(n), so it stays until a count reaches it.',
    'Count by scan reads every token in the map, live or not. Count reads only the expired entries at the front, plus one more that tells it to stop.',
    'The plain FIFO count believes the stale entry (5, a) and deletes a, which was renewed to 8. It reports 3 live tokens when 4 are live. The right count makes one more check, the map against the entry, and skips it.',
    'Advance the clock and nothing happens to the tokens. Expiry is only noticed when a count or a renew looks. No timer runs.',
    'Generate two tokens without advancing the clock, then advance past their expiry and count. Both entries leave in one call. The loop at the front must be a while, not an if.',
    'Generate an id that already exists. This page refuses, because the well-known version of the task promises new ids. In the round, ask. If repeats are allowed, overwrite the expiry; the old queue entry turns stale and the same check skips it.',
    'Rebuild with a ttl of 3 and watch tokens expire before you can renew them.',
  ],
  complexity: [
    { op: 'Generate', average: 'O(1)', worst: 'O(1)', note: 'One map write. With the queue, one append as well.' },
    { op: 'Renew', average: 'O(1)', worst: 'O(1)', note: 'One map lookup, one test of expiry > now, one write. With the queue, one append; the stale entry isn\'t looked for.' },
    { op: 'Count, map only (scan)', average: 'O(n)', worst: 'O(n)', note: 'n is every token in the map, expired ones included unless the scan removes them. Fine for a few thousand calls: 2,000 calls is at most about 4 million checks in total.' },
    { op: 'Count, map plus queue', average: 'O(1) amortised', worst: 'O(entries expired)', note: 'Each generate or accepted renew pushes one entry, and each entry is popped once. So m calls do at most m pops between them, however the pops fall.' },
    { op: 'Map plus min-heap (ttl varies)', average: 'O(log n)', worst: 'O(log n) per push or pop', note: 'Entries no longer arrive in expiry order, so a heap of (expiry, id) keeps the soonest on top. Same stale check on pop.' },
    { op: 'Linked hash map, move to end', average: 'O(1)', worst: 'O(entries expired) for count', note: 'Renew removes the token and puts it back, which moves it to the back. No stale entries. Needs one ttl, like the queue.' },
  ],
  space:
    'Map only: O(tokens ever generated), unless the scan also removes expired ones. Map plus queue or heap: O(live tokens + entries not yet popped). Each renewal adds an entry, and a stale entry stays until its old expiry passes and a count pops it. With one ttl, a token renewed k times inside one ttl holds at most k + 1 entries. Linked hash map: O(live tokens + expired tokens not yet swept), with two extra pointers per entry and no stale entries.',
  usedIn: [
    {
      name: 'The coding task',
      how: 'Often called the authentication manager: a constructor that takes the ttl, then generate(tokenId, currentTime), renew(tokenId, currentTime) and countUnexpiredTokens(currentTime). In the well-known version, expiry at time t happens before any other action at t, ids passed to generate are new, and the times passed in strictly increase. Your version may relax any of those, so ask.',
    },
    {
      name: 'The edge cases a tester will try',
      how: 'A renew or count at exactly the expiry time (the token is already dead). A renew of an id never generated (no error, no new token). A renew of an expired token (it stays dead; it must not come back to life). A generate of an id that already exists. Many tokens expiring at the same tick. A count before any generate. A renew followed by a count just after the token\'s old expiry.',
    },
    {
      name: 'Access-token caches (the production cousin)',
      how: 'A client that calls another service holds one OAuth access token and its expiry. It returns the cached token, refreshes before expiry, and makes one refresh call however many callers ask at once. Go\'s singleflight package does that last part.',
    },
    {
      name: 'Session stores',
      how: 'A session table keyed by id with an expiry column, renewed on activity. Expired rows are removed lazily on read or by a sweep from the oldest expiry, which is the queue on this page.',
    },
    {
      name: 'Redis key expiry',
      how: 'Keys with a time to live are removed lazily when they are next read, and by a background cycle that samples keys with an expiry set. A count of live keys can therefore include some that have expired but not yet been removed.',
    },
  ],
  reachFor: [
    'The map with a scan when the input is small or counts are rare. If the task says a few thousand calls in total, it\'s the right first answer, and often the right final one. Say its cost and move on.',
    'The map plus a queue when counts are frequent and there is one ttl. One ttl and a clock that never goes back mean entries are pushed in expiry order, so the expired ones are always at the front and nothing needs sorting.',
    'The linked hash map when you want O(1) with no stale entries. In Java or Kotlin, keep a LinkedHashMap in insertion order and renew with remove then put: a plain put on an existing key keeps its old place. Count removes from the front while expiry <= now, then returns the size.',
    'The min-heap when each token has its own ttl. A token issued later can now expire sooner, so arrival order is no longer expiry order, and both the queue and the linked hash map give wrong answers.',
    'Outside the round, the same shape fits anything that expires a fixed time after its last use: sessions, leases, idempotency keys.',
  ],
  costs: [
    'A plain FIFO breaks as soon as there is a renew. The entry pushed at generate still carries the old expiry. A count that trusts it deletes a token that was renewed. Check the entry against the map when you pop it, and skip it if they differ.',
    'Stale entries cost memory until their old expiry passes. A token renewed every second with a ttl of an hour leaves up to 3,600 entries behind. The linked hash map avoids that.',
    'Nothing is deleted unless a count runs. If counts are rare, call the same front-popping cleanup from generate and renew too.',
    'Don\'t use the linked hash map\'s access-order mode. In that mode a get moves the entry to the back, so the lookup inside renew would move an expired token behind live ones and break the order.',
    'The queue and the linked hash map both rely on time moving forward. If a call can arrive with an earlier time, the order is gone. Ask whether times are strictly increasing or only non-decreasing; either is fine, going backwards is not.',
    'None of the versions is safe across threads as written. One lock around every method is the right fix: each call does a handful of in-memory steps, amortised O(1), with no I/O inside, so the lock is held for well under a microsecond and contention is rarely the bottleneck.',
    'A ConcurrentHashMap alone isn\'t enough. Renew is read, test, then write, and two threads can interleave between the steps. Count touches two structures: it pops an entry, checks the map, then deletes. A renew that lands between the check and the delete loses a live token. Only the map-and-scan version can go lock-free, with computeIfPresent for renew and a count that may be slightly out of date.',
    'With several threads, also decide who owns the clock. Callers that each pass their own now can arrive out of order. Read the clock inside the lock, or take the larger of the argument and the last time seen.',
    'Simplified on this page: ids are one or two letters, time is whole ticks, a repeated generate is refused, and the page draws at most 7 tokens and 8 queue entries.',
  ],
  interview: [
    'Clarify before typing. "Is a token expired at exactly its expiry time?" (Usually yes.) "Renew of an unknown or expired id: do nothing, no error?" "Can generate repeat an id, and if so does it overwrite?" "Does time only move forward, and can two calls share a time?" "Is the ttl the same for every token?" "How many calls, roughly?"',
    'Say the plan in one line: "I\'ll start with a map from id to expiry and count by scanning. That\'s O(1) generate and renew, O(n) count. Then I\'ll write the edge-case tests, then make count faster if we need it."',
    'The simple version in Kotlin, about ten lines. class TokenManager(private val ttl: Int) { private val expiry = HashMap<String, Int>(); fun generate(id: String, now: Int) { expiry[id] = now + ttl }; fun renew(id: String, now: Int) { val e = expiry[id] ?: return; if (e > now) expiry[id] = now + ttl }; fun countUnexpired(now: Int) = expiry.values.count { it > now } }',
    'Write the tests next, with a ttl of 5. Generate a at 1: count at 5 is 1, count at 6 is 0. Renew a at 6 does nothing, and count at 7 is still 0. Renew of an unknown id doesn\'t throw and doesn\'t create a token. Generate b at 1, renew b at 5, count at 6 is 1 and count at 10 is 0. That last test is the one a plain FIFO fails.',
    'Name the bug you\'re avoiding: "A renew that only checks the id is in the map would bring an expired token back to life. So the test is expiry > now, not containsKey."',
    'Then optimise out loud: "Count is O(n). With one ttl and a forward-only clock, entries arrive in expiry order, so I can keep a queue and only look at the front. Renew makes old entries stale, so I check each popped entry against the map. Every entry is pushed once and popped once, so count is O(1) amortised."',
    'The queue version in Kotlin adds one field and changes count. private val queue = ArrayDeque<Pair<Int, String>>(). Generate and an accepted renew also do queue.addLast(now + ttl to id). Count is: while (queue.isNotEmpty() && queue.first().first <= now) { val (e, id) = queue.removeFirst(); if (expiry[id] == e) expiry.remove(id) }; return expiry.size',
    'Offer the alternative in a sentence: "A LinkedHashMap with remove then put on renew gives the same cost with no stale entries. If the ttl varied per token I\'d swap the queue for a PriorityQueue ordered by expiry, O(log n) per push and pop, with the same stale check."',
    'If asked about threads: "One lock around all three methods. The work inside is tiny and never blocks, so a single lock is enough. A ConcurrentHashMap wouldn\'t do it, because renew is check-then-act and count updates the queue and the map together."',
    'If asked about production, switch to the cached access token: "One token and its expiry in memory. Callers get the cached token. I refresh ahead of expiry, so on the happy path nobody waits." A common rule of thumb is to refresh when about a fifth of the token\'s life is left; it\'s a rule of thumb, not a standard.',
    'Explain single flight: "The first caller to find the token due starts the refresh and stores the in-flight call, a CompletableFuture in Java or a Deferred in Kotlin. Later callers await that same object. Fifty callers make one call to the auth server, not fifty." Hold the lock only to read or set the in-flight call, never across the network call.',
    'Say what callers get during a refresh. While the old token is still live they get the old token at once. Only when it has truly expired do they wait on the in-flight call.',
    'Cover failure: "If the refresh fails, I keep serving the old token until it truly expires and retry with exponential backoff and jitter. I clear the in-flight call on failure, in a finally block, or every later caller waits on a dead call for ever. Once the token has expired, callers get the error."',
    'Add the margins: "I treat the token as expiring a little early, say 30 seconds, to cover clock skew and time on the wire. I work out expiry from expires_in against my own clock, not from the server\'s timestamp. If a call comes back 401 with a token I thought was live, I drop it and refresh once, since it may have been revoked."',
    'Keep saying the complexity as you go. Each time the code changes, one sentence: what generate, renew and count cost now, and what the memory is.',
  ],
};
