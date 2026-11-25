# Building a Rate Limiter in Plain Java

*This tutorial walks through building a complete in-process rate limiter step by step. Back to the practice page: Rate limiter.*

---

## 1. Overview

In this tutorial, we'll build an in-process rate limiter in plain Java 21: a single class that tells a gateway whether a request to a service may go ahead now. When a service has already had its share, the limiter refuses the next request until an earlier one has stopped counting.

We'll build the solution incrementally across five parts:

1. Counting requests in fixed windows, with one rule for every service.
2. Giving each service its own limit, and rejecting a missing name.
3. Replacing the count with a sliding log, which refuses a burst across a window edge.
4. Telling a refused caller when to come back *(optional stretch)*.
5. Making the limiter thread-safe and evicting idle services *(optional stretch)*.

These five parts are stages 1 to 5 of the practice page, and every test we name is a JUnit class and method from the practice project. By the end, we'll be able to write the core (Parts 1 to 3) from memory and justify each comparison in it.

---

## 2. The Problem

Suppose a gateway sits in front of several internal services, and each can take only so many requests. Our job is to write one method, `boolean allow(String service)`, that says whether a request to that service may go ahead right now. The first rule is the same for everyone: **at most 3 requests in any 10 seconds**.

Let's review the exact requirements:

* **Separate counts:** Each service is counted on its own.
* **Refused requests:** A refused request does not count against the limit.
* **The window edge:** A request made *exactly* one window ago has left the window. With a 10,000 ms window, a request at 0 no longer counts at 10,000.
* **Unknown services:** A service never seen before needs no registration and gets the default limit.

The starter project provides a `Clock`, a `FakeClock` that the tests move by hand, and an empty `RateLimiter` with five stubs that throw. It also supplies the limit itself, as a record:

```java
record Limit(int maxRequests, long windowMillis) {
    Limit {
        if (maxRequests < 1 || windowMillis < 1) {
            throw new IllegalArgumentException("limit must be positive");
        }
    }
}
```

Because the record refuses anything below 1, we never have to validate a limit ourselves. We also read the time only through the clock, which is what lets a test compare 9,999 with 10,000 without sleeping.

Here is the statement's example, with a limit of 3 requests per 10,000 ms and every request going to `orders`:

```text
at 0, 0, 0     allowed, allowed, allowed
at 9,999       refused (3 already in this window)
at 10,000      allowed (the requests at 0 have left)
```

Finally, we may assume one process, and that time never goes backwards.

---

## 3. The Design

Before any code, notice that "any 10 seconds" can be read in two ways:

* **Fixed blocks:** The clock is cut into blocks, 0 to 9,999 and then 10,000 to 19,999, with one count for each service that starts again in every block.
* **Any span:** The limit holds over any span of 10 seconds, wherever it starts.

Fixed blocks break the second reading at their edges. Here are six requests between 9,000 and 11,000, where `x` is allowed and `.` is refused:

```text
time (ms)   0                    10,000              20,000
fixed       |------ window 0 ------|------ window 1 ------|
requests                     x x x x x x
                             3 + 3, so all 6 are allowed

sliding         (--- last 10,000 ms ---]
requests                     x x x . . .
                             3 allowed, then 3 refused
```

Each fixed window sees only 3 of the six requests, so all six pass within 2 seconds. The sliding span is drawn as the sixth request finds it: already holding three. Note that the picture is not to scale.

Why isn't a count enough for the second reading? Because a count can't tell us how far apart requests are, so the final design keeps the time of every allowed request. This is the sliding log. Time only moves forwards, so new times join at the back and old ones leave from the front, and the size of what remains is the count.

Each design settles its window edge in a single line, and both agree that a request made at 0 no longer counts at 10,000:

```text
Fixed window:  window number = now / windowMillis, rounded down
Sliding log:   a time has left when  time <= now - windowMillis
```

We'll still start with the fixed window, because it is quick to write and gives us a working baseline to change.

---

## 4. Part 1: A Limit per Window

In Part 1, we'll apply one rule to every service, counted in fixed windows: the window number is the time divided by the window length, and each new window starts again from zero. `Part1FixedWindowTest` verifies this behaviour.

### 4.1. The State

The starter's constructor keeps nothing, so we begin with the fields:

