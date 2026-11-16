import type { Extras } from './types';

/**
 * Interview extras for "AI case notes: from a recorded visit to a reviewed note".
 *
 * From a content spec of 16 November 2026, section 6.
 * Figures as on the design page: 100,000 workers (assumption), 20% recording a week, 2 recordings
 * each, 45 minutes: 40,000 recordings and 30,000 audio hours a week (assumptions); 40 uploads a minute
 * at an assumed 3 times peak; about 56 cents an audio hour in vendor cost (assumed prices).
 * Everything here is this design's; it describes no real supplier's architecture.
 */
export const extras: Extras = {
  opening: [
    `Before I draw anything, some questions. Who records, and on what: a council phone, a laptop, in a browser? How long is a typical visit, and how bad is the signal? How is consent given, and what happens if someone withdraws it halfway through? Which languages? How quickly does the worker need the draft? Does each council have its own template? And must the worker review the note before it goes anywhere?`,
    `If you're happy, I'll assume this. Council devices, a web app, visits of 30 to 90 minutes, often with no signal. Verbal consent first, and a withdrawal means delete. English first. A draft within ten minutes of upload. A template per council. The worker must review and sign, then pastes into the case system, because that is how one council's published transparency record describes it. And nothing is kept longer than 120 days.`,
    `On size. I'll assume 100,000 frontline workers have accounts; tell me if that is far off. I'll design for 100,000 workers, one in five recording in a week, two recordings each: 40,000 recordings, about 30,000 audio hours a week. That is 800 uploads an hour on average and maybe 40 a minute at peak. So throughput is small. One Rails app and one Postgres will carry it.`,
    `The hard parts are elsewhere. A long upload on a bad connection that must never lose a visit. A chain of slow, paid calls to other companies that fail and hang. A draft that must not invent things, in a record that decides someone's care. A note that has to be the worker's own. And deleting everything on time, everywhere, with proof.`,
    `The shape. The device records locally and uploads in parts straight to object storage. Rails owns a state machine in Postgres. Jobs in a Postgres-backed queue transcribe with Deepgram, with Whisper behind a circuit breaker, then summarise into the council's template with every sentence citing transcript lines, then check those citations. The worker reviews beside the transcript, signs, and copies it out. A retention job deletes at 120 days and writes receipts. I've assumed Rails and Postgres as a typical stack for a small team, and those vendors because one council's published record names them. Where would you like to go deep?`,
  ],

  pushes: [
    {
      q: 'Why a Rails monolith and a queue in Postgres? Will it scale?',
      a: [
        'The load is about 3 jobs a second at peak and a few web requests a second. The work is waiting on vendors, not computing.',
        'One database lets the state change and the next job commit together. That removes a whole class of lost-job bugs.',
        `At ten times the volume, the same design holds with more worker processes. At a hundred times, I'd move the queue off the main database and keep the step table as the truth.`,
        `I'd split a service out when a team boundary or a scaling limit asks for it, not before.`,
      ],
    },
    {
      q: 'Most Rails teams run Sidekiq. Why not Sidekiq?',
      a: [
        'Sidekiq is fine and faster. Its cost is that the push to Redis is not in the database transaction.',
        'So you need a safety net: an outbox, or a sweeper that re-enqueues steps with no job. I have the sweeper anyway.',
        `If the team already runs Sidekiq well, I'd keep it and rely on the step table and sweeper. The design does not depend on the queue being exactly-once; nothing is.`,
      ],
    },
    {
      q: 'Why multipart to S3 and not tus? And what happens on an iPhone when the screen locks?',
      a: [
        'Multipart needs nothing new to run and keeps audio off our servers. Its cost is the 5 MiB minimum part: a drop repeats up to 84 seconds of sending on half a megabit.',
        `tus resumes at the byte but is a stateful server that all audio passes through. I'd switch if measured upload failures on poor connections justified it.`,
        `Screen lock is the real weakness of a web recorder. I'd hold a wake lock, test on the devices councils issue, tell the worker before recording if the browser cannot be trusted, and treat a native recorder as the fix if the data says we lose recordings. I have not verified current browser behaviour.`,
      ],
    },
    {
      q: 'What happens when the same job runs twice?',
      a: [
        'It will: a worker frozen past its lease, a deploy mid-job, a queue redelivery.',
        `Three guards. The claim on (recording, step) lets one run proceed. Every write starts with a compare-and-set on the recording's state. Outputs have unique keys: one transcript per recording, one draft per generation.`,
        'What I cannot prevent is paying the vendor twice. I reduce it with a 10-minute drain on transcription workers and leases longer than timeouts.',
      ],
    },
    {
      q: 'Deepgram is down for two hours on a Monday morning. Walk me through it.',
      a: [
        'Within 30 seconds the breaker opens and new work goes to Whisper. Drafts carry on, without speaker labels, and review says so.',
        `Whisper's quota becomes the limit. If it cannot take the peak, the queue grows; per-council fairness stops one council taking it all; the SLO burns and we tell councils through the status page.`,
        'Every 60 seconds one trial call tests Deepgram. When it passes, traffic moves back.',
        'Afterwards: how many drafts were late, how many used the fallback, and whether to offer workers a re-run on the primary.',
      ],
    },
    {
      q: 'The fallback is worse. Is a worse draft better than a late one?',
      a: [
        `For most visits, yes, if the worker is told. A late note costs the worker's evening.`,
        `It could be a council setting: "wait for the primary" for teams where attribution matters most, such as child protection meetings with many speakers.`,
        `I'd decide with data: edit rates and removals on fallback drafts against primary ones.`,
      ],
    },
    {
      q: 'A three-hour recording, or a team meeting covering six cases?',
      a: [
        'Length first: timeouts and leases scale with duration; over 30,000 tokens I extract statements per 20-minute piece with line numbers, then write from the extracts.',
        `Multi-case meetings are a different product problem. The 2024 trial found the tool struggled with them. I'd ask the worker to mark where each case starts, or detect topic changes and ask them to confirm, and produce one note per case.`,
        `And I'd cap recording length in the app with a clear message, so nobody learns the limit by losing a morning.`,
      ],
    },
    {
      q: 'How do you stop the model making things up?',
      a: [
        `I can't stop it; I can make it checkable. Every statement cites transcript lines. Code rejects citations that do not exist. A second call judges whether the lines support the sentence. Unsupported sentences are flagged and block export until the worker decides.`,
        'Then the worker reviews with the source one click away. That is the control; the rest makes it quicker.',
        `I'd say plainly that the checker is a model and is sometimes wrong, and I'd measure it against human labels.`,
      ],
    },
    {
      q: 'And what about things it leaves out?',
      a: [
        'Grounding does not catch omissions. That is the worse error in safeguarding: a disclosure that never reaches the note.',
        'Online: show the worker the transcript passages no statement cites, longest first. Offline: a test set where practitioners have marked the facts that must appear, and a score for how many do.',
        `The template helps: a heading such as "Risks and concerns raised" makes the model look for them.`,
      ],
    },
    {
      q: 'How would you measure accuracy?',
      a: [
        `Transcription: word error rate on a consented, labelled sample, reported by accent group and setting, because one council's published record itself warns about strong accents. The 98% in that record is the vendor's claim; I'd want our own number.`,
        'Notes: share of statements unsupported; omission score on a marked test set; and a monthly audit where practice leads compare a sample of signed notes with transcripts and grade errors as harmful, material or cosmetic.',
        'Edit and removal rates at review are useful but biased: a tired reviewer edits less.',
        `And I'd measure what the Ada Lovelace Institute's report says councils do not: the effect on the people the notes are about, not only time saved.`,
      ],
    },
    {
      q: 'How do you change a prompt, or cope with a model being retired?',
      a: [
        'Template versions are immutable and each draft records its version and model.',
        `A new version runs against the test set, then on 5% of one council's recordings, then goes live. Rolling back moves a pointer.`,
        `The model version is pinned. A retirement date is a project: re-run every council's test set on the next version before the date.`,
      ],
    },
    {
      q: 'Why row-level security and not a schema per council? How do you know it works?',
      a: [
        'Three hundred schemas means three hundred migrations per deploy, several times a day. One schema with a policy on every table is operable.',
        'It works with a pooled connection because the tenant is set with SET LOCAL inside each transaction.',
        `Tests run as the application role, not the owner. A check in CI fails if any table with a tenant_id lacks a policy. In production a canary user from a fake council tries to read another's row every five minutes and must get nothing.`,
        'With no tenant set the query errors. I ran that on Postgres.',
      ],
    },
    {
      q: 'You have UK, US and Australian customers. Where does the data live?',
      a: [
        'One complete stack per region: app, database, bucket, keys and in-region model deployments. A council belongs to one region. This design assumes UK or EEA for UK councils, Australia for Australian customers and US servers for the US.',
        `The only global thing is a small directory mapping a council's sign-in domain to its region. No personal data crosses.`,
        'The same code deploys to all three. The cost is three of everything to run, and vendor features that arrive in one region first.',
      ],
    },
    {
      q: 'Prove to me a recording is deleted. What about backups and vendors?',
      a: [
        'A receipt per place it was held: bucket, database, each vendor, with dates and evidence.',
        'Backups cannot be edited. They expire after 35 days, the contract says so, and a restore ends by re-running the retention job. When a council leaves, destroying its key finishes the job.',
        'Vendors: I know exactly which received it from the call log. Each copy is recorded as not held, deleted, or expiring on a date. I have not verified what each vendor keeps; that is the first contract question.',
      ],
    },
    {
      q: 'Consent is withdrawn after the note is already in the case system.',
      a: [
        'Our copies go at once: audio, transcript, draft, note, and vendor requests.',
        `The council's record is the council's decision under its own duties. A social worker's record of a visit does not depend on consent to recording in the way the recording does. We tell the council's lead and log it.`,
        `I'd want the council's view written into onboarding, not worked out on the day.`,
      ],
    },
    {
      q: 'Do you redact personal data before the LLM?',
      a: [
        `No, and I'd say why. The note needs the names and details; replacing and restoring them adds a new way to get a statutory record wrong.`,
        'The controls are in-region processing, no-training terms, as little vendor retention as the contract allows, and a per-council key.',
        'Where I do redact is everywhere content has no business: logs, error reports, traces, the ops view.',
        'I don\'t know what your team does here, so I would ask.',
      ],
    },
    {
      q: 'Halve the cost.',
      a: [
        'Transcription is about four fifths of it on my assumptions, so start there: a volume price, then removing long silences before sending if billing is per minute, then measuring a cheaper tier.',
        'At the assumed volume the list-price speech bill is about $58,000 a month. That is the point where self-hosting Whisper deserves a costed trial, weighed against turning a product team into an inference team.',
        `The LLM is 11 cents an hour. I'd use a smaller model for the check and cache the template part of the prompt, and I would not cut the check to save five cents.`,
      ],
    },
    {
      q: 'Would you integrate with Liquidlogic or Mosaic?',
      a: [
        `I'd find out first which systems most users are on and whether their suppliers offer and license a write API. I have not verified any of that.`,
        'Then one adapter, one council, with the worker still pressing the button and choosing the record.',
        `The gain is fewer wrong-record pastes and a real "exported". The cost is that the notes app starts holding case identifiers.`,
      ],
    },
    {
      q: 'How do you roll this out to a new council?',
      a: [
        'Before any data: their data protection impact assessment, a transparency record, the sub-processor list, their retention period and region.',
        'Set up the tenant: key, sign-in federation, roles. Build their templates with their practice leads and test on synthetic conversations.',
        'A pilot of 20 to 30 workers for four to six weeks, with consent and review training.',
        'Agree in advance what would stop the rollout: error rates in audited notes, not only hours saved. Then widen in waves with per-council limits.',
      ],
    },
    {
      q: 'You have four engineers and three months. What ships first, and what do you cut?',
      a: [
        'First: never lose a recording. Local recording, resumable upload, the state machine, step table and sweeper.',
        'Second: retention with receipts and row-level security, because they are promises already made.',
        'Third: fallback and breaker, then citations and the check.',
        'Cut for now: case system integrations, chunk-and-merge, per-section parallel calls, self-hosting. Each has a trigger for coming back.',
      ],
    },
    {
      q: 'Who owns what, and who is on call?',
      a: [
        'With a small team I would not draw four teams. One team owns the pipeline end to end, with named owners for capture, pipeline and vendors, AI quality, and data protection engineering.',
        'On call is one rota, four paging conditions, runbooks, and vendor outages handled by the breaker so most nights are quiet.',
        'The council owns consent practice, template content and the final note. That line matters as much as any service boundary.',
      ],
    },
    {
      q: 'Should this exist? Where is your red line?',
      a: [
        `The case for it is time: workers spend a great deal of it on write-up, and the evaluations report hours back. The case against is that an error lands in a record that decides someone's care, and the person it is about never sees the draft.`,
        'So my lines are: the worker is the author and must review; nothing exports unread; consent is real and withdrawal is honoured in minutes; minimum retention; no training on this data; accuracy measured by group, and published to councils.',
        'And I would not ship a change that saves time and raises the harmful-error rate, whatever the dashboard says.',
      ],
    },
    {
      q: 'How is this different from your real-time products?',
      a: [
        'Note-taking is a batch pipeline: minutes are fine, retries are possible, a queue smooths peaks.',
        'A live voice agent or interpreter has a budget of a few hundred milliseconds, streaming speech in both directions, and no retry: it degrades or hands over to a person.',
        'I would share tenancy, retention and audit, and not the job pipeline.',
      ],
    },
    {
      q: `A worker's account is taken over. Or one of your own engineers is curious.`,
      a: [
        `Workers see only their own recordings, behind the council's single sign-on with multi-factor, for at most 120 days. That bounds the damage.`,
        `Staff have no standing access to content. The ops role reads metadata. Reading a recording needs a reason, the council's permission, an hour's grant and an audit event the council can see.`,
        'Key use is logged by the cloud, outside our application, so it can be reconciled against those grants.',
      ],
    },
  ],

  lead: {
    phases: [
      { name: '1. Never lose a visit', ships: 'Local recording in slices, multipart resumable upload, checksum before local delete, the recording state machine, step table, sweeper, a minimal ops view.', why: `A lost recording cannot be recovered and is the fastest way to lose a council's trust. Everything later sits on the state machine.` },
      { name: '2. Keep the promises already made', ships: 'Delete-by date on every row, the retention job with receipts, the bucket backstop, row-level security on every table, per-council keys, the audit log.', why: `These are in councils' data protection assessments today. They are cheap now and expensive to retrofit.` },
      { name: '3. Survive the vendors', ships: 'Provider adapters, timeouts by length, backoff, the breaker, Whisper fallback with a 1% trickle, dead steps and re-drive, per-council fairness, cost per audio hour.', why: 'Vendor incidents are the commonest cause of late drafts; this turns them from outages into slower days.' },
      { name: '4. Make the draft checkable', ships: 'Template versions, structured output with cited lines, the grounding check, flags in review, draft and note as separate rows, edit counts, the test set and the monthly audit.', why: `This is the product's real risk. It comes fourth only because it needs the pipeline under it to be boring.` },
      { name: '5. Widen', ships: 'A second region, long recordings and multi-case meetings, one case system adapter with a pilot council, the cost work.', why: `Each has a trigger: a contract, a measured failure rate, a supplier's API, a bill.` },
    ],
    migration: [
      'Assume a pipeline already runs at about 1,000 audio hours a week. So this is how I would move any working Rails pipeline to this shape without a bad day.',
      'Add the step table and state guards beside the existing jobs first. They change no behaviour; they only refuse double work. Backfill rows for recordings in flight.',
      `Move uploads to multipart behind a flag per council. Keep the old path until the new one's completion rate on poor connections is measurably higher.`,
      'Add delete_after with a backfill from created_at. Run the retention job in report-only mode for two weeks and compare what it would delete with what the current process deletes. Then switch it on.',
      'Turn on row-level security one table at a time, starting with tables only jobs touch, with the test suite running as the application role.',
      'Introduce cited output as a new template version per council. Run it in shadow on a 5% sample (about 11 cents more an audio hour on that sample), compare, then switch council by council.',
      'Nothing here needs downtime. Each step can be turned off by a flag.',
    ],
    slos: [
      { name: 'Draft ready', target: '95% within 10 minutes of upload complete; 99% within 30 minutes, per week', why: 'The worker should have the draft before the next visit. Typical is about 3 minutes (90 s transcription at an assumed 30 times real time, about 60 s of model calls, queue time). The 30-minute tier allows for a fallback during an outage.' },
      { name: 'No lost recordings', target: '0 recordings acknowledged as uploaded and later unavailable', why: 'The one failure that cannot be put right.' },
      { name: 'Availability of recording upload and review', target: '99.5% a month', why: `99.5% is a typical target in a G-Cloud listing for this kind of service (assumption). Recording itself needs no server, so the app can meet a modest target without workers being stopped.` },
      { name: 'Deletion on time', target: '100% of due content deleted from our stores within 24 hours of its date; withdrawals within 15 minutes', why: 'It is a contractual and legal promise, so it is measured like uptime.' },
      { name: 'Dead steps', target: 'no step dead for more than 4 working hours without an owner', why: 'A dead step is a worker with no note.' },
      { name: 'Draft quality (an indicator, not an SLO)', target: 'unsupported statements and removal rate per template version within its own four-week range', why: 'Quality has no honest single threshold. A sudden move after a prompt or model change is the signal.' },
    ],
    oncall: [
      'Page: 95th percentile draft-ready time over 10 minutes for 30 minutes, or any recording waiting over 30 minutes.',
      'Page: both speech providers failing, or both LLM deployments failing.',
      'Page: the cross-council canary read returned a row. That is a data breach until proved otherwise.',
      'Page: any recording more than 24 hours past its delete-by date, or an object in the bucket with no live row.',
      `Morning: one provider's breaker opened and the fallback worked. Dead steps. Uploads stuck over 24 hours, by council. Cost per audio hour over $0.75. Vendor deletion receipts pending over 7 days. Legal holds over 90 days.`,
      'Runbooks: provider outage (confirm breaker, post status, watch fallback quota); late drafts (queue age by step, per-council caps); restore from backup (always ends with the retention job); break-glass access (reason, council consent, one hour).',
      'A vendor outage should not need a person at 3 a.m. That is what the breaker is for.',
    ],
    teams: [
      { name: 'Notes product team (capture and review)', owns: `The recorder, the upload client, the review editor, export, and the worker's experience of failures.` },
      { name: 'Pipeline and platform (may be the same people in a small team)', owns: 'The state machine, queue, provider adapters and breakers, tenancy, keys, retention, the ops view, cost, and the pager.' },
      { name: 'AI quality (prompt engineers with an engineer)', owns: 'Templates and prompt versions, the test sets, the grounding check, the monthly audit and its numbers.' },
      { name: 'Customer and forward-deployed engineers', owns: `Onboarding a council: tenant set-up, templates with practice leads, training on consent and review.` },
      { name: 'Security and data protection', owns: `Sub-processor terms, the pack for a council's impact assessment, deletion evidence, break-glass approvals.` },
      { name: 'The council', owns: 'Consent practice, the content of its templates, its retention period, legal holds, and the final note in its case system.' },
    ],
    buildBuy: [
      { part: 'Speech to text', call: 'Buy (Deepgram, Whisper as fallback)', why: 'Named in the public record; faster than building; revisit self-hosting when the bill passes the cost of a small team.' },
      { part: 'LLM', call: 'Buy (OpenAI model on Azure, pinned, in region)', why: 'Quality and residency today; keep an adapter so a second provider is a config change.' },
      { part: 'Upload', call: 'Buy (object storage multipart)', why: 'Resumable upload is solved; tus only if measurements demand it.' },
      { part: 'Queue', call: 'Use what Rails has (GoodJob or Sidekiq)', why: 'Three jobs a second does not need a platform.' },
      { part: 'Workflow engine', call: 'Do not buy', why: 'Four steps and a table.' },
      { part: 'Sign-in', call: 'Buy (an identity provider; one council\'s published record lists one)', why: `Federation with 300 councils' directories is not a thing to hand-build.` },
      { part: 'Keys', call: 'Buy (cloud KMS)', why: 'Logging and destruction with a waiting period come with it.' },
      { part: 'Grounding check, test sets, audit tooling', call: 'Build', why: `This is the product's safety case and nobody sells it for social care notes.` },
      { part: 'Ops view', call: 'Build small', why: 'It is a page over our own state tables.' },
      { part: 'Case system integration', call: 'Wait, then build one adapter', why: 'Depends on suppliers; paste works today.' },
    ],
    cost: [
      `About 56 cents an audio hour in vendor cost on this page's assumptions: 45 for speech, 11 for the LLM. About $16,800 a week at 30,000 audio hours, about $73,000 a month, about $870,000 a year. At an assumed small start of 1,000 hours a week it is about $560 a week.`,
      'Speech is four fifths. Price per audio hour is the first thing to negotiate and the main reason to revisit build against buy.',
      'Retries are real money: every timed-out call is a row in vendor_calls. Watch cost per audio hour, not only the invoice.',
      'Storage is about $350 a month for 15 TB. Not worth engineering time.',
      'The database and app servers are small: one primary, one replica, a handful of worker processes per region. Three regions triples the fixed part.',
      'People cost more than vendors: on call across three time zones, onboarding 300 councils, and the audit programme.',
    ],
    risks: [
      { risk: 'A harmful error in a signed note.', answer: 'Citations, the check, review that cannot be skipped, the monthly audit by severity, and a rule that a change which raises harmful errors does not ship.' },
      { risk: 'A recording lost on a device.', answer: 'Slices every 10 seconds, upload as soon as there is signal, nagging when recordings sit on a device, measurement of time-on-device; a native recorder if the numbers are bad.' },
      { risk: `One council sees another's data.`, answer: 'Row-level security, per-council keys and prefixes, tests as the application role, a canary that pages.' },
      { risk: 'Deletion silently stops.', answer: 'Overdue count and orphan count as paged alerts; bucket rule as backstop; monthly report to each council.' },
      { risk: 'A vendor changes price, terms, model or filter.', answer: 'Adapters, a second provider for each step kept warm, pinned versions, test sets per template.' },
      { risk: 'Review becomes a rubber stamp.', answer: 'Make checking quick, block export on flags, report review patterns to councils in aggregate, and work with practice leads on what good looks like.' },
      { risk: 'The tool hears some people worse than others.', answer: 'Measure transcription error by accent group on consented samples, publish it to councils, route or warn where it is poor.' },
      { risk: 'The team is small and the pager is loud.', answer: 'Four paging conditions, breakers that absorb vendor incidents, and nothing built that needs its own on-call.' },
    ],
  },

  rehearsal: [
    { stage: 'Clarify and scope', minutes: 6, prompt: 'You are asked to design the pipeline behind an AI note-taking tool for councils: a recorded visit becomes a reviewed case note. Ask your questions, then state your assumptions.', cover: ['Who records, on what, for how long, with what signal', 'Consent and withdrawal', 'Languages', 'Turnaround target', 'Template per council', 'Review required before export', 'Retention: 120 days at most', 'Which cloud'] },
    { stage: 'Numbers', minutes: 4, prompt: `Size it out loud. Say which figures are assumptions.`, cover: ['1,000 audio hours a week as a small start (assumption)', '100,000 workers (assumption)', '40,000 recordings, 30,000 hours a week (assumption)', '800 uploads an hour, 40 a minute at peak', '15 TB held; about $350 a month', '56 cents an audio hour; speech is four fifths', 'Conclusion: small throughput; the hard parts are reliability, accuracy, deletion'] },
    { stage: 'High-level design and data model', minutes: 12, prompt: 'Draw the boxes and the main tables. Follow one recording across them.', cover: ['Device, Rails app, bucket, Postgres, queue, two workers, three vendors, review, case system, retention, keys, ops', 'recordings.state and its moves', 'pipeline_steps as the idempotency key', 'Job and state in one transaction', 'Why the stack: a typical small-team stack, and vendors one council\'s published record names'] },
    { stage: 'Deep dive: upload and the job pipeline', minutes: 10, prompt: 'The signal drops mid-upload. Then Deepgram goes down. Then a job runs twice. Explain each.', cover: ['Client recording id; create is idempotent', 'Parts, ETags, list and resume, checksum before local delete', 'Lease, timeout by audio length, backoff with jitter', 'Breaker, fallback, what the fallback lacks', 'Guards: claim, compare-and-set, unique outputs', 'Dead steps, re-drive, sweeper, fairness per council'] },
    { stage: 'Deep dive: summarising, grounding and review', minutes: 10, prompt: 'How do you keep an invented sentence out of a statutory record? And a missing one?', cover: ['Template versions, pinned model', 'Statements with cited lines; code validates', 'Check pass; flag, do not delete', 'Omissions are not caught: uncited passages, test sets', 'Review beside transcript; sign-off; draft and note kept apart', 'How you measure accuracy, by group', 'Content filter as a failure mode'] },
    { stage: 'Tenancy, retention and deletion', minutes: 6, prompt: `A council asks you to prove a person's recording is gone. Another council leaves.`, cover: ['Row-level security and how it is tested', 'Per-council key', 'delete_after at birth, CHECK at 120', 'Audio, then rows, then receipts', 'Vendors: three outcomes', 'Backups: 35 days, restore re-runs the job', 'Withdrawal race and the guard', 'Legal hold', 'Key destruction on exit', 'Region per stack'] },
    { stage: 'Run it and lead it', minutes: 7, prompt: 'What do you commit to, what pages, what does it cost, who owns what, and how do you bring on a new council?', cover: ['SLOs: draft in 10 minutes, zero lost, deletion on time', 'Four pages', 'Cost per audio hour and what drives it', 'Phases and what you cut', `Ownership, including the council's`, 'Rollout: impact assessment, templates, pilot, stop conditions', 'The ethical position in three sentences'] },
    { stage: 'Your questions', minutes: 5, prompt: 'Ask them what you most want to know.', cover: ['Which cloud and queue are current', 'What vendors keep, and for how long', 'How accuracy is measured today and by whom', 'How much of the note workers change', 'What the team is on call for', 'What they would change about the pipeline first'] },
  ],
};
