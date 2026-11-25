# Building a Circuit Breaker in Plain Java

*This tutorial walks through building a complete circuit breaker step by step. Back to the practice page: Circuit breaker.*

---

## 1. Overview

In this tutorial, we'll build a circuit breaker around a lightweight web client using plain Java 21. When a downstream service starts failing repeatedly, the circuit breaker will temporarily stop sending requests to it, wait for a cooldown period, and then send a single trial request to check if the service has recovered.

We'll build the solution incrementally across five parts:

1. Counting failures in a sliding window and tripping the breaker.
2. Adding a cooldown period and a single trial request.
3. Isolating state with one breaker per downstream service.
4. Making the implementation thread-safe *(optional stretch)*.
5. Replaying historical request data where timestamps arrive as input *(optional variant)*.

These five parts correspond directly to stages 1 through 5 of the practice project, and the JUnit test methods referenced throughout match the test classes in that repository. By the end, we'll have a clean, interview-ready implementation of the core mechanics and a solid grasp of every boundary condition involved.

---

## 2. The Problem

Suppose Service A communicates with two downstream services, B and C, through a shared `WebClient`. Our goal is to implement `execute()` so that if a service fails **three times within ten minutes**, we stop calling it for the next **five minutes**.

Let's review the exact requirements:

* **What counts as a failure:** Any HTTP status of `500` or higher, or any exception thrown by the remote call. `4xx` responses are client errors and do not count as failures. If an exception is thrown, we record the failure and rethrow the exception unchanged.
* **Sliding window:** The ten-minute window slides continuously. A failure that is *exactly* ten minutes old no longer counts, and a successful call in between does not reset the failure history.
* **Blocked calls:** When the breaker is open, blocked calls never reach the remote service. They immediately return `Response.BLOCKED` (status `503` with the `blocked` flag set) and do not modify any breaker state.
* **Recovery trial:** Once five minutes or more have passed since opening (an *exact* five-minute elapsed time counts), a single call is allowed through as a trial. If it succeeds (i.e., is not a failure), the breaker closes and clears the old failure history. If it fails, the five-minute cooldown restarts from the time of the trial.

The starter project provides `Request`, `Response`, a simulated `Remote`, and a controllable `Clock` for deterministic testing. `WebClient` already defines `maxFailures` (`3`), `windowMillis` (`600000`), and `cooldownMillis` (`300000`). Since a few tests override these defaults, we'll always reference the fields rather than hardcoding values.

Here is how a sample sequence of calls to Service B behaves (with timestamps in milliseconds):

```text
     0  remote answers 500  ->  500 returned, 1 failure
     0  remote answers 500  ->  500 returned, 2 failures
     0  remote answers 500  ->  500 returned, 3 failures: open at 0
299999  remote not called   ->  BLOCKED
300000  remote answers 200  ->  200, the trial: closed, failures gone
300000  remote answers 200  ->  200

```

---

## 3. The Design

To keep the code modular, we'll encapsulate all state for a single downstream service inside a small inner class called `Breaker`. It exposes just two methods:

* `allow(now)` — decides whether a request is permitted to proceed.
* `record(now, failed)` — records the outcome of a request that was allowed through.

Notice that `Breaker` receives the current timestamp as a parameter instead of reading `Clock` directly. Keeping time as an explicit input makes the class easier to reason about—and makes Part 5 almost effortless.

Starting in Part 2, the breaker operates as a three-state machine:

```text
            third failure            first call 5 min or
            inside 10 min            more after opening
  CLOSED ------------------> OPEN ------------------------> HALF_OPEN
    ^                         ^                              |    |
    |                         +------- trial fails ----------+    |
    +------------------ trial is not a failure -------------------+

```

There is no background timer or scheduled task here. The transition from `OPEN` to `HALF_OPEN` happens lazily when a new request arrives and checks the elapsed time.

Both time-based rules compare an elapsed age using `>=`:

```text
Failure expires from window:  now - failureTime >= windowMillis
Next call becomes the trial:  now - openedAt    >= cooldownMillis

```

For simplicity, this breaker does not calculate failure percentages, does not enforce request timeouts (our simulated remote responds immediately), and runs in a single JVM process.

---

