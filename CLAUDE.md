# Working on this repo

This file is the handover for any coding session, human or agent. Read it first. `AGENTS.md` points here.

## What this is

A static teaching site: https://deadeth.github.io/data-structures-visualised/

It is built for systems design interview preparation. It has three kinds of page:

1. **Structure pages** (`#/s/<id>`): one data structure or one distributed-systems mechanism, animated step by step. You follow one key, transaction or message; every comparison is shown; Python and Java listings light up in step. There are about 40, listed in `src/catalog.ts`.
2. **Design pages** (`#/d/<id>`): an interactive high-level design with a guided tour, clickable components and connections, and interview notes. The web crawler is the reference. Ledger, suspicious-transaction alerts and card processing were in progress when this file was written (see "State").
3. **Search** (`#/search/<q>`), the home page with a cheat sheet, and a head-to-head comparison page.

Owner: Matthew (GitHub `deadeth`). He reviews the live site, not pull requests. Push to `main` deploys.

## Commands

```
npm ci
npm run dev          # Vite dev server
npm test             # vitest, all pages and the core
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + production build into dist/
npm run shot -- <id|home|compare> [--mobile] [--code|--java]   # screenshots into .shots/ (git-ignored)
```

`npm run shot` needs Chrome at `/usr/bin/google-chrome` or `CHROME_PATH`. It prints page errors and exits 1 on any. In a scratch copy with a symlinked `node_modules`, two 403 font errors are expected and harmless.

Deploy: `.github/workflows/deploy.yml` runs `npm ci`, `npm test`, `npm run build` and publishes `dist/` to GitHub Pages on every push to `main`. Check a deploy with `gh api "repos/deadeth/data-structures-visualised/actions/runs?per_page=1"`.

## Layout of the code

```
src/
  catalog.ts              every structure page: id, name, group, blurb, cheat-sheet row. GROUPS sets sidebar order.
  main.ts                 shell, sidebar, hash router, search box
  core/                   the animation engine (no DOM knowledge of any one page)
    types.ts              StructureDef, OpDef, Scene, Frame, Info
    recorder.ts           operations call rec.step / compare / mark / line; each call is one Frame
    renderer.ts fit.ts    SVG drawing, tweening by node id, fitting and following the probe
    player.ts timing.ts   playback, speed, scrubbing
    code.ts               parses listings: regions and anchors
    code-contract.test.ts every frame of every seed, tour and suggestion names a real anchor in both languages
  structures/<id>/        one folder per page: index.ts, info.ts, <id>.test.ts, code/<name>.py, code/<Name>.java
  designs/types.ts        the Design type
  designs/<id>.ts         one design page as data
  ui/structure-page.ts    stage.ts code-panel.ts    the structure page
  ui/design-page.ts design.css                      the design page renderer
  ui/search.ts home.ts compare.ts
  styles.css              design tokens and everything shared
docs/
  adding-a-structure.md   the contract for a structure page. Read before writing one.
  adr/                    why things are the way they are
  briefs/                 the briefs given to sub-agents; reuse them
  superpowers/specs/      the original design spec
scripts/shot.mjs          screenshots
```

## Rules that are easy to break

- **Colour means one thing each.** Magenta is only the thing being followed. Amber compared, blue visited, green found or written or committed, red dashed removed or rejected. Named pointers use `shape: 'tag'` and no hue. See ADR 0003.
- **A page owns its folder and nothing else.** To add a structure page, write `src/structures/<id>/` and add one entry to `src/catalog.ts`. Nothing else needs registering.
- **Listings are real programs.** One runnable file per language, `# region name` and `#@anchor` comments (Java: `// region`, `//@anchor`), lines at most 80 characters. Check them against a model with a harness kept outside the repo. See `docs/briefs/code-listings.md` and ADR 0004.
- **Every tour shows the failure**, not only the happy path.
- **Design diagrams stay simple.** At most about 14 chips at rest, one line per pair of boxes, in-process calls unchipped, recovery paths hidden behind the key's toggle. See ADR 0006.
- **Writing style** on every page: plain British English, short sentences, concrete numbers, no filler. State on the page what is simplified.
- **Do not claim what was not checked.** Mechanics are model-checked. Product trivia in the notes (defaults, version numbers) mostly came from memory and has not been verified; treat it as unverified until someone checks it against a source.

