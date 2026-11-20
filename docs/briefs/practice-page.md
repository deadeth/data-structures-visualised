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

## What goes where

- `summary`: what the task is and what it is really testing, in one or two sentences.
- `brief`: the task as given at the start. Short. Only the opening requirement; later requirements belong to the parts.
- `given`: what the starter already has, so he does not rewrite it.
- `ask`: five to seven questions worth asking before typing. For each: why the answer changes the code, and the assumption to state aloud if the interviewer says "your call". Order them as he would ask them. The first two or three should be the ones that matter most; he will not have time for seven.
- `outline`: the finished solution in plain steps. Read it aloud: if it sounds like Java, rewrite it.
- `parts`: one per stage, in stage order. For each:
  - `ask`: the new requirement in the interviewer's voice, one or two sentences.
  - `tests`: the names from the facts file, exactly.
  - `pseudocode`: this stage's logic only, in plain steps, lines at most 64 characters. Indent with two spaces. No braces, no types, no semicolons.
  - `regions`: the region names from the facts file, in the order he should read them.
  - `explain`: three to five short paragraphs. Start with the decision this stage turns on (which data structure, where the state lives, what the boundary does) and why this choice and not the obvious alternative. Then what changed since the stage before. Give costs as numbers where there are any (memory per key, work per call).
  - `lines`: two to four single lines worth a note: the boundary comparison, the line that is easy to get backwards, the idiom. `code` must be an exact fragment of one line in the regions you listed; copy it from the stage file, do not retype it.
  - `trace`: the run from the facts file as a table. Keep the engineer's real output; you may rename columns and shorten cell text, but change no value. Six to ten rows. The caption says what to notice. Say in `note` which test it matches, if it does.
  - `say`: what to say aloud while writing this stage, in his voice, one or two sentences. It should name the decision, not narrate the typing.
  - `pitfalls`: two to four mistakes this stage invites, each one sentence saying what goes wrong and what it looks like when it does.
- `followUps`: eight to ten questions an interviewer asks once the code works, hardest last. Each answer is two to four short sentences he could say in thirty seconds: the position first, then the reason, then what it costs.
- `mistakes`: four to six ways people lose time on this task. Concrete: "Writing the per-service map before one service works" beats "over-engineering".
- `see`: links to this site's animated pages that show the mechanism, where one exists. Use only ids you have checked exist in `src/catalog.ts` (structures, `#/s/<id>`) or `src/reading/concepts/` (`#/c/<id>`).
- `simplified`: what the solution leaves out compared with production code. The site's rule is to say on the page what is simplified.
- `unverified`: anything in your words that is a fact about a product, a library default or common practice and that you have not checked. Mechanics you can read off the code are not unverified.
- `minutes` and `core`: from the facts file.

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
