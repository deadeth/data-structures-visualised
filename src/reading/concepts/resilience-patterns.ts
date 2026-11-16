import type { Concept } from "../types";

const page: Concept = {
  id: "resilience-patterns",
  title: "Resilience patterns",
  group: "Reliability",
  summary:
    "How a service stays up when the things it calls don't: timeouts, retries, breakers, bulkheads, shedding and fallbacks, and the targets, alerts and deploy habits that tell you whether they're working.",
  minutes: 14,
  sections: [
    {
      id: "slow-is-worse-than-down",
      title: "Slow is worse than down",
      blocks: [
        {
          p: "A dead dependency fails fast: connection refused, in under a millisecond. A slow one is worse, because every call to it holds a thread, a connection and some memory until it gives up. Most outages that spread start with something slow, not something dead.",
        },
        {
          p: "Take a checkout API with 200 worker threads that calls payments, inventory and recommendations. Recommendations starts taking 30 seconds. At 50 requests a second, all 200 threads are stuck on it within 4 seconds (200 ÷ 50). Checkout now fails for everyone, and the service that broke it was the one nobody needed.",
        },
        {
          diagram: {
            w: 520,
            h: 320,
            nodes: [
              { id: "users", label: "Customers", sub: "50 requests/s", x: 190, y: 10, kind: "client" },
              { id: "api", label: "Checkout API", sub: "200 threads, all stuck", x: 190, y: 120, tone: "bad" },
              { id: "pay", label: "Payments", sub: "healthy, idle", x: 20, y: 250, tone: "muted" },
              { id: "recs", label: "Recommendations", sub: "30 s a call", x: 190, y: 250, tone: "bad" },
              { id: "inv", label: "Inventory", sub: "healthy, idle", x: 360, y: 250, tone: "muted" },
            ],
            edges: [
              { from: "users", to: "api", label: "timeouts", tone: "bad" },
              { from: "api", to: "pay" },
              { from: "api", to: "recs", label: "200 waiting", tone: "bad" },
              { from: "api", to: "inv" },
            ],
          },
          caption:
            "One optional dependency went slow and took the whole API with it. Payments and inventory are healthy and get no traffic. Every pattern on this page exists to stop this picture.",
        },
        {
          p: "The patterns below fall into three jobs. Stop waiting (timeouts, deadlines, breakers). Stop making it worse (retry limits, shedding, rate limits). Keep something working (bulkheads, fallbacks). The second half of the page covers how you'd know: SLOs, alerts, incidents and safe deploys.",
        },
      ],
    },
    {
      id: "timeouts-and-deadlines",
      title: "Timeouts and deadlines",
      blocks: [
        {
          p: "Every network call needs a timeout, and the library default is usually wrong: often it's none, or 30 seconds. Set it from the dependency's measured p99, with some headroom. If recommendations answers in 80 ms at p99, a 200 ms timeout loses almost nothing and frees the thread 150 times sooner than a 30 second one.",
        },
        {
          p: "A timeout is per call. A **deadline** is per request: the edge decides the user will wait 800 ms, and each hop passes the remaining time down. A service that receives a request with 80 ms left doesn't start a 200 ms query. Without this, lower layers carry on working for a caller that has already given up, which is wasted load at the worst moment.",
        },
        {
          diagram: {
            w: 480,
            h: 410,
            nodes: [
              { id: "c", label: "Mobile app", sub: "waits 800 ms", x: 170, y: 10, kind: "client" },
              { id: "gw", label: "Gateway", sub: "sets the deadline", x: 170, y: 120 },
              { id: "pay", label: "Payments service", sub: "fraud check took 620", x: 170, y: 230 },
              { id: "db", label: "Postgres", sub: "query skipped", x: 170, y: 340, kind: "store", tone: "bad" },
            ],
            edges: [
              { from: "c", to: "gw", label: "800 ms budget" },
              { from: "gw", to: "pay", label: "700 ms left" },
              { from: "pay", to: "db", label: "80 ms left", tone: "bad" },
            ],
          },
          caption:
            "The deadline shrinks as it travels down. At the last hop 80 ms remain, the query needs 200 ms, so the service skips it and fails at once instead of doing work nobody will read. gRPC carries a deadline this way; over plain HTTP you pass a header yourself.",
        },
        {
          callout:
            "Timeouts must shrink as you go down. If the gateway gives up at 1 second and the service behind it waits 5 seconds on its database, the service does 4 seconds of work per request for nobody.",
          kind: "pitfall",
          title: "Inverted timeouts",
        },
      ],
    },
    {
      id: "retries",
      title: "Retries, backoff, jitter and budgets",
      blocks: [
        {
          p: "Many failures pass in a moment: a dropped packet, a host restarting, a leader election. A retry turns those into successes. The trouble is that retries add load exactly when the callee has least to spare.",
        },
        {
          sequence: {
            actors: ["1,000 clients", "API", "Database"],
            messages: [
              { from: "1,000 clients", to: "API", label: "1,000 requests/s" },
              { from: "API", to: "Database", label: "1,000 queries/s", note: "database starts timing out" },
              { from: "Database", to: "API", label: "timeouts", tone: "bad", dashed: true },
              { from: "API", to: "Database", label: "3 tries each: 3,000/s", tone: "bad" },
              { from: "API", to: "1,000 clients", label: "503", tone: "bad", dashed: true },
              { from: "1,000 clients", to: "API", label: "3 tries each: 3,000/s", tone: "bad" },
              { from: "API", to: "Database", label: "9,000 queries/s", tone: "bad", note: "it recovers, then falls over again" },
            ],
          },
          caption:
            "A retry storm. Two layers each trying 3 times turn 1,000 queries a second into 9,000 against a database that could not serve 1,000. A third layer would make it 27,000. The outage now outlasts its cause.",
        },
        {
          p: "Four rules keep retries safe. Retry only errors that may pass: timeouts, connection resets, 503, and 429 after its `Retry-After`. Never a 400 or 404. Wait longer each time, with a cap: 100 ms, 200 ms, 400 ms. Add **jitter**, so a thousand clients that failed together don't come back together: sleep a random time between 0 and the backoff. And retry at one layer only.",
        },
        {
          p: "A **retry budget** is the backstop. Each client may spend retries worth about 10% of its normal traffic. In a short blip every retry goes through. In a long outage the extra load is capped at 1.1 times normal instead of 3 times.",
        },
        {
          see: [
            {
              href: "#/s/retries-breaker",
              label: "Retries, backoff and circuit breakers",
              why: "Run the same storm with immediate retries, plain backoff and full jitter, and compare the load on the downstream tick by tick.",
            },
          ],
        },
      ],
    },
    {
      id: "idempotency",
      title: "Idempotency comes first",
      blocks: [
        {
          p: "A timeout tells you nothing about whether the work was done. The server may have charged the card and lost the reply. So a retry is only safe if doing the operation twice has the same effect as doing it once. Reads, a `PUT` of a whole value and a `DELETE` are like that already. A `POST` that moves money isn't, until you add an idempotency key.",
        },
        {
          sequence: {
            actors: ["Client", "Payments API", "Card network"],
            messages: [
              { from: "Client", to: "Payments API", label: "POST /payments key=k1" },
              { from: "Payments API", to: "Card network", label: "charge £40" },
              { from: "Card network", to: "Payments API", label: "approved", tone: "ok" },
              { from: "Payments API", to: "Client", label: "reply lost", tone: "bad", dashed: true, note: "client times out: paid or not?" },
              { from: "Client", to: "Payments API", label: "POST /payments key=k1" },
              { from: "Payments API", to: "Client", label: "200, first result", tone: "ok", note: "k1 already stored: no second charge" },
            ],
          },
          caption:
            "The client can't tell a lost request from a lost reply, so it sends the same key again. The server finds k1 and replays the stored answer. Without the key, the customer pays £80.",
        },
        {
          p: "The cost is a table of keys with a unique constraint, written in the same transaction as the payment, and a rule for how long keys live (24 hours is common). Message consumers need the same thing: Kafka and SQS deliver at least once, so a consumer records the message id it has handled.",
        },
        {
          see: [
            {
              href: "#/s/idempotency-keys",
              label: "Idempotency keys",
              why: "Follows one payment through a lost reply, a concurrent duplicate and a reused key with a different body.",
            },
          ],
        },
      ],
    },
    {
      id: "circuit-breakers",
      title: "Circuit breakers",
      blocks: [
        {
          p: "A timeout still costs the full wait on every call. If a dependency has been failing for a minute, the next call will fail too, so stop making it. A circuit breaker counts recent results per dependency and, past a threshold, fails calls at once without sending them. The dependency gets room to recover and the caller gets its threads back.",
        },
        {
          diagram: {
            w: 560,
            h: 300,
            nodes: [
              { id: "closed", label: "Closed", sub: "calls pass, count failures", x: 20, y: 40, w: 180, tone: "ok" },
              { id: "open", label: "Open", sub: "fail fast, send nothing", x: 360, y: 40, w: 180, tone: "bad" },
              { id: "half", label: "Half-open", sub: "let a few probes through", x: 190, y: 220, w: 180, tone: "compare" },
            ],
            edges: [
              { from: "closed", to: "open", label: "50% of 20 fail", tone: "bad" },
              { from: "open", to: "half", label: "after 30 s" },
              { from: "half", to: "closed", label: "probes pass", tone: "ok" },
            ],
          },
          caption:
            "Three states. The numbers are examples: open when half of at least 20 calls in 10 seconds fail, wait 30 seconds, then probe. A failed probe sends half-open straight back to open for another 30 seconds (not drawn).",
        },
        {
          p: "What it costs: some calls that would have worked are refused, and the thresholds need tuning. Judge a failure rate over a window with a minimum call count. A raw count of 5 failures opens on a blip at high traffic and never opens at low traffic. Keep one breaker per dependency, or per host, never one for everything.",
        },
      ],
    },
    {
      id: "bulkheads",
      title: "Bulkheads",
      blocks: [
        {
          p: "A bulkhead gives each dependency its own fixed share of a resource, so one can't use all of it. In practice that's a separate connection pool or a concurrency limit per dependency. In the opening example, recommendations with a pool of 10 can hold 10 threads hostage, not 200.",
        },
        {
          diagram: {
            w: 560,
            h: 330,
            groups: [{ label: "Checkout API: 200 threads", x: 10, y: 10, w: 540, h: 150 }],
            nodes: [
              { id: "p1", label: "Payments pool", sub: "20 slots, 6 in use", x: 30, y: 60, w: 150, tone: "ok" },
              { id: "p2", label: "Recs pool", sub: "10 slots, all stuck", x: 205, y: 60, w: 150, tone: "bad" },
              { id: "p3", label: "Inventory pool", sub: "20 slots, 4 in use", x: 380, y: 60, w: 150, tone: "ok" },
              { id: "pay", label: "Payments", x: 30, y: 250, w: 150 },
              { id: "recs", label: "Recommendations", sub: "30 s a call", x: 205, y: 250, w: 150, tone: "bad" },
              { id: "inv", label: "Inventory", x: 380, y: 250, w: 150 },
            ],
            edges: [
              { from: "p1", to: "pay" },
              { from: "p2", to: "recs", label: "11th call refused", tone: "bad" },
              { from: "p3", to: "inv" },
            ],
          },
          caption:
            "The same failure as the first picture, with pools. Recommendations fills its 10 slots and the 11th call is refused at once. The other 190 threads keep serving checkout.",
        },
        {
          p: "The same idea works at larger sizes: a separate worker fleet for batch jobs, a separate Kafka consumer group for a slow partner, a separate database for reporting. The cost is capacity that sits idle, and pool sizes you have to choose. Size each pool from peak rate times p99 latency: 100 calls a second at 80 ms needs about 8 in flight, so 10 to 20.",
        },
      ],
    },
    {
      id: "rate-limiting-and-shedding",
      title: "Rate limiting and load shedding",
      blocks: [
        {
          p: "These two get confused. **Rate limiting** is per client and is about fairness: one customer's script may not use everyone's capacity. **Load shedding** is per server and is about survival: when I'm over capacity, I refuse some work early so the rest finishes.",
        },
        {
          p: "A rate limiter is usually a token bucket per API key: 100 a second sustained, bursts of 200, and a `429` with `Retry-After` beyond that. Shedding watches the server's own state, such as requests in flight or queue age, and returns `503` when it passes a limit. Refusing costs microseconds. Accepting a request that will time out after 800 ms in a queue costs the full work and still fails.",
        },
        {
          p: "Shed by priority when you can. Drop the recommendations refresh before the payment, and health checks never. Keep queues short and bounded: a queue longer than the caller's timeout only holds requests that are already dead.",
        },
        {
          see: [
            {
              href: "#/s/token-bucket",
              label: "Token bucket",
              why: "Shows the lazy refill, a burst spending saved tokens, and where Retry-After comes from.",
            },
          ],
        },
      ],
    },
    {
      id: "degradation",
      title: "Graceful degradation and fallbacks",
      blocks: [
        {
          p: "When a breaker is open or a pool is full, the caller needs something to do instead. Decide it per call, in advance. The question to ask is: what does the user see if this dependency is gone for an hour?",
        },
        {
          table: {
            head: ["Call", "Fallback", "What it costs"],
            rows: [
              ["Recommendations", "Popular items from a cache, or hide the panel", "A blander page"],
              ["Exchange rate for display", "Last known rate, marked with its time", "Stale by minutes; never use it to execute"],
              ["Feature flags", "Last known values held in memory", "A flag change doesn't arrive"],
              ["Sending a receipt email", "Queue it and send later", "Someone must drain the queue"],
              ["Fraud score on a card payment", "A stricter rule set, or decline over a limit", "More false declines"],
              ["Moving money", "None. Fail clearly", "The user retries with the same key"],
            ],
          },
          caption: "A fallback is a product decision. Agree it with the product owner before the outage, not during it.",
        },
        {
          callout:
            "A fallback that is only ever run during an outage is untested code that runs at the worst time. Exercise it: turn the dependency off in staging on a schedule, or send 1% of traffic down the fallback path all the time.",
          kind: "pitfall",
          title: "The fallback nobody has run",
        },
      ],
    },
    {
      id: "health-checks",
      title: "Health checks and load balancing",
      blocks: [
        {
          p: "A load balancer is the first resilience pattern most systems have: it stops sending traffic to a host that fails its checks. Detection takes interval times threshold. A check every 5 seconds with 2 misses means up to 10 seconds of errors from that host, so pair active checks with passive ones that eject a host on real request failures.",
        },
        {
          p: "Keep two kinds of check apart. **Liveness** asks whether the process should be restarted. **Readiness** asks whether it should get traffic. Neither should fail because a shared dependency is down: if every host's check tests the database, a database blip removes every host at once, and the balancer has nowhere to send anything.",
        },
        {
          p: "Spread hosts over three zones and size for losing one. With 3 zones each normally at 60%, losing one puts the other two at 90%. That's too close: aim for 50% or lower in normal running.",
        },
        {
          see: [
            {
              href: "#/s/load-balancing",
              label: "Load balancing",
              why: "Fail a server and watch the health check count misses before taking it out; make one slow and compare policies.",
            },
          ],
        },
      ],
    },
    {
      id: "slos",
      title: "SLIs, SLOs and error budgets",
      blocks: [
        {
          p: "An **SLI** is a measurement of what users get: the share of payment requests answered correctly in under 500 ms, measured at the load balancer. An **SLO** is the target for it: 99.9% over 30 days. The **error budget** is what's left: 0.1%.",
        },
        {
          table: {
            head: ["SLO", "Allowed bad time in 30 days", "Out of 10 million requests"],
            rows: [
              ["99%", "7.2 hours", "100,000"],
              ["99.9%", "43 minutes", "10,000"],
              ["99.95%", "22 minutes", "5,000"],
              ["99.99%", "4.3 minutes", "1,000"],
            ],
          },
          caption: "30 days is 43,200 minutes. 0.1% of that is 43.2 minutes.",
        },
        {
          p: "The numbers decide the design. At 99.9% a person can be paged, take 10 minutes to respond and still fix one incident a month inside the budget. At 99.99% the whole budget is 4 minutes, less than the time to open a laptop, so recovery must be automatic.",
        },
        {
          p: "Dependencies multiply. A request that needs five services, each at 99.9%, succeeds 0.999⁵ = 99.5% of the time: 3.6 hours a month, not 43 minutes. To promise more than your dependencies you need retries, fallbacks or fewer hard dependencies.",
        },
        {
          p: "The budget is also a way to make decisions. Budget left: ship faster and run the risky migration. Budget spent: stop feature launches and spend the time on reliability. It turns an argument between product and engineering into a number both agreed in advance.",
        },
        {
          callout:
            "\"I'd set an SLO of 99.9% on successful payments under 500 ms, measured at the edge. That's 43 minutes a month. It tells me a human can be in the loop for recovery, and it gives the team a budget: when it's gone, we stop launches and fix what burned it.\"",
          kind: "interview",
          title: "Say the number and what it buys",
        },
      ],
    },
    {
      id: "alerting",
      title: "Alert on symptoms",
      blocks: [
        {
          p: "Page a person for what users feel: error rate, latency, payments not completing. Don't page for causes such as CPU at 90% or one host down. Causes are many and mostly harmless; symptoms are few and always matter. Causes belong on dashboards, where the person paged for the symptom goes looking.",
        },
        {
          p: "Alert on how fast the budget is burning. A burn rate of 1 uses the budget in exactly 30 days. A rate of 14.4 sustained for an hour uses 2% of the month's budget (14.4 ÷ 720 hours) and would empty it in 50 hours: page. A rate of 6 over 6 hours uses 5%: page. A slow leak at a rate of 1 over 3 days: a ticket, in working hours.",
        },
        {
          callout:
            "Every page should need a human, now, and say what to do first. If the on-call engineer's response to an alert is to wait and see, delete it or make it a ticket.",
          kind: "rule",
        },
      ],
    },
    {
      id: "incidents",
      title: "Incidents and blameless review",
      blocks: [
        {
          p: "During an incident, restore service first and find the cause later. Roll back the last change, fail over, turn the flag off, shed load. Many outages follow a change, so \"what changed in the last hour?\" is the first question.",
        },
        {
          p: "Give it a shape. One incident lead who decides and doesn't type. One person on communications, posting to a status page on a fixed interval. Everyone else works the problem in one channel. Severity levels agreed beforehand say who is woken and who is told.",
        },
        {
          p: "Afterwards, write a review that asks how the system let this happen, not who did it. \"An engineer ran the wrong command\" is where the review starts: why was that command possible in production, with no confirmation and no dry run? People who expect blame hide details, and details are what you need. Each action gets one owner and a date, and someone checks they were done.",
        },
      ],
    },
    {
      id: "deployment-safety",
      title: "Deployment safety",
      blocks: [
        {
          p: "Since changes cause so many incidents, make each change small, watched and reversible. A **canary** sends a small share of traffic to the new build and compares its SLIs with the old one before going further.",
        },
        {
          diagram: {
            w: 520,
            h: 410,
            nodes: [
              { id: "lb", label: "Load balancer", x: 190, y: 10 },
              { id: "canary", label: "Canary", sub: "new build, 1 host", x: 30, y: 120, tone: "compare" },
              { id: "fleet", label: "Fleet", sub: "old build, 99 hosts", x: 350, y: 120 },
              { id: "cmp", label: "Compare SLIs", sub: "errors, p99, 15 min", x: 190, y: 230, tone: "compare" },
              { id: "go", label: "Promote", sub: "5%, 25%, 100%", x: 30, y: 340, tone: "ok" },
              { id: "back", label: "Roll back", sub: "automatic", x: 350, y: 340, tone: "bad" },
            ],
            edges: [
              { from: "lb", to: "canary", label: "1%" },
              { from: "lb", to: "fleet", label: "99%" },
              { from: "canary", to: "cmp" },
              { from: "fleet", to: "cmp" },
              { from: "cmp", to: "go", label: "no worse", tone: "ok" },
              { from: "cmp", to: "back", label: "worse", tone: "bad" },
            ],
          },
          caption:
            "The canary is judged against the old build running at the same time, not against a fixed threshold. A bad build reaches 1% of traffic for 15 minutes instead of everyone for an hour.",
        },
        {
          p: "**Feature flags** separate deploying code from releasing behaviour. The code ships dark, is turned on for staff, then 1% of customers, and can be turned off in seconds without a deploy. The cost is a second code path to test and old flags to remove.",
        },
        {
          p: "**Rollback** has to be possible, which is mostly a database question. Make schema changes in steps that old and new code can both run against: add the column, write to both, backfill, switch reads, and drop the old column a release later. A migration that old code can't survive turns a 2 minute rollback into a restore.",
        },
      ],
    },
    {
      id: "failure-to-pattern",
      title: "Which pattern for which failure",
      blocks: [
        {
          table: {
            head: ["Failure", "Pattern", "Watch out for"],
            rows: [
              ["A dependency is slow", "Timeout from its p99, deadline passed down, bulkhead", "Timeouts longer than the caller's"],
              ["A dependency is down for minutes", "Circuit breaker and a fallback", "Thresholds on raw counts"],
              ["A brief error or lost packet", "Retry with capped backoff and jitter, at one layer", "Retrying a 400; retrying at every layer"],
              ["A reply was lost after a write", "Idempotency key", "Key not stored in the same transaction"],
              ["A long outage with eager clients", "Retry budget, about 10% of traffic", "Storm on recovery"],
              ["More traffic than capacity", "Load shedding by priority, bounded queues", "Queues longer than the timeout"],
              ["One client sends too much", "Rate limit per client (token bucket)", "A limiter outage blocking everyone"],
              ["One host is broken", "Health checks, passive ejection", "Checks that test shared dependencies"],
              ["A zone is lost", "Three zones, sized to lose one", "Running at 60% and calling it spare"],
              ["A bad build", "Canary with automatic rollback", "Schema changes old code can't run on"],
              ["A bad feature or config", "Feature flag as an off switch", "Flags nobody has ever turned off"],
              ["A message that always fails", "Dead-letter queue after a few attempts", "Nobody reading the dead-letter queue"],
            ],
          },
          caption: "In an interview, name the failure first, then the pattern, then its cost.",
        },
        {
          callout:
            "Don't list all of these for every arrow on the board. Pick the two calls where failure hurts most, say which pattern each gets and why, and give numbers: the timeout, the retry count, the breaker threshold, the SLO.",
          kind: "interview",
          title: "Use them sparingly",
        },
      ],
    },
  ],
  unverified: [
    "That client library defaults are 'often none, or 30 seconds': true of several HTTP clients from memory, not checked per library.",
    "That gRPC propagates deadlines to downstream calls automatically: it carries a deadline per call; automatic propagation depends on the language and on passing the context.",
    "Idempotency keys living 24 hours is described as common from memory (Stripe documents 24 hours); not checked.",
    "The burn-rate thresholds (14.4 over 1 hour for 2% of budget, 6 over 6 hours for 5%) follow the Google SRE Workbook from memory. The arithmetic is checked; the attribution is not.",
    "'About one outage in every few follows a change' is a deliberately loose statement of a commonly quoted finding; no source checked and no figure claimed.",
    "Kafka and SQS described as at-least-once: true of standard SQS queues and of Kafka consumers that commit after processing; FIFO queues and Kafka transactions differ.",
    "The breaker numbers (50% of 20 calls in 10 seconds, 30 second wait), pool sizes and canary timings are illustrative, matching the retries page on this site, not any product's defaults.",
  ],
};

export default page;
