# 0006. Design pages are data, and the diagram stays simple

Status: accepted

## Decision
A system design page is one `Design` object (`src/designs/types.ts`) rendered by `src/ui/design-page.ts`: components, connections with a communication mode and method, a tour, and notes. A new design is a new data file.

Diagram rules, learned from four review rounds on the crawler page:
- About 14 chips visible at rest. Thirty was "crowded" however carefully they were spaced.
- One line per pair of boxes; request and reply share it.
- In-process calls are thin unchipped arrows; their chip appears when live or selected.
- Recovery and reprocessing paths are hidden behind a toggle in the key and shown when a step, detail or link needs them.
- Purpose labels show only for the live line or the open box; the detail panel's "Talks to" list carries the rest.
- The whole diagram and key fit one screen at 1440x900 and 1366x768.
- The tour token is a small dot with a label on a pill. Its side is fixed per leg; it does not hunt for free space.
- On phones the view zooms to fit each step; the readout carries the words.
- Keyboard: the diagram is one tab stop with arrow-key movement; tour keys act only on the transport.

## Consequences
Collision-free layout is checked by scripts, not by eye. Those scripts lived in the git-ignored `.shots/` folder of the session that wrote them and are not in the repo; rebuild them from the acceptance lists in `docs/briefs/design-page.md` if they are gone.
