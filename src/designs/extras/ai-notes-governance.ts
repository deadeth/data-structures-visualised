import type { Extras } from './types';

/**
 * Interview extras for "Trustworthy AI notes across councils and countries".
 *
 * From the content spec of 16 November 2026 (ai-notes-governance.md, section 6). Figures as on the
 * design page: about 100,000 users (an assumption), an assumed 10% recording a day with 2 notes
 * each, so 20,000 notes a day and about 1 a second at peak; 10,000 audio hours a day; about 400
 * tenants in three regions; 106 days live plus 14 days of backups = 120. The design is ours and
 * describes no real supplier's. The rehearsal is 60 minutes.
 */
export const extras: Extras = {
  opening: [
    'Before I draw anything, a few questions. Who are the tenants: one per council, or per team inside a council? What does "stays in its country" cover: storage only, or processing by the speech and language vendors too? Is the council\'s case system the record, with ours a working copy? What is the retention promise, and does it include backups and vendors? And what worries you most: a wrong sentence in a care record, or one council seeing another\'s data?',
    'If you\'re happy, I\'ll assume: a tenant per council; data stored and processed in-country, vendors included; the council\'s case system is the statutory record; everything of ours is gone within 120 days at most, which is the figure in one council\'s published transparency record; and a practitioner approves every note before it leaves.',
    'On scale, I\'d size it from public numbers. Around 100,000 users by your own figures. If one in ten records on a given day and makes two notes, that\'s 20,000 notes a day, about one a second at peak, and around 10,000 hours of audio a day. So writes are small. The hard part is trust: residency, isolation, drafts you can check, an audit trail, and deletion that really happens.',
    'The shape: one global control plane that holds no personal data, just councils, prompt and model releases, and rollout. Then a full, separate stack per country: app, Postgres with row-level security and a tenant id on every row, storage, a key per council, and in-country vendor endpoints on zero-retention terms. Regions pull configuration and send up only counts. Every draft sentence has to cite the transcript, a second model checks it, and a human approves. Every action writes an audit line in the same transaction. Every note is born with a deletion date.',
    'I\'ll walk one note through that, including four ways it goes wrong: a request in the wrong region, an invented safeguarding detail, a prompt release that makes one council\'s drafts worse, and a vendor that keeps data too long. Then how I\'d deliver it and who owns what. Tell me where you\'d like to go deep.',
  ],

  pushes: [
    {
      q: 'Why a control plane at all? Why not three fully separate stacks?',
      a: [
        'Three separate stacks is the safest thing to explain to a regulator, and I\'d start there if the team were tiny.',
        'The cost is drift: three rollouts by hand, a prompt fix that reaches Australia a week late, three sets of release tooling.',
        'The control plane holds only what is not personal: councils and regions, releases, rollout percentages, evaluation results, counts. Regions pull from it; it has no credentials into any region.',
        'If it is down, regions keep drafting on the last configuration. Each region has a local override to pin a release.',
        'The line to police is what counts as configuration. A council\'s own template stays in its region.',
      ],
    },
    {
      q: 'Row-level security, schema per tenant or database per tenant?',
      a: [
        'Shared tables with tenant_id and forced row-level security for the many: one migration, one backup, adding a council is a row.',
        'Schema per tenant: 400 schemas times 10 tables is 4,000 tables to migrate; pools and the catalogue suffer.',
        'Database per tenant: the strongest isolation and no noisy neighbours, but 400 databases to run in three countries and a cost floor per council.',
        'Every primary key starts with tenant_id, so a large or demanding council can be moved to its own database later without a redesign.',
        'Row-level security is the second guard, not the first. The app still filters by tenant; the policy catches the query that forgot.',
      ],
    },
    {
      q: 'How does row-level security fail, and how would you know?',
      a: [
        'A table added without a policy: a migration check fails the build for any table with tenant_id that lacks FORCE ROW LEVEL SECURITY and a policy.',
        'A role that bypasses it: the app and workers connect as a role with no BYPASSRLS; nothing in the request path connects as the owner.',
        'The tenant setting leaking between requests on a pooled connection: SET LOCAL lasts one transaction, and a query with no tenant set errors.',
        'A test suite that calls every endpoint as tenant A and asserts it never returns tenant B\'s ids. And per-note keys, so a leak of rows is ciphertext.',
        'I ran the policies on PostgreSQL 16 for this design: a second tenant saw zero rows and an insert for another tenant was refused.',
      ],
    },
    {
      q: 'A user\'s request lands in the wrong region. What happens?',
      a: [
        'The region refuses it. The token\'s region claim is wrong, the tenant is not in that region\'s table, and the schema cannot hold a foreign tenant\'s row.',
        'It answers 421 and reads no body. It does not forward or redirect: forwarding passes the data through the wrong country.',
        'It alerts, because it means routing is broken. The cost is an outage for that user until routing is fixed. I choose the outage.',
      ],
    },
    {
      q: 'What exactly is global, and what never leaves a region?',
      a: [
        'Global: code, container images, base prompts and releases, the council directory (name, domain, region), rollout percentages, scripted evaluation cases, daily counts.',
        'Regional only: audio, transcripts, drafts, approved text, user accounts and emails, council templates, audit lines, vendor call records, keys, backups.',
        'Upward traffic is counts per council, day, template and release. No ids, no text.',
        'Support staff are the hard case: see the support access question.',
      ],
    },
    {
      q: 'How do you stop one large council slowing everyone else?',
      a: [
        'A per-council cap on running jobs in the queue\'s claim query: 8 by default, and the council with the fewest running goes first.',
        'Per-council rate limits on the API and on vendor calls, so one council cannot use the whole vendor quota.',
        'Statement timeouts in the database. Largest councils can move to their own worker pool or their own database.',
        'I tested the claim query: with another council at its cap and 300 waiting, a new council\'s single job was picked next.',
      ],
    },
    {
      q: 'How does the grounding check actually work?',
      a: [
        'The drafting model must return each sentence with the transcript segment numbers it used. No citation means unsupported.',
        'Mechanical checks first: the segments exist; names, numbers, dates and medicines in the sentence appear in them.',
        'Then a second model, with a narrow question: do these segments support this sentence? Supported, partly, unsupported or contradicted.',
        'And the reverse: segments tagged as high risk that no sentence cites are raised as possible omissions.',
        'It flags and never deletes. High-risk flags must be resolved before the database will accept an approval.',
        'I\'d say plainly that this is my design. I have seen nothing public about how your team checks drafts.',
      ],
    },
    {
      q: 'The checker is another LLM. Why trust it?',
      a: [
        'I don\'t fully. It has a miss rate and a false-alarm rate, and both are measured: people re-check a weekly sample of approved notes against audio, inside the council\'s governance.',
        'It is asked an easier question than the drafter: one sentence, a few segments, yes or no.',
        'Where possible it is a different model from the one that wrote the draft.',
        'The human is still the final control. The checker\'s job is to aim their attention.',
        'If flags are too many, people stop reading them, so the flag rate is itself watched.',
      ],
    },
    {
      q: 'People will just click approve. Is human-in-the-loop a real control?',
      a: [
        'On its own, no. Fluent text gets trusted.',
        'So friction goes where the risk is: each high-risk flag must be resolved, with the audio one click away.',
        'Two cheap signals show rubber-stamping: review time against note length, and edit distance near zero across a team.',
        'A practice lead samples approved notes each week. That is a practice control the product supports, not one it can replace.',
        'The record says who approved, and whether flags were kept, edited or removed.',
      ],
    },
    {
      q: 'How do you evaluate a prompt change before anyone sees it?',
      a: [
        'Scripted conversations written with practitioners and recorded by actors with a range of accents. No real recordings: they are deleted within 120 days and are not ours to keep.',
        'Each case lists facts the draft must include and must not include. Scores: fact recall, unsupported-sentence rate, critical misses.',
        'Sets per template and per language or locale, and a small set per council template.',
        'A red-team set of about 40 cases with a zero-miss gate: denials, disclosures, third parties, several cases in one meeting, a speaker who tells the AI to ignore its instructions.',
        'Evaluation runs in each region through the production code path, so in-country endpoints and each council\'s template are exercised.',
      ],
    },
    {
      q: 'Evaluation passed and it was still worse in production. Now what?',
      a: [
        'That is what the canary is for. One opted-in council, 25% of its notes, compared with the other 75% on the same day and template.',
        'Signals: unsupported rate, median edit distance, review time. A blunt automatic halt: twice the baseline on 500 or more sentences.',
        'Rollback is two row changes; regions pull it within 60 seconds.',
        'The audit log lists exactly which notes the bad release wrote. Unapproved ones are redrafted; the council gets the list of approved ones.',
        'Then the failure is re-created as a scripted case and added to the set, for every template like it.',
      ],
    },
    {
      q: 'The vendor silently changes the model. How do you notice?',
      a: [
        'Releases pin dated snapshots, never an alias such as "latest".',
        'A nightly run of 50 evaluation cases per region against the live release; a shift with no release change means something moved underneath.',
        'When a vendor retires a snapshot, moving to the next one is a release like any other: evaluate, canary, rings.',
      ],
    },
    {
      q: 'What is in the audit trail, and how is it tamper-proof?',
      a: [
        'One line per action: generated (with release), flags, opened, edited, approved, exported, held, deleted, support access, refusals. Who, when, which note, which release.',
        'Written in the same transaction as the action, through a function that is the only way in. The app role cannot insert, update or delete directly.',
        'Hash-chained per council; the latest hash is copied hourly to storage locked against deletion.',
        'It is tamper-evident, not tamper-proof: a superuser could alter the table, and the sealed hash would show it.',
        'It holds versions and a keyed fingerprint of the text, never the text, so it can outlive the note.',
      ],
    },
    {
      q: 'How do you really delete within 120 days, including backups?',
      a: [
        'Every note is created with a delete_after date. A worker deletes audio, then rows, and writes a receipt.',
        'Live retention is capped at 106 days because backups are kept 14: nothing is older than 120 anywhere we control.',
        'After any restore, deletion receipts newer than the backup are replayed before traffic is allowed.',
        'Storage has a 120-day lifecycle rule as a backstop. An alarm fires if any note is a day overdue.',
        'When a council leaves, its data is deleted and then its key is destroyed, which also makes backup copies unreadable.',
      ],
    },
    {
      q: 'And the copies at the speech-to-text and LLM vendors?',
      a: [
        'I cannot delete inside a vendor. The controls are contract and choice: in-country endpoints, zero-retention terms, no training, audit rights, notice of incidents.',
        'Every call is recorded: vendor, purpose, endpoint region, retention terms, request id, time. No content.',
        'Detection: weekly tracer recordings and a monthly reconciliation against whatever the vendor lets us list. I\'d be honest that many vendors expose little.',
        'If a vendor is found keeping data: switch that region to the fallback by a new release, demand deletion in writing, give each council its list of affected notes.',
        'The long-term fix is fewer sub-processors: self-hosted speech to text first.',
      ],
    },
    {
      q: 'Legal hold and consent withdrawal: don\'t they conflict with deletion?',
      a: [
        'Consent withdrawn: delete now, same path, with a receipt. One council\'s published record already describes deleting the recording if someone objects.',
        'Legal hold: the council, as controller, tells us to keep one note. It has a named person, a reason and a review date, and the worker skips it.',
        'A hold is the one way past 120 days, so it is visible in the audit log and reported monthly to the council.',
        'Text already in the case system is the council\'s to handle under its own rules.',
      ],
    },
    {
      q: 'Today it\'s copy and paste. How would you integrate with case management systems?',
      a: [
        'In order: structured copy by section and an export file now; a pull API for councils with integration teams; write-back per case system last.',
        'Write-back writes an unsigned draft to a case the practitioner picked, with an idempotency key of note id and version, through an outbox with retries.',
        'The risks: a note on the wrong person\'s file, holding credentials to a statutory system, one connector per supplier and version, and losing the last human look.',
        'I\'d want one design partner council and its case system supplier before building any connector.',
      ],
    },
    {
      q: 'How do the supplier\'s own support staff get access to a council\'s data?',
      a: [
        'By default they have none. Support works from ids, statuses and audit lines.',
        'Break-glass access: requested for one tenant and a stated reason, approved by a second person, time-limited to an hour, and written to that council\'s audit log as actor kind "support".',
        'Support for a country is done by staff permitted for that country\'s data; a UK engineer has no path into the Australian region.',
        'Screening staff to BS7858 is a people control alongside these.',
      ],
    },
    {
      q: 'Where do UK GDPR and the certifications change the design?',
      a: [
        'The council is the controller and we are its processor, so the design gives the council the levers: retention period, holds, who its users are, audit access, export.',
        'Each council needs a DPIA. One council\'s, for a product of this kind, was approved in 2025. The system should hand over the evidence: data flows, sub-processors per region, retention settings, the release history.',
        'Sub-processors are listed per region and changing one is a notified change.',
        'A supplier of this kind typically claims ISO 27001, Cyber Essentials Plus, the NHS Data Security and Protection Toolkit and an annual CREST penetration test. Those ask for access control, logging, change management and supplier management, which map onto break-glass, the audit log, releases and the vendor record.',
        'For the US and Australia I\'d only claim what is public: data stays in-country. I would ask what else applies.',
      ],
    },
    {
      q: 'It\'s a Rails monolith today. How do you get there without stopping the product?',
      a: [
        'Add tenant_id and policies table by table, in permissive mode first (log what would be refused), then enforce.',
        'Stand up the second region as a fresh deployment for new customers there. Move nobody across regions unless they must be.',
        'Add the audit function and call it from the existing code paths before changing anything else.',
        'Add the grounding check in shadow: compute flags, show them to nobody, measure the rates. Then show them.',
        'Pull releases out of code into the release table last, with the current prompt as release 1.',
      ],
    },
    {
      q: 'What would you cut if you had one quarter and five engineers?',
      a: [
        'Keep: tenant isolation with policies, the audit line in the transaction, deletion with receipts, pinned releases with a per-council rollback. Those are the promises.',
        'Simplify: no control plane yet; releases shipped as configuration per region. Citations and mechanical checks before the second-model check.',
        'Defer: write-back, per-note keys (start with per-council), vendor reconciliation beyond the call record, automatic halts (alert a person first).',
        'I\'d say which risks that leaves open and who has accepted them.',
      ],
    },
    {
      q: 'What does it cost, and what drives the cost?',
      a: [
        'Vendor usage dominates: about 10,000 audio hours and about 340 million tokens a day at my assumed volume. The grounding check is roughly half the tokens.',
        'Then the fixed cost of three regions: each needs a database with a standby, storage, workers and on-call cover, even at 1,000 notes a day.',
        'Storage is small: about 8 TB of audio at the 30-day default.',
        'I would not quote prices from memory. I\'d price it from current rate cards and track cost per note by council.',
      ],
    },
  ],

  lead: {
    phases: [
      { name: '1. Isolation and evidence', ships: 'tenant_id and forced row-level security on every table; tenant set per transaction; the audit function called from every action; cross-tenant tests in the build.', why: 'These are promises already made to councils. They change no behaviour a user sees, so they can ship first and quietly.' },
      { name: '2. Deletion you can prove', ships: 'delete_after on every note; the Retention worker with holds, receipts and the overdue alarm; backups at 14 days and the 106-day ceiling; the vendor call record.', why: 'The 120-day promise is public in a council\'s transparency record. It should be provable before anything new is built.' },
      { name: '3. Releases and rollback', ships: 'Immutable releases with pinned models; the release number on every note; per-council rollout percentages; evaluation sets for the base templates; a manual rollback that takes a minute.', why: 'Nothing about quality can be managed until every draft says what wrote it and a change can be undone for one council.' },
      { name: '4. Grounding and review', ships: 'Citations in the draft; mechanical checks; the second-model check in shadow, then visible; the omission check; high-risk flags that block approval; edit distance and review time.', why: 'The largest gain in safety, and the largest change for practitioners. It needs the release machinery to roll out safely and design partner councils to tune the flags.' },
      { name: '5. Control plane and regions as a product', ships: 'The global directory and router; regions pulling releases and sending counts; canary rings and the automatic halt; per-council keys with key destruction on exit.', why: 'Worth building once there are three live regions and weekly releases. Before that, per-region configuration is enough.' },
      { name: '6. Integration', ships: 'Structured export file; a pull API; one write-back connector with a partner council and its case system supplier.', why: 'It saves practitioners the most time and carries the most risk of a note on the wrong file. It comes last, on top of the audit trail and approvals.' },
    ],
    migration: [
      'Start from a typical stack for a small UK product team: a Rails and PostgreSQL application with background jobs. Assume one database per country already exists, since data is held in-country. Confirm both with the interviewer.',
      'Add tenant_id to every table and backfill. Turn on policies in a logging mode first: record every query that would have been refused, fix them, then enforce table by table.',
      'Call audit.append from existing code paths before changing them. The log starts at a known date and says so; it does not pretend to cover the past.',
      'Give every existing note a delete_after from its creation date. Run the Retention worker in report-only mode for a week and compare with the current deletion job before letting it delete.',
      'Record the current prompt and model as release 1 for every council. No behaviour changes; every new note now says what wrote it.',
      'Run the grounding check in shadow on live drafts for a month to learn the baseline flag rate per template before any practitioner sees a flag.',
      'Introduce flags with three design partner councils, then by ring. Tell each council before its practitioners see a change, and update the material it needs for its DPIA.',
      'Move encryption to per-council keys by re-wrapping data keys in the background. No downtime; old and new are both readable during the move.',
    ],
    slos: [
      { name: 'Availability of the app, per region', target: '99.5% a month', why: 'A typical G-Cloud target for this kind of service (assumption). That is 3.6 hours a month. Practitioners can fall back to writing notes by hand, so this is honest, not heroic.' },
      { name: 'Draft ready after upload', target: '95% within 5 minutes for a 30-minute recording', why: 'The practitioner is waiting between visits. Past 10 minutes they start typing instead.' },
      { name: 'Deletion on time', target: '100% of notes deleted within 24 hours of their date; zero data older than 120 days', why: 'This is a promise in public documents, not a performance figure. One miss is an incident.' },
      { name: 'Audit completeness', target: '100% of actions have a line; chain verified hourly with zero breaks', why: 'The trail is only worth having if it is complete.' },
      { name: 'Isolation', target: 'Zero cross-tenant reads; zero accepted wrong-region requests', why: 'Measured by the cross-tenant test suite on every build and a daily synthetic probe that tries both.' },
      { name: 'Draft quality', target: 'Unsupported-sentence rate and median edit distance per council within their baseline band; zero critical misses on the red-team set for any live release', why: 'These are the numbers a release is gated on, so they are the numbers to promise internally.' },
      { name: 'Rollback time', target: 'A release rolled back for a council within 5 minutes of the decision', why: 'Pull every 30 seconds makes 60 seconds typical. Five minutes leaves room for a control plane fault and the local override.' },
    ],
    oncall: [
      'Pages at once: any accepted cross-tenant read or wrong-region write (should be impossible); the audit chain failing verification; a note more than 24 hours past its deletion date; a region\'s app or database down; the key service unreachable in a region.',
      'Pages in working hours for the AI on-call: an automatic halt has fired; a red-team case fails on the nightly run of the live release; a vendor\'s error rate is over 5% for 10 minutes and the fallback is carrying traffic.',
      'Waits for the morning: one council\'s edit distance drifting up over a week; evaluation run slower than usual; a vendor tracer still findable (it becomes urgent once confirmed); legal holds past their review date.',
      'Each region has its own rota or a follow-the-sun rota of people cleared for that region\'s data. Nobody debugs Australian data from a UK laptop.',
      'A wrong sentence reported by a practitioner is a product incident with its own path: reproduce on a scripted case, check the release, add the test. It is not paged unless it is a safeguarding matter at volume.',
    ],
    teams: [
      { name: 'Platform (tenancy, regions, keys)', owns: 'The regional stacks, the control plane and router, row-level security and its build checks, keys, backups and restores.' },
      { name: 'Notes product', owns: 'The app, upload, review screen, templates, export and integrations. The practitioner\'s experience of flags.' },
      { name: 'AI quality', owns: 'Releases, prompts, evaluation sets and the red-team set, the grounding check, rollout rules and the halt thresholds. Works with prompt engineers and a practitioner adviser.' },
      { name: 'Trust (security and data protection)', owns: 'The audit log\'s rules, retention and deletion policy, sub-processor contracts and the vendor record, DPIA evidence packs, break-glass approval. Includes the data protection officer.' },
      { name: 'Each council', owns: 'Its users, its templates, its retention period, its legal holds, sampling approved notes, and the statutory record in its case system. It is the controller.' },
      { name: 'Customer success', owns: 'Onboarding a council: identity provider setup, template set-up, canary agreements, telling councils about changes.' },
    ],
    buildBuy: [
      { part: 'Speech to text and the LLM', call: 'Buy, with a path to self-host speech to text', why: 'Vendor models are better than anything a team this size could train. Speech to text is the likeliest to bring in-house, since open models exist and it removes a sub-processor from the audio.' },
      { part: 'Grounding check', call: 'Build', why: 'It is the product\'s claim to being trustworthy and depends on our templates and risk topics. It uses a bought model underneath.' },
      { part: 'Evaluation sets and red-team cases', call: 'Build', why: 'They encode what a good social care note is. Nobody sells that. Written with practitioners.' },
      { part: 'Identity broker', call: 'Buy', why: 'Hundreds of council identity providers with their own settings. One council\'s published record lists a hosted identity service as the authentication sub-processor.' },
      { part: 'Key management and object storage', call: 'Buy from the cloud provider, in-region', why: 'Nobody should build a key service.' },
      { part: 'Job queue', call: 'Use the database', why: 'One job a second. A PostgreSQL-backed queue is already in the assumed stack.' },
      { part: 'Audit log', call: 'Build, small', why: 'One table, one function, one sealing job. A bought product would hold data outside the region\'s database and still need the same transaction rule.' },
      { part: 'Rollout and feature flags', call: 'Build the release table; buy a flag tool for ordinary product flags', why: 'Releases need evaluation gates and audit that flag tools do not have. Ordinary flags do not need building.' },
      { part: 'Case system connectors', call: 'Partner', why: 'Each needs the case system supplier\'s API and goodwill. Build one with a partner council before deciding on the rest.' },
    ],
    cost: [
      'AI vendor usage is the largest variable cost: about 10,000 audio hours and about 340 million tokens a day at the assumed 20,000 notes. The grounding check is about half of the tokens. Track cost per note by council and template.',
      'Three regions each carry a fixed cost whatever their volume: a database with a standby, workers, storage, monitoring and an on-call rota of cleared people. Australia at an assumed 1,000 notes a day costs nearly what the UK does to run.',
      'Evaluation is not free: a full UK run is about 2,920 cases, about 15% of a day\'s production tokens. Run the full set per release and 50 cases nightly.',
      'Storage is minor: about 8 TB of audio at the 30-day default, about 30 TB if every council chose the 106-day ceiling.',
      'Headcount, as a starting point for discussion: platform 4, notes product 6, AI quality 4 including a prompt engineer, trust 2 plus the data protection officer. About 16 engineers. This is my sizing, not the interviewer\'s.',
      'Prices are not quoted on this page. They change often and none were checked.',
    ],
    risks: [
      { risk: 'A wrong draft causes harm despite review, and the press or a regulator asks what controls existed.', answer: 'The grounding check, blocking flags, the audit trail and release history are the answer, and they must exist before the question is asked. Publish the evaluation method to councils. Sample approved notes.' },
      { risk: 'Flag fatigue: practitioners learn to dismiss flags.', answer: 'Keep the high-risk list short. Watch the share of flags resolved as "kept" in under five seconds. Tune with partner councils.' },
      { risk: 'A cross-tenant leak through a path outside the policies: a report, an export job, a support tool.', answer: 'No role in any request or job path bypasses row-level security. Per-note keys. The cross-tenant test suite covers jobs and exports as well as endpoints.' },
      { risk: 'A vendor withdraws an in-country endpoint or changes its terms.', answer: 'Two vendors per stage per region where possible, switched by a release. A self-hosted speech model as the fallback of last resort.' },
      { risk: 'The control plane becomes a quiet store of personal data: someone adds a council user list or sample notes to it.', answer: 'A schema review rule: no table in the control plane may hold a user id or free text from a note. Counts only, checked in code review and by a scan.' },
      { risk: 'Legal holds grow until "120 days" is fiction.', answer: 'Each hold has a review date and an owner. A monthly report to each council lists its holds. Count them on the trust dashboard.' },
      { risk: 'The team cannot run three regions well.', answer: 'Identical stacks from one definition, one deploy pipeline with three targets, and a fourth region only when a contract pays for it.' },
      { risk: 'Write-back files a note on the wrong person.', answer: 'Unsigned drafts only, to a case the practitioner chose, one connector with one partner first, and an off switch per council.' },
    ],
  },

  rehearsal: [
    {
      stage: 'Clarify and set defaults', minutes: 5,
      prompt: 'Ask what changes the design, then state your defaults and move on. The round is taken to be one hour.',
      cover: [
        'Tenant per council? Residency for storage only, or processing and vendors too? Is the case system the record?',
        'Retention: 120 days at most, including backups and vendors? Who approves a note?',
        'Which worries them more: wrong content or data crossing a boundary?',
        'Defaults: tenant per council, in-country including vendors, case system is the record, 120 days everywhere, a practitioner approves every note.',
      ],
    },
    {
      stage: 'Numbers', minutes: 4,
      prompt: 'Size it aloud from public figures and say which are assumptions.',
      cover: [
        'About 100,000 users (assumption); 10% record a day, 2 notes each: 20,000 notes a day; about 1 a second at peak.',
        '10,000 audio hours a day; 400 GB of audio a day; 8 TB at 30 days.',
        'About 240,000 audit lines a day. About 400 tenants.',
        'Conclusion: writes are small. The problem is trust, not throughput.',
      ],
    },
    {
      stage: 'The shape', minutes: 8,
      prompt: 'Draw the global row, then one region, then the vendors outside it.',
      cover: [
        'Global: router with a council directory; control plane with releases and rollout. No personal data. Regions pull.',
        'Region: app, Postgres with row-level security, audio store, key per council, pipeline with a fair queue, grounding check, audit log, retention worker.',
        'Outside: the council\'s identity provider, AI vendors at in-country endpoints, the council\'s case system.',
        'Say the three other-region facts: same stack, separate accounts, no path between them.',
      ],
    },
    {
      stage: 'Tenancy and residency', minutes: 8,
      prompt: 'Go deep on isolation between councils and between countries.',
      cover: [
        'Routing by customer, not by location. The region re-checks and refuses with 421.',
        'Row-level security against schema or database per tenant, and when you would move a council out.',
        'Tenant set per transaction; no role bypasses; the build check for tables without policies.',
        'Per-council keys, per-note data keys, key destruction on exit. Noisy neighbours and the per-council cap.',
      ],
    },
    {
      stage: 'AI quality controls', minutes: 12,
      prompt: 'This is the heart of it. Walk the invented safeguarding sentence from draft to flag to fix.',
      cover: [
        'Citations per sentence; mechanical checks; second-model support check; omission check; flags that block approval.',
        'Human as final control, and why that alone is weak: targeted friction, review time, edit distance, sampling.',
        'Evaluation sets per template and language, scripted not real; red-team set with a zero-miss gate.',
        'Immutable releases with pinned models; canary council at 25%; halt rule; rollback in under a minute; the miss becomes a test.',
      ],
    },
    {
      stage: 'Audit, retention and vendors', minutes: 9,
      prompt: 'Show that the promises can be proved.',
      cover: [
        'Audit line in the same transaction; append-only; hash chain; sealed hourly; no text, a keyed fingerprint.',
        'delete_after on every note; 106 + 14 = 120; receipts; replay after restore; legal hold; consent withdrawal.',
        'Vendors: in-country, zero retention, a row per call, tracers and reconciliation, and what you do when one is caught.',
      ],
    },
    {
      stage: 'Integration and compliance', minutes: 5,
      prompt: 'Be practical about the case system and specific about what regulation changes.',
      cover: [
        'Today: copy and paste, no API in the listing. Next: structured export, pull API, then write-back as an unsigned draft.',
        'SSO through the council\'s identity provider; leavers; break-glass support access.',
        'Controller and processor; DPIA evidence; sub-processor lists per region; the certifications a supplier lists and what they ask of the design.',
      ],
    },
    {
      stage: 'Deliver and run it', minutes: 6,
      prompt: 'The engineering-leader view: order, ownership, what pages.',
      cover: [
        'Order: isolation and audit, deletion, releases, grounding, control plane, integration. Say why that order.',
        'Shadow first: policies in logging mode, the checker unseen for a month.',
        'Teams: platform, notes product, AI quality, trust. The council owns its users, templates, holds and the record.',
        'Pages: cross-tenant read, chain break, overdue deletion, region down. A halt goes to the AI on-call in hours.',
      ],
    },
    {
      stage: 'Your questions', minutes: 3,
      prompt: 'Ask what you would need to know to do the job.',
      cover: [
        'Which cloud is current?',
        'How are drafts checked today, and what do councils ask for most?',
        'Is any case system integration live, and with which supplier?',
        'How many engineers, and who owns evaluation?',
      ],
    },
  ],
};
