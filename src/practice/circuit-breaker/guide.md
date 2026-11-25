# Building a Circuit Breaker in Plain Java

## 1. Overview

In this tutorial, we'll build a circuit breaker around a small web client in plain Java 21. It stops calling a service that keeps failing, then sends one call to see whether it has recovered.

We'll work in five parts: count failures and open, cool down and send one trial, keep one breaker for each service, then two optional parts, threads and a `replay` method. These are the practice page's stages 1 to 5, and the tests we name are methods of the JUnit classes in the practice project.

By the end, we'll be able to write the three core parts in a pair-programming interview and explain each comparison in them.

## 2. The Problem

Service A calls two downstream services, B and C, through one `WebClient`. We implement `execute()` so that **three failures within ten minutes mean no calls to that service for the next five minutes**. The rules:

- A status of 500 or more, or an exception from the remote, is a failure. A 4xx is not. An exception is counted and rethrown unchanged.
- The ten minutes slide: a failure exactly ten minutes old no longer counts, and a success in between resets nothing.
- A blocked call never reaches the remote. It returns `Response.BLOCKED` (status 503, `blocked` flag set) and changes nothing.
- Five minutes or more after opening (exactly five counts), one call goes through as a trial. If it isn't a failure, the breaker closes and forgets the old failures. If it fails, the five minutes start again from the trial.

The starter supplies `Request`, `Response`, a simulated `Remote` and a fake `Clock` that moves only when a test says so. `WebClient` already holds `maxFailures` (3), `windowMillis` (600000) and `cooldownMillis` (300000). A few tests set other values, so we use the fields.

Here is the starter's example, with every call to B and times in milliseconds:

```
       0  remote answers 500  ->  500 returned, 1 failure
       0  remote answers 500  ->  500 returned, 2 failures
       0  remote answers 500  ->  500 returned, 3 failures: open at 0
  299999  remote not called   ->  BLOCKED
  300000  remote answers 200  ->  200, the trial: closed, failures gone
  300000  remote answers 200  ->  200
```

## 3. The Design

All the state for one service goes in a small inner class, `Breaker`. `allow(now)` says whether a call may go, and `record(now, failed)` takes in the outcome of one that went. **The breaker is handed the time and never reads the clock**, which makes Part 5 almost free.

From Part 2 it has three states:

```
            third failure            first call 5 min or
            inside 10 min            more after opening
  CLOSED ------------------> OPEN ------------------------> HALF_OPEN
    ^                         ^                              |    |
    |                         +------- trial fails ----------+    |
    +------------------ trial is not a failure -------------------+
```

There's no timer: the move to `HALF_OPEN` happens when a call arrives, not when five minutes pass.

Both time rules compare an age with `>=`:

```
a failure has left the window when   now - failureTime >= windowMillis
the next call is the trial when      now - openedAt    >= cooldownMillis
```

Our breaker is simplified: it measures no failure rate, it has no timeouts (the simulated remote answers at once), and it lives in one process.

## 4. Part 1: Counting Failures

Part 1 lets calls through and opens the breaker on the third failure within ten minutes. It stays open until Part 2. `Part1CountAndTripTest` checks it.

### 4.1. The Call Path

Here's `execute()` after Part 1, with one `Breaker` in a field named `breaker`:

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

We ask before we call, so a blocked call never reaches the remote. An exception is recorded, then rethrown as it came (`exceptionRethrownUnchanged`).

With `>= 400` as the failure test, three 404s from one caller's bad input would block everyone, and `fourHundredsPassThrough` fails.

### 4.2. The Sliding Window

The breaker holds the time of each recent failure, and a flag:

```java
/** Times of recent failures, oldest first. */
private final Deque<Long> failures = new ArrayDeque<>();
private boolean open;
```

We keep times, not a count, because the oldest failure has to drop out by itself. With a counter, failures at minutes 0, 9 and 18 read as 3, though no ten minutes held more than 2 (`windowSlides`).

The counting happens in `record()`:

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

**The loop uses `>=`, so a failure whose age is exactly `windowMillis` is removed before we count.** With `>` it would still count, and `failureExactlyTenMinutesOldDropsOut` gets BLOCKED where it expects a 500.

Clearing the deque on a success would make the rule "three in a row", which `successInBetweenResetsNothing` catches.

