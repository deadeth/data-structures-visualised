import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Two-phase commit makes one transaction commit at several databases or none of them. In phase 1 the coordinator asks every participant to prepare: each one writes "prepared" to its log, keeps its locks and votes yes, or votes no. If every vote is yes, the coordinator writes commit to its own log, and in phase 2 tells everyone. The catch is the yes vote. After it, a participant may not decide alone, so if the coordinator dies at the wrong moment, everyone waits with their locks held.',
  watch: [
    'The magenta chip is the transaction. Follow it from the coordinator to each participant and back.',
    'A yes vote comes after "prepared" is on disk. That record is a promise: whatever crashes next, this participant can still commit.',
    'The amber comparison after phase 1 counts yes votes against participants. Anything short of all of them, a no or a silence, means abort.',
    'The coordinator\'s commit record is the commit point. Before it is on disk the transaction can still abort; after it, it will commit, even if every machine crashes.',
    'Crash the coordinator after logging. A, B and C sit in "prepared" with their locks, ask, get no answer, and wait. Nothing else can touch those rows.',
    'Recover the coordinator. It reads its log, finds commit with no end record, and sends commit again. With Crash coordinator "before", it finds nothing and the answer is abort.',
    'Crash a participant "after": it comes back, finds prepared in its log with no decision, and has to ask. "Before": it finds nothing and rolls back on its own.',
    'Simplified: messages are never lost except to a node that is down, timeouts fire at once, each transaction writes one row per participant, and a no vote is forced by the button rather than by a real check.',
  ],
  complexity: [
    { op: 'Commit, n participants', average: '2 round trips', worst: 'Unbounded', note: '4n messages: prepare, vote, decision, ack. Worst case is a coordinator crash: participants wait until it is back.' },
    { op: 'Forced log writes', average: '2n + 1', worst: '2n + 1', note: 'Each participant forces prepared and then commit; the coordinator forces commit. The end record need not be forced.' },
    { op: 'Abort', average: 'Under 2 round trips', worst: 'Unbounded', note: 'With presumed abort, an abort is not acked and leaves no end record.' },
    { op: 'Lock hold time', average: '2 round trips + 2 forced writes', worst: 'Until the coordinator recovers', note: 'Rows stay locked from the write until the participant hears the decision.' },
    { op: 'Recovery, coordinator', average: 'O(log length)', worst: 'O(log length)', note: 'Scan for commits with no end record and send them again. No record means abort.' },
    { op: 'Recovery, participant', average: 'O(log length) + 1 round trip', worst: 'Unbounded', note: 'Prepared with no decision: retake the locks and ask the coordinator.' },
  ],
  space:
    'One log record per participant per state change, plus the coordinator\'s decision and end records. In memory, the locks of every transaction still in flight, and the coordinator\'s list of commits not yet acked.',
  usedIn: [
    {
      name: 'XA and JTA',
      how: 'X/Open XA is the standard interface between a transaction manager and resource managers such as databases and message brokers: xa_prepare, xa_commit, xa_rollback, and xa_recover to list in-doubt transactions after a crash. Java\'s JTA uses it.',
    },
    {
      name: 'PostgreSQL',
      how: 'PREPARE TRANSACTION, COMMIT PREPARED and ROLLBACK PREPARED let an outside coordinator run 2PC. A prepared transaction survives a restart and keeps its locks until resolved. It is off by default: max_prepared_transactions is 0.',
    },
    {
      name: 'MySQL (InnoDB)',
      how: 'XA START, XA END, XA PREPARE, XA COMMIT, and XA RECOVER for in-doubt transactions. Inside one server, MySQL also uses an internal two-phase commit between the binary log and InnoDB.',
    },
    {
      name: 'Google Spanner',
      how: 'Each shard is a Paxos group. A transaction across groups runs 2PC with one group\'s leader as coordinator. Because coordinator and participants are each replicated, losing one machine does not leave the transaction stuck.',
    },
    {
      name: 'CockroachDB',
      how: 'Each range is a Raft group. A transaction writes intents and a transaction record, both replicated, so a failed node is replaced rather than waited for. Its parallel commits protocol (since 19.2) cuts the commit to about one round of consensus.',
    },
    {
      name: 'Apache Kafka transactions',
      how: 'A transaction coordinator in the broker logs the transaction\'s state to a replicated internal topic, __transaction_state, then writes commit or abort markers into every partition the transaction touched. It is two-phase commit over replicated logs.',
    },
  ],
  reachFor: [
    'You must change data in two or more stores, and a reader may never see one change without the other.',
    'All participants are under your control, speak the same protocol (XA, or a database\'s own), and sit close together on a reliable network.',
    'Inside a distributed database, between shards that are themselves replicated with Raft or Paxos. That removes the blocking problem, which is why Spanner and CockroachDB can afford it.',
    'Transactions are short and touch few rows, so holding locks for two round trips costs little.',
  ],
  costs: [
    'It blocks. A participant that voted yes waits for the coordinator, holding its locks, for as long as the coordinator is down. A single coordinator is a single point of failure.',
    'It is slow: two round trips and 2n + 1 forced disk writes on the critical path, with locks held across the network the whole time. Throughput on hot rows suffers first.',
    'Availability is the product of the participants\' availability: any one participant that is down or slow aborts every transaction it is part of.',
    'Operational pain: in-doubt transactions must be found and resolved after crashes. XA lets an operator make a "heuristic" commit or rollback by hand, which can break atomicity.',
    'Many systems do not support it at all: most message brokers, HTTP APIs and SaaS services. Across services, prefer a saga or the outbox pattern.',
    'Three-phase commit adds a pre-commit round so participants can finish without the coordinator, but it is only safe when message delays are bounded. A network partition can still make it give the wrong answer, so it is rare in practice.',
  ],
  interview: [
    'Say what it promises: atomic commit. Every participant commits or every participant aborts, and commit happens only if all voted yes. It does not give isolation by itself; locks do that.',
    'Name the point of no return: the yes vote. Before it, a participant may abort on its own. After it, it must wait to be told. The coordinator\'s forced commit record is the commit point for the whole transaction.',
    'Explain why it blocks: if the coordinator dies after the votes, a prepared participant cannot tell "commit decided" from "nothing decided", and asking the others does not help if they are all prepared too.',
    'Fix the blocking by replicating the coordinator: run 2PC across Paxos or Raft groups, as Spanner and CockroachDB do. Gray and Lamport\'s Paxos Commit is the textbook version.',
    'Across microservices, avoid it. Use a saga: a chain of local transactions, each with a compensating action to undo it. Say the cost: no isolation, so other readers can see the half-done state.',
    'Use the outbox pattern to update a database and publish an event without 2PC: write the event to an outbox table in the same local transaction, and let a relay or change data capture (Debezium) publish it.',
    'Make participants idempotent. Decisions are resent after crashes, so applying commit twice must be harmless. Key each step by transaction id.',
    'Mention presumed abort: no record at the coordinator means abort, so aborts need no acks and no forced writes. It is why the recovery rule is simple.',
  ],
};
