# Fixture: A Counter With a Limit in Java

*This is test material for the tutorial page. Back to the practice page: Fixture practice.*

---

## 1. Overview

This is test material for the tutorial page. It uses every element the format allows: **bold**, *italics*, **bold with `code`**, *italics with `code`*, `inline code`, a [link to the Java documentation](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Math.html), lists, rules, a table and three kinds of code block.

In this article we build a counter that refuses calls at a limit, a stage at a time.

## 2. Counting Calls

### 2.1. The State

The counter keeps one field. Every call to `hit` adds one:

```java
static final class Counter {
    private int count;
```

### 2.2. The Limit

The check comes before the increment, so a refused call is never counted:

```java
boolean hit(String who) {
    if (count >= limit) {
        audit.refused(who, count);
        return false;
    }
    count++;
    return true;
}
```

The order of events for a limit of 2 looks like this:

```
hit("ann")  count 0 -> 1   let through
hit("ann")  count 1 -> 2   let through
hit("ann")  count 2        refused, reported as ann@2
```

The same run as a table, with an empty cell where nothing is reported:

| Call | Count Before | Result | Reported |
| --- | --- | --- | --- |
| `hit("ann")` | `0` | let through | |
| `hit("ann")` | `1` | let through | |
| `hit("ann")` | `2` | **refused** | `ann@2` |

---

A refused call changes *nothing*:

```text
count stays at 2

```

## 3. Resetting and Reading What Is Left

We write the last two stages in this order:

1. Set the count back to zero in `reset`.
2. Return the calls left in `remaining`, never below zero *(optional stretch)*.

```java
int remaining() {
    return Math.max(0, limit - count);
}
```

## 4. Conclusion

What to take away:

* **Ask first:** whether the limit is inclusive, before typing.
* *"Test a limit of 0 and a limit of 1."*
- Keep the count in one field, so a reset is one line.

---
