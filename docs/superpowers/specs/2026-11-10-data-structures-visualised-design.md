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

- The readout always shows the followed key (the latest probe of the operation) as the magenta pill. A comparison whose left side is that key reads `[key] op [right]`; one about a derived value (a hash, a bit, a distance) shows the key, then the value in a neutral pill that names whose value it is (`h(63) = 232°`, `E via B: 12`). Between comparisons the key stays, dimmed.
- The readout is one stacked composition at every width (design council round 2): a 44px row of chips, then the sentence under it from the same left edge. Before any operation there is no chip row. The sentence is clamped to three lines (the full text is in the step log and is what a screen reader hears) and keeps one height through an operation: its longest message, at most three lines, at least two on a wide screen.
- No text in the scene renders below 12 CSS px: the scale is never below 0.75 across the width or the height, and labels grow from 14 to 16 scene px as the scale falls. A scene too wide scrolls sideways; one too tall for a short screen (a phone held sideways) makes the canvas taller and the page scrolls. On narrow screens the canvas takes the height of its content, leaving room on screen for the readout and the transport; on wider ones it grows only if a scene would otherwise be squeezed.
- A canvas that scrolls sideways is panned by the renderer's own tween, on the same clock and easing as the chip, so the chip never leaves the view; a hop that fits is framed whole. With no probe the view centres on what is marked, or on the scene (the root of a tree). The last frame shows as much of the result as it can without losing the chip. The edge with more scene beyond it fades. Whether the canvas is a scroll region (focusable, named, arrows pan it, with a visible hint while focused) is decided once per operation.
- Starting an operation brings the readout, the canvas and the transport into view at every width, scrolling as little as possible. While there is something to play and the stage is taller than the screen, the transport sticks to the bottom of the screen.
- Order is readout, canvas, transport, counters, step log. At 1200px and above the log sits beside the canvas; below that it goes under the counters as an "All steps" disclosure, folded away on phones. Steps not yet reached show only their number.
- Space always plays or pauses (except in text fields and on the "All steps" disclosure), the arrows step, `[` and `]` change speed. Changing speed mid-step keeps the part of the step already spent. Slow speeds slow the movement too (by the square root of the slow-down). Screen readers hear a step when the reader moves through steps, pauses or reaches the end, never during playback; the home demo is never announced and does not start itself under reduced motion.

## Design system

- Magenta is reserved for the key being followed. Amber is "being compared now", blue is "visited", green is "found or written", red is "removed or missed" (also dashed, so it does not rely on colour). "Ruled out" is quiet through lighter colours, never through opacity. Structural lines (edges, the ring) are at least 3:1 against white. An empty slot has a light dashed outline. Categorical hues for grouping stay clear of all five. Charts use a neutral grey, not amber.
- Type: Atkinson Hyperlegible Next for text and Atkinson Hyperlegible Mono for keys, chosen because the digits are hard to misread.
- Cool grey paper, white stage, dark ink readout strip. One dark block per page for the interview notes.

## Content per structure

What it is, what to watch, cost of each operation (average and worst), space, where it runs in production, when to reach for it, what it costs, what to say in an interview.

## Extra pages

- Home: a looping demo and a cheat sheet of every structure.
- Head to head: one workload through every structure that takes integer keys, comparing comparisons and node reads per lookup.

## Testing

Each structure has invariant tests under random operations against a simple model, checks that counters agree with recording on and off, and a run of its seed and tour. `npm run shot` screenshots every tour step for visual checks.

## Example code (added 2026-11-10)

Each structure keeps one real, runnable file per language (Python and Java) under `src/structures/<id>/code/`. Comments mark regions (one per operation and helper) and anchors (named lines). An operation lists the regions to show; each frame names the anchors it is executing; those lines are highlighted.

Layout (design council round 3, and the owner's request that steps and code show together): the step log always shows; a remembered Code on/off toggle (aria-pressed) adds the code, with a Python/Java switch in the code's own header. From 1360px with Code on, the side column is `clamp(380px, 38%, 480px)` and stacks the log (about 38% of its height, never under 150px) above the listing, each scrolling and following on its own. From 1200 to 1359px the log keeps its 300px column and the code is a window under the canvas, above the transport, up to eight rows (fewer when a tall scene needs the canvas height). From 900 to 1199px the same window, with the log as the open "All steps" disclosure under the counters. Under 900px the window is a three-row strip and the disclosure is folded. The window scrolls (keyboard and touch) to the rest of the listing. The listing follows the live lines with the canvas's own tween and easing (jumping when the movement is under 300ms or over a panel height), puts the first live line about 30% down with the function's signature in view when it fits, never cuts a row at the top, and when highlighted runs do not fit together shows the run of the last-named anchor with a "N more above/below" button for the rest. Wrapped lines hang 2ch under their own indent. Live rows carry a visually hidden "Running:" prefix, and with Code on the status announcement ends with the line numbers when the reader stops or steps. The listing must be the same algorithm as the animation, step for step. `src/core/code-contract.test.ts` checks that every operation has both listings, that they carry the same anchors, and that every frame names lines that exist.

## Simpler structures (added 2026-11-10)

Stack (array with a top index, doubling growth), Queue (linked list with head and tail) and Priority queue (sorted array with binary-search insertion, pointing to the binary heap page for the faster version) join the Foundations group.
