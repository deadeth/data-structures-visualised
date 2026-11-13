# Brief: show what each connection looks like

Repo: /home/claude/data-structures-visualised. Read CLAUDE.md first (writing style, "do not claim what was not checked").

Each design page draws connections between boxes: SQL, Kafka, REST or HTTPS calls, gRPC, S3 PUT and GET, Redis, CDC, ISO 8583, in-process calls and so on. A connection's panel says in words what travels. The owner wants to SEE it: the statement, the request and response, the message schema and one example message. Your job is to write that for EVERY connection (every entry in `flows`) in ONE design file, named in your prompt.

Type (src/designs/types.ts, already extended; do not edit it):
```ts
interface Example { title: string; lang: 'sql' | 'json' | 'proto' | 'http' | 'text'; code: string; note?: string }
Flow.examples?: Example[]
```
The page shows each as a labelled block of monospaced text, under "What it looks like".

## What to write, by kind of connection
Write one to three blocks per flow, enough to show the call and what comes back.
- SQL (reads, writes, transactions): the actual statements, with the page's table and column names. Where the flow is one transaction, show BEGIN to COMMIT. A second block with the table definition only where the columns are the point.
- Kafka or any log: a "Topic and key" block (topic name, key, partitions if the page gives them, what the key buys), then a "Message value" block with one example message as JSON. Add a schema block (Avro or JSON Schema) only if it stays under about 20 lines; otherwise the example is enough.
- REST or HTTPS: a "Request" block (method, path, the headers that matter such as Idempotency-Key, JSON body) and a "Response" block (status line, body). Use lang 'http'.
- gRPC: a "Service definition" block in proto3 (the rpc and its request and response messages, the fields that matter), then an "Example call" block showing one request and reply as JSON-like text, with the deadline if the page gives one.
- S3 PUT or GET: the request line and key layout ("PUT /bucket/prefix/..."), the headers that matter, and what is in the object.
- Redis or another cache: the commands, one per line, with a comment line saying what each returns.
- CDC: the change event as the relay emits it (table, operation, before and after), as JSON.
- Card network messages (ISO 8583): a field list as text, "MTI 0100" then the fields the page names with example values. Use only message types and field numbers the page already states.
- Push, SMS, email providers: the payload sent to the provider, as JSON or text.
- In-process calls: the function signature and one call, as text. Keep it to a few lines.
- Flows with a reply (`reply`): show both directions.
- Recovery or cold paths: the same treatment.

## Rules
- Use the page's own story: the same names, ids, amounts and numbers as the tour, the components and the glossary (for example the same account, the same payment id, the same amounts in the same units). Read the whole file first. If the tour follows one payment or URL, the examples follow the same one, so a reader can trace it from line to line.
- Keep each block short: at most about 25 lines, lines at most 72 characters. Show the fields that matter to the design (keys, idempotency, versions, epochs, amounts, statuses) and leave the rest out. No "..." fillers longer than one line.
- These are illustrations of shape, written for this page. Do not copy any real company's API. Do not present invented field names as a real product's schema: where a real protocol is involved (Kafka, S3, ISO 8583, FCM, APNs) keep to parts you are sure of and that the page already relies on, and keep the rest generic. List in your report anything a careful reader might want checked.
- Consistency: field names used in one flow must match the next flow that carries the same thing (the event a relay publishes is the event a consumer reads). SQL must be valid for the database the page names and must agree with the statements the page already describes in words.
- `note` (optional, one sentence) says what to notice: the key that makes a retry safe, the condition that prevents an overdraft, the field that carries order.
- TypeScript: write `code` as a template literal (backticks) so it can span lines; escape any backtick or `${` inside it. No tabs; two-space indents. Plain British English in titles and notes; no em dashes.
- Edit ONLY your design file, and only by adding `examples` to flows. Do not change any other text. No git commands at all.

## Check before you report
- `npx tsc --noEmit` clean (run from the repo root).
- Counts: flows, flows with `examples`, blocks in total, longest line, longest block. All flows must have examples.
- Look at it: `node .shots/ex-look.mjs <design-id>/f/<flow-id> [more routes]` writes a screenshot of each connection's panel at 1440 and 390 into .shots/ and prints whether the page scrolls sideways; open at least three with the Read tool (one SQL, one log, one request and response).
- Re-read your examples against the page once more for mismatched names or numbers.

## Report (final message, under 250 words)
Counts, the story the examples follow, anything worth checking, and anything on the page your examples could not be made consistent with.
