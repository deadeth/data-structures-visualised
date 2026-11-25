# Building a Rate Limiter in Plain Java

## 1. Overview

In this tutorial, we'll build an in-process rate limiter in plain Java 21: one class that tells a gateway whether a request to a service may go ahead now.

We'll build it in five parts. Parts 1 to 3 are the core: a limit per fixed window, each service's own limit, and a sliding log that refuses a burst across a window edge. Parts 4 and 5 are optional: a retry hint, then thread safety and evicting idle services.

These parts are the practice page's stages 1 to 5. Every test we name is a JUnit class and method from the practice project.

By the end, we'll be able to write the core from memory and justify each comparison in it.

## 2. The Problem

A gateway sits in front of several internal services, and each can take only so many requests. We write one method, `boolean allow(String service)`. The first rule is the same for everyone: at most 3 requests in any 10 seconds.

Four rules settle the details:

- Each service is counted on its own.
- A refused request does not count against the limit.
- A request made exactly one window ago has left the window: with a 10,000 ms window, a request at 0 no longer counts at 10,000.
- A service never seen before needs no registration and gets the default limit.

The starter supplies a `Clock`, a `FakeClock` that the tests move by hand, an empty `RateLimiter` with five stubs that throw, and the limit:

```java
record Limit(int maxRequests, long windowMillis) {
    Limit {
        if (maxRequests < 1 || windowMillis < 1) {
            throw new IllegalArgumentException("limit must be positive");
        }
    }
}
```

The record refuses anything below 1, so we never validate a limit. We read the time only through the clock, which lets a test compare 9,999 with 10,000 without sleeping.

Here is the statement's example, with every request to `orders`:

```
at 0, 0, 0     allowed, allowed, allowed
at 9,999       refused (3 already in this window)
at 10,000      allowed (the requests at 0 have left)
```

We may assume one process, and that time never goes backwards.

## 3. The Design

"Any 10 seconds" can be read two ways.

The first is fixed blocks on the clock: 0 to 9,999, then 10,000 to 19,999, with one count for each service that starts again in every block.

The second is any span of 10 seconds, wherever it starts. Fixed blocks break that reading at their edges. Here are six requests between 9,000 and 11,000, where `x` is allowed and `.` is refused:

```
time (ms)   0                    10,000              20,000
fixed       |------ window 0 ------|------ window 1 ------|
requests                     x x x x x x
                             3 + 3, so all 6 are allowed

sliding         (--- last 10,000 ms ---]
requests                     x x x . . .
                             3 allowed, then 3 refused
```

Each fixed window sees only 3 of the six, so all six pass within 2 seconds. The sliding span is drawn as the sixth request finds it: already holding three. The picture is not to scale.

**A count can't tell us how far apart requests are, so the final design keeps the time of every allowed request.** This is the sliding log. Time only moves forwards, so new times join at the back and old ones leave from the front; the size of what remains is the count.

We'll still start with the fixed window: it is quick to write and gives us a baseline.

## 4. Part 1: A Limit per Window

Part 1 is one rule for every service, counted in fixed windows. `Part1FixedWindowTest` checks it.

### 4.1. The State

The starter's constructor keeps nothing, so we begin with the fields:

```java
private final Clock clock;
private final Limit defaultLimit;
private final Map<String, Window> windows = new HashMap<>();

/** How many requests were allowed in window number `number`. */
private record Window(long number, int count) {}
```

For each service we store a pair: a window number and the count for that window. The constructor assigns `clock` and `defaultLimit`.

### 4.2. Counting Without a Reset

This is `allow` at the end of Part 1:

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

**Nothing ever resets a counter.** A stored pair with a different number belongs to a finished window, so its count reads as 0. A `windowStart` field with a reset step would add a second boundary to get wrong.

`long` division rounds down, so 9,999 is window 0 and 10,000 is window 1. We refuse on `>=`, because the fourth request finds a count of 3.

Let's trace the Part 1 code across the edge. The last column is the stored pair, as (window number, count):

```
time (ms) window  count before  result   stored after
0         0       0             allowed  (0, 1)
0         0       1             allowed  (0, 2)
0         0       2             allowed  (0, 3)
9,999     0       3             refused  (0, 3)
10,000    1       0             allowed  (1, 1)
10,000    1       1             allowed  (1, 2)
10,000    1       2             allowed  (1, 3)
10,000    1       3             refused  (1, 3)
```

At 10,000 the stored pair is still `(0, 3)`, but its number is not 1, so the count reads 0. A refusal stores nothing.

## 5. Part 2: Each Service's Own Limit

Part 2 adds `setLimit(service, limit)`: one service gets its own limit from its next call, and its count so far is kept. A null or blank name now throws `IllegalArgumentException`. `Part2OwnLimitsTest` checks both.

