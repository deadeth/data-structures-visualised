import type { Practice } from '../types';

const page: Practice = {
  id: 'token-manager',
  title: 'Token manager: one access token, kept fresh',
  summary:
    "Keep one access token for your service's outgoing calls: cache it, renew it 30 seconds early, refresh before logging in, ride out an auth outage and let a hundred threads share one renewal. The finished code is one synchronized method and a ten-line helper, so what is being tested is whether you can say why each line is where it is.",
  minutes: 35,
  core: 3,
  brief: [
    '"Our service calls a partner API that needs an access token on every request. Getting a token means a call to the partner\'s auth server, which is slow and rate limited. Write a token manager with one method, `getToken()`, that returns a token that is valid right now and calls the auth server as rarely as it can."',
    'That is all you get at the start. It does not say how long a token lasts, whether there is a refresh token, what callers get when the auth server is down, or how many threads call. Ask before you type.',
    'An interviewer who says "token manager" may mean a different exercise. The animated [Token manager](#/s/token-manager) page is a store of many tokens, each with its own time to live, where the work is renewing them and counting the live ones cheaply; this page keeps one token and fetches it as rarely as it can. If the name is all you are given, ask which one is meant.',
  ],
  given: [
    '`record Token(String authToken, String refreshToken, long expiresAt)`. `expiresAt` is when the token stops working, in milliseconds on your clock. A record gives you the accessors `authToken()`, `refreshToken()` and `expiresAt()` without writing them.',
    '`interface AuthApi` with `login()` and `refresh(String refreshToken)`, each returning a `Token`. Both throw `AuthUnavailableException` when the server is down. `refresh` throws `RefreshRejectedException` when it will not take the refresh token. Both exceptions are unchecked, so the compiler will not remind you to catch them.',
    "`interface Clock { long nowMillis(); }`. It is the starter's own one-method interface, not `java.time.Clock`. The tests pass in a clock they set by hand, so nothing in your class may read the system clock.",
    '`FakeAuthApi`, the auth server the tests use. It issues `a1`, `a2` and so on with refresh tokens `r1`, `r2`, each valid for one hour (3,600,000 ms) from issue. It accepts only the latest refresh token it has issued. It logs every call, failed ones too, and the tests count calls by reading that log: `[login, refresh r1 (down), refresh r1]`.',
    'The `TokenManager` stub. `DEFAULT_MARGIN_MILLIS = 30_000` is there, and so is a two-argument constructor that already passes it to the three-argument one. You fill in the three-argument constructor and `getToken()`, which returns the access token as a `String`, not the record: callers need only the string for a header.',
    'A test harness and the tests of all five stages. Before each test body runs, the clock is set to 0 and a new manager on a new server has already fetched `a1`, which expires at 3,600,000. `token()` returns what `getToken()` returned, or the simple class name of what it threw. `tokenAt(t)` sets the clock to `t` first. `hundredCalls()` is for stage 5.',
    'With the starter untouched, all three stage 1 tests fail with `expected a1, got UnsupportedOperationException`. Set `STAGE` to run more.',
  ],
  ask: [
    {
      q: 'Does a token come with an expiry, and on whose clock?',
      why: "Every stage after the first compares the time with it. If the server sends a lifetime in seconds, you turn it into a time on your own clock when the answer arrives. If it sends a time on its own clock, the difference between the two clocks comes with it.",
      assume: 'Each token carries `expiresAt` in milliseconds on our clock, and I read the time from a clock passed to the constructor.',
    },
    {
      q: 'How long can a request take once it has its token? How early should I renew?',
      why: 'A token that is valid when you hand it out can expire while the request is on the wire. The answer is the margin, and it changes the test from "has it expired" to "will it expire within 30 seconds".',
      assume: 'Renew 30 seconds early by default, with the margin a constructor argument.',
    },
    {
      q: 'Is there a refresh token, and what happens if the server refuses it?',
      why: 'It decides which call a renewal makes. A refresh that can be refused needs a second path back to a full login.',
      assume: 'Refresh whenever I hold a token. If the refresh token is refused, log in.',
    },
    {
      q: 'What should callers get when the auth server is down?',
      why: 'You can fail at once, or ride out the outage on a token that still works. The answer decides what a failed renewal does: throw, or return what you have.',
      assume: 'Keep handing out the old token until it really expires and try the server again on each call. Once nothing valid is left, throw a clear exception.',
    },
    {
      q: 'Is `getToken()` called from many threads?',
      why: 'If it is, a hundred request threads can find the token expired in the same millisecond, and each will call a server that is slow and rate limited.',
      assume: "Yes, from request threads. I'll get it right for one thread first and make it thread safe as the last step, so an expired token costs one auth call and not a hundred.",
    },
    {
      q: 'Is there one instance of our service or several, and does a new login cancel what was issued before it?',
      why: "If it does, several instances with a manager each keep knocking out each other's tokens, and the token has to live somewhere they share.",
      assume: "One instance and one manager. I'll come back to several instances once this works.",
    },
    {
      q: 'One set of credentials, or a token for each partner or each user?',
      why: 'Many keys turn the one field into a map of managers, with a lock for each and a limit on its size.',
      assume: 'One set of credentials, so one token.',
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
      pseudocode: `a manager holds:
  the auth server
  token, empty at first

getToken:
  if there is no token:
    token = login()
  return the token's access string`,
      regions: ['state', 'constructor', 'get-token'],
      explain: [
        "The decision is when to log in. Do it on the first call to `getToken()`, not in the constructor. Building a manager then never touches the network, and a login that fails does so where a token is needed. A login in the constructor passes all three tests of this stage, and it comes back to bite in stage 4, whose last test expects a manager's first `getToken()` to make the call and report the failure.",
        "The state is one field, `private Token token`, and `null` means never fetched. Keep the whole record even though you return only the string: stage 2 needs its `expiresAt` and stage 3 its `refreshToken`. Callers get a `String` and never see the expiry, so the rule for when a token is too old lives in this class and nowhere else.",
        'It is an instance field. The third test builds a second manager on the same server and expects `a2` from it and `a1` still from the first. A `static` field would share one token between them.',
        'The constructor is handed a clock and a margin and stores neither yet, because nothing reads them until stage 2. Type the two fields, the one assignment and the four lines of `getToken()`. A call costs one null check, and the server is called once in the life of the manager. That is also what is wrong with it: the last row of the run shows `a1` handed out after it has expired.',
      ],
      lines: [
        { code: 'private Token token;', note: '`null` until the first call. Not `final`, because it is replaced on every renewal, and not `static`, because each manager has its own.' },
        { code: 'if (token == null) {', note: 'The only question stage 1 asks. Stage 2 adds a second condition after it with `||`, and this one has to stay first.' },
        { code: 'return token.authToken();', note: 'The string goes out and the record stays in. No caller can hold on to an expiry and make its own decision with it.' },
      ],
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
        note: 'Rows 2 and 3 are the tests "first call logs in" and "later calls reuse the token". Rows 4 and 5 are "each manager keeps its own token".',
      },
      say: "I'll log in on the first call, not in the constructor, so building the manager never touches the network. I'm keeping the whole Token record because I'll need its expiry next, but callers only get the string.",
      pitfalls: [
        'Logging in in the constructor: every test passes until stage 4, where "failed first login throws and is not kept" reports `expected IllegalStateException, got a2`.',
        'Making the field `static`: the second test sees a token left over from the first, and "later calls reuse the token" fails with `expected [login], got []`.',
        'Keeping only the access string in the field: stage 1 passes, and stage 2 starts with changing the field back to the record to reach `expiresAt`.',
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
      pseudocode: `a manager also holds:
  the clock
  the margin

getToken:
  now = the time on the clock, read once
  if there is no token, or now >= its expiry - margin:
    token = login()
  return the token's access string`,
      regions: ['state', 'constructor', 'get-token'],
      explain: [
        'The whole stage is one comparison: renew when `now >= expiresAt - margin`. Do the sum aloud. `a1` expires at 3,600,000 and the margin is 30,000, so the line is at 3,570,000. At 3,569,999 you keep `a1`. At 3,570,000 you replace it.',
        'It is `>=` because `expiresAt` is the moment the token stops working. With `>` and a margin of 0, the manager would hand out a token at the very millisecond it died. With `>=`, every token handed out here has more than the margin left: more than 30 seconds by default. The tests pin the boundary from both sides, one millisecond apart.',
        'The obvious alternative is `now >= token.expiresAt()` with no margin. It passes three of the four tests and hands out tokens with a millisecond to live. Another is a second field holding the time to renew at. That works, but it is a second value to keep in step with the token, and stage 4 needs the real expiry as well. Keep the token and do the subtraction.',
        'Read the clock once, into `now`, from the `Clock` you were given. That is what lets a test stand at 3,569,999. Stage 4 makes a second comparison in the same call, and both must see the same time.',
        'Since stage 1: two fields, two assignments in the constructor, one new line and a longer condition. Renewal is still a full login, so the log reads `[login, login]`. A call costs one clock read and one subtraction. Under steady use the server is called every 3,570,000 ms, half a minute short of the hour.',
      ],
      lines: [
        { code: 'long now = clock.nowMillis();', note: "One read for each call, from the injected clock. `System.currentTimeMillis()` here takes the time out of the tests' hands." },
        {
          code: 'if (token == null || now >= token.expiresAt() - marginMillis) {',
          note: '`token == null` comes first so that `||` never reaches `token.expiresAt()` on a missing token. Then `>=`, and minus, not plus: the margin moves the line earlier.',
        },
        { code: 'this.marginMillis = marginMillis;', note: 'Store what the constructor was given and read the field in `getToken()`. Reading `DEFAULT_MARGIN_MILLIS` there ignores a margin of 0.' },
      ],
      trace: {
        caption:
          'The boundary is one millisecond wide: `a1` at 3569999, `a2` at 3570000. With a margin of 0 the same comparison puts the boundary on the expiry itself. Look at the expiry of `a2`, 7170000: an hour from when it was issued, not from when `a1` would have died.',
        head: ['Margin (ms)', 'Call', 'Clock (ms)', 'Returns', 'Token kept', 'Auth server log'],
        rows: [
          ['30000', 'getToken()', '0', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['30000', 'getToken(), 1 ms before the margin', '3569999', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['30000', 'getToken(), exactly at the margin', '3570000', 'a2', 'a2, expires 7170000', '`[login, login]`'],
          ['30000', 'getToken() again', '3570000', 'a2', 'a2, expires 7170000', '`[login, login]`'],
          ['0', 'new server, new manager: getToken()', '0', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['0', 'getToken(), 1 ms before expiry', '3599999', 'a1', 'a1, expires 3600000', '`[login]`'],
          ['0', 'getToken(), exactly at expiry', '3600000', 'a2', 'a2, expires 7200000', '`[login, login]`'],
        ],
        note: 'Rows 1 to 4 are the tests "token is kept until one ms before the margin" and "token is replaced exactly at the margin". Rows 5 to 7 are "margin of zero keeps the token to its expiry", run here on a server of its own. In the test the same calls return `a2`, `a2` and `a3`, because the manager built before each test has already taken `a1`.',
      },
      say: "The rule is: renew once the time reaches expiry minus the margin. I'll write it as one comparison with greater-or-equal, so a token is replaced at the exact millisecond, and I read the injected clock once so the tests can stand on that boundary.",
      pitfalls: [
        'Writing `>` for `>=`: "token is replaced exactly at the margin" fails with `expected a2, got a1`, and so does the margin of zero test, where it means handing out a token at the instant it dies.',
        'Comparing with `expiresAt` alone: three tests pass and only "token is replaced exactly at the margin" fails, so it looks nearly right.',
        'Putting `token == null` second in the condition: the first call throws `NullPointerException` and every test fails, stage 1 included.',
        'Calling `System.currentTimeMillis()`: the real time is far past 3,600,000, so every call logs in, and "later calls reuse the token" fails with `expected a1, got a2`.',
      ],
    },
    {
      id: 'refresh',
      title: 'Refresh first, log in if refused',
      stage: 3,
      ask: "Don't log in every hour. Renew with `refresh()` and the token's refresh token, and if the server refuses the refresh token, log in. A renewal that fails must break nothing.",
      tests: ['renewal uses the refresh token', 'refused refresh token falls back to login', 'failed refresh keeps the old token for the retry'],
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
      regions: ['get-token', 'renew'],
      explain: [
        'The decision is where the field is written. `renew()` returns the new token and never touches the field. `getToken()` assigns it in one place: `token = renew();`. Java runs the right-hand side first, so if the call throws, the assignment never happens and `a1` and `r1` are exactly where they were. That one line is the whole of "must break nothing".',
        'The tempting alternative is to clear the field before renewing, or to treat a failure as "no token". Then the refresh token is gone, and the retry has to be a full login. The log reads `[login, refresh r1 (down), login]` where the test wants `[login, refresh r1 (down), refresh r1]`.',
        'Fall back to `login()` only on `RefreshRejectedException`. A refusal means the server answered and this refresh token is dead, so a login is the right next call. `AuthUnavailableException` means the server did not answer, and a login would go to the same server: catching it here turns one failed call into two against a rate-limited server. Let it leave `renew()` untouched. At this stage it reaches the caller raw. Stage 4 decides what to do with it.',
        'You never have to fake a refusal. The supplied server accepts only the newest refresh token it has issued, and every login or refresh that succeeds issues a new pair. So a login by any manager makes the refresh tokens of every other manager on that server stale. The second test builds another manager and calls it once: it gets `a2` and `r2`, and `r1` is dead. At 3,600,000 your manager offers `r1`, is refused, logs in and gets `a3`.',
        'Write `renew()` under `getToken()` first, ten lines, then change `auth.login()` to `renew()`. The first branch is for the first call, when there is no refresh token to offer. A renewal costs one auth call, or two when the refresh token is refused.',
      ],
      lines: [
        { code: 'token = renew();', note: 'The only line that writes the field after the first login, and it writes only what a successful call returned. If `renew()` throws, the line has no effect.' },
        {
          code: 'return auth.refresh(token.refreshToken());',
          note: 'The refresh token, not the access token. Both are `String`s, so the compiler cannot tell them apart. Get it wrong and the log shows `refresh a1 (refused)`.',
        },
        { code: '} catch (RefreshRejectedException e) {', note: 'The one exception that means "log in". Catching `RuntimeException` here would also send a login to a server that has just failed to answer.' },
        { code: 'if (token == null) {', note: 'In `renew()`: the first call has nothing to refresh with. It also keeps `token.refreshToken()` away from a missing token.' },
      ],
      trace: {
        caption:
          'Three runs. Each begins like row 1: a new server, and a manager that has fetched `a1` at time 0. In run C look at "Token kept" after the failed call: still `a1` with `r1`, so the retry is a refresh and not a login.',
        head: ['Run', 'Call', 'Clock (ms)', 'Returns', 'Token kept', 'Auth server log'],
        rows: [
          ['A', 'getToken()', '0', 'a1', 'a1, r1, expires 3600000', '`[login]`'],
          ['A', "getToken() at a1's expiry", '3600000', 'a2', 'a2, r2, expires 7200000', '`[login, refresh r1]`'],
          ['A', "getToken() at a2's expiry", '7200000', 'a3', 'a3, r3, expires 10800000', '`[login, refresh r1, refresh r2]`'],
          ['B', 'another manager logs in', '0', 'no call to ours', 'a1, r1, expires 3600000', '`[login, login]`'],
          ['B', "getToken() at a1's expiry", '3600000', 'a3', 'a3, r3, expires 7200000', '`[login, login, refresh r1 (refused), login]`'],
          ['C', "getToken() at a1's expiry, server down", '3600000', 'AuthUnavailableException', 'a1, r1, expires 3600000', '`[login, refresh r1 (down)]`'],
          ['C', 'getToken() again, server up', '3600000', 'a2', 'a2, r2, expires 7200000', '`[login, refresh r1 (down), refresh r1]`'],
        ],
        note: 'Run A is the test "renewal uses the refresh token", run B "refused refresh token falls back to login" and run C "failed refresh keeps the old token for the retry". In run B the other manager was given `a2` and `r2`, which is why ours ends up with `a3`.',
      },
      say: "renew returns the new token and I assign it in exactly one place, so if the call throws, the old token and its refresh token are untouched. I only fall back to login when the refresh token is refused, because if the server's down a login wouldn't get through either.",
      pitfalls: [
        'Catching every exception for the fallback: a server that is down gets a refresh and then a login, and "failed refresh keeps the old token for the retry" shows `[login, refresh r1 (down), login]`.',
        'Setting `token = null` before renewing: after a failed call the refresh token is lost, the retry is a login, and the same test fails with the same log.',
        'Passing `token.authToken()` to `refresh`: it compiles, every refresh is refused, and all three tests fail with logs such as `[login, refresh a1 (refused), login, refresh a2 (refused), login]`.',
        'Leaving out the fallback: "refused refresh token falls back to login" fails with `expected a3, got RefreshRejectedException`.',
      ],
    },
    {
      id: 'outage',
      title: 'When the auth server is down',
      stage: 4,
      ask: 'The auth server goes down now and then. Keep using the token you have until it really expires, and try the server again on the next call. Once there is nothing valid to give, throw a clear exception. Never keep a failure.',
      tests: ['server down inside the margin gives the old token', 'server down at expiry throws', 'failed first login throws and is not kept'],
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
      regions: ['get-token'],
      explain: [
        'There are two times, and this stage is about keeping them apart. The margin says when to start trying: 3,570,000. The expiry says when the token dies: 3,600,000. For the 30 seconds between them `a1` still works. So when a renewal fails, the question is the second one, "is it still alive", and the comparison is `now >= token.expiresAt()` with no margin in it.',
        'Put the margin in that comparison and you have written the condition that got you into the block. It is always true there, every failed renewal throws, and the 30 seconds bought nothing. Written against `expiresAt`, the margin becomes 30 seconds of free retries: an outage shorter than that costs callers nothing. A token returned in those 30 seconds may still die during a slow request. That is a request that might fail, against one that certainly would.',
        'The boundary is `>=` for the reason it was in stage 2. At 3,600,000 `a1` has stopped working, and returning it only moves the failure to the partner API, where it arrives as a rejected request with no sign that the auth server caused it. `token == null` comes first again, because the first login can fail too and then there is no old token to judge.',
        '"Never keep a failure" is met by what the `catch` block leaves out. It sets no flag, saves no exception and records no time. The field still holds whatever it held, so the next call asks the same question and tries the server again. The cost is that during an outage every call makes one auth call, with no backoff. Say that aloud, because it is the next question.',
        'Catch `AuthUnavailableException` and nothing wider, so a bug in your own code surfaces as itself. Throw `IllegalStateException` with a message that says what is wrong and with `e` as its cause. The path that returns the old token is an empty fall-through; leave a comment there so the reader knows it is meant. To type it, wrap the line `token = renew();` in a `try`: nine lines go round it, all in `getToken()`, and `renew()` is untouched.',
      ],
      lines: [
        {
          code: 'if (token == null || now >= token.expiresAt()) {',
          note: 'No margin here. This asks whether the token is dead, not whether it is due. With `- marginMillis` it is always true inside this block.',
        },
        { code: '} catch (AuthUnavailableException e) {', note: 'Only "the server did not answer". A refused refresh token never gets here, because `renew()` has already turned it into a login.' },
        { code: '"no valid token: auth server unavailable", e);', note: 'The message says what the caller lacks and why. The second argument keeps the original exception as the cause for whoever reads the stack trace.' },
      ],
      trace: {
        caption:
          'The same failure three times, and what is kept decides the outcome: a live token is returned (run A), a dead one or none at all throws (runs B and C). In every run the next call goes straight back to the server.',
        head: ['Run', 'Call', 'Clock (ms)', 'Returns', 'Token kept', 'Auth server log'],
        rows: [
          ['A', 'getToken()', '0', 'a1', 'a1, r1, expires 3600000', '`[login]`'],
          ['A', 'getToken(), server down, 1 ms before expiry', '3599999', 'a1', 'a1, r1, expires 3600000', '`[login, refresh r1 (down)]`'],
          ['A', 'getToken() again, server up', '3599999', 'a2', 'a2, r2, expires 7199999', '`[login, refresh r1 (down), refresh r1]`'],
          ['B', 'getToken(), server down, at expiry', '3600000', 'IllegalStateException', 'a1, r1, expires 3600000', '`[login, refresh r1 (down)]`'],
          ['B', 'getToken() again, server up', '3600000', 'a2', 'a2, r2, expires 7200000', '`[login, refresh r1 (down), refresh r1]`'],
          ['C', 'a new manager, first getToken(), server down', '0', 'IllegalStateException', 'nothing', '`[login, login (down)]`'],
          ['C', 'its next getToken(), server up', '0', 'a2', 'a2, r2, expires 3600000', '`[login, login (down), login]`'],
        ],
        note: 'Runs B and C start as run A does, with `a1` fetched at time 0; in run C the new manager shares that server, so the first `login` in its log belongs to the other manager. Run A is the test "server down inside the margin gives the old token", run B "server down at expiry throws" and run C "failed first login throws and is not kept".',
      },
      say: "The margin is when I start trying and the expiry is when the token actually dies, so if a renewal fails I check against the real expiry. Still alive, I return it and the next call tries again; dead or missing, I throw with the cause attached, and I store nothing about the failure.",
      pitfalls: [
        'Using the margin in the failure check, or throwing on every failure: "server down inside the margin gives the old token" fails with `expected a1, got IllegalStateException`.',
        'Returning the old token whatever its age, or writing `>` at the expiry: "server down at expiry throws" fails with `expected IllegalStateException, got a1`.',
        'Forgetting that the first login can fail: with no `token == null` in the check, "failed first login throws and is not kept" reports `got NullPointerException`.',
        'Remembering the failure in a flag or a saved exception and answering later calls from it: a one-second outage then lasts until something clears the flag.',
      ],
    },
    {
      id: 'single-flight',
      title: 'A hundred threads, one renewal',
      stage: 5,
      ask: 'A hundred threads call `getToken()` at the same moment and the token has expired. I want one call to the auth server, and all hundred to get the new token. Someone reading a valid token should wait no longer than the simplest design needs.',
      tests: ['hundred threads on an expired token share one call', 'hundred threads on a valid token make no call', 'after a failed renewal the next waiter renews'],
      pseudocode: `getToken, one caller at a time (one lock for each manager):
  everything from stage 4, unchanged

what the lock does when 100 threads find the token expired:
  thread 1 takes the lock, sees "expired", calls refresh
  threads 2 to 100 wait for the lock
  thread 1 stores the new token and lets go
  each waiter takes the lock in turn, sees a fresh token
    and returns it without calling the server`,
      regions: ['get-token'],
      explain: [
        'The decision is what the lock has to cover: the check, the renewal and the write, as one critical section. The fault is a hundred threads passing the check before any of them has renewed, so a lock around the renewal alone is too small. `synchronized` on the method covers all three with one word. It also makes the plain `token` field safe, because every read and write of it now happens with the same lock held.',
        'A caller who finds a valid token holds the lock for one clock read and one comparison. The real cost comes once an hour: while one thread is inside the auth call, every other caller waits, including those in the 30-second margin whom `a1` would still have served. That wait lasts as long as the auth call does, and this code puts no timeout on it. Say so.',
        'Failure needs nothing new, because stage 4 stores nothing. If the first renewal fails, that caller gets the exception and lets go of the lock. The next waiter finds the token still expired and renews it itself, and the other 98 reuse what it fetched: `{IllegalStateException=1, a2=99}` for three calls in the log. If the server stayed down, the waiters would each try in turn.',
        'The cleverer options each buy one thing. A `volatile` field, checked once outside the lock and again inside it, lets readers of a valid token skip the lock. It is more code, the inner check is the line people forget, and all it saves is a wait for one comparison: move to it when a profile shows threads queueing on this monitor. A `ReentrantLock` behaves the same in more lines (`lock`, `try`, `finally`, `unlock`) and adds `tryLock` with a timeout: move to it when a caller must be able to give up waiting.',
        'A shared `CompletableFuture` for the renewal in flight needs the lock only to find or start the future, so nobody holds a lock across the network and callers in the margin can take the old token and go. It brings stage 4 back in a new place: a failed future has to be thrown away, not kept. Move to it when the hourly wait shows in your latency, or when renewal moves to a background thread. Here one word passes all three tests, so give that answer first.',
      ],
      lines: [
        { code: 'synchronized String getToken() {', note: 'The whole of stage 5. An instance method locks on this manager, so two managers never wait for each other.' },
        {
          code: 'if (token == null || now >= token.expiresAt() - marginMillis) {',
          note: 'Each of the 99 waiters runs this check after it gets the lock, finds the token the first thread stored, and skips the renewal.',
        },
        { code: 'token = renew();', note: 'Now a network call made with a lock held. That is the price of the one-word fix, and the reason the auth call needs a timeout.' },
      ],
      trace: {
        caption:
          'With the lock, one thread is inside the auth call and 99 wait outside it, so the log gains one line. Without it (the last two rows, stage 4 code under the same test) all 100 are inside the server at once.',
        head: ['Code', 'Moment', 'The 100 threads', 'Auth server log'],
        rows: [
          ['stage 5', 'one getToken() at time 0', 'a1', '`[login]`'],
          ['stage 5', 'clock at 3600000, 100 threads started, auth call held', '`{BLOCKED=99, TIMED_WAITING=1}`', '`[login]`'],
          ['stage 5', 'auth call released, all threads done', '`{a2=100}`', '`[login, refresh r1]`'],
          ['stage 5', 'new run, server down for one call: threads started, call held', '`{BLOCKED=99, TIMED_WAITING=1}`', '`[login]`'],
          ['stage 5', 'auth call released, all threads done', '`{IllegalStateException=1, a2=99}`', '`[login, refresh r1 (down), refresh r1]`'],
          ['stage 5', 'new run, clock at 0 so a1 is valid: 100 threads', '`{a1=100}`', '`[login]`'],
          ['stage 4, no lock', 'clock at 3600000, 100 threads started, auth call held', '`{TIMED_WAITING=100}`', '`[login]`'],
          ['stage 4, no lock', 'auth call released, all threads done', '100 different outcomes: a2 to a101', '`login`, then `refresh r1` 100 times'],
        ],
        note: 'The thread states come from a scratch copy with one print added before the release. `BLOCKED` is a thread waiting for the manager\'s lock; `TIMED_WAITING` is a thread inside the held auth call. Rows 2 and 3 are the test "hundred threads on an expired token share one call", rows 4 and 5 "after a failed renewal the next waiter renews" and row 6 "hundred threads on a valid token make no call". In the last row no refresh was refused, because the fake checks the refresh token as the call arrives, before it is held.',
      },
      say: "The check, the renewal and the write have to be one critical section, so I'll make the whole method synchronized: the first thread renews, the rest wait and then find the new token. That holds a lock across a network call, which I'm accepting for now, and I'd want a timeout on that call.",
      pitfalls: [
        'Locking only the renewal: all hundred pass the check first, then queue up and renew one after another, and the test reports `100 different outcomes`.',
        'Making the field `volatile` and adding no lock: every thread sees the latest token, and nothing stops all hundred from calling the server together. The test reports `100 different outcomes` again.',
        'Using a `static` lock or a `static synchronized` method: every test here still passes, and in a service with several managers one slow auth server holds up callers of all the others.',
        'Rewriting the method as double-checked locking or a shared future with minutes left on the clock, when one word passes all three tests.',
      ],
    },
  ],
  followUps: [
    {
      q: 'How do you test code that depends on the time?',
      a: [
        "I pass the clock in and never read the system clock inside the class. The tests set the time to exact values, so I can stand at 3,569,999 and then at 3,570,000 without a single sleep.",
        "For threads I'd do what this file does: real threads, a latch in the fake server that holds the auth call until they are all waiting, and a limit on every wait.",
        'The cost is one more constructor argument.',
      ],
    },
    {
      q: 'What must never appear in a log?',
      a: [
        'The access token and the refresh token. Anyone who can read the logs could call the partner as us, and with the refresh token they could keep getting new tokens.',
        "I'd log events and facts about them: renewed, refused, failed, the expiry time.",
        "A Java record's default `toString` prints every field, so I'd override it on `Token`, or make sure the record never reaches a logger or an exception message.",
      ],
    },
    {
      q: "Our clock and the auth server's are a few seconds apart. Does that matter?",
      a: [
        "It matters if the expiry arrives as a time on the server's clock. Then the difference comes straight off the margin, or adds to it.",
        "I'd rather be given a lifetime in seconds and add it to my own clock when the response arrives. That is what `expiresAt` on our clock stands for in this exercise.",
        'Either way the 30-second margin has to cover the clock difference plus the longest request, so I would measure both before making it smaller.',
      ],
    },
    {
      q: 'The partner API answers 401 for a token we think is valid. What then?',
      a: [
        "The token was revoked early, or the server has lost it. I'd add an `invalidate(token)` method, get a new token and retry the request once.",
        "Once, not in a loop. A second 401 means the credentials or the permissions are wrong, and more logins won't fix that.",
        "`invalidate` takes the string that failed and does nothing if the manager already holds a newer one. That stops a slow thread throwing away a token another thread has just fetched.",
      ],
    },
    {
      q: 'What would you measure once this is live?',
      a: [
        'Auth calls by kind and result: login, refresh, refused, failed. A rise in refused refreshes tells me something else is invalidating our tokens.',
        'How long callers wait inside `getToken()`, and how much life a token has left when it is handed out.',
        "And 401s from the partner on a token we believed was good. I'd alert when renewals have been failing for ten seconds or so, because at 30 the token is dead and requests start to fail.",
      ],
    },
    {
      q: 'The auth server is down for ten minutes. What stops us hammering it?',
      a: [
        'Today, nothing: every call makes one attempt.',
        "I'd keep a next-attempt time that doubles after each failure, say 1, 2, 4 seconds up to a cap, with random jitter so instances don't retry in step. Before that time I return the old token if it's alive and throw at once if it isn't.",
        "A success resets it. It's the one thing about a failure I'd store, and it's a time, not a saved exception: see [Retries, backoff and circuit breakers](#/s/retries-breaker).",
      ],
    },
    {
      q: 'You hold a lock across a network call. Is that acceptable?',
      a: [
        'Here, yes. It is what makes one renewal for a hundred threads a one-word change, and it happens once an hour.',
        'The danger is a call that hangs, because every caller waits behind it. So the auth client needs a [timeout](#/c/resilience-patterns/timeouts-and-deadlines) well under the 30-second margin, which leaves time for another try while the old token is alive.',
        "If callers must never wait while the old token is alive, I'd move to a shared future, at the cost of more code and one more place to mishandle a failure.",
      ],
    },
    {
      q: "Would you renew in the background, off the callers' threads?",
      a: [
        'Not as the first version. On demand is one method, and it costs one slow request an hour.',
        'A scheduled task that renews at, say, 80% of the lifetime means request threads never wait for the auth server. I would move to it if that hourly wait showed up in the slowest requests.',
        'It costs a thread to start and stop, renewals when nobody needs a token, and the on-demand path has to stay for the day the background renewal fails.',
      ],
    },
    {
      q: 'We need a token for each of 200 partners, or for each user. What changes?',
      a: [
        "A map from the key to its own manager, created on first use with `computeIfAbsent` on a `ConcurrentHashMap`, which builds the value once even if two threads ask together.",
        "Each manager has its own lock, so one slow partner doesn't hold up the other 199.",
        'For users the map needs a limit, an [LRU](#/s/lru-cache) or eviction after idle time, or it grows with every user ever seen. And their refresh tokens are secrets that need a safe place to live.',
      ],
    },
    {
      q: 'We run ten instances of the service. What changes?',
      a: [
        'Each instance has its own manager, so ten renewals an hour. If the server allows that, I change nothing.',
        "It breaks if the server keeps only the newest refresh token for a client, as the fake here does. Two managers on it make each other's refresh tokens stale, so every renewal is a refused refresh and then a login: `refresh r1 (refused), login, refresh r2 (refused), login`.",
        "Then the token goes in a store the instances share, with a short lock or a compare-and-set so one instance renews and the rest read. That costs a network read where there was a field, and a second dependency that can be down.",
      ],
    },
  ],
  mistakes: [
    'Typing before asking whether tokens expire and whether there is a refresh token, then storing a bare `String` in stage 1 and reworking the field twice.',
    'Starting with the threads: reaching for `ReentrantLock` or `AtomicReference` in stage 1, before a single-threaded manager passes its three tests.',
    'Settling the boundary by feel. Say the sum aloud, 3,600,000 minus 30,000 is 3,570,000, and decide what happens at exactly that number before choosing between `>` and `>=`.',
    'Writing your own fake clock or fake server. Both are supplied, and the tests already read the log.',
    'Adding retry loops, sleeps or backoff inside `getToken()` in stage 4. The stage asks for one `try`, one `if` and one `throw`.',
    'Guessing at a failing test instead of printing `auth.log()`, which shows every call the manager made and how each one ended.',
  ],
  see: [
    {
      href: '#/s/token-manager',
      label: 'Token manager (the other exercise with this name)',
      why: 'A store of many tokens, each with a time to live, with renew and a count of the live ones. An interviewer who says "token manager" could mean that task or this one.',
    },
    {
      href: '#/c/caching/ttl-stampede',
      label: 'Caching: TTLs, jitter and stampedes',
      why: 'Stage 5 is a stampede on one key. The sequence diagram shows a hundred requests joining one call in flight, and the table beside it lists the other defences.',
    },
    {
      href: '#/s/cache-strategies',
      label: 'Cache read and write strategies',
      why: 'Its stampede operation shows several readers missing one key at once, first with no lock and then with a lock for each key.',
    },
    {
      href: '#/s/retries-breaker',
      label: 'Retries, backoff and circuit breakers',
      why: 'The backoff with jitter that the ten-minute outage question asks for, animated.',
    },
    {
      href: '#/c/resilience-patterns/timeouts-and-deadlines',
      label: 'Resilience patterns: timeouts and deadlines',
      why: 'Why the auth call needs a timeout before you hold a lock across it.',
    },
  ],
  simplified: [
    'A token with no refresh token is not handled. The fake always issues one, so `renew()` never checks; a server that sends none would need `token.refreshToken() == null` to lead to `login()` as well.',
    'No timeout on the auth calls, and the lock is held across them. A call that hangs holds up every caller.',
    'No backoff and no jitter. While the server is down every call makes one attempt.',
    'Nothing handles a 401 from the partner API, so a token revoked before its expiry is handed out until it expires.',
    'No renewal in the background. A caller always pays for it.',
    '`expiresAt` arrives as a time on our clock. A real response has to be converted, and the two clocks may differ.',
    'One set of credentials, one partner, one process.',
    'No logging and no metrics, and nothing about where credentials come from.',
    '`IllegalStateException` stands in for an exception type of your own.',
    "The fake's rule that only the latest refresh token works is one possible server behaviour, chosen so that the tests can produce a refusal through the normal API.",
    'In stage 5 the test waits until no thread is runnable before it releases the auth call. A correct manager passes whether or not that wait completes.',
  ],
  unverified: [
    'That auth servers commonly send a lifetime in seconds and not an absolute time, and that a refresh token is optional: from memory of OAuth 2.0, not checked against the specification.',
    'That some auth servers keep only one live token or one live refresh token for a client, so a new login cancels the old: general knowledge, not checked against any product.',
    'That a refresh is cheaper for the server, or allowed more often, than a login: an assumption behind stage 3, not a measured fact.',
    'That `computeIfAbsent` on a `ConcurrentHashMap` runs its function at most once for a key: from memory of the Java documentation.',
    'The alternatives in stage 5 (a `volatile` field with a second check, `ReentrantLock`, a shared `CompletableFuture`) were not written or run here. What each buys and costs is reasoning.',
    'The designs in the follow-up answers (an `invalidate` method for a 401, backoff with jitter, background renewal at 80% of the lifetime, a map of managers, a shared store for several instances) were not built. The figures in them are examples.',
    'That a partner API answers a revoked or expired token with a 401: common practice, not something this exercise shows.',
    'That a caller with a valid token holds the lock only briefly is read off the code. No test here measures time.',
  ],
};

export default page;
