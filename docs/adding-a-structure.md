# Adding a structure

Every structure lives in its own folder, `src/structures/<id>/`, and default-exports a `StructureDef` from `index.ts`. The id must match an entry in `src/catalog.ts`. Nothing else needs registering: the page, the sidebar link and the cheat-sheet link go live when the file exists.

`src/structures/b-plus-tree/` is the reference implementation. Read it first, along with `src/core/types.ts`.

## How it fits together

A structure never draws. Its operations mutate plain state and call the recorder at each interesting moment. The recorder calls your `layout(state)` to get a `Scene`, overlays any highlights you have set, and stores the result as a `Frame`. The player then moves through the frames, which is why stepping backwards and scrubbing need no extra work from you.

```
op.run(state, args, rec)
   ├─ rec.mark / rec.markCell / rec.markEdge   sticky highlights, by id
   ├─ rec.compare(key, '<', other, verdict)    counts a comparison and snapshots a frame
   ├─ rec.step(message, { probe })             snapshots a frame
   └─ rec.count('reads')                       bumps a counter
```

## Rules that make the pages feel like one site

**Follow the key.** Pass a `probe` on every frame where the key is "somewhere": `{ text: '42', at: nodeId, cell?: i }`. The magenta chip travels to that node. Magenta means the followed key and nothing else, so only use the `key` tone for the cell that holds that key.

**Show every comparison.** Each time the algorithm compares the key with something, call `rec.compare(left, op, right, verdict, { probe })`. `left` is the key being followed. `verdict` says what the result means for the next move, in lower case with no full stop: `'go left'`, `'keep scanning right'`. Mark the cell or node being compared with the `compare` tone first, then set it back (`'idle'` clears a cell mark) or to `path`.

**Tones have fixed meanings.** `path` visited, `compare` being compared now, `ok` found or written, `bad` removed, evicted or missed, `dim` ruled out, `key` holds the followed key. `hue` (0 to 5) is for grouping only, such as which server owns a key.

**Counters.** Use `comparisons` (added for you by `rec.compare`), `reads` for nodes, buckets, pages or tables touched, and `writes` for nodes or slots written. Add others only when they are the point of the structure (`evictions`, `moved`). List the ones to display in `counters`.

**Narration.** One or two plain sentences per step that say what is happening and why it is done that way. British English. No jargon without explaining it. The final frame of every operation states the outcome and, where it helps, the cost ("read 3 nodes for 40 keys").

**Stable ids.** A node keeps the same `id` for as long as it is the same thing, so the renderer can slide it to its new position. Give a new node a `from` id when it splits off or is copied from another, and it will grow out of that node.

**Work with recording off.** The head-to-head page runs operations with `rec.recording === false`. Operations must still mutate state and count correctly, and must not rely on frames. Keep them iterative where the depth can reach thousands (an unbalanced tree fed sorted keys), or the stack will overflow.

**Sets, not multisets.** Inserting a key that is already present is a no-op with a sentence saying so.

**Keys.** Integers from 0 to 999 unless the structure is about strings.

## Layout

`layout(state)` returns absolute positions in px for a scene roughly 700 to 1000 wide and up to about 380 tall. The renderer scales the scene to fit, so do not chase exact sizes, but do avoid overlaps. Use the helpers in `src/core/geometry.ts`:

- `boxWidth(texts)` and `nodeSize(node)` for the drawn size of a node
- `tidyTree({ root, children, width })` for any tree (pass `null` children to keep left and right apart in binary trees)
- `CELL_H`, `cellWidth` for grids and rows

Leave about 44px of clear space above any node the probe will visit. Node shapes are `box` (default, one or many cells) and `circle`. Edge kinds are `tree`, `side` and `line`. `decor` gives you a ring, lane bands and text labels.

## What a definition needs

- `seed`: starting contents so the canvas is never empty
- `ops`: each with `args`, `run` and, ideally, `suggest` so an empty input box does something interesting
- `tour`: four to six steps that show the behaviours worth seeing, including the expensive one (a split, a resize, an eviction, a rotation)
- `status`: two to four live facts (size, height, load factor)
- `fill`: optional, one random insert, used by "Add 8 random keys"
- `bench`: optional, `{ insert, search }` op ids if the structure can take integer keys for the head-to-head page
- `info`: the written content. Be specific: name real systems and what they use the structure for, and write interview points someone could say out loud. Check facts; do not guess.

## Checking your work

```
npx vitest run src/structures/<id>      # logic and invariants
npx tsc --noEmit                        # types
npm run shot -- <id>                    # screenshots of every tour step into .shots/
```

Open the screenshots and look at them: nothing overlapping, the probe sitting where the comparison is, highlights that match the sentence in the readout. A test file should check the structure's invariants under a few thousand random operations against a simple model (a `Set`, a sorted array), check that counters match with recording on and off, and run the seed and tour through the definition.
