# Brief: write one reading page (concept page or design walkthrough)

Repo: /home/claude/data-structures-visualised. A static teaching site for system design interview preparation. Most pages animate a mechanism step by step. Reading pages are different: prose with diagrams, to be read on a laptop or a phone, that explain a pattern properly and link out to the animated pages for the mechanics.

The reader is Matthew, a Senior Engineering Manager preparing for Senior Engineering Lead and Director-level system design interviews at UK fintech and public-sector tech companies. He knows the basics. He wants the reasoning: what problem each option solves, what it costs, what breaks, and how to talk about it in an interview.

## The format

Read `src/reading/types.ts` first. It is the contract. Your page is one TypeScript file that exports a single object of type `Concept` (concept pages) or `Reading` (walkthroughs) as its default export:

```ts
import type { Concept } from '../types';
const page: Concept = { id: '...', title: '...', group: 'Data', summary: '...', minutes: 12, sections: [ ... ], unverified: [ ... ] };
export default page;
```

- Concept pages go in `src/reading/concepts/<id>.ts`. Walkthroughs go in `src/reading/walkthroughs/<design id>.ts`.
- Touch no other file. Another agent is building the renderer and the registry at the same time; do not wait for it.
- Check your file compiles: `npx tsc --noEmit` (errors in files that are not yours are other agents' work in progress: ignore them).
- Run no git commands that change anything.

## Diagrams

Use plenty: at least one picture per section where a picture helps, and at least four per page. A reader should be able to skim the diagrams and captions alone and get the shape of the argument.

- `diagram`: boxes and arrows. At most 640 wide and 420 tall. Default box 140 by 56. Leave at least 40 units between boxes so edge labels fit. Labels short (about 18 characters a line); put detail in `sub` or the caption. Prefer tall layouts: phones shrink wide diagrams. Use `groups` for regions, shards, data centres or teams. Lay the coordinates out on paper first; overlapping boxes or edges that run through boxes are the commonest fault.
- `sequence`: message sequence charts, for protocols and races (a stale read, a lost update, a failover, a retry). At most 5 actors, at most about 10 messages.
- `design` (walkthroughs only): a snapshot of the design page's own diagram with some components and flows lit. Use the component and flow ids from `src/designs/<id>.ts`.
- Colour (`tone`) means one thing each, site-wide: `follow` magenta is only the one thing being followed; `compare` amber checked or compared; `visited` blue passed through; `ok` green written, committed, healthy; `bad` red failed, rejected, lost; `muted` grey present but not the point. Most boxes have no tone.
- Every diagram and sequence needs a caption that says what to notice, not just what it is.

## Writing

- Plain British English. Short sentences. Contractions. Concrete numbers (latencies, sizes, rates) with the working when it matters.
- State the point first, then support it. Name things: say "Postgres streaming replication" or "Kafka consumer group", not "the system".
- For every option: the problem it solves, how it works, what it costs, what breaks, when you'd choose it. Use a `table` to compare options side by side.
- Use `callout` with `kind: 'interview'` for what to say out loud, `pitfall` for the mistake candidates make, `rule` for rules of thumb, `example` for worked cases.
- Link to the animated pages with `see` blocks and inline links, wherever one shows the mechanism. Structure ids: b-plus-tree, lsm-tree, skip-list, trie, append-log, column-store, inverted-index, geo-index, hash-table, consistent-hashing, partitioning, bloom-filter, simhash, lru-cache, heap, queue, token-bucket, crawl-frontier, cache-strategies, mvcc, two-phase-locking, two-phase-commit, leader-replication, version-vectors, crdt, quorum, raft, mapreduce, stream-joins, stream-checkpoints, tcp, realtime-push, load-balancing, serialization, outbox, saga, idempotency-keys, retries-breaker, stack, fifo-queue, priority-queue, linked-list, bst, avl-tree, red-black-tree, graph, binary-search, merge-lists, merge-sort, quicksort, insertion-sort, quickselect. Design ids: web-crawler, ledger, fraud-alerts, card-processing, money-moved-dashboard. Concept pages link as `#/c/<id>`.
- Never use these words: delve, dive into, navigate (figurative), underscore, bolster, foster, harness, leverage, unpack, shed light on, pave the way, pivotal, groundbreaking, cutting-edge, transformative, game-changing, innovative, robust, comprehensive, seamless, intricate, nuanced, vibrant, multifaceted, holistic, testament, landscape (figurative), realm. No "It's not just X, it's Y". No "In today's world". No sentence that says something is important instead of showing why. Do not open with a sweeping statement or close with an inspirational summary.
- Never write a list where every item is "**Bold term:** explanation". Use a table, or plain sentences.
- Do not claim what you are not sure of. Mechanics you can reason out are fine. Product specifics (defaults, version numbers, which company uses what, published figures) go in `unverified` unless you are certain, and if a claim is shaky, leave it out.
- Length: concept pages about 2,000 to 3,000 words; walkthroughs about 3,000 to 4,500 words. Set `minutes` to words / 200, rounded.

## Before you report

Re-read your file once as the reader: does each diagram say something the prose doesn't? Is any number unexplained? Then report: the file path, section titles, the number of diagrams and sequences, the word count, and your `unverified` list.
