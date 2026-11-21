# Brief: write the words for one pairing practice page

Repo: /home/claude/data-structures-visualised. A static teaching site. Its "Pairing practice" pages (`#/p/<id>`) each take one small coding task of the kind set in a pair-programming interview and build it a stage at a time in Java.

The Java is already written and tested: `src/practice/<id>/starter/Solution.java` and `src/practice/<id>/solution/s<n>/Solution.java`. The engineer who wrote it left you notes at `/home/claude/practice-work/<id>/facts.md`. You write one file, `src/practice/<id>/page.ts`, with a default export of type `Practice`. Read `src/practice/types.ts` first: it is the contract, and each field's comment says what belongs in it.

```ts
import type { Practice } from '../types';
const page: Practice = { id: '...', title: '...', ... };
export default page;
```

Touch no other file. Run no git commands that change anything.

## The reader

Matthew, an engineering manager who wrote Java daily some years ago and is getting his hands back in for pair-programming interviews: Java, an online editor with no IDE, no AI help, two engineers watching, about 50 working minutes. He will paste the starter in, set a clock and build the stages in order, talking as he goes. He reads the page before a run to learn the shape of the solution, and after a run to see what he missed.

So the page has two jobs. Teach him to write this code himself, a stage at a time, in the order he would write it. And teach him what to say: the questions before the code, the sentence while typing, the answers after.

He does not need Java syntax explained. He does need the idiom he may have forgotten named at the moment it is used (`computeIfAbsent`, `ArrayDeque`, a record, `BigDecimal.setScale`), in one clause.

## The shape of a page

The reader drills the questions and the core stages until they feel natural, and only talks through the rest. The page is built for that. Top to bottom:

1. Opening: title, one-sentence `summary`, what the task is testing (`testing`), how to use the page (`use`), then the brief and what the starter gives.
2. Ask first: five or six questions.
3. One section for each core stage (stages 1 to `core`), each with exactly five things: what is asked and its tests, the code, the design choice, a traced run, the pitfalls.
4. Stretch stages (after `core`): each opens with a spoken answer of three sentences, with its code and the rest folded away.
5. The last ten minutes: one list of questions and short answers, covering both what an interviewer asks next and what the solution leaves out.
6. A variant, if the page has one: another framing of the same task, folded, with one takeaway.

Earlier versions of these pages had ten subsections a stage, separate "what they ask next", "where the time goes" and "what this page leaves out" sections, and a list of unchecked facts. Those are gone. Say each thing once, in the place it is used.

## What goes where

- `summary`: one sentence saying what to build, with the task's own numbers.
- `testing`: `intro` is one or two sentences on what the task is really for: the code is short (give the measured number of lines he writes by the core stage; count them in the stage file, do not guess), and what counts is how he handles what the brief leaves out, where he puts the state, and how he works against the clock. Then exactly three `points`, each one plain sentence naming one thing being watched and what it looks like on this task (for the circuit breaker: asking what a failure is and whether the window slides before typing; testing exact millisecond boundaries with the supplied clock and no sleeping; putting the state in a small class early so that one service becoming many is a two-line change). Do not write them as a bold term followed by an explanation. Do not claim to know how any employer marks.
- `use`: one or two sentences. Drill "Ask first" and the core stages until they feel natural. Treat the stretch stages and the last ten minutes as things to say, not to code up front.
- `brief`: the task as given at the start. Short. Only the opening requirement.
- `given`: at most five short items on what the starter already has, so he does not rewrite it. One line each.
- `ask`: five or six questions, most important first. For each: why the answer changes the code (one or two sentences), and the assumption to state aloud.
- `outline`: the finished solution in plain steps, about 20 lines. It is shown folded.
- `parts`: one per stage, in stage order. For every part:
  - `ask`: the new requirement in the interviewer's voice, one or two sentences.
  - `tests`: the names from the starter, exactly.
  - `regions`: the region names in that stage's file, in reading order.
  - `pseudocode`: this stage's logic only, in plain steps, lines at most 64 characters, two-space indent, no braces, types or semicolons. It is shown folded under the code.
  - `choice`: the one decision the stage turns on, as a single paragraph of at most 110 words. State the choice, why this and not the obvious alternative, and the boundary or idiom that is easy to get wrong (name the comparison exactly as the code has it). This replaces the old explanation and line notes: keep the best of both and cut the rest.
  - `say`: one sentence to say aloud while writing the stage, in his voice.
  - `sketch`: only where a small picture helps him hold the whole thing in his head (a state machine, a window on a timeline). Plain characters, lines at most 64, drawn so that every arrow has one start and one end. Most stages have none.
  - `trace`: the table from a real run. Six to ten rows. The caption says what to notice.
  - `pitfalls`: two to four, each one sentence saying what goes wrong and what it looks like when it does.
  - For a stretch stage (after `core`), also `verbal`: exactly three short sentences that answer the requirement aloud, for when there is no time to code it. They must be true of the code in that stage's file.
  - `caveat`: one line, only where the stage needs a warning the reader would otherwise be misled without, such as a threading test that passes on wrong code most of the time. Give the measured figure.
  - `variant: true` with a one- or two-sentence `verbal`: only for a part that is another framing of the task, not a next step.
