# Adding example code to existing structures

Repo: /home/claude/data-structures-visualised (Vite + TypeScript, no UI framework). The site animates data structures step by step for systems design interview prep. A new feature shows a real Python and Java implementation beside each animation, with the executing lines highlighted in step with every frame. The core and the B+ tree are done. Your job is to add the listings and the line anchors for the structures assigned to you.

## Read first
1. `docs/adding-a-structure.md`, all of it, and especially the "Example code" section. It is the specification.
2. `src/core/code.ts` (the region and anchor mark-up) and `src/core/code-contract.test.ts` (what is checked).
3. The reference: `src/structures/b-plus-tree/code/b_plus_tree.py`, `src/structures/b-plus-tree/code/BPlusTree.java`, and in `src/structures/b-plus-tree/index.ts` the `rec.line(...)` calls, the `code: [...]` on each op, the two `?raw` imports and `source: { python, java }`.
4. Then, for each structure assigned to you, read its `index.ts` (and any sibling files) carefully so you know exactly what each operation's frames do.

## For each assigned structure
1. Write `src/structures/<id>/code/<snake_name>.py` and `src/structures/<id>/code/<PascalName>.java`: complete, runnable, idiomatic implementations of the SAME algorithm the animation performs, step for step. If the animation scans linearly, the code scans linearly. If the animation uses a particular hash function, tie-break or capacity rule, so does the code. Do not show something cleverer than what is animated; add a short comment where a production version would differ.
2. Mark regions (one per operation plus shared helpers) and anchors on the lines each kind of frame executes. Same region and anchor names in both files.
3. In `index.ts`: import both files with `?raw`, add `source: { python, java }` to the definition, add `code: [...]` to EVERY op (the op's own region first, helpers after), and add `rec.line('anchor')` calls so that every frame of every op names at least one anchor in its listing. `rec.line` is sticky, so set it each time the algorithm moves to a different line.
4. Do NOT change what the animation does: no added, removed or reworded frames, no changed counters, comparisons, probes or marks, unless you find a real bug (then fix it and tell me). Existing tests must pass without being edited, apart from additions.
5. Verify the code really works. Put a harness OUTSIDE the repo (for example `/tmp/code-check/<id>/`): copy the two files there, run the Python implementation and the Java one (`javac`, `java`; Java 21) against a simple model (a set, a sorted list, a dict) for several thousand random operations each, across the structure's parameter choices where it has any. Both must pass.
6. Run, and fix until clean:
```
npx vitest run src/core/code-contract.test.ts -t "<id>"
npx vitest run src/structures/<id>
npx tsc --noEmit        # other people are editing other folders at the same time; only errors in YOUR folders are yours
npm run shot -- <id> --code
npm run shot -- <id> --java
```
7. Open several of the resulting `.shots/<id>-<n>-<op>-mid-code.png` and `-java.png` images with the Read tool and check that the highlighted line is the line the readout sentence describes, in both languages, and that nothing is cut off. Fix and re-shoot until right.

## Style of the listings
- Lines at most 80 characters after dedent, most under 60. The panel is narrow.
- Few comments, short, only where the code alone would not say why. One-line docstrings and Javadoc only. British English.
- Idiomatic names per language. Python: snake_case, no type hints needed, standard library only. Java: Java 21, standard library only, records are fine; one public top-level class per file named after the file.
- Class and field definitions that operations rely on can sit outside regions (not shown) or in a small region shown with the first operation, whichever reads better. Prefer showing only the function bodies that the frames walk through.
- No imports, printing, logging, main methods or test code inside regions.
- These words must not appear in comments: delve, leverage, robust, seamless, pivotal, crucial, landscape, realm, harness, foster, comprehensive, nuanced, intricate. No em dashes.

## Hard limits
- Only create or edit files inside the folders assigned to you. Do not touch `src/core`, `src/ui`, `src/catalog.ts`, `src/styles.css`, `scripts/`, other structures, package.json or config. If something in the core blocks you, work within what exists and tell me.
- Do not run git commit, git push or any state-changing git command. No scratch files in the repo outside `.shots/`. No long-lived dev servers.

## Report back (short)
Per structure: files added, regions and anchors used, result of the Python and Java model checks (how many operations), contract test, structure tests, tsc for your folders, what you saw in the screenshots, any bug found in the existing animation, anything you could not verify.
