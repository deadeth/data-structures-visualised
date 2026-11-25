# Building a Token Manager in Plain Java

## 1. Overview

In this tutorial, we'll build a token manager in plain Java 21: a class that keeps one access token for a partner API and calls the auth server as rarely as it can.

There are five parts. Parts 1 to 3 are the core: log in once and keep the token, renew it shortly before it expires, and refresh before falling back to a login. Parts 4 and 5 are optional: an outage of the auth server, and one renewal shared by a hundred threads.

These parts are the practice page's stages 1 to 5. Every test we name is a JUnit class and method from the practice project.

By the end, we'll be able to write the core from memory and give the reason for each line.

## 2. The Problem

Our service calls a partner API that needs an access token on every request. Getting one means a call to the partner's auth server, which is slow and rate limited. We write one method, `getToken()`, that returns the access string of a token that is valid right now.

The starter supplies the token and the auth server's interface:

```java
/** expiresAt: when it stops working, in milliseconds on our clock. */
record Token(String authToken, String refreshToken, long expiresAt) {}

/** The partner's auth server: slow and rate limited. Both calls throw
 *  AuthUnavailableException when it is down; refresh() throws
 *  RefreshRejectedException if it will not take the refresh token. */
interface AuthApi {
    Token login();
    Token refresh(String refreshToken);
}
```

Neither exception is checked. Which one we catch is most of Parts 3 and 4.

We're also given `Clock`, whose one method `nowMillis()` is our only source of time, and `FakeAuthApi`. The fake issues `a1`, `a2` and so on with refresh tokens `r1`, `r2`, each valid for one hour (3,600,000 ms). Only the latest refresh token works, and `log()` lists every call, such as `[login, refresh r1 (down)]`.

The rules are:

- Log in on the first call to `getToken()`, not in the constructor.
- Use a token until the clock reaches `expiresAt - margin`. The margin is 30,000 ms unless the constructor is given another.
- At that moment or later, renew: `refresh()` with the token's refresh token, and if that is refused, log in.
- Each manager keeps its own token.

We assume one instance of the service and one set of credentials. The starter's statement gives this example, with the default margin:

```
t = 0          getToken() -> a1, expires at 3,600,000   [login]
t = 3,569,999  getToken() -> a1, no call
t = 3,570,000  getToken() -> a2                [login, refresh r1]
```

The boundary is 3,600,000 - 30,000 = 3,570,000.

## 3. The Design

The manager's state is one field: the whole `Token` record, where `null` means never fetched.

Here is one token's life, with the default margin:

```
t = 0                     3,570,000               3,600,000
|-------------------------|-----------------------|----------->
issued                    margin starts           expiry

  use a1, no call           renew now; if that      a1 is dead:
                            fails, a1 still works   renew or throw
```

Two times matter. The margin start says when to begin renewing, and the expiry says when the token is dead. Parts 2 and 3 use only the first; Part 4 needs the second.

**We write the token field in one place, and only with the result of a call that succeeded.** A failed renewal then leaves the old token and its refresh token alone, and the next call tries again.

We simplify twice: we renew on the caller's thread, with no background task, and we trust `expiresAt` to be on our own clock.

## 4. Part 1: Logging In Once and Keeping the Token

The rule: log in on the first call and keep the token, so later calls return it without reaching the auth server. `Part1LogInOnceAndKeepTest` checks it.

In Part 1 the manager keeps two things:

```java
private final AuthApi auth;
private Token token;
```

We keep the whole record because Part 2 needs its `expiresAt` and Part 3 its `refreshToken`. It's an instance field: a `static` one would share a token between managers, and `Part1LogInOnceAndKeepTest.eachManagerKeepsItsOwnToken` would fail.

The constructor stores the auth server and does nothing else:

```java
TokenManager(AuthApi auth, Clock clock, long marginMillis) {
    this.auth = auth;
}
```

A login here is a network call inside object construction: `Part1LogInOnceAndKeepTest.constructorMakesNoCall` builds two managers and expects an empty log.

The first version of `getToken()` is a null check:

```java
String getToken() {
    if (token == null) {
        token = auth.login();
    }
    return token.authToken();
}
```

What it gets wrong shows as soon as the clock moves, in this run of the Part 1 code:

```
t=0 getToken() -> a1   auth log [login]
t=3600001 getToken() -> a1   auth log [login]
```

The second line hands out `a1` one millisecond after it expired.

## 5. Part 2: Renewing Before Expiry

The rule: replace a token that has expired, or will within the margin, so no request in flight carries a dead token. `Part2RenewBeforeExpiryTest` checks it.

The constructor now keeps the clock and the margin, in two new `final` fields:

```java
TokenManager(AuthApi auth, Clock clock, long marginMillis) {
    this.auth = auth;
    this.clock = clock;
    this.marginMillis = marginMillis;
}
```

The clock is passed in so that a test can stand at 3,569,999 and then at 3,570,000 without sleeping.

In `getToken()`, the condition grows by one clause:

