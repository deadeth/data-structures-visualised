import type { Concept } from "../types";

const page: Concept = {
  id: "system-design-interview-playbook",
  title: "System design interview playbook",
  group: "Interview craft",
  summary:
    "How to run a 45 to 60 minute system design round as an engineering lead or director: the phases and their timings, the numbers to carry in your head, how to take a push, and what makes an answer sound like a leader's.",
  minutes: 14,
  sections: [
    {
      id: "the-shape",
      title: "The shape of the hour",
      blocks: [
        {
          p: "You run the round; the interviewer steers it. That means you keep the clock, say where you are, and leave time for the parts a lead is hired for. Most candidates who fail at this level don't get the design wrong. They spend 25 minutes on boxes and never reach failure, rollout or the team.",
        },
        {
          table: {
            head: ["Phase", "45 min", "60 min", "You leave it with"],
            rows: [
              ["1. Clarify and set defaults", "4", "5", "Scope, users, the two or three properties that matter"],
              ["2. Numbers", "3", "5", "Peak rate, storage a year, the one number that shapes the design"],
              ["3. API and data model", "5", "7", "Three or four calls; the main tables and their keys"],
              ["4. High-level design", "8", "10", "One diagram, one request traced through it, who owns what"],
              ["5. Deep dives", "15", "20", "Two or three hard parts taken to the mechanism"],
              ["6. Operations and rollout", "6", "8", "SLOs, what pages, how it ships, how it's migrated"],
              ["7. Wrap-up", "4", "5", "What you'd do next, what you cut, your questions"],
            ],
          },
          caption: "Minutes are targets, not rules. The columns sum to 45 and 60.",
        },
        {
          diagram: {
            w: 640,
            h: 240,
            nodes: [
              { id: "p1", label: "Clarify", sub: "5 min", x: 0, y: 20, w: 130 },
              { id: "p2", label: "Numbers", sub: "5 min", x: 170, y: 20, w: 130 },
              { id: "p3", label: "API and data", sub: "7 min", x: 340, y: 20, w: 130 },
              { id: "p4", label: "High-level design", sub: "10 min", x: 510, y: 20, w: 130 },
              { id: "p5", label: "Deep dives", sub: "20 min", x: 510, y: 160, w: 130 },
              { id: "p6", label: "Ops and rollout", sub: "8 min", x: 340, y: 160, w: 130 },
              { id: "p7", label: "Wrap-up", sub: "5 min", x: 170, y: 160, w: 130 },
            ],
            edges: [
              { from: "p1", to: "p2" },
              { from: "p2", to: "p3" },
              { from: "p3", to: "p4" },
              { from: "p4", to: "p5", label: "by minute 27" },
              { from: "p5", to: "p6" },
              { from: "p6", to: "p7" },
            ],
          },
          caption:
            "The top row is setup: 27 minutes of a 60 minute round. The deep dives are where you're assessed, so reach them before the half-way mark. If you're still drawing boxes at minute 35, you've lost the bottom row.",
        },
        {
          callout:
            "Say the plan in the first minute: \"I'll spend five minutes on scope and numbers, sketch the API and the data, draw the high-level design, then go deep on the two riskiest parts and finish with how we'd run and ship it. Pull me anywhere you'd rather go.\"",
          kind: "interview",
          title: "Open with the agenda",
        },
      ],
    },
    {
      id: "clarify",
      title: "Clarify, and set defaults",
      blocks: [
        {
          p: "Ask four or five questions that change the design, not twenty that don't. Who uses it and how many? What's the main write and the main read? What must never happen (money lost, a double charge, a stale balance shown as final)? Is it one region or several? What already exists?",
        },
        {
          p: "When the interviewer says \"up to you\", don't keep asking. State a default and move on: \"I'll assume 5 million UK customers, one region with three zones, and that we own the ledger but not the card processor. Tell me if you'd like something different.\" A stated assumption is as good as an answer, and it shows you can decide with partial information.",
        },
        {
          p: "Write the requirements on the board in two short lists: what it does, and the properties (correctness, latency, availability, cost). Rank the properties. \"Never double-pay; 99.9% available; p99 under 500 ms; in that order\" tells the interviewer how you'll make every later trade.",
        },
        {
          callout:
            "Scope out loud. \"I'll leave out onboarding, disputes and reporting, and come back if there's time\" is a decision. Silently ignoring them reads as not having noticed.",
          kind: "rule",
        },
      ],
    },
    {
      id: "numbers",
      title: "Numbers: back-of-envelope estimation",
      blocks: [
        {
          p: "The point of estimating is to make a design decision, not to do arithmetic. Three minutes should tell you whether one database is enough, whether you need a cache, and what grows fastest. Round hard and say the working.",
        },
        { h: "The conversions" },
        {
          table: {
            head: ["Fact", "Use"],
            rows: [
              ["A day is 86,400 seconds, about 100,000", "1 million a day is about 12 a second"],
              ["100 million a day", "About 1,200 a second"],
              ["Peak is 3 to 10 times the average", "Say which you chose and why (payday, lunch, a launch)"],
              ["1 KB a row, 1 million rows a day", "1 GB a day, 365 GB a year"],
              ["Storage a year", "rows a day × bytes a row × 365, then × 2 or 3 for indexes and replicas"],
              ["A month is 43,200 minutes", "99.9% allows 43 minutes down; 99.99% allows 4"],
            ],
          },
        },
        { h: "Latencies worth knowing (approximate)" },
        {
          table: {
            head: ["Operation", "Roughly"],
            rows: [
              ["Read from memory", "100 nanoseconds"],
              ["Random read from an SSD", "0.1 ms"],
              ["Round trip inside one data centre", "0.5 ms"],
              ["Redis GET, including the network", "1 ms"],
              ["Postgres read by primary key, including the network", "1 to 2 ms"],
              ["Postgres commit, flushed to disk", "A few ms"],
              ["Round trip between zones in a region", "1 to 2 ms"],
              ["London to US east coast, round trip", "75 ms"],
              ["London to Sydney, round trip", "250 ms"],
              ["Call to a card scheme or bank API", "100s of ms; budget for it"],
            ],
          },
          caption: "Orders of magnitude, from memory. What matters is the ratios: a cross-continent hop costs as much as 100 local calls.",
        },
        { h: "What one box can do (approximate)" },
        {
          table: {
            head: ["Component", "One instance, roughly", "What limits it"],
            rows: [
              ["Stateless web or API server", "1,000s of simple requests a second", "CPU, and the latency of what it calls"],
              ["Postgres primary", "1,000s of simple write transactions a second; a few TB", "Disk flushes, locks on hot rows, vacuum, restore time"],
              ["Redis", "About 100,000 operations a second", "One thread for commands; memory"],
              ["Kafka partition", "10s of MB a second; 10,000s of 1 KB messages", "Disk and network; ordering holds only within the partition"],
            ],
          },
          caption: "Use these to decide how many, not to promise a benchmark. Say \"roughly\" when you quote them.",
        },
        {
          callout:
            "Card payments for a UK fintech. 5 million customers × 2 payments a day = 10 million a day. ÷ 86,400 ≈ 116 a second on average; × 5 for the lunchtime peak ≈ 600 a second. Each payment writes about 1 KB across the authorisation, the ledger entries and their indexes: 10 GB a day, 3.65 TB a year. Decision: 600 writes a second fits one Postgres primary, so no sharding. Storage is what grows, so partition by month and archive old partitions.",
          kind: "example",
          title: "Worked example 1: write-heavy",
        },
        {
          diagram: {
            w: 520,
            h: 410,
            nodes: [
              { id: "a", label: "10 million a day", sub: "5M customers × 2", x: 190, y: 10 },
              { id: "b", label: "÷ 86,400", sub: "≈ 116 a second", x: 40, y: 120 },
              { id: "c", label: "× 5 at peak", sub: "≈ 600 a second", x: 40, y: 230 },
              { id: "d", label: "One primary copes", sub: "no sharding", x: 40, y: 340, tone: "ok" },
              { id: "e", label: "× 1 KB a payment", sub: "10 GB a day", x: 340, y: 120 },
              { id: "f", label: "× 365", sub: "3.65 TB a year", x: 340, y: 230 },
              { id: "g", label: "Partition, archive", sub: "storage is the risk", x: 340, y: 340, tone: "compare" },
            ],
            edges: [
              { from: "a", to: "b", label: "rate" },
              { from: "b", to: "c" },
              { from: "c", to: "d" },
              { from: "a", to: "e", label: "storage" },
              { from: "e", to: "f" },
              { from: "f", to: "g" },
            ],
          },
          caption:
            "One input, two chains, two decisions. Every estimate should end in a box like the bottom row: something you will or won't build because of the number.",
        },
        {
          callout:
            "A public exchange-rate page. 20 million views a day ÷ 86,400 ≈ 230 a second; × 10 when a currency is in the news ≈ 2,300 a second. But there are only about 1,000 currency pairs, and a displayed rate may be 60 seconds old. Behind one shared cache with a 60 second lifetime, the origin sees at most 1,000 ÷ 60 ≈ 17 requests a second, whatever the traffic. Decision: this is a caching problem, not a database problem. Spend the deep dive on expiry, stampedes and what to show when the rate source is down.",
          kind: "example",
          title: "Worked example 2: read-heavy",
        },
        {
          callout:
            "Estimating everything. Nobody needs bandwidth in megabits or the server count to two figures. Do the rate, the storage and one thing particular to the problem, then say what they decide.",
          kind: "pitfall",
        },
      ],
    },
    {
      id: "api-and-data",
      title: "API and data model",
      blocks: [
        {
          p: "Write three or four calls, not the whole surface. For each: the verb, the key fields and what makes it safe to retry. `POST /payments` with an `Idempotency-Key` header says more about your experience than ten endpoints.",
        },
        {
          p: "Then the data: the two or three main tables, their primary keys, the index behind the hottest read, and the constraints that protect the invariants. A `UNIQUE` constraint or a `CHECK (balance >= 0)` on the board is a correctness argument the interviewer can see. Say which service owns each table; nothing else writes to it.",
        },
        {
          see: [
            { href: "#/c/choosing-a-database", label: "Choosing a database", why: "How to justify the store in two sentences, and the mistakes to avoid." },
            { href: "#/s/idempotency-keys", label: "Idempotency keys", why: "The mechanism behind a retry-safe write." },
          ],
        },
      ],
    },
    {
      id: "high-level-design",
      title: "High-level design",
      blocks: [
        {
          p: "Draw the plain version first: client, load balancer, a stateless service, one database, and a queue with workers for anything that can happen later. Trace one request through it out loud. Only then add what the numbers or the requirements force, and say which number forced it.",
        },
        {
          diagram: {
            w: 560,
            h: 410,
            groups: [
              { label: "Payments team", x: 100, y: 90, w: 250, h: 310 },
              { label: "Notifications team", x: 380, y: 290, w: 170, h: 110 },
            ],
            nodes: [
              { id: "c", label: "Client", x: 180, y: 10, kind: "client" },
              { id: "api", label: "Payments API", sub: "stateless", x: 180, y: 124 },
              { id: "pg", label: "PostgreSQL", sub: "source of truth", x: 180, y: 228, kind: "store", tone: "ok" },
              { id: "k", label: "Kafka", sub: "payment events", x: 180, y: 328, kind: "queue" },
              { id: "w", label: "Notifier", sub: "push, email", x: 395, y: 328 },
              { id: "r", label: "Redis", sub: "rate limits", x: 400, y: 124, kind: "store" },
            ],
            edges: [
              { from: "c", to: "api" },
              { from: "api", to: "pg", label: "commit" },
              { from: "pg", to: "k", label: "outbox", dashed: true },
              { from: "k", to: "w", dashed: true },
              { from: "api", to: "r" },
            ],
          },
          caption:
            "A starting skeleton with ownership drawn on. The synchronous path is three boxes. The line that crosses between teams is an event stream, so the contract between them is the event schema, and the notifier being down can't fail a payment.",
        },
        {
          p: "Drawing the team boundaries is a cheap way to sound like a lead. It prompts the right questions: who is paged for this box, which calls cross teams, and is each of those synchronous (their outage is now yours) or asynchronous (you need a contract and a lag alert)?",
        },
      ],
    },
    {
      id: "deep-dives",
      title: "Deep dives, pushes and steering",
      blocks: [
        {
          p: "Choose the deep dives yourself before you're asked: \"The two risky parts are the double-spend on concurrent payments and what happens when the processor times out. I'll take those unless you'd like another.\" Pick the parts where correctness or scale is hard, not the parts you find comfortable.",
        },
        {
          p: "In a dive, go down to the mechanism: the lock, the constraint, the key, the message order. Then say what it costs and what you rejected. \"Row lock on the account inside the transaction; it serialises that account's payments, which is fine at a few a second per account; I rejected optimistic retries because hot merchant accounts would spin.\"",
        },
        {
          p: "A push is the interviewer telling you where the marks are. Take it in four moves: restate it, answer with a mechanism, give the cost, and check back.",
        },
        {
          sequence: {
            actors: ["Interviewer", "You"],
            messages: [
              { from: "Interviewer", to: "You", label: "What if the database dies mid-payment?", tone: "compare" },
              { from: "You", to: "Interviewer", label: "Restate: after commit, before the reply?" },
              { from: "Interviewer", to: "You", label: "Yes" },
              { from: "You", to: "Interviewer", label: "Mechanism: client retries, same key", note: "the unique key replays the first result" },
              { from: "You", to: "Interviewer", label: "Cost: sync standby, a few ms a commit" },
              { from: "You", to: "Interviewer", label: "Check: go further into failover?" },
              { from: "Interviewer", to: "You", label: "No. What about two regions?", tone: "compare", note: "a steer: follow it, park the rest" },
            ],
          },
          caption:
            "One push, handled in under two minutes. The restatement often halves the question. The check-back hands the interviewer the wheel, and their next question tells you what they're scoring.",
        },
        {
          table: {
            head: ["What they say", "What it usually means", "What to do"],
            rows: [
              ["\"What if X fails?\"", "You've drawn the happy path only", "Name the failure, the detection, the recovery, what the user sees"],
              ["\"Would that scale?\"", "They've seen a bottleneck", "Find it with a number, then fix that one thing"],
              ["\"Is there a simpler way?\"", "You've over-built", "Agree if it's true, and say what would make the complex version worth it"],
              ["\"Let's move on\"", "You have the marks, or you're stuck", "Stop within a sentence. Don't finish the thought"],
              ["\"Are you sure?\"", "Either a real error or a test of nerve", "Re-derive it aloud. Change your answer if wrong; hold it, with the reason, if not"],
              ["Silence", "They're writing notes", "Carry on, and offer a choice of where to go next"],
            ],
          },
        },
        {
          callout:
            "If you don't know, say what you do know and how you'd find out: \"I haven't run Kafka across regions. I know the options are mirroring or a stretched cluster, and the question I'd ask the team is what we lose on failover.\" Bluffing a product detail is the fastest way to lose a senior interviewer.",
          kind: "rule",
          title: "Not knowing",
        },
      ],
    },
    {
      id: "operations-and-rollout",
      title: "Operations and rollout",
      blocks: [
        {
          p: "This is the phase other candidates skip and the one a hiring panel for a lead listens for. Cover four things in six to eight minutes: the targets (an SLO with its number), what pages a human (symptoms, not causes), how you'd know the data is right (a reconciliation job, with how often it runs), and how it reaches production.",
        },
        {
          p: "Rollout is rarely a launch. It's usually a migration from something that already takes real money. Show that you'd de-risk it in steps, each with an exit test and a way back.",
        },
        {
          diagram: {
            w: 520,
            h: 410,
            nodes: [
              { id: "s1", label: "Shadow", sub: "new path, results unused", x: 60, y: 10, w: 180 },
              { id: "s2", label: "Compare", sub: "old against new, daily", x: 60, y: 120, w: 180, tone: "compare" },
              { id: "s3", label: "1% of customers", sub: "staff first, by flag", x: 60, y: 230, w: 180 },
              { id: "s4", label: "Ramp to 100%", sub: "then retire the old", x: 60, y: 340, w: 180, tone: "ok" },
              { id: "off", label: "Flag off", sub: "back in seconds", x: 360, y: 230, tone: "bad" },
            ],
            edges: [
              { from: "s1", to: "s2" },
              { from: "s2", to: "s3", label: "zero breaks, 2 weeks" },
              { from: "s3", to: "s4", label: "SLO holds" },
              { from: "s3", to: "off", label: "SLO breach", tone: "bad" },
            ],
          },
          caption:
            "Each arrow has an exit test, and the first real customers arrive behind a flag that turns off in seconds. Say the test and the way back for every step.",
        },
        {
          see: [
            { href: "#/c/resilience-patterns", label: "Resilience patterns", why: "SLO arithmetic, burn-rate alerts, canaries and the failure-to-pattern table." },
          ],
        },
      ],
    },
    {
      id: "lead-answer",
      title: "What makes it a lead or director answer",
      blocks: [
        {
          p: "A senior engineer is assessed on whether the design works. A lead or director is assessed on whether a team could build, run and afford it, and whether you'd make sound calls along the way. The design is the same; what you say around it differs.",
        },
        {
          table: {
            head: ["Topic", "A senior engineer's answer", "A lead's answer adds"],
            rows: [
              ["Trade-offs", "Picks a good option", "Names the option rejected, why, and what would reverse the choice"],
              ["Boundaries", "Draws services", "Says which team owns each, and whether each crossing is a call or an event"],
              ["Operability", "Mentions monitoring", "An SLO with a number, what pages, a daily check that the data is right"],
              ["Rollout", "\"Deploy behind a flag\"", "Shadow, compare, ramp, with exit tests and the old system kept as fallback"],
              ["Cost", "Not raised", "Rough monthly cost and its main driver; where a managed service buys back headcount"],
              ["Delivery", "Not raised", "What ships in the first quarter, how many engineers, what's deferred"],
              ["Simplicity", "Adds components for scale", "Says when the simple thing is enough, and the number at which it stops being"],
              ["Risk", "Lists failure modes", "Ranks them, and spends the time on the one that loses money or the licence"],
            ],
          },
          caption: "You don't need every row. Three or four, said unprompted, change how the round reads.",
        },
        {
          callout:
            "\"With five engineers I'd ship this in three steps. First the synchronous path on one Postgres, behind a flag, for staff. Second the outbox and events, so notifications and reporting come off the critical path. Third the reconciliation job, before we take external customers. I'd defer multi-region: at 600 writes a second it isn't a capacity question, and it would double the on-call load.\"",
          kind: "interview",
          title: "A delivery plan in four sentences",
        },
        {
          p: "Saying the simple thing is enough is the hardest of these and the most persuasive. \"One Postgres, one service and a nightly job covers this for two years at these numbers. Here's what I'd watch to know when that stops being true.\" It shows you've paid for complexity before.",
        },
      ],
    },
    {
      id: "failure-patterns",
      title: "Common failure patterns",
      blocks: [
        {
          list: [
            "Starting to draw in the first minute. You design the wrong system well.",
            "No numbers, or numbers that decide nothing.",
            "Naming technologies with no reason: Kafka, Cassandra and Kubernetes on the board by minute 10.",
            "A happy path with no failure in it. Nothing times out, nothing is retried, nothing is delivered twice.",
            "Talking for ten minutes without checking in. The interviewer's steer never gets a gap.",
            "Arguing with a push, or folding at once. Both skip the thinking.",
            "Going deep on what you know best instead of what the problem makes hard.",
            "Running out of time before operations and rollout, so the answer stops at senior engineer.",
            "Hiding uncertainty. A wrong product fact stated firmly costs more than \"I'd check that\".",
          ],
        },
      ],
    },
    {
      id: "checklist",
      title: "A one-page checklist",
      blocks: [
        { h: "Before you draw" },
        {
          list: [
            "Agenda said out loud, with timings.",
            "Users, main write, main read, what must never happen.",
            "Defaults stated; scope cut out loud.",
            "Properties ranked: correctness, availability, latency, cost.",
            "Peak rate, storage a year, and the decision each one makes.",
          ],
        },
        { h: "The design" },
        {
          list: [
            "Three or four API calls, each safe to retry.",
            "Main tables, keys, the hot index, the constraints.",
            "Plain skeleton first; one request traced end to end.",
            "Each added component justified by a number or a requirement.",
            "Ownership: which team runs each box; calls against events.",
          ],
        },
        { h: "Deep dives" },
        {
          list: [
            "Two or three, chosen by you, at the level of locks, keys and message order.",
            "For each: the mechanism, its cost, what you rejected.",
            "Every push: restate, mechanism, cost, check back.",
            "At least one failure followed from detection to recovery.",
          ],
        },
        { h: "Leading it" },
        {
          list: [
            "An SLO with its minutes; what pages; how you know the data is right.",
            "Rollout in steps with exit tests and a way back.",
            "Cost driver, team size, what ships first, what's deferred.",
            "Where the simple version is enough, and the number that ends that.",
            "Last two minutes: what you'd do next, then your questions.",
          ],
        },
      ],
    },
    {
      id: "worked-examples",
      title: "Worked examples on this site",
      blocks: [
        {
          p: "Each design page is one round played through: a tour that follows a request, panels for every component with its tables and queries, and the alternatives that were rejected. The four fintech designs also have an opening script, likely pushes, a timed rehearsal mode and a crib.",
        },
        {
          see: [
            { href: "#/d/ledger", label: "Ledger", why: "Correctness first: double entry, holds, idempotency and a parity job. Good practice for the data model and operations phases." },
            { href: "#/d/card-processing", label: "Card processing", why: "A latency budget across parties you don't control, and what to do when one times out." },
            { href: "#/d/fraud-alerts", label: "Suspicious-transaction alerts", why: "A stream with a decision deadline, a push to the customer and an escalation path." },
            { href: "#/d/money-moved-dashboard", label: "Money moved dashboard", why: "An aggregation prompt where the estimate decides the design; each step states the problem, the options and the choice." },
            { href: "#/d/web-crawler", label: "Web crawler", why: "The classic scale question: partitioning, politeness and recovery after a node fails." },
          ],
        },
        {
          callout:
            "Rehearse against the clock, out loud, and record it. Most people find their first run reaches the deep dives at minute 35. The fix is nearly always a shorter clarify phase and a plainer first diagram.",
          kind: "rule",
          title: "Practise the timing, not the content",
        },
      ],
    },
  ],
  unverified: [
    "Every figure in the latency table is an order of magnitude from memory (the well-known 'latency numbers' lists and general experience), not measured or checked against a source. Round-trip times London to US east (75 ms) and London to Sydney (250 ms) are approximate.",
    "Every figure in the 'what one box can do' table is a rough rule of thumb: thousands of requests a second for a web server, thousands of write transactions a second and a few TB for a Postgres primary, about 100,000 operations a second for Redis, tens of MB a second for a Kafka partition. Real figures vary by an order of magnitude with hardware, payload and configuration.",
    "'Peak is 3 to 10 times the average' is a rule of thumb.",
    "Redis described as one thread for commands: true of command execution; newer versions use extra threads for network I/O.",
    "'A sync standby costs a few ms a commit': approximate, depends on distance between zones.",
    "The worked examples' inputs (5 million customers, 2 payments a day, 1 KB a payment, 20 million page views, 1,000 currency pairs, a 60 second cache lifetime) are invented for the arithmetic, not any company's figures.",
    "What interviewers mean by particular phrases, what hiring panels listen for at lead and director level, and 'most people reach the deep dives at minute 35' are the writer's judgement, not sourced.",
    "The statement that the four fintech design pages have an opening script, pushes, rehearsal mode and a crib is taken from the repo's CLAUDE.md and the presence of src/designs/extras/<id>.ts files; the pages themselves were not opened.",
  ],
};

export default page;