```java
private final Clock clock;
private final Limit defaultLimit;
private final Map<String, Window> windows = new HashMap<>();

/** How many requests were allowed in window number `number`. */
private record Window(long number, int count) {}
```

For each service we store a pair: a window number and the count for that window. The constructor only has to assign `clock` and `defaultLimit`.

### 4.2. Counting Without a Reset

With the state in place, this is `allow` at the end of Part 1:

```java
boolean allow(String service) {
    long number = clock.millis() / defaultLimit.windowMillis();
    Window window = windows.get(service);
    // A window from an earlier number is over: start again at 0.
    int count = window != null && window.number() == number
            ? window.count() : 0;
    if (count >= defaultLimit.maxRequests()) {
        return false;
    }
    windows.put(service, new Window(number, count + 1));
    return true;
}
```

Notice that nothing ever resets a counter. A stored pair with a different number belongs to a finished window, so its count simply reads as 0. A `windowStart` field with a reset step would add a second boundary to get wrong.

Two details are worth highlighting here (the tests write `y` for a request allowed and `n` for one refused):

* **Rounding down:** `long` division rounds down, so 9,999 is window 0 and 10,000 is window 1. `refusedUntilTheWindowEnds` stands at 9,999 and `countStartsAgainAtTheWindowEdge` at 10,000.
* **Refusing on `>=`:** The fourth request finds a count of 3, so we refuse once the count has reached the limit. Using `>` would let it through, causing `fourthRequestInAWindowIsRefused` to get `yyyy` instead of `yyyn`.

Let's trace the Part 1 code across the window edge. The last column is the stored pair, as (window number, count):

| Time (ms) | Window | Count Before | Result | Stored After |
| --- | --- | --- | --- | --- |
| `0` | `0` | `0` | allowed | `(0, 1)` |
| `0` | `0` | `1` | allowed | `(0, 2)` |
| `0` | `0` | `2` | allowed | `(0, 3)` |
| `9,999` | `0` | `3` | refused | `(0, 3)` |
| `10,000` | `1` | `0` | allowed | `(1, 1)` |
| `10,000` | `1` | `1` | allowed | `(1, 2)` |
| `10,000` | `1` | `2` | allowed | `(1, 3)` |
| `10,000` | `1` | `3` | refused | `(1, 3)` |

At 10,000 the stored pair is still `(0, 3)`, but its number is not 1, so the count reads 0 and three more requests pass. Notice also that a refusal stores nothing.

---

## 5. Part 2: Each Service's Own Limit

Part 2 adds `setLimit(service, limit)`: one service gets its own limit from its next call, and its count so far is kept. A null or blank name is the caller's bug, so it now throws `IllegalArgumentException`. `Part2OwnLimitsTest` checks both rules.

First, we add a second map:

```java
private final Map<String, Limit> limits = new HashMap<>();
```

It holds only the services that have been given their own limit. Next, we add two small helpers, one to read that map and one to check a name:

```java
private Limit limitFor(String service) {
    return limits.getOrDefault(service, defaultLimit);
}

// A request with no service name cannot be routed: the caller's bug.
private static void requireName(String service) {
    if (service == null || service.isBlank()) {
        throw new IllegalArgumentException("service name required");
    }
}
```

Two details are worth highlighting here:

* **No registration (`getOrDefault`):** An unknown service is simply absent from `limits`, so it gets `defaultLimit` (`otherServicesKeepTheDefault`).
* **Null before blank:** The null test has to come first. Written the other way round, `isBlank()` itself would throw `NullPointerException`, and `allowRejectsNull` expects `IllegalArgumentException`.

In Part 2, `allow` opens with both helpers:

```java
boolean allow(String service) {
    requireName(service);
    Limit limit = limitFor(service);
    long number = clock.millis() / limit.windowMillis();
```

The rest is Part 1's method, with `limit` in place of `defaultLimit`. Then `setLimit` only has to store what it is given:

```java
void setLimit(String service, Limit limit) {
    requireName(service);
    limits.put(service, Objects.requireNonNull(limit, "limit"));
}
```

Why is such a short method enough? Because the limit is read fresh on every call and never copied beside the count, a change applies on the very next call. Had we copied the limit into `Window`, `setLimit` would do nothing for a service already called (`aLoweredLimitAppliesOnTheNextCall`). Note also that no test passes a null limit, so the `requireNonNull` is our own caution.

