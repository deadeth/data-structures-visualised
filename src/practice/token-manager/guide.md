# Building a Token Manager in Plain Java

*This tutorial walks through building a complete token manager step by step. Back to the practice page: Token manager.*

---

## 1. Overview

In this tutorial, we'll build a token manager in plain Java 21: a small class that keeps one access token for a partner API. Whenever a caller asks, it hands back a token that is valid right now, and it calls the partner's auth server as rarely as it can.

We'll build the solution incrementally across five parts:

1. Logging in on the first call and keeping the token.
2. Renewing the token shortly before it expires.
3. Refreshing first, and logging in only when the refresh is refused.
4. Surviving an outage of the auth server *(optional stretch)*.
5. Sharing one renewal between a hundred threads *(optional stretch)*.

These five parts correspond directly to stages 1 through 5 of the practice page, and every test we name is a JUnit class and method from the practice project. Parts 1 to 3 are the core. By the end, we'll be able to write that core from memory and give the reason for each line.

---

## 2. The Problem

Our service calls a partner API that needs an access token on every request. Getting a token means a call to the partner's auth server, which is slow and rate limited. Our goal is to write one method, `getToken()`, that returns the access string of a token that is **valid right now**.

The starter supplies the token record and the auth server's interface:

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

Notice that neither exception is checked. Deciding which one we catch is most of Parts 3 and 4.

We're also given `Clock`, whose one method `nowMillis()` is our only source of time, and `FakeAuthApi`, which stands in for the auth server. The fake issues `a1`, `a2` and so on with refresh tokens `r1`, `r2`, each valid for one hour (3,600,000 ms). Only the latest refresh token works, and `log()` lists every call, such as `[login, refresh r1 (down)]`.

Let's review the exact requirements:

* **First login:** We log in on the first call to `getToken()`, not in the constructor.
* **Keeping the token:** We use a token until the clock reaches `expiresAt - margin`. The margin is 30,000 ms unless the constructor is given another.
* **Renewal:** At that moment or later, we renew. We call `refresh()` with the token's refresh token, and if that is refused, we log in.
* **One token for each manager:** Each manager keeps its own token.

For simplicity, we assume one instance of the service and one set of credentials. The starter's statement gives this example, with the default margin:

```text
t = 0          getToken() -> a1, expires at 3,600,000   [login]
t = 3,569,999  getToken() -> a1, no call
t = 3,570,000  getToken() -> a2                [login, refresh r1]
```

The boundary is 3,600,000 - 30,000 = 3,570,000: one millisecond before it we still hand out `a1`, and at it we renew.

---

## 3. The Design

The manager's state is a single field: the whole `Token` record, where `null` means that we have never fetched one.

Here is the life of one token, with the default margin:

```text
t = 0                     3,570,000               3,600,000
|-------------------------|-----------------------|----------->
issued                    margin starts           expiry

  use a1, no call           renew now; if that      a1 is dead:
                            fails, a1 still works   renew or throw
```

Two times matter on this line:

* **The margin start (3,570,000):** This says when to begin renewing.
* **The expiry (3,600,000):** This says when the token is dead.

Parts 2 and 3 use only the first, while Part 4 needs the second.

**We write the token field in one place, and only with the result of a call that succeeded.** Why be so strict? Because a failed renewal then leaves the old token and its refresh token alone, and the next call simply tries again.

For simplicity, we renew on the caller's thread, with no background task, and we trust `expiresAt` to be on our own clock.

---

## 4. Part 1: Logging In Once and Keeping the Token

In Part 1, we log in on the first call and keep the token, so that later calls return it without reaching the auth server. This behaviour is verified by `Part1LogInOnceAndKeepTest`.

For now, the manager keeps two things:

```java
private final AuthApi auth;
private Token token;
```

Why keep the whole record when `getToken()` hands back only the access string? Because Part 2 needs its `expiresAt` and Part 3 its `refreshToken`. Notice also that `token` is an instance field. A `static` one would share a single token between every manager, and `eachManagerKeepsItsOwnToken` would fail.

The constructor stores the auth server and does nothing else:

```java
TokenManager(AuthApi auth, Clock clock, long marginMillis) {
    this.auth = auth;
}
```

A login here would be a network call inside object construction. By waiting for the first call, we make sure that a login which fails does so where a token is needed. `constructorMakesNoCall` checks this: it builds two managers and expects an empty log.

