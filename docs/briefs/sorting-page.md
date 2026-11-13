# A new structure page: a sorting or searching algorithm

The site (repo /home/claude/data-structures-visualised) teaches data structures and systems for interview preparation. The owner asked for "some sorting and searching algorithms, e.g. merge sort and merging 2 lists". You are building ONE page; your prompt names it. Five other agents are each building another page in the same group at the same time.

Read first, in full: CLAUDE.md; docs/adding-a-structure.md (the contract; follow it); docs/briefs/code-listings.md; src/core/types.ts; and as working examples src/structures/b-plus-tree/ (the reference), src/structures/heap/ (an array drawn as cells with index subs and pointer tags) and one more of your choice. The catalogue entry for your page is already in src/catalog.ts under the group "Sorting and searching": do not edit the catalogue or any file outside your folder src/structures/<id>/. No git commands.

## How an algorithm fits a contract written for data structures
- State is an array (or the lists) plus whatever the algorithm tracks. `seed` loads a small, interesting input (8 to 12 items) so the canvas is never empty. Operations run the algorithm on the current array, or load a new one: give an op that sets the array from typed numbers (e.g. "5 2 9 1"), ops that load telling inputs (already sorted, reversed, many equal values, random), and the algorithm op(s) themselves. Read how `args` and `suggest` work in types.ts and existing pages.
- "Follow the key" becomes: follow the item being placed or sought. The magenta probe is that item (the key searched for; the item being inserted into the sorted part; the pivot; the smaller front item being taken). Every comparison between two items is a `rec.compare` with a verdict saying what happens next ("take from the left", "go right half", "shift it right"). Show every comparison; do not skip to the answer.
- Named indices (lo, mid, hi, i, j, left, right, pivot, k) are tags (`shape: 'tag'`), on their own row under or over the cells, sliding by stable id.
- Tones: `compare` for the two cells being compared, `ok` for an item in its final sorted place or written to the output, `dim` for a range ruled out (binary search) or outside the current sub-problem, `path` for visited. Never use colour for anything else.
- Duplicates are allowed here (the "sets, not multisets" rule is for containers): a sort must handle equal values, and where stability matters the page must show it (e.g. label equal items 5a and 5b in a sub or caption and show their order kept or lost).
- Items are integers 0 to 999. Keep arrays to at most about 12 to 16 cells so the scene stays under about 950 wide; show recursion or sub-ranges with bracket decor, rows or dimming rather than a wide tree where possible.
- Counters: `comparisons` (automatic), `writes` (items moved or written), and others only if they are the point (`swaps`, `depth`).
- Operations must work with recording off and stay iterative or bounded in depth for long inputs (explicit stack if needed).
- `bench`: leave it out unless your page naturally offers insert and search over integer keys.

## The page must teach
- `tour`: four to six steps showing the behaviours worth seeing, INCLUDING the expensive or failing one (binary search missing a key and why an unsorted input breaks it; quicksort's worst case on sorted input with a bad pivot; insertion sort on reversed input; merging when one list runs out; a tie and what stability means).
- `info`: `summary` (two or three plain sentences that open the page), how it works, costs with the reasoning in one line each (why log n, why n log n, why n squared), when to use it and when not, where real systems use it, and interview points someone could say aloud. Tie it to the rest of the site where true: merge is what LSM compaction, sort-merge joins and external sort do; binary search is how a B+ tree node, an SSTable index block and a Kafka offset index are searched; top-k with a heap of k is how a leaderboard or "top queries" job works. Only state product facts you are sure of, and list in your report every such fact you did not verify so it can be checked later.
- Plain British English, short sentences, no em dashes, no filler. Say on the page what is simplified.

## Code listings
One real, runnable file per language in src/structures/<id>/code/ (Python and Java), with regions and anchors as the contract describes, lines at most 80 characters. The listing must be the algorithm the animation shows, comparison for comparison. Test both with python3 and javac/java against a simple model (the language's own sort, a linear scan) on thousands of random inputs, with the harness kept OUTSIDE the repo (/tmp/algo/<id>/). Every frame names an anchor that exists in both languages (src/core/code-contract.test.ts checks this).

## Tests and checks
Write src/structures/<id>/<id>.test.ts: correctness against a model over a few thousand random inputs (including empty, one item, all equal, sorted, reversed), counters equal with recording on and off, and the seed and tour run through the definition. Then:
```
npx vitest run src/structures/<id> src/core/code-contract.test.ts
npx tsc --noEmit
npm run shot -- <id>            # every tour step into .shots/ ; then --mobile, --code, --java
```
Read the screenshots: nothing overlapping, the probe where the comparison is, tags under the right cells, highlights that match the readout's sentence, at desktop and phone width. Fix what you see. If another agent's unfinished folder breaks a shared test, that is not yours: say so and carry on.

## Report back, briefly
What the page shows (ops, tour steps by title), the checks you ran and their results, anything you could not verify (product facts especially), and any place the contract did not fit and what you did instead.