Here is the Part 1 code with two failures at time 0, then four calls at exactly ten minutes (`-` means the remote wasn't called):

```
time     to  remote   returned  state after          failure times after
0        B   500      500       closed               [0]
0        B   500      500       closed               [0, 0]
600000   B   500      500       closed               [600000]
600000   B   500      500       closed               [600000, 600000]
600000   B   500      500       open                 [600000, 600000, 600000]
600000   B   -        BLOCKED   open                 [600000, 600000, 600000]
```

At 600000 both early failures are exactly 600000 old and leave together, so it takes three new failures to open. At 599999 they would still count (`failureJustInsideTheWindowCounts`).

## 5. Part 2: Cooling Down, Then One Trial

Part 2 adds recovery: five minutes or more after opening, one call goes through as a trial. `Part2CooldownAndTrialTest` checks it.

### 5.1. Three States

The flag becomes an enum, declared in `WebClient`:

```java
private enum State { CLOSED, OPEN, HALF_OPEN }
```

`HALF_OPEN` means one trial is out. Two booleans would allow a fourth, meaningless combination.

The breaker also remembers when it opened:

```java
private State state = State.CLOSED;
private long openedAt;
```

The cooldown is measured from `openedAt`.

### 5.2. Choosing the Trial

Now `allow()` takes the time:

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

**The breaker goes half-open inside `allow`, as it hands out the trial and before the remote is called.** A call that arrives while the trial is out finds `HALF_OPEN` and gets `false`.

With `>=`, a call at 299999 is blocked and a call at 300000 is the trial. With `>`, ten of the thirteen tests in the class fail, `trialAtExactlyFiveMinutesClosesOnSuccess` among them.

The `false` path changes no field, so blocked calls can't restart the five minutes. `execute()` now passes `clock.millis()` to `allow`.

### 5.3. What the Trial's Answer Does

`record()` gains a branch at the top. The rest is the Part 1 code, with `open = true` replaced by `open(now)`:

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

A trial that isn't a failure closes the breaker and clears the failure times. Without the clear, the three failures that opened the breaker can be only five minutes old, still inside the ten, so one new failure makes four in the window and opens it again (`recoveryForgetsEarlierFailures`).

A failed trial calls a small helper:

```java
private void open(long now) {
    state = State.OPEN;
    openedAt = now;
}
```

Because the helper sets `openedAt` again, the next five minutes run from the trial, not from the first opening. If we set only the state, the old `openedAt` would already be past the cooldown, every later call would be another trial, and `failedTrialOpensForAnotherCooldown` fails.

Here's the Part 2 code with a trial that fails, then one that succeeds:

```
time     to  remote   returned  state after          failure times after
0        B   500      500       CLOSED               [0]
0        B   500      500       CLOSED               [0, 0]
0        B   500      500       OPEN since 0         [0, 0, 0]
299999   B   -        BLOCKED   OPEN since 0         [0, 0, 0]
300000   B   500      500       OPEN since 300000    [0, 0, 0]
599999   B   -        BLOCKED   OPEN since 300000    [0, 0, 0]
600000   B   200      200       CLOSED               []
600000   B   200      200       CLOSED               []
```

The trial at 300000 fails and moves the opening time, so 599999 is still blocked. `HALF_OPEN` never shows: with one thread, the trial's answer is recorded before the next call.

## 6. Part 3: One Breaker for Each Service

Part 3 keeps B and C apart, each with its own failures and its own five minutes. `Part3PerServiceTest` checks it, and `Breaker` doesn't change.

The field becomes a map:

```java
private final Map<String, Breaker> breakers = new HashMap<>();
```

Each service name gets one whole breaker.

A helper finds the breaker for a name, or makes a closed one and stores it:

```java
private Breaker breakerFor(String service) {
    return breakers.computeIfAbsent(service, s -> new Breaker());
}
```

`computeIfAbsent` does the lookup and the insert in one call.

Then `execute()` gains a first line:

```java
Breaker breaker = breakerFor(request.service());
```

The local variable has the old field's name, so the rest of `execute()` compiles as it stands. The key is the service, not the path (`pathsOfOneServiceShareABreaker`).

## 7. Part 4: Many Threads (Optional Stretch)

Part 4 is optional: many threads call `execute()` at once (`Part4ThreadSafetyTest`).

### 7.1. Lock the Decisions, Not the Call

The map becomes a concurrent one:

```java
private final Map<String, Breaker> breakers = new ConcurrentHashMap<>();
```

With `computeIfAbsent`, two threads that ask for B get the same breaker.

We also mark `allow` and `record` as `synchronized`. That locks one `Breaker`, so B and C never wait for each other, and each decision is a single step.

`execute()` itself takes no lock: `allow` takes the lock and lets it go, the remote call runs with no lock held, and `record` takes it again. **If we held the lock across the remote call, every caller for that service would queue behind the slowest call, including the callers we mean to block at once.**

With `synchronized` on `execute()` the counting is still right, but `exactlyOneTrialAfterTheCooldown` and `slowCallDoesNotHoldUpTheNext` fail: the 19 threads that should come back BLOCKED wait behind the trial.

The short lock is safe because the trial is chosen inside `allow`: reading `OPEN` and writing `HALF_OPEN` are one step, so only one thread gets `true`.

### 7.2. Answers That Arrive Late

Letting go of the lock means the state can change while a call is out, so `record` gains a guard after the trial branch:

```java
// Ignore late answers from calls let through before it opened.
if (state != State.CLOSED || !failed) {
    return;
}
```

An answer that arrives while the breaker is open came from a call that set off before it opened. Without the guard, a late failure would restart the five minutes (`lateFailureWhileOpenIsIgnored`).

### 7.3. What the Tests Don't Prove

There's a known gap. With `synchronized` removed from `allow` alone, we ran the class 20 times on a 2-CPU machine, each run repeating every test 10 times, and all 20 runs were green.

So a green Part 4 does not prove thread safety. The race needs two threads to read `OPEN` before either writes `HALF_OPEN`, and the case for that lock has to be made in words.

## 8. Part 5: Time Arrives as Data (Optional Variant)

Part 5 is optional too. `replay(lines)` takes lines of the form `timestampMillis service statusCode` and answers ALLOWED, BLOCKED or INVALID for each, never calling the remote (`Part5ReplayTest`).

A helper, `replayLine`, returns INVALID unless the line splits into exactly three pieces and the first and third are whole numbers. Only then does it touch a breaker:

```java
Breaker breaker = breakerFor(parts[1]);
if (!breaker.allow(at)) {
    return "BLOCKED";
}
breaker.record(at, status >= 500);
return "ALLOWED";
```

This is `execute()` with the line's time in place of the clock and its status in place of the remote, so no rule is written twice.

Here's a real run:

```
line           result   B's state after      B's failure times after
0 B 500        ALLOWED  CLOSED               [0]
60000 B 500    ALLOWED  CLOSED               [0, 60000]
600000 B 500   ALLOWED  CLOSED               [60000, 600000]
600001 B 500   ALLOWED  OPEN since 600001    [60000, 600000, 600001]
900000 B 200   BLOCKED  OPEN since 600001    [60000, 600000, 600001]
x B 500        INVALID  OPEN since 600001    [60000, 600000, 600001]
900001 B 200   ALLOWED  CLOSED               []
900002 B 500   ALLOWED  CLOSED               [900002]
```

The line that opens the breaker is itself ALLOWED, and the bad line changes nothing. `replay` assumes the lines are in time order, and nothing checks that.

## 9. Common Mistakes

Each was made in the reference code, and the named test failed:

1. Never dropping old failures, as a plain counter does: `Part1CountAndTripTest.windowSlides`.
2. `>` in the window loop, so a failure exactly ten minutes old still counts: `Part1CountAndTripTest.failureExactlyTenMinutesOldDropsOut`.
3. `>` at the cooldown, so the call at exactly five minutes is blocked: `Part2CooldownAndTrialTest.trialAtExactlyFiveMinutesClosesOnSuccess`.
4. No `failures.clear()` after a good trial, so one new failure reopens the breaker: `Part2CooldownAndTrialTest.recoveryForgetsEarlierFailures`.
5. Setting the state after a failed trial but not `openedAt`: `Part2CooldownAndTrialTest.failedTrialOpensForAnotherCooldown`.

## 10. What to Say Out Loud

Three questions first, then three reasons:

- "What counts as a failure? I'll assume a 5xx or an exception, not a 4xx."
- "Do the ten minutes slide? Then I need the time of each failure, not a counter."
- "Exactly ten minutes old: in or out? Exactly five minutes after opening: blocked or let through? Each answer is one operator."
- "State goes in a small `Breaker` class that is given the time, so many services need only a map."
- "The breaker goes half-open as it hands out the trial, so nobody else gets through while it's out."
- "With threads I'd lock each decision, never the remote call, or a slow service holds up even the calls I'm blocking."

## 11. Taking It Further

### 11.1. Why Not Throw When Blocked?

Being blocked is expected while a service is down, so callers handle it like any other answer. The `blocked` flag tells our refusal apart from a real 503.

### 11.2. What if the Trial Never Answers?

The breaker stays half-open and blocks every later call, because only the trial's answer moves it on. A real client needs a timeout on every call.

### 11.3. What About a Late Answer Mid-Trial?

Our code gets this wrong: in `HALF_OPEN`, `record` takes the next answer to arrive as the trial's, whoever sent it. No test covers it. The fix is a permit from `allow` that marks the trial.

### 11.4. Where Do Retries Go?

We'd put the retry outside the breaker, so every attempt is counted and a blocked answer ends the loop at once. Retries also need backoff and a budget.

## 12. Conclusion

In this tutorial, we built a circuit breaker as a three-state machine in one small class, with a map to give each service its own breaker. The ideas worth keeping from Parts 1 to 3 are failure times in place of a count, both boundaries written as an age compared with `>=`, and a breaker that is handed its time. With threads, we lock each decision but never the remote call.
