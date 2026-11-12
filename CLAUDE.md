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

## State when this file was last updated (12 November 2026)

Live and verified:
- About 48 structure pages across nine groups. "Reliability patterns" holds transactional outbox, sagas, idempotency keys, and retries, backoff and circuit breakers.
- Four design pages over a registry (`src/designs/index.ts`): web crawler, ledger, suspicious-transaction alerts, card processing. The last three have been fact-checked against sources; the checkers' "could not verify" lists are in the session reports, not the repo.
- Interview extras for ledger, alerts and cards (`src/designs/extras/<id>.ts`, rendered by `src/ui/design-extras.ts`): opening script, likely pushes, "lead it", rehearsal mode (`#/d/<id>/rehearse`) and a two-page crib (`#/d/<id>/crib`). The crawler has none yet.
- Site search, covering structures, designs and interview pushes.
- A structure page opens with `info.summary` under its title. The catalogue `blurb` is only for the home page, sidebar and search.

Paused, not in progress:
- Crawler design page blind review. Rounds 5 to 12 ran on 11 and 12 November. Round 12 scored 9 in sixteen of eighteen cells and 8 in two: written content (a write-ordering error, since fixed) and clarity (a phone camera jump between steps 13 and 14, since fixed). Matthew stopped the loop after the round 12 fixes; no round 13 has checked them. Reports and briefs were in `/tmp/council/b<n>/` on the session machine and are not in the repo.
- The crawler tour has 14 steps: the node failure is two steps, "The lease runs out" and "A new owner takes over".
- Known and accepted on the crawler page: at 768x1024 step 14 rests without the Object store in view (tablets have no edge signs); at 320px wide steps 6, 7 and 12 show one end of a leg and an edge sign for the other; with a box selected, labels that cannot be placed cleanly are left off the diagram and listed in the panel; there is no dark scheme.
- The ledger design was rewritten on 12 November to Matthew's spec: append-only `ledger_entries`, `accounts` as a trigger-kept balance cache (fillfactor 80, guard trigger, CHECK for overdrafts), locks in id order with `FOR NO KEY UPDATE` and a conditional CTE insert, house accounts split 16 ways per shard, reserve and settle as two balanced transactions through `FPS_PENDING_nn`, journal partitioned by month. The DDL, triggers, reserve and settle, the partition caveat (unique keys must include `created_at`, so `idempotency_keys` is the guard across partitions), the balance check with `account_period_totals`, detach and the break-glass bypass were run on PostgreSQL 18 (PGlite) outside the repo. Prose claims about HOT, lock modes and Debezium were not. Open question: settle and reverse use different keys, so only the payment record stops both happening.
- The ledger, alerts and cards diagrams share the renderer but have had no layout pass of their own: the ledger's right-hand column sits tight against the stage edge.
- Alternatives on design pages are three columns: what the option is, pros, cons. Data: `Alternative.what/pros/cons`, `Flow.ways` (the chosen way first) and `Component.numbers` entries as `{ text, from }` with the working. All four designs are filled in. That text was written on 12 November from the writers' own knowledge and has not been fact-checked; the writers also flagged figures on the pages that do not follow from their inputs (crawler: link-rate figures of 20,000 and 50,000 a second used inconsistently, a full 15 GB frontier snapshot every few minutes; alerts: preferences store size, the 100-a-second alert burst; ledger: which account keys a multi-account event). None of those were changed.
- Prose uses a one-glyph font, "Plain zero" (the zero of Atkinson Hyperlegible Next with its slash removed, OFL), inlined in `src/styles.css` as `--sans`; data contexts use `--sans-data` and keep the slashed zero.

Design-page decisions settled during review (reviewers flip on these; do not reopen without a reason):
- Phone tour: one fixed canvas height, camera scale between 0.8 and 1.0 so diagram text is 13px or more, no zooming out to fit a step. The camera follows the token; the destination box and resting label always sit inside the canvas; other lit boxes out of view get an edge sign.
- The whole-diagram fit starts at about 1010px wide. Fitting at 768px draws 9.9px text, so tablets pan.
- Bottom-row chips are staggered on their own lines, not on one baseline.
- Parts off the current step dim with solid colours (text 4.5:1 or better, strokes 3:1 or better), never opacity.
- The token is painted above chips, its dot never rests on words, and moving labels keep off box names.
- Labels on a selected box need a visible owner (plate, leader, near their line) or are dropped; the detail panel lists them all.
- Every overlap or contrast check runs on every tour step at every size: 1920x1080, 1440x900, 1366x768, 1024x768, 768x1024, 640x400, 390x844, 844x390, 320x640. Fixes measured on phones only caused desktop regressions twice.

Not started:
- Written "concept" pages for the playlist's comparison videos (SQL vs NoSQL, MySQL vs PostgreSQL, Spanner, VoltDB, MongoDB vs Cassandra, HBase, Kafka vs RabbitMQ, Elasticsearch, time-series and graph databases, Redis vs Memcached, CDNs, object stores, ZooKeeper, monolith vs microservices). They need a small notes page type.
- An optional table and cross-page links in `Info` (the MVCC page wants an anomaly grid; several pages refer to others by name only).
- A fact-check pass over product trivia in page notes.
- README still lists the first 17 structures.

Known rough edges:
- On phones some labels inside structure scenes are cut at the canvas edge (worst: graph, LSM tree, token bucket).
- `cache-strategies` has an 8-step tour; the guide says 4 to 7.
- Some pages change a page setting from inside the tour through an operation, so the dropdown can disagree with the status line (version vectors, MVCC, TCP, serialisation, 2PL).
- Design-page boxes still link to older pages where a pattern page now fits better (only the glossary entries for idempotency key and outbox were re-pointed).
- Unverified product trivia in the newest pages: Resilience4j, Polly, gRPC deadlines, Kafka idempotent producer, Postgres sequence behaviour; vendor list and fee figures in the cards extras.
