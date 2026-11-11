# 0004. Example code is real, runnable and model-checked; frames name its lines

Status: accepted

## Decision
- Each page ships one real Python file and one real Java file in `src/structures/<id>/code/`, imported with `?raw`.
- Listings are marked up with regions (`# region name` / `# endregion`, Java `// region`) and anchors (`#@name`, Java `//@name`). An operation lists the regions it shows; each frame names the anchors that are running.
- `src/core/code-contract.test.ts` runs every page's seed, tour and suggestions and fails if any frame names an anchor missing from either language, or a line is over 80 characters.
- Before a page ships, both listings are run against a simple model over thousands of random operations, with the harness kept outside the repo. The serialisation page went further and compared bytes with the real protobuf and Avro libraries.

## Consequences
- The code a reader sees is the algorithm the animation runs, not pseudo-code that drifted.
- Model checks have caught real bugs (Raft's write acknowledgement; an SSI check that would have been vacuous).
- The TypeScript model and the two listings are three implementations to keep in step.
- Only the mechanics are checked this way. Prose claims about products are not.