The first version of `getToken()` is a null check:

```java
String getToken() {
    if (token == null) {
        token = auth.login();
    }
    return token.authToken();
}
```

After that first login, every later call finds the token and returns its access string without reaching the server (`laterCallsReuseTheToken`).

What this version gets wrong shows as soon as the clock moves. Here is a run of the Part 1 code:

| Time | Call | Returned | Auth Log After |
| --- | --- | --- | --- |
| `0` | `getToken()` | `a1` | `[login]` |
| `3600001` | `getToken()` | `a1` | `[login]` |

The second row hands out `a1` one millisecond after it expired, because nothing in this code ever looks at the clock.

---

## 5. Part 2: Renewing Before Expiry

Next, we replace a token that has expired, or that will within the margin, so that no request in flight carries a dead token. `Part2RenewBeforeExpiryTest` verifies this part.

The constructor now keeps the clock and the margin, in two new `final` fields:

```java
TokenManager(AuthApi auth, Clock clock, long marginMillis) {
    this.auth = auth;
    this.clock = clock;
    this.marginMillis = marginMillis;
}
```

Notice that the clock is passed in, which lets a test stand at `3569999` and then at `3570000` without sleeping.

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

**The whole part is one comparison: `now >= token.expiresAt() - marginMillis`.** Two details are worth highlighting here:

* **Boundary operator (`>=`):** We use `>=` because `expiresAt` is the moment the token stops working. With `>` and a margin of 0, we'd hand out a token in the very millisecond it died (`marginOfZeroKeepsTheTokenToItsExpiry`).
* **One clock read:** We read the clock once, into `now`, because Part 4 makes a second comparison that must see the same time.

The starter's `main` makes four calls. With the Part 2 code, it prints:

| Time | Call | Returned | Auth Log After |
| --- | --- | --- | --- |
| `0` | `getToken()` | `a1` | `[login]` |
| `0` | `getToken()` | `a1` | `[login]` |
| `3569999` | `getToken()` | `a1` | `[login]` |
| `3570000` | `getToken()` | `a2` | `[login, login]` |

The boundary is one millisecond wide: `keptUntilOneMsBeforeTheMargin` and `replacedExactlyAtTheMargin` stand on either side of it. Notice too that the renewal in the last row is still a full `login`, which Part 3 changes.

---

## 6. Part 3: Refreshing First, Then Logging In

In Part 3, we stop logging in every hour. We renew with `refresh()`, and we log in only if the server refuses the refresh token. A renewal that fails must break nothing: the old token and its refresh token stay, so that the next call refreshes. `Part3RefreshThenLoginTest` verifies this part. For now, a server-down exception may pass through to the caller.

### 6.1. One Assignment

In `getToken()`, one line changes inside the same condition:

```java
if (token == null || now >= token.expiresAt() - marginMillis) {
    token = renew();
}
```

Why does such a small change matter? Because Java runs the right-hand side before it assigns. If `renew()` throws, the assignment never happens, and `a1` and `r1` are exactly where they were.

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

Notice that `renew()` returns the new token, never touches the field, and catches one exception only.

**"Refused" and "server down" are different failures, and a login cures only the first.** Let's take them in turn:

* **Refused (`RefreshRejectedException`):** The server answered, and this refresh token is dead, so we log in.
* **Down (`AuthUnavailableException`):** The server didn't answer. A login would go to the same server, so we let this exception leave `renew()` uncaught.

Two simpler versions would each get this wrong. Catching every exception would send a login to a server that is down (`serverDownIsNotTreatedAsRefused`). Clearing the field on a failure would throw away `r1`, so the retry would be a login too (`failedRefreshKeepsTheOldTokenForTheRetry`).

### 6.3. A Traced Run

Let's run the Part 3 code three ways. Run A is a plain renewal. In run B another manager has logged in, so `r1` is stale. In run C the server is down for one call. A `-` marks a value that the run did not print:

| Run | Time | Call | Returned | Auth Log After |
| --- | --- | --- | --- | --- |
| A | `0` | `getToken()` | `a1` | `[login]` |
| A | `3570000` | `getToken()` | `a2` | `[login, refresh r1]` |
| A | `7140000` | `getToken()` | `a3` | `[login, refresh r1, refresh r2]` |
| B | `0` | `getToken()` | `a1` | `[login]` |
| B | `-` | a second manager logs in | `-` | `[login, login]` |
| B | `3570000` | `getToken()` | `a3` | `[login, login, refresh r1 (refused), login]` |
| C | `0` | `getToken()` | `a1` | `[login]` |
| C | `3570000` | `getToken()` | `AuthUnavailableException` | `[login, refresh r1 (down)]` |
| C | `3570000` | `getToken()` | `a2` | `[login, refresh r1 (down), refresh r1]` |

In run B, the refused refresh is followed by one login. In run C, the retry is `refresh r1`, not `login`: the failed call left `a1` and `r1` in place.

### 6.4. A Gap in the Tests

One sequence has no test: a refused refresh followed by a fallback login that fails. The supplied fake can't produce it, because it fails the next call, whichever call that is, so the refresh fails as "down" before it can be refused.

Reading the code, the login's exception leaves `renew()`, nothing is assigned, and the old token stays. No test in the project checks that, however.

---

## 7. Part 4: Surviving an Auth Server Outage (Optional Stretch)

This part is optional. When the auth server is down, we keep returning the old token until it really expires, with no margin, and we try again on the next call. Once there is no valid token left to give, we throw `IllegalStateException` with the `AuthUnavailableException` as its cause. `Part4AuthServerDownTest` verifies this part.

The renewal line from Part 3 is now wrapped in a `try`:

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

The `catch` asks the second question from our timeline: has the token really expired? Three details are worth highlighting here:

* **No margin in the check:** We compare `now` with `token.expiresAt()` alone. With the margin in it, every failure would throw, and the 30 seconds would buy nothing (`serverDownInsideTheMarginGivesTheOldToken`).
* **The null check:** `token == null` covers a first login that fails, when there is no old token to fall back on. Without it, the comparison itself throws a `NullPointerException` (`failedFirstLoginThrowsAndIsNotKept`).
* **No flag:** The `catch` records nothing about the failure. Storing nothing is what makes the next call try again.

Here are two runs of the Part 4 code. In run A the server is down at the start of the margin, and then again 1 ms before the expiry. In run B it is down at the expiry:

| Run | Time | Call | Returned | Auth Log After |
| --- | --- | --- | --- | --- |
| A | `0` | `getToken()` | `a1` | `[login]` |
| A | `3570000` | `getToken()` | `a1` | `[login, refresh r1 (down)]` |
| A | `3599999` | `getToken()` | `a1` | `[login, refresh r1 (down), refresh r1 (down)]` |
| A | `3599999` | `getToken()` | `a2` | `[login, refresh r1 (down), refresh r1 (down), refresh r1]` |
| B | `0` | `getToken()` | `a1` | `[login]` |
| B | `3600000` | `getToken()` | `IllegalStateException (cause AuthUnavailableException)` | `[login, refresh r1 (down)]` |
| B | `3600000` | `getToken()` | `a2` | `[login, refresh r1 (down), refresh r1]` |

At `3599999`, `a1` still works, so we return it. At `3600000` it's dead, and returning it would only move the failure to the partner API, so we throw (`serverDownAtExpiryThrows`).

---

## 8. Part 5: One Renewal for Many Threads (Optional Stretch)

This part is optional too. When a hundred threads find the token due for renewal at once, we want them to cause one call to the auth server, and all of them to get the new token. Each manager has its own lock. `Part5OneRenewalForManyThreadsTest` verifies this part.

The change is one word on the method:

```java
// One lock around check and renew: the first caller renews while
// the rest wait, then find the new token. A reader of a valid
// token holds the lock only for one comparison.
/** Returns an access token that is valid now. */
synchronized String getToken() {
```

**The lock has to cover the check, the renewal and the write together.** Why all three? Because the fault is a hundred threads passing the check before any of them has renewed. With one lock around the whole method, the first thread refreshes and stores `a2`, and each waiter then runs the same check, finds a fresh token and makes no call.

Here is the Part 5 code with a hundred threads and the auth call held open. Below it is the Part 4 code, which has no lock, on the same run:

