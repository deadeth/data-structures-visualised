# Data structures, visualised: design

Date: 2026-11-10. Approved in conversation; build went ahead on "build it, review live".

## Purpose

A public GitHub Pages site that animates common data structures and explains where each fits in a systems design, aimed at systems design interview preparation. The reference point is bplustree.app, which covers B+ trees only and has no step or speed control. This site should be better at three things: following a single key through the structure, showing every comparison, and controlling the pace.

## Decisions

- Scope: fourteen structures. B+ tree, LSM tree, skip list, trie, hash table, consistent hash ring, Bloom filter, LRU cache, binary heap, ring buffer queue, linked list, binary search tree, AVL tree, graph traversal.
- Stack: Vite and TypeScript, no UI framework. Vitest for structure logic. GitHub Actions builds and deploys to Pages.
- Repo: `deadeth/data-structures-visualised`, public.

## Architecture

Operations produce frames; the player consumes them. A frame is a complete scene (nodes, edges, decor) plus narration, the current comparison, the probe position and running counters. Structures hold plain state and a pure `layout(state)`; a recorder snapshots the layout and overlays highlights. The renderer matches nodes by id between frames and tweens positions, so structures get movement, step-back, scrubbing and speed control for free.

One shared stage on every page: a readout showing the followed key and the current comparison, the canvas, a clickable step log, transport (restart, step back, play or pause, step forward, end, scrubber), speed from 0.25× to 8×, and counters.

## Design system

- Magenta is reserved for the key being followed. Amber is "being compared now", blue is "visited", green is "found or written", red is "removed or missed".
- Type: Atkinson Hyperlegible Next for text and Atkinson Hyperlegible Mono for keys, chosen because the digits are hard to misread.
- Cool grey paper, white stage, dark ink readout strip. One dark block per page for the interview notes.

## Content per structure

What it is, what to watch, cost of each operation (average and worst), space, where it runs in production, when to reach for it, what it costs, what to say in an interview.

## Extra pages

- Home: a looping demo and a cheat sheet of every structure.
- Head to head: one workload through every structure that takes integer keys, comparing comparisons and node reads per lookup.

## Testing

Each structure has invariant tests under random operations against a simple model, checks that counters agree with recording on and off, and a run of its seed and tour. `npm run shot` screenshots every tour step for visual checks.
