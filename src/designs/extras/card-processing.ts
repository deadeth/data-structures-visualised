import type { Extras } from './types';

/**
 * Interview extras for the credit card processing design.
 *
 * The question: "Design a credit card processing system."
 *
 * Numbers agree with src/designs/card-processing.ts: about 1.2 million cards, 1.2 million
 * authorisations a day, about 135 messages a second at the yearly peak, built for 1,000; a budget of
 * about 100 ms typical and 300 ms at the 99th percentile; fraud 50 ms, hold 20 ms; clearing in
 * four to six files a day; processor time limits of 2 to 3 seconds (6 at Lithic).
 *
 * Checked on 11 November 2026: Tide's support page says Tide is not a bank, is authorised to
 * issue e-money, its current accounts are powered by ClearBank, and its cards are issued by Tide
 * or PrePay Technologies under licence from Mastercard. Capital on Tap's own page and Funding
 * Circle say Capital on Tap provides the Tide credit card. Which processor Tide uses today was
 * not checked, so it is phrased as an assumption. Fees and salaries are labelled as assumptions.
 */
export const extras: Extras = {
  opening: [
    "Before I draw anything: which side of the card do you mean? There are two quite different systems behind that question. The issuer gets a request from the network and has a couple of seconds to say yes or no against the cardholder's money. The acquirer, or a payment provider like Stripe, takes a charge from a merchant and has to send it out and find out what happened. They share the same four parties and the same three phases (authorise, clear, settle), but the hard problems are different.",
    "Unless you would rather I didn't, I'll take the issuer side. That is the side a business bank is on: Tide's members carry Mastercard cards, and a decline at a till is the failure they feel. I'll treat the acquirer side as a variant at the end. I'll also design for debit on the account balance first and treat credit as a variant: the authoriser checks a credit limit in place of a balance, and statements and interest are a ledger concern. I believe Tide's own credit card comes through a partner anyway.",
    "Questions that change the design. Are we connected to Mastercard ourselves, or through an issuer processor that sends us a webhook? Most e-money firms and newer banks start on a processor such as Marqeta, Paymentology, Thredd, Lithic or Enfuce, and I'll assume that is where we are today. How many cards and purchases? I'll assume about 1.2 million cards and one purchase per card a day: 1.2 million authorisations, about 135 a second at the yearly peak. Out of scope: card production, 3-D Secure screens, people working disputes, credit decisions.",
    "That makes it clear what this is not: a throughput problem. 135 messages a second fits on one database. The hard problem is answering correctly inside a fixed time, every time, while never approving money that is not there. A retry, a reversal, a late answer and a stand-in decision must all leave the balance exactly right. And then clearing, a day later, at a different amount, has to find the right hold.",
    "The shape of the answer. A gateway that owns the clock and keeps card numbers in a small PCI zone. An authoriser that runs cheap checks first, fraud inside 50 ms, and the hold last, as one ledger transaction keyed by the network's identifiers. An outbox for events so notifications never slow a purchase. Clearing files matched to holds, net settlement, and a daily three-way reconciliation. Stand-in parameters set in advance as a product decision.",
    "I'll do the sums, draw the authorisation path with its time budget, go deep on the hold and idempotency, then clearing and money, then failure and security. I'll finish with the decision I think matters most for a firm like Tide: whether to keep the processor or connect to the scheme ourselves, and how to move without anyone noticing.",
  ],

  pushes: [
    {
      q: "Your ledger database fails over at lunchtime and is unavailable for 90 seconds. What happens to every tap?",
      a: [
        "The authoriser cannot place a hold, so it does not approve. It declines with a system-error code inside its own deadline, or, better, it does not answer and the network times out into stand-in. Which of those we prefer is a setting we chose before the incident, not a decision at 1pm.",
        "Stand-in approves on the parameters we gave the network: a per-card limit, a daily cap, refused categories such as gambling. At about 45 a second on a normal peak, that is 4,000 purchases decided by someone else. We accepted that exposure when we set the limits.",
        "When the ledger is back, the network sends advices (0120) for what it approved. We post each as a hold, even if it takes the balance negative. We apply, we do not decide again. Clearing will match them like any other hold.",
        "What I would watch: the stand-in share, approvals lost (purchases stand-in declined that we would have approved), and how many accounts went negative. Those three numbers tell me whether the stand-in limits were right.",
        "And I would shorten the 90 seconds: a synchronous standby in the other site and a scripted promotion, rehearsed. The ledger is the one dependency the authoriser cannot do without, so its failover time is effectively our outage time.",
      ],
    },
    {
      q: "Today you are on a processor. Should Tide connect to Mastercard directly, as Monzo did?",
      a: [
        "Not by default. A processor buys the network link, the PCI zone, the HSMs, clearing files and scheme certification. What it costs is control: its outage is ours, our decision gets a slice of its time budget (2 to 3 seconds), and its matching rate and roadmap become ours.",
        "Bring it in-house when three things are true. Processing fees are a large line, which at about 440 million authorisations a year they may be. The processor is the cause of incidents or limits on product, not just an occasional annoyance. And we already own the hard parts above the wire: authorisation decisions, holds in our ledger, our own clearing and reconciliation.",
        "What it costs: scheme certification and a testing cycle measured in months; PCI DSS for a cardholder data environment of our own, assessed every year; payment HSMs in each site and the key ceremonies to load them; two data centres with circuits to the network; and a 24/7 on-call rota with people who can read ISO 8583. That is a standing team, not a project.",
        "Monzo moved after its processor's outages in 2017 and that made sense for them. I would want our own outage history and fee numbers on the table before recommending it, and I would phase it so every step before the scheme connection is useful even if we never take the last one.",
        "The middle path is worth naming: some processors offer a lower-level service where they hold the scheme link and the HSMs but we run decisioning, ledger and clearing logic. That removes most of the product limits without the certification and data-centre cost.",
      ],
    },
    {
      q: "How would you move a million cards from the processor to your own connection?",
      a: [
        "The network routes by card number range (BIN), not by card. So the unit of migration at the network is a BIN range, and moving one is a scheme change with lead time, not a flag we flip. Card by card only works by reissuing cards into a new range that already routes to us.",
        "Before any routing change, the decision is already ours: in the processor phase our authoriser answers their webhook. Moving to our own gateway changes the transport, not the logic. I would shadow it: feed the processor's request stream into our gateway path and compare every decision.",
        "Start with a new, small BIN range: staff cards, then new cards for one product. Grow it through natural reissue (expiry, loss, replacement) before moving an existing range in one go. Each move is a one-way door for that range for weeks, so rollback is keeping the processor contract and their stand-in alive while we prove it.",
        "Two traps. Chip keys: the processor's HSMs hold the keys that check every card's cryptogram, so either they are exported to ours under a key ceremony or the cards are reissued. And reissuing changes the card number, which breaks merchants' stored cards and wallet tokens, so we lean on Mastercard's updater services and token life-cycle handling and tell customers well ahead.",
        "During the mixed period we run two clearing inputs (the processor's reports and Mastercard's files) and one reconciliation across both, with the settlement account the single truth.",
      ],
    },
    {
      q: "Two taps on two cards of the same business arrive at once, against the last £10. Prove only one is approved.",
      a: [
        "The funds check and the hold are one transaction on the account: lock the account row, read the available balance (posted less open holds), insert the hold if it fits, insert the outbox row, commit. The second transaction waits for the lock and then sees the first hold.",
        "Daily limits are checked in the same transaction against the same account's totals, so they cannot race either.",
        "The key is the network's identifiers for the authorisation. A retry of the first tap finds its stored decision and gets the same answer, without touching the balance.",
        "The cost is that a busy business with many cards queues on one row. At this size that is milliseconds. If one customer ever made it a problem I would split their spend limit across sub-allocations per card, not loosen the lock.",
        "Never a reservation in a cache that is written to the ledger later. That can approve money that is not there, and an approval cannot be taken back.",
      ],
    },
    {
      q: "Our approval reached the network after its timer. What does the customer's balance show?",
      a: [
        "The network has already answered by stand-in and ignores our late response. We have a hold that may not match what happened at the till.",
        "The advice that follows is the truth. If stand-in approved, keep our hold (or create one if we had declined). If it declined, release ours. Our own record is never the authority over what the network decided.",
        "This is why the gateway owns a deadline well inside the network's: we aim to answer in under a second, so most slowness ends as our decline, not as a disagreement.",
        "I would count these mismatches. A rising number means our latency is too close to the limit, and it is the earliest warning before stand-in share rises.",
      ],
    },
    {
      q: "The clearing record says £36.55, the hold was £36.40, and some records match nothing. How does clearing work?",
      a: [
        "No field links a clearing record to its authorisation, so match on authorisation code, card, merchant and amount within a tolerance. Post the final amount, release the hold, write the event, all in one transaction keyed by file and record number.",
        "Amounts differ for good reasons: tips, exchange rate on the clearing day, a hotel bill larger than the pre-authorisation. Post what clears.",
        "Records with no hold (offline taps, forced posts) are posted anyway, even into a negative balance, and sent for review. The remedy for a wrong one is a dispute, not a refusal.",
        "Holds that never clear lapse at the end of the network's window. Unmatched records go to a queue with an owner. Marqeta cites about 99 per cent automatic matching; I would set that as our target and treat the rest as work, not noise.",
      ],
    },
    {
      q: "How would you phase this, and what would you not build?",
      a: [
        "First quarter: our authoriser answering the processor's webhook, with card controls and rules-based fraud, and a decline on timeout we chose. The processor still holds balances or we fund just in time. That retires the risk that our decisions are wrong, with the processor as a safety net.",
        "Then holds in our own ledger, then our own clearing and three-way reconciliation, then stand-in parameters we own and review. Only after all of that, and only if the numbers justify it, our own scheme connection by BIN range.",
        "Not building: a rules engine for the risk team on day one (limits live in data first), our own vault or HSMs while a processor holds the card numbers, streaming clearing (files arrive in batches anyway), multi-currency accounts, or an in-house fraud model before we have labelled data. Each has a trigger I would write down.",
        "Every phase is useful on its own, so if the company decides never to connect to the scheme, nothing was wasted.",
      ],
    },
    {
      q: "How do you know it is working?",
      a: [
        "Five numbers on one dashboard: approval latency at the 99th percentile, wrongful declines (declines caused by us, not the customer), stand-in share, unmatched clearing records, and reconciliation breaks by age.",
        "Wrongful declines are the one most teams miss. Approval rate alone moves with fraud and customer behaviour; declines with a system reason code (timeouts, errors, dependency down) are ours and should be near zero.",
        "Correctness is a number too: zero unexplained breaks older than one business day between ledger, clearing totals and the settlement account.",
        "I would also run a few test cards in production every few minutes, a synthetic purchase end to end, because the first sign of a broken path should not be a customer at a till.",
      ],
    },
    {
      q: "Who owns the authorisation path, the ledger and fraud? Where do they argue?",
      a: [
        "The card authorisation team owns the gateway or processor integration, the authoriser, the card store and the time budget. It is the only team that can change what happens inside the 300 ms.",
        "The ledger team owns holds and postings behind an API with a 20 ms objective. The authoriser is a client. It never reads ledger tables.",
        "Fraud owns the model and its features. It gets 50 ms and a contract: late means rules only, and fraud never blocks the path. The argument is always 'one more feature, 10 more ms', and the answer is that the budget is fixed and owned by the authorisation team.",
        "Stand-in parameters and card controls are product and risk decisions, signed off by them and reviewed quarterly. Engineering implements and reports how they performed.",
      ],
    },
    {
      q: "Turn it round. You are the acquirer, or a payment provider like Stripe.",
      a: [
        "Now we send the request and wait. The hard part is not knowing: a timeout after sending may still have been approved, so we must never charge twice.",
        "Record the attempt with the merchant's idempotency key before calling out. On a timeout, query the status or send a reversal, never a blind retry with a new identity.",
        "The life cycle is ours to drive: authorise, capture, refund, and disputes arriving as debits. Webhooks tell the merchant, fed from the same outbox pattern.",
        "Reconciliation flips too: we match what we captured against the network's settlement and what we paid out to merchants.",
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: "1. Our decision on the processor's request (one quarter)",
        ships: "An authoriser that answers the processor's real-time webhook (Marqeta's just-in-time funding, Lithic's Auth Stream Access and similar): card status and freeze, owner's controls, rules-based fraud and velocity limits, idempotent on the processor's identifiers, a decline-on-timeout setting, and events through an outbox. Balances may still be checked against our existing account system. A team of four or five, behind a flag, card range by card range.",
        why: "Retires the risk that our decisions are wrong or slow, while the processor still holds the network link, PCI scope and clearing. Customers notice the controls and instant freeze straight away, so it earns its keep even if nothing else ships.",
      },
      {
        name: "2. Holds in our own ledger",
        ships: "The funds check and the hold as one ledger transaction keyed by the authorisation's identifiers; reversals, partial and incremental authorisations, advices and expiry of holds. Available balance shown in the app from our ledger.",
        why: "Retires the risk of approving money that is not there, which is the most expensive mistake. It comes second because it needs phase 1's identifiers and life-cycle events to be reliable first.",
      },
      {
        name: "3. Clearing and three-way reconciliation",
        ships: "Clearing from the processor's reports (or Mastercard's files if direct): match to holds, post final amounts, forced posts, refunds. Daily reconciliation of ledger, clearing totals and the settlement account, with a break queue that has owners and evidence. Settlement funding forecast.",
        why: "Until this exists we trust the processor's books. After it we can prove every penny ourselves, which safeguarding needs and which any later move away from the processor depends on.",
      },
      {
        name: "4. Stand-in parameters and resilience",
        ships: "Stand-in limits per card and per day and refused categories, agreed with product and risk and set at the processor and network. Posting of advices, game days for ledger failover and loss of one site, synthetic test purchases, alerting on stand-in share.",
        why: "Turns 'what happens when we are down' from luck into a reviewed decision. It also fits the operational resilience work the regulator expects for an important business service like card payments.",
      },
      {
        name: "5. Own scheme connection, only if the case holds",
        ships: "Gateway with ISO 8583 over persistent TCP from two sites, card vault, payment HSMs, PCI zone, scheme certification, then migration by BIN range starting with staff cards and a new range for new cards.",
        why: "The last and most expensive step, and optional. By now every part above the wire is ours and proven, so this changes the transport and the security perimeter, not the decisions or the money.",
      },
    ],

    migration: [
      "Two migrations hide in this. The first is moving the decision and the money from the processor to us while the processor keeps the network link. The second, optional, is moving the network link itself. Do them years apart if at all.",
      "Decision first, in shadow. Our authoriser receives a copy of every request and decides, but the processor's or the existing system's answer is used. Compare per request: same outcome, same reason. Differences are triaged daily until the unexplained rate is near zero for a few weeks including a month end.",
      "Then go live for a slice of cards with a flag per card: staff, then a few per cent of members, then the rest. Rollback is the flag; the processor's own decisioning stays configured behind us, with a default on timeout we chose.",
      "Holds: shadow-post holds into our ledger from the processor's authorisation and advice stream and compare available balances per account every few minutes. Cut over per account when it has no holds in flight, or carry open holds across with their original identifiers so clearing still finds them.",
      "Clearing: run our matching on the processor's clearing data alongside their posting, compare posted amounts per record, and only then let ours post. Reconciliation against the settlement account runs across both throughout, because safeguarding does not pause for a migration.",
      "Network link, if we take that step: the network routes by BIN range, so the unit is a range. Start with a new small range for staff cards issued on our connection, then new and replacement cards into new ranges, then move an existing range by scheme routing change. Each range move is planned with the processor and Mastercard weeks ahead, avoids month ends and peak trading days, and keeps the processor contract and stand-in alive as the rollback.",
      "Plan for keys and card numbers. Either the issuer keys move from the processor's HSMs to ours under a witnessed key ceremony, or the cards are reissued. Reissue means new card numbers, so wallet tokens and merchants' stored cards must be updated, and members told in advance.",
      "Brief compliance early. A change of card processor is a material outsourcing change, and I would ask whether the regulator and Mastercard need notice and on what timetable.",
    ],

    slos: [
      {
        name: "Approval latency",
        target: "Target: our decision in under 300 ms at the 99th percentile, measured from request received to answer sent; never more than 1 second.",
        why: "The page's budget adds to about 106 ms typically. Processors give 2 to 3 seconds and the network longer, but staying well under a second leaves room for a retry and keeps late answers, and the disagreements they cause, rare.",
      },
      {
        name: "Wrongful declines",
        target: "Target: under 0.05 per cent of authorisations declined for a system reason (timeout, error, dependency down) over a month.",
        why: "This is the failure a member feels at a till and the one approval rate hides. At 1.2 million a day, 0.05 per cent is 600 people a day; I would start there and tighten it once we can measure it reliably.",
      },
      {
        name: "Stand-in share",
        target: "Target: under 0.1 per cent of authorisations decided by stand-in in a month, and no single incident putting more than 5 minutes of traffic into stand-in.",
        why: "Stand-in is safe but blind: it approves less than we would and approves things we might not. Visa's own figures show stand-in approving far fewer than issuers do. A month at 0.1 per cent is about 36,000 purchases, roughly 13 minutes of full outage.",
      },
      {
        name: "Unmatched clearing records",
        target: "Target: 99 per cent of clearing records matched automatically on arrival; every unmatched record owned within one business day.",
        why: "Marqeta reports about 99 per cent against an industry norm of about 88. Each unmatched record is either a hold left open, which hides spendable money, or a posting with no context for the member.",
      },
      {
        name: "Reconciliation breaks",
        target: "Target: zero unexplained breaks between ledger, clearing totals and settlement account older than one business day; each day reconciled by a fixed hour.",
        why: "This is what correct means for money. One business day matches the settlement and safeguarding cycle, so a break is understood before the next one arrives.",
      },
      {
        name: "Freeze takes effect",
        target: "Target: a card frozen in the app declines on the next authorisation, 100 per cent, checked by a synthetic test card.",
        why: "It is the control members use when a card is stolen. A freeze that lags by a replica's delay is a fraud loss and a complaint.",
      },
    ],

    oncall: [
      "Pages at 3am: approval rate or authorisation volume falling sharply against the same hour last week; stand-in share rising; wrongful declines or p99 latency burning the SLO fast; synthetic test purchases failing.",
      "Pages at 3am: loss of the processor's webhook or our network connections in one site, the HSM pool in one site, or the ledger not accepting holds. Each of these sends traffic to stand-in within seconds.",
      "Pages at 3am, near the cut-off: the settlement funding forecast short for the next settlement. Missing it breaks scheme rules.",
      "Waits for the morning: individual unmatched clearing records, a single small reconciliation break, a clearing file late within its cycle, notification lag, consumer lag for analytics, fraud model running on rules only for a few minutes (alert, but the path is safe).",
      "First runbook: ledger or a core dependency down. How to confirm stand-in is taking the load, what our parameters are, how to post the advices afterwards, how to tell customer support and the status page.",
      "Second runbook: processor or network link outage. Who to call at the processor or Mastercard, how to tell whether it is them or us, which side to drain, and what members will see.",
      "Third runbook: clearing file problems. A file missing, duplicated or failing its totals: how to set it aside, rerun it safely, and check the settlement forecast still holds.",
    ],

    teams: [
      { name: "Card authorisation", owns: "The processor integration or gateway, the authoriser and its ordered checks, the card store and controls, idempotency on network identifiers, the time budget, stand-in configuration, synthetic test cards. Owns the relationship with the processor or Mastercard technically." },
      { name: "Ledger", owns: "Holds, postings, balances and the outbox behind an API with a latency objective. Serves cards, payments and lending. The authoriser and clearing are clients and never write ledger tables." },
      { name: "Card operations and reconciliation", owns: "Clearing ingestion and matching, forced posts, the unmatched queue, settlement funding forecast, three-way reconciliation and breaks, dispute plumbing. Engineers working daily with finance and disputes operations." },
      { name: "Fraud and risk engineering", owns: "Features from the event stream, the model and rules, the 50 ms scoring service, post-authorisation alerts. The boundary that matters most is the authorisation path: fraud gets a fixed budget and a fallback, the ledger gets one transaction, and only the authorisation team may add time to the path." },
    ],

    buildBuy: [
      { part: "Network connection, clearing files, PCI zone", call: "Buy: an issuer processor (Marqeta, Paymentology, Thredd, Lithic, Enfuce)", why: "Certification, HSMs, two sites and 24/7 operations are a standing cost that only pays at scale or when the processor limits the product. Revisit with outage history and fee numbers each year." },
      { part: "Authorisation decision", call: "Build", why: "Controls, limits and the member's experience at the till are the product. Every processor offers a real-time decision hook for exactly this." },
      { part: "Ledger and holds", call: "Build (or extend the existing ledger)", why: "Balances are ours and safeguarding is ours. A processor-held balance makes our app show their view of money." },
      { part: "Clearing matching and reconciliation", call: "Build the matching and three-way reconciliation; take the processor's clearing data as input", why: "We need our own proof of every penny, and it is the precondition for ever moving off the processor." },
      { part: "Fraud scoring", call: "Start with rules and the processor's or network's risk scores; build a model when we have labelled data", why: "Vendors such as Featurespace and Feedzai exist and are trained on more data than ours; the price is an outside call in a 50 ms budget, so measure it first." },
      { part: "Payment HSMs (only with own connection)", call: "Buy: payment HSMs such as Thales payShield, or AWS Payment Cryptography", why: "Nobody builds these. The choice is hardware in our sites against a managed service, and depends on where the gateway runs." },
      { part: "Card events log", call: "Buy: managed Kafka", why: "About 5 million events a day is small, and the outbox pattern is the part that matters, which we build." },
    ],

    cost: [
      "Volume: about 1.2 million authorisations a day is about 440 million a year, plus as many clearing records. Infrastructure for 135 messages a second at peak, built for 1,000, is small: a few services in two regions and one ledger primary with a synchronous standby.",
      "Processor fees are the line that drives the build-or-buy case. Assumption: if all-in processing costs a penny an authorisation, that is about £4.4 million a year; at half a penny, about £2.2 million. The real number is in the contract and is the first thing I would ask for.",
      "Own connection, assumption: a standing team of 12 to 20 engineers across gateway, HSM and keys, clearing and on-call, at a loaded £100,000 to £130,000 each is roughly £1.5 to £2.5 million a year. Add two data centre presences with network circuits, payment HSMs in each, an annual PCI assessment, and scheme certification. It pays only if fees are near the top of that range or the processor costs us in outages and product.",
      "Monzo's case was outages, not fees. Ours may be different; I would show both columns.",
      "Headcount for phases 1 to 4 on a processor: authorisation team of four to six, card operations and reconciliation of three or four, a share of ledger and fraud teams. Most of that is needed whether or not we ever connect directly.",
      "The cost of being wrong dominates: a day of wrongful declines costs members' trust, and a safeguarding shortfall or a missed settlement costs regulatory and scheme attention far beyond a year of machines.",
    ],

    risks: [
      { risk: "Processor outage: their incident is our members' declined cards, as Monzo found in 2017.", answer: "Stand-in parameters we own and review; ask the processor for their resilience evidence and outage history; synthetic test purchases so we know before support does; the build-or-buy review each year uses real outage minutes." },
      { risk: "Approving money that is not there, through a race, a retry or a hold placed after the answer.", answer: "Funds check and hold in one ledger transaction keyed by the network's identifiers; property tests firing concurrent and repeated requests; decline or stand-in when the ledger cannot answer, never approve and post later." },
      { risk: "Regulatory: safeguarding of e-money funds and daily reconciliation break during the move, or card payments miss their impact tolerance under the operational resilience rules.", answer: "Reconciliation is phase 3, before any move of money or link, and runs across old and new. Card payments mapped as an important business service with a tested tolerance. Compliance briefed before each phase and on any outsourcing change." },
      { risk: "Scheme obligations: settlement not funded on time, stand-in left misconfigured, dispute deadlines missed, or certification slipping and blocking a migration.", answer: "Settlement forecast with an alert well before cut-off; stand-in parameters reviewed quarterly by product and risk; dispute deadlines tracked as work items; certification planned with Mastercard and the processor months ahead, never on the critical path of a promise to the business." },
      { risk: "PCI scope creep: card numbers leak into logs, events or the ledger and pull half the estate into scope.", answer: "Card numbers stop at the gateway or never reach us on a processor. Tokens everywhere else; log scanning for card-number patterns in CI and production." },
      { risk: "Migration by BIN range is a one-way door, and reissue breaks stored cards and wallet tokens.", answer: "Start with a new small range for staff, grow through natural reissue, keep the processor live as fallback, use the network's updater and token services, and tell members ahead of any reissue." },
      { risk: "People: 24/7 on-call for a payment path on a small team, and only one or two people who understand ISO 8583, keys and clearing.", answer: "Do not take the own-connection step until the rota is at least six to eight people deep. Pairing, written runbooks, game days run by different people each quarter, and the processor's support contract kept as a backstop." },
    ],
  },

  rehearsal: [
    {
      stage: "Clarify and choose a side",
      minutes: 5,
      prompt: "Ask which party the interviewer means, say which you will take and why, and ask the questions that change the design. State your assumptions and the hard problem out loud.",
      cover: [
        "Issuer or acquirer; takes issuer, because that is the side a business bank is on, acquirer as a variant.",
        "Debit first, credit as a variant: limit in place of balance, statements and interest in the ledger.",
        "Direct to the network or through an issuer processor; assumes a processor today.",
        "Cards, purchases a day, peak; what is out of scope.",
        "Names the hard problem: answer correctly inside a fixed time, never approve money that is not there.",
      ],
    },
    {
      stage: "Numbers",
      minutes: 3,
      prompt: "Do the sums that decide the architecture, and say what they tell you about where the difficulty is.",
      cover: [
        "About 1.2 million authorisations a day, 14 a second on average, about 135 messages a second at the yearly peak; build for 1,000.",
        "Under 100 ledger writes a second at peak; clearing in four to six files a day.",
        "Conclusion: not a throughput problem; latency, correctness and availability.",
      ],
    },
    {
      stage: "Authorisation path and time budget",
      minutes: 9,
      prompt: "Draw the path from the network to an answer and put the time on each hop. Say who owns the clock and what each step does when a dependency is late.",
      cover: [
        "Four parties and three phases: authorise, clear, settle.",
        "Gateway owns the deadline; every call gets only what is left.",
        "Ordered checks: card state, cryptogram or 3-D Secure, controls, fraud within 50 ms, funds and hold last.",
        "Budget about 100 ms typical, 300 ms at the 99th percentile, hard stop well under the network or processor limit.",
        "Card numbers stop at the gateway; tokens behind it; HSM checks the chip.",
        "Freeze read from the primary or a cache cleared on write.",
      ],
    },
    {
      stage: "The hold and idempotency",
      minutes: 7,
      prompt: "Go deep on approving money exactly once. Walk through a race, a retry, a reversal, a late answer and an advice.",
      cover: [
        "Funds check and hold in one ledger transaction, with the outbox row.",
        "Key from the network's identifiers; a retry returns the stored decision.",
        "Reversal releases the hold; expiry is the backstop.",
        "Late answer: stand-in decided, the advice is the truth.",
        "Strong consistency for money; notifications and rewards read the log.",
      ],
    },
    {
      stage: "Clearing, settlement, reconciliation",
      minutes: 7,
      prompt: "Follow the purchase to the next day and to the bank account. Show what goes wrong and how you would know.",
      cover: [
        "Match on authorisation code, card, merchant and amount; amounts differ.",
        "Forced posts and offline taps posted anyway; disputes as the remedy.",
        "Idempotent per file and record; duplicate files post nothing.",
        "Net settlement once a working day; funding forecast before cut-off.",
        "Three-way reconciliation with owned breaks.",
      ],
    },
    {
      stage: "Failure and security",
      minutes: 5,
      prompt: "Break it. Pick the failures an interviewer will pick, and say what the member at the till sees in each.",
      cover: [
        "Ledger down: decline or stand-in, never approve without a hold; post advices afterwards.",
        "Fraud slow: rules only, recorded.",
        "Lose a site: the other answers; stored keys catch in-flight repeats.",
        "Stand-in parameters as a product decision made in advance.",
        "PCI scope kept small by tokens; keys only in HSMs.",
      ],
    },
    {
      stage: "Build or buy, and migration",
      minutes: 5,
      prompt: "Step back. Say whether this firm should run its own scheme connection, what it would cost, and how you would get there without members noticing.",
      cover: [
        "Processor first; own connection only when fees, outages or product limits justify a standing team.",
        "Costs named: certification, PCI DSS, HSMs and key ceremonies, two sites, 24/7 on-call.",
        "Migration by BIN range, starting small with staff cards and new cards; chip keys and reissue as traps.",
        "Shadow decisions and holds before any cut-over; processor kept as rollback.",
      ],
    },
    {
      stage: "Leading it",
      minutes: 4,
      prompt: "Tell them how you would deliver and run it: the order, the measures and who owns what.",
      cover: [
        "Phases: decision on the processor webhook, own holds, clearing and reconciliation, stand-in parameters, then optionally the scheme link.",
        "SLOs: latency, wrongful declines, stand-in share, unmatched clearing, reconciliation breaks.",
        "Teams: authorisation owns the path and the budget, ledger owns holds, fraud gets 50 ms, card operations owns clearing and reconciliation.",
        "What pages at 3am; regulatory and scheme risks and the answers.",
      ],
    },
  ],
};
