import type { Design } from './types';

/**
 * Suspicious transaction alerts for small business owners, as a high-level design.
 *
 * Two systems joined by one event. In the payment path, a risk engine decides
 * within about 150 ms whether to allow, hold or block an outbound payment. The
 * hold is committed with an outbox row and published on a log keyed by account.
 * The notification platform turns that event into an alert with a stable id,
 * resolves who to tell and how from per-person preferences, sends it through
 * priority queues and channel workers, escalates when nobody answers, and takes
 * the answer back to release or block the payment. The baseline is a UK business
 * bank of about a million small businesses.
 */
export const fraudAlerts: Design = {
  id: 'fraud-alerts',
  name: 'Suspicious transaction alerts',
  blurb: 'Follow one held payment to its answer, then open any part to see what it does and what you could use instead.',
  rest: 'Press Play to follow a payment, or open a box or chip. In the diagram, arrow keys move and Enter opens.',
  restTouch: 'Press Play to follow a payment, or tap any box or chip to open it.',
  size: { w: 1280, h: 520 },
  frame: { x: 550, y: 90, w: 450, h: 426, label: 'Notification platform', note: 'Go deep here' },

  components: [
    {
      id: 'payer',
      name: 'Payer',
      tech: 'app, web, API',
      x: 80, y: 190, w: 130, h: 56, kind: 'outside',
      what: 'Whoever asks the bank to move money: a team member in the app or on the web, an accounting tool through the API, or a shop terminal through the card network. On the tour it is someone signed in from a browser this business has never used.',
      why: 'Who started the payment decides who you should ask. If it is the owner on their usual phone, a warning in the payment screen is enough. If it is a new device, the session itself may be the fraudster, so the question has to go somewhere else: to a device already bound to the account.',
      built: [
        { name: "App", what: "The bank's mobile app on a phone. When it is set up it binds the phone to the account with a key held on the device.", why: "A bound phone is a known device: a payment from it can get a warning in the payment screen, and it is where the question goes when a payment comes from somewhere else." },
        { name: "Web", what: "The bank's website, used in a browser. The tour's browser, dev_web_9c1e, is not a bound device and has never been seen on this account.", why: "A payment from an unknown browser may come from someone who stole the sign-in details, so the question cannot go back to that browser: it goes to the owner's bound phone." },
        { name: "API", what: "A programming interface: accounting tools send payment orders over HTTPS on the business's behalf.", why: "It uses the same POST /payments with an idempotency key and the device's identity, so the same risk check, hold and alert apply whoever sends the payment." },
      ],
      numbers: [
        { text: 'Faster Payments has a scheme limit of £1 million a payment. Banks set their own lower limits.', from: 'Quoted, not derived: Pay.UK (in Sources) raised the scheme limit from £250,000 to £1 million a payment in 2022, and each bank sets its own lower limit.' },
        { text: 'A card authorisation is answered while the customer waits at the till, so card checks get the tightest budget.', from: 'Not a sum. The page sets one decision target, 150 ms at the 99th percentile (my target), and no separate card figure. The point is only that a card check can never be slower than that.' },
      ],
      fails: 'An attacker with stolen credentials looks exactly like the owner to the server. Treat the session that made the payment as untrusted until a bound device or strong authentication says otherwise.',
      alternatives: [
        { name: 'Ask in the session or out of band, chosen by risk', chosen: true, good: 'A trusted device gets a warning or a challenge in the payment flow. A new device triggers a hold and an alert to the owner\'s bound phone.', cost: 'Two journeys to build and test, and a rule that decides between them.',
          what: 'The risk engine\'s action picks where the question goes. A device already bound to the account gets a warning or a challenge in the payment screen. A new device, like the tour\'s browser, gets a hold and an alert to the owner\'s bound phone.',
          pros: [
            'The owner on their usual phone is not sent a second message about their own payment.',
            'An attacker in a stolen session never sees the question: it goes to a phone they do not hold.',
            'At most 1 alert in 20 is fraud, so keeping honest owners\' journeys short matters.',
          ],
          cons: [
            'Two journeys to build, test and explain to customers.',
            'A rule decides between them, and a wrong call sends the question to the attacker\'s session.',
            'Only as strong as device binding: it trusts whichever phone was bound at set-up.',
          ],
        },
        { name: 'Always challenge in the session', good: 'Simple, instant, and no notification system needed.', cost: 'Useless when the session belongs to the attacker: they answer the challenge themselves.',
          what: 'Every risky payment gets a challenge in the screen that made it: a warning to confirm, or a one-time code. No hold and no notification platform; the answer comes back in the same request.',
          pros: [
            'Simple and instant: the payer answers in seconds.',
            'No alert service, send queues or escalation ladder to build.',
            'Right for a trusted device, where the person at the screen is the owner.',
          ],
          cons: [
            'Useless when the session belongs to the attacker: they answer the challenge themselves.',
            'Does nothing for the case this design is built for: a new browser at 23:40.',
            'A code sent by SMS to answer it is exposed to SIM swaps.',
          ],
        },
        { name: 'Always alert out of band', good: 'The real owner always hears.', cost: 'Every honest payment from the owner\'s own phone triggers a second message to the same phone.',
          what: 'Every flagged payment is held and the owner is asked on their bound phone, whatever device made the payment.',
          pros: [
            'The real owner always hears, even if the session was taken over.',
            'One journey and one rule, simpler to reason about.',
            'Every question leaves the same record in the alert store.',
          ],
          cons: [
            'Every honest payment from the owner\'s own phone triggers a second message to the same phone.',
            'Adds a hold and a wait where a warning in the flow would have settled it.',
            'More alerts to honest owners teaches them to ignore alerts.',
          ],
        },
      ],
      say: 'My first question is who started the payment. A known device gets a warning in the flow. An unknown one gets a hold, and the question goes to a phone the attacker does not hold.',
    },
    {
      id: 'payments',
      name: 'Payment service',
      tech: 'ledger, holds',
      short: 'Payments',
      x: 345, y: 190, w: 150, h: 98, kind: 'shared',
      lines: ['hold, release', 'outbox row'],
      what: 'Owns each payment. It validates the order, reserves the funds, asks the risk engine for a verdict, and then submits the payment to Faster Payments, holds it, or rejects it. In the same database transaction that changes the payment\'s state, it writes an event row to an outbox table.',
      why: 'A Faster Payment cannot be cancelled once sent, so the hold has to happen here, before submission. The outbox avoids a dual write: if the service committed the hold and then published to Kafka as a second step, a crash in between would leave a payment held with nobody told.',
      built: [
        { name: "Ledger", what: "The record of the account's money: balances and the payments that move them. The Payment service validates each order and reserves the funds before deciding what to do.", why: "The service that owns the money owns the decision to send it, so hold, release and reject have one writer and cannot race." },
        { name: "Holds (hold, release)", what: "A state on the payment: kept, not submitted to Faster Payments, waiting for an answer. Release submits it; a hold that expires is rejected, not released.", why: "A Faster Payment cannot be cancelled once sent, so the only place to stop one is here, before submission. The payment delay rules allow a hold until the end of the fourth business day." },
        { name: "Outbox row", what: "A row written to an outbox table in the same database transaction as the payment's state change, naming the event to announce. Change data capture later publishes it to payment-events. This is the transactional outbox pattern.", why: "Committing the hold and then publishing to Kafka as a second step could crash in between and leave a payment held with nobody told. With the outbox, both happen or neither does." },
      ],
      numbers: [
        { text: 'About 46 payments a second on average and 1,000 a second designed peak (see Numbers).', from: '1 million businesses x about 4 payments a business a day = 4 million a day (Numbers table; the million rests on Tide\'s about 750,000 UK members). 4,000,000 / 86,400 seconds = about 46 a second. The 1,000 a second peak is a design choice, about 20 times the average, to cover busy hours and attacks (assumption).' },
        { text: 'Risk call budget (my target): 150 ms at the 99th percentile, inside the payment request.', from: 'A target, not a sum: the brief\'s decision target. Features about 10 ms + model about 20 ms leaves about 120 ms for the network hop, the rules and logging. Stripe Radar decides in under 100 ms (in Sources), so the figure is realistic.' },
      ],
      fails: 'If the risk engine times out, apply a fixed fallback policy by band: small payments to known payees go through, large payments to new payees are held. Never wait past the budget. If the outbox relay stalls, holds still happen but alerts are late, so alarm on the age of the oldest unpublished row.',
      alternatives: [
        { name: 'Decide in line, hold before submission', chosen: true, good: 'Stops the money while it can still be stopped. The alert pipeline only has to report a decision already made.', cost: 'Adds the risk call to every outbound payment, and a fallback policy for when it is slow.',
          what: 'The payment service asks the risk engine before it submits to Faster Payments, then submits, holds or rejects. The hold is a state on the payment, committed with its outbox row, so the alert path only reports a decision already made.',
          pros: [
            'Stops the money while it can still be stopped: a Faster Payment cannot be cancelled once sent.',
            'The alert pipeline does not have to stop money, only reach a person before the hold expires.',
            'One owner of the payment\'s state, so hold, release and reject cannot race.',
          ],
          cons: [
            'Adds the risk call, up to 150 ms at the 99th percentile, to every outbound payment.',
            'Needs a fallback policy for when the engine is slow, and that policy is itself a risk decision.',
            'The risk engine becomes a dependency of every payment, softened only by the fallback.',
          ],
        },
        { name: 'Send first, alert after', good: 'No latency added to the payment. Fine for card spend notifications.', cost: 'For Faster Payments the money has gone. All that is left is recovery and reimbursement.',
          what: 'The payment is submitted at once, and the risk engine reads it from payment-events afterwards. Anything suspicious becomes an alert and, at best, a card freeze. This is the "alerts only" framing on this page.',
          pros: [
            'No latency added to the payment, and the risk engine leaves the payment path.',
            'Fine for card spend notifications, where the customer only needs to know.',
            'Much simpler: no hold, no hold expiry, no fallback policy.',
          ],
          cons: [
            'For Faster Payments the money has gone. All that is left is recovery and reimbursement.',
            'Reimbursement is up to £85,000 a claim, shared with the receiving bank, so the loss lands on the banks.',
            'The owner\'s answer can stop the next payment, not this one.',
          ],
        },
        { name: 'Delay every payment to a new payee', good: 'One rule, nothing to score.', cost: 'Delays every honest customer. The payment delay rules expect reasonable grounds to suspect fraud for each delay, not a blanket rule.',
          what: 'A blanket rule: every payment to a newly added payee waits a set time before submission. No score and no features.',
          pros: [
            'One rule, nothing to score, and easy to explain.',
            'Catches the tour\'s pattern: a large payment to a payee added two minutes earlier.',
            'Needs no model, feature store or back-testing.',
          ],
          cons: [
            'Delays every honest customer paying a new supplier.',
            'The payment delay rules expect reasonable grounds to suspect fraud for each delay, not a blanket rule.',
            'Misses fraud that goes to an existing payee.',
          ],
        },
      ],
      say: 'The hold lives in the payment service, before submission, because Faster Payments are irrevocable. The hold and its event are one transaction, through an outbox.',
      see: [{ id: 'append-log', label: 'Append-only log' }],
    },
    {
      id: 'risk',
      name: 'Risk engine',
      tech: 'rules + model',
      x: 345, y: 50, w: 150, h: 56, kind: 'shared',
      what: 'Scores each outbound payment and card authorisation. It loads the account\'s features, runs a model to get a fraud score, then runs rules that turn the score and the context into one action: allow, warn, hold for confirmation, or block. Every decision is logged with its inputs, so a rule can be replayed against history before it ships.',
      why: 'Rules alone are easy to explain but fraudsters learn them. A model alone is hard to steer on the day a new scam appears. Monzo splits the job into detectors (usually models), action controls that ask for an action, and one selection step that picks the final action, all written as pure functions that can be back-tested. Stripe Radar decides in under 100 ms from more than 1,000 signals.',
      built: [
        { name: "Model", what: "A program trained on past payments with known outcomes. It turns the account's features into one fraud score, 0.93 on the tour.", why: "It catches combinations of signals nobody wrote a rule for. Rules alone have high false positives and fraudsters learn to stay under their thresholds." },
        { name: "Rules", what: "Conditions written by people that turn the score and the context (amount, new payee, new device) into one action: allow, warn, hold or block. Every decision is logged with its inputs and the rule and model versions.", why: "A rule can change on the day a new scam appears, without retraining, and gives a reason to show. Logged inputs let a change be back-tested, and a rate limit on each action stops one bad rule holding every payment in the bank." },
      ],
      numbers: [
        { text: 'Budget: 150 ms at the 99th percentile, of which reading features about 10 ms and the model about 20 ms (my targets).', from: 'Targets, not sums. 150 ms is the brief\'s decision target. 10 ms is one Redis round trip, the timeout on the features call. 20 ms assumes a model scored in the engine\'s own process, with no further hop. 150 - 10 - 20 = about 120 ms left for the network, the rules, logging and slow tails.' },
        { text: 'Fraud is rare: about 1 in 10,000 transactions at Monzo, about 1 in 1,000 payments at Stripe.', from: 'Quoted from the Monzo and Stripe posts (in Sources), not derived. They count different populations, so they need not agree; the Numbers table uses Monzo\'s figure for a bank.' },
        { text: 'Stripe reports wrongly blocking about 0.1 per cent of legitimate payments.', from: 'Quoted from Stripe\'s post on Radar (in Sources), not derived. No sum on this page uses it.' },
      ],
      fails: 'A crash or timeout: the payment service applies its fallback policy. A bad rule: each action carries a rate limit, as in Monzo\'s action applier, which stops applying an action past its limit and alerts an engineer. One broken rule cannot hold every payment in the bank.',
      alternatives: [
        { name: 'Model score plus rules that choose an action', chosen: true, good: 'The model catches patterns, rules give fast control and explanations, and both are logged for back-testing.', cost: 'Two things to govern, and a model to retrain as fraud changes.',
          what: 'A model turns the features into a fraud score. Rules turn the score and the context (amount, new payee, new device) into one action: allow, warn, hold or block. This is Monzo\'s split, with every decision logged with its inputs.',
          pros: [
            'The model catches combinations nobody wrote a rule for.',
            'Rules give fast control on the day a new scam appears, and a reason to show.',
            'Logged inputs let a rule or model be back-tested before it ships.',
            'A rate limit per action stops one bad rule holding every payment.',
          ],
          cons: [
            'Two things to govern: rule changes and model releases.',
            'A model to retrain as fraud changes, with labels that arrive late: claims can come up to 13 months after the payment.',
            'A hold is harder to explain to a customer than one rule firing.',
          ],
        },
        { name: 'Rules only', good: 'Transparent and quick to build. A sound first version.', cost: 'High false positives and easy to learn around.',
          what: 'Hand-written rules on the same features, for example: hold a payment over a set amount to a payee added in the last hour from a new device. No model to train.',
          pros: [
            'Transparent: every hold has a rule to point at.',
            'Quick to build. A sound first version, as in the start-up framing.',
            'Needs no labelled history, which a new bank does not have.',
          ],
          cons: [
            'High false positives: fixed thresholds catch honest owners paying new suppliers.',
            'Easy to learn around: fraudsters find the threshold and stay under it.',
            'Rules pile up and interact, and become hard to reason about.',
          ],
        },
        { name: 'Model only', good: 'Catches patterns nobody wrote down, with one score to tune.', cost: 'Hard to steer on the day a new scam appears, and harder to explain.',
          what: 'The model\'s score alone decides, with a threshold per action: above one number hold, above a higher one block. No rule layer.',
          pros: [
            'Catches combinations of signals nobody wrote down.',
            'One place to change behaviour: retrain or move a threshold.',
            'Less logic to maintain than a growing rule set.',
          ],
          cons: [
            'Hard to steer on the day a new scam appears: retraining takes longer than writing a rule.',
            'Harder to explain why a payment was held.',
            'Context outside the model, such as a customer flagged as vulnerable, has nowhere to go.',
          ],
        },
        { name: 'A bought-in scoring service', good: 'Fast to start, and data pooled across many banks.', cost: 'A network hop outside your control on every payment, a cost per call, and less say in the model.',
          what: 'The risk engine sends each payment to a vendor that returns a score or an action. The vendor trains on data pooled across its clients.',
          pros: [
            'Fast to start, without a data science team.',
            'Data pooled across many banks can show a scam this bank has not met yet.',
            'The vendor runs and scales the scoring.',
          ],
          cons: [
            'A network hop outside your control on every payment, inside the 150 ms budget.',
            'A cost per call, on 4 million payments a day.',
            'Less say in the model, and harder to back-test your own changes against it.',
          ],
        },
      ],
      say: 'The engine returns an action, not a score. Hold is the interesting one: it buys time to ask the owner, and that is what the notification system is for.',
    },
    {
      id: 'features',
      name: 'Feature store',
      tech: 'Redis counters',
      short: 'Features',
      x: 80, y: 50, w: 140, h: 70, kind: 'store',
      what: 'Holds what the engine needs about an account, ready to read in one round trip: payments and amounts in the last hour and day, new payees added recently, whether this payee is new, usual hours, devices and countries seen. Short-window counters are updated in the same call that reads them. Longer aggregates come from stream and batch jobs.',
      why: 'Velocity is the strongest sign of a taken-over account: several new payees and a large amount within minutes. It must include the payment being scored, so it cannot wait for a job that runs every few seconds. Monzo groups features as just-in-time, near-real-time (computed ahead and cached) and batch.',
      built: [
        { name: "Redis", what: "A widely used in-memory key-value database: data lives in memory, so reads and writes are fast, and it can run a short script as one atomic step. Each account's features are one Redis hash, a set of named fields under one key.", why: "Velocity features must include the payment being scored and come back in about 10 ms of the 150 ms budget. At about 1 GB for a million businesses it fits in memory, and one read per payment is far lighter than aggregate queries on the payment database at 1,000 payments a second." },
        { name: "Counters", what: "Running counts and sums per account over short windows: payments in the last hour, amount sent today, new payees, payments after 23:00 this year.", why: "They are incremented in the same script that reads them, so two payments at the same moment both count. A stream processor such as Flink would compute exact windows but seconds late, so it computes only the longer windows." },
      ],
      numbers: [
        { text: 'Assume about 1 KB a business for a million businesses: about 1 GB, which fits in memory with room for payee pairs.', from: '1 million businesses (Numbers table) x about 1 KB a business (assumption: a few dozen counters, timestamps and small sets of devices and countries) = about 1 GB. One server\'s memory holds many times that, so business and payee pairs fit alongside.' },
        { text: 'All features for an account in one hash: one read, not twenty.', from: 'Not a sum. "Twenty" stands for one read per feature if each lived under its own key. One hash is one round trip, which is what keeps features inside about 10 ms.' },
      ],
      fails: 'If the counters are lost, every account looks quiet, which is exactly what a fraudster wants. Rebuild them by replaying the last day of payment events, and until then treat missing features as risky for large payments to new payees. Reads have a timeout: return what has resolved and mark the rest missing.',
      alternatives: [
        { name: 'Counters in Redis, updated in line', chosen: true, good: 'Fresh to the payment being scored, and one read per decision.', cost: 'A dependency on the hot path, and counters to rebuild after a loss.',
          what: 'Each account\'s features sit in one Redis hash. The risk engine runs one short script that reads the hash and increments the short-window counters for this payment, atomically, with a timeout of about 10 ms.',
          pros: [
            'Fresh: the count includes the payment being scored.',
            'One read per decision, about 10 ms of the 150 ms budget.',
            'Two payments at the same moment both count, because read and increment are one step.',
            'About 1 GB for a million businesses, which fits in memory.',
          ],
          cons: [
            'A dependency on the hot path: if it is slow, decisions run with features marked missing.',
            'Counters to rebuild after a loss, by replaying a day of payment events.',
            'Counters are coarser than a stream processor\'s exact sliding windows.',
          ],
        },
        { name: 'A stream processor (Flink) computing windows from the log', good: 'Exact sliding windows and joins across streams. Right for longer windows.', cost: 'Seconds of lag: a fraudster\'s second payment can be scored before the first is counted.',
          what: 'A stream processor reads payment-events, keeps windowed sums per account in its own state, and writes results where the engine can read them. In this design it computes the longer windows.',
          pros: [
            'Exact sliding windows, and joins across streams such as sign-ins and payments.',
            'Right for longer windows (a day, a week), where seconds of lag do not matter.',
            'State is checkpointed and rebuilt from the log, not by hand.',
          ],
          cons: [
            'Seconds of lag: a fraudster\'s second payment can be scored before the first is counted.',
            'The payment reaches the log after the decision, so it can never count itself.',
            'Another platform to run, with its own checkpoints and upgrades.',
          ],
        },
        { name: 'Aggregate queries on the ledger', good: 'No new store.', cost: 'Heavy queries on the system of record, inside a 150 ms budget.',
          what: 'At decision time the risk engine queries the payment database: payments in the last hour, new payees today, amount sent in 24 hours.',
          pros: [
            'No new store, and nothing to keep in step.',
            'Exact, straight from the system of record.',
            'Workable at small scale, such as the 10,000-business start-up framing.',
          ],
          cons: [
            'Heavy queries on the system of record, inside a 150 ms budget.',
            'At the 1,000 payments a second designed peak, several aggregate reads for each payment.',
            'Two payments at the same moment may each miss the other until both commit.',
          ],
        },
      ],
      say: 'Velocity features must count the payment in front of me, so short windows are updated in line. Longer windows can come from a stream job.',
      see: [{ id: 'hash-table', label: 'Hash table' }, { id: 'stream-checkpoints', label: 'Stream checkpoints' }],
    },
    {
      id: 'txlog',
      name: 'payment-events',
      tech: 'Kafka, by account',
      x: 345, y: 340, w: 180, h: 64, kind: 'queue',
      what: 'The log of every payment state change: created, held, released, blocked, sent, card frozen. Messages are keyed by account id, so every event for one business lands on one partition, in order.',
      why: 'Many readers need these events (alerts, statements, analytics, fraud labels), and none of them may slow a payment. Ordering per account means the alert service never sees "released" before "held". The log keeps a week of history, so a consumer that was down catches up, and a lost cache can be rebuilt.',
      built: [
        { name: "Kafka", what: "Apache Kafka, a distributed message log. Messages are appended to a topic split into partitions; each partition keeps its order, and each reader (a consumer group) reads at its own pace and can re-read history while it is kept.", why: "Alerts, statements, analytics and fraud labels all read these events and none may slow a payment. A week of history lets a reader that was down catch up and a lost cache be rebuilt, which a managed queue that gives each message to one reader, such as SQS, cannot." },
        { name: "Keyed by account", what: "Each message's key is the account id, and the key picks the partition, so all of one business's events land on one partition, in order.", why: "The Alert service must never read \"released\" before \"held\". At about 3,000 events a second at peak, a few dozen partitions are plenty: they exist for parallel readers, not throughput." },
      ],
      numbers: [
        { text: 'Assume 4 million payments a day at about three events each: about 12 million events, 1,000 payments a second designed peak. A few dozen partitions are plenty; they exist for parallel consumers, not for throughput.', from: '4 million payments a day (Numbers table) x about 3 state changes each (assumption: created, then held or sent, then a final state) = about 12 million events a day, about 140 a second on average. At the 1,000 payments a second designed peak, about 3,000 events a second. Small messages at that rate do not need many partitions, so their number is set by how many consumers should read in parallel (reasoning, not measured).' },
        { text: 'Consumer lag on the alerts group is alert latency: alarm at 2 seconds.', from: 'The latency budget (Numbers table) allows under 1 second for the log and the consumer, and under 2 seconds from event to push. Lag of 2 seconds alone has used the whole event-to-push budget, so that is where to alarm (a choice).' },
      ],
      fails: 'If the brokers are down, rows wait in the outbox and are published later. Payments are still held, but nobody is told, so this is a P1 page and the payment service caps how many holds it will place without a published event. A slow consumer only delays its own work.',
      alternatives: [
        { name: 'Outbox to Kafka, keyed by account', chosen: true, good: 'No dual write, order per account, replay, and any number of readers.', cost: 'Brokers to run, and a relay or change data capture to operate.',
          what: 'The held state and an outbox row commit in one transaction, and change data capture publishes the row to payment-events, keyed by account id. Each reader, the alert service among them, has its own consumer group.',
          pros: [
            'No dual write: no moment when the payment is held and no event exists.',
            'Order per account, so "released" never arrives before "held".',
            'A week of history to replay after a consumer outage or a lost cache.',
            'Any number of readers (alerts, statements, analytics, fraud labels) without slowing payments.',
          ],
          cons: [
            'Brokers to run, and a relay or change data capture to operate.',
            'At-least-once: readers must ignore repeats by the event\'s id.',
            'If the brokers are down, payments are held and nobody is told, so it needs a P1 page and a cap on holds.',
          ],
        },
        { name: 'The risk engine calls the alert service directly', good: 'One hop fewer, a little faster.', cost: 'A dual write again, and a slow alert service now slows payments.',
          what: 'When it returns "hold", the risk engine also calls the alert service with the payment and the reason. No log in between.',
          pros: [
            'One hop fewer, a little faster.',
            'Nothing to run between the two services.',
            'Easy to trace: one call, one alert.',
          ],
          cons: [
            'A dual write again: the alert can go out for a hold that never committed, or the other way round.',
            'A slow alert service now slows payments.',
            'No replay, and no order per account when two calls race.',
          ],
        },
        { name: 'A managed queue (SQS FIFO with the account as the group)', good: 'No brokers, order per group, a dead-letter queue built in.', cost: 'One reader per message and no replay of history, so every new consumer needs its own copy.',
          what: 'The relay sends each outbox row to a managed FIFO queue with the account id as the message group, so one business\'s events stay in order. The alert service reads it.',
          pros: [
            'No brokers to run.',
            'Order per group, which gives order per account.',
            'A dead-letter queue built in.',
          ],
          cons: [
            'One reader per message: statements, analytics and fraud labels each need their own copy.',
            'No replay of history, so a lost cache cannot be rebuilt from it.',
            'Still needs the outbox and a relay: it removes the brokers, not that work.',
          ],
        },
      ],
      say: 'The alert is a reader of the payment\'s state change, not a side effect of the risk call. That gives me replay, order per account and no dual write.',
      see: [{ id: 'append-log', label: 'Append-only log' }, { id: 'partitioning', label: 'Partitioning' }],
    },
    {
      id: 'alerts',
      name: 'Alert service',
      tech: 'dedup, timers',
      x: 655, y: 340, w: 144, h: 80, kind: 'node',
      what: 'Turns a "payment held" event into an alert. It derives the alert id, sets the severity, asks Preferences who to tell, writes the alert, puts one send job per person and channel on the P0 queue, and sets the time of the next step. It owns the alert\'s states: open, sent, delivered, answered, expired, and the escalation ladder between them.',
      why: 'The alert id is a hash of the payment id and the reason, so a redelivered event finds the alert already there and sends nothing new. One owner for the state means one place decides when to escalate and when to stop. Partitioned by account like the log, one consumer handles one business\'s alerts in order.',
      built: [
        { name: "Dedup (a derived alert id)", what: "Deduplication: recognising a repeat and doing nothing. The alert id is a hash of the payment id and the reason, so a redelivered event finds the alert already written.", why: "Kafka delivers at least once, so repeats will happen. A random id would make a second alert and a second round of messages; a derived id makes the repeat harmless." },
        { name: "Timers", what: "The time of each alert's next step, stored as next_step_at on its row in the Alert store and checked every second. A sweeper every minute catches steps a deploy or a bug missed.", why: "A timer in memory dies with a restart; a row survives. A workflow engine such as Temporal or AWS Step Functions would give durable timers too, but adds another platform and some latency per step on the P0 path." },
      ],
      numbers: [
        { text: 'Assume about 8,000 alerts a day, about 1 a second at peak, and bursts of 100 a second during an attack on many accounts.', from: '4 million payments a day x about 0.2 per cent held or flagged (Numbers table) = 8,000 a day, about 0.1 a second on average. 1 a second at peak is about 10 times the average (assumption). 100 a second is an assumed burst: the attack drill, 10,000 accounts in five minutes, averages 10,000 / 300 = about 33 a second, and attacks arrive unevenly.' },
        { text: 'Target: event to send job in under 500 ms at the 99th percentile.', from: 'A target. The latency budget allows under 1 second for the log and the consumer; 500 ms for the alert service\'s own work (Preferences within 50 ms, a write, an enqueue) leaves the rest for consumer lag.' },
        { text: 'My default ladder: push at once, SMS at 90 seconds, a voice call at 5 minutes, the second contact at 10 minutes, fraud operations at 30.', from: 'Choices, not sums. Push first because it is the fastest and costs nothing per message. 90 seconds gives a person time to see a lock-screen alert before a paid SMS. The whole ladder ends within 30 minutes, far inside a hold that may last until the end of the fourth business day.' },
      ],
      fails: 'A crash after writing the alert but before enqueueing: the event\'s offset was not committed, so it is read again, the alert is found, and any send not marked done is enqueued again. Timers are a next-action time on the alert row, polled every second, so they survive restarts.',
      alternatives: [
        { name: 'An alert service with its own state and timers', chosen: true, good: 'Fast, and the whole ladder is in one place you can reason about.', cost: 'Durable timers and retries are yours to build.',
          what: 'The alert service derives the alert id, writes the alert and its plan, enqueues the sends and stores the time of the next step on the alert row. A poll every second finds steps that are due and moves the ladder on.',
          pros: [
            'Fast: event to send job in under 500 ms.',
            'The whole ladder is in one place you can reason about and test.',
            'Timers are rows, so they survive restarts and deploys.',
            'Partitioned by account like the log, so one business\'s alerts are handled in order.',
          ],
          cons: [
            'Durable timers and retries are yours to build.',
            'A poll every second is a steady load on the store, and a step can fire up to a second late.',
            'Needs the sweeper as a safety net for steps a deploy or a bug missed.',
          ],
        },
        { name: 'A workflow engine (Temporal, AWS Step Functions)', good: 'Durable timers, retries and a history of every step, for free.', cost: 'Another platform on the P0 path, and some latency per step.',
          what: 'Each alert becomes a workflow run: send push, wait 90 seconds for an answer, send SMS, wait, call. The engine stores each step and its timers, and resumes after a crash.',
          pros: [
            'Durable timers, retries and a history of every step, for free.',
            'The ladder reads as ordinary code, easy to change.',
            'The engine\'s own timers do the sweeper\'s job.',
          ],
          cons: [
            'Another platform on the P0 path, with its own failure modes.',
            'Some latency per step.',
            'Its history is a second record beside the alert store, which an audit must reconcile.',
          ],
        },
        { name: 'Send everywhere at once, no state', good: 'The quickest first contact, and very little to build.', cost: 'Spams people, cannot stop when someone answers, and cannot escalate.',
          what: 'On a held event, send push, SMS and a call to everyone on the plan in one go, and keep nothing beyond the sends.',
          pros: [
            'The quickest first contact on every channel.',
            'Very little to build: no timers, no ladder, no state.',
            'A lost push does not matter, because the SMS went too.',
          ],
          cons: [
            'Spams people: a call at 23:40 for every hold, when most alerts go to honest owners.',
            'Cannot stop when someone answers, and cannot escalate to a second person.',
            'Pays for SMS and calls on all 8,000 alerts a day, not only the unanswered ones.',
          ],
        },
      ],
      say: 'Every alert gets an id derived from what caused it. Delivery is at-least-once everywhere, so that id is what stops the owner getting five copies.',
      see: [{ id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'prefs',
      name: 'Preferences',
      tech: 'people, channels',
      x: 655, y: 180, w: 150, h: 56, kind: 'node',
      what: 'Answers "who hears about this, on which channels, in what order, in which language". It holds each business\'s people and roles (owner, director, bookkeeper), each person\'s channels and bound devices, thresholds (the bookkeeper gets email only above £1,000), quiet hours, language and which accounts they follow. Then it applies the rules for the alert\'s category.',
      why: 'Preferences belong to people, but the duty to warn belongs to the bank. Categories with different rules keep both: a security alert ignores marketing opt-outs and quiet hours and always includes the mandatory channels, while marketing honours every opt-out. Only people with authority over the account get buttons; the bookkeeper gets a copy to read.',
      built: [
        { name: "People", what: "Each business's people and their roles (owner, director, bookkeeper), and which accounts each follows.", why: "Only people with authority over the account get buttons; the bookkeeper gets a copy to read. The second contact on the ladder, the director, comes from here." },
        { name: "Channels", what: "Each person's ways of being reached (push to bound devices, SMS, voice, email, in-app) in their order, with thresholds, quiet hours and language. Read through a cache, in under 10 ms.", why: "One service applies the category rules for every team, so a security alert overrides quiet hours everywhere and marketing honours every opt-out. Preferences choose the channel and order, not whether a security alert is sent." },
      ],
      numbers: [
        { text: 'Assume about 1.4 million people and 2 million devices, a few KB each: a few GB in all, which fits in a cache.', from: '1 million businesses x about 1.4 people each = 1.4 million people, each with about 1.4 devices = about 2 million devices (Numbers table assumptions). That is about 3.4 million records; at 1 to 3 KB each (assumption) it is about 3.4 to 10 GB. Either end fits in a cache.' },
        { text: 'Target: one read per alert, under 10 ms.', from: 'A target. At about 1 alert a second at peak and 100 in a burst the load is trivial, and 10 ms sits well inside the call\'s 50 ms timeout and the alert service\'s 500 ms.' },
      ],
      fails: 'If Preferences is down, fail open for security alerts: use the last cached plan or, if there is none, the mandatory default (the owner\'s bound devices by push, then the owner\'s verified mobile by SMS). Never drop a fraud alert because a settings service is down. For marketing, fail closed and send nothing.',
      alternatives: [
        { name: 'A preference service with a read-through cache', chosen: true, good: 'One place for every team\'s rules, and fast.', cost: 'A network call on the alert path, with a fallback to keep.',
          what: 'One service owns people, channels, devices, thresholds and quiet hours, and turns them into a plan per alert with the category\'s rules applied. A read-through cache keeps a read under 10 ms.',
          pros: [
            'One place for every team\'s rules, so quiet hours and opt-outs are right everywhere.',
            'Fast: one read under 10 ms.',
            'Category rules (security overrides quiet hours) are enforced in one place.',
            'The plan is stored with the alert, so the audit shows the rules as they were.',
          ],
          cons: [
            'A network call on the alert path, with a 50 ms timeout and a fallback to keep.',
            'A cache to invalidate when someone changes a setting.',
            'A shared service many teams depend on, so changes need care.',
          ],
        },
        { name: 'A local copy in the alert service, fed by change data capture', good: 'No network call, and it survives the service being down.', cost: 'Can be seconds stale, and every instance holds the whole set.',
          what: 'The alert service keeps its own copy of every preference, fed by change data capture from the preference database, and reads it in process.',
          pros: [
            'No network call on the alert path.',
            'Survives the preference service being down.',
            'A few GB fits in memory on each instance.',
          ],
          cons: [
            'Can be seconds stale: someone removed a minute ago may still get the alert.',
            'Every instance holds the whole set, and a new instance must load it before it starts.',
            'The category rules still live somewhere; copying them too means two places to change.',
          ],
        },
        { name: 'Each sending team keeps its own', good: 'Nothing shared to build.', cost: 'Every team rebuilds quiet hours and opt-outs, and gets them wrong in different ways.',
          what: 'Payments, cards and marketing each store their own contact settings and apply their own quiet hours and opt-outs.',
          pros: [
            'Nothing shared to build or run.',
            'Each team moves at its own pace.',
            'One team\'s settings store failing affects only that team.',
          ],
          cons: [
            'Every team rebuilds quiet hours and opt-outs, and gets them wrong in different ways.',
            'An owner changes their number in one place and not the others.',
            'No single view of what a person agreed to when a complaint asks.',
          ],
        },
      ],
      say: 'Preferences choose the channel and the order, not whether a security alert is sent. An owner can put SMS before push, but cannot switch fraud alerts off.',
      see: [{ id: 'lru-cache', label: 'LRU cache' }],
    },
    {
      id: 'store',
      name: 'Alert store',
      tech: 'inbox, audit',
      x: 655, y: 475, w: 140, h: 70, kind: 'store',
      what: 'The durable record of every alert: what caused it, who it went to, each delivery attempt and receipt, the answer, who gave it and from which device. The app\'s inbox reads from it, so an alert missed on the lock screen is waiting when the app opens. When the app is open, it gets the alert at once over its WebSocket.',
      why: 'Push is best effort and SMS can be lost, so the inbox is the one copy certain to be there. The same rows are the audit trail. Under the reimbursement rules, a bank that refuses a claim for gross negligence must prove it, often by showing the customer ignored a specific warning. So it must be able to show exactly what it said and when.',
      built: [
        { name: "PostgreSQL", what: "A widely used open-source relational database: tables, SQL queries and transactions. Here one table of alerts and one of alert events, both partitioned by month.", why: "The alert and its next-step time are written in one transaction, and the inbox, complaints and audits are plain SQL. About 7.5 GB a day for every notification is manageable in one database if old months are archived, so a wide-column store such as Cassandra is not needed." },
        { name: "Inbox", what: "The list of alerts the app shows, read from this store. An open app also gets each new alert at once over its WebSocket, a connection it keeps open to the bank.", why: "Push is best effort and SMS can be lost, so the inbox is the one copy certain to be there. Push and SMS only get someone to look at it." },
        { name: "Audit", what: "Append-only rows of what was decided, sent, delivered and answered, with times and devices.", why: "A bank that refuses a reimbursement claim for gross negligence must prove it, often by showing the customer ignored a specific warning. So it must show exactly what it said and when." },
      ],
      numbers: [
        { text: 'Fraud alerts: 8,000 a day at about 2 KB, which is tiny.', from: '8,000 alerts a day (Numbers table) x about 2 KB (assumption: the alert, its plan, and a few attempt and answer rows) = about 16 MB a day, about 6 GB a year.' },
        { text: 'Assume every notification of every kind: about 5 million a day at 1 KB with 1.5 attempts each, about 7.5 GB a day or 2.7 TB a year.', from: 'About 4 million payment notifications + about 1 million campaign messages = about 5 million a day (Numbers table). 5 million x 1 KB x 1.5 attempts = 7.5 GB a day; x 365 = about 2.7 TB a year. 1 KB a notification and 1.5 attempts are assumptions in the Numbers table.' },
      ],
      fails: 'If it is down, the alert service still enqueues P0 sends (getting the owner\'s attention is more urgent than the record), and writes the record when the store returns, by reading the log again. Events are keyed by alert id and step, so a replay writes nothing twice.',
      alternatives: [
        { name: 'PostgreSQL, partitioned by month', chosen: true, good: 'Transactions alongside the alert state, and simple queries for the inbox, for complaints and for audits.', cost: 'Old partitions to archive.',
          what: 'One table of alerts keyed by alert id and one of events keyed by alert id and step, both partitioned by month. The inbox, complaints and audits are plain SQL queries.',
          pros: [
            'Transactions alongside the alert state: the alert and its next-step time are written together.',
            'Simple queries for the inbox, for complaints and for audits.',
            'Old months detach as whole partitions, cheap to archive.',
            '7.5 GB a day for every notification is manageable in one database if old months are archived.',
          ],
          cons: [
            'Old partitions to archive, and a retention period to decide.',
            'One primary to fail over, and the every-second timer poll runs against it.',
            'Scaling writes past one primary means sharding by account later.',
          ],
        },
        { name: 'A wide-column store (Cassandra, DynamoDB)', good: 'Scales writes for every notification the bank sends.', cost: 'Audit queries across alerts are harder to write.',
          what: 'Alerts stored by account and time, with each alert\'s events appended under it.',
          pros: [
            'Scales writes for every notification the bank sends.',
            'One account\'s inbox is one partition read.',
            'Replication across machines built in.',
          ],
          cons: [
            'Audit queries across alerts are harder to write.',
            'No transaction across the alert and its timer; conditional writes have to do the job.',
            'The volume here, 7.5 GB a day, does not need it.',
          ],
        },
        { name: 'Logs only', good: 'Cheap.', cost: 'No reliable inbox, and an audit trail you have to reconstruct under pressure.',
          what: 'No alert table: every send, receipt and answer is a log line, and the inbox and audit are built from log search.',
          pros: [
            'Cheap.',
            'Nothing new to run: logging already exists.',
            'Good enough for debugging a single send.',
          ],
          cons: [
            'No reliable inbox: a logging pipeline may drop or delay lines under load.',
            'An audit trail you have to reconstruct under pressure, when a reimbursement claim turns on what was said.',
            'No place for the next-step time, so no durable timers.',
          ],
        },
      ],
      say: 'The inbox is the durable copy. Push and SMS are ways of getting someone to look at it.',
      see: [{ id: 'b-plus-tree', label: 'B+ tree' }, { id: 'realtime-push', label: 'Real-time push' }],
    },
    {
      id: 'queue',
      name: 'Send queues',
      tech: 'Kafka, P0 to P3',
      x: 900, y: 340, w: 150, h: 64, kind: 'queue',
      what: 'A separate topic for each priority: P0 security (fraud holds, a new device signing in, one-time passcodes), P1 transactional (money in, money out), P2 product, P3 marketing. Each topic has its own consumer group and its own workers, so a marketing campaign can never stand in front of a fraud alert.',
      why: 'A queue serves in arrival order. Hello Interview\'s campaign example is a million messages in five minutes, over 3,000 a second; a fraud alert behind that waits minutes. Netflix\'s RENO splits events into priority queues, each with its own compute cluster, for the same reason.',
      built: [
        { name: "Kafka", what: "The same kind of message log as payment-events: here four topics, sends.p0 to sends.p3, each with its own consumer groups. A job that fails every try goes to a dead-letter topic.", why: "It absorbs bursts (100 alerts a second become work the workers drain), keeps one alert's jobs in order by keying them on the alert id, and lets failed jobs be replayed after a fix." },
        { name: "P0 to P3", what: "Four priorities: P0 security (fraud holds, new-device sign-ins, one-time passcodes), P1 transactional, P2 product, P3 marketing.", why: "A partition is read in order whatever a field says, so a fraud alert behind a million-message campaign at over 3,000 a second would wait minutes. Separate topics, workers and provider quotas keep P3 from ever standing in front of P0." },
      ],
      numbers: [
        { text: 'P0 fraud alerts: about 25,000 sends a day (my estimate). P0 is sized for 500 a second.', from: '8,000 alerts a day x about 1.5 people x 2 channel steps = 24,000, call it 25,000 (Numbers table). For 500 a second: a burst of 100 alerts a second x 1.5 people = 150 first sends a second, about 300 with a second step; 500 leaves headroom, and P0 also carries passcodes and new-device alerts (a choice).' },
        { text: 'P3: campaigns of a million messages in minutes.', from: 'Hello Interview\'s example (in Sources): 1 million messages in five minutes = 1,000,000 / 300 seconds = about 3,300 a second, the "over 3,000 a second" on this page.' },
      ],
      fails: 'P0 lag pages someone at once; P3 lag is a dashboard. A job that fails every try goes to a dead-letter topic and is replayed after a fix, and a P0 job in the dead-letter topic also opens a case, because a person did not hear about a held payment.',
      alternatives: [
        { name: 'A topic per priority, with its own workers', chosen: true, good: 'Isolation you can see and size, including separate quotas with each provider.', cost: 'More topics and consumer groups to run.',
          what: 'Four topics, P0 to P3, each with its own consumer group, workers and provider quota. A fraud alert goes on P0 and never shares a partition with a campaign.',
          pros: [
            'Isolation you can see and size: P0 for 500 sends a second, P3 for over 3,000.',
            'Separate quotas with each provider, so a campaign cannot use up P0\'s.',
            'Lag alarms per priority: P0 pages, P3 is a dashboard.',
          ],
          cons: [
            'More topics and consumer groups to run.',
            'P0 workers sit mostly idle at about 25,000 sends a day: the price of headroom.',
            'Moving a message type to another priority is a deploy, not a field change.',
          ],
        },
        { name: 'One topic with a priority field', good: 'Simple.', cost: 'A partition is read in order, so a high-priority message still waits behind everything before it.',
          what: 'All notifications on one topic with a priority field. Workers read in order and handle a P0 message first when they reach it.',
          pros: [
            'Simple: one topic, one consumer group.',
            'Easy to add a priority level.',
            'Fewer idle workers.',
          ],
          cons: [
            'A partition is read in order, so a high-priority message still waits behind everything before it.',
            'Behind a million-message campaign at over 3,000 a second, a fraud alert waits minutes.',
            'Provider quotas are shared, so P3 can use them up.',
          ],
        },
        { name: 'Managed queues per priority (SQS)', good: 'No brokers, retries and dead-letter queues built in.', cost: 'Fine for sends. You lose replay, which matters less here than on the payment log.',
          what: 'One managed queue per priority, with workers reading P0 first. A job not finished reappears after a visibility timeout, and moves to a dead-letter queue after its last try.',
          pros: [
            'No brokers to run.',
            'Retries and dead-letter queues built in.',
            'Fine for sends: one slow job does not hold up the jobs behind it.',
          ],
          cons: [
            'You lose replay, which matters less here than on the payment log.',
            'payment-events and the status topic stay on Kafka, so two messaging systems to run.',
          ],
        },
      ],
      say: 'Priority is physical: separate topics, separate workers, separate provider quotas. I do not trust a priority field in a shared queue.',
      see: [{ id: 'priority-queue', label: 'Priority queue' }, { id: 'queue', label: 'Message queue' }],
    },
    {
      id: 'workers',
      name: 'Channel workers',
      tech: 'push, SMS, voice',
      x: 900, y: 180, w: 166, h: 98, kind: 'node',
      lines: ['retry, breaker', 'dedup key'],
      what: 'One pool per channel and provider: push, SMS, voice, email, in-app. A worker takes a send job, checks and sets its dedup key, renders the template in the person\'s language, calls the provider with a timeout, records the result, and retries with backoff and jitter on errors worth retrying. A circuit breaker per provider moves traffic to the second provider or to the next step on the ladder.',
      why: 'Providers fail on their own and have their own limits, so each gets its own pool: an SMS outage cannot slow push. The dedup key (alert id, person, channel, step) is set with an atomic set-if-absent before the call, so a job delivered twice sends once.',
      built: [
        { name: "Push, SMS and voice pools", what: "A pool of worker processes per channel and provider. A worker takes a send job, renders the template in the person's language, calls the provider with a timeout and records the result.", why: "Providers fail on their own and have their own limits, so an SMS outage cannot slow push, and each pool scales to its own provider's quota." },
        { name: "Retry with backoff", what: "Trying again after an error worth retrying, waiting longer each time with a random part (jitter) added. P0: 3 tries at about 1, 2 and 4 seconds.", why: "About 7 seconds of retrying ends far inside the 90 seconds before the SMS step, and jitter stops a provider coming back from an outage being hit all at once." },
        { name: "Circuit breaker", what: "A switch per provider that opens after a run of failures, so workers fail fast instead of calling, and closes when test requests succeed.", why: "An open breaker moves traffic to the second provider or the next ladder step at once, instead of every job retrying against a provider that is down." },
        { name: "Dedup key", what: "Alert id, person, channel and step, such as A-91:per_1101:push:1, set with an atomic set-if-absent before the provider call and kept until the hold ends.", why: "Exactly-once delivery does not exist across Apple, Google and phone networks, so a job delivered twice is sent once. It cannot stop a second call inside one job whose reply was lost; that rare duplicate is the price." },
      ],
      numbers: [
        { text: 'Target: P0 push handed to APNs or FCM within 1 second at the 99th percentile.', from: 'A target from the latency budget (Numbers table): log and consumer under 1 second + push handed over under 1 second = event to push under 2 seconds.' },
        { text: 'P0 retries (my choice): 3 tries at about 1, 2 and 4 seconds with jitter. P3 can wait minutes.', from: 'A choice. Waits that double, 1 + 2 + 4 = about 7 seconds of retrying, end far inside the 90 seconds before the SMS step. Jitter spreads retries so a provider coming back from an outage is not hit all at once.' },
      ],
      fails: 'A send that worked but whose reply was lost gets retried. The dedup key stops a second job, but not a second call inside one job, so a rare duplicate is the price. Push uses a collapse id, so a duplicate replaces the first on screen instead of stacking.',
      alternatives: [
        { name: 'A pool per channel and provider, with breakers', chosen: true, good: 'Failures stay inside one provider, and each pool scales to its own limits.', cost: 'More deployments to run and watch.',
          what: 'A worker pool per channel and provider: push, SMS on each of two providers, voice, email, in-app. Each sets its dedup key, renders the template, calls with a timeout, retries with backoff and has its own breaker.',
          pros: [
            'Failures stay inside one provider: an SMS outage cannot slow push.',
            'Each pool scales to its own provider\'s limits and quotas.',
            'An open breaker moves traffic to the second provider or the next ladder step.',
          ],
          cons: [
            'More deployments to run and watch.',
            'Most pools sit idle most of the time at P0 volumes.',
            'A send that worked but whose reply was lost can repeat: the dedup key stops a second job, not a second call.',
          ],
        },
        { name: 'A bought-in notification service', good: 'Templates, preferences and dashboards on day one.', cost: 'Another hop and another company on the path of a regulated security alert.',
          what: 'A hosted platform takes one request per message and handles templates, preferences, channel choice and the calls to Apple, Google and SMS providers.',
          pros: [
            'Templates, preferences and dashboards on day one.',
            'Provider integrations already built.',
            'The start-up framing uses one, and P3 marketing could here.',
          ],
          cons: [
            'Another hop and another company on the path of a regulated security alert.',
            'Its retries and duplicates are not yours to control, so one send per person, channel and step is harder to promise.',
            'Its outage stops every channel at once unless you keep a direct path too.',
          ],
        },
        { name: 'One worker for every channel', good: 'Least code.', cost: 'One slow provider holds up all the others.',
          what: 'One pool reads every send job and calls whichever provider the job names.',
          pros: [
            'Least code and one deployment.',
            'Everything visible in one place.',
            'Enough while volumes are tiny and providers healthy.',
          ],
          cons: [
            'One slow provider holds up all the others: SMS timeouts delay push.',
            'Cannot size or rate-limit per provider.',
            'One bad deploy stops every channel at once.',
          ],
        },
      ],
      say: 'Delivery is at-least-once with a dedup key per person, channel and step. Exactly-once does not exist across a phone network, so I make the second copy harmless.',
      see: [{ id: 'token-bucket', label: 'Token bucket' }],
    },
    {
      id: 'push',
      name: 'APNs, FCM',
      tech: 'push gateways',
      x: 1185, y: 180, w: 150, h: 56, kind: 'outside',
      what: 'Apple\'s and Google\'s push services. The worker posts each notification over HTTP/2 to APNs for iPhones, or to FCM for Android, and they deliver it to the device when they can.',
      why: 'The only way to wake a locked phone. APNs priority 10 sends at once, while 5 sends based on the device\'s power state. FCM high priority can wake a device in Doze. On iOS the Time Sensitive level breaks through Focus and scheduled summaries, and Apple\'s own example of when to use it is an account security issue.',
      built: [
        { name: "APNs", what: "Apple Push Notification service: Apple's service for delivering notifications to iPhones. The worker posts each one over HTTP/2 to a device token, and Apple delivers it when it can.", why: "The only way to wake a locked iPhone. Called directly, not through FCM, so every Apple option (priority 10, Time Sensitive, collapse id, expiry) is set with nothing in between and errors such as a 410 arrive first-hand." },
        { name: "FCM", what: "Firebase Cloud Messaging: Google's service for delivering notifications to Android phones. It can also pass messages on to APNs for iPhones.", why: "The only way to wake a locked Android phone: high priority can wake a device in Doze, Android's power-saving sleep. Used for Android only here, so iPhone pushes do not take an extra hop." },
      ],
      numbers: [
        { text: 'APNs payload up to 4 KB, collapse id up to 64 bytes.', from: 'Quoted from Apple\'s documentation (in Sources), not derived. The lock-screen text on this page is well under 4 KB.' },
        { text: 'For an offline device APNs stores only one notification per app, usually the latest. An expiry of 0 means try once and do not store.', from: 'Quoted from Apple\'s documentation (in Sources), not derived. It is why the inbox, not the push, is the copy certain to be there.' },
      ],
      fails: 'Both are best effort. APNs may reorder, throttle or drop, and FCM may lower to normal priority the high-priority messages of an app that shows nothing for them. So a 200 means accepted, not seen, and the escalation timer never trusts it. A 410 from APNs means the token is dead: delete it and go to the next step now.',
      alternatives: [
        { name: 'APNs and FCM called directly', chosen: true, good: 'Every Apple and Google option (priority, interruption level, collapse id, expiry) with nothing in between.', cost: 'Two APIs, two sets of credentials, two kinds of error.',
          what: 'The push workers keep HTTP/2 connections to APNs for iPhones and send to FCM for Android, setting each platform\'s own options on every message.',
          pros: [
            'Every Apple and Google option (priority, interruption level, collapse id, expiry) with nothing in between.',
            'Errors arrive first-hand, such as a 410 for a dead token.',
            'No third company on the path of a security alert.',
          ],
          cons: [
            'Two APIs, two sets of credentials, two kinds of error.',
            'Long-lived connections and credentials to manage.',
            'Two code paths to test for the same alert.',
          ],
        },
        { name: 'FCM for both platforms', good: 'One API for iOS and Android.', cost: 'One more hop to Apple, and Apple-only options through a translation layer.',
          what: 'The workers send every push to FCM, which passes iOS messages on to APNs.',
          pros: [
            'One API for iOS and Android.',
            'One set of credentials and one error handler in the workers.',
            'Fewer code paths to test.',
          ],
          cons: [
            'One more hop to Apple, and one more place for a delay.',
            'Apple-only options through a translation layer.',
            'Apple\'s errors reach you second-hand.',
          ],
        },
        { name: 'Your own connection to the app (as Uber\'s RAMEN)', good: 'Acknowledged within seconds, with sequence numbers and retries you control.', cost: 'Works only while the app is running. A locked phone still needs APNs or FCM.',
          what: 'While the app runs it keeps its own connection to the bank, as Uber\'s RAMEN does, and the bank sends the alert down it with sequence numbers and acknowledgements.',
          pros: [
            'Acknowledged within seconds, so the bank knows the app has it.',
            'Sequence numbers and retries you control.',
            'This design already has one: the open app\'s WebSocket for the inbox.',
          ],
          cons: [
            'Works only while the app is running. A locked phone still needs APNs or FCM.',
            'A connection to hold for every open app.',
            'An acknowledgement means the app got it, still not that a person saw it.',
          ],
        },
      ],
      say: 'A push accepted is not a push seen. I send at priority 10, as Time Sensitive, and let the escalation timer decide whether it worked.',
      see: [{ id: 'realtime-push', label: 'Real-time push' }],
    },
    {
      id: 'sms',
      name: 'SMS, voice',
      tech: 'two providers',
      x: 1185, y: 400, w: 150, h: 56, kind: 'outside',
      what: 'SMS aggregators and a voice provider. The worker sends the text, and the provider reports its progress by webhook: queued, sent, delivered, undelivered or failed, in Twilio\'s terms. Delivered means the carrier confirmed it, not that anyone read it. A voice call reads a short message and takes a key press.',
      why: 'SMS reaches a phone with no data and no app, and a call is the hardest thing to ignore. Both cost money per message and are weaker channels, so they are steps on the ladder, not the first try.',
      built: [
        { name: "SMS aggregator", what: "A company that sends text messages to many mobile networks through one API, and reports progress by webhook: queued, sent, delivered, undelivered or failed, in Twilio's terms.", why: "SMS reaches a phone with no data and no app. It costs money per message and a SIM swap exposes it, so it is a step on the ladder, never the first try, and never carries a link or a code." },
        { name: "Voice provider", what: "A service that places an automated phone call, reads a short message and takes a key press.", why: "A call is the hardest thing to ignore, so it is step three, at 5 minutes. Pressing 1 says \"not me\"; a call can never release money." },
        { name: "Two providers", what: "Two SMS aggregators with traffic weighted between them, each behind its own circuit breaker.", why: "Two is the smallest number that survives one provider's outage. Both carry a share all the time, because a provider used only in emergencies may be broken when needed." },
      ],
      numbers: [
        { text: 'Two providers, traffic weighted between them, with a breaker on each.', from: 'A design choice, not a sum. Two is the smallest number that survives one provider\'s outage.' },
        { text: 'My rule: no receipt within 60 seconds counts as unknown, not failed.', from: 'A choice. Receipts can be late, out of order or missing (Twilio, in Sources), so silence proves nothing. The SMS goes at 90 seconds and the call at 5 minutes, so 60 seconds is decided well before the next step.' },
      ],
      fails: 'Receipts come from the carrier and can be late, out of order or missing. A provider outage opens its breaker and traffic moves to the other. A SIM swap gives the attacker the owner\'s texts, so an SMS never carries a code or a link, and an SMS reply can only block a payment, never release one.',
      alternatives: [
        { name: 'Two aggregators with failover', chosen: true, good: 'Survives one provider\'s outage or a block on one route.', cost: 'Two contracts, two sets of webhooks to handle.',
          what: 'SMS workers send through two aggregators, traffic weighted between them, each behind its own breaker. A voice provider places the call step. Receipts come back by webhook.',
          pros: [
            'Survives one provider\'s outage or a block on one route.',
            'A breaker moves traffic in seconds, without a deploy.',
            'Receipts from both show when one route is slow.',
          ],
          cons: [
            'Two contracts, two sets of webhooks to handle.',
            'Two sender and template set-ups to keep in step.',
            'A provider used only in emergencies may be broken when needed, so it must carry a share all the time.',
          ],
        },
        { name: 'One provider', good: 'Simpler and cheaper to run.', cost: 'Its outage is your outage, on the channel you use when push has already failed.',
          what: 'All SMS and calls through one aggregator, with retries but no second route.',
          pros: [
            'Simpler and cheaper to run.',
            'One webhook format, one contract.',
            'Enough for an early start-up.',
          ],
          cons: [
            'Its outage is your outage, on the channel you use when push has already failed.',
            'No other route when a carrier blocks or slows its traffic.',
          ],
        },
        { name: 'WhatsApp or RCS business messages', good: 'Branded, verified sender, read receipts.', cost: 'Not everyone has them, and the sender\'s setup and rules take time.',
          what: 'The step-two message goes as a business message on WhatsApp or RCS instead of plain SMS, from a verified sender.',
          pros: [
            'Branded, verified sender, harder to imitate than an SMS sender name.',
            'Read receipts.',
            'Room for a richer message.',
          ],
          cons: [
            'Not everyone has them, and the sender\'s setup and rules take time.',
            'Needs data or an app, which is what the SMS step is there to avoid.',
          ],
        },
      ],
      say: 'SMS is a fallback that tells the owner to open the app. It never carries a link or a code, because SIM swaps and fake bank texts are real.',
    },
    {
      id: 'phone',
      name: 'Owner\'s phone',
      tech: 'app, lock screen',
      x: 1185, y: 46, w: 150, h: 56, kind: 'outside',
      what: 'The owner\'s phone, bound to the account when the app was set up. The lock screen shows: "A payment of £4,800 to a new payee is on hold. Was this you?" with two actions, "Not me" and "Yes, it was me". It shows no account number, no balance and no link.',
      why: 'The binding is what makes this a second channel the attacker does not control. On iOS an action can require the phone to be unlocked, so a stranger holding the phone cannot answer.',
      built: [
        { name: "App", what: "The bank's app on the owner's phone, bound to the account at set-up with a key held on the device.", why: "The binding makes this a second channel the attacker does not control: an answer signed by that key comes from the owner's phone, not from the browser." },
        { name: "Lock screen", what: "What the phone shows before it is unlocked: \"A payment of £4,800 to a new payee is on hold. Was this you?\" with \"Not me\" and \"Yes, it was me\".", why: "Anyone holding the phone can read it, so it shows no account number, balance or link. On iOS an action can require the phone to be unlocked, so a stranger holding the phone cannot answer." },
      ],
      fails: 'The phone is off, lost or out of signal: the ladder moves to SMS, a call, then the second contact. The payment stays held until someone answers or the hold expires, and an expired hold is rejected, not released.',
      alternatives: [
        { name: '"Not me" from the notification; "Yes" opens the app', chosen: true, good: 'Blocking is one tap. Releasing money goes through strong authentication.', cost: 'Two paths for one question.',
          what: 'The lock-screen alert has two actions. "Not me" is answered from the notification on an unlocked phone. "Yes, it was me" opens the app, which asks for strong authentication tied to the £4,800 and the payee before releasing.',
          pros: [
            'Blocking is one tap, at the moment speed matters most.',
            'Releasing money goes through strong authentication bound to the amount and payee.',
            'Matches the risk: a wrong block costs a delay, a wrong release costs the money.',
          ],
          cons: [
            'Two paths for one question, to build and test on iOS and Android.',
            'Honest owners, most of those asked, take the longer path to say yes.',
          ],
        },
        { name: 'Both answers inside the app', good: 'One path, always authenticated.', cost: 'Slower to block, at the moment speed matters most.',
          what: 'Tapping the alert opens the app, which asks "Not me" or "Yes" after its own sign-in.',
          pros: [
            'One path, always authenticated.',
            'Room to show the payee, amount and Confirmation of Payee result.',
            'Simpler to build and test.',
          ],
          cons: [
            'Slower to block, at the moment speed matters most.',
            'The owner must sign in before they can stop anything.',
          ],
        },
        { name: 'Reply to an SMS', good: 'Works without the app or data.', cost: 'Weak authentication: accept "NO" to block, never "YES" to release.',
          what: 'The SMS asks the owner to reply NO to stop the payment, and the provider\'s webhook brings the reply to the reply service.',
          pros: [
            'Works without the app or data.',
            'Reaches an owner whose push token is dead.',
            'Familiar to customers.',
          ],
          cons: [
            'Weak authentication: accept "NO" to block, never "YES" to release.',
            'A SIM swap gives the attacker the owner\'s texts.',
          ],
        },
      ],
      say: 'The two answers carry different risk. A wrong "not me" delays a payment; a wrong "yes" loses the money. So blocking is one tap, and releasing needs strong authentication.',
    },
    {
      id: 'reply',
      name: 'Reply service',
      tech: 'SCA, idempotent',
      x: 900, y: 46, w: 150, h: 56, kind: 'shared',
      what: 'Takes the answer from a notification action, the app or an SMS webhook. It checks the person may act on this account, the alert is still open, and this answer has not been applied already. "Not me" asks the payment service to reject the payment, freeze the cards and end other sessions. "Yes" requires strong customer authentication tied to the amount and payee, then releases the payment.',
      why: 'The answer moves money, so it is treated like a payment instruction: authenticated, time-limited and idempotent on the alert id. If two people answer differently, the safer answer wins: any "not me" blocks, and a release needs the owner or a director.',
      built: [
        { name: "SCA", what: "Strong customer authentication: two independent factors out of something you know, have and are, such as the bound phone and a fingerprint. With dynamic linking, the code is tied to the amount and the payee.", why: "\"Yes\" releases money, so it is treated as a payment instruction. \"Not me\" only delays a payment, so a signed tap from the bound phone is enough." },
        { name: "Idempotent", what: "Doing it twice has the same effect as doing it once. Every call to the Payment service carries the alert id, A-91, as its idempotency key.", why: "Apps retry and people double-tap. A repeated Reject returns the first result, rejected at version 3, and nothing is applied twice." },
      ],
      numbers: [
        { text: 'An answer is valid until the hold expires. The payment delay rules allow until the end of the fourth business day after the order, but a business waiting on a supplier payment wants an answer in minutes.', from: 'Quoted from FCA FG24/6 and the 2024 regulations (in Sources): a delay may last until the end of the fourth business day. "Minutes" is not a rule, only what a business paying a supplier needs.' },
      ],
      fails: 'A double tap or a retried request returns the first result. If the payment service is down, the answer is recorded and applied when it returns: the payment is held, so nothing moves meanwhile. The reply service never releases a payment because something timed out.',
      alternatives: [
        { name: 'One reply service, idempotent on the alert id', chosen: true, good: 'One place for the rules about who may answer, how strongly, and what happens.', cost: 'A service on the critical path of every answer.',
          what: 'Every answer, from a notification action, the app, an SMS or a call, goes to one service. It checks who is answering, that the alert is open and not yet answered, then calls the payment service with the alert id as the idempotency key.',
          pros: [
            'One place for who may answer, how strongly, and what happens.',
            'A double tap or a retried request returns the first result.',
            'One rule for conflicts: any "not me" blocks, and a release needs the owner or a director.',
          ],
          cons: [
            'A service on the critical path of every answer.',
            'If it is down, answers wait; the payment stays held, so nothing moves meanwhile.',
            'Every channel\'s answer format must be mapped into it.',
          ],
        },
        { name: 'Each channel applies its own answer', good: 'Fewer hops.', cost: 'Rules drift between push, SMS and the app, and races between them are hard to reason about.',
          what: 'The app backend, the SMS webhook handler and the voice handler each call the payment service themselves.',
          pros: [
            'Fewer hops.',
            'No shared service to keep available.',
            'Each channel team owns its whole path.',
          ],
          cons: [
            'Rules drift between push, SMS and the app.',
            'Races between channels are hard to reason about: an SMS "no" and an app "yes" at once.',
            'Three places to enforce strong authentication for a release.',
          ],
        },
        { name: 'Always route the owner to a call with fraud operations', good: 'A human judges every case.', cost: 'Minutes to hours, at 8,000 alerts a day.',
          what: 'No self-service answer: every held payment waits for the owner to speak to fraud operations, who release or block it.',
          pros: [
            'A human judges every case.',
            'A person can notice a customer being coached by a scammer.',
            'No reply service or authentication flow to build.',
          ],
          cons: [
            'Minutes to hours, at 8,000 alerts a day.',
            'Most alerts go to honest owners, who wait on the phone to release their own payment.',
            'Staff needed at 23:40 on a Friday.',
          ],
        },
      ],
      say: 'The reply is a payment instruction in disguise. It is authenticated, idempotent on the alert id, and "yes" needs strong customer authentication bound to the amount and payee.',
    },
    {
      id: 'ops',
      name: 'Fraud operations',
      tech: 'case queue',
      short: 'Fraud ops',
      x: 345, y: 475, w: 150, h: 56, kind: 'shared',
      what: 'The team that works cases: every "not me", every alert that expires unanswered, and every alert for a customer flagged as vulnerable. Each case arrives with the alert\'s full timeline from the alert store.',
      why: 'Some answers need a person: asking the receiving bank to freeze funds, reporting to the police, and deciding a reimbursement claim within the time the rules allow.',
      built: [
        { name: "Case queue", what: "A work queue for the fraud team: every \"not me\", every alert that expires unanswered, and every alert for a customer flagged as vulnerable, each with its full timeline. Cases come from a change feed (change data capture) on the Alert store.", why: "Some steps need a person: asking the receiving bank to freeze funds, reporting to the police, and deciding a reimbursement claim within 5 business days, or 35 at most. A queue gives each case an owner and an alarm on cases older than an hour; saved queries on the store would give neither." },
      ],
      numbers: [
        { text: 'Reimbursement within 5 business days of a claim, or 35 at most when the bank stops the clock to investigate (PSR).', from: 'Quoted from the PSR sources, not derived: five business days, or up to 35 when the bank stops the clock.' },
      ],
      fails: 'If case creation lags, nothing is lost: the change feed is replayed. Alarm on cases older than an hour.',
      alternatives: [
        { name: 'Cases from the alert store\'s change feed', chosen: true, good: 'Every case carries the same timeline the customer saw.', cost: 'One more consumer to run.',
          what: 'A change feed on the alert store turns alerts closed as "not me", expired without an answer, or sent to a vulnerable customer into cases, each with its full timeline.',
          pros: [
            'Every case carries the same timeline the customer saw.',
            'A lag loses nothing: the feed is replayed, and the alert id stops duplicate cases.',
            'The alert service does not depend on the case tool.',
          ],
          cons: [
            'One more consumer to run.',
            'Seconds between the alert closing and the case opening.',
          ],
        },
        { name: 'Ops reads the alert store directly', good: 'Nothing to build.', cost: 'No queue, no ownership, and nothing pages when cases pile up.',
          what: 'Fraud operations run saved queries on the alert store to find expired and "not me" alerts.',
          pros: [
            'Nothing to build.',
            'Any question can be asked of the data.',
            'Workable at start-up scale.',
          ],
          cons: [
            'No queue, no ownership, and nothing pages when cases pile up.',
            'Analysts\' queries load the store the alert service writes to.',
          ],
        },
        { name: 'The alert service opens the case itself', good: 'No change feed, and the case opens as the alert closes.', cost: 'A dual write: the alert can close without its case, and the alert service depends on the case tool.',
          what: 'When the alert service closes an alert as "not me" or expired, it calls the case tool directly.',
          pros: [
            'No change feed to run.',
            'The case opens the moment the alert closes.',
          ],
          cons: [
            'A dual write: the alert can close without its case.',
            'The alert service now depends on the case tool, and a failed call needs its own retries.',
            'No replay if case creation has a bug.',
          ],
        },
      ],
      say: 'The automated path handles the common case. Expired and confirmed-fraud alerts become cases with the full timeline attached.',
    },
  ],

  flows: [
    {
      id: 'pay', from: 'payer', to: 'payments', d: 'M145,190 H270', label: 'payment order',
      mode: 'external', via: 'HTTPS', chip: 0.5, at: 'above',
      how: 'POST /payments with an idempotency key chosen by the client, the payee, the amount and the device\'s identity. The payee goes through Confirmation of Payee first, when the payee is new.',
      delivery: 'Safe to repeat: the same idempotency key returns the same payment, never a second one.',
      alts: ['An Open Banking payment initiated by another app on the owner\'s behalf.', 'A card authorisation from the card network, with a much tighter deadline.'],
      examples: [
        { title: 'Request', lang: 'http', code: `POST /payments HTTP/1.1
Host: api.bank.example
Authorization: Bearer <session token>
Idempotency-Key: 6f1c2e0a-4b7d-4e8a-9d3f-2a5b8c1e7f40
Content-Type: application/json

{
  "account_id": "acc_51207",
  "scheme": "FPS",
  "payee_id": "pye_77310",
  "amount_pence": 480000,
  "currency": "GBP",
  "device": {
    "id": "dev_web_9c1e",
    "kind": "browser"
  }
}`,
          note: 'The client chose the Idempotency-Key, so sending this again returns pay_8KD3F2, never a second payment.' },
        { title: 'Response (the reply: pending)', lang: 'http', code: `HTTP/1.1 202 Accepted
Location: /payments/pay_8KD3F2
Content-Type: application/json

{
  "payment_id": "pay_8KD3F2",
  "status": "pending",
  "message": "We are checking this payment."
}`,
          note: 'Pending says nothing about suspicion; the final state comes later through the inbox or a refresh.' },
      ],
      ways: [
        { name: 'HTTPS', chosen: true, what: 'POST /payments from the app, the web or the API, with a client-chosen idempotency key, the payee, the amount and the device\'s identity. The service answers "pending" while it checks.',
          pros: [
            'One API for the app, the web and accounting tools.',
            'A retried request with the same key returns the same payment.',
            'Carries the device identity the risk engine needs.',
          ],
          cons: [
            'Proves the channel, not the person: the session may be the attacker\'s.',
            'The client must handle "pending" and learn the final state later.',
          ] },
        { name: 'Open Banking payment initiation', what: 'Another app, such as an accounting tool, starts the payment through the bank\'s Open Banking interface on the owner\'s behalf. The order reaches the payment service and is scored the same way.',
          pros: [
            'The owner pays from inside a tool they already use.',
            'The same hold, alert and reply path applies.',
          ],
          cons: [
            'Another company\'s app is in the journey, so the bank controls less of what the payer sees.',
            'Another integration to keep, with its own consent and authentication flow.',
          ] },
        { name: 'Card authorisation', what: 'The card network asks the bank to approve a card payment while the customer waits at the till. It goes through the same risk engine with a tighter deadline.',
          pros: [
            'Covers card spend, which the brief asks about.',
            'A decline is instant, and an honest customer can try again.',
          ],
          cons: [
            'No time to ask the owner first: allow or decline, then a notification.',
            'A much tighter deadline than a bank transfer.',
          ] },
      ],
      reply: {
        id: 'payres', label: 'pending',
        how: 'The payment comes back as pending. The person at the browser is not told it is suspected, only that it is being checked.',
        delivery: 'The final state arrives later, by the app\'s inbox or a refresh.',
      },
    },
    {
      id: 'score', from: 'payments', to: 'risk', d: 'M345,141 V78', label: 'score',
      mode: 'call', via: 'gRPC', chip: 0.5, at: 'right',
      how: 'Score(payment, account, device, payee) with a deadline of 150 ms. The request carries everything the payment service already knows, so the engine does not call back.',
      delivery: 'One try within the deadline. On timeout the payment service applies its fallback policy and logs that it did.',
      alts: ['An asynchronous score after submission, which is too late for Faster Payments.', 'The rules compiled into the payment service as a library, with no network hop but slower to change.'],
      examples: [
        { title: 'Service definition', lang: 'proto', code: `service RiskEngine {
  rpc Score(ScoreRequest) returns (Verdict);
}

message ScoreRequest {
  Payment payment = 1;  // id, amount_pence, scheme, created_at
  Account account = 2;  // id, business_id
  Device device = 3;    // id, kind, bound, country
  Payee payee = 4;      // id, added_at
}

message Verdict {
  enum Action {
    ACTION_UNSPECIFIED = 0;
    ALLOW = 1;
    WARN = 2;
    HOLD = 3;
    BLOCK = 4;
  }
  Action action = 1;
  double score = 2;
  repeated string reasons = 3;
  string model_version = 4;
  string rules_version = 5;
}` },
        { title: 'Example call (the reply: hold)', lang: 'text', code: `Score, deadline 150 ms
{
  payment: { id: "pay_8KD3F2", amount_pence: 480000,
             scheme: "FPS", created_at: "2026-11-13T23:40:12Z" },
  account: { id: "acc_51207", business_id: "biz_3318" },
  device:  { id: "dev_web_9c1e", kind: "browser",
             bound: false, country: "NL" },
  payee:   { id: "pye_77310", added_at: "2026-11-13T23:38:05Z" }
}

reply
{
  action: HOLD,
  score: 0.93,
  reasons: ["new_device", "new_payee_velocity", "unusual_hour"],
  model_version: "model-2026-11-02",
  rules_version: "rules-418"
}`,
          note: 'The reply names the model and rule versions, so the logged decision can be replayed; on a timeout there is no reply and the fallback policy applies.' },
      ],
      ways: [
        { name: 'gRPC', chosen: true, what: 'Score(payment, account, device, payee) with a 150 ms deadline. The request carries everything the payment service knows, so the engine never calls back.',
          pros: [
            'A deadline on the call, so the payment never waits past its budget.',
            'Typed request and reply, including the model and rule versions that decided.',
            'Reused connections keep the hop cheap.',
          ],
          cons: [
            'A synchronous dependency: a slow engine slows payments up to the deadline.',
            'Needs the fallback policy for timeouts.',
          ] },
        { name: 'Asynchronous score after submission', what: 'The engine reads the payment from the log after it has been sent, and alerts if it looks wrong.',
          pros: [
            'No latency added to the payment.',
            'The engine can take longer and use more features.',
          ],
          cons: [
            'Too late for Faster Payments: the money has gone.',
            'Turns every hold into a recovery case.',
          ] },
        { name: 'Rules as a library in the payment service', what: 'The rules are compiled into the payment service and run in its process.',
          pros: [
            'No network hop, and no engine to be down.',
            'The lowest latency.',
          ],
          cons: [
            'Slower to change: a new rule needs a payment service release.',
            'A model and features inside the payment service make it heavier and harder to own.',
          ] },
      ],
      reply: {
        id: 'verdict', label: 'hold',
        how: 'The action (allow, warn, hold or block), the reasons, and the versions of the model and rules that decided.',
        delivery: 'Logged with its inputs, so the decision can be replayed and explained later.',
      },
    },
    {
      id: 'feat', from: 'risk', to: 'features', d: 'M270,50 H150', label: 'features',
      mode: 'call', via: 'Redis', chip: 0.5, at: 'above',
      how: 'One round trip: a short script reads the account\'s feature hash and increments the short-window counters for this payment, atomically.',
      delivery: 'A timeout of about 10 ms. Missing features are marked missing, not zero.',
      alts: ['A feature service in front of the store, as Monzo\'s feature loader, which resolves a graph of features with a timeout.', 'Reading features from a stream processor\'s state.'],
      examples: [
        { title: 'Commands', lang: 'text', code: `# One round trip: the engine runs one stored script
EVALSHA <sha> 1 feat:acc_51207 480000 dev_web_9c1e NL
# Inside the script, as one atomic step:
HGETALL feat:acc_51207
# -> new_payees_1h 3, pays_1h 0, sent_today_pence 0,
#    late_pays_ytd 0, dev:dev_ios_41a2 1, cc:GB 1
HINCRBY feat:acc_51207 pays_1h 1
# -> 1: this payment is counted
HINCRBY feat:acc_51207 sent_today_pence 480000
# -> 480000
HINCRBY feat:acc_51207 late_pays_ytd 1
# -> 1: the first payment after 23:00 this year
# The script returns the old hash and the new counts.`,
          note: 'Read and increment run inside one script, so two payments at the same moment both count.' },
        { title: 'Reply (velocity)', lang: 'json', code: `{
  "new_payees_1h": 3,
  "pays_1h": 1,
  "sent_today_pence": 480000,
  "late_pays_ytd": 1,
  "device_seen": false,
  "country_seen": false,
  "missing": []
}`,
          note: 'A feature that did not resolve within about 10 ms is listed under missing, never returned as zero.' },
      ],
      ways: [
        { name: 'Redis', chosen: true, what: 'One round trip runs a short script in Redis that reads the account\'s feature hash and increments its short-window counters, atomically. The timeout is about 10 ms.',
          pros: [
            'One round trip, about 10 ms of the 150 ms budget.',
            'Read and increment are one step, so two payments at once both count.',
            'A timeout marks features missing, never zero.',
          ],
          cons: [
            'A script in the store is code to version and test.',
            'The engine is tied to the store\'s data layout.',
          ] },
        { name: 'A feature service (as Monzo\'s feature loader)', what: 'A service in front of the stores resolves the features each detector needs as a graph, with a timeout, and returns what has resolved.',
          pros: [
            'Detectors ask for features by name, not by key layout.',
            'Mixes sources: in-line counters, stream results and batch tables.',
          ],
          cons: [
            'Another hop inside the 150 ms budget.',
            'Another service to run.',
          ] },
        { name: 'A stream processor\'s state', what: 'The engine reads windowed counts that a stream processor keeps from payment-events.',
          pros: [
            'Exact windows and joins across streams.',
            'No separate counter store.',
          ],
          cons: [
            'Seconds behind: the payment being scored is not counted.',
            'Ties every payment decision to the stream job being up.',
          ] },
      ],
      reply: {
        id: 'featvals', label: 'velocity',
        how: 'Counts and flags: new payees in the last hour, amount sent today, device and country seen before.',
        delivery: 'Read and updated in one step, so two payments at the same moment both count.',
      },
    },
    {
      id: 'outbox', from: 'payments', to: 'txlog', d: 'M345,239 V308', label: 'state changes',
      mode: 'async', via: 'CDC', chip: 0.5, at: 'right',
      how: 'The held state and an outbox row commit in one transaction. Change data capture reads the database\'s log and publishes each outbox row to Kafka, keyed by account id.',
      delivery: 'At-least-once. The relay can publish and crash before it records that it did, so every event carries a deterministic id and readers ignore repeats.',
      alts: ['A relay that polls the outbox table, which is simpler but adds polling delay.', 'Publishing straight to Kafka after the commit, which is the dual write this avoids.'],
      examples: [
        { title: 'One transaction', lang: 'sql', code: `BEGIN;
UPDATE payments
   SET status = 'held',
       version = 2,
       hold_expires_at = '2026-11-19 23:59:59+00'
 WHERE payment_id = 'pay_8KD3F2'
   AND status = 'pending'
   AND version = 1;
-- 1 row; 0 rows would mean something else moved it first

INSERT INTO outbox (event_id, account_id, event_type, payload)
VALUES ('pay_8KD3F2:2', 'acc_51207', 'payment.held', $1);
-- $1 is the message value shown on the next connection
COMMIT;`,
          note: 'The event id is the payment id and its version, so a row published twice carries the same id and readers drop the repeat.' },
        { title: 'Change event read from the database log', lang: 'json', code: `{
  "table": "outbox",
  "op": "insert",
  "before": null,
  "after": {
    "event_id": "pay_8KD3F2:2",
    "account_id": "acc_51207",
    "event_type": "payment.held",
    "payload": "<the message value, next connection>"
  },
  "committed_at": "2026-11-13T23:40:12Z"
}`,
          note: 'A generic shape, not any one connector\'s format: an insert with no before and the new row after.' },
        { title: 'Topic and key', lang: 'text', code: `topic      payment-events
key        acc_51207   (account id)
value      the outbox row's payload, JSON
partition  hash(key) mod the number of partitions`,
          note: 'Keyed by account, every event for the café lands on one partition, so "rejected" is never read before "held".' },
      ],
      ways: [
        { name: 'CDC', chosen: true, what: 'Change data capture reads the database\'s own log and publishes each committed outbox row to Kafka, keyed by account. The payment service only writes to its database.',
          pros: [
            'No dual write.',
            'Publishes as soon as the commit is in the log, with no polling delay.',
            'No polling queries on the payment database.',
          ],
          cons: [
            'A connector to run, tied to the database\'s log.',
            'At-least-once: events carry a deterministic id so readers ignore repeats.',
          ] },
        { name: 'A polling relay', what: 'A worker queries the outbox table every so often for unpublished rows, publishes them and marks them sent.',
          pros: [
            'Simpler: plain SQL, no log connector.',
            'Easy to understand and debug; the start-up framing uses one.',
          ],
          cons: [
            'Adds the polling delay to every alert.',
            'Polling queries load the payment database.',
          ] },
        { name: 'Publish to Kafka after the commit', what: 'The payment service commits the hold, then publishes the event to Kafka as a second step.',
          pros: [
            'No outbox table and no relay.',
            'The lowest delay when everything works.',
          ],
          cons: [
            'The dual write this design avoids: a crash in between leaves a payment held and nobody told.',
            'A Kafka outage now stalls payments or loses events.',
          ] },
      ],
    },
    {
      id: 'consume', from: 'txlog', to: 'alerts', d: 'M435,340 H583', label: 'held',
      mode: 'async', via: 'Kafka', chip: 0.34, at: 'below',
      how: 'The alert service\'s consumer group reads the partitions of payment-events. It acts on events that need a person (held, blocked, released, card frozen) and ignores the rest.',
      delivery: 'At-least-once, in order per account. Offsets are committed only after the alert is written and its sends are queued.',
      alts: ['A topic of risk decisions published by the engine, which separates "held" from the payment\'s own record.', 'A webhook from the payment service, with retries to build.'],
      examples: [
        { title: 'Message value', lang: 'json', code: `{
  "event_id": "pay_8KD3F2:2",
  "event_type": "payment.held",
  "payment_id": "pay_8KD3F2",
  "version": 2,
  "account_id": "acc_51207",
  "business_id": "biz_3318",
  "scheme": "FPS",
  "amount_pence": 480000,
  "currency": "GBP",
  "payee": { "id": "pye_77310", "new": true },
  "device": { "id": "dev_web_9c1e", "bound": false },
  "risk": {
    "action": "HOLD",
    "reasons": ["new_device", "new_payee_velocity",
                "unusual_hour"]
  },
  "hold_expires_at": "2026-11-19T23:59:59Z",
  "occurred_at": "2026-11-13T23:40:12Z"
}` },
        { title: 'What the consumer does', lang: 'text', code: `group alerts, reading payment-events
payment.held      alert_id = hash(payment_id, "payment.held")
                  shown as A-91 on this page
                  write the alert, resolve the plan, queue sends
payment.rejected  close A-91 as answered, cancel later steps
payment.created   ignore
payment.sent      ignore

commit the offset only after the alert row and its jobs
are written; after a crash the event is read again and
finds A-91 already there`,
          note: 'The alert id comes from the payment id and the reason, so a second copy of the event creates nothing new.' },
      ],
      ways: [
        { name: 'Kafka', chosen: true, what: 'The alert service\'s consumer group reads payment-events, acts on held, blocked, released and card frozen, and ignores the rest. Offsets are committed only after the alert is written and its sends are queued.',
          pros: [
            'Order per account.',
            'A crash means a re-read, and the alert id makes that harmless.',
            'Lag is a direct measure of alert delay.',
          ],
          cons: [
            'Reads all 12 million events a day to act on a small share of them.',
            'A rebalance of the consumer group can pause a partition briefly.',
          ] },
        { name: 'A topic of risk decisions', what: 'The risk engine publishes its decisions to their own topic, and the alert service reads that instead.',
          pros: [
            'Only the events that matter.',
            'Separates detection from the payment\'s own record.',
          ],
          cons: [
            'Decision and hold are two writes: the topic can say "held" for a hold that never committed.',
            'Releases and blocks still come from payment-events, so two topics to order against each other.',
          ] },
        { name: 'A webhook from the payment service', what: 'The payment service calls an alert service endpoint for each held payment.',
          pros: [
            'Simple and familiar.',
            'No consumer group to run.',
          ],
          cons: [
            'Retries to build, and retries can break the order per account.',
            'No replay.',
          ] },
      ],
    },
    {
      id: 'resolve', from: 'alerts', to: 'prefs', d: 'M655,300 V208', label: 'who, how?',
      mode: 'call', via: 'gRPC', chip: 0.5, at: 'right',
      how: 'Resolve(business, category, amount, time) returns a plan: people, channels in order, language, which rules were overridden and why.',
      delivery: 'A timeout of 50 ms. On failure the alert service uses its cached plan or the mandatory default, and records that it did.',
      alts: ['A local copy of preferences in the alert service, kept current by change data capture.', 'Preferences sent inside every event, which goes stale as soon as someone changes a setting.'],
      examples: [
        { title: 'Service definition', lang: 'proto', code: `service Preferences {
  rpc Resolve(ResolveRequest) returns (Plan);
}

message ResolveRequest {
  string business_id = 1;
  string category = 2;      // "security"
  int64 amount_pence = 3;
  string at = 4;            // when the event happened
}

message Plan {
  repeated Recipient recipients = 1;
  repeated string overrides = 2;  // which rule, and why
}

message Recipient {
  string person_id = 1;
  string role = 2;
  string language = 3;
  bool can_answer = 4;
  repeated Step steps = 5;  // channel, after_seconds
}` },
        { title: 'Example call (the reply: plan)', lang: 'text', code: `Resolve, deadline 50 ms
{ business_id: "biz_3318", category: "security",
  amount_pence: 480000, at: "2026-11-13T23:40:12Z" }

reply
{
  recipients: [
    { person_id: "per_1101", role: "owner", language: "en-GB",
      can_answer: true,
      steps: [ { channel: "push",  after_seconds: 0 },
               { channel: "sms",   after_seconds: 90 },
               { channel: "voice", after_seconds: 300 } ] },
    { person_id: "per_1103", role: "director", language: "en-GB",
      can_answer: true,
      steps: [ { channel: "push", after_seconds: 600 } ] },
    { person_id: "per_1102", role: "bookkeeper", language: "en-GB",
      can_answer: false,
      steps: [ { channel: "email", after_seconds: 0 } ] }
  ],
  overrides: ["owner quiet hours from 22:00: category security"]
}`,
          note: 'The override is named in the plan, and the plan is stored with the alert, so the audit shows why the owner was woken.' },
      ],
      ways: [
        { name: 'gRPC', chosen: true, what: 'Resolve(business, category, amount, time) returns a plan within 50 ms. On failure the alert service uses its cached plan or the mandatory default, and records that it did.',
          pros: [
            'Always the current settings.',
            'A deadline bounds the wait.',
            'The plan is stored with the alert, for the audit.',
          ],
          cons: [
            'A network call on the alert path.',
            'A fallback to keep and test.',
          ] },
        { name: 'A local copy, fed by change data capture', what: 'The alert service keeps every preference in its own memory, updated by change data capture.',
          pros: [
            'No call and no timeout.',
            'Survives Preferences being down.',
          ],
          cons: [
            'Seconds stale after a change.',
            'Every instance holds a few GB.',
          ] },
        { name: 'Preferences inside every event', what: 'The payment event carries the business\'s contact plan.',
          pros: [
            'No lookup at all.',
            'The simplest path.',
          ],
          cons: [
            'Stale as soon as someone changes a setting.',
            'The payment service now has to know about people, channels and quiet hours.',
          ] },
      ],
      reply: {
        id: 'plan', label: 'plan',
        how: 'For example: owner by push, then SMS at 90 seconds, then a call; bookkeeper by email, no actions; quiet hours overridden because the category is security.',
        delivery: 'The plan is stored with the alert, so the audit shows the rules as they were at that moment.',
      },
    },
    {
      id: 'record', from: 'alerts', to: 'store', d: 'M655,380 V440', label: 'alert, audit',
      mode: 'write', via: 'SQL', chip: 0.5, at: 'right',
      how: 'Insert the alert with its id as the primary key, the plan, and the time of the next step. Later steps append events: sent, delivered, answered, closed.',
      delivery: 'Safe to repeat: inserting an alert id that exists does nothing, and events are keyed by alert id and step.',
      alts: ['Event-sourcing the alert into its own topic and building the inbox from it.', 'A document per alert, updated in place, which loses the history.'],
      examples: [
        { title: 'Write the alert before sending', lang: 'sql', code: `INSERT INTO alerts
  (alert_id, created_at, payment_id, account_id, category,
   severity, status, plan, next_step, next_step_at)
VALUES
  ('A-91', '2026-11-13 23:40:12+00', 'pay_8KD3F2',
   'acc_51207', 'security', 'high', 'open', $1, 2,
   '2026-11-13 23:41:42+00')
ON CONFLICT DO NOTHING;
-- $1 is the plan from Preferences, as JSON
-- a second copy of the held event inserts nothing`,
          note: 'The table is partitioned by month, so PostgreSQL needs created_at in the key; it is the event\'s own time, so a repeat still collides.' },
        { title: 'Later steps append events', lang: 'sql', code: `INSERT INTO alert_events
  (alert_id, alert_created_at, step, kind, at, detail)
VALUES ('A-91', '2026-11-13 23:40:12+00', 1, 'push_accepted',
        '2026-11-13 23:40:13+00', '{"provider": "apns"}')
ON CONFLICT DO NOTHING;

-- 23:43, after "not me" and the payment.rejected event
BEGIN;
INSERT INTO alert_events
  (alert_id, alert_created_at, step, kind, at, detail)
VALUES ('A-91', '2026-11-13 23:40:12+00', 2, 'answered',
        '2026-11-13 23:43:05+00',
        '{"answer": "not_me", "device": "dev_ios_41a2"}')
ON CONFLICT DO NOTHING;
UPDATE alerts
   SET status = 'answered', answer = 'not_me',
       next_step_at = NULL
 WHERE alert_id = 'A-91'
   AND created_at = '2026-11-13 23:40:12+00'
   AND status IN ('open', 'sent', 'delivered');
COMMIT;`,
          note: 'Setting next_step_at to NULL is what cancels the call and the director: the timer is that column.' },
      ],
      ways: [
        { name: 'SQL', chosen: true, what: 'Insert the alert with its id as the primary key, its plan and the time of its next step. Later steps append event rows keyed by alert id and step.',
          pros: [
            'A repeat does nothing: the key already exists.',
            'History kept as rows is the audit trail.',
            'The next-step time is the durable timer.',
          ],
          cons: [
            'Every step is a database write.',
            'The timer poll reads the same table every second.',
          ] },
        { name: 'Event-sourcing into a topic', what: 'Each change to an alert is an event on its own topic, and the inbox and audit are built from it.',
          pros: [
            'Full history by design, and replay.',
            'Each reader can build its own view.',
          ],
          cons: [
            'The inbox is a view that can lag the events.',
            'Timers and current state still need a store.',
          ] },
        { name: 'A document per alert, updated in place', what: 'One document per alert, rewritten as the alert moves through its states.',
          pros: [
            'One read gives the whole alert.',
            'A flexible shape.',
          ],
          cons: [
            'Loses the history unless it is kept somewhere else.',
            'Concurrent updates must be guarded.',
          ] },
      ],
    },
    {
      id: 'enqueue', from: 'alerts', to: 'queue', d: 'M727,340 H825', label: 'send jobs',
      mode: 'async', via: 'Kafka', chip: 0.5, at: 'above',
      how: 'One job per person and channel on the topic for the alert\'s priority: P0 for this one. Each job carries its dedup key, the template id, the language and an expiry.',
      delivery: 'At-least-once. The dedup key makes a repeated job harmless, and an expired job is dropped, because a fraud alert after the hold has ended only confuses people.',
      alts: ['Calling the workers directly, which loses buffering and retries.', 'One job per alert that the worker fans out, which hides failures per person.'],
      examples: [
        { title: 'Topic and key', lang: 'text', code: `topic  sends.p0   (others: sends.p1, sends.p2, sends.p3)
key    A-91       (alert id: one alert's steps stay in order)
value  one send job per person and channel, JSON

for A-91 at 23:40:12:
  A-91:per_1101:push:1    owner, push
  A-91:per_1102:email:1   bookkeeper, email copy, no buttons
at 23:41:42, step 2:
  A-91:per_1101:sms:2     owner, SMS` },
        { title: 'Message value', lang: 'json', code: `{
  "job_id": "A-91:per_1101:push:1",
  "alert_id": "A-91",
  "person_id": "per_1101",
  "channel": "push",
  "step": 1,
  "device_id": "dev_ios_41a2",
  "template": "payment_held",
  "language": "en-GB",
  "params": { "amount_pence": 480000, "payee_new": true },
  "expires_at": "2026-11-19T23:59:59Z"
}`,
          note: 'The job id is the dedup key (alert, person, channel, step), and expires_at is the end of the hold.' },
        { title: 'Receipt read back from send-status', lang: 'json', code: `{
  "job_id": "A-91:per_1101:sms:2",
  "attempt": 1,
  "alert_id": "A-91",
  "channel": "sms",
  "provider": "sms-a",
  "outcome": "delivered",
  "at": "2026-11-13T23:41:46Z"
}`,
          note: 'Recorded as an event row keyed by alert and step, so a repeated receipt changes nothing.' },
      ],
      ways: [
        { name: 'Kafka', chosen: true, what: 'One job per person and channel on the topic for the alert\'s priority, each with its dedup key, template id, language and expiry.',
          pros: [
            'Absorbs bursts: 100 alerts a second become work the workers drain.',
            'A failure shows per person and channel.',
            'Expired jobs are dropped, not sent late.',
          ],
          cons: [
            'At-least-once, so the dedup key is needed.',
            'One more hop before the first push.',
          ] },
        { name: 'Call the workers directly', what: 'The alert service calls the channel workers itself, and waits for the result.',
          pros: [
            'One hop fewer.',
            'An immediate result.',
          ],
          cons: [
            'Loses buffering and retries.',
            'A slow provider slows the alert service.',
          ] },
        { name: 'One job per alert, fanned out by the worker', what: 'One job per alert; the worker reads the plan and sends to each person and channel.',
          pros: [
            'Fewer messages.',
            'A simpler enqueue.',
          ],
          cons: [
            'Hides failures per person.',
            'A retried job resends to everyone unless each send is deduplicated.',
          ] },
      ],
      reply: {
        id: 'receipts', label: 'receipts',
        how: 'The alert service reads delivery results from a status topic and records them. A hard failure, such as a dead push token, moves the ladder to its next step at once.',
        delivery: 'At-least-once, keyed by job, so a repeated receipt changes nothing.',
      },
    },
    {
      id: 'jobs', from: 'queue', to: 'workers', d: 'M900,308 V229', label: 'P0 first',
      mode: 'async', via: 'Kafka', chip: 0.5, at: 'right',
      how: 'Each channel\'s workers read their own topics, with more consumers on P0 than on P3, and a separate quota with each provider for P0.',
      delivery: 'At-least-once. After the last retry a job goes to a dead-letter topic, and a P0 job there opens a case.',
      alts: ['Workers pulling from SQS queues per priority, with visibility timeouts for retries.'],
      examples: [
        { title: 'Topics and consumer groups', lang: 'text', code: `sends.p0, one consumer group per channel pool:
  push-p0    takes jobs with channel "push"
  sms-p0     takes jobs with channel "sms"
  voice-p0   takes jobs with channel "voice"
  email-p0   takes jobs with channel "email"
P0 groups run more consumers than P3 groups, and use
their own quota with each provider.

before each provider call, an atomic set-if-absent:
  dedup:A-91:per_1101:push:1   (kept until the hold ends)
  -> set:     this worker sends
  -> present: a copy already sent or is sending; skip

after the last retry (about 1, 2 and 4 seconds):
  topic sends.p0.dead-letter, key A-91, value the job
  a P0 job there also opens a case` },
        { title: 'Status message (the reply), key job id', lang: 'json', code: `{
  "job_id": "A-91:per_1101:push:1",
  "attempt": 1,
  "alert_id": "A-91",
  "channel": "push",
  "provider": "apns",
  "outcome": "accepted",
  "detail": "200",
  "at": "2026-11-13T23:40:13Z"
}`,
          note: 'Accepted means Apple has it, not that anyone saw it, so the 90-second timer keeps running.' },
      ],
      ways: [
        { name: 'Kafka', chosen: true, what: 'Each channel\'s workers read their own priority topics, with more consumers on P0 than on P3. After the last retry a job goes to a dead-letter topic.',
          pros: [
            'P0 has its own readers and is never behind P3.',
            'Dead-letter and replay after a fix.',
            'Lag per topic shows which priority is behind.',
          ],
          cons: [
            'A job retrying in place holds up the jobs behind it in its partition, so P0 retries stay at about 7 seconds.',
            'Parallelism is capped by the number of partitions.',
          ] },
        { name: 'SQS queues per priority', what: 'Workers poll a managed queue per priority. A job not finished reappears after a visibility timeout.',
          pros: [
            'Retries and dead-letter queues built in.',
            'One slow job does not hold up the others.',
          ],
          cons: [
            'No replay of past jobs.',
            'A second messaging system beside Kafka.',
          ] },
        { name: 'A jobs table polled by workers', what: 'Send jobs are rows beside the alert in the alert store, and workers claim them with a row lock.',
          pros: [
            'One system fewer: jobs live with the alert.',
            'A job and the alert\'s state change in one transaction.',
          ],
          cons: [
            'Polling load on the database that holds the audit.',
            'Hard to stretch to P3 campaigns at over 3,000 a second.',
          ] },
      ],
      reply: {
        id: 'status', label: 'status',
        how: 'The worker publishes the outcome of each attempt: accepted, delivered, failed, and why.',
        delivery: 'At-least-once, keyed by job and attempt.',
      },
    },
    {
      id: 'apns', from: 'workers', to: 'push', d: 'M983,180 H1110', label: 'priority 10',
      mode: 'external', via: 'HTTP/2', chip: 0.543, at: 'above',
      how: 'A POST to APNs with apns-priority 10, push type alert, the Time Sensitive interruption level, a collapse id of the alert id, and an expiry at the end of the hold. FCM gets the same message at high priority.',
      delivery: 'Best effort. Connections are kept open for hours and reused, and each request has its own id for tracing.',
      alts: ['FCM for both platforms.', 'A silent push that makes the app fetch the alert, which iOS may delay or skip.'],
      examples: [
        { title: 'Request to APNs', lang: 'http', code: `POST /3/device/<token of the owner's iPhone>
apns-push-type: alert
apns-priority: 10
apns-collapse-id: A-91
apns-expiration: 1795132799
apns-topic: <the app's bundle id>
authorization: bearer <provider token>

{
  "aps": {
    "alert":
      "A payment of £4,800 to a new payee is on hold. Was this you?",
    "interruption-level": "time-sensitive",
    "category": "PAYMENT_HOLD"
  },
  "alert_id": "A-91"
}`,
          note: 'Expiry 1795132799 is 23:59:59 on 19 November, the end of the hold; header and aps names are Apple\'s, alert_id and PAYMENT_HOLD are the app\'s own.' },
        { title: 'The same alert through FCM (generic)', lang: 'text', code: `to            the owner's Android device token
priority      high
collapse      A-91
time to live  until 2026-11-19 23:59:59
text          A payment of £4,800 to a new payee is on hold.
              Was this you?
data          alert_id A-91, two actions

Shown as fields, not as FCM's own request format.` },
        { title: 'Responses (the reply: 200 or 410)', lang: 'http', code: `HTTP/2 200
apns-id: <Apple's id for this request>
-- accepted: queued by Apple, not seen by anyone

HTTP/2 410
{"reason": "Unregistered"}
-- the token is dead: delete it, go to the SMS step now

HTTP/2 429
{"reason": "TooManyRequests"}

HTTP/2 503
{"reason": "ServiceUnavailable"}
-- retry with backoff; a run of these opens the breaker`,
          note: 'Only the status decides what happens next; a 200 never stops the escalation timer.' },
      ],
      ways: [
        { name: 'HTTP/2', chosen: true, what: 'A POST to APNs over a long-lived HTTP/2 connection: priority 10, Time Sensitive, the alert id as collapse id, and an expiry at the end of the hold. FCM gets the same message at high priority.',
          pros: [
            'Priority 10 sends at once.',
            'The collapse id makes a duplicate replace the first, not stack.',
            'Many requests share one reused connection.',
          ],
          cons: [
            'A 200 means accepted, not seen.',
            'Connections and credentials to manage for each platform.',
          ] },
        { name: 'FCM for both platforms', what: 'The worker sends iOS pushes to FCM too, which passes them on to APNs.',
          pros: [
            'One API.',
            'One set of credentials.',
          ],
          cons: [
            'One more hop to Apple.',
            'Apple-only options through a translation layer.',
          ] },
        { name: 'A silent push that makes the app fetch', what: 'A push with nothing to show wakes the app, which fetches the alert and shows it itself.',
          pros: [
            'The alert text never passes through Apple or Google.',
            'The app shows the latest state.',
          ],
          cons: [
            'iOS may delay or skip it.',
            'FCM may lower high-priority messages that show nothing to normal priority.',
          ] },
      ],
      reply: {
        id: 'apnsres', label: '200 or 410',
        how: 'A status per request: 200 accepted, 410 the token is no longer valid, 429 too many requests, 5xx try again.',
        delivery: 'Accepted means queued by Apple or Google, not seen by a person.',
      },
    },
    {
      id: 'sms', from: 'workers', to: 'sms', d: 'M983,210 H1040 Q1050,210 1050,220 V390 Q1050,400 1060,400 H1110', label: 'SMS, call',
      mode: 'external', via: 'HTTPS', chip: 0.48, at: 'right',
      how: 'A request to the SMS provider with the text and a status callback address. The worker picks the provider by weight and by each provider\'s breaker.',
      delivery: 'At-least-once from the worker. A provider may also retry inside its own network.',
      alts: ['A direct connection to a mobile network, which only very large senders have.', 'A voice call first for very large amounts.'],
      examples: [
        { title: 'Request to an SMS provider (generic)', lang: 'http', code: `POST /messages HTTP/1.1
Host: sms-a.example
Authorization: Bearer <API key>
Content-Type: application/json

{
  "client_ref": "A-91:per_1101:sms:2",
  "to": "+447700900123",
  "sender": "YOURBANK",
  "text": "<the SMS text, next block>",
  "status_callback":
    "https://notify.bank.example/sms/status"
}

HTTP/1.1 202 Accepted

{ "message_id": "sms-a-55130", "status": "queued" }`,
          note: 'Field names are generic, not any provider\'s API; client_ref carries the job id so receipts can be matched.' },
        { title: 'The SMS text, and the call at 5 minutes', lang: 'text', code: `SMS, step 2 at 90 seconds, to the verified number:
  Your bank: a payment from your business account is on
  hold. Open the app to check it. We will never ask you to
  move money to another account.

Call, step 3 at 5 minutes, through the voice provider:
  "A payment from your business account is on hold.
   If you did not make it, press 1. Otherwise, open the
   app to confirm it."
  key 1 -> "not me", passed to the reply service`,
          note: 'No link, no code and no way to release money: a SIM swap would give the attacker this text.' },
        { title: 'Status callback (the reply: delivered)', lang: 'http', code: `POST /sms/status HTTP/1.1
Host: notify.bank.example
X-Signature: <provider's signature of the body>
Content-Type: application/json

{
  "message_id": "sms-a-55130",
  "client_ref": "A-91:per_1101:sms:2",
  "status": "delivered",
  "at": "2026-11-13T23:41:46Z"
}

HTTP/1.1 204 No Content`,
          note: 'Delivered means the carrier confirmed it; no callback within 60 seconds counts as unknown, not failed.' },
      ],
      ways: [
        { name: 'HTTPS', chosen: true, what: 'A request to the chosen provider with the text and a status callback address. The worker picks the provider by weight and by each provider\'s breaker.',
          pros: [
            'A plain API, easy to move between providers.',
            'Receipts come back by callback.',
          ],
          cons: [
            'Receipts can be late, out of order or missing.',
            'A provider may retry inside its own network, so a rare duplicate.',
          ] },
        { name: 'A direct connection to a mobile network', what: 'The bank connects to a mobile network itself instead of through an aggregator.',
          pros: [
            'One company fewer in the path.',
            'Receipts closer to the carrier.',
          ],
          cons: [
            'Only very large senders have one.',
            'Contracts and links per network to run.',
          ] },
        { name: 'A voice call first for very large amounts', what: 'For very large amounts, skip SMS and call straight away.',
          pros: [
            'The hardest step to ignore.',
            'Reaches an owner on any phone.',
          ],
          cons: [
            'A call at 23:40 for every large hold, mostly to honest owners.',
            'Costs more per attempt than SMS.',
          ] },
      ],
      reply: {
        id: 'dlr', label: 'delivered',
        how: 'The provider calls back as the message moves through its states: sent, delivered, undelivered, failed.',
        delivery: 'Callbacks may be late, out of order or missing, so a missing receipt is unknown, not failure.',
      },
    },
    {
      id: 'notify', from: 'push', to: 'phone', d: 'M1185,152 V74', label: 'alert',
      mode: 'external', via: 'push', chip: 0.5, at: 'right',
      how: 'Apple or Google delivers the notification over the phone\'s own connection to them, and the phone shows it on the lock screen with its two actions.',
      delivery: 'No promise. If the phone is offline, APNs stores one notification for the app, usually the latest.',
      alts: ['The app\'s own WebSocket, which reaches the phone only while the app is open.'],
      examples: [
        { title: 'On the lock screen', lang: 'text', code: `YOUR BANK                                    now
A payment of £4,800 to a new payee is on hold.
Was this you?

   [ Not me ]          [ Yes, it was me ]

No account number, no balance, no link.`,
          note: 'Time Sensitive lets it through the owner\'s Focus; collapse id A-91 means a duplicate replaces this one.' },
        { title: 'What the app gets when an action is tapped', lang: 'text', code: `action    NOT_ME          (runs only on an unlocked phone)
alert_id  A-91            (from the push payload)
then      POST /alerts/A-91/answer, signed by the bound key

action    YES_IT_WAS_ME   (opens the app)
then      strong authentication for £4,800 to pye_77310,
          then POST /alerts/A-91/answer`,
          note: 'The action names are the app\'s own, defined for category PAYMENT_HOLD; iOS hands the app the action and the payload.' },
      ],
      ways: [
        { name: 'push', chosen: true, what: 'Apple or Google delivers over the phone\'s own connection to them, and the phone shows the alert on the lock screen with its two actions.',
          pros: [
            'Wakes a locked phone.',
            'No connection for the bank to hold.',
          ],
          cons: [
            'No promise: it may be late or dropped.',
            'APNs stores only one notification per app for an offline phone.',
          ] },
        { name: 'The app\'s own WebSocket', what: 'The app\'s own connection to the bank carries the alert.',
          pros: [
            'Acknowledged by the app.',
            'Instant while the app is open.',
          ],
          cons: [
            'Reaches the phone only while the app is open.',
            'Does nothing for an owner who is asleep.',
          ] },
        { name: 'Background polling by the app', what: 'The app checks the inbox from time to time in the background.',
          pros: [
            'No push provider in the path.',
            'Picks up anything a push missed.',
          ],
          cons: [
            'The phone\'s operating system decides when background work runs, so it may be very late.',
            'Most checks find nothing.',
          ] },
      ],
    },
    {
      id: 'tap', from: 'phone', to: 'reply', d: 'M1110,46 H975', label: 'answer',
      mode: 'call', via: 'HTTPS', chip: 0.5, at: 'above',
      how: 'POST /alerts/{id}/answer from the app with the answer, signed by the device\'s bound key. "Yes" also carries a strong authentication result tied to the amount and payee.',
      delivery: 'Safe to repeat: keyed by alert id, so a second tap gets the first result.',
      alts: ['An SMS reply through the provider\'s webhook, accepted for "not me" only.', 'A key press on the voice call, also "not me" only.'],
      examples: [
        { title: 'Request ("Not me")', lang: 'http', code: `POST /alerts/A-91/answer HTTP/1.1
Host: api.bank.example
Authorization: Bearer <app session>
Device-Id: dev_ios_41a2
Device-Signature: <bound key's signature of the body>
Content-Type: application/json

{
  "answer": "not_me",
  "signed_at": "2026-11-13T23:43:05Z"
}`,
          note: 'The alert id in the path is the idempotency key, and the signature proves the answer came from the bound phone.' },
        { title: 'Response (the reply: blocked)', lang: 'http', code: `HTTP/1.1 200 OK
Content-Type: application/json

{
  "alert_id": "A-91",
  "result": "blocked",
  "payment": { "id": "pay_8KD3F2", "status": "rejected" },
  "cards": "frozen",
  "sessions_ended": 1,
  "shown": [
    "Your payment of £4,800 has been stopped.",
    "Your cards are frozen.",
    "Our fraud team will be in touch."
  ]
}`,
          note: 'A second tap, or a retried request, gets this same body back.' },
        { title: 'What "Yes, it was me" would carry', lang: 'http', code: `POST /alerts/A-91/answer HTTP/1.1
Device-Id: dev_ios_41a2
Device-Signature: <bound key's signature of the body>

{
  "answer": "yes",
  "sca": {
    "amount_pence": 480000,
    "payee_id": "pye_77310",
    "auth_code": "<code bound to this amount and payee>"
  }
}`,
          note: 'Dynamic linking: the code is specific to £4,800 and pye_77310, so changing either invalidates it.' },
      ],
      ways: [
        { name: 'HTTPS', chosen: true, what: 'POST /alerts/{id}/answer from the app, signed by the device\'s bound key. "Yes" also carries a strong authentication result tied to the amount and payee.',
          pros: [
            'Signed by the bound device, so it comes from the owner\'s phone.',
            'Keyed by alert id, so a second tap gets the first result.',
            'Can carry a release with strong authentication.',
          ],
          cons: [
            'Needs data and the app.',
            'The bound key must be kept safe on the device.',
          ] },
        { name: 'An SMS reply', what: 'The owner replies to the SMS and the provider\'s webhook brings it to the reply service.',
          pros: [
            'Works without data or the app.',
            'Reaches an owner whose push token is dead.',
          ],
          cons: [
            'Accepted for "not me" only.',
            'A SIM swap gives the attacker the owner\'s texts.',
          ] },
        { name: 'A key press on the voice call', what: 'During the call the owner presses a key to say "not me".',
          pros: [
            'Works on any phone.',
            'Reaches someone who ignores texts.',
          ],
          cons: [
            '"Not me" only.',
            'Customers are rightly wary of calls that claim to be the bank.',
          ] },
      ],
      reply: {
        id: 'done', label: 'blocked',
        how: 'What happened, in plain words: payment stopped, cards frozen, what to do next.',
        delivery: 'Shown in the app, and repeated in the inbox.',
      },
    },
    {
      id: 'apply', from: 'reply', to: 'payments', d: 'M825,46 H495 Q485,46 485,56 V180 Q485,190 475,190 H420', label: 'block or release',
      mode: 'call', via: 'gRPC', chip: 0.2, at: 'below',
      how: 'Reject(payment, reason) and FreezeCards(account), or Release(payment, authentication result). Each carries the alert id as its idempotency key.',
      delivery: 'Safe to repeat. A payment that is no longer held, because it expired or someone else already answered, returns its current state.',
      alts: ['Publishing the answer as an event that the payment service consumes, which is simpler to scale but slower to confirm to the owner.'],
      examples: [
        { title: 'Service definition', lang: 'proto', code: `service PaymentService {
  rpc Reject(RejectRequest) returns (PaymentState);
  rpc FreezeCards(FreezeCardsRequest) returns (CardsState);
  rpc Release(ReleaseRequest) returns (PaymentState);
}
message RejectRequest {
  string payment_id = 1;
  string reason = 2;
  string idempotency_key = 3;   // the alert id
}
message FreezeCardsRequest {
  string account_id = 1;
  string idempotency_key = 2;   // the alert id
}
message ReleaseRequest {
  string payment_id = 1;
  bytes sca_result = 2;         // tied to amount and payee
  string idempotency_key = 3;   // the alert id
}
message PaymentState {
  string payment_id = 1;
  string status = 2;            // held, rejected, sent
  int64 version = 3;
}
message CardsState { string account_id = 1; bool frozen = 2; }` },
        { title: 'Example call (the reply: blocked)', lang: 'text', code: `Reject { payment_id: "pay_8KD3F2", reason: "owner_not_me",
         idempotency_key: "A-91" }
-> { payment_id: "pay_8KD3F2", status: "rejected", version: 3 }

FreezeCards { account_id: "acc_51207", idempotency_key: "A-91" }
-> { account_id: "acc_51207", frozen: true }

the same Reject again, key A-91:
-> { payment_id: "pay_8KD3F2", status: "rejected", version: 3 }
   the first result; nothing is applied twice`,
          note: 'Version 3 leaves through the outbox as event pay_8KD3F2:3, payment.rejected, which is how the alert service hears of it.' },
      ],
      ways: [
        { name: 'gRPC', chosen: true, what: 'Reject and FreezeCards, or Release with the authentication result, each carrying the alert id as its idempotency key. The reply is the payment\'s new state.',
          pros: [
            'The owner sees "blocked" at once.',
            'Safe to repeat.',
            'The payment service stays the only writer of payment state.',
          ],
          cons: [
            'Needs the payment service up; if not, the answer is recorded and applied later.',
            'A synchronous link between two critical services.',
          ] },
        { name: 'The answer as an event', what: 'The reply service publishes the answer, and the payment service consumes it.',
          pros: [
            'Simpler to scale.',
            'The reply service never waits on payments.',
          ],
          cons: [
            'Slower to confirm to the owner.',
            'Another topic and consumer to run.',
          ] },
        { name: 'Write the payment row directly', what: 'The reply service updates the payment\'s state in the payment database itself.',
          pros: [
            'No hop and no API.',
            'Quick to build.',
          ],
          cons: [
            'Two writers to payment state, bypassing its rules.',
            'The change skips the outbox unless both services write it.',
          ] },
      ],
      reply: {
        id: 'applied', label: 'blocked',
        how: 'The payment\'s new state and the state of the cards.',
        delivery: 'The same change also goes out through the outbox, which is how the alert service hears of it.',
      },
    },
    {
      id: 'cases', from: 'store', to: 'ops', d: 'M585,475 H420', label: 'cases',
      mode: 'async', via: 'CDC', chip: 0.69, at: 'above',
      how: 'A change feed on the alert store turns alerts closed as "not me", expired without an answer, or sent to a vulnerable customer into cases.',
      delivery: 'At-least-once, keyed by alert id, so a replay finds the case already open.',
      alts: ['The alert service calling the case tool directly when it closes an alert.'],
      examples: [
        { title: 'Change event on the alerts table', lang: 'json', code: `{
  "table": "alerts",
  "op": "update",
  "before": { "alert_id": "A-91", "status": "delivered" },
  "after": {
    "alert_id": "A-91",
    "status": "answered",
    "answer": "not_me",
    "payment_id": "pay_8KD3F2",
    "account_id": "acc_51207"
  },
  "committed_at": "2026-11-13T23:43:06Z"
}`,
          note: 'A generic change event: answered with "not me" is one of the three changes that open a case.' },
        { title: 'Case opened', lang: 'text', code: `opens a case when an alert is answered "not me", expires
unanswered, or went to a customer flagged as vulnerable

case      case-A-91   (one per alert: a replay finds it open)
queue     fraud operations
timeline  from alert_events for A-91:
  23:40:12  payment held, alert opened
  23:40:13  push accepted by APNs
  23:41:46  SMS delivered
  23:43:05  "not me" from dev_ios_41a2
  23:43:06  payment rejected, cards frozen`,
          note: 'The case carries the same timeline the owner saw, so nobody has to rebuild it.' },
      ],
      ways: [
        { name: 'CDC', chosen: true, what: 'A change feed on the alert store turns alerts closed as "not me", expired, or sent to a vulnerable customer into cases, keyed by alert id.',
          pros: [
            'A replay finds the case already open.',
            'The alert service never calls the case tool.',
          ],
          cons: [
            'A feed consumer to run.',
            'Seconds of delay.',
          ] },
        { name: 'The alert service calls the case tool', what: 'When it closes an alert, the alert service calls the case tool directly.',
          pros: [
            'No change feed.',
            'The case opens at once.',
          ],
          cons: [
            'A dual write: the alert can close without its case.',
            'The alert service depends on the case tool.',
          ] },
        { name: 'A scheduled query', what: 'A job every few minutes queries the alert store for alerts that need a case.',
          pros: [
            'Plain SQL.',
            'Easy to change what qualifies.',
          ],
          cons: [
            'Late by up to the interval.',
            'Must track what it has already seen.',
          ] },
      ],
    },
    {
      id: 'redrive', from: 'store', to: 'queue', d: 'M725,475 H890 Q900,475 900,465 V372', label: 'redrive',
      mode: 'async', via: 'sweeper', chip: 0.3, cold: true,
      how: 'Off the hot path. Every minute a sweeper reads alerts whose next step is overdue (a timer missed during a deploy, or a job lost to a bug) and enqueues the step again. The dedup keys make it safe.',
      delivery: 'Repeatable. It only enqueues steps that have no recorded result.',
      alts: ['A workflow engine\'s durable timers, which do this for you.', 'Trusting the timers, and finding out from a complaint.'],
      examples: [
        { title: 'Sweeper query, every minute', lang: 'sql', code: `SELECT a.alert_id, a.created_at, a.next_step
  FROM alerts a
 WHERE a.status IN ('open', 'sent', 'delivered')
   AND a.next_step_at < now() - interval '10 seconds'
   AND NOT EXISTS (
         SELECT 1
           FROM alert_events e
          WHERE e.alert_id = a.alert_id
            AND e.alert_created_at = a.created_at
            AND e.step = a.next_step)
 ORDER BY a.next_step_at
 LIMIT 500;`,
          note: 'Only steps with no recorded event come back, which is what makes running it twice safe.' },
        { title: 'If the step 2 timer for A-91 were missed', lang: 'text', code: `23:41:42  next_step_at passes; a deploy is running,
          nothing fires
23:42:00  the sweeper finds A-91, step 2, no event yet
          -> sends.p0, key A-91,
             job A-91:per_1101:sms:2 (the same job id)

if the first job went out after all, the worker finds
dedup:A-91:per_1101:sms:2 already set and sends nothing`,
          note: 'The job id is rebuilt from the alert, person, channel and step, so the sweeper\'s copy hits the same dedup key.' },
      ],
      ways: [
        { name: 'sweeper', chosen: true, what: 'Every minute a sweeper reads alerts whose next step is overdue and enqueues that step again. The dedup keys make it safe.',
          pros: [
            'Catches timers missed in a deploy and jobs lost to a bug.',
            'Simple, and safe to run twice.',
          ],
          cons: [
            'Up to a minute late.',
            'A query on the alert store every minute.',
          ] },
        { name: 'A workflow engine\'s durable timers', what: 'Each alert\'s ladder runs in a workflow engine, whose timers fire even after a crash.',
          pros: [
            'Durable timers built in.',
            'No sweeper to write.',
          ],
          cons: [
            'Another platform on the P0 path.',
            'Some latency per step.',
          ] },
        { name: 'Trust the timers', what: 'No sweeper: the alert service\'s own timers are the only thing that moves the ladder.',
          pros: [
            'Nothing to build.',
            'No extra load on the store.',
          ],
          cons: [
            'You find out from a complaint.',
            'A missed step means an owner never hears about a held payment.',
          ] },
      ],
    },
  ],

  tour: [
    {
      title: 'A payment from a new browser',
      text: "23:40 on a Friday. Someone signs in to a café's business account from a browser it has never used. They ask the Payment service to send £4,800 by Faster Payments, the UK's near-instant bank transfer, to a payee added two minutes earlier. A Faster Payment cannot be cancelled once sent, so any check has to happen now, before the bank submits it.",
      focus: ['payer', 'payments'],
      path: ['pay'],
      labels: ['£4,800 FPS'],
      story: {
        context: "A session on the café's account, acc_51207, comes from a browser the bank has never seen, dev_web_9c1e. It added payee pye_77310 two minutes ago and now sends POST /payments for £4,800 by Faster Payments, with an idempotency key, the payee, the amount and the device.",
        problem: "To the server, someone with stolen sign-in details looks exactly like the owner. Faster Payments usually arrive in seconds and cannot be cancelled once sent, so after submission there is no undo.",
        consequence: "If the money goes and this is fraud, £4,800 is gone from the café, and all that is left is recovery and reimbursement. If the bank stops every payment like this one, honest owners paying a new supplier late at night are stopped too.",
        fix: "Check before submitting. The Payment service answers the browser at once with 202 and status \"pending\", keeps the payment unsent and asks the risk engine for a verdict. The cost is a check inside every outbound payment.",
      },
      explain: [
        { q: "What is Faster Payments?", a: "The UK's near-instant bank transfer system, run by Pay.UK. Money usually arrives in seconds, occasionally up to two hours later. Once sent, a Faster Payment cannot be cancelled." },
        { q: "Who is the Payer?", a: "Whoever asks the bank to move money: a person in the app or on the web, or an accounting tool through the API. Here it is someone signed in from a browser this business has never used. It may be the owner, or a fraudster with stolen sign-in details." },
        { q: "Why does a new browser matter?", a: "The owner's phone was bound to the account when the app was set up, and the bank knows the devices it has seen. A browser never seen before, with a payee added two minutes earlier, is the usual sign of an account takeover: someone else signed in as the customer." },
        { q: "What does the Payment service receive?", a: "A POST /payments request over HTTPS: account acc_51207, payee pye_77310, 480000 pence, scheme FPS and the browser's device id. It carries an idempotency key chosen by the client, so sending it again returns the same payment, pay_8KD3F2, never a second one." },
        { q: "What does \"submit\" mean here?", a: "Hand the payment to the Faster Payments scheme, so the money leaves for the payee's bank. Until the Payment service submits it, nothing has moved and the payment can still be held or rejected." },
      ],
    },
    {
      title: 'Read the features, count this payment',
      text: "The Payment service asks the Risk engine for a verdict and will wait at most 150 ms. The engine needs the account's recent activity (its features), kept in the Feature store, an in-memory database. In one request it reads them and counts this payment in the same step: three new payees in ten minutes, the first payment after 23:00 this year, a device and a country never seen.",
      focus: ['payments', 'risk', 'features'],
      path: ['score', 'feat', 'featvals'],
      labels: ['score?', 'features?', 'velocity'],
      story: {
        context: "pay_8KD3F2 is held back, unsent. The Payment service calls the Risk engine's Score method over gRPC with the payment, account, device and payee, and a deadline of 150 ms. Before it can score, the engine needs the account's features.",
        problem: "The strongest sign of a taken-over account is speed: several new payees and a large amount within minutes. A count that leaves out the payment being scored, or one updated by a job a few seconds later, sees a quiet account. Two payments at the same moment could each miss the other.",
        consequence: "A fraudster's second and third payments would be scored as if the first had not happened, and the account would look normal until it was empty. A slow read would also eat the 150 ms budget and delay every payment in the bank.",
        fix: "Each account's features sit in one Redis hash. The engine runs one short script that reads the hash and adds this payment to the short-window counters as one atomic step, with a timeout of about 10 ms. Anything not back in time is marked missing, never zero. The cost is a store on the payment path, and counters to rebuild from a day of payment events if they are lost.",
      },
      explain: [
        { q: "What is a feature?", a: "A fact about the account that the engine scores with: payments and amounts in the last hour and day, new payees, usual hours, devices and countries seen. Short-window counts like these are called velocity features." },
        { q: "What is the 150 ms budget?", a: "The longest the Payment service waits for a verdict, at the 99th percentile: 99 calls in 100 must finish within it. Features take about 10 ms and the model about 20 ms, leaving about 120 ms for the network, the rules and logging." },
        { q: "What is the Feature store?", a: "A Redis database: Redis keeps its data in memory, so reads are fast. Each account's features are one Redis hash, a small set of named fields under one key, here feat:acc_51207." },
        { q: "What does \"one round trip\" mean?", a: "One request from the Risk engine to the Feature store and one reply. The engine runs one stored script that reads the hash and increments pays_1h, sent_today_pence and late_pays_ytd, instead of one call per feature." },
        { q: "Why count the payment in the same step?", a: "So the counts include the payment being scored. Redis runs the script as one step with nothing in between, so two payments at the same moment both count." },
        { q: "What if the Feature store is slow?", a: "The call has a timeout of about 10 ms. Features that did not come back are listed as missing, never returned as zero, so a gap cannot make the account look quiet." },
      ],
    },
    {
      title: 'Hold, do not block',
      text: "Inside the Risk engine a model gives the payment a fraud score and rules turn the score into an action. Blocking is wrong if it really is the owner, and allowing it cannot be undone. So the action is hold, and ask the owner. The person at the browser sees only \"pending\". Since 30 October 2024 UK banks may delay a payment they reasonably suspect for up to four business days, if they tell the payer why.",
      focus: ['risk', 'payments', 'payer'],
      path: ['verdict', 'payres'],
      labels: ['hold', 'pending'],
      story: {
        context: "The engine has the features. Its model gives a score of 0.93 with the reasons new_device, new_payee_velocity and unusual_hour. Its rules turn the score and the context into one of four actions: allow, warn, hold or block.",
        problem: "On this page's numbers at most 1 alert in 20 is fraud, so most flagged payments come from honest owners. The session asking may be the fraudster's, so a warning in the browser proves nothing: they would confirm it themselves.",
        consequence: "Block everything suspicious and honest businesses miss supplier payments. Allow it and £4,800 may be gone for good. Ask the browser and the attacker answers.",
        fix: "The engine returns HOLD, with its reasons and the model and rule versions that decided, and logs the decision with its inputs so it can be replayed. The Payment service keeps the payment unsent and tells the browser only \"pending\". The cost is a wait for an honest owner, and a promise to get an answer before the hold expires.",
      },
      explain: [
        { q: "What are the model and the rules?", a: "The model is a program trained on past payments with known outcomes; it turns the features into one fraud score, here 0.93. Rules are written by people and turn the score and context, such as a new payee and a new device, into an action. Rules can change on the day a new scam appears, without retraining." },
        { q: "What is a hold?", a: "A state on the payment: it is kept, nothing is submitted to Faster Payments, and it waits for an answer. A release submits it. A hold that expires is rejected, not released." },
        { q: "Why hold rather than block?", a: "It may really be the owner: on this page's numbers at most 1 alert in 20 is fraud. A block stops an honest business paying its supplier, while a hold only delays it until the owner says yes." },
        { q: "What does the person at the browser see?", a: "The reply to their request: 202 Accepted, status \"pending\", \"We are checking this payment.\" They are not told it is suspected, because they may be the fraudster." },
        { q: "What is the payment delay rule?", a: "A UK rule in force since 30 October 2024 (FCA guidance FG24/6). A bank with reasonable grounds to suspect fraud may delay an outbound payment until the end of the fourth business day after the order, and must tell the payer about the delay, the reason and what is needed." },
        { q: "When does this hold expire?", a: "At 23:59:59 on 19 November, the hold_expires_at the Payment service writes in the next step. If nobody has answered by then, the payment is rejected." },
      ],
    },
    {
      title: 'Publish the hold exactly when it commits',
      text: "The Payment service saves two things in one database transaction, so both are saved or neither is: the payment's new state, held, and an outbox row, a note of the event to announce. Change data capture (CDC), which reads the database's own change log, then publishes the row to payment-events, a Kafka log that keeps each account's events in order. So no payment is held without its event, or the other way round.",
      focus: ['payments', 'txlog'],
      path: ['outbox'],
      labels: ['payment held'],
      story: {
        context: "The Payment service has the verdict, HOLD. It must change pay_8KD3F2 from pending to held, and tell the rest of the bank, the Alert service among them.",
        problem: "Saving the state and sending a message touch two systems. Done as two steps (a dual write), a crash between them leaves the two disagreeing: a held payment with no message, or a \"held\" message for a hold that never saved.",
        consequence: "A held payment nobody hears about sits until it expires, and an honest owner's payment is rejected without a word. A message for a hold that never committed sends a false alarm. Neither shows up without comparing both systems.",
        fix: "One transaction updates the payment (status held, version 2, hold_expires_at 23:59:59 on 19 November, only if it is still pending at version 1) and inserts outbox row pay_8KD3F2:2, payment.held. CDC reads the committed row from the database log and publishes it to payment-events with key acc_51207. The cost is a connector to run, and an alarm on the age of the oldest unpublished row.",
      },
      explain: [
        { q: "What is a database transaction?", a: "A group of writes the database saves all together or not at all. If the machine crashes halfway, none of them is kept." },
        { q: "What is the outbox?", a: "A table in the payment database where the service writes each event it wants to announce, in the same transaction as the change itself. Something else publishes the rows, so the Payment service only ever writes to its own database." },
        { q: "What is change data capture?", a: "A connector that reads the database's own change log, the record the database keeps of every committed change, and turns each new outbox row into a message. The code that writes payments does not change." },
        { q: "What are Kafka and payment-events?", a: "Kafka is a message log: it stores messages in order and lets many readers each read at their own pace. payment-events is the log (a topic) of every payment state change, kept for a week, read by alerts, statements, analytics and fraud labels." },
        { q: "What does \"keyed by account\" mean?", a: "Each message carries the account id, acc_51207, as its key, and the key picks the partition, one ordered part of the log. All of one business's events land on one partition, so a reader never sees \"rejected\" before \"held\"." },
        { q: "Can the event be published twice?", a: "Yes: CDC can publish and crash before it records that it did. The event id is the payment id and its version, pay_8KD3F2:2, the same both times, so readers drop the repeat." },
      ],
    },
    {
      title: 'An alert with a stable id',
      text: "The Alert service reads the held event from payment-events. It names the alert with a hash, a code always worked out the same way from the payment id and the reason (shown here as A-91), so if the log delivers the event twice, the second copy finds the alert already there and does nothing. Severity is high, because money is waiting.",
      focus: ['txlog', 'alerts'],
      path: ['consume'],
      labels: ['held event'],
      story: {
        context: "Event pay_8KD3F2:2, payment.held, is on payment-events in acc_51207's partition. The Alert service's consumer group reads it. It acts on held, blocked, released and card frozen, and ignores created and sent.",
        problem: "Kafka delivers at least once. If the Alert service crashes after writing the alert but before recording its place in the log (committing its offset), it reads the same event again after a restart.",
        consequence: "Each re-read would make a new alert and a new set of messages: the owner gets several copies at 23:40, and the bank has several records of one hold.",
        fix: "The alert id is worked out from the event, not random: a hash of the payment id and the reason. A second copy gives the same id, A-91, finds the alert written, and only re-queues any send not marked done. The offset is committed only after the alert is written and its sends are queued. The cost is ids that must be designed to come out the same every time.",
      },
      explain: [
        { q: "What is the Alert service?", a: "The part of the notification platform that turns a \"payment held\" event into an alert. It asks who to tell, writes the alert, queues the sends and runs the escalation ladder. It owns the alert's states: open, sent, delivered, answered, expired." },
        { q: "What is a hash?", a: "A function that turns any input into a fixed-size value, always the same value for the same input. Hashing pay_8KD3F2 with \"payment.held\" always gives the same alert id, shown as A-91 on this page." },
        { q: "What are a consumer group and an offset?", a: "A consumer group is a named set of readers that share a topic; each partition is read by one of them. The offset is a reader's place in a partition, and committing it records \"read up to here\"." },
        { q: "Why commit the offset last?", a: "If the service crashes before the alert row and its jobs are written, the offset was not committed, so the event is read again. The alert id makes that second read harmless." },
        { q: "Why is severity high?", a: "Money is waiting on an answer. The alert is stored with category security and severity high, and its sends go on P0, the highest-priority queue." },
      ],
    },
    {
      title: 'Who to tell, and how',
      text: "The Alert service asks Preferences, which holds each business's people and their settings, who to tell. It returns a plan. The owner wants push first and has quiet hours from 22:00, but a security alert overrides quiet hours. The bookkeeper gets email only above £1,000, so she gets a copy, with no buttons as she cannot answer. Marketing opt-outs do not apply to security alerts.",
      focus: ['alerts', 'prefs'],
      path: ['resolve', 'plan'],
      labels: ['who, how?', 'owner, bookkeeper'],
      story: {
        context: "The Alert service has A-91 for business biz_3318. Before writing or sending anything it calls Preferences: Resolve(biz_3318, security, £4,800, 23:40:12), with a 50 ms timeout.",
        problem: "A small business has several people with different roles and settings: an owner, a director, a bookkeeper. The owner asked not to be disturbed after 22:00, and some people opt out of marketing. The bank still has a duty to warn, and only people with authority over the account may answer.",
        consequence: "Honour quiet hours here and the owner sleeps through a £4,800 fraud. Ignore everyone's settings and honest owners are woken for marketing too, or a bookkeeper with no authority is asked to release money.",
        fix: "Preferences applies the rules for the alert's category. The plan: the owner, per_1101, by push now, SMS at 90 seconds and a call at 5 minutes; the director, per_1103, by push at 10 minutes; the bookkeeper, per_1102, by email now, can_answer false. It names the override, and the plan is stored with the alert. If Preferences is down, the Alert service uses its cached plan or the mandatory default and records that it did. The cost is a network call on the alert path.",
      },
      explain: [
        { q: "What is Preferences?", a: "A service that answers \"who hears about this, on which channels, in what order, in which language\". It holds each business's people and roles, their channels and bound devices, thresholds, quiet hours and language, and applies the rules for the alert's category." },
        { q: "What is a category?", a: "The kind of message, such as security or marketing, each with its own rules. A security alert ignores quiet hours and marketing opt-outs and always includes the mandatory channels; marketing honours every opt-out." },
        { q: "What are quiet hours?", a: "Times a person asks not to be disturbed, here from 22:00 for the owner. The plan records the override, \"owner quiet hours from 22:00: category security\", so the audit shows why the owner was woken." },
        { q: "Why does the bookkeeper get no buttons?", a: "She has no authority over the account, so the plan marks her can_answer false and she gets an email copy to read. She gets it at all because her threshold is £1,000 and this payment is £4,800." },
        { q: "Where does the director come in?", a: "The plan puts the director on push at 10 minutes: the second contact on the ladder. That step runs only if the owner has not answered by then." },
        { q: "Why are marketing opt-outs ignored?", a: "A security alert is a service message, not marketing. Under PECR, the UK rules on electronic marketing, consent rules cover marketing, not service messages; adding promotion to an alert would make it marketing." },
      ],
    },
    {
      title: 'Write it down before sending',
      text: "Before anything is sent, the Alert service writes the alert, its plan and the time of its next step into the Alert store, a PostgreSQL database. This row is what the app's inbox will show and the start of the audit trail, the record of what the bank said and when. The escalation timer is that next-step time, a column on the row, so it survives a restart.",
      focus: ['alerts', 'store'],
      path: ['record'],
      labels: ['alert A-91'],
      story: {
        context: "The Alert service has A-91 and its plan. Nothing has been sent yet.",
        problem: "A push may never arrive and an SMS can be lost. A timer kept only in the service's memory dies when the service restarts or is redeployed. And if a scam claim is disputed later, the bank must show exactly what it told the customer and when.",
        consequence: "Without a durable record the alert can vanish: no inbox entry, no escalation after a restart, no evidence. Under the reimbursement rules, a bank that refuses a claim for gross negligence must prove it, often by showing the customer ignored a specific warning.",
        fix: "One insert: alert A-91, created 23:40:12, payment pay_8KD3F2, category security, severity high, status open, the plan as JSON, next step 2 at 23:41:42. ON CONFLICT DO NOTHING, so a second copy of the event inserts nothing. Later steps add event rows keyed by alert and step. The cost is a database write per step, and a poll on the store every second.",
      },
      explain: [
        { q: "What is the Alert store?", a: "The durable record of every alert: what caused it, who it went to, each delivery attempt and receipt, and the answer. It is a PostgreSQL database, a relational database queried with SQL, with tables partitioned by month." },
        { q: "What is the inbox?", a: "The list of alerts the app shows, read from the Alert store. An alert missed on the lock screen is waiting there when the app opens, and an open app gets new alerts at once over its own connection (a WebSocket)." },
        { q: "What is the audit trail?", a: "The record of what was decided, sent, delivered and answered, with times and devices. It is the evidence when a reimbursement claim or a complaint turns on what the bank said." },
        { q: "How can a timer be a column?", a: "The row stores next_step_at, here 23:41:42, 90 seconds after the alert. Every second the Alert service looks for rows whose time has passed and takes the next step, so a restart loses nothing." },
        { q: "Why write before sending?", a: "So every send has an inbox entry, a timer and a record behind it. The one exception: if the store is down, P0 sends go anyway and the record is written when it returns, because reaching the owner comes first." },
      ],
    },
    {
      title: 'Jump the queue',
      text: "The Alert service puts one send job per person and channel on the P0 topic, the top-priority queue. A marketing campaign of a million messages may be going out on P3, the lowest priority, right now, but it has its own topic and its own workers, so it cannot get in front. Each job carries a dedup key (alert, person, channel, step), so a job delivered twice is sent once.",
      focus: ['alerts', 'queue', 'workers'],
      path: ['enqueue', 'jobs'],
      labels: ['P0 push job'],
      story: {
        context: "The alert is written. Step 1 of the plan must go out now, at 23:40:12: push to the owner and an email copy to the bookkeeper.",
        problem: "A queue serves in arrival order. A campaign of a million messages in five minutes is over 3,000 a second, and a fraud alert behind it would wait minutes. Kafka also delivers at least once, so a job can arrive twice.",
        consequence: "The owner hears minutes late while the attacker is still signed in, or gets the same alert twice and learns to ignore the bank's alerts.",
        fix: "Four topics, P0 security to P3 marketing, each with its own consumer groups, workers and quota with each provider. A-91's jobs go on sends.p0, keyed by alert id so one alert's steps stay in order: A-91:per_1101:push:1 and A-91:per_1102:email:1. Each carries its dedup key, template, language and an expiry at the end of the hold. The cost is more topics to run, and P0 workers mostly idle at about 25,000 sends a day.",
      },
      explain: [
        { q: "What is a send job?", a: "One instruction to send one message to one person on one channel, such as A-91:per_1101:push:1: push to the owner, step 1. It carries the template, the language, the device and an expiry." },
        { q: "What are P0 to P3?", a: "Four priorities, each its own Kafka topic: P0 security (fraud holds, new-device sign-ins, one-time passcodes), P1 transactional, P2 product, P3 marketing. P0 is sized for 500 sends a second." },
        { q: "Why not one queue with a priority field?", a: "Kafka reads a partition in order, whatever the messages say. A P0 message behind a million P3 messages still waits for them, so priority has to be separate topics with separate workers." },
        { q: "What is a dedup key?", a: "Alert id, person, channel and step, such as A-91:per_1101:push:1. A worker sets it just before sending; a second job with the same key finds it set and sends nothing." },
        { q: "Why does a job expire?", a: "Its expiry is the end of the hold, 23:59:59 on 19 November. A fraud alert after the hold has ended only confuses people, so an expired job is dropped." },
      ],
    },
    {
      title: 'Push at priority 10',
      text: "A Channel worker sets the dedup key and posts to APNs, Apple's push service, at priority 10 (send now) as Time Sensitive, which breaks through the phone's Focus mode. The lock screen says a payment of £4,800 to a new payee is on hold: was this you? No account number, no link. APNs answers 200, which means accepted, not seen. The owner is asleep.",
      focus: ['workers', 'push', 'phone'],
      path: ['apns', 'notify'],
      labels: ['priority 10', 'Was this you?'],
      story: {
        context: "The push worker takes A-91:per_1101:push:1 from sends.p0 at 23:40:12. The owner's bound phone is an iPhone, dev_ios_41a2.",
        problem: "Only Apple's and Google's push services can wake a locked phone, and both are best effort: APNs may reorder, throttle or drop, and keeps only one notification per app for an offline phone. A 200 means Apple accepted it, not that anyone saw it. And anyone holding the phone can read the lock screen.",
        consequence: "If the bank took \"accepted\" as \"seen\", it would stop trying while the owner sleeps. If the notification showed account details or a link, it would help the next scam.",
        fix: "The worker sets dedup:A-91:per_1101:push:1 with an atomic set-if-absent, then posts over a long-lived HTTP/2 connection: priority 10, time-sensitive, collapse id A-91 so a duplicate replaces the first, and an expiry at the end of the hold. It publishes \"accepted, 200\" to the status topic, and the 90-second timer keeps running. The cost is a first step that may not have worked.",
      },
      explain: [
        { q: "What are APNs and FCM?", a: "Apple Push Notification service and Firebase Cloud Messaging, Google's equivalent. They are the only way to wake a locked phone: the bank sends the message to them, and they deliver it over the phone's own connection." },
        { q: "What does priority 10 mean?", a: "An APNs setting: 10 sends at once, 5 sends based on the phone's power state. An Android phone gets the same message through FCM at high priority, which can wake a sleeping device." },
        { q: "What are Time Sensitive and Focus?", a: "Focus is an iPhone mode that silences notifications, for example at night. Time Sensitive is a notification level that breaks through it; Apple names an account security issue as an example of when to use it." },
        { q: "What does the 200 mean?", a: "Apple's reply: the request was accepted and queued. It does not mean the phone got it or that anyone saw it, so a 200 never stops the escalation timer." },
        { q: "What is a collapse id?", a: "An id that makes a later notification replace an earlier one on the phone. It is the alert id, A-91, so a rare duplicate replaces the first instead of stacking." },
        { q: "Why no link or account number?", a: "Anyone holding the phone can read the lock screen, and fake bank messages with links are a common scam. The alert says only what is on hold, with two actions: \"Not me\" and \"Yes, it was me\"." },
      ],
    },
    {
      title: 'No answer: escalate to SMS',
      text: "Ninety seconds pass with no answer. The timer on the alert row fires and the Alert service queues step two: an SMS, through one of two SMS providers, to the owner's verified number, saying a payment is on hold and to open the app. It has no link and no code. The provider reports it delivered. Next would come a call, then the director.",
      focus: ['alerts', 'queue', 'workers', 'sms'],
      path: ['enqueue', 'jobs', 'sms', 'dlr'],
      labels: ['step 2', 'SMS job', 'SMS', 'delivered'],
      story: {
        context: "It is 23:41:42, A-91's next_step_at. The push was accepted, but nobody has answered.",
        problem: "The owner may be asleep, the phone offline, or the push dropped. SMS reaches a phone with no data and no app, but whoever has taken over the owner's number by a SIM swap reads the texts too. Delivery reports can be late, out of order or missing.",
        consequence: "Stop at push and a sleeping owner may not hear until the hold expires: a fraud goes unconfirmed, or an honest payment is rejected. Put a link or a code in the SMS and a SIM swap or a fake bank text turns the alert into the scam.",
        fix: "The poll finds A-91 due and puts A-91:per_1101:sms:2 on sends.p0. The SMS worker picks provider sms-a by weight and breaker, and sends the text with a callback address. sms-a reports \"delivered\" at 23:41:46, stored as an event for step 2. If nobody answers, the call comes at 5 minutes and the director's push at 10. The cost is a paid message, and \"delivered\" is not \"read\".",
      },
      explain: [
        { q: "What is the escalation ladder?", a: "The steps taken while nobody answers: push at once, SMS at 90 seconds, a call at 5 minutes, the director at 10 minutes, fraud operations at 30. Each step's time is stored on the alert row." },
        { q: "What makes the timer fire?", a: "The Alert service checks every second for alerts whose next_step_at has passed. A sweeper also runs every minute for steps a deploy or a bug missed; the dedup key makes its copy harmless." },
        { q: "Why two SMS providers?", a: "Two is the smallest number that survives one provider's outage. Traffic is weighted between them, each behind its own circuit breaker, and the worker picks one per message." },
        { q: "What does \"delivered\" mean?", a: "The provider calls the bank back to say the mobile network confirmed the message. It does not mean anyone read it, and no callback within 60 seconds counts as unknown, not failed." },
        { q: "What is a SIM swap?", a: "A fraudster moving the victim's phone number to their own SIM card, so texts and calls go to them. That is why the SMS carries no code or link, and an SMS reply can only block a payment, never release one." },
      ],
    },
    {
      title: 'The owner taps "Not me"',
      text: "The owner opens the app and taps \"Not me\". The Reply service checks the answer is signed by the owner's bound phone (tied to the account at set-up), the alert is still open, and no answer has been applied yet. Then it asks the Payment service to reject the payment, freeze the cards and end the unknown session. \"Yes\" would have needed a second check, such as a fingerprint, tied to the amount and payee.",
      focus: ['phone', 'reply', 'payments'],
      path: ['tap', 'apply', 'applied', 'done'],
      labels: ['Not me', 'block, freeze', 'blocked', 'blocked'],
      story: {
        context: "At 23:43:05 the owner, woken by the SMS, opens the app and taps \"Not me\" on A-91. The app sends POST /alerts/A-91/answer, signed by the phone's bound key.",
        problem: "The answer moves money, so it is as sensitive as a payment instruction. It could be forged, tapped twice, retried by the app, or race with another person's answer.",
        consequence: "A forged \"yes\" releases £4,800 to the fraudster. An answer applied twice could leave the payment's state confused, and a \"yes\" from someone without authority could release money they may not move.",
        fix: "The Reply service checks the signature from dev_ios_41a2, that A-91 is open, and that no answer is applied. It calls Reject(pay_8KD3F2, owner_not_me) and FreezeCards(acc_51207), both with A-91 as the idempotency key: the payment is rejected at version 3, the cards frozen, one session ended. A second tap gets the same reply. If two people disagree, any \"not me\" wins. The cost is a service on the path of every answer.",
      },
      explain: [
        { q: "What is the Reply service?", a: "The one place every answer arrives: from a notification action, the app, an SMS or a call. It checks who is answering, that the alert is open and not yet answered, then tells the Payment service what to do." },
        { q: "What does the bound phone's signature prove?", a: "At set-up the app made a key held on the phone and registered it with the bank (device binding). An answer signed with it comes from dev_ios_41a2, the owner's phone, not from the browser where the fraudster is signed in." },
        { q: "What is an idempotency key?", a: "An id sent with a request so that repeating it has no further effect. The alert id, A-91, is the key: the same Reject sent again returns \"rejected, version 3\" and nothing is applied twice." },
        { q: "Why is \"Not me\" one tap and \"Yes\" not?", a: "A wrong \"not me\" only delays a payment; a wrong \"yes\" loses the money. So \"Yes\" opens the app and needs strong customer authentication with a code tied to £4,800 and pye_77310; changing either invalidates it (dynamic linking)." },
        { q: "What is strong customer authentication?", a: "Two independent factors out of something you know, something you have and something you are, such as the bound phone and a fingerprint. Releasing a held payment is treated as a payment instruction, so it needs it." },
        { q: "Who changes the payment?", a: "Only the Payment service. The Reply service asks it over gRPC and never writes the payment row itself, so the change also goes out through the outbox." },
      ],
    },
    {
      title: 'Close the loop',
      text: "The block is a change to the payment's state, so the Payment service announces it through the same outbox and payment-events log. The Alert service reads it, cancels the call and the director's push, marks the alert answered and sends a short confirmation. The timeline stays in the Alert store for the inbox and the audit, and a case opens for Fraud operations, the bank's team for fraud cases.",
      focus: ['payments', 'txlog', 'alerts', 'store', 'ops'],
      path: ['outbox', 'consume', 'record'],
      labels: ['blocked', 'close alert', 'answered'],
      branch: { path: ['cases'], label: 'case' },
      story: {
        context: "pay_8KD3F2 is rejected at version 3 and the cards are frozen. A-91 still has steps waiting: the call at 5 minutes and the director's push at 10.",
        problem: "The Alert service only knows what it reads. If it never heard of the block, its timers would carry on: a call to the owner and a push to the director about a payment already stopped. And a confirmed fraud needs people: someone must chase the money and decide any claim.",
        consequence: "Calls and pushes after the answer annoy the owner and alarm the director for nothing. A fraud with no case means nobody asks the receiving bank to freeze the funds, and nobody can show later what happened.",
        fix: "The rejection commits with outbox event pay_8KD3F2:3, payment.rejected, on the same partition as the hold, so it is read after it. In one transaction the Alert service records the answer and sets next_step_at to NULL, which cancels the remaining steps. A change feed on the Alert store sees A-91 answered \"not me\" and opens case-A-91 with the timeline from 23:40:12 to 23:43:06. The cost is one more consumer, and seconds before the case opens.",
      },
      explain: [
        { q: "Why does the block go through the outbox again?", a: "Every change to a payment leaves through the outbox, whoever caused it. The Alert service hears of the block the same way it heard of the hold, and in order, because both are keyed by acc_51207." },
        { q: "How does a NULL cancel the call?", a: "The timer is the next_step_at column. With no time in it, the every-second check and the sweeper find nothing due for A-91, so the call and the director's push never happen." },
        { q: "What is a change feed?", a: "Change data capture on the Alert store: each committed change to the alerts table becomes a message. The update to \"answered, not_me\" is one of the three changes that open a case." },
        { q: "Which alerts become cases?", a: "Alerts answered \"not me\", alerts that expire with no answer, and alerts sent to a customer flagged as vulnerable. Each case carries the alert's full timeline, the same one the owner saw." },
        { q: "What does Fraud operations do?", a: "The bank's team that works fraud cases: asking the receiving bank to freeze funds, reporting to the police, and deciding reimbursement claims within 5 business days, or 35 at most if the bank stops the clock." },
      ],
    },
    {
      title: 'When APNs is failing',
      text: "Run it again with APNs, Apple's push service, returning errors. After a run of failures the push worker's circuit breaker opens: it stops calling APNs, and P0 jobs go straight to the next step on each owner's ladder, SMS, without waiting 90 seconds. The alert is still in the inbox. Push resumes when test requests succeed. A 410 reply, meaning one phone's push address is dead, works the same way for that phone.",
      focus: ['workers', 'push', 'sms'],
      path: ['apns', 'apnsres'],
      labels: ['push', '503'],
      pill: ['above', 'above'],
      branch: { path: ['sms'], label: 'SMS now' },
      story: {
        context: "The same night, with one change: APNs answers 503, ServiceUnavailable. The push worker's first try for A-91 fails, and so do its retries at about 1, 2 and 4 seconds.",
        problem: "Push is the first step for most owners. If every push job retried for about 7 seconds and then waited for the SMS step at 90 seconds, every owner would hear late, and the push pool would spend its time on calls that fail.",
        consequence: "Every held payment in the bank would wait at least 90 seconds longer for its owner, when speed matters most. Calling a failing provider over and over also slows its recovery.",
        fix: "A circuit breaker per provider counts failures. After a run of them it opens: workers stop calling APNs and fail fast, and P0 jobs go to each owner's next step, SMS, at once. The inbox still holds every alert. After a while the breaker lets a few test requests through, and push resumes when they succeed. A 410 for one dead token is handled the same way for that person. The cost is paid SMS for every alert while the breaker is open.",
      },
      explain: [
        { q: "What is a circuit breaker?", a: "A switch in the worker that counts failures for one provider. After a run of them it opens, and the worker stops calling and fails fast. After a while it lets a few test requests through, and closes when they succeed." },
        { q: "What do 503 and 410 mean?", a: "HTTP status codes from APNs. 503 ServiceUnavailable means try again later, and a run of them opens the breaker. 410 Unregistered means one device's token is dead: delete it and go to the SMS step now." },
        { q: "What is a device token?", a: "The address that identifies one app on one phone to APNs; the worker posts to /3/device/<token>. When APNs answers 410 for it, the token is no longer valid." },
        { q: "What are retries with backoff and jitter?", a: "Before the breaker opens, each P0 job tries 3 times, at about 1, 2 and 4 seconds, with a random part added so retries do not all arrive together. That is about 7 seconds, far inside the 90 before the SMS step." },
        { q: "Does this stop pushes to Android?", a: "No. There is a worker pool and a breaker per provider, so APNs failing does not open FCM's breaker." },
        { q: "Why does the inbox matter here?", a: "Push and SMS only get the owner to look. The alert is in the Alert store whatever happens to APNs, so it is there when the owner opens the app." },
      ],
    },
  ],

  brief: [
    {
      heading: 'Ask first',
      points: [
        'Which transactions? Outbound Faster Payments and card spend at least. Direct debits and incoming money are lower risk.',
        'Block, hold or just tell? A hold before the money moves is what makes "real-time" matter.',
        'Who are the users? A small business has several people: owner, directors, a bookkeeper, staff with cards. Who may answer?',
        'Which channels, and is there an app? Push, SMS, email, in-app, voice.',
        'What does "real-time" mean here? Ask for numbers, then propose them.',
        'How much of the time should go on detection? Usually the interviewer wants the notification system, with enough detection to be credible.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Decide in the payment path whether to allow, hold or block an outbound payment.',
        'Tell the right people on the right channels, by their preferences, with rules a security alert may override.',
        'Escalate when nobody answers: another channel, then another person, then a human team.',
        'Take the answer back, safely, and release or block the payment.',
        'Keep a record of every alert, attempt and answer, readable in the app and for an audit.',
      ],
    },
    {
      heading: 'How well (my targets)',
      points: [
        'Decision in the payment path: 150 ms at the 99th percentile.',
        'Event to push handed to Apple or Google: 2 seconds at the 99th percentile.',
        'No alert lost: every held payment ends answered, expired into a case, or released by a person.',
        'No owner gets the same alert twice on one channel.',
        'A marketing campaign never delays a security alert.',
        'Available 99.95 per cent, in two regions, failing safe: if in doubt, hold and tell.',
      ],
    },
  ],

  numbers: [
    { what: 'Businesses', assumption: 'a UK business bank of about a million small businesses (Tide had about 750,000 UK members in 2025)', result: '1 million businesses, about 1.4 million people, about 2 million devices' },
    { what: 'Payments scored', assumption: 'about 4 outbound payments and card spends a business a day', result: '4 million a day: about 46 a second on average, build for 1,000' },
    { what: 'Alerts', assumption: 'about 0.2 per cent of payments held or flagged', result: 'about 8,000 a day, about 1 a second at peak, bursts of 100 a second in an attack' },
    { what: 'How many alerts are fraud', assumption: 'about 1 in 10,000 transactions is fraud (Monzo\'s figure), and 1 in 500 is alerted', result: 'at most 1 alert in 20 is fraud, so "yes, it was me" must take one tap' },
    { what: 'P0 sends', assumption: 'about 1.5 people and 2 channel steps per alert', result: 'about 24,000, call it 25,000 a day: tiny, so latency is the design problem, not throughput' },
    { what: 'Everything else', assumption: 'a notification per payment, plus campaigns of a million in five minutes', result: 'about 5 million a day, and spikes over 3,000 a second on P3' },
    { what: 'Latency budget', assumption: 'score 150 ms, log and consumer under 1 s, push handed over under 1 s', result: 'event to push in under 2 s, escalation after 90 s' },
    { what: 'Storage', assumption: 'every notification at 1 KB, 1.5 attempts each', result: 'about 7.5 GB a day, 2.7 TB a year; fraud alerts alone are a rounding error' },
    { what: 'Feature store', assumption: 'about 1 KB of counters a business', result: 'about 1 GB in memory' },
  ],

  framings: [
    {
      name: 'Business bank, about a million businesses (this diagram)',
      scale: '4 million payments and 8,000 alerts a day',
      shape: 'A hold in the payment path, an outbox and a log, and a notification platform with preferences, priority queues, channel workers, escalation and a reply path. The hard parts are idempotency, escalation and what fails open.',
    },
    {
      name: 'An early start-up',
      scale: '10,000 businesses',
      shape: 'Rules in the payment service, an outbox table polled by one worker, a hosted notification service for push and SMS, preferences in the main database. Keep the alert id, the hold and the reply rules; buy the rest.',
    },
    {
      name: 'Alerts only, no holds',
      scale: 'card spend notifications and after-the-fact alerts',
      shape: 'The risk engine leaves the payment path and reads the log instead. Latency targets relax to seconds, and the reply path freezes cards rather than releasing payments. Much simpler, and too late for Faster Payments.',
    },
    {
      name: 'Consumer scale (Uber, LinkedIn)',
      scale: 'a billion or more notification requests a day',
      shape: 'Throughput, ranking and frequency caps dominate: which of many messages to send, when and on which channel. Security alerts become one small priority class that skips all of it.',
    },
  ],

  decisions: [
    { choice: 'Where the hold happens', a: 'In the payment service, before submission, with an in-line score.', b: 'After submission, from the log, alert only.', call: 'Before submission for Faster Payments, because they cannot be cancelled. After the fact for card spend notifications.' },
    { choice: 'How the alert is triggered', a: 'An outbox row published to a log keyed by account.', b: 'The risk engine calls the alert service.', call: 'The outbox. No dual write, order per account, replay.' },
    { choice: 'Delivery promise', a: 'At-least-once with a dedup key per person, channel and step.', b: 'Try for exactly-once end to end.', call: 'At-least-once. Exactly-once does not exist across Apple, Google and phone networks.' },
    { choice: 'Priority', a: 'A topic, workers and provider quota per priority.', b: 'One queue with a priority field.', call: 'Separate topics. A partition is read in order whatever its fields say.' },
    { choice: 'Preferences unavailable', a: 'Fail open: cached plan, then the mandatory default.', b: 'Fail closed: send nothing until settings load.', call: 'Fail open for security alerts, closed for marketing.' },
    { choice: 'Confirming the answer', a: 'One tap for "not me"; strong authentication for "yes".', b: 'The same check for both.', call: 'Asymmetric. A wrong block costs a delay; a wrong release costs the money.' },
    { choice: 'Build or buy the platform', a: 'Build the alert service and P0 path; buy SMS and voice.', b: 'A hosted notification platform for everything.', call: 'Build P0, buy commodity channels. P3 marketing can use a hosted tool.' },
  ],

  drills: [
    { name: 'APNs is failing or slow', what: 'The push breaker opens after a run of errors. P0 jobs go to the next step on each ladder at once, the inbox still holds every alert, and push resumes when test requests succeed.' },
    { name: 'The preference store is down', what: 'Fail open for security: use the cached plan, or the mandatory default of the owner\'s devices by push and verified mobile by SMS. Record that defaults were used. Marketing sends nothing.' },
    { name: 'The owner is offline', what: 'Push is stored by Apple for one notification only. The ladder moves to SMS, a call, then the director, then fraud operations. The payment stays held and is rejected if the hold expires.' },
    { name: 'Kafka is down', what: 'Holds still happen and outbox rows wait. Page at once, because people are not being told. The payment service caps holds without published events; past the cap it applies the stricter fallback policy.' },
    { name: 'The alert service crashes mid-send', what: 'The event offset was not committed, so it is read again. The alert id finds the existing alert, and dedup keys stop repeated sends. The sweeper catches steps whose timers were missed.' },
    { name: 'The risk engine times out', what: 'The payment service applies its fixed fallback by band and logs it. Large payments to new payees are held; small payments to known payees go through.' },
    { name: 'One SMS provider fails', what: 'Its breaker opens and traffic moves to the second provider. Undelivered receipts count as unknown, so the ladder carries on to a call.' },
    { name: 'An attack on 10,000 accounts in five minutes', what: 'Holds rise sharply. P0 is sized for 500 sends a second, provider quotas are reserved for it, and the action rate limit pages the fraud team, who may switch on a stricter rule for everyone.' },
    { name: 'A bad rule holds 20 per cent of payments', what: 'The action\'s rate limit trips, stops placing holds beyond it and pages. Roll back the rule; held payments are re-scored and released or alerted.' },
    { name: 'The feature store loses its data', what: 'Every account looks quiet. Rebuild counters from a day of the log, and until then treat missing features as risky for large payments to new payees.' },
    { name: 'A region fails', what: 'Payments and alerts fail over together, with the account partitioning intact. Dedup keys and alert ids are global, so sends retried in the other region do not repeat.' },
  ],

  interview: [
    'Open by splitting the problem: deciding a payment is suspicious, in the payment path, and telling the right people and getting their answer back. Say you will spend most time on the second, and ask whether that matches what they want.',
    'Pin "real-time" to numbers: a decision in 150 ms inside the payment, a push handed over within 2 seconds, escalation at 90 seconds. Mention that Faster Payments cannot be cancelled, which is why there is a hold at all.',
    'Do the sums in a minute: a million businesses, 4 million payments, 8,000 alerts a day. Throughput is tiny, so the problems are latency, reliability, duplicates and people.',
    'Draw the line: payment service, risk engine, outbox, log, alert service, preferences, priority queues, workers, Apple and Google and SMS, phone, reply service, back to payments.',
    'Go deep where seniority shows: the alert id and dedup keys; preferences with categories and overrides; the escalation ladder and its timers; provider failure and failing open.',
    'Raise the reply path yourself. The answer moves money, so it is authenticated, idempotent and asymmetric: one tap to block, strong authentication to release.',
    'Close with security and regulation: nothing sensitive on a lock screen or in an SMS, no links, service messages are not marketing, the reimbursement rules make speed and records matter. Then name what to measure.',
  ],

  sources: [
    { label: 'Hello Interview: Design a Notification System', href: 'https://www.hellointerview.com/learn/system-design/problem-breakdowns/notification-system', note: 'The interview framing: channel opt-outs and quiet hours, a million-message campaign in five minutes, and the deep dives on never dropping, priority during a blast, and duplicates. Most of the page is paid; only the outline was read.' },
    { label: 'Payment Systems Regulator: new protections for APP scam victims (2024)', href: 'https://www.psr.org.uk/news-and-updates/latest-news/news/groundbreaking-new-protections-for-victims-of-app-scams-start-today/', note: 'From 7 October 2024: up to £85,000, five business days, an optional £100 excess, Faster Payments and CHAPS, consumers, micro-enterprises and charities.' },
    { label: 'PSR: APP scams information sheet for payment firms', href: 'https://www.psr.org.uk/media/x4tji2en/psr-app-scams-psp-information-sheet-v3.pdf', note: 'The £85,000 limit per claim, claims within 13 months of the last payment, an excess of up to £100, and individuals, micro-enterprises and charities in scope.' },
    { label: 'PSR: new reimbursement requirement, policy overview (June 2023)', href: 'https://www.psr.org.uk/media/iinpeh1d/psr-app-fraud-new-reimbursement-requirement-high-level-policy-overview-june-2023-1.pdf', note: 'The 50:50 split between sending and receiving firms, five business days with stop the clock, gross negligence as an exception.' },
    { label: 'A&O Shearman: the UK APP fraud reimbursement scheme', href: 'https://www.aoshearman.com/en/insights/ao-shearman-on-fintech-and-digital-assets/the-uks-authorised-push-payment-app-fraud-reimbursement-scheme', note: 'A law firm summary: the limit cut from a proposed £415,000 to £85,000 before launch, exceptions to the 50:50 split, the consumer standard of caution, and gross negligence as a high bar the bank must prove.' },
    { label: 'FCA FG24/6: guidance on delaying payments', href: 'https://www.fca.org.uk/publication/finalised-guidance/fg24-6.pdf', note: 'In force 30 October 2024: delay until the end of the fourth business day, reasonable grounds by the end of the next business day, and telling the payer the delay, the reason and what is needed.' },
    { label: 'legislation.gov.uk: Payment Services (Amendment) Regulations 2024', href: 'https://www.legislation.gov.uk/uksi/2024/1013/pdfs/uksi_20241013_en.pdf', note: 'The law behind the payment delay: Regulation 86(2A) to (2D) of the 2017 regulations, in force 30 October 2024.' },
    { label: 'Pay.UK: how Faster Payments work', href: 'https://www.wearepay.uk/what-we-do/payment-systems/faster-payment-system/how-faster-payments-work/', note: 'Funds usually almost immediately, occasionally up to two hours; once sent a Faster Payment cannot be cancelled.' },
    { label: 'Pay.UK: £1 million Faster Payments now possible (2022)', href: 'https://newseventsinsights.wearepay.uk/media-centre/press-releases/1-million-faster-payments-now-possible/', note: 'The scheme limit rose from £250,000 to £1 million a payment; each bank sets its own lower limit.' },
    { label: 'Pay.UK: Confirmation of Payee FAQs', href: 'https://www.wearepay.uk/what-we-do/overlay-services/confirmation-of-payee/faqs/', note: 'The name check for new payees and changed details, its four answers (yes, close match, no, unavailable), and business accounts.' },
    { label: 'legislation.gov.uk: Regulation 260/2012, Article 2', href: 'https://www.legislation.gov.uk/eur/2012/260/article/2/data.htm?view=plain', note: 'The micro-enterprise definition: fewer than 10 people and turnover or balance sheet up to €2 million.' },
    { label: 'FCA Handbook: UK SCA-RTS Article 5, dynamic linking', href: 'https://handbook.fca.org.uk/technical-standards/s140c1225', note: 'The payer is made aware of the amount and payee, the code is specific to both, and any change to either invalidates it.' },
    { label: 'ICO: identify direct marketing', href: 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/identify-direct-marketing/', note: 'Service messages for administrative or customer service purposes are not direct marketing; adding promotion makes them marketing.' },
    { label: 'ICO: Amex fined for sending four million unlawful emails (2021)', href: 'https://ico.org.uk/about-the-ico/news-and-events/news-and-blogs/2021/05/amex-fined-for-sending-four-million-unlawful-emails/', note: '£90,000 for about 4.1 million marketing emails sent as service emails. Read through a reprint of the ICO release.' },
    { label: 'UK Finance: Annual Fraud Report 2026', href: 'https://www.ukfinance.org.uk/news-and-insight/press-release/fraud-report-2026-press-release', note: '2025: £1.28 billion stolen, £576.4 million by APP fraud of which £75.6 million non-personal.' },
    { label: 'Tide: over 1.5 million members (2025)', href: 'https://www.tide.co/blog/tide-update/tide-now-supports-over-1-5-million-small-businesses-globally/', note: 'About 750,000 UK members: the basis for the million-business estimate.' },
    { label: 'Monzo: building a reactive fraud prevention platform', href: 'https://monzo.com/blog/build-a-reactive-fraud-prevention-platform', note: 'Detectors, action controls and action selection as pure functions; just-in-time, near-real-time and batch features; rate limits on actions; about 1 fraud in 10,000.' },
    { label: 'Stripe: how we built Radar', href: 'https://stripe.dev/blog/how-we-built-it-stripe-radar', note: 'Under 100 ms, over 1,000 signals, 0.1 per cent of good payments blocked, about 1 in 1,000 fraudulent.' },
    { label: 'Uber: RAMEN real-time push platform', href: 'https://www.uber.com/en/blog/real-time-push-platform/', note: 'At-least-once with sequence numbers, three priorities, time-to-live from seconds to 30 minutes, 1.5 million connections.' },
    { label: 'Uber: next-generation push platform on gRPC', href: 'https://www.uber.com/en-IT/blog/ubers-next-gen-push-platform-on-grpc', note: 'Why immediate acknowledgements matter: delivery state unknown for 30 seconds under batched acks.' },
    { label: 'Uber: optimising push timing with machine learning', href: 'https://www.uber.com/en-CA/blog/how-uber-optimizes-push-notifications-using-ml', note: 'The Consumer Communication Gateway: frequency caps, minimum gaps and expiry for marketing pushes.' },
    { label: 'LinkedIn: Air Traffic Controller', href: 'https://engineering.linkedin.com/blog/2018/03/air-traffic-controller--member-first-notifications-at-linkedin', note: 'Partitioned by recipient on Samza and RocksDB; channel choice and duplicate filters; p90 push latency cut from 12 s to 1.5 s.' },
    { label: 'InfoQ: Netflix RENO', href: 'https://www.infoq.com/news/2022/03/netflix-reno', note: 'Priority-specific queues each with its own cluster, a staleness filter, and isolated failure domains.' },
    { label: 'Slack: tracing notifications', href: 'https://slack.engineering/tracing-notifications/', note: 'The notification id as trace id, spans from trigger to opened, and 100 per cent sampling of notification flows.' },
    { label: 'Airbnb: promotions and communications platform', href: 'https://medium.com/airbnb-engineering/airbnbs-promotions-and-communications-platform-6266f1ffe2bd', note: 'Transactional and promotional messages on one platform, SQS-backed delivery workers in front of the vendors, typical delivery under 30 seconds.' },
    { label: 'Apple: sending notification requests to APNs', href: 'https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns', note: 'Priority 10, 5 and 1, expiry and 0, collapse id up to 64 bytes, 4 KB payload, one stored notification per app (usually the latest), may reorder, connections reused for hours to days.' },
    { label: 'Apple: viewing the status of push notifications', href: 'https://developer.apple.com/documentation/usernotifications/viewing-the-status-of-push-notifications-using-metrics-and-apns', note: 'Acceptance is not delivery: APNs may then deliver, store or discard; no ordering guarantee for the one stored notification.' },
    { label: 'Apple: Human Interface Guidelines, managing notifications', href: 'https://developer.apple.com/design/human-interface-guidelines/managing-notifications', note: 'Interruption levels; Time Sensitive overrides scheduled delivery and breaks through Focus, with an account security issue as an example; Critical also overrides the Ring/Silent switch and needs an entitlement.' },
    { label: 'Apple: UNNotificationActionOptions', href: 'https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions', note: 'authenticationRequired: an action that runs only on an unlocked device.' },
    { label: 'Firebase: set and manage Android message priority', href: 'https://firebase.google.com/docs/cloud-messaging/android/message-priority', note: 'High priority can wake a sleeping device and suits account alerts; high-priority messages that show nothing may be dropped to normal priority.' },
    { label: 'Twilio: outbound message status in status callbacks', href: 'https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks', note: 'The states a message reports by webhook: queued, sent, delivered, undelivered, failed.' },
    { label: 'Twilio: Messages resource, message status values', href: 'https://www.twilio.com/docs/messaging/api/message-resource', note: 'Sent means the upstream carrier accepted it; delivered means the carrier confirmed delivery (to the handset where available).' },
    { label: 'Scott Logic: the transactional outbox', href: 'https://blog.scottlogic.com/2025/09/08/solving-data-consistency-in-distributed-systems-with-the-transactional-outbox.html', note: 'The dual-write problem, polling relays against change data capture, deterministic ids and idempotent readers.' },
    { label: 'Nationwide: safe account scams', href: 'https://www.nationwide.co.uk/news-and-stories/safe-account-scams', note: 'Legitimate organisations never ask you to move money to another account: the line every alert repeats.' },
  ],

  glossary: [
    { term: 'Faster Payments', also: ['FPS'], where: 'payments', text: 'The UK\'s near-instant bank transfer system, run by Pay.UK. Money usually arrives in seconds, occasionally up to two hours later. Once sent, a Faster Payment cannot be cancelled, which is why a suspicious one must be held before it is submitted.' },
    { term: 'APP fraud', also: ['authorised push payment fraud', 'scam'], where: 'ops', text: 'Fraud where the victim makes the payment themselves, tricked by someone posing as a supplier, the bank or the police. In 2025 UK Finance reported £576.4 million lost this way, £75.6 million of it by businesses and other non-personal accounts.' },
    { term: 'Reimbursement requirement', also: ['PSR rules', 'mandatory reimbursement'], where: 'ops', text: 'Since 7 October 2024 UK banks must reimburse APP fraud victims on Faster Payments and CHAPS up to £85,000 a claim, within five business days or 35 at most if they stop the clock. Claims are allowed up to 13 months after the last payment, with an optional excess of up to £100. The sending and receiving banks broadly share the cost equally. Consumers, micro-enterprises and charities are covered.' },
    { term: 'Micro-enterprise', where: 'ops', text: 'In UK payments law, a business with fewer than 10 people and annual turnover or balance sheet of no more than €2 million, judged when the account contract is made. Many small business customers are one, so they get consumer-level payment protections.' },
    { term: 'Payment delay', also: ['D+4'], where: 'payments', text: 'Since 30 October 2024 a UK bank with reasonable grounds to suspect fraud may delay an outbound payment by up to four business days. It must form its suspicion by the end of the next business day and tell the payer why.' },
    { term: 'Confirmation of Payee', also: ['CoP'], where: 'payer', text: 'A check of the payee\'s name against the account before a new payment. The answer is a match, a close match (show the real name), no match, or unavailable.' },
    { term: 'Strong customer authentication', also: ['SCA'], where: 'reply', text: 'Two independent factors from knowledge, possession and inherence, such as a bound phone and a fingerprint. Releasing a held payment is treated as a payment instruction and needs it.' },
    { term: 'Dynamic linking', where: 'reply', text: 'The SCA rule for remote payments: the payer is shown the amount and the payee, and the authentication code is specific to both, so changing either invalidates it.' },
    { term: 'Account takeover', also: ['ATO'], where: 'risk', text: 'Someone else signing in as the customer with stolen credentials. The tell-tale signs are a new device, new payees and sudden large amounts, which is what velocity features catch.' },
    { term: 'Velocity feature', also: ['counter', 'sliding window'], where: 'features', text: 'A count or sum over a recent window: payments in the last hour, new payees today, amount sent in 24 hours. Short windows must include the payment being scored.' },
    { term: 'False positive', also: ['precision'], where: 'risk', text: 'A good payment flagged as fraud. With fraud at about 1 in 10,000 transactions (Monzo\'s rate), even a good model flags far more good payments than bad, so most alerts go to honest owners.' },
    { term: 'Back-testing', where: 'risk', text: 'Running a new rule or model over past transactions with known outcomes before it goes live, to see what it would have caught and how many good payments it would have stopped.' },
    { term: 'Transactional outbox', also: ['outbox pattern'], see: { id: 'outbox', label: 'Transactional outbox' }, where: 'payments', text: 'Writing the business change and the event that announces it in one local transaction, then publishing the event from that table. Both happen or neither does.' },
    { term: 'Dual write', where: 'txlog', text: 'Updating a database and sending a message as two separate steps. A crash between them leaves the two disagreeing. The outbox avoids it.' },
    { term: 'Change data capture', also: ['CDC', 'Debezium'], where: 'txlog', text: 'Reading a database\'s own change log and turning each committed change into a message, without changing the code that writes.' },
    { term: 'Partition key', see: { id: 'partitioning', label: 'Partitioning' }, where: 'txlog', text: 'The value that picks a message\'s partition. Keying by account keeps one business\'s events in order on one partition, read by one consumer.' },
    { term: 'Consumer lag', where: 'txlog', text: 'How far a reader is behind the newest message. For the alert service it is the alert\'s delay, so it is alarmed in seconds.' },
    { term: 'At-least-once', also: ['exactly-once', 'delivery guarantee'], where: 'alerts', text: 'Every message is delivered one or more times, never zero. Easy to promise with retries; safe only when a repeat is harmless.' },
    { term: 'Idempotency key', also: ['idempotent'], see: { id: 'idempotency-keys', label: 'Idempotency keys' }, where: 'reply', text: 'An id sent with a request so that repeating the request has no further effect. The alert id is the key for the answer and for the payment action it causes.' },
    { term: 'Dedup key', also: ['deduplication'], where: 'workers', text: 'Alert id, person, channel and step, set with an atomic set-if-absent before a send. A second job with the same key sends nothing.' },
    { term: 'Priority queue', also: ['P0', 'priority topic'], see: { id: 'priority-queue', label: 'Priority queue' }, where: 'queue', text: 'Here, a separate topic and worker pool per priority, so security alerts never wait behind marketing.' },
    { term: 'Dead-letter queue', also: ['DLQ', 'dead-letter topic'], where: 'queue', text: 'Where a job goes after its last retry, so it stops blocking others and can be inspected and replayed. A P0 job there also opens a case.' },
    { term: 'Circuit breaker', where: 'workers', text: 'After a run of failures, stop calling a provider for a while and fail fast, then let a few test requests through. Here an open breaker moves traffic to the other provider or the next channel.' },
    { term: 'Backoff with jitter', also: ['exponential backoff', 'retry'], where: 'workers', text: 'Waiting longer after each failed try, with a random part added, so thousands of retries do not arrive together.' },
    { term: 'APNs', also: ['Apple Push Notification service'], where: 'push', text: 'Apple\'s push service. Priority 10 sends at once, priority 5 waits for power. It is best effort and stores only one notification per app for an offline device, usually the latest.' },
    { term: 'FCM', also: ['Firebase Cloud Messaging'], where: 'push', text: 'Google\'s push service. High priority can wake a sleeping Android device, but if high-priority messages show nothing, FCM may drop them to normal priority.' },
    { term: 'Collapse id', also: ['collapse key'], where: 'push', text: 'An id that makes a later notification replace an earlier one on the device. Using the alert id means a duplicate push replaces, not stacks.' },
    { term: 'Time Sensitive notification', also: ['interruption level', 'Focus'], where: 'phone', text: 'An iOS level for things that need attention now, which breaks through Focus and scheduled summaries. Apple names an account security issue as an example. Critical, which also overrides silent mode, needs an Apple entitlement.' },
    { term: 'Delivery receipt', also: ['DLR', 'status callback'], where: 'sms', text: 'The provider\'s report of what happened to a message: queued, sent, delivered, undelivered or failed. Delivered means the carrier confirmed it. Receipts can be late, out of order or missing.' },
    { term: 'Escalation ladder', where: 'alerts', text: 'The steps taken while nobody answers: push, SMS, a call, a second person, then a human team. Each step has a deadline stored with the alert.' },
    { term: 'Quiet hours', where: 'prefs', text: 'Times a person asks not to be disturbed. Honoured for marketing and most service messages, overridden for a security alert that needs an answer.' },
    { term: 'Service message', also: ['PECR', 'direct marketing'], where: 'prefs', text: 'A message with routine information a customer needs, such as a security alert. Under PECR, consent rules cover marketing, not service messages, but adding promotion to a service message can make it marketing.' },
    { term: 'In-app inbox', also: ['WebSocket', 'notification centre'], see: { id: 'realtime-push', label: 'Real-time push' }, where: 'store', text: 'The list of alerts the app shows, read from the alert store. When the app is open it gets new ones at once over its own connection.' },
    { term: 'Device binding', where: 'phone', text: 'Tying a phone to the account at set-up with a key held on the device. An answer signed by that key comes from the owner\'s phone, not from wherever the fraudster is signed in.' },
    { term: 'SIM swap', where: 'sms', text: 'A fraudster moving a victim\'s phone number to their own SIM, so texts and calls go to them. The reason an SMS never carries a code or a link, and an SMS reply can only block.' },
    { term: 'Audit trail', where: 'store', text: 'The append-only record of what was decided, sent, delivered and answered, with times and devices. It is the evidence when a reimbursement claim or complaint turns on what the bank said.' },
    { term: 'Fail open', also: ['fail closed', 'fail safe'], where: 'prefs', text: 'Choosing what happens when a dependency is down. A security alert fails open to the mandatory channels; marketing fails closed and sends nothing.' },
  ],
};