## 4. Part 1: Counting Failures

In Part 1, we'll allow calls through until three failures occur within the ten-minute window, at which point the breaker opens and stays open. This behavior is verified by `Part1CountAndTripTest`.

### 4.1. The Call Path

With a single `Breaker` stored in a field named `breaker`, our initial `execute()` method looks like this:

```java
public Response execute(Request request) {
    if (!breaker.allow()) {
        return Response.BLOCKED;
    }
    Response response;
    try {
        response = remote.call(request);
    } catch (RuntimeException e) {
        breaker.record(clock.millis(), true);
        throw e;
    }
    breaker.record(clock.millis(), response.status() >= 500);
    return response;
}

```

We check `breaker.allow()` before invoking `remote.call()`, ensuring blocked requests never hit the downstream service. If the remote throws a `RuntimeException`, we record the failure and rethrow the original exception untouched (verified by `exceptionRethrownUnchanged`).

Also, note the `>= 500` check. If we mistakenly used `>= 400`, three `404` responses caused by a single client's bad input would trip the breaker for everyone, causing `fourHundredsPassThrough` to fail.

### 4.2. The Sliding Window

Inside `Breaker`, we store the timestamps of recent failures in a `Deque` alongside a boolean flag:

```java
/** Times of recent failures, oldest first. */
private final Deque<Long> failures = new ArrayDeque<>();
private boolean open;

```

Why store timestamps instead of a simple integer counter? Because old failures must expire individually as time moves forward. With a plain counter, failures at minutes 0, 9, and 18 would add up to 3—even though no ten-minute window ever contained more than 2 failures (`windowSlides`).

Here is how `record()` maintains the sliding window:

```java
void record(long now, boolean failed) {
    if (!failed) {
        return;
    }
    failures.addLast(now);
    while (now - failures.peekFirst() >= windowMillis) {
        failures.removeFirst();
    }
    if (failures.size() >= maxFailures) {
        open = true;
    }
}

```

Two details are worth highlighting here:

* **Boundary operator (`>=`):** Using `>=` ensures a failure that is *exactly* `windowMillis` old is evicted before we check the size. Using `>` would keep it in the deque, causing `failureExactlyTenMinutesOldDropsOut` to return `BLOCKED` instead of `500`.
* **No reset on success:** Returning early when `!failed` leaves the deque intact. Clearing it on a success would turn the rule into "three failures in a row," which `successInBetweenResetsNothing` explicitly guards against.

Let's trace this logic with two failures at time `0`, followed by four calls at exactly ten minutes (`600000` ms). A `-` indicates the remote was not called:

| Time | Service | Remote | Returned | State After | Failure Times After |
| --- | --- | --- | --- | --- | --- |
| `0` | B | `500` | `500` | closed | `[0]` |
| `0` | B | `500` | `500` | closed | `[0, 0]` |
| `600000` | B | `500` | `500` | closed | `[600000]` |
| `600000` | B | `500` | `500` | closed | `[600000, 600000]` |
| `600000` | B | `500` | `500` | open | `[600000, 600000, 600000]` |
| `600000` | B | `-` | `BLOCKED` | open | `[600000, 600000, 600000]` |

At `600000`, both failures from time `0` are exactly `600000` ms old and drop out together, so it takes three fresh failures to trip the breaker. Had the third call arrived at `599999`, those earlier failures would still be inside the window (`failureJustInsideTheWindowCounts`).

---

## 5. Part 2: Cooling Down, Then One Trial

Next, let's add recovery logic: once five minutes have elapsed after opening, we allow a single trial call through. `Part2CooldownAndTrialTest` verifies this stage.

### 5.1. Three States

First, let's replace the `boolean open` flag with a `State` enum declared inside `WebClient`:

```java
private enum State { CLOSED, OPEN, HALF_OPEN }

```

Using an enum instead of two separate booleans prevents invalid state combinations. We also add a field to track when the breaker opened:

```java
private State state = State.CLOSED;
private long openedAt;

```

### 5.2. Choosing the Trial

Now `allow()` accepts the current timestamp so it can evaluate the cooldown:

