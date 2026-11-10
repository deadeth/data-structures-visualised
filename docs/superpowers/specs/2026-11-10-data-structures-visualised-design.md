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

Stage rules (design council round 1):

- The readout always shows the followed key (the latest probe of the operation) as the magenta pill. A comparison whose left side is that key reads `[key] op [right]`; one about a derived value (a hash, a bit, a distance) shows the key, then the value in a neutral pill. Between comparisons the key stays, dimmed. Before any operation the chip column collapses; during one it has a fixed width, and the sentence a fixed height, so nothing shifts between steps.
- Scene text never renders below 12 CSS px (scale at least 0.75). A scene that is still too wide scrolls sideways and follows the probe. On narrow screens the canvas takes the height of its content (up to 70% of the viewport); on wider ones it grows only if a scene would otherwise be squeezed.
- Order is readout, canvas, transport, counters, step log. At 1200px and above the log sits beside the canvas; below that it goes under the counters as an "All steps" disclosure, folded away on phones. Steps not yet reached show only their number.
- Space always plays or pauses (except in text fields), the arrows step, `[` and `]` change speed. Slow speeds slow the movement too (by the square root of the slow-down). Screen readers hear a step when the reader moves through steps, pauses or reaches the end, never during playback; the home demo is never announced and does not start itself under reduced motion.

## Design system

- Magenta is reserved for the key being followed. Amber is "being compared now", blue is "visited", green is "found or written", red is "removed or missed" (also dashed, so it does not rely on colour). Categorical hues for grouping stay clear of all five. Charts use a neutral grey, not amber.
- Type: Atkinson Hyperlegible Next for text and Atkinson Hyperlegible Mono for keys, chosen because the digits are hard to misread.
- Cool grey paper, white stage, dark ink readout strip. One dark block per page for the interview notes.

## Content per structure

What it is, what to watch, cost of each operation (average and worst), space, where it runs in production, when to reach for it, what it costs, what to say in an interview.

## Extra pages

- Home: a looping demo and a cheat sheet of every structure.
- Head to head: one workload through every structure that takes integer keys, comparing comparisons and node reads per lookup.

## Testing

Each structure has invariant tests under random operations against a simple model, checks that counters agree with recording on and off, and a run of its seed and tour. `npm run shot` screenshots every tour step for visual checks.
