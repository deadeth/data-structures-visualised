import type { Extras } from './types';

/**
 * Interview extras for the suspicious transaction alerts design: what to say first, the likely
 * pushes, how to lead the build, and a timed rehearsal. Numbers agree with src/designs/fraud-alerts.ts.
 */
export const extras: Extras = {
  opening: [
    "Let me play it back. A small business owner should hear, within seconds, that a transaction on their account looks wrong, on the channel they prefer, and be able to answer. I read that as two systems joined by one event: deciding a payment is suspicious, inside the payment path, and then telling the right people and getting their answer back. I will spend most of the time on the second, with enough detection to be credible. Does that match what you want?",
    "A few questions first. Which transactions: outbound Faster Payments and card spend at least? Do we hold the payment, or only tell? Who are the users: the owner alone, or directors, a bookkeeper and staff with cards? Is there an app with bound devices? And what does real-time mean to you in seconds?",
    "If you leave it to me, I will assume a UK business bank of about a million small businesses, about 4 million payments a day and about 8,000 alerts. Outbound Faster Payments are held before submission, because once sent they cannot be cancelled. Card spend gets an alert after the fact. There is an app, and the owner's phone is bound to the account.",
    "Throughput is tiny: about one alert a second. The hard problem is that a held payment must end in an answer, an expiry into a case, or a decision by a person, and never in silence. That means no lost events, no duplicate alerts, an escalation ladder when nobody answers, and an answer path that moves money safely. Preferences matter, but they choose the channel and order, not whether a security alert is sent.",
    "The shape: the payment service asks a risk engine for a verdict within 150 ms and, if it is hold, commits the hold and an outbox row together. The event goes on a log keyed by account. An alert service gives it a stable id, asks preferences who to tell, writes it down, and puts send jobs on a P0 queue that marketing can never block. Channel workers call Apple, Google and SMS providers. The owner's answer comes back through a reply service that blocks with one tap and releases only with strong authentication.",
    "Because I would be leading this rather than only drawing it, I will also say what a first version is, what I would buy, how I would roll it out without hurting good customers, and what I would measure.",
  ],

  pushes: [
    {
      q: "How do you guarantee that a held payment is never left with nobody told, and that the owner does not get five copies?",
      a: [
        "The hold and its event commit in one transaction through an outbox, so there is no held payment without an event. I alarm on the age of the oldest unpublished row, and cap holds without a published event.",
        "Everything after that is at-least-once. The alert id is a hash of payment id and reason, so a redelivered event finds the alert. Each send has a dedup key of alert, person, channel and step, set before the call. Push uses the alert id as collapse id, so a rare duplicate replaces rather than stacks.",
        "Offsets are committed only after the alert is written and its jobs are queued. Timers are a next-action time on the alert row, and a sweeper re-enqueues overdue steps, so a deploy cannot lose an escalation.",
        "The real guarantee is a reconciliation: every held payment must reach a terminal state, answered, expired into a case, or decided by a person. I would run that check continuously and page on any hold older than its ladder with no recorded step.",
      ],
    },
    {
      q: "The owner is being coached by a scammer and taps \"Yes, it was me\". What does your system do?",
      a: [
        "Be honest: a was-this-you alert stops account takeover, not authorised push payment fraud. In an APP scam the owner really is making the payment.",
        "So the answer depends on why the payment was held. For takeover signals, \"Yes\" with strong authentication bound to amount and payee releases it. For scam signals, such as a first payment to a new payee with a Confirmation of Payee mismatch or a pattern like a safe-account scam, \"Yes\" leads to a specific warning about that scam, and above a threshold to a call from fraud operations.",
        "The payment delay rules let us hold for up to four business days with reasonable grounds, if we tell the payer why. That is the tool for the high-risk minority, not a default.",
        "It matters commercially: since October 2024 the sending bank carries half the reimbursement for APP fraud on Faster Payments up to £85,000, and micro-enterprises are covered. The audit trail of what we warned and when is our evidence.",
      ],
    },
    {
      q: "With fraud at about 1 in 10,000 transactions, almost every alert goes to an honest owner. How do you stop them learning to ignore it?",
      a: [
        "Treat precision and alert volume as product metrics I own jointly with the fraud lead and the product lead, not as a model detail. If at most one alert in 20 is fraud, every other alert is a cost to a customer and to fraud operations.",
        "Measure alerts per active business per month, the share answered \"Yes\", time to answer, and the share answered \"Not me\" that were confirmed fraud. Agree a ceiling on alerts per business and treat breaking it as an incident for the rule that caused it.",
        "Spend friction where risk is: a known device gets an in-flow warning, not an alert. Only new devices and high-risk patterns get a hold and an out-of-band question.",
        "Every rule is back-tested on history before it ships and goes live in shadow first, so we know its false-positive cost before a customer sees it.",
        "Make \"Yes\" one tap plus authentication and keep the wording specific: amount, payee, why it was held. Vague alerts train people to dismiss them.",
      ],
    },
    {
      q: "Why build this? There are notification vendors that do templates, preferences and channels.",
      a: [
        "Split by priority. The P0 security path, meaning the alert service, ladder, dedup and reply path, is tied to holds on real money and to our audit evidence. I would build that: it is small, about 25,000 sends a day, and it is our risk.",
        "Push gateways are Apple's and Google's; there is nothing to buy in between that adds value on P0, so call APNs and FCM directly.",
        "SMS and voice are commodities: buy them from two aggregators so one outage is not ours.",
        "Marketing and product messages, P2 and P3, are a fine fit for a hosted vendor such as Braze or Customer.io, and that keeps campaigns off our P0 infrastructure entirely.",
        "For a start-up of 10,000 businesses I would reverse most of this and buy, keeping only the alert id, the hold and the reply rules in-house.",
      ],
    },
    {
      q: "Users have preferences. Can an owner turn fraud alerts off, or set quiet hours?",
      a: [
        "Preferences choose who, which channel first, language and thresholds. They do not choose whether a security alert is sent. Categories carry the rules: security overrides quiet hours and marketing opt-outs and always includes the mandatory channels.",
        "If the preference service is down, security alerts fail open to the cached plan or the mandatory default: the owner's bound devices by push, then verified mobile by SMS. Marketing fails closed.",
        "Roles matter more than channels in a small business. Only people with authority over the account get the buttons; the bookkeeper gets a read-only copy above her threshold.",
        "Security alerts must stay pure service messages: no promotion in them, or under PECR they start to count as marketing.",
        "The plan is stored with the alert, so a complaint months later can see exactly which rules applied that night.",
      ],
    },
    {
      q: "Two people answer differently: a director taps \"Yes\" and the owner taps \"Not me\". Who wins?",
      a: [
        "The safer answer wins. Any \"Not me\" blocks; release needs the owner or a director, with strong authentication.",
        "The reply service is idempotent on the alert id, so the first applied answer is recorded and later ones get the current state back with an explanation.",
        "A block that races a release goes to fraud operations as a case, because two people with authority disagreeing is itself a signal.",
        "The asymmetry is the point: a wrong block costs a delay; a wrong release costs the money.",
      ],
    },
    {
      q: "What happens when the risk engine, Kafka or Apple's push service is down?",
      a: [
        "Risk engine slow or down: the payment service applies a fixed fallback by band within the 150 ms budget. Small payments to known payees go through, large payments to new payees are held. It never waits.",
        "Kafka down: holds still happen and outbox rows wait. That is a page, because people are not being told; past a cap the payment service applies the stricter fallback.",
        "APNs failing: the breaker opens and P0 jobs move straight to SMS without waiting 90 seconds. The inbox still holds every alert.",
        "The principle is fail safe: if in doubt, hold and tell. An expired hold is rejected, never released.",
      ],
    },
    {
      q: "You have a small team and a quarter. What ships first, and what waits?",
      a: [
        "First version: rules only in the risk engine, the hold in the payment service with an outbox, an alert service with stable ids, push plus SMS through one aggregator, the mandatory default as the only preference, an escalation of push then SMS then fraud operations, and the reply path with one-tap block and authenticated release.",
        "Waits: a model, voice calls, a second contact, a preference centre with roles and thresholds, a second SMS provider, and moving other notifications onto the platform.",
        "The order retires the biggest risk first, which is money leaving before anyone is asked. Everything that waits improves precision or reach, and needs real data from version one to tune.",
        "What I would not build at all: our own push connection for locked phones, a workflow engine before we need one, or exactly-once delivery.",
      ],
    },
    {
      q: "How would you roll out holds without hurting good customers?",
      a: [
        "Shadow first: score every payment and log the would-be action, with no hold and no alert. That tells us the hold rate, the latency cost on the payment path, and how many holds each rule would cause.",
        "Then alert-only for a band: tell the owner after the payment, with a way to report it. That proves delivery and the reply path, with no money waiting.",
        "Then hold, by cohort and by rule band, starting with large payments to new payees from new devices, at 1 per cent of accounts and ramping.",
        "Each action has a rate limit, so a bad rule cannot hold everything; a breach pages and the rule rolls back.",
        "Gates between steps are agreed with the fraud lead and compliance up front: hold rate, false-positive rate, time to answer, complaint volume.",
      ],
    },
    {
      q: "How do you know it is working?",
      a: [
        "Reliability: every held payment reaches a terminal state, event to push hand-off under 2 seconds at the 99th percentile, P0 consumer lag, duplicate rate.",
        "Outcome: fraud losses on Faster Payments, reimbursement cost, share of confirmed fraud stopped before submission.",
        "Customer cost: alerts per business per month, false-positive rate, median time to answer, held payments that expire, complaints.",
        "I would trace every alert end to end with its id as trace id, from hold to answer, so a single missed alert can be explained, not averaged away.",
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: "1. Shadow scoring (weeks 1 to 6)",
        ships: "Risk engine with in-house rules on features we already have, called in the payment path with the 150 ms budget and the fallback policy, logging would-be actions only. Outbox and change data capture on the payment service, publishing payment-events keyed by account.",
        why: "Retires two unknowns before any customer is touched: what the payment path latency becomes, and how many holds the rules would cause. It also lays the event backbone everything else reads.",
      },
      {
        name: "2. Hold and ask (end of the first quarter)",
        ships: "Holds for one rule band. Alert service with stable alert ids, dedup keys and next-action timers; P0 topic; push workers to APNs and FCM; SMS through one aggregator; the mandatory default plan; ladder of push, SMS at 90 seconds, then a case for fraud operations; reply service with one-tap block and authenticated release; the in-app inbox as the durable copy. Alert-only for a fortnight, then holds by cohort.",
        why: "This is the version that stops money leaving before anyone is asked, which is the whole point. It is deliberately narrow so a team of five or six can ship it in a quarter.",
      },
      {
        name: "3. Reach and people",
        ships: "Second SMS provider with breakers, voice call step, second contact, roles and authority on the business, preference centre with channel order, thresholds, quiet hours and language, and the security category rules.",
        why: "Version one tells us how many alerts expire unanswered and why. This phase cuts expiries, which is what drives fraud operations workload and customer harm.",
      },
      {
        name: "4. Precision",
        ships: "Model score alongside the rules, stream features for longer windows, back-testing and replay tooling so fraud strategy can change rules themselves, scam-specific warnings on \"Yes\".",
        why: "Only now is there labelled data from our own alerts and answers to train and judge a model. Precision lowers alert fatigue and ops cost.",
      },
      {
        name: "5. One platform",
        ships: "Move transactional notifications onto P1 of the same platform; put marketing on a hosted tool behind the shared preference service.",
        why: "Removes duplicate preference logic across teams, and keeps campaigns physically away from P0.",
      },
    ],

    migration: [
      "Assume today alerts are sent after the fact from a rules job, straight from the payment service to an SMS and email vendor. Nothing is held.",
      "Step one is the outbox. Add it to the payment service and publish payment-events alongside the legacy sends. Reconcile daily: every payment state change in the database has exactly one event on the log.",
      "Run the new risk engine in shadow on live traffic. Compare its would-be actions with the legacy rules job: which payments both flag, which only one does, and why. Fraud strategy signs off the differences.",
      "Run the alert service in dry-run: it consumes events, writes alerts and plans, and enqueues sends to a recording channel instead of providers. Reconcile each legacy alert against a new alert id and compare who would have been told and how.",
      "Cut over by cohort of accounts, chosen by a hash of account id: 1, 10, 50, then 100 per cent. One flag per account, read by both paths, decides which sends; the legacy path checks it before sending, so a business never gets both.",
      "Holds come last, by rule band, after the new alert path has carried a cohort alone for at least two weeks.",
      "Rollback is the flag flipped back for the cohort. Holds already placed stay answerable: the reply service and the sweeper keep running, and any hold whose ladder cannot complete goes to fraud operations as a case. Never release held payments in bulk to roll back.",
    ],

    slos: [
      {
        name: "Decision in the payment path",
        target: "Target: 99th percentile under 150 ms, and 99.95 per cent of payments decided by the engine rather than the fallback",
        why: "The payment is waiting. Past the budget the fallback decides, which is safe but blunt, so its use rate is the real health signal.",
      },
      {
        name: "Event to push handed to Apple or Google",
        target: "Target: 99th percentile under 2 seconds",
        why: "Matches the page budget: under 1 second through log and consumer, under 1 second to hand over. An owner at a till or a supplier on the phone is waiting.",
      },
      {
        name: "Held payments reaching a terminal state",
        target: "Target: 100 per cent answered, expired into a case, or decided by a person; zero silent holds, checked continuously",
        why: "This is the promise the system exists to keep. Any miss is an incident, not an error budget.",
      },
      {
        name: "Duplicate alerts",
        target: "Target: under 1 in 10,000 alerts delivered twice on one channel",
        why: "Duplicates erode trust and look like phishing. Exactly-once is impossible across phone networks, so set a measured ceiling.",
      },
      {
        name: "Time to first answer",
        target: "Target: median under 5 minutes, and under 5 per cent of holds expiring unanswered",
        why: "Expiries become cases and delayed supplier payments. This is where escalation and preferences earn their keep.",
      },
      {
        name: "P0 isolation",
        target: "Target: P0 consumer lag under 2 seconds during any P3 campaign",
        why: "A million-message campaign must never delay a fraud alert. Test it with a campaign-sized load before each peak.",
      },
    ],

    oncall: [
      "Pages at 3am: P0 consumer lag over 2 seconds for a minute; oldest unpublished outbox row older than 30 seconds; risk engine fallback rate above a few per cent; an action rate limit tripped (hold rate spike); any P0 job in the dead-letter topic; both SMS providers' breakers open; any hold past its ladder with no recorded step.",
      "Waits for the morning: P2 and P3 lag, one SMS provider degraded while the other is healthy, slow delivery receipts, rising dead push tokens, model score drift, alert volume per business creeping up.",
      "Runbook 1, people are not being told: check outbox age, Kafka health and consumer lag in that order; how to tighten the hold cap; how to have fraud operations call owners of open holds by hand.",
      "Runbook 2, hold rate spike: decide with the fraud on-call whether it is a bad rule or a real attack, using the rule breakdown. Bad rule: roll it back and re-score held payments. Attack: keep it, reserve provider quota for P0, staff up operations.",
      "Runbook 3, push failing: confirm the breaker opened and P0 is going to SMS; check the APNs and FCM status pages and our credentials and certificates; watch SMS cost and provider quota; how to close the breaker by hand.",
      "Fraud alerts are a 24-hour path, so the rota needs enough people that a page is rare. A small team cannot carry a noisy rota on a P0 system; alert quality is a staffing decision.",
    ],

    teams: [
      {
        name: "Payments core",
        owns: "The payment state machine, the hold, the outbox and payment-events, and the Reject, Release and FreezeCards API. The only team that changes money state.",
      },
      {
        name: "Fraud risk engineering",
        owns: "Risk engine, feature store, rules and model serving, back-testing and replay tooling. Works day to day with fraud strategy analysts and data scientists, who own the rules' content.",
      },
      {
        name: "Notification platform",
        owns: "Alert service, preferences, priority queues, channel workers and providers, the inbox, and the reply service. Serves every team that sends messages; owns P0 delivery SLOs.",
      },
      {
        name: "Fraud operations (not engineering)",
        owns: "Cases, calls to customers, reimbursement decisions. A customer of the platform, with a say in the ladder and case rules.",
      },
      {
        name: "The boundary that matters most",
        owns: "Detection decides an action; payments owns the hold and the money; notifications only tell and carry the answer back through payments' idempotent API. The \"payment held\" event and the Release and Reject calls are the contract, versioned and agreed first. If notifications could move money directly, or risk could hold directly, ownership of a lost payment would be unclear.",
      },
    ],

    buildBuy: [
      {
        part: "Push delivery",
        call: "Use APNs and FCM directly",
        why: "They are the only way to wake a locked phone. Calling them directly gives every option that matters here: priority, Time Sensitive, collapse id, expiry.",
      },
      {
        part: "SMS and voice",
        call: "Buy from two aggregators (for example Twilio, Vonage, Sinch or Infobip)",
        why: "Commodity, priced per message, and an outage on one should not be ours. Two contracts and two webhook formats are the price.",
      },
      {
        part: "P0 orchestration: alert service, ladder, dedup, reply",
        call: "Build",
        why: "Small, tied to holds on real money and to our audit evidence. Vendors such as Courier, Knock or Novu do templates and routing well, but put another company on the path of a regulated security alert.",
      },
      {
        part: "Marketing and product messages",
        call: "Buy a hosted tool (for example Braze or Customer.io)",
        why: "Campaign tooling is not our edge, and it keeps million-message campaigns off P0 infrastructure. It reads the shared preference service.",
      },
      {
        part: "Fraud scoring",
        call: "Build rules and the action layer in-house; evaluate a vendor model (for example Featurespace, now part of Visa, Feedzai or SEON) as one input",
        why: "Rules on our own data are the right first version and must stay ours, because they decide holds and must be explainable. A vendor model can add signal earlier than our own labels allow, at a cost per call and a network hop inside the 150 ms budget.",
      },
      {
        part: "Log, cache and change data capture",
        call: "Use what the bank already runs (Kafka, managed or not; Redis; Debezium for change data capture)",
        why: "Throughput is tiny. Running something new for this would add operational risk for no gain.",
      },
      {
        part: "Durable timers",
        call: "Build a next-action time on the alert row with a sweeper; consider Temporal later",
        why: "One ladder per alert is simple enough. A workflow engine earns its place when ladders multiply across products.",
      },
    ],

    cost: [
      "Infrastructure is small. payment-events is about 4 million events a day at about 1 KB: 4 GB a day, about 85 GB for a week's retention with three replicas. The feature store is about 1 GB in memory. Fraud alerts are a rounding error; every notification of every kind is about 7.5 GB a day, 2.7 TB a year, in monthly partitions. Two regions roughly doubles it.",
      "Provider spend is modest if push leads. Assume a third of the 8,000 daily alerts reach the SMS step: about 2,700 texts a day, about a million a year. At an assumed 3 to 4p a text that is £30,000 to £40,000 a year. Calls at 5 per cent of alerts are about 150,000 a year. Push costs nothing per message. Putting SMS on P1 transactional messages would cost far more than fraud alerts ever will.",
      "Engineering headcount is the real build cost: a notification platform team of five or six, fraud risk engineering of four plus one or two data scientists, and part of a payments team for the hold and outbox. Roughly 12 to 15 people, most of them already exist.",
      "Fraud operations is the running cost that matters. If 5 per cent of alerts expire and up to 1 in 20 is answered \"Not me\", that is 400 to 800 cases a day. At an assumed 15 minutes each, 100 to 200 analyst hours a day, so a team of a few dozen across shifts. Halving false positives and expiries saves more than the entire infrastructure bill, which is why precision is a product metric, not a model detail.",
    ],

    risks: [
      {
        risk: "Alert fatigue: owners learn to tap \"Yes\" without reading.",
        answer: "Own alerts per business and false-positive rate with the fraud and product leads, set a ceiling, shadow and back-test every rule, and keep the wording specific to amount, payee and reason.",
      },
      {
        risk: "A bad rule holds a large share of payments and stalls customers' businesses.",
        answer: "Rate limits on every action, rules shipped in shadow first, rollback in minutes, and re-scoring of held payments after the fix.",
      },
      {
        risk: "APP scams get past a was-this-you alert, because the owner is the one paying.",
        answer: "Scam-specific warnings and friction on \"Yes\" for scam patterns, Confirmation of Payee results as a signal, the payment delay power for the high-risk few, and a call from operations above a threshold.",
      },
      {
        risk: "Regulatory change: since October 2024 the sending bank shares APP reimbursement with the receiving bank, and in March 2025 the government announced the PSR will be folded into the FCA.",
        answer: "My assumption is that the reimbursement and delay rules carry over; I would confirm with compliance and keep them in the design review. Keep the audit trail complete either way: what we warned, when, on which channel, and what the customer answered.",
      },
      {
        risk: "Three teams must change together for the first hold to ship, and a slip in one stalls all.",
        answer: "Agree the held event and the Release and Reject API first, one accountable lead for the end-to-end path, and a shadow mode that lets each team ship its part independently.",
      },
      {
        risk: "SIM swap or a fake bank text turns the SMS channel against the customer.",
        answer: "SMS never carries a link or a code, an SMS reply can only block, and release needs strong authentication on a bound device.",
      },
      {
        risk: "A small team carries a 24-hour P0 rota and burns out.",
        answer: "Few, high-quality pages; runbooks before launch; a rota big enough that pages are rare; and treating every noisy page as a defect to fix that sprint.",
      },
    ],
  },

  rehearsal: [
    {
      stage: "Clarify and scope",
      minutes: 4,
      prompt: "Restate the problem in your own words and ask the questions that change the design. Say what you will assume if they do not answer, and where you will spend your time.",
      cover: [
        "Split detection in the payment path from notification and the answer.",
        "Hold versus only tell, and why Faster Payments force a hold.",
        "Users are several people with roles, not one owner.",
        "Ask what real-time means in seconds.",
        "Say you will go deep on notification, with enough detection to be credible.",
      ],
    },
    {
      stage: "Numbers",
      minutes: 4,
      prompt: "Size it in a minute and say what the numbers tell you about where the difficulty is.",
      cover: [
        "About a million businesses, 4 million payments a day, about 46 a second, build for 1,000.",
        "About 8,000 alerts a day, about 1 a second, bursts of 100 in an attack.",
        "At most 1 alert in 20 is fraud, so \"Yes\" must be easy.",
        "Latency budget: 150 ms decision, under 2 s to push, escalate at 90 s.",
        "Throughput is tiny; latency, duplicates, escalation and people are the problem.",
      ],
    },
    {
      stage: "The line from payment to answer",
      minutes: 8,
      prompt: "Draw the whole path once, end to end, before going deep anywhere. Name what each box owns.",
      cover: [
        "Payment service holds before submission; risk engine returns an action, not a score.",
        "Hold and outbox row in one transaction; log keyed by account.",
        "Alert service, preferences, alert store, P0 topic, channel workers.",
        "APNs and FCM, SMS and voice, the owner's bound phone.",
        "Reply service back to payments; cases for fraud operations.",
      ],
    },
    {
      stage: "Deep dive: never lost, never doubled",
      minutes: 9,
      prompt: "Take one held payment through a crash at each step. Show why nothing is lost and nothing is sent twice, and how escalation survives a restart.",
      cover: [
        "Outbox avoids the dual write.",
        "Alert id from payment id and reason; offsets committed after alert and jobs are written.",
        "Dedup key of alert, person, channel and step; collapse id on push.",
        "Next-action time on the row plus a sweeper.",
        "Push accepted is not seen: the ladder never trusts a 200.",
        "Separate topics, workers and provider quota per priority.",
      ],
    },
    {
      stage: "Preferences and people",
      minutes: 5,
      prompt: "Explain how user preferences and the bank's duty to warn live together, and what happens when the preference service is down.",
      cover: [
        "Preferences choose who, channel order, language and thresholds, not whether.",
        "Security category overrides quiet hours and marketing opt-outs.",
        "Only people with authority get buttons.",
        "Fail open to the mandatory default for security, closed for marketing.",
        "Plan stored with the alert for the audit.",
      ],
    },
    {
      stage: "The answer moves money",
      minutes: 5,
      prompt: "Design the reply path and say what you would never put in a notification or a text.",
      cover: [
        "Idempotent on the alert id.",
        "One tap to block; strong authentication bound to amount and payee to release.",
        "Safer answer wins when two people disagree.",
        "No links, codes or account details on a lock screen or SMS; SMS reply can only block.",
        "The limit: this stops takeover, not a coached APP scam.",
      ],
    },
    {
      stage: "Failure and operations",
      minutes: 5,
      prompt: "Pick three dependencies and say what happens when each fails, and what pages a person at 3am.",
      cover: [
        "Risk engine timeout: fixed fallback by band.",
        "Kafka down: holds continue, page, cap holds.",
        "APNs failing: breaker, straight to SMS.",
        "A bad rule: action rate limits.",
        "What pages versus what waits.",
      ],
    },
    {
      stage: "Leading it",
      minutes: 5,
      prompt: "Say what you would ship first with a small team, what you would buy, how you would roll it out safely, who owns what, and how you would know it works.",
      cover: [
        "Version one: rules, push plus SMS, mandatory default, reply path; model, voice and preference centre wait.",
        "Build P0; buy SMS, voice and marketing tooling; APNs and FCM direct.",
        "Shadow, then alert-only, then hold by cohort.",
        "Payments owns money, risk decides, notifications tell.",
        "False positives and alerts per business as product metrics owned with fraud and product.",
        "Regulation: reimbursement, payment delay, audit trail.",
      ],
    },
  ],
};