```java
boolean allow(long now) {
    if (state == State.CLOSED) {
        return true;
    }
    if (state == State.OPEN && now - openedAt >= cooldownMillis) {
        state = State.HALF_OPEN;
        return true;
    }
    return false;
}

```

Notice that the breaker transitions to `HALF_OPEN` *inside* `allow()`, before the remote call even starts. Any subsequent call that arrives while the trial is in flight sees `HALF_OPEN` and is immediately rejected.

Again, the `>=` operator is critical: a call at `299999` is blocked, while a call at `300000` becomes the trial. Switching to `>` breaks ten of the thirteen tests in `Part2CooldownAndTrialTest`, including `trialAtExactlyFiveMinutesClosesOnSuccess`.

Finally, when `allow()` returns `false`, it modifies no state—ensuring blocked requests never accidentally reset the cooldown timer. We'll also update `execute()` to pass `clock.millis()` into `breaker.allow()`.

### 5.3. Handling the Trial Outcome

In `record()`, we add a `HALF_OPEN` branch at the top. The rest of the method remains identical to Part 1, except we replace `open = true` with a helper call `open(now)`:

```java
if (state == State.HALF_OPEN) {
    if (failed) {
        open(now);
    } else {
        state = State.CLOSED;
        failures.clear();
    }
    return;
}

```

If the trial succeeds, we close the breaker and clear the `failures` deque. Skipping `failures.clear()` introduces a subtle bug: the three failures that originally tripped the breaker might only be five minutes old (still within the ten-minute window), meaning a single new failure would immediately trip the breaker again (`recoveryForgetsEarlierFailures`).

If the trial fails, we call our `open(now)` helper:

```java
private void open(long now) {
    state = State.OPEN;
    openedAt = now;
}

```

Updating `openedAt` ensures the new five-minute cooldown starts from the failed trial rather than the original opening time. If we only reset `state` without updating `openedAt`, the old timestamp would already be past the cooldown, turning every subsequent request into another trial (`failedTrialOpensForAnotherCooldown`).

Let's trace a scenario where the first trial fails and the second succeeds:

| Time | Service | Remote | Returned | State After | Failure Times After |
| --- | --- | --- | --- | --- | --- |
| `0` | B | `500` | `500` | `CLOSED` | `[0]` |
| `0` | B | `500` | `500` | `CLOSED` | `[0, 0]` |
| `0` | B | `500` | `500` | `OPEN` since `0` | `[0, 0, 0]` |
| `299999` | B | `-` | `BLOCKED` | `OPEN` since `0` | `[0, 0, 0]` |
| `300000` | B | `500` | `500` | `OPEN` since `300000` | `[0, 0, 0]` |
| `599999` | B | `-` | `BLOCKED` | `OPEN` since `300000` | `[0, 0, 0]` |
| `600000` | B | `200` | `200` | `CLOSED` | `[]` |
| `600000` | B | `200` | `200` | `CLOSED` | `[]` |

Because the trial at `300000` fails and updates `openedAt`, the call at `599999` is still blocked. You'll notice `HALF_OPEN` never appears in the "State After" column—on a single thread, the trial's outcome is recorded before the next request begins.

---

## 6. Part 3: One Breaker for Each Service

In Part 3, we isolate downstream services so that failures in Service B don't block calls to Service C (`Part3PerServiceTest`).

Because all state already lives inside `Breaker`, the class itself doesn't need to change at all. We simply replace the single `breaker` field in `WebClient` with a `Map`:

```java
private final Map<String, Breaker> breakers = new HashMap<>();

```

Next, we add a small helper that looks up the breaker for a given service, creating and storing a new closed one if it doesn't exist yet:

```java
private Breaker breakerFor(String service) {
    return breakers.computeIfAbsent(service, s -> new Breaker());
}

```

Then we add a single line at the top of `execute()`:

```java
Breaker breaker = breakerFor(request.service());

```

Because the local variable shares the same name as the old field, the rest of `execute()` works without modification. Note that we key the map by `request.service()`, not the request path—all endpoints belonging to the same service share one breaker (`pathsOfOneServiceShareABreaker`).

---

## 7. Part 4: Many Threads (Optional Stretch)

In a real web client, multiple threads will call `execute()` concurrently. `Part4ThreadSafetyTest` exercises this scenario.

