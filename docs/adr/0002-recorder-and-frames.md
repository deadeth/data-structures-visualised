# 0002. Operations record full frames; the player only replays them

Status: accepted

## Context
The point of the site is to follow one key through every comparison, at any speed, forwards and backwards.

## Decision
A structure's operation mutates plain state and calls a `Recorder` (`rec.step`, `rec.compare`, `rec.mark`, `rec.line`, counters). Each call captures one `Frame`: a complete `Scene` (nodes, edges, labels), a sentence, an optional comparison for the readout, counters, and the code anchors that are running. The `Player` only steps through frames; the `Renderer` tweens between scenes by node id.

The same operation runs with recording off for tests and for the head-to-head benchmark, and must produce the same counters.

## Consequences
- Stepping back, scrubbing and speed changes are trivial and always correct.
- An operation with many steps makes many full scenes; pages keep their models small (about 940 by 420 units).
- Layout is a pure function of state, so it can be tested: no overlaps, fixed corners, text sizes.
- The contract a page must meet is in `docs/adding-a-structure.md`.
