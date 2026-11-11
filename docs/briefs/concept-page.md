# Brief: add one concept page to "Data structures, visualised"

Repo: /home/claude/data-structures-visualised (Vite + TypeScript, no UI framework). The site animates data structures and, now, the core mechanisms of distributed systems, for systems design interview preparation. Every page uses the same engine: an operation mutates plain state and records frames; each frame is a picture, one sentence, an optional comparison, and the lines of a Python and a Java listing that are running. A page follows ONE thing (magenta) step by step: a key, a transaction, a message, a write.

Your page teaches a mechanism, not a data structure, but it uses the same engine. Model it small enough to draw (2 to 5 nodes/replicas/transactions, a handful of keys), deterministic, and honest: say plainly on the page what is simplified.

Read first, in this order:
1. docs/adding-a-structure.md (the contract: Recorder, scenes, tones, tags, tour, info, example code, seedFor, phone rules).
2. docs/briefs/code-listings.md (rules for the Python and Java listings: regions, anchors, 80 characters, real runnable code).
3. Two finished pages that also model a mechanism, all files: src/structures/append-log/ and src/structures/token-bucket/. Also skim src/structures/crawl-frontier/.
4. src/core/types.ts and src/core/recorder.ts.

Deliver, all inside src/structures/<your id>/ and nowhere else:
- index.ts (StructureDef: state, ops, seed, tour of 4 to 7 steps, suggest, layout, source), info.ts (written content), <id>.test.ts, code/<name>.py and code/<Name>.java.
- Every frame names at least one existing anchor in both listings (src/core/code-contract.test.ts will enforce it once I add the catalogue entry; do NOT edit src/catalog.ts or any file outside your folder).
- Colour rules: magenta only for the thing being followed; amber compared; blue visited; green committed/found/written; red dashed rejected/aborted/removed; named pointers and markers use `shape: 'tag'`. Scene at most about 940 units wide and 420 tall so it fits 1440x900 beside the code and pans sensibly on a phone; no text under 12px.
- The tour must show the failure or anomaly the mechanism exists to prevent or handle, not only the happy path.
- Written content (info.ts): plain British English, short sentences, concrete numbers. What it is, how it works, cost, where real systems use it (name them, and only claim what you are sure of), when not to use it, what to say in an interview. No filler. List anything you could not verify.
- Compile and run the Python and the Java yourself against a randomised check (thousands of operations against a simple model) to prove the listings are correct.

Checks before you report (run them, paste the result lines):
- `npx tsc --noEmit` (errors in other folders are other agents' work in progress: report, don't fix)
- `npx vitest run src/structures/<your id>`
- Look at your page: make a scratch copy of the repo under /tmp (cp -r without node_modules, symlink node_modules), add your catalogue entry THERE, run `npm run shot -- <id>`, `--code`, `--mobile` there, and read the screenshots. Fix what you see. Do not edit the real catalogue.

Do not run git commands that change anything. Many other agents are working in the repo at the same time: touch only your own folder.
Final message: files written, check results, the catalogue entry you propose (id, name, blurb of at most 110 characters, cheat row: lookup, insert, remove, ordered, pick; use the columns loosely for a mechanism, for example lookup = read cost, insert = write cost, remove = what it gives up, ordered = ordering guarantee, pick = when to choose it), the tour, simplifications, and facts you could not verify.