```java
String getToken() {
    long now = clock.nowMillis();
    // Renew early so a request in flight never carries a dead token.
    if (token == null || now >= token.expiresAt() - marginMillis) {
        token = auth.login();
    }
    return token.authToken();
}
```

**The whole part is one comparison: `now >= token.expiresAt() - marginMillis`.** It's `>=` because `expiresAt` is the moment the token stops working. With `>` and a margin of 0, we'd hand out a token in the very millisecond it died.

We read the clock once, into `now`, because Part 4 makes a second comparison that must see the same time.

The starter's `main` makes four calls. With the Part 2 code it prints:

```
t=0 getToken() -> a1   auth log [login]
t=0 getToken() -> a1   auth log [login]
t=3569999 getToken() -> a1   auth log [login]
t=3570000 getToken() -> a2   auth log [login, login]
```

The boundary is one millisecond wide: `Part2RenewBeforeExpiryTest.keptUntilOneMsBeforeTheMargin` and `Part2RenewBeforeExpiryTest.replacedExactlyAtTheMargin` stand on either side of it.

## 6. Part 3: Refreshing First, Then Logging In

The rule: renew with `refresh()`, and log in only if the server refuses the refresh token. A renewal that fails must break nothing: the old token and refresh token stay, so the next call refreshes. `Part3RefreshThenLoginTest` checks it. For now, a server-down exception may pass through to the caller.

### 6.1. One Assignment

In `getToken()`, one line changes inside the same condition:

```java
if (token == null || now >= token.expiresAt() - marginMillis) {
    token = renew();
}
```

Java runs the right-hand side before it assigns. If `renew()` throws, the assignment never happens, and `a1` and `r1` are exactly where they were.

### 6.2. Refused or Down

The new method decides which call a renewal makes:

```java
private Token renew() {
    if (token == null) {
        return auth.login();
    }
    try {
        return auth.refresh(token.refreshToken());
    } catch (RefreshRejectedException e) {
        return auth.login();
    }
}
```

`renew()` returns the new token, never touches the field, and catches one exception only.

**"Refused" and "server down" are different failures, and a login cures only the first.** `RefreshRejectedException` means the server answered and this refresh token is dead, so we log in. `AuthUnavailableException` means it didn't answer. A login would go to the same server, so that exception leaves `renew()` uncaught.

Catching every exception would send a login to a server that is down. Clearing the field on a failure would throw away `r1`, so the retry would be a login too.

### 6.3. A Traced Run

Let's run the Part 3 code three ways:

```
Run A: a plain renewal
t=0 getToken() -> a1   auth log [login]
t=3570000 getToken() -> a2   auth log [login, refresh r1]
t=7140000 getToken() -> a3   auth log [login, refresh r1, refresh r2]
Run B: another manager has logged in, so r1 is stale
t=0 getToken() -> a1   auth log [login]
  a second manager logs in      auth log [login, login]
t=3570000 getToken() -> a3   auth log [login, login, refresh r1 (refused), login]
Run C: the server is down for one call
t=0 getToken() -> a1   auth log [login]
t=3570000 getToken() -> AuthUnavailableException   auth log [login, refresh r1 (down)]
t=3570000 getToken() -> a2   auth log [login, refresh r1 (down), refresh r1]
```

In run C the retry is `refresh r1`, not `login`: the failed call left `a1` and `r1` in place.

### 6.4. A Gap in the Tests

One sequence has no test: a refused refresh followed by a fallback login that fails. The supplied fake can't produce it. It fails the next call, whichever call that is, so the refresh fails as "down" before it can be refused.

Reading the code, the login's exception leaves `renew()`, nothing is assigned, and the old token stays, but no test in the project checks that.

## 7. Part 4: Surviving an Auth Server Outage (Optional)

This part is optional. The rule: when the server is down, keep returning the old token until it really expires, with no margin, and try again on the next call. With no valid token, throw `IllegalStateException` with the `AuthUnavailableException` as its cause. `Part4AuthServerDownTest` checks it.

The renewal line from Part 3 is wrapped in a `try`:

```java
try {
    token = renew();
} catch (AuthUnavailableException e) {
    if (token == null || now >= token.expiresAt()) {
        throw new IllegalStateException(
                "no valid token: auth server unavailable", e);
    }
    // Still valid, only inside the margin: use it and try
    // the server again on the next call.
}
```

The `catch` asks the second question from our timeline: has the token really expired? With the margin in it, every failure would throw, and the 30 seconds would buy nothing.

`token == null` covers a first login that fails. The `catch` sets no flag: storing nothing is what makes the next call try again.

Here are two runs of the Part 4 code:

```
Run A: down at the start of the margin, then 1 ms before expiry
t=0 getToken() -> a1   auth log [login]
t=3570000 getToken() -> a1   auth log [login, refresh r1 (down)]
t=3599999 getToken() -> a1   auth log [login, refresh r1 (down), refresh r1 (down)]
t=3599999 getToken() -> a2   auth log [login, refresh r1 (down), refresh r1 (down), refresh r1]
Run B: down at the expiry
t=0 getToken() -> a1   auth log [login]
t=3600000 getToken() -> IllegalStateException (cause AuthUnavailableException)   auth log [login, refresh r1 (down)]
t=3600000 getToken() -> a2   auth log [login, refresh r1 (down), refresh r1]
```

