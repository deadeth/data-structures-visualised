# 0009. Mechanisms use the same engine as data structures

Status: accepted

## Context
The owner asked for the concepts of a 60-video systems design playlist to be covered. Most are mechanisms (Raft, two-phase commit, isolation levels, quorums, stream checkpoints), not data structures.

## Decision
Model each mechanism small enough to draw (two to five nodes or transactions) and build it as a normal structure page: the followed thing is a transaction, write or message; the tour must include the failure the mechanism exists to handle; the listings are a deterministic single-process simulation.

Comparison topics that do not animate (SQL vs NoSQL, Kafka vs RabbitMQ and so on) are to be written notes pages, not forced into the engine. That page type is not built yet.

## Consequences
- One engine, one visual language, one set of tests for everything animated.
- Some pages need to change a setting mid-tour and do it through an operation, so a dropdown can disagree with the state. A shared answer (letting a tour set parameters) would be better.
- The cheat-sheet columns (lookup, insert, remove, ordered) are used loosely for mechanisms.
