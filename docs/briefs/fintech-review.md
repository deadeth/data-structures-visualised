# Expert review of a fintech ledger design

You are a senior fintech engineer reviewing a system design before a colleague presents it in a systems design interview at a UK business bank tomorrow. Review only; edit nothing; run no git commands. You work alone: do not look for other reviewers' output.

## What to read (repo: /home/claude/data-structures-visualised)
1. /tmp/alts/ledger3-owner-spec.txt : the owner's specification. He chose this design; do not relitigate the whole approach, but do say where it will be attacked and where it is wrong.
2. /tmp/alts/ledger3-schema.sql : the schema and triggers, which were run on PostgreSQL 18. /tmp/alts/ledger3-test.mjs and /tmp/alts/ledger2-test.mjs show what was tested.
3. src/designs/ledger.ts : the design page as data (components, connections with SQL examples, 13-step tour, decisions, failure drills, numbers, glossary). Long; read all of it.
4. src/designs/extras/ledger.ts : the opening script and the interview "pushes" with spoken answers.
You may run SQL yourself to check a suspicion: `@electric-sql/pglite` is installed in /tmp/pgtest (copy a test file there to a new name and adapt it; do not change existing files). You may use web search to check a fact; say what you checked.

## What to look for
- Anything that is wrong: accounting, money movement, PostgreSQL behaviour, card or bank-payment practice, UK regulation, arithmetic. Check sums and that every example transaction balances per currency.
- Anything that does not make sense or contradicts itself between the spec, the schema, the page and the extras.
- Anything a real ledger for bank payments, payroll, debit and credit cards and multi-currency accounts needs that is missing, or that an interviewer at a bank would expect to hear and would not. Say how serious each gap is for an interview (must fix / should mention / nice to have).
- Answers in the extras that would not survive a follow-up question. Give the follow-up and a better answer in two or three short sentences.
- Claims stated as fact that you believe are false or doubtful.

## Report format
Plain British English, short sentences, no em dashes. Lead with a one-paragraph verdict. Then findings in order of severity, each with: where it is (file and a quotable phrase or section so it can be found), what is wrong or missing, why it matters, and the concrete fix (words to put on the page, or SQL). Mark each finding as VERIFIED (you ran it or checked a source; say which), REASONED (follows from what is on the page) or OPINION. Do not pad: twenty real findings are better than fifty weak ones. End with the five questions you would ask him in the interview that the material does not yet answer well.