| Code | Time | Moment | The 100 Threads | Auth Log |
| --- | --- | --- | --- | --- |
| Part 5 | `3600000` | while the auth call is held | thread states `{BLOCKED=99, TIMED_WAITING=1}` | `[login]` |
| Part 5 | `3600000` | at the end of the run | outcomes `{a2=100}` | `[login, refresh r1]` |
| Part 4, no lock | `3600000` | while the auth call is held | thread states `{TIMED_WAITING=100}` | `[login]` |
| Part 4, no lock | `3600000` | at the end of the run | outcomes `100 different outcomes` | `[login, refresh r1, refresh r1, refresh r1, refresh r1, refr... (101 calls)` |

`BLOCKED` is a thread waiting for the manager's lock, and `TIMED_WAITING` is the one inside the auth call. With the lock, one thread is inside the server while 99 wait, and the log gains a single line. Without it, all hundred are inside the server at once, and the log, which the run cut short, holds 101 calls.

`synchronized` on an instance method locks this manager only, which `eachManagerHasItsOwnLock` checks. The price is a lock held across a network call, and no test measures how long a caller waits.

---

## 9. Common Mistakes

Each of the following mistakes breaks a specific test:

1. **Using `>` instead of `>=` at the margin:** The call at `3570000` gets `a1` where `a2` is expected, failing `Part2RenewBeforeExpiryTest.replacedExactlyAtTheMargin`.
2. **Catching every exception for the fallback login:** A server that is down is sent a login too, so the log reads `[login, refresh r1 (down), login]`, failing `Part3RefreshThenLoginTest.serverDownIsNotTreatedAsRefused`.
3. **Clearing the token when a renewal fails:** The retry is a login where `refresh r1` is expected, failing `Part3RefreshThenLoginTest.failedRefreshKeepsTheOldTokenForTheRetry`.
4. **Putting the margin in the outage check:** The call at `3599999` gets `IllegalStateException` where `a1` is expected, failing `Part4AuthServerDownTest.serverDownInsideTheMarginGivesTheOldToken`.
5. **Locking only the renewal:** All hundred threads have already passed the check, so the test reports a line such as `100 different outcomes` (the count varies from run to run), failing `Part5OneRenewalForManyThreadsTest.hundredThreadsOnAnExpiredTokenShareOneCall`.

---

## 10. What to Say Out Loud

If you're implementing this in a pair-programming interview, the questions come before the code. Here are two questions to ask first, followed by four design points to explain as you type:

* *"Does a token carry an expiry, and on whose clock? I'll assume milliseconds on ours."*
* *"Is there a refresh token, and what should callers get when the server is down?"*
* *"I'll log in on the first call, not in the constructor, and keep the whole record because I need its expiry next."*
* *"A token can expire on the wire, so I'll renew at expiry minus the margin, with greater-or-equal."*
* *"`renew()` returns the new token and I'll assign it in one place, so a failed call leaves the old one alone."*
* *"I'll log in again only when the refresh token is refused: if the server is down, a login fails too."*

---

## 11. Taking It Further

Here are four questions about production use. None of these answers is built or tested in the project, and their figures are examples.

### 11.1. Is a Lock Across a Network Call Acceptable?

Here, yes: one word gives us one renewal for a hundred threads. It does need a timeout on the auth call well under the 30-second margin, which this code doesn't set. Without one, a single hung call holds up every caller.

### 11.2. What Stops Us Hammering a Server That Is Down?

Today, nothing: once the token is due, every call makes one attempt. To fix that, we'd store a next-attempt time that doubles up to a cap. Before that time, we'd return the old token if it's alive, or throw at once if it isn't.

### 11.3. What Changes With Ten Instances of the Service?

Each instance renews for itself, which makes ten renewals an hour in all. That breaks if the server keeps only the newest refresh token, as the fake here does: every renewal becomes a refused refresh and then a login. In that case, the token belongs in a shared store.

### 11.4. What Would We Log and Measure?

We'd never log either token: anyone reading the logs could call the partner as us, and a record's default `toString` prints every field. Instead, we'd count auth calls by kind and result, and alert once renewals have failed for ten seconds or so.

---

## 12. Conclusion

In this tutorial, we built a token manager that caches one token, renews it 30 seconds before its expiry, and refreshes before it logs in, with optional parts for outages and threads. The core takeaways from Parts 1 through 3 are renewing at `expiresAt - margin` with `>=`, reading the time from a clock we're given, and writing the token in one place from a call that succeeded. With those three ideas in place, an outage costs a `try` and a hundred threads cost one word.