## How to verify before committing

Other sessions or agents may have half-finished files in the working tree. Verify exactly what you are about to commit:

```
git add <only your files>
rm -rf /tmp/verify2 && mkdir /tmp/verify2
git checkout-index -a --prefix=/tmp/verify2/
ln -s "$PWD/node_modules" /tmp/verify2/node_modules
(cd /tmp/verify2 && npx tsc --noEmit && npx vitest run && npx vite build)
```

Then look at screenshots of what changed, commit, push, and confirm the deploy. "Tests pass" is not enough for a visual change: look at it at 1440x900 and at 390x844.

## Working with sub-agents

This repo was mostly built by one coordinating session and many sub-agents. What worked:

- One agent per page, each told to touch only its own folder. The coordinator edits `src/catalog.ts` and shared files.
- Give the agent a brief from `docs/briefs/` plus a paragraph on the page's model, operations and tour.
- Agents preview their page in a scratch copy of the repo with the catalogue entry added there, never in the real catalogue.
- Agents report facts they could not verify. Keep that list.
- Agents are stopped by usage limits and server restarts. Resume them by id rather than starting again; keep ids and state in a plan file.
- Never trust an agent's "all checks pass". Re-run the snapshot verification above and look at screenshots.

Design review used blind rounds: three fresh reviewers per round (visual, accessibility and responsive, interaction and motion), given no earlier scores and no sight of each other, reviewing a frozen build. Brief: `docs/briefs/blind-reviewer.md`. Process and lessons: ADR 0007.

## State when this file was written (11 November 2026)

Live and verified:
- About 40 structure pages across eight groups, including twenty built from the "Systems Design 2.0" playlist (transactions, replication and consensus, data processing, networking).
- The web crawler design page, after four blind review rounds. Round 4 scores were 9 in half the categories and 8 in most of the rest; accessibility was held at 7 by one forced-colours bug.
- Site search.

In progress, not yet committed:
- Round 4 fixes to the crawler page (`src/designs/*`, `src/ui/design-page.ts`, `design.css`, `search.ts`): fixed token-label side per leg, fit-to-step zoom on phones, forced-colours fix, even chip row. After they land: blind round 5.
- Three new design pages as data files: `src/designs/ledger.ts`, `fraud-alerts.ts`, `card-processing.ts`. Brief: `docs/briefs/design-page.md`.
- The router, sidebar, home page and search still assume one design (`web-crawler`). Generalise them to `#/d/<id>` over a small registry before the new designs can go live. Places: `src/main.ts` (nav link, route regex, import), `src/ui/search.ts` (index).

Not started:
- Written "concept" pages for the playlist's comparison videos (SQL vs NoSQL, MySQL vs PostgreSQL, Spanner, VoltDB, MongoDB vs Cassandra, HBase, Kafka vs RabbitMQ, Elasticsearch, time-series and graph databases, Redis vs Memcached, CDNs, object stores, ZooKeeper, monolith vs microservices). They need a small notes page type.
- An optional table and cross-page links in `Info` (the MVCC page wants an anomaly grid; several pages refer to others by name only).
- A fact-check pass over product trivia in page notes.
- README still lists the first 17 structures.

Known rough edges:
- On phones some labels inside structure scenes are cut at the canvas edge (worst: graph, LSM tree, token bucket).
- `cache-strategies` has an 8-step tour; the guide says 4 to 7.
- Some pages change a page setting from inside the tour through an operation, so the dropdown can disagree with the status line (version vectors, MVCC, TCP, serialisation, 2PL).
