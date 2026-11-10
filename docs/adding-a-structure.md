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

**Show every comparison.** Each time the algorithm compares the key with something, call `rec.compare(left, op, right, verdict, { probe })`. `left` is the key being followed, or a value derived from it (a hash, a bit position, a distance). The readout always shows the followed key, taken from the probe, as the magenta pill; when `left` is not that key it is drawn after it in a neutral pill, so magenta never lands on a derived value. A derived `left` must say whose value it is, short enough for a pill: `h(63) = 232°`, `10: balance +1`, `E via B: 12`, `bit 25`. That is why every operation that follows a key should pass a probe at least once. `verdict` says what the result means for the next move, in lower case with no full stop: `'go left'`, `'keep scanning right'`. Mark the cell or node being compared with the `compare` tone first, then set it back (`'idle'` clears a cell mark) or to `path`.

**Tones have fixed meanings.** `path` visited, `compare` being compared now, `ok` found or written, `bad` removed, evicted or missed (drawn with a dashed outline as well as red, so it never relies on colour alone), `dim` ruled out, `key` holds the followed key. `dim` is quiet through its own colours, never through opacity, so its text still reads at 4.5:1. A box cell with empty text is drawn as an empty slot (a light dashed outline). `hue` (0 to 5) is for grouping only, such as which server owns a key. Categorical hues must stay well clear of the state colours (magenta, amber, blue, green, red) so a grouped cell is never read as a state; if you add or change one, keep ink text above 7:1 on its fill and its stroke above 4.5:1.

**Labels under cells.** `sub` is furniture by default (an array index), drawn in the text face at label size. Set `subValue: true` when the label is data the reader should track, such as a distance so far; it is then drawn in the mono face at full weight.

**Counters.** Use `comparisons` (added for you by `rec.compare`), `reads` for nodes, buckets, pages or tables touched, and `writes` for nodes or slots written. Add others only when they are the point of the structure (`evictions`, `moved`). List the ones to display in `counters`.

**Narration.** One or two plain sentences per step that say what is happening and why it is done that way. British English. No jargon without explaining it. The final frame of every operation states the outcome and, where it helps, the cost ("read 3 nodes for 40 keys").

**Stable ids.** A node keeps the same `id` for as long as it is the same thing, so the renderer can slide it to its new position. Give a new node a `from` id when it splits off or is copied from another, and it will grow out of that node.

**Work with recording off.** The head-to-head page runs operations with `rec.recording === false`. Operations must still mutate state and count correctly, and must not rely on frames. Keep them iterative where the depth can reach thousands (an unbalanced tree fed sorted keys), or the stack will overflow.

**Sets, not multisets.** Inserting a key that is already present is a no-op with a sentence saying so.

**Keys.** Integers from 0 to 999 unless the structure is about strings.

## Layout

`layout(state)` returns absolute positions in px for a scene roughly 700 to 1000 wide and up to about 380 tall. The renderer scales the scene to fit, but never below 0.75 in either direction (cell text would drop under 12 CSS px): a scene that is still too wide makes the canvas scroll sideways, following the probe, and one too tall for a short screen (a phone held sideways) makes the canvas taller and the page scrolls. So keep scenes compact. Aim for no more than about 950 wide, so the scene fits beside the step log on a 1440px screen without scrolling, and avoid overlaps. Labels (titles, captions, subs, decor and edge labels) are drawn at 14px in scene units and grow as the scale falls, up to 16px at 0.75, so they never render under 12 CSS px: leave room for them at 16px (`LABEL_MAX` in `src/core/fit.ts`). The probe chip is 28px tall with 17px text; when a layout has to keep clear of it, use `probeWidth(text)` and `PROBE_H` from `src/core/fit.ts` rather than copying the numbers. Use the helpers in `src/core/geometry.ts`:

- `boxWidth(texts)` and `nodeSize(node)` for the drawn size of a node
- `tidyTree({ root, children, width })` for any tree (pass `null` children to keep left and right apart in binary trees)
- `CELL_H`, `cellWidth` for grids and rows

Leave about 44px of clear space above any node the probe will visit (`PROBE_H + 16`). Node shapes are `box` (default, one or many cells) and `circle`. Edge kinds are `tree`, `side` and `line`. `decor` gives you a ring, lane bands and text labels.

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
