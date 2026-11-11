# For coding agents

Read `CLAUDE.md`. It is the single handover document for this repo: what the site is, commands, code layout, the rules that are easy to break, how to verify before committing, how sub-agents were used, and the current state.

Then, depending on the job:

| Job | Read |
| --- | --- |
| Add or change a structure or mechanism page | `docs/adding-a-structure.md`, `docs/briefs/concept-page.md`, `docs/briefs/code-listings.md` |
| Add or change a system design page | `docs/briefs/design-page.md`, `src/designs/types.ts`, `src/designs/web-crawler.ts` |
| Review design quality | `docs/briefs/blind-reviewer.md`, `docs/adr/0007-blind-review-rounds.md` |
| Understand why something is built the way it is | `docs/adr/` |

Ground rules:

- Touch only the files your task names. One page, one folder.
- Do not edit `src/catalog.ts` or shared files unless you are the coordinating session.
- No new dependencies without asking the owner.
- Verify the exact snapshot you commit (see `CLAUDE.md`), and look at screenshots for any visual change.
- Say what you could not verify. Do not present memory as fact.
- Commit to `main` only when the owner has asked for the work; pushing deploys the live site.
