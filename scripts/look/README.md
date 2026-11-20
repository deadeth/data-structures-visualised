# Screenshot helpers

One-off scripts written while building and reviewing pages. They are kept because they are quicker to adapt than to rewrite. None is run by the tests or the build.

Run them from the repo root, for example `node scripts/look/step-look.mjs ledger 3 7`. Each starts its own Vite server, opens Chrome at `/usr/bin/google-chrome` (edit the path on other machines) and writes PNGs into `.shots/`, which is git-ignored.

The ones worth knowing:

- `step-look.mjs <design> <steps...>`: a design tour step at 1440 and 390 wide, plus its "explained" panel.
- `story-look.mjs <design> <story> <steps...>`: the same for a named story.
- `db-look.mjs <design>/c/<component>`: a component panel with "What it stores" and "Key queries".
- `alt-look.mjs`, `ex-look.mjs`, `extras-look.mjs`, `picker-look.mjs`, `collapse-look.mjs`: alternatives, examples, interview extras, the story picker, the collapse button.
- `wide-look.mjs <routes...>`: any route at 2560, 1920 and 1440 wide.
- `read-look.mjs <routes...>`: reading pages (`c/<id>`, `d/<design>/read`) full page at 1440x900 and 390x844, into `.shots/read-*.png`. Also prints page errors, sideways scroll, the smallest text in any figure and words in a figure that overlap. In development `c/fixture-reading` shows the renderer's fixture page.
- `lock-look.mjs [route]`: with `LOCK_PASSWORD` set, a locked page before unlocking, after a wrong password and after the right one, at 1440x900 and 390x844, into `.shots/lock-*.png`. Also prints the sidebar's design names, whether a reload stays open, and whether search and home show the page in a fresh tab.
- `course-look.mjs [module id] [--fresh]`: the course overview, one module (the first by default) and the home page's course card at 1440x900 and 390x844, with no progress and with some set in `localStorage` before load, into `.shots/course-*.png`. Prints page errors, sideways scroll, the progress bars' values and unlabelled inputs.
- `sheet-look.mjs <out dir>`: the web crawler's cheat sheet (`#/d/web-crawler/crib`) at 1920x1080, 1440x900 and 390x844, first view and full page, with the clock running at 1440 and 390, plus `text.txt` (the words in reading order) and `sheet.pdf` (the printed pages; `pdftoppm -r 110 -png sheet.pdf print-page` turns it into images, and it must be two pages). Prints the stretch the clock marks.
- `audio-look.mjs [main|small-first|both] [--phone] [--still]`: the tour narration on the web crawler. Asserts from the page which clip plays, that a step waits for its clip, that pause, next, audio off and leaving the tour behave, that a wrong manifest hash plays nothing and that no sound starts without a gesture; screenshots the tour controls with Audio off and on into `.shots/audio-*.png`. `--still` runs it with reduced motion. Exits 1 on a failed check.
- `quiz-look.mjs <out dir> [design id]`: a design's test (`#/d/<id>/test`, web crawler by default) at 1440x900 and 390x844, full page: questions unanswered, picked, right and wrong, the score and its "Start again" confirm, and the design header's "Test yourself" link. Prints page errors and sideways scroll.
- `practice-look.mjs <out dir> [practice id]`: pairing practice pages at 1440x900 and 390x844, full page: the guide (`#/p`), the development fixture guide (`#/p/fixture-guide`), and one page (`fixture-practice` by default) with practice mode off, on, on with one part shown, and off with a follow-up and a whole-file disclosure open; then the first view with the clock running, a part's address (`#/p/<id>/<part>`), a reload, and an unknown id. Prints page errors, sideways scroll of the page, code blocks and traces that scroll inside their frames, the smallest text, and whether a heading scrolled to lands under the tool bar. Compile and run the Java with `node scripts/practice/check.mjs [id]`.
- `live-code.mjs`: opens the live site, not a local build, and checks the listings show.
- `dump-sql.mjs`: prints the SQL blocks of a design so they can be run.

The rest (`b5-look`, `b11-extra`, `r4-look`, `l5-*`, `hld`, `dl`, `fit`, `num-look`, `skip`, `search`, `code`, `design-look`) were written for one review round or one bug and may need changes to run again.

For structure pages use `npm run shot` instead.
