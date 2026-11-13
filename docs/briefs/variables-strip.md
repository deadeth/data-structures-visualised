# A "Variables" strip beside every code listing

The owner asked: "in the code windows can you add a small debug panel that shows the current values of variables". The mechanism is built: `Rec.vars(values)` in src/core/types.ts and src/core/recorder.ts, shown by src/ui/code-panel.ts as a strip of name = value pairs between the code header and the listing, with the value that just changed outlined. Read the new paragraph "Show the variables" in docs/adding-a-structure.md, the `vars` doc comment on `Rec`, and CLAUDE.md.

Your job: for each page folder named in your prompt (src/structures/<id>/), add `rec.vars(...)` calls to the operations in its source (index.ts and any helper modules in the folder the operations live in) so that on every frame where the listing is lit, the strip shows the listing's variables at that point. Edit only those folders. No git commands. Do not change what the animation does, its messages, counters, frames or listings: only add `rec.vars` calls (and tiny local variables if you need one to hold a value the listing computes).

Rules
- Names are the listing's own variable names (look at code/*.py and the Java file): `key`, `node`, `lo`, `hi`, `mid`, `i`, `j`, `h`, `bucket`, `term`, `leader`. Where Python and Java differ only in case style, use the Python name. Indexed values that the code reads are welcome as their own entry: `'a[mid]': 42`.
- Values are what the code would hold: numbers, strings, booleans, `null`, short lists (`[5, 2, 9]`). For an object the listing holds by reference, show its identifying value (`node: 42` for the node whose first key is 42, `leaf: '[20, 27, 36]'`, `'node.next': null`). Never a sentence. Long lists are cut by the recorder.
- At most about six entries at a time, in a steady order (the operation's arguments first, then loop variables, then derived values), so entries do not jump about between frames.
- Each call replaces the whole set. Call it before the `rec.step` or `rec.compare` that shows the new values, wherever `rec.line` moves on or a variable changes. Clear with `rec.vars()` at the start of each operation's run, and when a helper's variables go out of scope if the next frames belong to other code.
- Every operation that has a listing should show variables on its frames. A frame that lights no code (a preset load with a one-line listing, a pure narration frame) may show just the arguments or nothing.
- For pages about a protocol or a system (TCP, Raft, two-phase commit, sagas, MVCC and the like) the listing still has variables: the message being handled, the state, counters, the transaction id, version numbers. Show those.
- Operations must still work with recording off; `rec.vars` is a no-op there, so build its argument cheaply or guard heavy formatting with `if (rec.recording)`.

Check
```
npx tsc --noEmit
npx vitest run src/structures/<id> src/core/code-contract.test.ts      # for each of your pages
npm run shot -- <id> --code                                               # read two or three mid-tour PNGs per page
```
In the screenshots the strip must show sensible values that match the lit lines and the picture (the index under the `mid` tag equals `mid` in the strip), fit without pushing the listing out of view, and not carry stale values into the next operation. If another agent's unfinished folder breaks a shared check, that is not yours: say so.

Report back, briefly: per page, which operations now show variables and which names; anything you could not show and why; any page where the listing's variables do not map onto the animation.
