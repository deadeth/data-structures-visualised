# Brief: make the tour teach, and explain every named technology

Repo: /home/claude/data-structures-visualised. Read CLAUDE.md first (writing style, "do not claim what was not checked"). You edit ONE design file, named in your prompt.

The owner is learning from these pages for an interview. He says the tour's step text (the dark box above the diagram) is too terse to learn from. His two examples, from the ledger page:

> "Commit on two machines. The commit waits until one of two synchronous standbys in another zone has the log record. Only then is the reservation confirmed. If the primary died now, the standby would already hold it: nothing acknowledged is lost."
> What is the synchronous standby? What is another zone? Where is the reservation confirmed? What is the standby? Acknowledged means what action, and who was it acknowledged to?

> "The hot account. Every payment credits fee income, so one balance row would make every payment queue behind it. The 20p went to sub-account 17 of 32, picked by hashing the transaction id. Each minute the sweeper moves them into the main account."
> It is missing context, and setting out the problem and consequences in more detail, and the solution to fix.

And: "in the ledger design a CDC is used and it mentions it uses Debezium in the diagram. Clicking on it doesn't show what Debezium is or why it was chosen."

Types (src/designs/types.ts, already extended; do not edit it): `TourStep.story`, `TourStep.explain`, `Component.built`.

## 1. Every tour step
a) Rewrite `text` (the dark box) so a newcomer can follow it on its own:
   - Say who does what to whom, using the names on the boxes.
   - No term that is not either everyday English or explained in the same sentence. Prefer the plain phrase ("a second copy of the database in another data centre") and give the term in brackets once if the reader needs it later.
   - Say in a clause why the step exists (the problem it answers).
   - Keep every fact, number and name the step has now. At most 420 characters (the box has limited room); most steps should land between 280 and 400.
b) Add `story: { context, problem, consequence, fix }`, one to three sentences each:
   - `context`: where the followed thing is now and what has just happened, so the step does not start cold.
   - `problem`: what could go wrong or what is hard at this point, concretely, with the page's numbers.
   - `consequence`: what the customer, the business or the system would suffer if nothing were done.
   - `fix`: what this design does about it, mechanically, step by step, and what that costs.
c) Add `explain`: three to six `{ q, a }` pairs. The questions are the ones a newcomer would ask about this step's text and picture, like the owner's above: what a term means, which box does it, where a thing is stored or confirmed, who is told and how they know. Each answer is two or three plain sentences and stands alone. Do not repeat a question already answered in an earlier step's `explain` unless this step changes the answer; refer back ("see step 3") only by saying it again briefly.

Do not change `title`, `focus`, `path`, `labels`, `pill`, `branch`, `failed`, `recovery` or `hide`.

## 2. Every component
Add `built: { name, what, why }[]` with one entry for each product, protocol or technique named in the component's `tech` line, in its name, or in the sub-lines drawn on its box (for example "Debezium", "Postgres primary", "Kafka, by account", "RocksDB", "Redis counters", "64-bit fingerprints", "token buckets", "HSM"):
   - `what`: what it is, in one or two sentences a newcomer can follow, including what kind of thing it is (a database, a library, a managed service, a technique).
   - `why`: why this design uses it for this box and not the obvious alternative, tied to the page's own requirements and numbers.
   A component whose tech line names nothing but a role (for example "app, API") gets one entry explaining that role, or none if there is truly nothing to explain. External boxes (a card network, a scheme, the web) get an entry saying what the thing is.

## Rules
- Plain British English, short sentences. No em dashes. No filler, no marketing words. Concrete numbers from the page.
- Stay consistent with everything else on the page: components, connections, their examples, alternatives, numbers, glossary and the "Say" lines. The story you tell in a step must match the examples on that step's connections (same ids, amounts, names).
- Do not add product trivia you cannot stand behind (no versions, defaults, limits or prices from memory). Describing what a well-known tool is, in general terms, is fine; say "typically" where behaviour depends on configuration. List in your report every claim a careful reader might want checked.
- If the page seems wrong somewhere, do not fix it; report it.
- TypeScript: escape apostrophes in single-quoted strings or use double quotes. Run tsc.
- Edit ONLY your design file. No git commands at all.

## Check before you report
- `npx tsc --noEmit` clean (run from the repo root).
- Counts: steps; steps with rewritten text, `story` and `explain`; longest `text` in characters; components; components with `built`; entries in total.
- Look at it: `node .shots/step-look.mjs <design-id> <step numbers...>` writes, for each step, a screenshot of the page top at 1440x900 and 390x844 and of the "Step n explained" panel, and prints the readout's height at each step (it should be the same on every step at one width). Open at least two steps' panels and one page-top shot with the Read tool. Check one component panel's "Built with" by reading its text with a small puppeteer script or a screenshot.
- Read every rewritten `text` once more as someone who has never seen the system. If a sentence needs the reader to already know a term, fix it.

## Report (final message, under 300 words)
Counts, the longest text, claims worth checking, anything on the page you think is wrong.