### 7.1. Lock the Decisions, Not the Remote Call

First, let's switch to a `ConcurrentHashMap`:

```java
private final Map<String, Breaker> breakers = new ConcurrentHashMap<>();

```

Using `computeIfAbsent()` on a `ConcurrentHashMap` guarantees that two threads requesting Service B for the first time will receive the exact same `Breaker` instance.

Next, we mark both `allow()` and `record()` as `synchronized`. Because the lock is on the individual `Breaker` instance, calls to Service B and Service C never contend with one another, and each state transition happens atomically.

Crucially, we do **not** synchronize `execute()` itself. Instead, `allow()` acquires and releases the lock, `remote.call()` executes completely lock-free, and `record()` acquires the lock again to update the state. If we held the lock across the network call, every thread calling that service—even threads that should be immediately rejected as `BLOCKED`—would pile up behind a slow remote response.

In fact, putting `synchronized` on `execute()` still counts failures accurately, but it causes `exactlyOneTrialAfterTheCooldown` and `slowCallDoesNotHoldUpTheNext` to fail because 19 threads that should return `BLOCKED` immediately end up waiting on the trial call.

Because `allow()` checks `OPEN` and transitions to `HALF_OPEN` inside a single synchronized block, only one thread can ever win the trial.

### 7.2. Handling Late-Arriving Responses

Releasing the lock during the remote call introduces a new edge case: the breaker's state can change while a request is still in flight. To handle this, we add a guard in `record()` right after the `HALF_OPEN` branch:

```java
// Ignore late answers from calls let through before it opened.
if (state != State.CLOSED || !failed) {
    return;
}

```

If a response arrives while the breaker is already `OPEN`, it must belong to a request that started before the breaker tripped. Without this guard, a late failure would reset `openedAt` and extend the cooldown (`lateFailureWhileOpenIsIgnored`).

### 7.3. What the Tests Don't Prove

There is an important caveat with concurrency testing: passing tests do not guarantee thread safety. Even after removing `synchronized` from `allow()`, running `Part4ThreadSafetyTest` 20 times on a 2-CPU machine (with each test repeated 10 times) produced 20 green runs.

Triggering the race requires two threads to read `OPEN` before either writes `HALF_OPEN`, which is rare under light contention. In an interview or code review, you have to justify that lock by reasoning about the interleaving, not just pointing at a green test suite.

---

## 8. Part 5: Time Arrives as Data (Optional Variant)

In Part 5, we add a `replay(lines)` method that processes log lines formatted as `timestampMillis service statusCode` and returns `ALLOWED`, `BLOCKED`, or `INVALID` for each line—without ever calling `remote` (`Part5ReplayTest`).

A helper method, `replayLine()`, validates that the line splits into exactly three tokens and that the first and third parse as numbers (returning `INVALID` otherwise). Once validated, it delegates directly to the breaker:

```java
Breaker breaker = breakerFor(parts[1]);
if (!breaker.allow(at)) {
    return "BLOCKED";
}
breaker.record(at, status >= 500);
return "ALLOWED";

```

Because `Breaker` takes the timestamp as an argument rather than reading `Clock`, `replayLine()` mirrors `execute()` almost line for line—swapping the clock for `at` and the remote call for `status`—without duplicating any circuit breaker logic.

Here is a trace of a sample replay run:

| Input Line | Result | B's State After | B's Failure Times After |
| --- | --- | --- | --- |
| `0 B 500` | `ALLOWED` | `CLOSED` | `[0]` |
| `60000 B 500` | `ALLOWED` | `CLOSED` | `[0, 60000]` |
| `600000 B 500` | `ALLOWED` | `CLOSED` | `[60000, 600000]` |
| `600001 B 500` | `ALLOWED` | `OPEN` since `600001` | `[60000, 600000, 600001]` |
| `900000 B 200` | `BLOCKED` | `OPEN` since `600001` | `[60000, 600000, 600001]` |
| `x B 500` | `INVALID` | `OPEN` since `600001` | `[60000, 600000, 600001]` |
| `900001 B 200` | `ALLOWED` | `CLOSED` | `[]` |
| `900002 B 500` | `ALLOWED` | `CLOSED` | `[900002]` |