We add a second map:

```java
private final Map<String, Limit> limits = new HashMap<>();
```

It holds only the services given their own limit. Two helpers read it and check a name:

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

`getOrDefault` is why an unknown service needs no registration. The null test comes first, or `isBlank()` itself would throw `NullPointerException`.

In Part 2, `allow` opens with both helpers:

```java
boolean allow(String service) {
    requireName(service);
    Limit limit = limitFor(service);
    long number = clock.millis() / limit.windowMillis();
```

The rest is Part 1's method, with `limit` in place of `defaultLimit`. Then `setLimit` only stores:

```java
void setLimit(String service, Limit limit) {
    requireName(service);
    limits.put(service, Objects.requireNonNull(limit, "limit"));
}
```

**The limit is read fresh on every call and never copied beside the count**, so a change applies on the next call. Copying the limit into `Window` would make `setLimit` do nothing for a service already called. No test passes a null limit, so the `requireNonNull` is our own caution.

This run of the Part 2 code follows `Part2OwnLimitsTest.aRaisedLimitAppliesOnTheNextCall`, with the clock at 0:

```
allow("orders")                   allowed
allow("orders")                   allowed
allow("orders")                   allowed
allow("orders")                   refused
setLimit("orders", 5 per 10,000)
allow("orders")                   allowed
allow("orders")                   allowed
allow("orders")                   refused
```

Three of the new five were already used, so two more pass.

## 6. Part 3: The Sliding Log

Part 3 makes the limit hold over any window: we count only the requests allowed in the last window length. `Part3SlidingLogTest` checks it.

### 6.1. Seeing It Fail First

First we run the new tests on the Part 2 code. `Part3SlidingLogTest.noBurstOfSixAcrossAWindowEdge` expects `yyynnn` (y for allowed, n for refused) and gets `yyyyyy`: the burst from the picture.

### 6.2. The Log

The log replaces the `windows` map and the `Window` record:

```java
/** Per service, the times of its allowed requests, oldest first. */
private final Map<String, Deque<Long>> logs = new HashMap<>();
```

Each log is an `ArrayDeque`, which keeps duplicates. A `TreeSet` would store three requests in the same millisecond once.

### 6.3. The Window Edge

One helper drops the times that have left the window:

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

**The whole edge rule is the `<=`.** At 10,000 the cutoff is 0, so a request logged at 0 goes; with `<` it would stay 1 ms too long. `!log.isEmpty()` guards `peekFirst()`, which returns `null` on an empty deque.

### 6.4. Check, Then Record

In Part 3, `allow` becomes:

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

The size test comes before `addLast`, so a refusal is never recorded. Adding first would let a client that retries in a loop keep its log full for ever.

Let's run the picture's six requests on the Part 3 code, and two later ones:

```
time (ms) cutoff   result   log after
9,000     -1,000   allowed  [9000]
9,500     -500     allowed  [9000, 9500]
9,999     -1       allowed  [9000, 9500, 9999]
10,000    0        refused  [9000, 9500, 9999]
10,500    500      refused  [9000, 9500, 9999]
11,000    1,000    refused  [9000, 9500, 9999]
18,999    8,999    refused  [9000, 9500, 9999]
19,000    9,000    allowed  [9500, 9999, 19000]
```

The refusals leave the log as it was. The slot taken at 9,000 is still held at 18,999 and frees at 19,000.

## 7. Part 4: When to Come Back (Optional)

Part 4 is an optional stretch. `retryAfterMillis(service)` returns 0 if a request would be allowed now, otherwise how long until one would be. Asking must not use up a slot. `Part4RetryAfterTest` checks it.

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

We fetch with `get`, not `computeIfAbsent`, so asking about an unknown service leaves no empty log behind. Part 4's tests don't notice the difference; `Part5ThreadsAndEvictionTest.askingAboutAnUnknownServiceTracksNothing` does.

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

The oldest time plus the window minus now is right only while the log holds exactly the limit. **After a limit is lowered below the current count, more than one request must leave before one more fits.** `mustLeave` counts them.

In this run of the Part 4 code, requests are allowed at 0, 1,000 and 2,000, then the limit is lowered to 2:

```
time (ms) call                       answer   log after
2,000     retryAfterMillis("orders") 9,000    [0, 1000, 2000]
10,000    allow("orders")            refused  [1000, 2000]
10,999    allow("orders")            refused  [1000, 2000]
11,000    allow("orders")            allowed  [2000, 11000]
```

Two requests must leave, so the blocker is 1,000 and the answer is 1,000 + 10,000 - 2,000 = 9,000. Waiting for the oldest alone would answer 8,000, and at 10,000 the request is still refused.

