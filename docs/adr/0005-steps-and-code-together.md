# 0005. Steps and code are visible together

Status: accepted (replaces an earlier Steps | Code switch)

## Context
The owner asked that the step log and the code be visible at the same time.

## Decision
"Code" is one on/off button (stored as `dsv.code`). The step log always shows.
- 1360px and wider: one side column, log above code, each following the current step.
- 1200 to 1359px: log beside the canvas, code in a window under the canvas.
- 900 to 1199px: code window under the canvas, log in an open disclosure below.
- Under 900px: a three-line code strip, log folded.
- Landscape phones (height under 500px): the code window is left out with a note.

## Consequences
The canvas is narrower with code on, so scenes are budgeted for it. A page whose scene cannot fit beside the code at 0.75 scale drops to the next layout down (skip list at 1440).
