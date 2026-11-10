# Data structures, visualised

Step through the data structures behind real systems. Follow one key, see every comparison, set your own pace.

**Live site: https://deadeth.github.io/data-structures-visualised/**

Each page runs the real algorithm one step at a time:

- The key you are following is always magenta, and it moves to wherever it is being compared.
- Every comparison is written out (`58 > 48`) with what it means for the next move.
- Play, pause, step forwards and backwards, drag through the steps, or change speed from 0.25× to 8×.
- Counters show comparisons and node reads for the operation, so the cost is a number you watched add up.
- Switch the side panel from Steps to Code to see a real implementation in Python or Java, with the line being executed highlighted as the animation plays.
- Underneath: what each operation costs, which production systems use the structure, when to reach for it, what it costs you, and what to say about it in a systems design interview.

Keyboard: space plays and pauses, the arrow keys step, `[` and `]` change speed.

## Structures

| Storage and indexes | Hashing and distribution | Caches and queues | Foundations |
| --- | --- | --- | --- |
| B+ tree | Hash table | LRU cache | Stack |
| LSM tree | Consistent hash ring | Binary heap | Queue |
| Skip list | Bloom filter | Ring buffer queue | Priority queue |
| Trie | | | Linked list |
| | | | Binary search tree |
| | | | AVL tree |
| | | | Graph traversal |

The head-to-head page runs one workload through every structure that can take it and compares the work per lookup.

## Run it locally

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests for every structure
npm run build      # type-check and build into dist/
npm run shot -- b-plus-tree   # screenshots of a page's tour into .shots/ (needs Chrome)
npm run shot -- b-plus-tree --code   # the same with the code panel showing
```

## How it works

A structure never draws anything. Its operations mutate plain state and ask a recorder for a snapshot at each interesting moment. A snapshot is a complete scene plus the narration, the comparison and the running counters. The player moves through those snapshots and the renderer tweens between them, matching nodes by id. That is why stepping backwards and scrubbing work everywhere without any per-structure code.

```
src/core/        types, recorder, renderer (SVG), player, layout helpers
src/ui/          stage (readout, canvas, step log, transport), pages
src/structures/  one folder per structure: logic, layout, written content, tests,
                 and code/ with the Python and Java listings
src/catalog.ts   the list of structures and the cheat sheet
```

To add a structure, see [docs/adding-a-structure.md](docs/adding-a-structure.md).

Built with Vite and TypeScript, no runtime dependencies beyond the fonts (Atkinson Hyperlegible Next and Mono, chosen because the digits are hard to misread).