- `followUps`: ten to twelve questions for the last ten minutes, hardest last. Each answer is two or three sentences he could say in twenty seconds: the position first, then the reason or the cost. Fold what the solution leaves out into this list as questions ("What would you change before this went to production?", "What happens if a call takes longer than the cooldown?") so that nothing a reader should know is lost, and nothing is said twice.
- `see`: links to this site's pages that show the mechanism, label only. Use only ids you have checked exist in `src/catalog.ts` (structures, `#/s/<id>`), `src/reading/concepts/` (`#/c/<id>`) or `src/practice/` (`#/p/<id>`).
- `unverified`: keep the existing list, trimmed to what still applies to the words on the page. It is not shown to the reader; it is the record for whoever maintains the page.
- `minutes` and `core`: unchanged.

## Accuracy

Everything you say about what the code does must be true of the code in the stage file you are describing. Open each stage file and read it beside the facts. If the facts and the code disagree, the code wins, and say so in your report. Do not describe behaviour the tests do not show unless you have read it in the code. If you want to check something, compile and run: `mkdir -p /tmp/w-<id> && cp <file> /tmp/w-<id>/Solution.java && cd /tmp/w-<id> && javac Solution.java && java Solution` (JDK 21 is installed; use a folder of your own, since other writers are working at the same time).

Do not say where the task comes from. Name no company, no interview source and no person anywhere in the file. The page is a practice task and says nothing about who sets it.

## Writing

- Plain British English. Short sentences. Contractions. Say the point first, then support it.
- Concrete over general. Use the task's own numbers (3 failures, 10 minutes, 5 minutes) every time; never "the threshold" where "3" will do.
- Second person for instruction ("Keep the timestamps in a deque"), first person only inside `say` and the follow-up answers, which are his words.
- No sentence that says something matters without showing why. No preamble, no summary endings, no rhetorical questions.
- Never write a list where every item is a bold term followed by an explanation. Use sentences, or the fields the contract gives you.
- At most one dash used as punctuation in the whole file; use commas, colons or full stops.
- Never use these words: delve, dive into, navigate, underscore, bolster, foster, harness, leverage, unpack, shed light on, pave the way, pivotal, groundbreaking, cutting-edge, transformative, game-changing, innovative, robust, comprehensive, seamless, intricate, nuanced, vibrant, multifaceted, holistic, testament, landscape, realm. No "It's not just X, it's Y". No "Not only X but Y".
- Inline markup: `code` in backticks for identifiers and values, **bold** sparingly for the one phrase in a paragraph he must not miss, links as `[label](#/s/<id>)`.
- TypeScript strings: use double quotes or template literals for any string with an apostrophe in it. Pseudocode goes in a template literal; check no line passes 64 characters.

## Before you report

- `npx tsc --noEmit` (errors in files that are not yours are other agents' work in progress: ignore them, but your file must be clean).
- `npx vitest run src/practice` must pass for your page. Fix what it names.
- Read the page once as him the night before: is there a stage where he would still not know what to type first?

Report: the file path, the part titles, the word count, any place the facts and the code disagreed, and your `unverified` list.