This run of the Part 2 code follows `Part2OwnLimitsTest.aRaisedLimitAppliesOnTheNextCall`, with the clock at 0. A `-` marks the call that returns nothing:

| Call | Result |
| --- | --- |
| `allow("orders")` | allowed |
| `allow("orders")` | allowed |
| `allow("orders")` | allowed |
| `allow("orders")` | refused |
| `setLimit("orders", 5 per 10,000)` | `-` |
| `allow("orders")` | allowed |
| `allow("orders")` | allowed |
| `allow("orders")` | refused |

Three of the new five were already used, so only two more pass: the count survived the change of limit.

---

## 6. Part 3: The Sliding Log

In Part 3, we make the limit hold over any window: we count only the requests allowed in the last window length. `Part3SlidingLogTest` verifies this stage.

### 6.1. Seeing It Fail First

Before changing anything, we run the new tests on the Part 2 code, so that the problem shows up as a red test. `Part3SlidingLogTest.noBurstOfSixAcrossAWindowEdge` expects `yyynnn` and gets `yyyyyy`, which is exactly the burst from the picture in section 3.

### 6.2. The Log

The log replaces both the `windows` map and the `Window` record:

```java
/** Per service, the times of its allowed requests, oldest first. */
private final Map<String, Deque<Long>> logs = new HashMap<>();
```

Each log is an `ArrayDeque`, which keeps duplicates. A `TreeSet` would store three requests made in the same millisecond only once, so a fourth would be allowed (`Part1FixedWindowTest.fourthRequestInAWindowIsRefused`).

### 6.3. The Window Edge

Next, one helper drops the times that have left the window:

```java
// The window is (now - length, now]: a request made exactly one
// window ago has left it.
private static void dropExpired(Deque<Long> log, long now,
        Limit limit) {
    long cutoff = now - limit.windowMillis();
    while (!log.isEmpty() && log.peekFirst() <= cutoff) {
        log.pollFirst();
    }
}
```

Two details are worth highlighting here:

* **Boundary operator (`<=`):** The whole edge rule is this one comparison. At 10,000 the cutoff is 0, so a request logged at 0 goes. With `<` it would stay 1 ms too long, which `aSlotFreesExactlyOneWindowAfterItsRequest` is built to catch.
* **The empty check:** `!log.isEmpty()` guards `peekFirst()`, which returns `null` on an empty deque.

### 6.4. Check, Then Record

With the helper written, `allow` in Part 3 becomes:

```java
boolean allow(String service) {
    requireName(service);
    Limit limit = limitFor(service);
    long now = clock.millis();
    Deque<Long> log =
            logs.computeIfAbsent(service, s -> new ArrayDeque<>());
    dropExpired(log, now, limit);
    if (log.size() >= limit.maxRequests()) {
        // Not logged: a refused request must not hold a slot.
        return false;
    }
    log.addLast(now);
    return true;
}
```

Notice the order of the last two steps: the size test comes before `addLast`, so a refusal is never recorded. Adding first would let a client that retries in a loop keep its own log full for ever (`refusedRequestsAreNotCounted`).

Let's run the picture's six requests on the Part 3 code, followed by two later ones:

| Time (ms) | Cutoff | Result | Log After |
| --- | --- | --- | --- |
| `9,000` | `-1,000` | allowed | `[9000]` |
| `9,500` | `-500` | allowed | `[9000, 9500]` |
| `9,999` | `-1` | allowed | `[9000, 9500, 9999]` |
| `10,000` | `0` | refused | `[9000, 9500, 9999]` |
| `10,500` | `500` | refused | `[9000, 9500, 9999]` |
| `11,000` | `1,000` | refused | `[9000, 9500, 9999]` |
| `18,999` | `8,999` | refused | `[9000, 9500, 9999]` |
| `19,000` | `9,000` | allowed | `[9500, 9999, 19000]` |

The refusals leave the log exactly as it was. The slot taken at 9,000 is still held at 18,999 and frees at 19,000, one whole window after its request.

---

## 7. Part 4: When to Come Back (Optional Stretch)

Part 4 is an optional stretch. When we refuse, the gateway wants to tell the caller when to come back: `retryAfterMillis(service)` returns 0 if a request would be allowed now, otherwise how long until one would be. Asking must not use up a slot. `Part4RetryAfterTest` checks it.

