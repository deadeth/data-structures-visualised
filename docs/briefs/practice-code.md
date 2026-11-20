# Brief: the Java for one pairing practice page

Repo: /home/claude/data-structures-visualised. A static teaching site. Its "Pairing practice" pages (`#/p/<id>`) each take one small coding task of the kind set in a pair-programming interview and build it a stage at a time in Java. Read `src/practice/types.ts` first: it describes the folder you are writing into.

You write the Java and a facts file. Another agent writes the page's words from them, so the facts file must be complete and every claim in it must come from running the code.

The reader is an engineering manager who used to write Java daily and is getting his hands back in. He will paste the starter into an online interview editor (HackerRank, Java 21), with no IDE and possibly no autocomplete, and work through the stages against a clock, talking aloud. The code he ends up with should be what a senior engineer would write in 40 minutes in an interview: plain, correct, small. Not a framework.

## Files

```
src/practice/<id>/starter/Solution.java        supplied code, empty stubs, every stage's tests, STAGE = 1
src/practice/<id>/solution/s1/Solution.java    the whole file once stage 1 is done, STAGE = 1
src/practice/<id>/solution/s2/Solution.java    ... once stage 2 is done, STAGE = 2
...
/home/claude/practice-work/<id>/facts.md       outside the repo
```

Touch nothing else in the repo. Run no git commands that change anything. Other agents are working in the same tree.

## Every Java file

- One file, one program. `public class Solution` with `public static void main(String[] args)`. No package line. Imports from `java.*` only. Other types are static nested classes, records, enums or interfaces inside `Solution`, or non-public top-level types in the same file; pick one style and keep it.
- Java 21. Records, `var`, switch expressions and enhanced `for` are welcome where they make the code shorter. Nothing a reviewer would have to look up.
- Lines at most 80 characters. Four-space indent. No tabs.
- The starter is at most 300 lines and well under 50 KB. Stage files are as long as they need to be.
- Runs in well under one second. No `Thread.sleep`, no real clock: time comes from a clock the tests control (a `long` of milliseconds passed in, or a small `Clock` interface with a fake). No randomness without a fixed seed. No reading from stdin, no files, no network.
- The same three sections in the same order in every file of the page, each opened by a banner comment exactly as written here:

```java
// ===== Supplied code: do not change =====
// ===== Your code =====
// ===== Tests: set STAGE to run more =====
```

- "Supplied code" is what an interviewer would hand over: simulated remote services, request and response types, the clock. It is byte-for-byte the same in the starter and every stage file.
- "Your code" is the class or classes the reader writes. In the starter each method the tests call exists as a stub that compiles and throws `UnsupportedOperationException("stage n")` or returns a harmless default, with a `// TODO stage n:` comment of one line. Fix the public API up front so that later stages add methods or change bodies but never change a signature an earlier test uses.
- "Tests" is byte-for-byte the same in the starter and every stage file, except the one line `static final int STAGE = n;`. It holds a tiny harness and the tests of every stage:

```java
static final int STAGE = 1;

public static void main(String[] args) {
    if (STAGE >= 1) stage1();
    if (STAGE >= 2) stage2();
    ...
    System.out.println(failed == 0 ? "ALL PASSED" : failed + " FAILED");
}
```

  Each test is a named check: print `PASS <name>` or `FAIL <name>: expected <x>, got <y>`. A test that throws is caught and printed as `FAIL <name>: threw <exception>`, and the run carries on. After each stage print `Stage n: p/t passed`. Never call `System.exit`. Test names are short, lower case, unique across the file, and say the behaviour ("third failure opens the breaker"), not the method.
- Above each stage's tests, a comment of two to four lines gives that stage's requirement in plain words, as the interviewer would say it. The starter's header comment gives only the opening brief (at most 15 lines) and one line on how STAGE works. Requirements for later stages live only above their tests, so the reader meets them one at a time.
- Tests check behaviour through the public API only. Three to six tests a stage. Include the awkward cases: the boundary of a time window (exactly at the limit), the first call, the empty state, the call after recovery. Concurrency tests use real threads with a latch and a bounded wait of at most one second, and must pass every time: run them 200 times in a loop before you trust them.

## Stage files

- `solution/s<n>/Solution.java` is the starter with stages 1 to n done and `STAGE = n`. Stubs for later stages stay as stubs. Every test of stages 1 to n passes; the file also still compiles with the later tests in it.
- Each stage changes as little as it can. Build s2 by copying s1 and editing it. A reader should be able to diff s1 against s2 and see only stage 2.
- In each stage file, mark what **that stage** added or changed with regions: `// region name` on its own line, then whole members (a field group, a method, a small class), then `// endregion` on its own line. Region names are lower case with hyphens and unique in the file. Do not open a region inside a method body. Carry no regions over from the previous stage: s2 marks only stage 2's work. The starter has no region markers.
- Comments inside "Your code" are the few a good engineer would leave: why, not what. The page explains the rest.
- The last stage is the reference solution. Read it once more as a reviewer: names, early returns, no dead code, no cleverness.

## Check before you report

For the starter and each stage n, from a scratch directory outside the repo:

```
mkdir -p /tmp/practice/<id>/sN && cp <file> /tmp/practice/<id>/sN/Solution.java
cd /tmp/practice/<id>/sN && javac -Xlint:all Solution.java && java Solution
```

- No compiler warnings.
- Starter: compiles, runs, prints FAIL for stage 1's tests (none pass by accident unless that is honest, and say which), never crashes.
- Stage n: every test of stages 1 to n passes. Also set STAGE to the highest stage in a scratch copy of the last file and confirm ALL PASSED.
- Mutation check on the last stage: break the solution in three different realistic ways (an off-by-one on a boundary, a forgotten reset, a missing lock or a wrong comparison) and confirm at least one test fails each time. If none does, add the test.
- The supplied and test sections really are identical across files: `diff` them.
- No line over 80 characters: `awk 'length > 80' file`.

## The facts file

`/home/claude/practice-work/<id>/facts.md`, for the writer. Plain notes, not prose for the page.

1. The opening brief, and what the starter supplies.
2. Six to eight questions a candidate should ask before coding, each with why it matters and the assumption the code makes.
3. For each stage: the requirement; the test names exactly as printed; the region names you marked; what changed since the previous stage and why this way and not the obvious alternative; the data structure and its cost; two or three single lines worth a note; the mistakes this stage invites.
4. For each stage, a trace: one run of that stage's code on a small concrete scenario (ideally one of the tests), as a table of events and the state after each. Produce it by adding temporary prints to a scratch copy and pasting the real output. Do not write a trace by hand.
5. The whole solution as pseudocode, about 20 lines, and each stage's pseudocode.
6. Eight to twelve follow-up questions an interviewer might ask once the code works (scale, several instances, failure, observability, configuration, testing, what you would change for production), each with a correct answer in two to four sentences.
7. What the solution leaves out or simplifies compared with production code.
8. Anything you are not sure of.

## Report

File paths, the stage list with test counts, the output of the final run, the three mutations and which test caught each, and anything you could not check.
