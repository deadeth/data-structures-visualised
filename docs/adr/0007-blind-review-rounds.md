# 0007. Design quality is judged by blind review rounds

Status: accepted

## Context
The owner asked for the design to be reviewed and improved until three reviewers give 9 out of 10 in every category, and later that reviewers must not know earlier scores or each other's.

## Decision
Each round: three fresh reviewers (visual design; accessibility and responsive layout; interaction and motion) score six categories from a frozen build, with no history. Brief: `docs/briefs/blind-reviewer.md`. Their reports, with scores removed, go to an implementer. The coordinator verifies, commits, rebuilds the frozen build and runs the next round.

## What we learned
- Reviewers who know their earlier scores drift upwards. Blind scores started lower and were more useful.
- Reviewers must measure: overlaps by bounding box, contrast by number, every animation frame sampled. The frame-by-frame motion reviews found the real bugs (pause not pausing, steps skipped on a speed change).
- A fresh reviewer always finds about six new things. Scores plateau at 8 in a lens while 9 holds in another; past that point the findings are taste. Agree a stopping rule with the owner.
- Following each reviewer's suggested fix literally causes ping-pong: one round asks for no zoom, the next for zoom. When a topic comes back twice, the coordinator decides and writes the decision into the brief.
- Structural changes move scores; polish does not. Cutting the diagram from 30 chips to 14 did more than three rounds of spacing fixes.
- Reviewers must use a frozen build, or edits by other agents corrupt their measurements.