The method starts like `allow`, with one difference:

```java
long retryAfterMillis(String service) {
    requireName(service);
    Limit limit = limitFor(service);
    long now = clock.millis();
    Deque<Long> log = logs.get(service);
    if (log == null) {
        return 0;
    }
```

We fetch the log with `get`, not `computeIfAbsent`, so that asking about an unknown service leaves no empty log behind. Part 4's own tests don't notice the difference, but `Part5ThreadsAndEvictionTest.askingAboutAnUnknownServiceTracksNothing` does.

The second half finds the request that is in the way:

```java
    dropExpired(log, now, limit);
    // Usually 1; more if the limit was lowered while the log was full.
    int mustLeave = log.size() - limit.maxRequests() + 1;
    if (mustLeave <= 0) {
        return 0;
    }
    // A slot frees when the mustLeave-th oldest request leaves.
    long blocker = log.stream().skip(mustLeave - 1).findFirst().get();
    return blocker + limit.windowMillis() - now;
}
```

Why not simply take the oldest time, add the window and subtract now? Because that sum is right only while the log holds exactly the limit. After a limit is lowered below the current count, more than one request must leave before one more fits, and `mustLeave` counts them.

In this run of the Part 4 code, requests are allowed at 0, 1,000 and 2,000, and then the limit is lowered to 2:

| Time (ms) | Call | Answer | Log After |
| --- | --- | --- | --- |
| `2,000` | `retryAfterMillis("orders")` | `9,000` | `[0, 1000, 2000]` |
| `10,000` | `allow("orders")` | refused | `[1000, 2000]` |
| `10,999` | `allow("orders")` | refused | `[1000, 2000]` |
| `11,000` | `allow("orders")` | allowed | `[2000, 11000]` |

Two requests must leave, so the blocker is 1,000 and the answer is 1,000 + 10,000 - 2,000 = 9,000. Waiting for the oldest alone would answer 8,000, and at 10,000 the request is still refused (`aLoweredLimitWaitsForEnoughRequestsToLeave`).

---

## 8. Part 5: Threads and Idle Services (Optional Stretch)

Part 5 is also an optional stretch. Many threads now call the limiter at once, and a service that goes quiet should not stay in memory for ever. `Part5ThreadsAndEvictionTest` checks it.

### 8.1. One Lock

We add `synchronized` to all five methods, which gives us one lock for the whole limiter. Two steps must each happen as one:

* **Check the size, then add:** In `allow`, no other thread may take the last slot between the size test and `addLast`.
* **Check for empty, then remove:** In `evictIdle`, no request may be logged between the test for an empty log and its removal.

A `ConcurrentHashMap` alone would not be enough, because it would leave the `ArrayDeque` inside it, and the check-then-add, unsafe.

### 8.2. Evicting Idle Services

`evictIdle()` drops the services with nothing left in their own window and returns how many it dropped:

```java
synchronized int evictIdle() {
    long now = clock.millis();
    int evicted = 0;
    for (var it = logs.entrySet().iterator(); it.hasNext(); ) {
        var entry = it.next();
        dropExpired(entry.getValue(), now, limitFor(entry.getKey()));
        if (entry.getValue().isEmpty()) {
            it.remove();
            evicted++;
        }
    }
    return evicted;
}
```

Two details are worth highlighting here:

* **Drop first, then test:** We drop expired times before testing for empty, because `allow` always leaves a log with something in it. Without that line, `idleServicesAreEvicted` finds nothing evicted and gets `0 2`, not `2 0`.
* **Logs, never limits:** Eviction touches `logs` and never `limits`. It forgets request times, not a limit set with `setLimit` (`evictionKeepsTheLimit`).

Finally, `trackedServices()` returns `logs.size()`.

In this run of the Part 5 code, `search` has its own limit of 1 per 1,000 ms:

| Time (ms) | Call | Answer | Tracked | Logs After |
| --- | --- | --- | --- | --- |
| `0` | `allow("search")` | allowed | `1` | search `[0]` |
| `0` | `allow("orders")` | allowed | `2` | orders `[0]`, search `[0]` |
| `999` | `evictIdle()` | `0` | `2` | orders `[0]`, search `[0]` |
| `1,000` | `evictIdle()` | `1` | `1` | orders `[0]` |
| `1,000` | `allow("search")` | allowed | `2` | orders `[0]`, search `[1000]` |
| `1,000` | `allow("search")` | refused | `2` | orders `[0]`, search `[1000]` |
| `10,000` | `evictIdle()` | `2` | `0` | (none) |

