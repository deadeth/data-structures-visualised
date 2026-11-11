# 0008. One sub-agent per page; the coordinator owns shared files

Status: accepted

## Decision
Pages are built in parallel by sub-agents, one page each, each writing only `src/structures/<id>/` or `src/designs/<id>.ts`. The coordinating session owns `src/catalog.ts`, `src/main.ts`, `src/core/*`, `src/ui/*` and `src/styles.css`, adds catalogue entries, verifies a staged snapshot and commits.

## Why
Parallel agents editing shared files corrupt each other's work and each other's measurements. Folder ownership makes parallel work safe without branches.

## Consequences
- Agents cannot see their page in the real site until the coordinator registers it; they preview in a scratch copy.
- Changes that need a shared file (a table slot in page notes, links between pages) queue up behind the coordinator.
- Half-written folders from running agents break `tsc` for the whole tree, so the coordinator verifies a staged snapshot, never the working tree.
