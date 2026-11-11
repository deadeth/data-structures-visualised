import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'An idempotency key makes a retried request safe. The client makes one random key per payment and sends it with every attempt. The server stores the key, a hash of the request and the response in the same transaction as the payment, so a retry finds the row and gets the first answer back instead of paying again. This page simplifies to one account, one amount field, one database and a clock in hours.',
  watch: [
    'The tour starts on a server with no keys. The response to a £40 payment is lost, the client cannot tell whether it worked, it retries, and order 2 is charged twice. The second payment row turns red.',
    'With keys, the same lost response ends differently. The retry\'s insert hits the unique index, the stored hash matches, and the stored 201 comes back. "Replays served" goes up; "Payments applied" and the balance do not.',
    'The key row and the payment commit in one step. Crash the server before the commit and both vanish; crash it after and both survive. Either way the retry under the same key does the right thing.',
    'Two copies at once: copy 2\'s insert waits on the unique index while copy 1\'s transaction is open, then finds the committed row and replays it.',
    'Same key, new amount: the hashes differ and the server answers 422. It neither charges nor replays.',
    'Retry with a new key: the server sees a key it has never stored, so it charges again. Keys only work when the client makes the key once, before the first attempt.',
    'Retry after expiry: the row is pruned after 24 hours, a retry 25 hours late looks new, and the order is charged twice.',
  ],
  complexity: [
    { op: 'First request', average: 'O(1) + 2 writes', worst: 'O(log n)', note: 'One unique-index insert into the key table, one payment row, one update of the key row, all in one commit. n is the number of keys kept.' },
    { op: 'Retry (replay)', average: 'O(1) reads', worst: 'O(log n)', note: 'The failed insert and one read of the stored row. Nothing is written.' },
    { op: 'Concurrent duplicate', average: 'One wait', worst: 'As long as the first transaction', note: 'The second insert blocks on the unique index until the first commits or rolls back.' },
    { op: 'Pruning', average: 'O(expired)', worst: 'O(n)', note: 'A background delete of rows older than the window, best done through an index on the creation time.' },
  ],
  space:
    'One row per key for as long as the window: the key (a UUID is 36 characters as text), a hash, a status, the stored response and a timestamp. At 100 payments a second and a 24-hour window that is 8.64 million rows. With a 2 KB stored response that is about 17 GB, so store a compact response or a pointer to the payment, not the whole body.',
  usedIn: [
    {
      name: 'Stripe',
      how: 'Every API v1 POST accepts an Idempotency-Key header. Stripe saves the status code and body of the first request once the endpoint starts running, including 500 errors, and replays them on a retry with the header Idempotent-Replayed: true. It compares the parameters with the original and errors if they differ. Keys are kept for at least 24 hours; a key reused after it is pruned starts a new request. A request that clashes with one still running under the same key gets 409 Conflict. Its API v2 uses a 30-day window.',
    },
    {
      name: 'IETF Idempotency-Key header draft',
      how: 'An Internet-Draft, not yet an RFC (version 07, October 2025), that standardises the header for POST and PATCH. It says a server SHOULD answer 400 when the key is missing, 422 when a key is reused with a different payload, and 409 when a request with the same key is still being processed. A fingerprint of the payload is optional, and the server should publish its expiry policy.',
    },
    {
      name: 'HTTP itself',
      how: 'RFC 9110 defines GET, HEAD, PUT, DELETE, OPTIONS and TRACE as idempotent and POST as not. That is why a key is needed on POST /payments and not on PUT /accounts/7/limit.',
    },
    {
      name: 'Kafka idempotent producer',
      how: 'The same idea one layer down. The broker gives each producer an id and each batch a sequence number per partition, and drops a batch it has already written when the producer retries after a lost acknowledgement.',
    },
    {
      name: 'Brandur Leach, "Implementing Stripe-like Idempotency Keys in Postgres" (2017)',
      how: 'A worked design for requests that also call outside services and so cannot fit in one transaction. The work is split into atomic phases, each its own transaction, and the key row records how far the request got so a retry resumes from there.',
    },
    {
      name: 'The outbox and saga pages, and the ledger design, on this site',
      how: 'The outbox page writes an event in the same transaction as the change, the same trick as storing the key with the payment. Its relay delivers at least once, so its consumers store each event id the same way. On the saga page every command carries a key and each service stores the key with its reply in one local transaction. The ledger design inserts the key in the same transaction as the ledger entries and the outbox row.',
    },
  ],
  reachFor: [
    'Any POST that moves money, sends a message or creates something a customer would notice twice: payments, transfers, orders, refunds, emails.',
    'Any client that retries on its own: a mobile app on a flaky network, an SDK with automatic retries, a job queue, a proxy.',
    'Consumers of a message log. Delivery is at least once, so the consumer records each event id in the same transaction as its effect and skips ids it has seen.',
    'Calls you make to a provider. Pass your own key, or one derived from it, through to the card processor or bank, so a retry of your request does not become a second charge downstream.',
  ],
  costs: [
    'It is not needed when the operation is naturally idempotent. "Set the limit to £500" (PUT) or "mark invoice 7 paid" gives the same result however often it runs. Prefer that shape when you can design for it.',
    'A write on every request and a table that grows with traffic until it is pruned.',
    'The key must live in the same database transaction as the effect. A key in Redis and a payment in Postgres can disagree after a crash: key saved and payment lost, so the retry is told it is done and the customer is never charged; or payment saved and key lost, so the retry charges again. A cache in front is fine as a fast path, never as the only record.',
    'It cannot fix a client that makes a new key per attempt, a key reused for a different payment, or a retry later than the window. Those are client rules, and the server can only catch the second one.',
    'A request that calls an outside service cannot keep a transaction open across the call. Commit an in-progress row first, answer duplicates with 409, and record each step so a retry can resume. That is much more work than the single transaction shown here.',
    'Keys are only unique within a scope. Scope them per account or per API key, or two customers who both send "order-1" will collide.',
  ],
  interview: [
    '"Exactly once" over a network is not something you can buy. What you build is at-least-once delivery, because the client retries until it hears back, plus idempotent handling on the server, so the second delivery has no effect. Together they look like exactly once.',
    'Say where the key is stored and why: in the same transaction as the payment, with a unique index on the key. Then a crash before the commit loses both and a crash after keeps both. There is no moment when one exists without the other.',
    'Store a hash of the request with the key and compare it on a retry. Same key and same body is a retry: replay. Same key and a different body is a bug: reject with 422 and do not replay, or you would confirm a payment of the wrong amount.',
    'On a replay return exactly what the first request returned, the same status and body, and mark it as a replay (Stripe uses Idempotent-Replayed: true). Do not return 409 for a finished request; the client needs the original answer.',
    'Two copies in flight at once: in one transaction, the unique index makes the second wait and then replay. If the work calls a provider, commit an in-progress row first and answer the second copy with 409, and the client retries later.',
    'The key is made by the client, once per intended payment, before the first attempt, and saved with the order so a restarted client resends the same key. A key made inside the retry loop protects nothing.',
    'The window must be longer than any client will keep retrying. Stripe keeps keys for at least 24 hours and tells clients to stop retrying after 24 hours and reconcile instead. Choose the window, then make the client\'s retry policy end before it.',
    'Carry the guarantee end to end. If your server calls a card processor, send it an idempotency key tied to yours. Otherwise your retry is safe and the processor\'s is not.',
    'For a message consumer, the event id is the key: insert it into a processed_events table with a unique constraint in the same transaction as the effect, and skip the event when the insert fails.',
  ],
};
