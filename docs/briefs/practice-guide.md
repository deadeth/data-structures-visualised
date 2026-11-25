<!-- Used on 25 November 2026 for the three tutorials. <pkg> paths point at the owner's IntelliJ practice project, which is not in this repo; the site copy of each article is src/practice/<id>/guide.md. -->

# Brief: a tutorial for one practice problem, in the style of a Baeldung article

You are writing one reading document for a small Java 21 practice project. Its
owner is an engineering manager preparing for a 60-minute pair-programming
interview, done in plain Java without AI help and without frameworks. He has a
starter file and unit tests for the problem. He wants a document he can read to
understand the solution, and he has said he learns best from baeldung.com, so
the document must read like an article from that site.

You are a writing sub-agent. Do the work yourself. Do not spawn agents.

## What to read first (all read-only; change nothing under these paths)

- The project: `/home/claude/pairing-practice/`
  - `src/main/java/<pkg>/Solution.java`: the starter. Its top comment is the
    problem statement, with the parts in order.
  - `src/test/java/<pkg>/`: one JUnit test class per part.
- The tested reference material:
  `/home/claude/data-structures-visualised/src/practice/<id>/`
  - `solution/s<n>/Solution.java`: the whole file once stage n is done. Stage n
    is Part n. `// region` comments mark what each stage added.
  - `page.ts`: the words already written for this problem (what is asked, the
    design choice for each part, pitfalls, traces, follow-up questions). Use it
    as your source of facts and reasoning. Do not copy its sentences.

## The one file you write

`/home/claude/pairing-practice/guides/<file>.md` and nothing else. Create the
`guides` folder if it is missing. Do not edit any other file anywhere. Do not
commit or push anything.

## The shape: a Baeldung article

Follow the site's conventions closely:

- A title in title case, for example "Building a Circuit Breaker in Plain Java".
- Numbered sections as `## 1. Overview`, `## 2. The Problem`, and so on, with
  numbered sub-sections as `### 3.1. Counting Failures` where a section has
  steps. Headings in title case.
- "1. Overview" is short: what we'll build, in what order, and what the reader
  will be able to do at the end. It opens the way the site does ("In this
  tutorial, we'll ...").
- First person plural throughout: "we", "we'll", "our".
- Short paragraphs, mostly one to three sentences.
- Code comes in small pieces, never the whole file at once. Every code block has
  a sentence before it saying what it is, and a sentence or two after it
  explaining the decision that matters in it. Fence code as ```java.
- A sentence that carries the key idea of a section may be in bold. Use this
  sparingly, at most once a section.
- The last section is "N. Conclusion": three or four sentences on what we built
  and the ideas worth keeping.

## What the article must cover, in this order

1. Overview.
2. The Problem: the rules with their numbers, what is supplied, and one worked
   example with times, taken from the starter's statement.
3. The Design: the idea before any code. Where a small picture in plain
   characters helps (a state machine, a window on a timeline), include one in a
   plain fenced block.
4. One section for each part, in order, named after what it adds. Each one:
   the rule being added and the test class that checks it; the code that
   changes, shown as the pieces that matter; why it is written that way and
   what the simpler alternative would have got wrong; a short traced run with
   real values where it helps.
   Parts the starter marks optional (the stretch and the variant) are covered
   more briefly and say plainly that they are optional.
5. Common Mistakes: the three to five mistakes the tests are built to catch,
   each with the name of a test that catches it.
6. What to Say Out Loud: five or six short lines to say while writing it in an
   interview: the questions to ask before starting, and the one-sentence reason
   for each main choice.
7. Taking It Further: four to six short follow-up questions an interviewer may
   ask about production use, with a two- or three-sentence answer each.
8. Conclusion.

## Rules for the code (these are checked by a script afterwards)

- Every line inside a ```java block must appear, character for character apart
  from leading indentation, in one of the `solution/s<n>/Solution.java` files
  for this problem. Do not write new code, do not rename anything, do not tidy
  it, and do not show code from the JUnit test classes (name a test in the
  prose instead). You may leave lines out of the middle of a method only by
  ending the block and starting another; do not use "..." or "// ..." lines
  inside a java block. Do not include `// region` or `// endregion` lines.
- Say which part's code a block shows when it is not obvious.
- A traced run or any output you show must come from a real run. Java 21 and
  Maven are installed. Work in a scratch folder of your own,
  `/tmp/guide-<pkg>/`, and never in `/tmp/guide` or another agent's folder.
  Plain-character pictures and traces go in fenced blocks with no language.

## Rules for the words

- Plain British English. Short sentences. Concrete numbers.
- The Baeldung voice is wanted, so "we'll" and the occasional "let's" are fine.
  Use "let's" at most four times in the whole article.
- Never use these words: delve, dive into, navigate (figuratively), underscore,
  bolster, foster, harness, leverage, unpack, shed light on, pave the way,
  pivotal, groundbreaking, cutting-edge, transformative, game-changing,
  innovative, robust, comprehensive, seamless, intricate, nuanced, vibrant,
  multifaceted, holistic, testament, landscape, realm.
- Never use the patterns "It's not just X, it's Y" or "Not only X, but Y". No
  em dashes; use commas, colons or brackets.
- Name no company, and say nothing about where the task comes from or who sets
  it. Refer to "a pair-programming interview" only in general terms.
- Do not state product facts you cannot check from `page.ts` or the code: no
  library defaults, version numbers or claims about how a named product
  behaves. You may say that libraries exist for this (naming one or two
  well-known ones) without describing their settings.
- Where the article simplifies something, say so in a sentence.
- Do not claim anything is tested or proven unless a named test in the project
  checks it. If a known gap exists (the source material lists some), say so.

## Where it will be read

The same file is read in two places: in the project, beside the starter and the
JUnit tests, and as a sub page of the public practice page for this problem on
a teaching site, where the same work is called "Stage n". So:

- Call the steps "Part 1", "Part 2" and so on, and say once in the Overview
  that these are the practice page's stages 1 to 5.
- When you name a test, give the JUnit class and the test method as they are in
  the project, and say once in the Overview that the test names are those of
  the JUnit classes in the practice project.
- Use only this Markdown: one `#` title, `##` and `###` headings, paragraphs,
  fenced code blocks (```java or a bare fence), ordered lists, bullet lists,
  `**bold**`, `` `inline code` `` and `[links](https://...)`. No tables, no
  images, no HTML, no block quotes, no nested lists, no footnotes, no
  horizontal rules.
- Do not link to anything. The site adds its own links.

## Length

1,400 to 2,000 words of prose, not counting code and traces. Lines in the
Markdown file may be any length; do not hard-wrap paragraphs.

## Report back (under 200 words)

The file path and its word count; the sections; which stage file each code
block came from; the commands you ran for any trace; anything in the article
you could not check against the code or `page.ts`.