Notice that the line that trips the breaker is itself `ALLOWED`, and the malformed line (`x B 500`) leaves the state untouched. Note also that `replay()` assumes the input lines are already sorted chronologically.

---

## 9. Common Mistakes

While building the reference implementation, each of the following mistakes broke a specific test:

1. **Using a plain counter instead of timestamps:** Old failures never expire, failing `Part1CountAndTripTest.windowSlides`.
2. **Using `>` instead of `>=` in the window eviction loop:** A failure exactly ten minutes old is still counted, failing `Part1CountAndTripTest.failureExactlyTenMinutesOldDropsOut`.
3. **Using `>` instead of `>=` for the cooldown check:** A call arriving at exactly five minutes is blocked instead of becoming the trial, failing `Part2CooldownAndTrialTest.trialAtExactlyFiveMinutesClosesOnSuccess`.
4. **Forgetting `failures.clear()` after a successful trial:** Old failures remain in the deque, so a single new failure immediately reopens the breaker, failing `Part2CooldownAndTrialTest.recoveryForgetsEarlierFailures`.
5. **Resetting `state` to `OPEN` on a failed trial without updating `openedAt`:** The old cooldown is already expired, so every subsequent call becomes a trial, failing `Part2CooldownAndTrialTest.failedTrialOpensForAnotherCooldown`.

---

## 10. What to Say Out Loud

If you're implementing this in a pair-programming interview, it helps to clarify requirements upfront and narrate your key design choices. Here are three questions to ask first, followed by three design points to explain as you code:

* *"What counts as a failure? I'll assume a 5xx status or an exception, and treat 4xx responses as client errors."*
* *"Does the ten-minute window slide? If so, I'll store failure timestamps in a deque rather than using a counter."*
* *"For the exact boundaries—ten minutes old and five minutes after opening—are those inclusive or exclusive? Each answer maps directly to a single comparison operator."*
* *"I'll encapsulate the state in a small `Breaker` class that accepts the timestamp as a parameter. That makes supporting multiple services as simple as adding a `Map`."*
* *"I'm transitioning to `HALF_OPEN` inside `allow()` as I hand out the trial, so no other request can slip through while the trial is in flight."*
* *"For thread safety, I'll synchronize the state transitions (`allow` and `record`), never the remote call itself—otherwise a slow downstream service would stall even the calls we're trying to block."*

---

## 11. Taking It Further

If you want to discuss production hardening or edge cases beyond the starter project, here are four areas worth considering.

### 11.1. Why Return `Response.BLOCKED` Instead of Throwing?

When a downstream service is down, being blocked is an expected, routine outcome rather than an exceptional error. Returning a `Response` lets callers handle it uniformly alongside normal HTTP responses, while the `blocked` flag distinguishes a local refusal from a genuine `503` returned by the remote server.

### 11.2. What If the Trial Never Answers?

In our simplified implementation, if the trial request hangs forever, the breaker stays stuck in `HALF_OPEN` and blocks all future traffic indefinitely. In production, every outbound call needs a strict timeout so the trial always resolves to either a success or a failure.

### 11.3. What About a Late Response Arriving Mid-Trial?

There is a subtle concurrency bug in our `HALF_OPEN` handling that no test currently covers: if an old, slow request from before the breaker opened finishes *while* a trial is in flight, `record()` will mistake that late response for the trial's outcome. The clean fix is to have `allow()` return a permit (or token) that tags whether the caller is the trial, and pass that permit into `record()`.

### 11.4. Where Do Retries Go?

Retries belong *outside* the circuit breaker. Placing them outside ensures every failed attempt is counted toward the failure threshold, and a `Response.BLOCKED` immediately terminates the retry loop rather than hammering a downed service. In production, retries should also use exponential backoff and a retry budget.

---

## 12. Conclusion

In this tutorial, we built a circuit breaker from scratch in plain Java 21 using a compact three-state machine and a per-service `Map`. The core takeaways from Parts 1 through 3 are storing failure timestamps in a `Deque` instead of a counter, expressing both time boundaries as elapsed ages compared with `>=`, and passing time into the breaker rather than coupling it to a clock. Finally, when adding concurrency, we lock only the state decisions—never the remote call itself.