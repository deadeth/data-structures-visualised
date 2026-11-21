import type { Practice } from '../types';

const page: Practice = {
  id: 'token-manager',
  title: 'Token manager: one access token, kept fresh',
  summary:
    "Keep one access token for your service's outgoing calls: cache it, renew it 30 seconds before its hour is up, and refresh it before falling back to a login.",
  minutes: 35,
  core: 3,
  testing: {
    intro:
      'The code is short: by the end of stage 3 you have written 23 lines, one of them a comment. What counts is what you ask about the gaps in the brief, where the one field gets written, and how you use the clock.',
    points: [
      'You ask whether a token expires, whether there is a refresh token and what callers get in an outage before you type.',
      'You say the sum aloud, 3,600,000 minus 30,000 is 3,570,000, and test one millisecond either side of it with the supplied clock and no sleeping.',
      'You write the token field in one place, from a call that succeeded, so that an outage and a hundred threads each cost a few lines and no rewrite.',
    ],
  },
  use: 'Drill "Ask first" and stages 1 to 3 until you can type them without the page. Stages 4 and 5 and the last ten minutes are things to say: code them only if the clock allows.',
  brief: [
    '"Our service calls a partner API that needs an access token on every request. Getting a token means a call to the partner\'s auth server, which is slow and rate limited. Write a token manager with one method, `getToken()`, that returns a token that is valid right now and calls the auth server as rarely as it can."',
    'The animated [Token manager](#/s/token-manager) page is a store of many tokens, each with its own time to live, where the work is renewing them and counting the live ones cheaply; this page keeps one token and fetches it as rarely as it can. If the name is all you are given, ask which one is meant.',
  ],
  given: [
    '`record Token(String authToken, String refreshToken, long expiresAt)`, with `expiresAt` in milliseconds on your clock.',
    '`AuthApi`: `login()` and `refresh(String refreshToken)`. Both throw `AuthUnavailableException` when the server is down; `refresh` throws `RefreshRejectedException` on a refused refresh token. Neither is checked.',
    "`Clock`, the starter's own one-method interface (`nowMillis()`), set by hand in the tests: never read the system clock.",
    '`FakeAuthApi`: issues `a1`, `a2` with `r1`, `r2`, each valid for one hour (3,600,000 ms), and accepts only the latest refresh token. Print `auth.log()` when a test surprises you.',
    'The `TokenManager` stub, with the 30,000 ms default margin and the two-argument constructor written, and the tests. Each test starts at time 0 with `a1` already fetched.',
  ],
  ask: [
    {
      q: 'Does a token come with an expiry, and on whose clock?',
      why: "Every later stage compares the time with it, and a time on the server's clock brings the gap between the two clocks with it.",
      assume: 'Each token carries `expiresAt` in milliseconds on our clock, and I read the time from a clock passed to the constructor.',
    },
    {
      q: 'How early should I renew, given how long a request can take?',
      why: 'A token valid when handed out can expire on the wire, so the test becomes "will it expire within 30 seconds".',
      assume: 'Renew 30 seconds early by default, with the margin a constructor argument.',
    },
    {
      q: 'Is there a refresh token, and what happens if the server refuses it?',
      why: 'It decides which call a renewal makes. A refresh that can be refused needs a second path back to a full login.',
      assume: 'Refresh whenever I hold a token. If the refresh token is refused, log in.',
    },
    {
      q: 'What should callers get when the auth server is down?',
      why: 'The answer decides what a failed renewal does: throw at once, or return a token that still works.',
      assume: 'Keep handing out the old token until it really expires, trying the server again on each call. Once nothing valid is left, throw.',
    },
    {
      q: 'Is `getToken()` called from many threads?',
      why: 'A hundred threads can find the token expired in the same millisecond, and each calls a server that is slow and rate limited.',
      assume: "Yes, from request threads. I'll get it right for one thread first and make it thread safe as the last step.",
    },
    {
      q: 'One instance of our service and one set of credentials, or several?',
      why: "Several instances can cancel each other's tokens, and a token for each partner or user turns the one field into a map of managers.",
      assume: "One instance, one set of credentials. I'll come back to both once this works.",
    },
  ],
  outline: `a manager holds:
  the auth server, the clock, the margin (30 s unless told)
  the token: empty until the first call

getToken, one caller at a time:
  now = the time on the clock
  if there is no token, or now >= its expiry - margin:
    try:
      token = renew()
    if the server is down:
      if there is no token, or now >= its expiry:
        fail: "no valid token: auth server unavailable"
      otherwise keep the old token; the next call tries again
  return the token's access string

renew:
  if there is no token: return login()
  try: return refresh(the token's refresh token)
  if the refresh token is refused: return login()`,
  parts: [
    {
      id: 'cache',
      title: 'Log in once and keep the token',
      stage: 1,
      ask: 'Log in on the first call and keep the token. Later calls return it without calling the auth server.',
      tests: ['first call logs in', 'later calls reuse the token', 'each manager keeps its own token'],
      regions: ['state', 'constructor', 'get-token'],
      pseudocode: `a manager holds:
  the auth server
  token, empty at first

getToken:
  if there is no token:
    token = login()
  return the token's access string`,
      choice:
        'Log in on the first call to `getToken()`, not in the constructor: building a manager then never touches the network, and a login that fails does so where a token is needed. The state is one instance field, `private Token token`, where `null` means never fetched. Keep the whole record though you return only `token.authToken()`: stage 2 needs its `expiresAt` and stage 3 its `refreshToken`. Callers never see the expiry, so the rule for when a token is too old lives in this class alone.',
      say: "I'll log in on the first call, not in the constructor, and keep the whole Token record because I'll need its expiry next.",
      trace: {
        caption:
          'However often the first manager is asked, its login appears once in the log. The last row is the fault stage 2 fixes: at 3600001 the manager still returns `a1`, which expired at 3600000.',
        head: ['Call', 'Clock (ms)', 'Returns', 'That manager keeps', 'Auth server log'],
        rows: [
          ['new manager', '0', 'no call yet', 'nothing', '`[]`'],
          ['getToken()', '0', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['getToken()', '0', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['a second manager on the same server: getToken()', '0', 'a2', 'a2, expires 3600000', '`[login, login]`'],
          ['the first manager: getToken()', '0', 'a1', 'a1, expires 3600000', '`[login, login]`'],
          ['the first manager, 1 ms after a1 expired', '3600001', 'a1', 'a1, expires 3600000', '`[login, login]`'],
        ],
      },
      pitfalls: [
        'A login in the constructor passes until stage 4, where "failed first login throws and is not kept" reports `expected IllegalStateException, got a2`.',
        'A `static` field leaves a token over from the test before: "later calls reuse the token" fails with `expected [login], got []`.',
      ],
    },
    {
      id: 'margin',
      title: 'Renew before it expires',
      stage: 2,
      ask: 'Tokens last an hour. Replace one that has expired, or that will within a margin, 30 seconds by default, so that no request in flight carries a dead token.',
      tests: [
        'token is kept until one ms before the margin',
        'token is replaced exactly at the margin',
        'expired token is replaced',
        'margin of zero keeps the token to its expiry',
      ],
      regions: ['state', 'constructor', 'get-token'],
      pseudocode: `a manager also holds:
  the clock
  the margin

getToken:
  now = the time on the clock, read once
  if there is no token, or now >= its expiry - margin:
    token = login()
  return the token's access string`,
      choice:
        'The whole stage is one comparison: renew when `now >= token.expiresAt() - marginMillis`, so `a1` is kept at 3,569,999 and replaced at 3,570,000. It is `>=` because `expiresAt` is the moment the token stops working: with `>` and a margin of 0 you would hand out a token in the millisecond it died. `token == null` stays first, so `||` never reaches `expiresAt()` on a missing token. Read the injected clock once, into `now`: stage 4 makes a second comparison that must see the same time.',
      say: "I'll renew once the time reaches expiry minus the margin, with greater-or-equal so the token is replaced at that exact millisecond.",
      trace: {
        caption:
          'The boundary is one millisecond wide: `a1` at 3569999, `a2` at 3570000. With a margin of 0 the same comparison puts it on the expiry itself.',
        head: ['Margin (ms)', 'Call', 'Clock (ms)', 'Returns', 'Token kept', 'Auth server log'],
        rows: [
          ['30000', 'getToken()', '0', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['30000', 'getToken(), 1 ms before the margin', '3569999', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['30000', 'getToken(), exactly at the margin', '3570000', 'a2', 'a2, expires 7170000', '`[login, login]`'],
          ['0', 'new server, new manager: getToken()', '0', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['0', 'getToken(), 1 ms before expiry', '3599999', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['0', 'getToken(), exactly at expiry', '3600000', 'a2', 'a2, expires 7200000', '`[login, login]`'],
        ],
        note: 'Rows 4 to 6 are the margin of zero test on a server of its own. In the test the same calls return `a2`, `a2` and `a3`, because the manager built before each test has already taken `a1`.',
      },
      pitfalls: [
        '`>` for `>=` fails "token is replaced exactly at the margin" with `expected a2, got a1`, and the margin of zero test too.',
        '`expiresAt` alone passes three tests and fails only "token is replaced exactly at the margin", so it looks nearly right.',
        '`System.currentTimeMillis()` is far past 3,600,000, so every call logs in and "later calls reuse the token" fails with `expected a1, got a2`.',
      ],
    },
    {
      id: 'refresh',
      title: 'Refresh first, log in if refused',
      stage: 3,
      ask: "Don't log in every hour. Renew with `refresh()` and the token's refresh token, and if the server refuses the refresh token, log in. A renewal that fails must break nothing.",
      tests: ['renewal uses the refresh token', 'refused refresh token falls back to login', 'failed refresh keeps the old token for the retry'],
      regions: ['get-token', 'renew'],
      pseudocode: `getToken: as stage 2, with one line changed:
  token = renew()

renew:
  if there is no token:
    return login()
  try:
    return refresh(the token's refresh token)
  if the refresh token is refused:
    return login()

the token changes only when renew returns. If renew
throws, the old token and its refresh token are still there.`,
      choice:
        'The decision is where the field is written. `renew()` returns the new token and never touches the field; `getToken()` assigns it in one place, `token = renew();`. Java runs the right-hand side first, so if the call throws, `a1` and `r1` are exactly where they were. Fall back to `login()` only on `RefreshRejectedException`, which means the server answered and this refresh token is dead. `AuthUnavailableException` means it did not answer, and a login would go to the same server, so let it leave `renew()` uncaught.',
      say: "renew returns the new token and I assign it in one place, so a failed call leaves the old token alone, and I only log in again when the refresh token is refused.",
      trace: {
        caption:
          'Three runs, each beginning like row 1. In run C look at "Token kept" after the failed call: still `a1` with `r1`, so the retry is a refresh and not a login.',
        head: ['Run', 'Call', 'Clock (ms)', 'Returns', 'Token kept', 'Auth server log'],
        rows: [
          ['A', 'getToken()', '0', 'a1', 'a1, r1, expires 3600000', '`[login]`'],
          ['A', "getToken() at a1's expiry", '3600000', 'a2', 'a2, r2, expires 7200000', '`[login, refresh r1]`'],
          ['B', 'another manager logs in', '0', 'no call to ours', 'a1, r1, expires 3600000', '`[login, login]`'],
          ['B', "getToken() at a1's expiry", '3600000', 'a3', 'a3, r3, expires 7200000', '`[login, login, refresh r1 (refused), login]`'],
          ['C', "getToken() at a1's expiry, server down", '3600000', 'AuthUnavailableException', 'a1, r1, expires 3600000', '`[login, refresh r1 (down)]`'],
          ['C', 'getToken() again, server up', '3600000', 'a2', 'a2, r2, expires 7200000', '`[login, refresh r1 (down), refresh r1]`'],
        ],
        note: 'One run for each test, in order. In run B the other manager was given `a2` and `r2`, which made `r1` stale: you never have to fake a refusal.',
      },
      pitfalls: [
        'Catching every exception for the fallback: a server that is down gets a refresh and then a login, and the third test shows `[login, refresh r1 (down), login]`.',
        'Clearing `token` when a renewal fails: the refresh token is lost, the retry is a login, and the same test fails with the same log.',
        'Passing `token.authToken()` to `refresh`: both are strings so it compiles, every refresh is refused, and the log shows `refresh a1 (refused)`.',
      ],
    },
    {
      id: 'outage',
      title: 'When the auth server is down',
      stage: 4,
      ask: 'The auth server goes down now and then. Keep using the token you have until it really expires, and try the server again on the next call. Once there is nothing valid to give, throw a clear exception. Never keep a failure.',
      tests: ['server down inside the margin gives the old token', 'server down at expiry throws', 'failed first login throws and is not kept'],
      regions: ['get-token'],
      pseudocode: `getToken: as stage 3, with the renewal wrapped:
  try:
    token = renew()
  if the server is down:
    if there is no token, or now >= its expiry:
      fail: "no valid token: auth server unavailable"
    otherwise do nothing: the old token still works

  return the token's access string

nothing about the failure is stored, so the next call
finds the same token and tries the server again`,
      verbal: [
        "I'd wrap the renewal in a try and catch only the server-down exception, storing nothing about the failure.",
        "If the old token hasn't really expired I return it, and the next call tries the server again.",
        "If it has expired, or the first login failed, I throw an IllegalStateException with the cause attached.",
      ],
      choice:
        'There are two times: the margin says when to start trying, 3,570,000, and the expiry says when the token dies, 3,600,000. When a renewal fails, ask the second question, `now >= token.expiresAt()`, with no margin in it. With the margin you have rewritten the condition that got you into the block, so every failure throws and the 30 seconds bought nothing. It is `>=` because at 3,600,000 `a1` is dead, and returning it only moves the failure to the partner API. Set no flag in the `catch`: storing nothing is what makes the next call try again.',
      say: "On a failed renewal I check the real expiry, not the margin, and return the old token if it's still alive.",
      trace: {
        caption:
          'The same failure three times: a live token is returned (run A), a dead one or none at all throws (runs B and C). In every run the next call goes straight back to the server.',
        head: ['Run', 'Call', 'Clock (ms)', 'Returns', 'Token kept', 'Auth server log'],
        rows: [
          ['A', 'getToken(), server down, 1 ms before expiry', '3599999', 'a1', 'a1, r1, expires 3600000', '`[login, refresh r1 (down)]`'],
          ['A', 'getToken() again, server up', '3599999', 'a2', 'a2, r2, expires 7199999', '`[login, refresh r1 (down), refresh r1]`'],
          ['B', 'getToken(), server down, at expiry', '3600000', 'IllegalStateException', 'a1, r1, expires 3600000', '`[login, refresh r1 (down)]`'],
          ['B', 'getToken() again, server up', '3600000', 'a2', 'a2, r2, expires 7200000', '`[login, refresh r1 (down), refresh r1]`'],
          ['C', 'a new manager, first getToken(), server down', '0', 'IllegalStateException', 'nothing', '`[login, login (down)]`'],
          ['C', 'its next getToken(), server up', '0', 'a2', 'a2, r2, expires 3600000', '`[login, login (down), login]`'],
        ],
        note: 'One run for each test, in order, each starting with `a1` fetched at time 0. In run C the new manager shares that server, so the first `login` in its log belongs to the other manager.',
      },
      pitfalls: [
        'The margin in the failure check, or a throw on every failure: the first test fails with `expected a1, got IllegalStateException`.',
        'The old token returned whatever its age, or `>` at the expiry: "server down at expiry throws" fails with `expected IllegalStateException, got a1`.',
        'No `token == null` in the check: the first login can fail too, and the third test reports `got NullPointerException`.',
      ],
    },
    {
      id: 'single-flight',
      title: 'A hundred threads, one renewal',
      stage: 5,
      ask: 'A hundred threads call `getToken()` at the same moment and the token has expired. I want one call to the auth server, and all hundred to get the new token. Someone reading a valid token should wait no longer than the simplest design needs.',
      tests: ['hundred threads on an expired token share one call', 'hundred threads on a valid token make no call', 'after a failed renewal the next waiter renews'],
      regions: ['get-token'],
      pseudocode: `getToken, one caller at a time (one lock for each manager):
  everything from stage 4, unchanged

what the lock does when 100 threads find the token expired:
  thread 1 takes the lock, sees "expired", calls refresh
  threads 2 to 100 wait for the lock
  thread 1 stores the new token and lets go
  each waiter takes the lock in turn, sees a fresh token
    and returns it without calling the server`,
      verbal: [
        "I'd make getToken synchronized, so the check, the renewal and the write are one critical section.",
        'The first thread renews while the other 99 wait, then each finds the new token and makes no call.',
        "The price is a lock held across a network call, so I'd want a timeout on that call.",
      ],
      caveat:
        'No test here measures a wait: "hundred threads on a valid token make no call" passes with no lock at all, and one `static` lock shared by every manager passes all three.',
      choice:
        'The lock has to cover the check, the renewal and the write together, because the fault is a hundred threads passing the check before any has renewed. `synchronized` on the method does that in one word, locks on this manager only, and makes the plain `token` field safe. A caller with a valid token holds the lock for one clock read and one comparison. Once an hour everyone waits behind the auth call, including callers in the 30-second margin whom `a1` would still serve. Failure needs nothing new: stage 4 stored nothing, so the next waiter finds the token still expired and renews it.',
      say: "The check, the renewal and the write have to be one critical section, so I'll make the whole method synchronized.",
      trace: {
        caption:
          'With the lock, one thread is inside the auth call and 99 wait outside it, so the log gains one line. Without it (the last two rows, stage 4 code under the same test) all 100 are inside the server at once.',
        head: ['Code', 'Moment', 'The 100 threads', 'Auth server log'],
        rows: [
          ['stage 5', 'clock at 3600000, 100 threads started, auth call held', '`{BLOCKED=99, TIMED_WAITING=1}`', '`[login]`'],
          ['stage 5', 'auth call released, all threads done', '`{a2=100}`', '`[login, refresh r1]`'],
          ['stage 5', 'new run, server down for one call: threads started, call held', '`{BLOCKED=99, TIMED_WAITING=1}`', '`[login]`'],
          ['stage 5', 'auth call released, all threads done', '`{IllegalStateException=1, a2=99}`', '`[login, refresh r1 (down), refresh r1]`'],
          ['stage 5', 'new run, clock at 0 so a1 is valid: 100 threads', '`{a1=100}`', '`[login]`'],
          ['stage 4, no lock', 'clock at 3600000, 100 threads started, auth call held', '`{TIMED_WAITING=100}`', '`[login]`'],
          ['stage 4, no lock', 'auth call released, all threads done', '100 different outcomes: a2 to a101', '`login`, then `refresh r1` 100 times'],
        ],
        note: '`BLOCKED` is a thread waiting for the manager\'s lock; `TIMED_WAITING` is one inside the held auth call. Rows 1 and 2 are the first test, rows 3 and 4 the third and row 5 the second.',
      },
      pitfalls: [
        'Locking only the renewal: all hundred pass the check first, then renew one after another, and the test reports `100 different outcomes`.',
        'A `volatile` field and no lock: nothing stops all hundred calling the server together, and the test reports `100 different outcomes` again.',
        'Rewriting the method as double-checked locking or a shared future with minutes left on the clock, when one word passes all three tests.',
      ],
    },
  ],
  followUps: [
    {
      q: 'How do you test code that depends on the time?',
      a: "I pass the clock in and never read the system clock, so a test can stand at 3,569,999 and then at 3,570,000 without a sleep. For threads I'd use real threads, a latch in the fake server that holds the auth call, and a limit on every wait.",
    },
    {
      q: 'What would you log and measure once this is live?',
      a: "Never the access or refresh token: anyone reading the logs could call the partner as us, and a record's default `toString` prints every field. I'd count auth calls by kind and result, and alert once renewals have failed for ten seconds or so, because at 30 the token is dead.",
    },
    {
      q: 'What would you change before this went to production?',
      a: "A timeout and backoff first; both come up below. Then an exception type of our own in place of `IllegalStateException`, credentials from a secret store, and a branch in `renew()` that logs in when the server sent no refresh token.",
    },
    {
      q: "Our clock and the auth server's are a few seconds apart. Does that matter?",
      a: "Only if the expiry arrives as a time on the server's clock, when the gap comes straight off the margin. I'd rather be sent a lifetime in seconds and add it to my own clock when the response arrives. The 30 seconds must cover that gap plus the longest request.",
    },
    {
      q: 'The partner API answers 401 for a token we think is valid. What then?',
      a: "The token was revoked early, and today we'd hand it out until it expired. I'd add `invalidate(token)` and retry the request once with a new token: a second 401 means the credentials are wrong. `invalidate` does nothing if the manager already holds a newer token, so a slow thread can't discard a fresh one.",
    },
    {
      q: 'The auth server is down for ten minutes. What stops us hammering it?',
      a: "Today, nothing: every call makes one attempt. I'd store one thing about a failure, a next-attempt time that doubles up to a cap, with jitter so instances don't retry in step. Before that time I return the old token if it's alive and throw at once if not: see [Retries, backoff and circuit breakers](#/s/retries-breaker).",
    },
    {
      q: 'You hold a lock across a network call. Is that acceptable?',
      a: "Here, yes: one word gives one renewal for a hundred threads, once an hour. It needs a [timeout](#/c/resilience-patterns/timeouts-and-deadlines) on the auth call well under the 30-second margin, which this code doesn't set, or one hung call holds up every caller. If callers must never wait while the old token is alive, I'd share one `CompletableFuture` for the renewal and throw a failed one away.",
    },
    {
      q: 'Could a caller with a valid token skip the lock altogether?',
      a: "Yes: a `volatile` field, checked once outside the lock and again inside. It saves only a wait for one comparison, and the inner check is the line people forget, so I'd want a profile showing threads queueing first.",
    },
    {
      q: "Would you renew in the background, off the callers' threads?",
      a: "Not as the first version: on demand is one method and costs one slow request an hour. A scheduled task renewing at, say, 80% of the lifetime keeps request threads off the auth server, but the on-demand path must stay for the day it fails.",
    },
    {
      q: 'We need a token for each of 200 partners, or for each user. What changes?',
      a: "A map from the key to its own manager, created with `computeIfAbsent` on a `ConcurrentHashMap`, which builds the value once even if two threads ask together. Each manager has its own lock, so one slow partner doesn't hold up the other 199. For users the map needs a size limit, such as an [LRU](#/s/lru-cache).",
    },
    {
      q: 'We run ten instances of the service. What changes?',
      a: "Each has its own manager, so ten renewals an hour, and if the server allows that I change nothing. It breaks if the server keeps only the newest refresh token, as the fake here does: every renewal becomes a refused refresh and then a login. Then the token goes in a shared store, with a lock or compare-and-set so one instance renews.",
    },
  ],
  see: [
    { href: '#/s/token-manager', label: 'Token manager (the other exercise with this name)' },
    { href: '#/c/caching/ttl-stampede', label: 'Caching: TTLs, jitter and stampedes' },
    { href: '#/s/cache-strategies', label: 'Cache read and write strategies' },
    { href: '#/s/retries-breaker', label: 'Retries, backoff and circuit breakers' },
    { href: '#/c/resilience-patterns/timeouts-and-deadlines', label: 'Resilience patterns: timeouts and deadlines' },
  ],
  unverified: [
    'That auth servers commonly send a lifetime in seconds, and that a refresh token is optional: from memory of OAuth 2.0, not checked against the specification.',
    'That some auth servers keep only one live refresh token for a client: general knowledge, not checked against any product.',
    'That a refresh is cheaper for the server, or allowed more often, than a login: an assumption behind stage 3.',
    'That `computeIfAbsent` on a `ConcurrentHashMap` runs its function at most once for a key: from memory of the Java documentation.',
    'The alternatives to `synchronized` (a `volatile` field with a second check, a shared `CompletableFuture`) were not written or run. What each buys and costs is reasoning.',
    'The designs in the follow-up answers (`invalidate` for a 401, backoff with jitter, background renewal at 80% of the lifetime, a map of managers, a shared store, a secret store) were not built. Their figures are examples.',
    'That a partner API answers a revoked token with a 401: common practice, not something this exercise shows.',
    'That a caller with a valid token holds the lock only briefly is read off the code. No test measures time.',
  ],
};

export default page;