At 3,599,999 `a1` still works. At 3,600,000 it's dead, and returning it would only move the failure to the partner API.

## 8. Part 5: One Renewal for Many Threads (Optional)

This part is optional too. The rule: a hundred threads that find the token due for renewal at once cause one call to the auth server, and all get the new token. Each manager has its own lock. `Part5OneRenewalForManyThreadsTest` checks it.

The change is one word on the method:

```java
// One lock around check and renew: the first caller renews while
// the rest wait, then find the new token. A reader of a valid
// token holds the lock only for one comparison.
/** Returns an access token that is valid now. */
synchronized String getToken() {
```

**The lock has to cover the check, the renewal and the write together.** The fault is a hundred threads passing the check before any has renewed. With one lock, the first thread refreshes and stores `a2`, and each waiter then runs the same check, finds a fresh token and makes no call.

Here is the Part 5 code with a hundred threads and the auth call held open:

```
100 threads at t=3600000
  while the auth call is held: thread states {BLOCKED=99, TIMED_WAITING=1}   auth log [login]
  outcomes {a2=100}   auth log [login, refresh r1]
```

`BLOCKED` is a thread waiting for the manager's lock, and `TIMED_WAITING` is the one inside the auth call. The Part 4 code, which has no lock, gave this on the same run:

```
100 threads at t=3600000
  while the auth call is held: thread states {TIMED_WAITING=100}   auth log [login]
  outcomes 100 different outcomes   auth log [login, refresh r1, refresh r1, refresh r1, refresh r1, refr... (101 calls)
```

All hundred are inside the server at once. `synchronized` on an instance method locks this manager only, which `Part5OneRenewalForManyThreadsTest.eachManagerHasItsOwnLock` checks. The price is a lock held across a network call, and no test measures how long a caller waits.

## 9. Common Mistakes

These are the mistakes the tests are built to catch:

- Writing `>` in place of `>=` at the margin. `Part2RenewBeforeExpiryTest.replacedExactlyAtTheMargin` expects `a2` at 3,570,000 and gets `a1`.
- Catching every exception for the fallback login. `Part3RefreshThenLoginTest.serverDownIsNotTreatedAsRefused` then sees `[login, refresh r1 (down), login]`.
- Clearing the token when a renewal fails. `Part3RefreshThenLoginTest.failedRefreshKeepsTheOldTokenForTheRetry` expects the retry to be `refresh r1` and sees a login.
- Putting the margin in the outage check. `Part4AuthServerDownTest.serverDownInsideTheMarginGivesTheOldToken` expects `a1` at 3,599,999 and gets `IllegalStateException`.
- Locking only the renewal. All hundred threads have already passed the check, and `Part5OneRenewalForManyThreadsTest.hundredThreadsOnAnExpiredTokenShareOneCall` reported `100 different outcomes` in our run.

## 10. What to Say Out Loud

In a pair-programming interview, the questions come before the code:

- "Does a token carry an expiry, and on whose clock? I'll assume milliseconds on ours."
- "Is there a refresh token, and what should callers get when the server is down?"
- "I'll log in on the first call, not in the constructor, and keep the whole record because I need its expiry next."
- "A token can expire on the wire, so I renew at expiry minus the margin, with greater-or-equal."
- "`renew()` returns the new token and I assign it in one place, so a failed call leaves the old one alone."
- "I log in again only when the refresh token is refused: if the server is down, a login fails too."

## 11. Taking It Further

None of these answers is built or tested in the project, and their figures are examples.

### 11.1. Is a Lock Across a Network Call Acceptable?

Here, yes: one word gives one renewal for a hundred threads. It needs a timeout on the auth call well under the 30-second margin, which this code doesn't set, or one hung call holds up every caller.

### 11.2. What Stops Us Hammering a Server That Is Down?

Today, nothing: once the token is due, every call makes one attempt. We'd store a next-attempt time that doubles up to a cap, and before it return the old token if it's alive or throw at once.

### 11.3. What Changes With Ten Instances of the Service?

Each instance renews for itself, ten times an hour in all. That breaks if the server keeps only the newest refresh token, as the fake here does: every renewal becomes a refused refresh and then a login. The token then belongs in a shared store.

### 11.4. What Would We Log and Measure?

Never either token: anyone reading the logs could call the partner as us, and a record's default `toString` prints every field. We'd count auth calls by kind and result, and alert once renewals have failed for ten seconds or so.

## 12. Conclusion

In this article, we built a token manager that caches one token, renews it 30 seconds before its expiry, and refreshes before it logs in, with optional parts for outages and threads. Three ideas are worth keeping: renew at `expiresAt - margin` with `>=`, read the time from a clock we're given, and write the token in one place from a call that succeeded. With those in place, an outage costs a `try` and a hundred threads cost one word.