After its eviction at 1,000, `search` is allowed once and then refused, so its limit of 1 survived. Notice that `orders` keeps its own window until 10,000.

### 8.3. A Gap in the Tests

There is an important caveat: the thread tests can show a race, but they can't prove there is none. With `synchronized` taken off `evictIdle` alone, `Part5ThreadsAndEvictionTest.evictionDuringTrafficLosesNoRequest` failed in only 15 of 24 runs of the class, in one measurement on a 2-core machine. So we argue safety from the lock, not from a green run.

---

## 9. Common Mistakes

Each of the following mistakes, made on purpose in the reference implementation, broke a specific test:

1. **Recording a request before checking the size:** Refused requests then hold slots of their own, failing `Part3SlidingLogTest.refusedRequestsAreNotCounted`, which gets `yyynnnn`, not `yyynnny`.
2. **Using `<` instead of `<=` at the cutoff:** A request exactly one window old is still counted, failing `Part3SlidingLogTest.aSlotFreesExactlyOneWindowAfterItsRequest`, which gets `yyynnnyn`, not `yyynynny`.
3. **Clearing the count inside `setLimit`:** The service gets a fresh allowance whenever its limit is touched, failing `Part2OwnLimitsTest.aRaisedLimitAppliesOnTheNextCall`, which gets `yyynyyy`, not `yyynyyn`.
4. **Waiting only for the oldest request in `retryAfterMillis`:** After a limit is lowered the answer comes out too short, failing `Part4RetryAfterTest.aLoweredLimitWaitsForEnoughRequestsToLeave`, which gets `8000 ny`, not `9000 ny`.
5. **Removing a service's limit when evicting it:** The service comes back on the default limit, failing `Part5ThreadsAndEvictionTest.evictionKeepsTheLimit`, which gets `yy`, not `yn`.

---

## 10. What to Say Out Loud

If you're writing this in a pair-programming interview, it helps to settle the gaps in the statement first and then narrate each main choice. Here are three questions to ask before any code, followed by three design points to explain as you type:

* *"Does 'any 10 seconds' slide, or does it mean fixed blocks on the clock? I'll start with fixed blocks, knowing that they let 6 through across an edge."*
* *"Does a refused request count against the limit? I'll assume not, because the limit is on work sent to the service."*
* *"Is a request exactly 10,000 ms old still in the window? I'll assume it has left."*
* *"I'll keep a window number beside each count, so a stale count is simply ignored and I never have to write a reset."*
* *"A limit is configuration, so I'll give it its own map and read it on every call."*
* *"A count can't see that six requests are 2 seconds apart, so I'll keep the time of each allowed request."*

---

## 11. Taking It Further

If the conversation moves on to production use, here are four questions to be ready for.

### 11.1. What Changes With Four Instances?

Each instance counts only its own traffic, so four of them let through four times the limit. We'd move the logs to a shared store and do the drop, the count and the add as one atomic step, which costs a round trip on every request.

### 11.2. Why Not a Token Bucket?

The statement is a count: at most 3 in any 10 seconds. A token bucket promises something different, a rate with a burst on top. A bucket of 3 refilled at 3 per 10 seconds would allow a fourth request 3,334 ms after a burst of three.

### 11.3. Does the Log Still Work With Large Limits?

The log stores one time for each allowed request, so 10,000 a minute for each of 10,000 clients is 100 million stored times at full use. Past that point we'd move to a sliding window counter, which estimates from two counts and gives up exactness.

### 11.4. What Is Missing Before Production?

Something has to call `evictIdle`: here only the tests do. A limit can't be removed once it is set, and a limit of 0, to block a service, can't be expressed because `Limit` refuses it. In production we'd reach first for a library such as Resilience4j or Bucket4j.

---

## 12. Conclusion

In this tutorial, we built a rate limiter in five parts, from a fixed window to a sliding log with a lock and eviction. The core takeaways are injecting the clock so that a test can stand on the exact edge, checking before we record so that a refusal costs nothing, and keeping limits apart from request times so that changing or evicting one never disturbs the other. Finally, when we add threads, one lock makes each check and its update a single step.
