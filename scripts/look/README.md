# Screenshot helpers

One-off scripts written while building and reviewing pages. They are kept because they are quicker to adapt than to rewrite. None is run by the tests or the build.

Run them from the repo root, for example `node scripts/look/step-look.mjs ledger 3 7`. Each starts its own Vite server, opens Chrome at `/usr/bin/google-chrome` (edit the path on other machines) and writes PNGs into `.shots/`, which is git-ignored.

The ones worth knowing:

- `step-look.mjs <design> <steps...>`: a design tour step at 1440 and 390 wide, plus its "explained" panel.
- `story-look.mjs <design> <story> <steps...>`: the same for a named story.
- `db-look.mjs <design>/c/<component>`: a component panel with "What it stores" and "Key queries".
- `alt-look.mjs`, `ex-look.mjs`, `extras-look.mjs`, `picker-look.mjs`, `collapse-look.mjs`: alternatives, examples, interview extras, the story picker, the collapse button.
- `wide-look.mjs <routes...>`: any route at 2560, 1920 and 1440 wide.
- `live-code.mjs`: opens the live site, not a local build, and checks the listings show.
- `dump-sql.mjs`: prints the SQL blocks of a design so they can be run.

The rest (`b5-look`, `b11-extra`, `r4-look`, `l5-*`, `hld`, `dl`, `fit`, `num-look`, `skip`, `search`, `code`, `design-look`) were written for one review round or one bug and may need changes to run again.

For structure pages use `npm run shot` instead.
