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

**Pointers are tags.** A named index or pointer that marks a slot or node (`top`, `head`, `tail`, `lo`, `hi`) is a node with `shape: 'tag'`: white, a 1.5px secondary-ink outline, the text face at 600 at label size. One style on every page; never give it a hue or a tone. Put it beside or under what it points at, on a row of its own when two can share a slot, and slide it by keeping its id.

**Labels can break.** A newline in a `caption` or a decor label breaks it onto a second line. Keep notes to two lines of about 22 characters on narrow scenes, and keep a caption no wider than about two slots, so it reads as belonging to its own node. Titles, captions and edge labels count towards the scene's bounds, so a long one shrinks the scene.

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

Leave about 44px of clear space above any node the probe will visit (`PROBE_H + 16`). The resting picture between operations has no chip, so it is fitted without that room, which lets the canvas be shorter at rest; a layout needs no change for this.

On a phone most scenes are wider than the canvas and scroll sideways. The view is nudged so its edges fall between cells and labels rather than across them, so keep notes and captions short (break them with a newline) and no wider than what they label; a long note beside a row can never be shown whole at phone width. Row labels on the left scroll out of view on a phone, so put anything the reader needs to tell rows apart into the row itself (the append-only log puts the group letter in its `pos` tags). Node shapes are `box` (default, one or many cells) and `circle`. Edge kinds are `tree`, `side` and `line`. `decor` gives you a ring, lane bands and text labels.

## What a definition needs

- `seed`: starting contents so the canvas is never empty
- `seedFor`: optional, a seed for other parameter values when `seed` would not suit them (a consume on a partition that does not exist with fewer partitions, more records than a smaller structure holds). The page runs `seedFor(params)` in place of `seed` when it is there; `src/structures/append-log/` has an example. Never let a seed operation be a silent no-op
- `ops`: each with `args`, `run` and, ideally, `suggest` so an empty input box does something interesting
- `tour`: four to six steps that show the behaviours worth seeing, including the expensive one (a split, a resize, an eviction, a rotation)
- `status`: two to four live facts (size, height, load factor)
- `fill`: optional, one random insert, used by "Add 8 random keys"
- `bench`: optional, `{ insert, search }` op ids if the structure can take integer keys for the head-to-head page
- `info`: the written content. Be specific: name real systems and what they use the structure for, and write interview points someone could say out loud. Check facts; do not guess.

## Example code

Every structure ships a real implementation in Python and in Java, shown with the steps when the reader turns Code on. The lines being executed are highlighted in step with the animation. From 1360px wide the side column holds the step log on top and the listing below; narrower, the listing is a window under the canvas (eight rows at most, three on a phone) that follows the live lines and scrolls to the rest. Long lines wrap with a hanging indent, so write them to read well wrapped. `src/structures/b-plus-tree/` is the reference: read `code/b_plus_tree.py`, `code/BPlusTree.java` and the `rec.line(...)` calls in `index.ts`.

**One real file per language**, in `src/structures/<id>/code/`, imported as text (`import python from './code/name.py?raw'`) and passed as `source: { python, java }` on the definition. The files must run: check the Python with `python3` and the Java with `javac` and `java` (both are installed) against a simple model under thousands of random operations. Keep the test harness outside the repo; only the implementation is shown.

**Regions and anchors.** Two kinds of comment mark the file up and are never shown:

```
# region insert          // region insert          start of a named block
# endregion              // endregion              end of it
node = self.root  #@start      Node node = root; //@start      this line is the "start" anchor
```

An operation lists the regions to show, most important first: `code: ['insert', 'split', 'find_leaf']`. The same region and anchor names must exist in both languages. An anchor can sit on several lines, and a line can carry several (`#@scan,found`).

**Light the test.** On a comparison frame, light the line that makes the comparison the readout shows (the `if` or `while`), plus the branch it takes. A three-way decision per key (`if key < x` / `elif key > x` / `else`) counts as one comparison, as the animation does. When a frame lights two places (a call and the helper it calls), name the helper's anchor last: the listing scrolls to the last-named anchor when both do not fit, and offers a control to reach the other.

**Frames name anchors.** Call `rec.line('anchor')` before the step or comparison that executes that line. It is sticky: it applies to every frame until the next call, so set it whenever the algorithm moves on. Pass several names to light several places at once (`rec.line('split_leaf', 'push_up')`). Every frame of an operation must name at least one anchor that its listing has.

**Show the variables.** Beside the listing a "Variables" strip shows what the code's variables hold at the current step, like a debugger's watch window. Call `rec.vars({ lo, hi, mid, 'a[mid]': a[mid] })` whenever they change, before the step or comparison that shows the new values. It is sticky like `rec.line`, and each call replaces the whole set, so pass every variable in scope at that point, in a steady order (inputs first, then loop variables, then derived values), named exactly as the listing names them. Use the Python names when the two listings differ only in case style (`new_node` and `newNode`), and prefer names both share. Values are numbers, strings, booleans, `null`, or short lists; show what the code would hold (an index, a key, a node's key such as `node: 42`, a list as `[5, 2, 9]`), never a sentence. Keep it to about six variables at most: the ones a reader would watch. Call `rec.vars()` with no arguments when the variables go out of scope (the function returns, a new operation starts) so stale values never linger. A value that changed since the last frame is outlined for the reader automatically. With recording off the call does nothing.

**Write the code to match the animation**, not the other way round. If the animation compares the key with each separator in turn, the listing has a loop that does exactly that, so each comparison frame can point at it. Do not show a cleverer algorithm than the one being animated (say so in a short comment if a real implementation would differ, such as binary search inside a node).

**Keep it readable in a narrow panel.** Lines at most 80 characters after the region is dedented, and most under 60. Short comments only, and only where the code alone would not say why. One-line docstrings and Javadoc. Idiomatic names for each language (`find_leaf` in Python, `findLeaf` in Java). No imports, logging or test code inside regions.

`src/core/code-contract.test.ts` checks all of this for every structure: each operation has a listing in both languages, both carry the same anchors, and every frame of the tour and of a dozen suggested runs names anchors that exist.

## Checking your work

```
npx vitest run src/structures/<id>      # logic and invariants
npx tsc --noEmit                        # types
npm run shot -- <id>                    # screenshots of every tour step into .shots/
npm run shot -- <id> --code             # the same with the Python listing showing (--java for Java)
```

Open the screenshots and look at them: nothing overlapping, the probe sitting where the comparison is, highlights that match the sentence in the readout. A test file should check the structure's invariants under a few thousand random operations against a simple model (a `Set`, a sorted array), check that counters match with recording on and off, and run the seed and tour through the definition.
