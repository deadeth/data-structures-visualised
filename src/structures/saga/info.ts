import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A saga runs one business transaction across several services as a chain of local transactions, each committed on its own. Every step that can be undone has a compensating action, a new forward action that cancels its effect. If a step fails, the steps already done are compensated in reverse order. Nobody holds a lock across services, so a saga never blocks the way two-phase commit can, but other readers can see its half-done state.',
  watch: [
    'The magenta chip is the saga. The page models a £50 payment: Ledger holds the money, Limits counts it against today\'s limit, Gateway submits it to Faster Payments, and Ledger posts the debit.',
    'The orchestrator writes the saga\'s row to its saga log before it sends anything, and again after every reply. The row, not the orchestrator\'s memory, says where the saga is.',
    'Every command carries an idempotency key, such as S2-2. The service stores the key with its reply in the same local transaction, so a resent command is answered from the record and has no second effect.',
    'Fail step 3: the scheme rejects the payment. The orchestrator writes compensating, then undoes step 2 and then step 1: newest first, each its own local transaction with its own key.',
    'Lose a reply, or crash the orchestrator after a step ran but before the row recorded it. Either way the orchestrator sends the same command with the same key, and the amber comparison shows the service finding that key.',
    'Concurrent saga: a second payment sees the first one\'s hold. That is the missing isolation. The hold is a semantic lock, so Ledger answers "pending" rather than "insufficient funds", and the second saga waits.',
    'Fail after pivot: once the scheme has accepted the money, the saga can only go forward. Post is retried with the same key until Ledger is back.',
    'Choreography: the same happy path as a chain of events through a broker. There is no saga log. Fail a step there and see the undoing spread across services with no single place that knows.',
    'Simplified: one payer, one amount, steps that refuse only when told to or when money or limit runs out, timeouts that fire at once, and a broker that never loses an event. Choreography supports Start, Step and Fail only.',
  ],
  complexity: [
    { op: 'Saga of n steps', average: 'n local transactions, n round trips', worst: 'n + (n − 1) compensations', note: 'Each step commits alone. A failure at step k costs k − 1 compensations.' },
    { op: 'Saga log writes', average: '2 per saga + 1 per step', worst: 'Plus 1 per compensation', note: 'Row written at the start, after each reply, and when the state changes.' },
    { op: 'Locks across services', average: 'None', worst: 'None', note: 'Each local transaction holds its own locks for milliseconds. Holds and pending states are data, not locks.' },
    { op: 'Retry of a lost reply', average: '1 round trip', worst: 'Until the service answers', note: 'Same key, so the service answers from its record.' },
    { op: 'Recovery after a crash', average: 'O(unfinished sagas)', worst: 'O(log size)', note: 'Read the log, resume every row that is running or compensating.' },
  ],
  space:
    'One row per saga in the saga log, kept at least until the saga ends. In each service, one stored reply per idempotency key, kept long enough to outlive every retry. A hold or pending state per saga in flight.',
  usedIn: [
    {
      name: 'Garcia-Molina and Salem, 1987',
      how: 'The paper "Sagas" (SIGMOD 1987) named the idea: break a long-lived transaction into a sequence of transactions, each with a compensating transaction, so the database need not hold locks for the whole of it.',
    },
    {
      name: 'Temporal',
      how: 'A workflow engine. A workflow\'s code is the orchestrator; Temporal stores every step it takes in an event history and, after a worker dies, rebuilds the workflow by replaying that history. Its Java SDK has a Saga helper that registers compensations and runs them in reverse.',
    },
    {
      name: 'AWS Step Functions',
      how: 'A state machine service. AWS\'s own prescriptive guidance shows a serverless saga: each step a Lambda function, and a Catch on a failed step that routes to the compensating steps.',
    },
    {
      name: 'Ledger service design on this site',
      how: 'A transfer between accounts on two shards is a saga through a clearing account: debit the payer into the clearing account on one shard, then credit the payee from it on the other. A balance left in the clearing account shows a transfer still in flight.',
    },
  ],
  reachFor: [
    'A business transaction spans services that each own their database, so one ACID transaction cannot cover it.',
    'Steps take seconds to days (a payment, a booking, an order shipped), so holding locks for the whole of it is out of the question.',
    'Each step has a sensible business undo: release a hold, refund, cancel a booking, give a limit back.',
    'You can live with other readers seeing intermediate states, or can mark those states as pending.',
  ],
  costs: [
    'No isolation. Atomic only in the end (every step happens, or every undoable one is undone), consistent only if you design the compensations to keep it so, durable because each local commit is. Other sagas see the half-done state.',
    'A compensation is a new action, not a rollback. The original is still in the history, and some things cannot be undone at all: an email sent, money sent on Faster Payments. Order the steps so those come at the pivot or after it.',
    'Every step and every compensation must be idempotent, because every message may be delivered twice. That means an idempotency key per command and a stored reply per key.',
    'Compensations must not fail for business reasons. If one fails for a technical reason, it is retried; a step that can never be undone or completed needs a person.',
    'Choreography hides the flow. With no saga log, finding where a saga is stuck means joining every service\'s logs, and adding a step means changing several services.',
    'Isolation countermeasures are extra work: semantic locks (a pending state or a hold), commutative updates (add and subtract instead of setting a value), re-reading a value before changing it, and routing by value (risky amounts take a path with stronger guarantees).',
  ],
  interview: [
    'Define it in one breath: a sequence of local transactions, each with a compensating action, run forwards and, on failure, compensated backwards. No distributed lock.',
    'Say which ACID letters you keep: atomic in the end, consistent by design, durable, and NOT isolated. Then say what you do about isolation: a pending state or hold as a semantic lock.',
    'Name the pivot. Compensatable steps first, then the one step that cannot be undone (submitting the payment), then only steps that are retried until they succeed. Once the pivot commits, the saga must finish.',
    'Make the orchestrator durable: write the saga row before sending, and after every reply. On restart, read the log and resend the current step with the same key. Every service dedupes by key: see the Idempotency keys page.',
    'Publish events or commands with a transactional outbox, so a service never commits its step and then fails to tell anyone: see the Outbox page.',
    'Orchestration versus choreography: an orchestrator gives one place to read the state, change the flow and handle failures, at the cost of a central component. Choreography couples less but spreads the flow, and its failure paths, across services. A common rule of thumb: choreography for two or three steps, an orchestrator beyond that.',
    'Versus two-phase commit, line one: 2PC locks rows at every participant until the decision, so one coordinator failure can block everyone; a saga holds no locks across services and never blocks (see the Two-phase commit page).',
    'Versus two-phase commit, line two: 2PC is atomic and isolated at the cost of availability and latency; a saga gives up isolation and needs compensations written by hand.',
    'Versus two-phase commit, line three: use 2PC inside one database or one vendor\'s stack with short transactions; use a saga across services, teams or companies, and for anything slow.',
  ],
};