## 8. Part 5: Threads and Idle Services (Optional)

Part 5 is also an optional stretch. `Part5ThreadsAndEvictionTest` checks it.

### 8.1. One Lock

We add `synchronized` to all five methods, which is one lock for the whole limiter. Two steps must each happen as one: check the size then add, and check for empty then remove. A `ConcurrentHashMap` alone would leave the `ArrayDeque` inside it and the check-then-add unsafe.

### 8.2. Evicting Idle Services

`evictIdle()` drops the services with nothing left in their own window and returns how many:

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

We drop expired times before testing for empty, because `allow` always leaves a log with something in it. **Eviction touches `logs` and never `limits`**: it forgets request times, not a limit set with `setLimit`. `trackedServices()` returns `logs.size()`.

In this run of the Part 5 code, `search` has its own limit of 1 per 1,000 ms:

```
time (ms) call             answer   tracked  logs after
0         allow("search")  allowed  1        search [0]
0         allow("orders")  allowed  2        orders [0]  search [0]
999       evictIdle()      0        2        orders [0]  search [0]
1,000     evictIdle()      1        1        orders [0]
1,000     allow("search")  allowed  2        orders [0]  search [1000]
1,000     allow("search")  refused  2        orders [0]  search [1000]
10,000    evictIdle()      2        0        (none)
```

After its eviction at 1,000, `search` is allowed once and then refused: its limit of 1 survived. `orders` keeps its own window until 10,000.

### 8.3. A Gap in the Tests

The thread tests can show a race, but they can't prove there is none. With `synchronized` taken off `evictIdle` alone, `Part5ThreadsAndEvictionTest.evictionDuringTrafficLosesNoRequest` failed in only 15 of 24 runs of the class, in one measurement on a 2-core machine. So we argue safety from the lock, not from a green run.

## 9. Common Mistakes

Each of these is caught by a named test:

1. Recording a request before checking the size. `Part3SlidingLogTest.refusedRequestsAreNotCounted` gets `yyynnnn`, not `yyynnny`.
2. Writing `<` for `<=` at the cutoff. `Part3SlidingLogTest.aSlotFreesExactlyOneWindowAfterItsRequest` gets `yyynnnyn`, not `yyynynny`.
3. Clearing the count inside `setLimit`. `Part2OwnLimitsTest.aRaisedLimitAppliesOnTheNextCall` gets `yyynyyy`, not `yyynyyn`.
4. Waiting only for the oldest request in `retryAfterMillis`. `Part4RetryAfterTest.aLoweredLimitWaitsForEnoughRequestsToLeave` gets `8000 ny`, not `9000 ny`.
5. Removing a service's limit when evicting it. `Part5ThreadsAndEvictionTest.evictionKeepsTheLimit` gets `yy`, not `yn`.

## 10. What to Say Out Loud

Three questions come before any code:

- "Does 'any 10 seconds' slide, or is it fixed blocks? I'll start with fixed blocks, knowing they let 6 through across an edge."
- "Does a refused request count? I'll assume not: the limit is on work sent to the service."
- "Is a request exactly 10,000 ms old still in the window? I'll assume it has left."

Then one sentence for each main choice:

- "A window number beside each count means a stale count is ignored and I never write a reset."
- "A limit is configuration, so it gets its own map and I read it on every call."
- "A count can't see that six requests are 2 seconds apart, so I keep each allowed request's time."

## 11. Taking It Further

### 11.1. What Changes With Four Instances?

Each instance counts only its own traffic, so four of them let through four times the limit. We'd move the logs to a shared store and do the drop, the count and the add as one atomic step, which costs a round trip on every request.

### 11.2. Why Not a Token Bucket?

The statement is a count: at most 3 in any 10 seconds. A token bucket promises a rate with a burst on top. A bucket of 3 refilled at 3 per 10 seconds would allow a fourth request 3,334 ms after a burst of three.

### 11.3. Does the Log Still Work With Large Limits?

The log stores one time for each allowed request, so 10,000 a minute for each of 10,000 clients is 100 million stored times at full use. Past that we'd move to a sliding window counter, which estimates from two counts and gives up exactness.

### 11.4. What Is Missing Before Production?

Something has to call `evictIdle`: here only the tests do. A limit can't be removed once set, and a limit of 0, to block a service, can't be expressed because `Limit` refuses it. In production we'd reach first for a library such as Resilience4j or Bucket4j.

## 12. Conclusion

In this article, we built a rate limiter in five parts, from a fixed window to a sliding log with a lock and eviction. We inject the clock so a test can stand on the exact edge. We check before we record, so a refusal costs nothing. And we keep limits apart from request times, so changing or evicting one never disturbs the other.
