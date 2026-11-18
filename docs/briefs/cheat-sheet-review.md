# Reviewing a cheat sheet for a system design interview

You are one of four independent reviewers. You have not seen any earlier review and must not look for one.
Do not edit any file in the repo. Do not run git. Write nothing except your report (your final message).

## What is being reviewed

A cheat sheet for the "Design a web crawler" system design interview: 60 minutes, for an engineering
leadership role (senior engineering manager level) at a UK fintech. The candidate will keep it on a
second screen, or printed, during the interview "so I don't miss anything important". He is told the
round may start small (one site, one machine) and grow as the interviewer adds requirements.

His complaint about the previous version was: "it seems a bit coded and catchphrasey - make it more
human written and easier to glance at". So the two things he cares about are that it reads as if a
person wrote it, and that he can find his place in it in a second or two under pressure.

House style for the site: plain British English, short sentences, concrete numbers, no filler, no
jargon where a plain word works. No "Bold term: explanation" list items. No em dashes.

## Where it is (round folder given in your task)

- `text.txt`: the sheet's words, in reading order.
- `screen-1920-first-view.png`, `screen-1440-first-view.png`: what shows without scrolling on a monitor.
- `screen-1440-clock-at-20-minutes.png`: scrolled to the hour, with the clock running.
- `screen-1920-full.png`, `screen-1440-full.png`, `screen-390-full.png`: the whole page.
- `print-page-1.png`, `print-page-2.png`: the two printed A4 pages.
- Source: `/home/claude/data-structures-visualised/src/designs/extras/web-crawler.ts` (the `crib:` block at
  the end is the sheet; the rest of the file is the page's fuller interview notes it was written from).
- The design it summarises: `/home/claude/data-structures-visualised/src/designs/web-crawler.ts`
  (numbers, decisions, tour steps). The sheet must not contradict it.
- Renderer and styles, if you need them: `cribSheet` in `src/ui/design-extras.ts`, `.dx-sheet-*` in
  `src/ui/design-extras.css`.

## Things that are deliberate

- Lines in the hour are capped at 100 characters, answers at 140. A test enforces it.
- "Any time" marks a stretch the interviewer can start whenever they like; it takes no minutes of its own.
- On paper the minute tags sit on the title's line and are outlined, not filled, so a printer that
  leaves out backgrounds does not lose them.
- The sheet says "machine" throughout for what the design page calls a node.
- The hour's two columns are read downwards: the left is the first half hour, the right the second.
- "If they ask" is grouped by the part of the hour each question tends to come up in, in the hour's
  order, so he looks under the part he is on. It is not ordered by likelihood.
- "Start the clock" (top right, on screen only) marks the stretch the interview should be in and
  shows the minutes gone. `screen-1440-clock-at-20-minutes.png` shows it running. The bar it sits
  in stays at the top of the window while the page scrolls.
- The page sits inside the site's shell, with its sidebar on the left (a header on phones). That is given.
- With the clock running, the bar also says what to be doing ("Now: Grow it to many sites, until 22");
  pressing that brings the stretch into view. The page never scrolls by itself, so it cannot move
  under him while he is reading an answer.
- On paper the bullets start at the column's left edge, under the minute tag, to keep lines long.
- The sheet says "a snapshot" with no interval, because the design page itself gives two different
  intervals. That is a known fault of the design page, not of the sheet.
- Seen checks are quoted at the 400 a second expected, as the fuller notes do; 1,000 a second is
  what the hardware is built for.
- Content the candidate has not studied must not be added: every line has to come from the design
  page or the fuller notes.
- Coverage is measured against the rehearsal in the fuller notes (`rehearsal` at the end of
  `src/designs/extras/web-crawler.ts`): the sheet should prompt the main points of each of its
  eight stages, in the same minutes. It is not meant to hold every push.
- A point made in the hour is not repeated under "If they ask", and the other way round. Where a
  question seems missing, check the hour first.
- "The data stays right" (not "that is safe") is deliberate: a repeat fetch is safe for the data
  but still costs the site a visit.
- The default order for the deep dive follows the notes: a worker dying, one URL found twice, the
  rate limiter, then a whole machine failing.
- The running-behind note covers minutes 25 and 47 only, so that it stays one printed line.
- The Postgres columns are the ones the notes give for the small design.
- A group of questions is never split between the two columns, so on page 2 the columns end at
  different heights. That is accepted.
- On paper the number captions are a little smaller than the rest (9pt) so each stays two lines.
- `screen-390-clock-at-35-minutes.png` shows a phone with the clock running.
- The bar that stays in view also holds a strip of the hour's minutes: a press goes to that
  stretch, and with the clock running the current one is filled. "Its questions" goes to the group
  of answers for the current stretch, whose heading is filled too. Each group's heading carries
  its stretch's minutes.
- The strip starts with a "Numbers" button, which brings the numbers back into view from anywhere.
- Below 1700px wide the minute tags sit on the title's line, as on paper, so lines wrap less; a
  wider monitor keeps them in the margin.
- "Any time" has no group of its own under "If they ask": its points are in the hour, and a
  one-question group would cost two lines on a full page.
- On a phone the strip is left out for lack of room; the bar has a "Numbers" button in its place.
- "Say how you'd run it" lists what pages someone, as the notes' on-call list does; what waits for
  the morning (Kafka lag, repeat fetches) is left to the notes.
- With the clock running, below 1500px wide, the "Back to" link leaves the bar to make room; "Reset"
  brings it back.
- While the clock runs, stretches other than the current one are dimmed in solid colours: titles
  at about 7.6:1 on white, bullets at about 5.6:1. One reader asked for lighter and another for
  darker; this is the middle and is settled.
- Minutes and figures use the site's plain zero (no slash) so "30" cannot read as "3Ø".
- On paper there are no rules between stretches: each rule costs height, and page 1 has none to give.
- On a monitor 1700px wide or more, each button in the strip carries a word for its stretch beside
  the minutes ("16 to 22 Sites"); narrower, the minutes alone, with the title as a tooltip.
- Page 1 on paper is dense on purpose: the whole hour and the numbers on one side of one sheet.
  Looser spacing would push a stretch onto page 2.
- Settled wording, changed back and forth by earlier readers and not to be reopened without a new
  reason: "At 10 a second, if the site allows"; "finds its lease gone and stops" (the notes' own
  account of a woken machine); "The data stays right"; "One breach wakes someone. So does..." (to
  keep "page" for web pages); "It ends when the queue is empty" (naming the crawl costs a line).

## What to report

1. A score out of 10 for each of YOUR TWO categories (named in your task), with two or three
   sentences of reasons each. Be strict: 9 means you would hand it to the candidate as it is; 10
   means you cannot find anything worth changing. Do not round up to be kind.
2. Every change needed to reach 9 in each category, most important first. Be concrete: for wording,
   quote the line and give the exact replacement; for layout, say what to change and at which size;
   for a missing point, give the line you would add and where, and what you would cut to make room
   (page 1 is full: no spare line in either column, so any added line needs a cut beside it;
   page 2 has about four lines spare on the left and one on the right; "Keep doing" now has six
   habits, three a side). The sheet must stay two A4 pages.
3. Anything outside your categories that is plainly wrong, in one line each.

Keep the report under 600 words. Scores first, in the form `Category name: N/10`.
