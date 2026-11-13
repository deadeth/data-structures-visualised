# Brief: fuller alternatives on one design page

Repo: /home/claude/data-structures-visualised. Read CLAUDE.md first (writing style, "do not claim what was not checked").

The design pages show, for every component, an "Alternatives" list, and for every connection a "Ways to connect them" list. The page now lays each option out in three columns: what it is (left), pros (middle), cons (right). The data has only a one-line `good` and `cost` per option, and connection alternatives are bare strings. Your job is to write the fuller content for ONE design file, named in your prompt.

Types are in src/designs/types.ts (already extended; do not edit it):
- `Alternative` has new optional fields `what`, `pros`, `cons`.
- `Flow` has a new optional field `ways: Way[]` (`{ name, chosen?, what, pros, cons }`).

## What to write

For EVERY entry in every component's `alternatives` array, add:
- `what`: two or three short sentences. What the option is, in plain words, and how it would work in THIS design (name the box, the data, the numbers on the page). Not a definition from a textbook. For the chosen option, say why it fits here.
- `pros`: two to four points. Each a short phrase or sentence, concrete, specific to this design.
- `cons`: two to four points, the same. For the chosen option the cons are what you pay for it; for the others, at least one con says why this design passes on it.
Keep the existing `name`, `chosen`, `good` and `cost` exactly as they are (other pages use them). Your pros and cons should cover what `good` and `cost` say and add to it; do not contradict them.

For EVERY flow (connection), add `ways`: the chosen way first with `chosen: true` (name it as the chip names it, for example "gRPC" or "Kafka, keyed by account"), then one entry for each string already in that flow's `alts`, and one more real alternative if an obvious one is missing. Each with `what` (two sentences), `pros` (two or three) and `cons` (two or three). Leave `alts` as it is.

If a component has only one or two alternatives and an interviewer would plainly expect another (for example "do nothing / keep it in the caller", or the managed service), add it, with `good` and `cost` one-liners as well as the new fields. Do not pad: three to five options per component is the range.

## Rules
- Plain British English, short sentences, concrete numbers taken from the page itself. No filler, no marketing words. No em dashes. Apostrophes inside single-quoted TypeScript strings must be escaped or the string double-quoted; run tsc.
- Stay consistent with everything else on the page: the numbers, the chosen design, the tour, the "Say" lines, and the facts already checked on it. If you think the page is wrong somewhere, do not fix it; report it.
- Do not add product trivia you cannot stand behind: no version numbers, default settings, price figures or limits from memory. Say what a kind of tool does, and name a product only where the page already names it or the property is basic and well known (for example "Kafka keeps order within a partition"). List in your report every factual claim you added that a careful reader might want checked.
- Pros and cons are trade-offs an interviewer would accept, not strawmen. Every non-chosen option must have real pros.
- Edit ONLY your design file. Do not touch any other file. No git commands at all.

## Check before you report
- `npx tsc --noEmit` clean (run from the repo root).
- `npx vitest run src/designs` if any tests exist there; otherwise skip.
- A count: components, alternatives with all three new fields, flows, flows with `ways`. All must be complete.
- Look at your page: `node .shots/alt-look.mjs <design-id>/c/<component-id> <design-id>/f/<flow-id>` writes screenshots of the alternatives block at 1440 and 390 into .shots/ and prints overflow counts; open two or three with the Read tool. Text should read well in three columns; if a `what` runs past about 45 words, shorten it.

## Report (final message, under 300 words)
Counts, anything you added beyond the existing options, the claims worth checking, and anything on the page you think is wrong.

## Also: show where every number comes from (added by the owner)
The owner's example: on the crawler's Object store the page says "About 100 TB a month raw, about 20 TB compressed." and nothing says where 100 TB comes from or why compressed is a fifth of it.

`Component.numbers` now accepts `{ text, from }` as well as a plain string (type `Figure` in src/designs/types.ts). Convert EVERY entry in every component's `numbers` array in your file to `{ text: '<the line as it is>', from: '<the working>' }`:
- `from` shows the sum with its inputs, in the page's own figures: "1 billion pages a month x 100 KB a page = 100 TB."
- For every input or ratio, say what it is: taken from the page's "Numbers to have ready" table, a stated assumption (and why it is a reasonable one, in a few words), or a source already cited on the page. For the example: "HTML is mostly text; gzip or zstd usually gets about 5 to 1 on it, so 100 TB becomes about 20 TB. The ratio is an assumption."
- Re-do each sum. If a figure on the page does not follow from its inputs, do not change it: report it.
- Where a figure appears inside your new alternatives text (pros, cons, what), it must be one the page already derives, or carry its own short working.
- Use "x" or "×" consistently with the rest of your file, and no em dashes.
Add to your count: number entries, and how many now have `from`. Look at one component with numbers in a screenshot (`node .shots/alt-look.mjs` shows only the alternatives block; for the numbers, read the rendered text with a quick puppeteer script or check the page section in a full-page screenshot).
