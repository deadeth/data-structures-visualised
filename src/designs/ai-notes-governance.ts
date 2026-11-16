import type { Alternative, Design, TourStep, Way } from './types';

/**
 * Trustworthy AI notes across councils and countries, as a high-level design.
 *
 * Built from the content spec of 16 November 2026 (ai-notes-governance.md), which was written
 * from two research notes. The design is ours: it describes no real supplier's architecture.
 * Facts from public sources carry the kind of source; scale figures are labelled assumptions.
 *
 * The design: one global control plane with no personal data (councils, releases, rollout,
 * evaluation results, daily counts) and a global router that maps a council's domain to its
 * region. A full data plane per country: a Rails app, PostgreSQL with forced row-level
 * security and the tenant set per transaction, an audio store, a key per council and a data key
 * per note, a pipeline of three idempotent stages on a fair job queue, a grounding check, an
 * append-only hash-chained audit log written in the action's transaction, and a retention worker
 * with receipts. Regions pull configuration and send up counts only.
 *
 * Example values (invented): Northbridge Council (slug northbridge, UK), Priya, Mr A, note 7f3a,
 * a visit on Tuesday 17 November 2026 at 10:00; release 40 live, 41 failed evaluation, 42 canary
 * then rolled back at 16:10, 43 proposed. SQL on this page was run on PostgreSQL 16 by the spec's
 * writer and again on PGlite by the builder.
 */

/** An option on a component's panel. `good` and `cost` are the first pro and the first con, word for word. */
const alt = (name: string, what: string, pros: string[], cons: string[], chosen = false): Alternative => ({
  name,
  ...(chosen ? { chosen } : {}),
  good: pros[0],
  cost: cons[0],
  what,
  pros,
  cons,
});

/** One way two boxes could talk. */
const way = (name: string, what: string, pros: string[], cons: string[], chosen = false): Way => ({
  name,
  ...(chosen ? { chosen } : {}),
  what,
  pros,
  cons,
});

/** A line's `alts`: the names of the ways it does not use. */
const others = (ways: Way[]) => ways.filter((w) => !w.chosen).map((w) => w.name);

/**
 * A tour step from the spec's fields. `story.context` is the first sentence of the text,
 * `fix` is "Why this one" then "What can still go wrong", and `explain` answers the three
 * standard questions and the step's own one.
 */
const step = (s: Omit<TourStep, 'story' | 'explain'> & {
  context: string;
  problem: string;
  left: string;
  options: string;
  why: string;
  wrong: string;
  q: string;
  a: string;
}): TourStep => {
  const { context, problem, left, options, why, wrong, q, a, ...rest } = s;
  return {
    ...rest,
    story: { context, problem, consequence: left, fix: `${why} ${wrong}` },
    explain: [
      { q: 'What were the options?', a: options },
      { q: 'Why this one?', a: why },
      { q: 'What can still go wrong?', a: wrong },
      { q, a },
    ],
  };
};

const lookupWays = [
  way('Lookup by council domain', 'The user types a work email; only the domain is sent to the router, which maps it to a region.', ['No personal data reaches the global tier.', 'One address for all customers.'], ['Shared domains (two services under one council domain) need a picker.'], true),
  way('Ask the user to pick a country', 'A country chooser on the first screen.', ['No directory.'], ['Users pick wrong.', 'Does not find the tenant.']),
  way('Geo-routing by IP address', 'Route to the nearest region.', ['Automatic.'], ['Residency follows the customer, not the user\'s location.']),
];
const signinWays = [
  way('OIDC or SAML through a broker', 'Standard single sign-on. The broker holds each council\'s connection settings.', ['The council controls joiners and leavers.', 'Its MFA applies.'], ['Setup with each council\'s IT team.'], true),
  way('Local passwords', 'Accounts held by us.', ['No setup.'], ['Leavers keep access.', 'We hold credentials.']),
];
const appWays = [
  way('HTTPS and JSON with a bearer token', 'Plain request and reply.', ['Works through council proxies and firewalls.', 'Simple to audit.'], ['Status is polled, not pushed.'], true),
  way('WebSocket for live status', 'A held-open connection pushes "draft ready".', ['No polling.'], ['Council proxies often break long-lived connections.']),
];
const wrongWays = [
  way('Refuse with 421', 'The region rejects anything not addressed to it.', ['A routing mistake is an error, not a leak.', 'Nothing is stored abroad.'], ['The user sees a failure until routing is fixed.'], true),
  way('Proxy to the right region', 'The US app forwards the request to the UK.', ['The user notices nothing.'], ['UK personal data has now passed through a US server.', 'Needs a network path between regions.']),
  way('Redirect to the right region', 'Reply with a redirect to the UK address.', ['Self-healing.'], ['An upload body may already have been sent with the request.', 'Hides the routing bug.']),
];
const uploadWays = [
  way('Direct upload in parts with signed addresses', 'The browser writes to storage; the app only authorises.', ['58 MB files never pass through app servers.', 'A dropped connection resumes at the failed part.'], ['Two systems must agree the upload finished.'], true),
  way('Upload through the app', 'The browser posts the file to the app, which writes it to storage.', ['One hop to reason about.'], ['App servers tied up for minutes per upload.', 'A retry starts from zero.']),
  way('Stream while recording', 'Send audio as it is recorded.', ['Nothing to upload at the end.', 'Opens the way to live transcripts.'], ['Home visits often have no signal.', 'Consent can be withdrawn mid-visit, after audio has already left the device.']),
];
const sqlWays = [
  way('Tenant set per transaction, policies in the database', 'The app tells the database which tenant this transaction is for; policies filter every table.', ['A missed filter returns nothing.', 'Works with a transaction-mode connection pool.'], ['Every code path must open its transaction through one helper.'], true),
  way('Filters in application code only', 'Every query includes WHERE tenant_id = ?.', ['No database feature needed.'], ['One forgotten clause is a breach.']),
  way('A database role per tenant', 'Connect as a different role for each council.', ['Isolation by grants.'], ['400 roles and no shared connection pool.']),
];
const keysWays = [
  way('Unwrap per note, per request', 'One key service call each time a note is opened.', ['Every read of a note\'s key is logged outside the app.', 'A stolen database is ciphertext.'], ['The key service is on the read path.'], true),
  way('Cache the council\'s key in the app', 'Fetch the council key once and unwrap locally.', ['No call per note.'], ['The council\'s key now sits in app memory.', 'No per-note access log.']),
];
const jobsWays = [
  way('A jobs table in the same database', 'The queue is a table; enqueue is an INSERT in the note\'s transaction.', ['No note without a job, no job without a note.', 'Fairness is a WHERE clause.', 'Nothing new to run in three countries.'], ['Polling and row churn; fine at one job a second.'], true),
  way('A separate queue service with an outbox', 'Write the job to an outbox table, relay it to a broker.', ['Scales much further.', 'Workers do not load the database with polling.'], ['Another system per region.', 'Fair scheduling across 400 tenants is harder on a plain queue.']),
  way('One queue per council', 'Each council has its own queue and workers.', ['Perfect isolation of load.'], ['400 queues, most idle.']),
];
const audioWays = [
  way('The worker reads and forwards', 'The worker decrypts and streams the audio to the vendor.', ['The vendor never gets access to our storage.', 'The audio is encrypted at rest with our key.'], ['Audio passes through worker memory.'], true),
  way('Give the vendor a signed address', 'The vendor fetches the object itself.', ['Less work for the worker.'], ['The object would have to be stored unencrypted or with a key the vendor can use.']),
];
const pkeysWays = [
  way('Unwrap per stage', 'One call at the start of each stage.', ['Key access is logged per stage.'], ['Three calls per note.'], true),
  way('Pass the data key in the job', 'The app puts the unwrapped key in the job row.', ['No call.'], ['A plaintext key in a database table defeats the point.']),
];
const vendorWays = [
  way('Synchronous call from a worker, recorded per call', 'The worker calls and waits.', ['Simple.', 'Each call has one row saying what left.'], ['A worker is held for the length of the call.'], true),
  way('Vendor batch API', 'Submit a file of requests; collect results hours later.', ['Cheaper per token at most vendors.'], ['Practitioners want the draft in minutes.', 'Batch inputs are stored at the vendor until processed.']),
  way('Vendor webhook', 'Submit audio; the vendor calls back when done.', ['No worker held.'], ['An inbound endpoint that receives transcripts must be secured.']),
];
const checkWays = [
  way('A stage inside the worker', 'The check is code in the pipeline.', ['One deployable.', 'Shares the release\'s version pin.'], ['Shares the worker\'s fate.'], true),
  way('A separate checking service', 'A service with its own API.', ['Could be owned by a different team and used by other products.'], ['A network hop and a second deployment per region.']),
];
const resultsWays = [
  way('One transaction per stage', 'Results, next job and audit line commit together.', ['No half-finished stage.', 'Repeats are harmless.'], ['Text is encrypted in the worker before the insert, so the database cannot search it.'], true),
  way('Write results as objects in storage', 'Store transcript and draft as files.', ['Cheap.'], ['No per-sentence queries: no "which sentences cite segment 141?".']),
];
const relayWays = [
  way('Same transaction, then sealed hourly', 'Audit lives beside the data and is copied out on a schedule.', ['Nothing happens unrecorded.', 'Tamper-evident after at most an hour.'], ['Up to an hour of lines exist only in the database.'], true),
  way('Outbox to a separate audit service', 'Write an outbox row; a relay publishes it; an audit service stores it.', ['Audit is isolated from the main database.'], ['More parts.', 'The line arrives a moment after the action.']),
  way('Log lines', 'Write to the application log.', ['Free.'], ['Not transactional and not complete.']),
];
const pasteWays = [
  way('Copy by section, or a structured file', 'Manual transfer with tooling to make it quick and hard to get wrong.', ['Works with every case system.', 'A human puts it on the right file.'], ['About 6 pastes a note.', 'No confirmation of arrival.'], true),
  way('Pull API for the council', 'The council\'s systems fetch approved notes.', ['Automated, with the council in control.'], ['Needs council integration work.']),
  way('Write-back', 'We push into the case system.', ['No manual step.'], ['See the write-back line.']),
];
const writebackWays = [
  way('Unsigned draft to a chosen case, opt-in', 'Write-back that stops short of the signed record.', ['Removes the pasting.', 'Keeps a human signature inside the system of record.'], ['A connector per case system.', 'We hold access to a statutory system.'], true),
  way('Full automatic filing', 'Write the final entry with no further step.', ['Fastest.'], ['No last look.', 'A wrong match files a note on the wrong person.']),
  way('Robotic paste on the practitioner\'s screen', 'Desktop automation fills the case system\'s form.', ['No API needed.'], ['Breaks when the form changes.', 'Runs with the user\'s full rights.']),
];
const syncWays = [
  way('The region pulls', 'Regions poll; the control plane only answers.', ['No credentials for regions held globally.', 'A control plane outage does not stop drafting.'], ['Changes take up to 30 seconds to arrive.'], true),
  way('The control plane pushes', 'The control plane calls each region when something changes.', ['Instant.'], ['It needs network access and credentials into every region.']),
  way('Configuration shipped with each deployment', 'Releases are part of the app\'s code deploy.', ['Nothing to poll.'], ['A rollback is a redeploy in three countries.']),
];
const directoryWays = [
  way('Publish a copy to the router', 'The router answers from its own copy.', ['Sign-in survives a control plane outage.'], ['A new council appears after the next publish.'], true),
  way('The router queries the control plane', 'A live lookup per sign-in.', ['Always current.'], ['The control plane joins the sign-in path.']),
];
const purgeDbWays = [
  way('Row deletes in batches with receipts', 'Delete each note and record it.', ['Per-note proof.', 'Holds and per-council retention just work.'], ['Millions of row deletes a day need steady vacuuming.'], true),
  way('Drop partitions', 'Drop a day\'s partition.', ['Cheap.'], ['Retention differs by council and holds exist.']),
];
const purgeAudioWays = [
  way('Explicit delete, then verify by listing', 'Delete and check.', ['The receipt can say "audio_objects: 1" truthfully.'], ['Two calls per note.'], true),
  way('Rely on the lifecycle rule', 'Let storage expire objects by age.', ['Nothing to run.'], ['One age for every council, and no per-note proof.']),
];
const purgeVendorWays = [
  way('Reconcile what was sent against what the vendor lists', 'Compare our record of calls with the vendor\'s stored data, plus tracers.', ['Finds a retention fault without waiting to be told.', 'Uses data we already keep.'], ['Depends on the vendor exposing a listing.', 'Cannot see inside the vendor\'s logs.'], true),
  way('Trust the contract', 'Rely on the data processing agreement and annual reports.', ['No work.'], ['A misconfiguration at the vendor goes unseen for months.']),
  way('Self-host the model', 'Remove the vendor.', ['Nothing to check.'], ['See AI vendors.']),
];

export const aiNotesGovernance: Design = {
  id: 'ai-notes-governance',
  name: 'Trustworthy AI notes across councils and countries',
  blurb: 'The platform behind AI case notes for social care: one control plane, a separate stack per country, a tenant per council. Follow one draft note from a home visit to the council\'s case system, through a wrong-region request, an invented safeguarding detail, a bad prompt release and a vendor that kept data too long.',
  tourName: 'One note, visit to deletion',
  rest: 'Press Play to follow one note from a home visit to deletion, or open any box or chip. In the diagram, arrows move and Enter opens.',
  restTouch: 'Press Play to follow one note from a home visit to deletion, or tap any box or chip to open it.',
  size: { w: 1400, h: 660 },
  frame: { x: 240, y: 155, w: 945, h: 490, label: 'UK region (one of three)', note: 'Personal data stays inside' },

  components: [
    {
      id: 'user',
      name: 'Practitioner\'s browser',
      short: 'Practitioner',
      tech: 'council device',
      x: 90, y: 235, w: 136, h: 60, kind: 'input',
      what: 'A social worker, occupational therapist or other frontline worker using the web app on a council-issued device. They record or upload the audio of a conversation, review the draft, edit it, approve it and move it into the council\'s case system. One council\'s published algorithmic transparency record (2025) describes exactly this: staff record on council devices through the web app, edit the draft, then paste it into the case system.',
      why: 'The practitioner is the author of the record and the final control on the AI. Everything else on this page exists so that their approval means something: they see which sentences are unsupported, they can play the audio behind any sentence, and their name is on the approval.',
      built: [
        { name: 'Web app on a council device', what: 'A browser application. Nothing is installed and no recording is kept on the device once the upload is confirmed.', why: 'Council devices are managed and locked down. A browser app passes their IT checks and leaves no copy of a recording on a laptop that can be lost.' },
      ],
      numbers: [
        { text: 'About 100,000 users, 20,000 notes a working day (assumption).', from: 'Assume 100,000 frontline workers have accounts. Assume 10% record on a given working day and make 2 notes each: 100,000 x 10% x 2 = 20,000. All three figures are assumptions.' },
        { text: 'About 1.1 notes a second in the busiest hour.', from: 'Assume 20% of a day\'s notes arrive in one hour: 20,000 x 20% = 4,000 an hour; 4,000 / 3,600 = 1.1 a second.' },
        { text: 'A 30-minute recording is 14 MB as MP3 or 58 MB as WAV.', from: 'MP3 at 64 kbit/s: 8,000 bytes a second x 1,800 s = 14.4 MB. WAV at 16 kHz, 16-bit, mono: 32,000 bytes a second x 1,800 s = 57.6 MB. The 30-minute average is an assumption. One council\'s published record names WAV and MP3.' },
      ],
      fails: 'The network drops during a 58 MB upload from a car park. Uploads are in parts and resume; the note stays in "uploading" and nothing is queued until the last part is confirmed. A practitioner skims and approves a wrong draft: see the Grounding check and the review step. The design assumes some will skim.',
      alternatives: [
        alt('Record and review in a browser app', 'The practitioner records in the browser, or uploads a file, and reviews the draft in the same app. The approved text leaves by copy, file export or, later, a connector.', ['Works on any managed council device.', 'One place to show flags, citations and audio playback.', 'No recording left on the device.'], ['The practitioner works in two systems: this app and the case system.', 'Recording in a browser tab can stop if the device sleeps.'], true),
        alt('A plug-in inside the case management system', 'The draft appears inside the council\'s case system, written by an extension or an embedded panel.', ['One screen for the practitioner.', 'No copy and paste.'], ['One build per case system and per version.', 'The case system vendor controls what a plug-in may do.', 'Review tools (flags, playback) must fit inside someone else\'s screen.']),
        alt('A phone app that records offline', 'A native app records with no signal and uploads later.', ['Works in homes with no signal.'], ['Recordings of vulnerable people sit on a phone until upload.', 'Many councils do not allow work data on personal phones.', 'Two more apps to build and secure.']),
      ],
      say: 'The practitioner is the author and the last control. My job is to make their review fast and honest: show what the draft rests on, and make the risky sentences impossible to skip.',
    },
    {
      id: 'idp',
      name: 'Council identity provider',
      short: 'Council sign-in',
      tech: 'OIDC or SAML, MFA',
      x: 100, y: 90, w: 170, h: 56, kind: 'outside',
      what: 'The council\'s own staff directory and sign-in service. The practitioner signs in there, with the council\'s multi-factor rules, and comes back with a signed statement of who they are. An identity broker in front of the regional app turns that into a session token carrying three claims: the user, the tenant and the region. Identity federation and multi-factor authentication are what suppliers of this kind list on G-Cloud; one council\'s published record names a hosted identity service as the authentication sub-processor.',
      why: 'The council decides who its staff are. When someone leaves, the council disables one account and they lose this app too, without anyone telling the supplier. It also keeps passwords out of our system.',
      built: [
        { name: 'OIDC and SAML', what: 'Two standard protocols for signing in to one service with an account held by another. The identity provider signs a short statement about the user; the app checks the signature.', why: 'Councils already run one or the other for their other systems. Supporting both avoids a custom integration per council.' },
        { name: 'Identity broker', what: 'A service that speaks OIDC or SAML to each council on one side and gives the app one token format on the other.', why: 'Hundreds of councils each have their own identity provider settings. The broker holds those settings so the app does not. Buying this is cheaper than building it.' },
      ],
      numbers: [
        { text: 'Sessions last 8 hours (this design\'s choice).', from: 'One working day. A leaver keeps access for at most 8 hours after the council disables them, unless the council also pushes deprovisioning.' },
      ],
      fails: 'The council\'s identity provider is down: its staff cannot sign in, and nobody else is affected. A leaver\'s session is still live: sessions end after 8 hours, and a council that sends deprovisioning events ends them at once. A misconfigured mapping puts a user in the wrong tenant: the tenant comes from the connection the user signed in through, never from a field the user or their browser can set.',
      alternatives: [
        alt('Single sign-on through the council\'s identity provider', 'Each council connects its identity provider once. Users sign in there. The session token names the tenant that owns the connection.', ['Leavers lose access when the council disables them.', 'The council\'s own MFA rules apply.', 'No passwords stored by us.'], ['A setup step with each council\'s IT team.', 'A broker to pay for and trust: it is a sub-processor.'], true),
        alt('Our own usernames and passwords', 'The app keeps its own accounts and its own MFA.', ['No setup with council IT.'], ['Leavers keep access until someone tells us.', 'We hold credentials for staff with access to care records.', 'Fails most council security reviews.']),
        alt('Email magic links', 'The user types an email address and clicks a link sent to it.', ['Nothing to remember.', 'Access ends when the mailbox does.'], ['No MFA of the council\'s choosing.', 'Email is slow and often filtered on council networks.']),
      ],
      say: 'Sign-in is the council\'s, through OIDC or SAML. The tenant claim comes from the connection, not from anything the user can type, and the token also names the region.',
    },
    {
      id: 'edge',
      name: 'Global router',
      short: 'Router',
      tech: 'domain to region',
      x: 300, y: 90, w: 140, h: 56, kind: 'shared',
      what: 'The one global front door. It answers a single question: which country\'s stack serves this council? It holds a small read-only directory that maps a council\'s sign-in domain or slug to a region, and it replies with the address of that region\'s app. It never sees audio, transcripts, drafts or names of the people in them. After the first lookup the browser talks to the regional app directly.',
      why: 'A user starts with one web address. Something must send a Northbridge social worker to the UK stack and a Lakeview County caseworker to the US one. That something must hold no personal data, or the residency promise is broken at the front door.',
      built: [
        { name: 'Tenant directory', what: 'A list of councils: slug, sign-in domains and home region. The control plane publishes it; the router serves a copy.', why: 'A council\'s name and region are not personal data, so this list can be global. A copy at the router means sign-in still works when the control plane is down.' },
      ],
      numbers: [
        { text: 'About 400 entries (assumption).', from: 'Assume 400 customer organisations across three regions. A few kilobytes.' },
        { text: 'About 30,000 lookups a day.', from: 'One per sign-in. Assume 30% of 100,000 users sign in on a working day.' },
      ],
      fails: 'It is down: users with a saved regional address carry on; new sign-ins wait. It sends a user to the wrong region because the directory is wrong: the regional app refuses the request (tour step 2), so a bad directory is an outage for that council, not a leak.',
      alternatives: [
        alt('One front door that looks up the region', 'The user gives their work email domain or picks their council. The router replies with the regional address and the browser goes there.', ['One address to tell every customer.', 'The router holds no personal data.', 'A council can be moved between regions by changing one row.'], ['One more hop on first sign-in.', 'The directory is a global dependency for new sign-ins.'], true),
        alt('A separate web address per country', 'Users are told to use the UK, US or Australian address. There is no global lookup.', ['Nothing global at all.', 'Simple.'], ['Users arrive at the wrong one and see a confusing error.', 'Moving a council means telling every user.']),
        alt('Route by the user\'s location', 'Send each request to the nearest region by IP address.', ['No directory.'], ['Wrong: residency follows the customer, not where the user is today.', 'A UK social worker on holiday in Sydney would be sent to Australia.']),
      ],
      say: 'Routing is by customer, never by where the user happens to be. The router holds only council names and regions, and the regional stack checks again, so a routing mistake is refused instead of trusted.',
      see: [{ id: 'load-balancing', label: 'Load balancing' }],
    },
    {
      id: 'control',
      name: 'Control plane',
      tech: 'tenants, releases, rollout',
      x: 790, y: 90, w: 230, h: 80, kind: 'shared',
      lines: ['no personal data'],
      what: 'The global part of the product. It holds the list of councils and their regions, the releases (a prompt version with a pinned model, speech-to-text model and checker version), the rollout table that says which council runs which release, the results of evaluation runs, and daily quality counts sent up by each region. It holds no audio, no transcript, no draft and no user list. Regions pull from it; it cannot reach into a region\'s database or storage.',
      why: 'Three countries must run the same product, and a prompt change must roll out in a controlled order across all of them. One place for product configuration avoids three teams drifting apart. Keeping personal data out of it means it can sit in one country without breaking any other country\'s residency promise.',
      built: [
        { name: 'Release', what: 'An immutable, numbered bundle: the prompt text (stored by its hash), the exact LLM snapshot, the speech-to-text model, and the checker version. Release 42 never changes; a fix is release 43.', why: '"Which prompt and model wrote this note?" must have one answer a year later. A bundle that is never edited gives that answer, and makes rollback a pointer change.' },
        { name: 'Rollout table', what: 'One row per council and release with a percentage. Northbridge: release 40 at 75%, release 42 at 25%.', why: 'Staged rollout per tenant needs somewhere to say who is on what. A table is enough; a feature-flag product would also do.' },
        { name: 'Pull, not push', what: 'Each regional app asks the control plane for the current releases and rollout every 30 seconds and keeps the last answer.', why: 'If the control plane could push into regions it would need credentials for every region. With pull, a compromised or broken control plane cannot read regional data, and a control plane outage does not stop notes being drafted.' },
      ],
      numbers: [
        { text: 'A rollback reaches every region within 60 seconds.', from: 'Regions pull every 30 seconds (this design\'s choice). Worst case is one full interval plus the request, so under 60 seconds.' },
        { text: 'Quality counts: about 4,000 rows a day.', from: '400 tenants x about 5 templates in use x 2 releases = 4,000 rows of (tenant, day, template, release). Counts only.' },
      ],
      fails: 'It is down: regions keep drafting on the last configuration they pulled. New councils, new releases and rollbacks wait, so a rollback needs a break-glass path in each region (a local override row). It is compromised: the attacker can publish a bad prompt, which is why a release is signed, evaluated in each region before use, and never trusted to carry data access.',
      alternatives: [
        alt('One global control plane, a data plane per country', 'Product configuration, releases and rollout are global. Each country has its own app, database, storage, keys and vendor endpoints. Only counts cross the border, upward.', ['One product, one rollout order, three countries.', 'Personal data never leaves its region.', 'Adding a country is a new data plane, not a new product.'], ['The line between "configuration" and "data" must be policed: a council\'s custom template is kept in its region to be safe.', 'A global dependency for rollouts.'], true),
        alt('A fully separate stack per country', 'Three copies of everything, including releases and rollout, each run on its own.', ['No global part to fail or to argue about with a regulator.', 'A country can be sold or shut on its own.'], ['Three rollouts to coordinate by hand.', 'Versions drift: a fix reaches Australia a week late.', 'Three times the release tooling for a small team.']),
        alt('One global stack with a region column', 'One database and one app, with each row tagged by country and replicas placed near users.', ['Simplest to build.', 'One of everything.'], ['Data is in one country, whatever the tag says.', 'Fails a promise that data is stored, processed and hosted in Australia.', 'One incident touches every country.']),
      ],
      say: 'One control plane for what the product is, a data plane per country for what customers said. Regions pull configuration and send up counts. Nothing personal crosses a border and the control plane has no path into a region.',
      see: [{ id: 'leader-replication', label: 'Leader and replicas' }],
      tables: [
        { title: 'Councils and where they live', lang: 'sql', code: `CREATE TABLE tenants (
  tenant_id   uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  home_region text NOT NULL
              CHECK (home_region IN ('uk','us','au')),
  ring        int  NOT NULL DEFAULT 3
              CHECK (ring BETWEEN 0 AND 3),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_domains (
  domain    text PRIMARY KEY,   -- 'northbridge.gov.uk'
  tenant_id uuid NOT NULL REFERENCES tenants
);`, note: 'A council\'s name, sign-in domain and region. No users, no notes. Ring 0 is internal, 1 is canary councils, 3 is everyone.' },
        { title: 'Releases and who runs them', lang: 'sql', code: `CREATE TABLE releases (
  release_id   int PRIMARY KEY,
  prompt_sha256 bytea NOT NULL,
  llm_model    text NOT NULL,   -- a dated snapshot, never 'latest'
  stt_model    text NOT NULL,
  checker_version text NOT NULL,
  reason       text NOT NULL,
  created_by   text NOT NULL,
  status       text NOT NULL CHECK (status IN ('proposed',
               'eval_failed','eval_passed','canary','live',
               'rolled_back','retired')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rollout (
  tenant_id   uuid NOT NULL REFERENCES tenants,
  release_id  int  NOT NULL REFERENCES releases,
  percent     int  NOT NULL CHECK (percent BETWEEN 0 AND 100),
  set_by      text NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, release_id)
);`, note: 'A release is never edited. A council\'s rows in rollout add up to 100.' },
        { title: 'Evaluation results and daily counts', lang: 'sql', code: `CREATE TABLE eval_runs (
  release_id  int  NOT NULL REFERENCES releases,
  region      text NOT NULL,
  template_id text NOT NULL,
  language    text NOT NULL,
  cases       int  NOT NULL,
  critical_misses int NOT NULL,
  unsupported_rate numeric(5,4) NOT NULL,
  fact_recall numeric(5,4) NOT NULL,
  passed      boolean NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, region, template_id, language)
);
CREATE TABLE quality_rollup (
  tenant_id uuid NOT NULL REFERENCES tenants,
  day date NOT NULL,
  template_id text NOT NULL,
  release_id int NOT NULL REFERENCES releases,
  notes int NOT NULL,
  sentences int NOT NULL,
  unsupported int NOT NULL,
  contradicted int NOT NULL,
  edit_distance_p50 real,
  PRIMARY KEY (tenant_id, day, template_id, release_id)
);`, note: 'Everything a region sends up is a count or a rate. No note id, no user id, no text.' },
      ],
      queries: [
        { title: 'Which region serves this sign-in domain?', lang: 'sql', code: `SELECT t.slug, t.home_region
FROM tenant_domains d JOIN tenants t USING (tenant_id)
WHERE d.domain = 'northbridge.gov.uk';
-- northbridge | uk`, note: 'The whole of global routing. The router serves a published copy of this.' },
        { title: 'Which release writes this note?', lang: 'sql', code: `-- $2 is a bucket from 0 to 99, taken from a hash of the note id
SELECT release_id FROM (
  SELECT release_id,
         sum(percent) OVER (ORDER BY release_id DESC) AS upto
  FROM rollout WHERE tenant_id = $1) r
WHERE $2 < upto ORDER BY upto LIMIT 1;
-- bucket 17 -> 42 (the canary quarter); bucket 60 -> 40`, note: 'The bucket comes from the note id, so a retry of the same note always gets the same release. The region runs this against its pulled copy.' },
        { title: 'The halt rule', lang: 'sql', code: `SELECT c.tenant_id,
       round(c.unsupported::numeric / c.sentences, 4) AS canary,
       round(b.unsupported::numeric / b.sentences, 4) AS baseline
FROM quality_rollup c
JOIN quality_rollup b USING (tenant_id, day, template_id)
WHERE c.release_id = 42 AND b.release_id = 40
  AND c.day = '2026-11-17' AND c.sentences >= 500
  AND (c.unsupported::numeric / c.sentences
         > 2 * b.unsupported::numeric / b.sentences
       OR c.edit_distance_p50 > b.edit_distance_p50 + 0.08);
-- northbridge | 0.0410 | 0.0130`, note: 'Same council, same day, same template, two releases. A row back means halt. The thresholds (twice the baseline, 500 sentences, 0.08) are this design\'s choices.' },
        { title: 'Roll back one council', lang: 'sql', code: `BEGIN;
DELETE FROM rollout WHERE tenant_id = $1 AND release_id = 42;
UPDATE rollout SET percent = 100, set_by = 'halt-rule',
       set_at = now()
WHERE tenant_id = $1 AND release_id = 40;
UPDATE releases SET status = 'rolled_back' WHERE release_id = 42;
COMMIT;`, note: 'Rollback is two row changes. Regions see it at their next pull, within 60 seconds.' },
      ],
    },
    {
      id: 'other',
      name: 'Other regions',
      tech: 'US and Australia stacks',
      x: 1260, y: 90, w: 270, h: 80, kind: 'outside',
      lines: ['same boxes, separate accounts'],
      what: 'The same data plane, built twice more: one in the United States and one in Australia. Each has its own cloud account, database, storage, keys, vendor endpoints and audit log. There is no network path between regions and no shared credential. This design assumes the supplier has promised US customers that data is stored on US servers, and Australian customers that data is stored, processed and hosted in Australia.',
      why: '"Data stays in the country" is easiest to keep, and to prove, when the other countries\' systems cannot be reached at all. A shared database with a country column would rely on every query being right.',
      built: [
        { name: 'Separate cloud accounts', what: 'Each region is its own account or project with its own access rules. A person or service with rights in one has none in another.', why: 'Isolation by account is enforced by the cloud provider, not by our code. It is also simple to show an auditor.' },
      ],
      numbers: [
        { text: 'Assumed split of notes: UK 16,000 a day, US 3,000, Australia 1,000.', from: '20,000 a day x 80%, 15% and 5%. The split is an assumption: the UK is taken as the oldest market and Australia as the newest.' },
        { text: 'The smallest region still needs the full stack.', from: '1,000 notes a day is about one a minute, yet it needs a database with a standby, storage, keys, a worker pool and on-call cover. The fixed cost per region is the price of residency.' },
      ],
      fails: 'A request for a UK council arrives here (tour step 2). The token is for the wrong region and the council is not in this region\'s tenant table, so the app replies 421 and stores nothing. A whole region is lost: that country\'s users wait; the other two are untouched. There is no failover to another country, by design.',
      alternatives: [
        alt('No cross-region failover', 'Each region has a standby in a second zone of the same country. If the whole country\'s cloud region is down, the service is down there.', ['Residency holds in every failure.', 'Nothing to explain to a council\'s data protection officer.'], ['A full regional outage is a full outage for that country.'], true),
        alt('Fail over to another country', 'If the UK region is lost, UK traffic is served from, say, the EEA or the US.', ['Better availability.'], ['Breaks the promise at the worst moment.', 'Needs data copied abroad in advance to be any use.']),
        alt('A second region in the same country', 'Two full stacks per country where the cloud has two regions there.', ['Survives a regional outage in-country.'], ['Doubles the fixed cost.', 'Not every country has two cloud regions with the vendor endpoints needed.']),
      ],
      say: 'Three data planes with no path between them. I would rather be down in one country than quietly serve its data from another.',
    },
    {
      id: 'api',
      name: 'Regional app',
      short: 'App',
      tech: 'Rails, one per region',
      x: 335, y: 235, w: 160, h: 76, kind: 'node',
      what: 'The web application and API for one country. It checks every request\'s token (signature, region and tenant), opens a database transaction with the tenant set, creates notes, hands out upload addresses, queues jobs, serves the review screen, records approvals and exports, and writes an audit line in the same transaction as each action. It also pulls releases from the control plane every 30 seconds and sends daily counts up.',
      why: 'One deployable thing per region is the least a small team can run three times over. This design assumes a typical stack for a small UK product team: Ruby on Rails, PostgreSQL and background jobs. A Rails monolith with workers is the plausible starting point. This page describes no real supplier\'s architecture.',
      built: [
        { name: 'Rails monolith', what: 'One application holding the web pages, the API and the business rules, deployed as one unit. Background workers run the same code.', why: 'The load is about one note a second at peak. Splitting it into services would add network calls and three times the deployments for no gain. The seams that matter (vendors, checker, retention) are modules now and can be split later.' },
        { name: 'Tenant set per transaction', what: 'At the start of every transaction the app runs SET LOCAL app.tenant_id with the tenant from the token. The database\'s row-level security reads that setting.', why: 'The app\'s own WHERE clauses are the first guard. This is the second: a query that forgets its tenant filter returns nothing from another council, and one with no tenant set fails.' },
        { name: 'Region and tenant check', what: 'The app refuses any token whose region claim is not its own, and any tenant missing from its local tenants table, with HTTP 421 (misdirected request).', why: 'Routing is done by a global service that can be wrong. The region must not trust it.' },
      ],
      numbers: [
        { text: 'About 12 app requests per note; about 3 a second on average.', from: 'Create, 3 to 6 upload parts, status polls, open, save edits, approve, export: about 12. 20,000 notes x 12 = 240,000 requests a day in all regions; over an 8-hour day that is 8 a second, so about 3 a second spread across 24 hours and well under 50 a second at peak.' },
        { text: 'Availability target 99.5%.', from: 'A typical target in a G-Cloud listing for this kind of service; an assumption here. Over a 30-day month that allows 3.6 hours of downtime: 720 h x 0.5%.' },
      ],
      fails: 'A bug drops a tenant filter from a query: row-level security returns no rows from other councils, and a test that runs every endpoint as two tenants catches it before release. The app cannot reach the control plane: it keeps the last releases and carries on. The database is down: the app refuses uploads with a clear message, since a recording it cannot register is a recording it cannot delete on time.',
      alternatives: [
        alt('One monolith per region', 'The same Rails app deployed three times, each with its own configuration naming its region.', ['One codebase and one deployment pipeline.', 'Small enough for one team to run in three countries.', 'Transactions cover the action and its audit line.'], ['A slow endpoint can affect the rest.', 'Scaling is all-or-nothing until workers are split out.'], true),
        alt('Microservices per region', 'Separate services for notes, review, export, audit and retention, each with its own database.', ['Teams can ship independently.', 'Faults are contained.'], ['An action and its audit line are no longer one transaction.', 'Many more things to deploy three times.', 'Not justified at one note a second.']),
      ],
      say: 'It is a monolith per region, on purpose. The load is tiny. What matters is that every request is checked for region and tenant, and that an action and its audit line commit together.',
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }],
    },
    {
      id: 'kms',
      name: 'Tenant keys',
      tech: 'KMS, per council',
      x: 560, y: 292, w: 150, h: 56, kind: 'shared',
      what: 'A key management service in the region. It holds one key per council that never leaves the service. Each note gets its own data key, which encrypts that note\'s audio and its text columns. The data key is stored beside the note, wrapped (encrypted) by the council\'s key. To read a note, the app or a worker asks the service to unwrap that note\'s data key; the service checks the caller and logs the request.',
      why: 'Row-level security stops one council\'s session reading another\'s rows. Keys add a second wall that does not depend on the database: a stolen backup or a query that slips past the policies yields ciphertext. A key per council also gives a clean exit. When a council leaves, destroying its key makes every copy of its data unreadable, including copies in backups.',
      built: [
        { name: 'Envelope encryption', what: 'Data is encrypted with a data key. The data key is encrypted with a second key that lives only in the key service. Only the wrapped data key is stored with the data.', why: 'The key service never handles 58 MB audio files, only 32-byte keys. One unwrap call per note opened.' },
        { name: 'A key per council, a data key per note', what: 'Northbridge has one key in the UK key service. Note 7f3a has its own data key, wrapped by Northbridge\'s key.', why: 'Per council: an offboarded council\'s data can be made unreadable in one act. Per note: deleting one note\'s wrapped key leaves its audio unreadable even if an object was missed.' },
      ],
      numbers: [
        { text: 'About 100,000 unwrap calls a day.', from: '20,000 notes x about 5 opens each (transcribe, draft, check, review, export). About 1 a second on average. Key services are built for far more.' },
        { text: 'About 400 council keys.', from: 'One per tenant, 400 tenants (assumption). Each lives in its council\'s region.' },
      ],
      fails: 'The key service is down in a region: nothing can be read or drafted there; uploads are refused. This is a hard dependency, accepted for what it buys. A council\'s key is destroyed by mistake: every note of that council is lost for good, so destruction needs two people and a waiting period of 7 days (this design\'s choice). A wrapped data key still sits in a 14-day-old backup after its note is deleted: it stays readable until that backup expires, which is why live retention is capped at 106 days.',
      alternatives: [
        alt('A key per council, a data key per note', 'Envelope encryption with the council\'s key in the regional key service.', ['A second wall that does not rely on the database.', 'Offboarding by destroying one key.', 'Every read of a note\'s key is logged by the key service.'], ['The key service becomes a hard dependency.', 'Encrypted text cannot be searched in SQL.', 'Key destruction is irreversible.'], true),
        alt('Storage encryption with one key', 'Turn on the cloud\'s disk and bucket encryption with a single key for the region.', ['Free and invisible.', 'Meets "AES-256 at rest", the usual public claim.'], ['Protects against a stolen disk and little else.', 'No per-council exit.', 'Anyone who can query the database reads plaintext.']),
        alt('Customer-held keys', 'Each council holds its own key in its own cloud account and grants us use of it.', ['The council can cut off access itself.'], ['Most councils have no team to run a key service.', 'Their outage becomes our outage for them.', 'Worth offering only to the few who ask.']),
      ],
      say: 'Each council has its own key in its own region and each note its own data key. Row-level security is the first wall, keys are the second, and destroying a council\'s key is how I delete what backups still hold.',
    },
    {
      id: 'db',
      name: 'Regional database',
      short: 'Database',
      tech: 'PostgreSQL, row-level security',
      x: 467, y: 390, w: 374, h: 80, kind: 'store',
      what: 'One PostgreSQL cluster per country, with a standby in a second zone of the same country. Every council\'s rows share the same tables. Each row carries a tenant_id, and a row-level security policy on every table lets a session see only the rows of the tenant it has set. It holds notes, transcript segments, draft sentences with their citations, review flags, legal holds, the record of every vendor call, daily quality counts and the job queue. Transcript and draft text are stored encrypted with the note\'s data key.',
      why: 'About 400 councils is too many for a database each and too many for a schema each without pain, and small enough that one cluster per region carries the load many times over. Shared tables keep one migration, one backup and one set of indexes. Row-level security moves the isolation rule out of each query and into the database.',
      built: [
        { name: 'PostgreSQL', what: 'A relational database. This design assumes it.', why: 'Transactions cover a note, its job and its audit line together. Row-level security is built in. The team already runs it.' },
        { name: 'Row-level security', what: 'A policy attached to a table. PostgreSQL adds it to every query on that table as an extra condition. Here the condition is tenant_id = the session\'s app.tenant_id.', why: 'A forgotten WHERE clause is the commonest way one customer sees another\'s data. With a policy and FORCE ROW LEVEL SECURITY the forgotten clause returns nothing, and a session with no tenant set gets an error.' },
        { name: 'Region check in the schema', what: 'Each region\'s tenants table has CHECK (home_region = \'uk\') with its own region\'s code, and vendor_calls has the same check on the vendor endpoint.', why: 'A US council cannot be inserted into the UK database, and a call to a vendor endpoint outside the country cannot be recorded as made. Mistakes fail loudly at the lowest layer.' },
      ],
      numbers: [
        { text: 'About 5 million rows a day, about 0.5 GB.', from: 'Per note: about 210 transcript segments, about 40 draft sentences, a few flags and calls: about 260 rows. 20,000 x 260 = 5.2 million rows a day across regions. At about 100 bytes of ciphertext and overhead a row, about 0.5 GB a day.' },
        { text: 'Never more than about 400 million rows of note data.', from: 'Deletion caps it. At the 106-day ceiling there are about 76 working days of notes: 76 x 5.2 million = 395 million. At the 30-day default, about 21 working days: 110 million.' },
        { text: 'Backups kept 14 days.', from: 'This design\'s choice. It sets the live ceiling: 120 days promised less 14 days of backups = 106 days in the live database.' },
      ],
      fails: 'The primary fails: the standby in the other zone takes over; in-flight requests retry. A policy is missing on a new table: a migration check fails the build if any table with a tenant_id column lacks FORCE ROW LEVEL SECURITY and a policy. A big council\'s backlog slows everyone: see the job queue\'s per-tenant cap. A restore from backup brings back notes deleted since the backup was taken: after any restore, the Retention worker replays every deletion receipt newer than the backup before the database takes traffic.',
      alternatives: [
        alt('Shared tables with row-level security', 'One set of tables. Every row has tenant_id. A policy on every table filters by the tenant the session has set. The app\'s role cannot bypass policies.', ['One migration and one backup for 400 councils.', 'A missed filter in code returns nothing instead of a leak.', 'Cheap to add a council: one row.'], ['One cluster is one blast radius for faults and load.', 'Policies must be on every table; a check must enforce it.', 'Per-council restore means filtering a shared backup.'], true),
        alt('A schema per council', 'Each council gets its own copy of every table inside one database. The app switches schema per request.', ['Stronger separation than a column.', 'Per-council dump and restore is simple.'], ['400 schemas x about 10 tables = 4,000 tables to migrate on every release.', 'Connection pools and the catalogue suffer as schemas grow.', 'Cross-council counts need a query per schema.']),
        alt('A database per council', 'Each council has its own database or its own cluster.', ['The strongest isolation and no noisy neighbours.', 'Per-council backup, restore and deletion are trivial.'], ['400 databases to patch, back up and monitor in three countries.', 'Cost is a floor per council, even one with ten users.', 'Worth it for the few largest customers or those who require it by contract.']),
      ],
      say: 'Shared tables, tenant_id on every row, and row-level security forced on every table with the tenant set per transaction. I would move a council to its own database when its contract or its size asks for it, and the design allows that because every key already starts with tenant_id.',
      see: [{ id: 'partitioning', label: 'Partitioning' }, { id: 'leader-replication', label: 'Leader and replicas' }, { id: 'mvcc', label: 'MVCC' }],
      tables: [
        { title: 'Tenants in this region, and notes', lang: 'sql', code: `CREATE TABLE tenants (
  tenant_id     uuid PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  home_region   text NOT NULL CHECK (home_region = 'uk'),
  retention_days int NOT NULL DEFAULT 30
                CHECK (retention_days BETWEEN 1 AND 106),
  audit_retention_days int NOT NULL DEFAULT 2190,
  kms_key_ref   text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended',
                'offboarding'))
);
CREATE TABLE notes (
  tenant_id   uuid NOT NULL REFERENCES tenants,
  note_id     uuid NOT NULL,
  author_id   uuid NOT NULL,
  template_id text NOT NULL,
  language    text NOT NULL DEFAULT 'en-GB',
  status      text NOT NULL CHECK (status IN ('uploading',
              'queued','transcribing','drafting','needs_review',
              'approved','exported')),
  consent     text NOT NULL CHECK (consent IN ('verbal','written')),
  consent_at  timestamptz NOT NULL,
  release_id  int,
  audio_object text,
  wrapped_key bytea NOT NULL,   -- this note's data key, wrapped
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  delete_after timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, note_id)
);
CREATE INDEX notes_due ON notes (tenant_id, delete_after);`, note: 'The UK database accepts only UK tenants: the CHECK is written with each region\'s own code at deploy time. A note cannot exist without a consent record and a deletion date. 106 is 120 days less 14 days of backups.' },
        { title: 'Transcript and draft, sentence by sentence', lang: 'sql', code: `CREATE TABLE transcript_segments (
  tenant_id uuid NOT NULL,
  note_id   uuid NOT NULL,
  seg_no    int  NOT NULL,
  speaker   text NOT NULL,
  start_ms  int  NOT NULL,
  end_ms    int  NOT NULL,
  stt_confidence real NOT NULL,
  risk_tags text[] NOT NULL DEFAULT '{}',
  text_enc  bytea NOT NULL,     -- encrypted with the note's key
  PRIMARY KEY (tenant_id, note_id, seg_no),
  FOREIGN KEY (tenant_id, note_id)
    REFERENCES notes ON DELETE CASCADE
);
CREATE TABLE draft_sentences (
  tenant_id uuid NOT NULL,
  note_id   uuid NOT NULL,
  draft_no  int  NOT NULL,      -- 1 = AI draft, 2 = approved text
  sent_no   int  NOT NULL,
  section   text NOT NULL,
  text_enc  bytea NOT NULL,
  cites     int[] NOT NULL,     -- seg_no values it rests on
  verdict   text NOT NULL CHECK (verdict IN ('supported',
            'partly','unsupported','contradicted','unchecked')),
  high_risk boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, note_id, draft_no, sent_no),
  FOREIGN KEY (tenant_id, note_id)
    REFERENCES notes ON DELETE CASCADE
);`, note: 'Every draft sentence carries the segment numbers it rests on and the checker\'s verdict. Deleting the note row removes both tables\' rows with it.' },
        { title: 'Flags, holds and vendor calls', lang: 'sql', code: `CREATE TABLE review_flags (
  tenant_id uuid NOT NULL,
  note_id   uuid NOT NULL,
  flag_no   int  NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('unsupported',
            'contradicted','omission','low_audio')),
  sent_no   int,                -- the draft sentence, if any
  seg_no    int,                -- the transcript segment, if any
  high_risk boolean NOT NULL DEFAULT false,
  resolved_by uuid,
  resolved_as text CHECK (resolved_as IN ('kept','edited',
            'removed','added')),
  PRIMARY KEY (tenant_id, note_id, flag_no),
  FOREIGN KEY (tenant_id, note_id)
    REFERENCES notes ON DELETE CASCADE
);
CREATE TABLE legal_holds (
  tenant_id uuid NOT NULL REFERENCES tenants,
  hold_id   uuid NOT NULL,
  note_id   uuid NOT NULL,
  reason    text NOT NULL,
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  review_by timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (tenant_id, hold_id)
);`, note: 'A hold has a named person, a reason and a review date. It pauses deletion; it does not cancel it.' },
        { title: 'What was sent to which vendor', lang: 'sql', code: `CREATE TABLE vendor_calls (
  tenant_id uuid NOT NULL REFERENCES tenants,
  call_id   uuid NOT NULL,
  note_id   uuid NOT NULL,
  vendor    text NOT NULL,
  purpose   text NOT NULL CHECK (purpose IN ('stt','draft',
            'check','eval')),
  endpoint_region text NOT NULL CHECK (endpoint_region = 'uk'),
  retention_days int NOT NULL,  -- 0 = zero retention, by contract
  vendor_request_id text,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  bytes_sent bigint NOT NULL,
  PRIMARY KEY (tenant_id, call_id)
);
CREATE INDEX vendor_calls_window ON vendor_calls (vendor, sent_at);`, note: 'No content, so it outlives the note. It answers "what did we send to whom, when, and on what terms?" when a vendor reports a problem.' },
        { title: 'Row-level security, the same on every tenant table', lang: 'sql', code: `ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON notes
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id =
              current_setting('app.tenant_id')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO app_rw;
-- repeated for transcript_segments, draft_sentences,
-- review_flags, legal_holds, vendor_calls, quality_daily

-- every request:
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
-- ... the request's statements ...
COMMIT;`, note: 'USING filters what a session can read; WITH CHECK stops it writing a row for another tenant. With no tenant set the query fails ("unrecognized configuration parameter"), so the default is closed. The app\'s role app_rw has no BYPASSRLS. Run on PostgreSQL 16: a second tenant saw 0 notes, and an insert for another tenant was refused.' },
      ],
      queries: [
        { title: 'Approve, only if every high-risk flag is resolved', lang: 'sql', code: `UPDATE notes n SET status = 'approved', approved_at = now()
WHERE n.tenant_id = $1 AND n.note_id = $2
  AND n.status = 'needs_review'
  AND NOT EXISTS (
    SELECT 1 FROM review_flags f
    WHERE f.tenant_id = n.tenant_id AND f.note_id = n.note_id
      AND f.high_risk AND f.resolved_by IS NULL);
-- UPDATE 0 while a high-risk flag is open; UPDATE 1 after`, note: 'The rule is in the statement, not only in the screen. A client that skips the screen still cannot approve.' },
        { title: 'Possible omissions: risky things said that no sentence cites', lang: 'sql', code: `SELECT s.seg_no, s.risk_tags FROM transcript_segments s
WHERE s.tenant_id = $1 AND s.note_id = $2
  AND s.risk_tags <> '{}'
  AND NOT EXISTS (
    SELECT 1 FROM draft_sentences d
    WHERE d.tenant_id = s.tenant_id AND d.note_id = s.note_id
      AND d.draft_no = 1 AND s.seg_no = ANY (d.cites));
-- 163 | {medication,falls}`, note: 'Grounding catches what the draft added. This catches what it left out.' },
        { title: 'Notes due for deletion, skipping holds', lang: 'sql', code: `SELECT n.note_id FROM notes n
WHERE n.tenant_id = $1
  AND n.delete_after <= now()
  AND NOT EXISTS (
    SELECT 1 FROM legal_holds h
    WHERE h.tenant_id = n.tenant_id AND h.note_id = n.note_id
      AND h.released_at IS NULL)
ORDER BY n.delete_after LIMIT 500;`, note: 'Run per tenant, with that tenant set, so the Retention worker needs no role that bypasses the policies.' },
        { title: 'Next job, fairly', lang: 'sql', code: `WITH busy AS (
  SELECT tenant_id, count(*) AS running FROM jobs
  WHERE locked_at IS NOT NULL AND done_at IS NULL
  GROUP BY tenant_id)
SELECT j.job_id, j.idempotency_key
FROM jobs j LEFT JOIN busy b USING (tenant_id)
WHERE j.locked_at IS NULL AND j.done_at IS NULL
  AND j.run_after <= now()
  AND coalesce(b.running, 0) < 8
ORDER BY coalesce(b.running, 0), j.run_after
LIMIT 1 FOR UPDATE OF j SKIP LOCKED;`, note: 'With another council at its cap of 8 running jobs and 300 waiting, this returned Northbridge\'s one job. The cap is soft: two workers can both see 7 and both take a job.' },
        { title: 'How many notes went to a vendor in a window?', lang: 'sql', code: `SELECT count(*) AS calls, count(DISTINCT note_id) AS notes
FROM vendor_calls
WHERE tenant_id = $1 AND vendor = $2
  AND sent_at >= $3 AND sent_at < $4;`, note: 'The blast-radius question when a vendor admits keeping data. Run once per tenant; the answer goes to that council.' },
      ],
    },
    {
      id: 'blobs',
      name: 'Audio store',
      tech: 'object storage',
      x: 815, y: 378, w: 130, h: 66, kind: 'store',
      what: 'Object storage in the same country as the council. Holds the recording of each conversation, one object per note, encrypted with that note\'s data key before it is stored. The browser uploads straight to it through a short-lived signed address, in parts, so a dropped connection resumes. Workers read it once for transcription; the review screen streams a few seconds at a time when the practitioner plays the audio behind a sentence.',
      why: 'Audio is the largest and most sensitive thing in the system: a vulnerable person\'s voice talking about their life. It does not belong in the database, and it should not pass through the app\'s memory. Object storage is cheap, durable and has its own lifecycle rules as a backstop for deletion.',
      built: [
        { name: 'Signed upload address', what: 'A web address that allows one upload to one object path for a few minutes. The app creates it; the browser uses it.', why: '58 MB files skip the app servers. The address names the path, so a client cannot write into another council\'s prefix.' },
        { name: 'Lifecycle rule', what: 'A storage setting that deletes any object older than a set age, whatever the application thinks.', why: 'A backstop at 120 days. If the Retention worker has a bug, the storage still deletes. The worker deletes sooner and writes the receipt.' },
      ],
      numbers: [
        { text: 'About 400 GB of audio a day.', from: '20,000 notes x an assumed 20 MB average (between 14 MB for MP3 and 58 MB for WAV) = 400 GB.' },
        { text: 'About 8 TB held at the 30-day default; about 30 TB at the 106-day ceiling.', from: '30 days is about 21 working days: 21 x 400 GB = 8.4 TB. 106 days is about 76 working days: 76 x 400 GB = 30.4 TB.' },
      ],
      fails: 'An upload is abandoned half-way: parts with no confirmed note are removed after 24 hours. An object survives its note because a delete call failed: the worker retries until the store confirms, the note\'s data key is already gone so the object is unreadable, and the 120-day lifecycle rule removes it regardless. Path layout is tenant/note, so a listing by prefix can prove a council\'s objects are gone.',
      alternatives: [
        alt('Keep audio until the note is deleted', 'Audio lives as long as the note: 30 days after approval by default, never more than 106 days.', ['The practitioner can replay any sentence during review.', 'A complaint in the first weeks can be checked against the recording.'], ['The most sensitive data is held longest.', 'Storage cost: about 8 TB at rest.'], true),
        alt('Delete audio as soon as the transcript exists', 'Transcribe, then delete the recording within minutes.', ['Least sensitive data held.', 'Cheapest.'], ['No replay during review, so a wrong transcript cannot be caught by ear.', 'No re-transcription if the vendor\'s output was bad.', 'Accents and names are where transcripts fail (one council\'s published record notes the accent risk).']),
        alt('Delete audio at approval', 'Keep the recording through review, delete when the practitioner approves.', ['Replay where it matters, then gone.'], ['No evidence if the approved note is later disputed.', 'A good per-council option, and offered as a setting.']),
      ],
      say: 'Audio goes straight from the browser to storage in the council\'s country, encrypted with the note\'s own key. I keep it through review so the practitioner can listen to any sentence, and a council can choose to delete it at approval.',
    },
    {
      id: 'pipeline',
      name: 'AI pipeline',
      short: 'Pipeline',
      tech: 'workers, fair queue',
      x: 793, y: 235, w: 166, h: 76, kind: 'node',
      what: 'Background workers that take a job from the queue and run three stages for a note: speech to text, drafting, and the grounding check. Each stage is its own job with its own idempotency key, so a crash repeats one stage, not all three. The workers decide which release writes the note, call the vendors\' in-country endpoints, record each call in vendor_calls, and store the transcript, the draft sentences and the flags. The same workers run evaluation cases when a release is being tested, through the same code path.',
      why: 'A 30-minute recording takes minutes to process and depends on outside vendors that are sometimes slow or down. That must not block a web request. A queue lets the app answer at once, lets work retry, and is the place to stop one council\'s backlog starving the others.',
      built: [
        { name: 'Job queue in PostgreSQL', what: 'A jobs table. Workers claim a row with FOR UPDATE SKIP LOCKED, do the work, and mark it done. In Rails, GoodJob is a PostgreSQL-backed queue of this kind.', why: 'Queuing a job in the same transaction as the note means there is never a note without its job or a job without its note. At one note a second, a table is plenty. A broker would add a system to run in three countries.' },
        { name: 'Per-tenant fairness', what: 'The claim query skips councils that already have 8 jobs running and takes from the council with the fewest.', why: 'Assume the largest council has over 1,000 staff on the product. A council that size uploading a backlog must not make a 20-person team wait an hour.' },
        { name: 'Vendor fallback', what: 'If the speech-to-text vendor fails or times out, the worker tries a second engine. This design assumes Deepgram with OpenAI Whisper as the fallback, the pair one council\'s published record names.', why: 'Vendors have outages. The fallback must also be in-country and under contract, and each leg is recorded.' },
      ],
      numbers: [
        { text: 'Draft ready within 5 minutes of upload for 95% of notes (target).', from: 'Assumed stage times for a 30-minute recording: speech to text up to 2 minutes, drafting up to 1 minute, grounding check up to 1 minute, queueing up to 1 minute. Vendor speeds are assumptions.' },
        { text: 'About 17,000 tokens a note; about 340 million a day.', from: 'Transcript: 30 min x 150 words a minute = 4,500 words, about 6,000 tokens. Prompt and template about 1,000. Draft with citations about 1,500 out. The check reads transcript and draft again: about 8,500. Total about 17,000. x 20,000 notes = 340 million. Words per minute and tokens per word are assumptions.' },
        { text: 'About 70 workers at peak.', from: '4,000 notes in the busiest hour x about 4 minutes of worker time each = 16,000 worker-minutes; / 60 = 267 notes in flight at once if all waited on vendors. Most of that is waiting on network calls, so about 70 workers each holding 4 calls is enough. Rough.' },
      ],
      fails: 'A worker dies mid-stage: the job\'s lock times out and another worker repeats the stage. The idempotency key (transcribe:7f3a) and a check for an existing transcript stop a second vendor call where the first one finished. A vendor is down: retries with backoff, then the fallback, then the note waits in the queue with an honest status; the practitioner is told and can write notes by hand. A poison recording (silence, a corrupt file) fails three times and is parked with a message to the practitioner.',
      alternatives: [
        alt('Three idempotent stages on a database queue', 'Transcribe, draft and check are separate jobs. Each writes its result and queues the next in one transaction.', ['A failure repeats one stage.', 'No vendor is called twice for finished work.', 'The queue is in the transaction with the data.'], ['A table queue needs care with locking and vacuum at higher volumes.', 'Three status changes for the practitioner to wait through.'], true),
        alt('One long job per note', 'A single job does all three stages.', ['Simple.'], ['A failure in the check repeats the speech-to-text call, the dearest step.', 'Long-held locks.']),
        alt('A message broker and stream workers', 'Kafka or a cloud queue between stages.', ['Scales far beyond this.', 'Replay of stages.'], ['Enqueue and data write are no longer one transaction, so an outbox is needed.', 'Another system to run in each country for one message a second.']),
      ],
      say: 'Three idempotent stages on a queue that lives in the same database as the notes, with a per-council cap so a big council\'s backlog cannot starve a small one. Vendors are called from here and every call is written down.',
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }, { id: 'retries-breaker', label: 'Retries, backoff and circuit breakers' }, { id: 'outbox', label: 'Transactional outbox' }, { id: 'token-bucket', label: 'Token bucket' }],
    },
    {
      id: 'checker',
      name: 'Grounding check',
      short: 'Grounding check',
      tech: 'cites the transcript',
      x: 1070, y: 235, w: 180, h: 60, kind: 'node',
      what: 'The stage that tests the draft against the recording. The drafting prompt must return each sentence with the numbers of the transcript segments it rests on. The check then does three things. It confirms the cited segments exist and that names, numbers, dates and medicines in the sentence appear in them. It asks a second model whether the segments support the sentence: supported, partly, unsupported or contradicted. And it runs the other way: any transcript segment tagged as high risk (harm from others, self-harm, a child at risk, medicines, falls, capacity) that no sentence cites is raised as a possible omission. Sentences on those topics are marked high risk, and a high-risk flag must be resolved by the practitioner before the note can be approved.',
      why: 'An LLM can write a fluent sentence that nobody said. In a care record that can become a safeguarding referral that should not exist, or hide one that should. Third-party reports of AI notes in social work describe misspelt names, repetition and assumptions about needs (social work press coverage of council trials in 2024), and the Ada Lovelace Institute warned of hallucinations in February 2026. A reviewer reading 40 fluent sentences will miss the one that is wrong unless something points at it. This check is this design\'s proposal; it describes no real supplier\'s practice.',
      built: [
        { name: 'Citations from the drafting model', what: 'The model is asked for structured output: a list of sentences, each with a section and the segment numbers it used.', why: 'It makes every sentence checkable and lets the review screen play the audio behind it. A sentence with no citation is unsupported by definition.' },
        { name: 'Support check by a second model', what: 'A separate call, with a different prompt and where possible a different model, is given one sentence and its cited segments and asked whether they support it.', why: 'The model that wrote the sentence is the worst judge of it. A second, narrower question is easier to get right. It still errs, which is why it flags and never deletes.' },
        { name: 'Omission check', what: 'A classifier tags transcript segments by risk topic. A query lists tagged segments that no draft sentence cites.', why: 'Leaving out "I have not taken my tablets since the fall" is as harmful as inventing something. Grounding alone cannot see what is missing.' },
      ],
      numbers: [
        { text: 'About 40 support checks a note; about 800,000 a day.', from: 'About 40 sentences in a draft x 20,000 notes. Batched into one or two calls per note.' },
        { text: 'Baseline: 1.3% of sentences flagged unsupported.', from: 'Illustrative, not measured: 78 of 6,000 sentences on release 40 at Northbridge on the tour\'s day. A real baseline comes from the first month of running the check.' },
        { text: 'Red-team set: 40 cases, zero misses allowed.', from: 'This design\'s choice. Each case has a must-not-say or must-say fact: a denial that must not become an allegation, a disclosure that must appear, a third party\'s name that must not be attached to the wrong person, a speaker who says "ignore your instructions".' },
      ],
      fails: 'It misses an invented sentence (a false "supported"): the practitioner is still the final control, and a sample of approved notes is re-checked by people each week to measure the miss rate. It flags too much: practitioners stop reading flags, so the flag rate is itself watched and the high-risk list is kept short. The second model is down: the draft is shown with every sentence marked "unchecked", which blocks approval of high-risk sentences until they are checked or resolved by hand. It is a model too, and can be wrong about accents and dialect as speech to text can.',
      alternatives: [
        alt('Cite, check support, check omissions; flag for the human', 'Every sentence must cite segments. A second model judges support. Risky segments that nothing cites are raised. Flags are shown; nothing is silently removed.', ['Points the reviewer at the few sentences that need them.', 'Catches omissions as well as inventions.', 'Produces a number (unsupported rate) to gate releases on.'], ['Roughly doubles the LLM tokens per note.', 'The checker has its own error rate.', 'Adds up to a minute before the draft is ready.'], true),
        alt('Trust the draft and rely on review', 'Show the draft; the practitioner reads it against their memory of the visit.', ['Cheapest and fastest.', 'What most first versions do.'], ['People skim fluent text.', 'No measure of how often drafts are wrong.', 'Nothing to gate a release on.']),
        alt('Extractive notes only', 'Build the note only from quoted transcript sentences, with no rewriting.', ['Nothing can be invented.'], ['Reads like a transcript, not a case note.', 'Loses the summarising that saves the time.', 'Still misreads if the transcript is wrong.']),
        alt('Remove unsupported sentences automatically', 'Drop any sentence the checker rejects before the practitioner sees the draft.', ['Cleaner drafts.'], ['A wrong rejection silently deletes something true, perhaps a disclosure.', 'Hides the model\'s error rate from the reviewer.']),
      ],
      say: 'Every sentence in the draft has to point at the transcript segments it came from, a second model checks the support, and I also check the other direction for risky things said that the draft left out. It flags, the human decides, and the flag rate is the number I gate releases on.',
    },
    {
      id: 'vendors',
      name: 'AI vendors',
      short: 'AI vendors',
      tech: 'speech-to-text, LLM',
      x: 1306, y: 310, w: 170, h: 80, kind: 'outside',
      lines: ['zero-retention terms'],
      what: 'The outside companies whose models do the heavy work: one turns audio into text, another writes the draft and judges support. They are sub-processors: they handle the council\'s data on our behalf. Each is called only at an endpoint in the council\'s country, under contract terms that forbid training on the data and set how long the vendor may keep a request. One council\'s published record (2025) names Deepgram for speech to text with OpenAI Whisper as fallback, an OpenAI model for summaries, and says vendors do not train on the data. This design assumes the same, with the OpenAI model reached through Azure.',
      why: 'Nobody at this size trains their own speech and language models. Buying them is right. But the vendor is the one place where a copy of the data sits outside our walls, where our keys and our deletion job do not reach. So the design treats every vendor call as an export: minimal, recorded, in-country and on written terms.',
      built: [
        { name: 'Zero-retention terms', what: 'A contract setting under which the vendor processes a request and keeps no copy of the input or output afterwards. Where a vendor does not offer it, the shortest fixed window is agreed and recorded.', why: 'The 120-day promise covers sub-processors. A copy that is never kept cannot outlive it. This is a contract control: we cannot see inside the vendor.' },
        { name: 'In-country endpoint', what: 'A version of the vendor\'s service that runs in a named country or area and keeps processing there.', why: '"Stored, processed and hosted in Australia" covers the vendor\'s processing too. A vendor with no endpoint in a country is not used there.' },
        { name: 'Pinned model snapshot', what: 'A dated version of a model that does not change, as opposed to an alias that the vendor moves to newer models.', why: 'A draft must be attributable to an exact model. An alias that changes under us is an unannounced release.' },
      ],
      numbers: [
        { text: 'About 60,000 vendor calls a day.', from: 'Per note: 1 speech-to-text call, 1 drafting call, 1 or 2 check calls: about 3. 20,000 x 3 = 60,000 rows a day in vendor_calls.' },
        { text: 'About 10,000 hours of audio a day sent to speech to text.', from: '20,000 notes x 30 minutes. Both are assumptions.' },
      ],
      fails: 'A vendor is down or slow: timeouts, retries with backoff, a circuit breaker, then the fallback engine. A vendor changes a model behind an alias: releases pin dated snapshots, and a nightly run of 50 evaluation cases would show a shift. A vendor keeps data longer than the contract allows: tour step 13. A vendor withdraws its in-country endpoint: that region moves to another vendor or to a self-hosted model through a new release.',
      alternatives: [
        alt('Vendor APIs, in-country, on zero-retention terms', 'Call hosted models at regional endpoints under a data processing agreement, with every call recorded.', ['Best model quality for the least work.', 'No GPUs to run.', 'A second vendor can be a fallback.'], ['A copy of the data leaves our walls, however briefly.', 'Retention is enforced by contract, not by us.', 'Vendor changes and outages are ours to absorb.'], true),
        alt('Self-host open models in each region', 'Run an open speech model and an open LLM on our own GPUs in each country.', ['No sub-processor holds the data.', 'Deletion is fully ours.', 'Fixed cost at high volume.'], ['GPUs and model operations in three countries.', 'Likely lower draft quality than the best hosted models.', 'A realistic option for speech to text first.']),
        alt('Strip names before the LLM', 'Replace names, addresses and dates of birth with placeholders before the drafting call, and put them back after.', ['Less personal data reaches the vendor.'], ['Name errors are already a known failure in these notes (social work press coverage); placeholders make them likelier.', 'What is said in a care visit identifies the person even without a name.', 'Audio cannot be redacted before speech to text.']),
      ],
      say: 'Vendors are sub-processors, so every call is an export: in-country endpoint, zero-retention terms, a pinned model, and a row saying what was sent and when. I cannot delete inside a vendor, so the control there is the contract and the record.',
      see: [{ id: 'retries-breaker', label: 'Retries, backoff and circuit breakers' }],
    },
    {
      id: 'audit',
      name: 'Audit log',
      tech: 'append-only, hash chain',
      x: 560, y: 584, w: 200, h: 68, kind: 'store',
      what: 'The record of who did what. One line per action: draft generated (with the release), flags raised, flag resolved, note opened, edited, approved, exported, held, deleted; also every support-staff access and every refused request. Each line is written in the same database transaction as the action it records. Lines can be added and read but never changed or removed by the app. Each line carries a hash of the line before it, per council, so a missing or altered line breaks the chain. Every hour the new lines and the latest hash are copied to storage that is locked against deletion. A line holds ids, times, versions and a keyed fingerprint of the text, never the text.',
      why: 'A case note is evidence. Months later someone will ask who wrote this sentence, the AI or the worker, which prompt and model produced the draft, who approved it and what left the system. The note itself will be gone by then. The audit log must outlive the data it describes without becoming a second copy of it. This design assumes audit log retention is set by the customer, as G-Cloud listings for this kind of service commonly state.',
      built: [
        { name: 'Append-only table', what: 'A table in a separate schema owned by a different database role. The app\'s role may call one function that adds a line and may read its own tenant\'s lines. A trigger refuses UPDATE, DELETE and TRUNCATE for everyone.', why: '"Nobody changed the log" should not depend on nobody trying. Run on PostgreSQL 16: the app role was refused, and so was the schema\'s owner.' },
        { name: 'Hash chain', what: 'Each line stores the hash of the previous line and its own hash, which covers its content and that previous hash.', why: 'Tampering in the middle changes every hash after it. The hourly copy of the latest hash to locked storage means even someone with full database rights cannot rewrite history unnoticed.' },
        { name: 'Keyed fingerprint (HMAC)', what: 'A hash of the approved text mixed with the council\'s key. The same text and key always give the same fingerprint; without the key it cannot be guessed from the text.', why: 'It lets the council prove later that the text in its case system is the text that was approved, after our copy is deleted. A plain hash of a short sentence could be guessed; a keyed one cannot.' },
      ],
      numbers: [
        { text: 'About 240,000 lines a day; about 25 GB a year.', from: 'About 12 lines per note x 20,000 notes = 240,000. At about 400 bytes a line, 96 MB a day; x 260 working days = 25 GB.' },
        { text: 'Kept 6 years by default (assumption).', from: '2,190 days in the schema. The customer sets it (an assumption). Six years is this design\'s placeholder, not a legal finding.' },
      ],
      fails: 'The chain is broken by a bug in the writer: an hourly verification job recomputes the chain and pages if any line fails. The audit write fails: the action fails with it, because they share a transaction; nothing happens unrecorded. Audit lines themselves are personal data about staff (who opened what, when): they are tenant-scoped, readable by the council\'s administrators, and pruned at the council\'s audit retention by a function that records what it removed.',
      alternatives: [
        alt('Append-only table in the same transaction, sealed hourly', 'The audit line commits with the action. A job copies new lines and the chain\'s latest hash to locked storage every hour.', ['No action without its line, and no line without its action.', 'Tamper-evident.', 'Queryable with SQL by note, user or release.'], ['Shares the database\'s fate until the hourly copy.', 'A per-council lock on the chain head for each line (short, and the rate is a few a second).'], true),
        alt('Application logs shipped to a log service', 'Write audit events to the normal log stream and search them in a log tool.', ['No extra tables.'], ['Logs are sampled, dropped under load and expire.', 'Not transactional with the action.', 'Hard to prove nothing was removed.']),
        alt('Events to a stream, then a separate audit store', 'Publish each event to a message log; a consumer writes them to an audit database.', ['The audit store is fully separate.', 'Scales far.'], ['Needs an outbox to keep the no-action-without-a-line rule.', 'More moving parts in three countries.', 'The natural next step if volume grows.']),
      ],
      say: 'The audit line commits in the same transaction as the action, the table is append-only and hash-chained per council, and it stores versions and fingerprints, not text. So it can outlive the note and still answer who generated, reviewed, changed and exported what, with which model and prompt.',
      see: [{ id: 'append-log', label: 'Append-only log' }, { id: 'outbox', label: 'Transactional outbox' }],
      tables: [
        { title: 'The log and its chain heads', lang: 'sql', code: `CREATE SCHEMA audit AUTHORIZATION audit_owner;
CREATE TABLE audit.heads (
  tenant_id uuid PRIMARY KEY,
  last_seq  bigint NOT NULL,
  last_hash bytea  NOT NULL
);
CREATE TABLE audit.events (
  tenant_id  uuid   NOT NULL,
  seq        bigint NOT NULL,
  at         timestamptz NOT NULL,
  actor_kind text   NOT NULL CHECK (actor_kind IN ('user',
             'system','support')),
  actor_id   text   NOT NULL,
  action     text   NOT NULL,
  note_id    uuid,
  release_id int,
  content_hmac bytea,           -- keyed with the tenant's key
  detail     jsonb  NOT NULL DEFAULT '{}',
  prev_hash  bytea  NOT NULL,
  hash       bytea  NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX events_note ON audit.events (tenant_id, note_id);
CREATE INDEX events_release
  ON audit.events (tenant_id, release_id);`, note: 'No text column. The detail field holds counts and settings, such as {"edit_distance": 0.34}.' },
        { title: 'Append is the only way in', lang: 'sql', code: `CREATE FUNCTION audit.append(p_actor_kind text, p_actor text,
  p_action text, p_note uuid, p_release int, p_hmac bytea,
  p_detail jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = audit, pg_temp AS $$
DECLARE
  v_tenant uuid := current_setting('app.tenant_id')::uuid;
  v_at timestamptz := clock_timestamp();
  v_seq bigint; v_prev bytea; v_hash bytea;
BEGIN
  INSERT INTO heads VALUES (v_tenant, 0, '\\x00')
    ON CONFLICT (tenant_id) DO NOTHING;
  SELECT last_seq + 1, last_hash INTO v_seq, v_prev
    FROM heads WHERE tenant_id = v_tenant FOR UPDATE;
  v_hash := sha256(v_prev || convert_to(concat_ws('|', v_tenant,
    v_seq, v_at, p_actor_kind, p_actor, p_action, p_note,
    p_release, encode(p_hmac, 'hex'), p_detail), 'UTF8'));
  INSERT INTO events VALUES (v_tenant, v_seq, v_at, p_actor_kind,
    p_actor, p_action, p_note, p_release, p_hmac, p_detail,
    v_prev, v_hash);
  UPDATE heads SET last_seq = v_seq, last_hash = v_hash
    WHERE tenant_id = v_tenant;
  RETURN v_seq;
END $$;`, note: 'The tenant comes from the session, not from an argument, so a caller cannot write into another council\'s chain. Simplified: a production version would hash a fixed-format timestamp, since this text form depends on the session\'s time zone.' },
        { title: 'Nobody may change a line', lang: 'sql', code: `CREATE FUNCTION audit.no_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit.events is append-only'; END $$;
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE OR TRUNCATE
  ON audit.events FOR EACH STATEMENT
  EXECUTE FUNCTION audit.no_change();

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_reads ON audit.events FOR SELECT TO app_rw
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
GRANT USAGE ON SCHEMA audit TO app_rw;
GRANT SELECT ON audit.events TO app_rw;
GRANT EXECUTE ON FUNCTION audit.append TO app_rw;`, note: 'The app role has no INSERT, UPDATE or DELETE on the table. A superuser could still drop the trigger, which is what the hourly copy of the chain\'s latest hash to locked storage is for.' },
      ],
      queries: [
        { title: 'Everything that happened to one note', lang: 'sql', code: `SELECT seq, at, actor_id, action, release_id, detail
FROM audit.events
WHERE tenant_id = $1 AND note_id = $2 ORDER BY seq;
-- 1 | priya  | draft.generated | 42 | {"sentences": 38}
-- 2 | priya  | note.approved   | 42 | {"edit_distance": 0.34,
--                                      "review_seconds": 660}
-- 3 | priya  | note.exported   | 42 | {"how": "copy",
--                                      "sections": 6}`, note: 'Still answerable after the note, its audio and its transcript are deleted.' },
        { title: 'Which notes did release 42 write here?', lang: 'sql', code: `SELECT note_id,
       bool_or(action = 'note.approved') AS approved,
       bool_or(action = 'note.exported') AS exported
FROM audit.events
WHERE tenant_id = $1 AND release_id = 42
GROUP BY note_id;`, note: 'The list a council\'s practice lead gets after a rollback: which notes to look at again, and which have already left for the case system.' },
        { title: 'Verify the chain', lang: 'sql', code: `SELECT seq FROM (
  SELECT seq, prev_hash, hash,
         lag(hash) OVER (ORDER BY seq) AS want,
         sha256(prev_hash || convert_to(concat_ws('|', tenant_id,
           seq, at, actor_kind, actor_id, action, note_id,
           release_id, encode(content_hmac, 'hex'), detail),
           'UTF8')) AS recomputed
  FROM audit.events WHERE tenant_id = $1) t
WHERE hash <> recomputed
   OR (want IS NOT NULL AND prev_hash <> want);
-- 0 rows: the chain is intact`, note: 'Any row returned is a line that was altered or a gap where one was removed.' },
        { title: 'A deletion receipt', lang: 'sql', code: `SELECT audit.append('system', 'retention-worker', 'note.deleted',
  $1, NULL, NULL,
  '{"db_rows": 291, "audio_objects": 1,
    "note_key": "destroyed",
    "vendor_calls": ["req_9c41", "req_b770", "req_b771"],
    "vendor_retention_days": 0,
    "backups_clear_by": "2026-12-31"}');`, note: 'The receipt says what was removed from where, which vendor requests had carried the data and on what terms, and the date the last backup holding it expires.' },
      ],
    },
    {
      id: 'deleter',
      name: 'Retention worker',
      tech: 'day 106, receipts',
      x: 1070, y: 385, w: 160, h: 76, kind: 'node',
      what: 'A scheduled job in each region. Every 10 minutes, for each council, it finds notes past their delete_after date that are not on legal hold. For each it deletes the audio object, deletes the note row (which removes transcript, draft and flags with it, and the note\'s wrapped data key), and writes a deletion receipt to the audit log. It also handles three special cases: consent withdrawn (delete now), a council leaving (delete everything, then destroy the council\'s key), and a monthly check of what each vendor still holds against the record of what was sent.',
      why: 'One council\'s published record says its supplier keeps data up to 120 days and then deletes it. A promise like that fails quietly: nobody notices data that should have gone. So deletion is a first-class job with its own receipts, its own alarms and its own reconciliation, not a clean-up script. The 120 days must cover every copy: database, storage, backups and sub-processors.',
      built: [
        { name: 'Delete date on the note', what: 'delete_after is set when the note is created and moved when it is approved: approval plus the council\'s retention_days, never later than creation plus 106 days.', why: 'Each note carries its own deadline. The worker needs no rules, only a date and a hold check.' },
        { name: 'Backups and the 106-day ceiling', what: 'Database backups are kept 14 days. A note deleted on day 106 is in no backup after day 120.', why: '"Deleted" must include backups. Shortening live retention by the backup window is simpler than editing backups.' },
        { name: 'Deletion receipt', what: 'An audit line that lists what was removed from which store, the vendor requests that had carried the data and their terms, and the date backups will be clear.', why: 'A council\'s data protection officer can be shown, per note, that deletion happened. It is also what gets replayed after a restore from backup.' },
        { name: 'Legal hold', what: 'A row naming a note, a reason, the person who placed it and a review date. The worker skips held notes.', why: 'A complaint, a court order or a subject access request in progress can need the recording kept. That is the council\'s decision as controller, and it must be visible and time-boxed.' },
      ],
      numbers: [
        { text: 'About 20,000 deletions a working day in steady state.', from: 'What comes in goes out, a retention period later.' },
        { text: 'Alarm if any note is more than 24 hours past its date.', from: 'This design\'s choice. The worker runs every 10 minutes, so a note a day late means something is broken.' },
        { text: 'Nothing older than 120 days anywhere.', from: '106 days live + 14 days of backups = 120. Storage has its own 120-day lifecycle rule as a backstop.' },
      ],
      fails: 'The worker stops: the "oldest overdue note" alarm fires within a day, and the storage lifecycle rule still removes audio at 120 days. It deletes something on hold: the hold check is in the same query as the selection, and deleting a held note is a test case. A restore brings deleted notes back: deletion receipts newer than the backup are replayed before the database serves traffic. A vendor still has a copy: this worker cannot delete it; see tour step 13.',
      alternatives: [
        alt('Scheduled deletion with receipts and a hold check', 'A date on every note, a worker that deletes when it passes, an audit receipt for each, a hold table the worker respects.', ['Each deletion is provable.', 'Per-council retention is one column.', 'Late deletion is measurable and alarmed.'], ['Deleting 5 million rows a day needs steady, batched deletes.', 'Holds can become a way to keep things for ever unless reviewed.'], true),
        alt('Partition by day and drop old partitions', 'Store notes in daily partitions and drop a whole partition at its age.', ['Very cheap deletion.'], ['Councils have different retention periods and notes have holds, so no day\'s partition expires as a whole.', 'No per-note receipt.']),
        alt('Crypto-shredding only', 'Never delete rows or objects; delete the note\'s key and leave the ciphertext.', ['Instant, and covers backups of the data.'], ['The wrapped key is in backups too, so the note is readable until those expire.', 'Ciphertext for ever is hard to explain as "deleted".', 'Used here as a second line, not the only one.']),
      ],
      say: 'Every note is born with a deletion date. Live retention is capped at 106 days because backups last 14, so nothing is older than 120 anywhere we control. Each deletion writes a receipt, holds are explicit and reviewed, and vendor copies are handled by contract terms that I record per call.',
    },
    {
      id: 'cms',
      name: 'Case management system',
      short: 'Case system',
      tech: 'the council\'s record',
      x: 100, y: 505, w: 170, h: 56, kind: 'outside',
      what: 'The council\'s own system of record for social care, run by the council or its supplier. The approved note ends up here, on the person\'s case file, and this is where it lives for as long as the law requires. One council\'s published record (2025) says practitioners edit the draft and paste it into their case system, and that the final record lives in the council\'s system. This design assumes no API to start with, and exports in CSV, PDF and MP3.',
      why: 'The statutory record is the council\'s, not the supplier\'s. That is what makes a 120-day deletion possible: our copy is a working draft, theirs is the record. It also sets the integration question: how the approved text gets across, and who is accountable when it lands on the wrong file.',
      built: [
        { name: 'Structured export', what: 'The approved note split by the council template\'s sections, each with a copy button, plus a file (PDF for people, CSV or JSON for systems) carrying the section names, the note id and the keyed fingerprint.', why: 'Paste per section matches the case system\'s form fields and cuts mis-pasting. The file gives a council\'s own integration team something to import without us holding credentials to their system.' },
        { name: 'Write-back connector (option, not at rest)', what: 'A per-council integration that sends the approved note to the case system\'s API as an unsigned draft entry on a case the practitioner has picked.', why: 'It removes the copy step. It is off by default because of what it risks: see the alternatives.' },
      ],
      numbers: [
        { text: 'About 20,000 exports a working day.', from: 'One per approved note.' },
        { text: 'About 6 paste actions per note today.', from: 'A template with about 6 sections, pasted one by one into the case system\'s form (assumption).' },
      ],
      fails: 'The practitioner pastes into the wrong person\'s file: we cannot see it; the export shows the person\'s initials and visit time at the top of every section to make a mismatch obvious. The practitioner edits the text after pasting: the case system\'s copy is then the record, and our fingerprint will not match, which is correct. With write-back on: the case system is down (queue and retry with an idempotency key of note id and version), or the connector writes to the wrong case (the reason it writes a draft the practitioner must confirm inside the case system).',
      alternatives: [
        alt('Copy by section and a structured export file', 'After approval the practitioner copies each section into the case system, or downloads a file that the council imports.', ['Works with every case system today.', 'The practitioner places the text on the right file with their own eyes.', 'We hold no credentials to a statutory system.'], ['Manual steps: about 6 pastes a note.', 'We cannot confirm it reached the right record.', 'The saved time is partly spent copying.'], true),
        alt('The council pulls from our API', 'We publish an API; the council\'s integration layer fetches approved notes and files them.', ['No credentials to their system held by us.', 'The council controls matching to cases.'], ['Few councils have integration teams with time for this.', 'An API over care notes is a new attack surface to secure.']),
        alt('We write back into the case system', 'A connector per case system pushes the approved note through that system\'s API.', ['No copying.', 'The export is confirmed, with the case system\'s own id.'], ['Wrong-file risk moves from a person to our matching code, at scale.', 'We would hold credentials to each council\'s statutory system.', 'One connector per case system and version, each needing that supplier\'s cooperation.', 'A draft could land in the record without a last human look unless it is written as unsigned.']),
      ],
      say: 'Today the last step is copy and paste, and the listing offers no API. I would ship structured export first, then a pull API, and treat write-back as an opt-in that writes an unsigned draft to a case the practitioner chose, because a note on the wrong person\'s file is the worst outcome in this whole system.',
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }, { id: 'serialization', label: 'Serialisation' }],
    },
  ],

  flows: [
    {
      id: 'lookup', from: 'user', to: 'edge', d: 'M158,213 H200 V90 H230', label: 'which region?', at: 'left',
      mode: 'call', via: 'HTTPS', chip: 0.49,
      travels: 'The council\'s sign-in domain or slug, and back comes the address of the region that serves it. No user name, no token.',
      how: 'The browser sends the domain part of the work email, northbridge.gov.uk. The router replies with the UK app\'s address and the browser remembers it.',
      delivery: 'A read of public-grade data. Safe to repeat and safe to cache. A wrong answer is caught by the regional app (step 2).',
      alts: others(lookupWays),
      ways: lookupWays,
      examples: [
        { title: 'Request', lang: 'http', code: `GET /v1/region?domain=northbridge.gov.uk HTTP/1.1
Host: app.notes.example` },
        { title: 'Response', lang: 'json', code: `{ "tenant": "northbridge", "region": "uk",
  "app": "https://uk.notes.example",
  "sign_in": "https://uk.notes.example/sso/northbridge" }`, note: 'Only the domain is sent. The full email address goes to the regional sign-in, not to the global router.' },
      ],
    },
    {
      id: 'signin', from: 'user', to: 'idp', d: 'M60,205 V118', label: 'sign in', at: 'left',
      mode: 'external', via: 'OIDC', chip: 0.5,
      travels: 'The practitioner\'s sign-in at the council\'s own identity provider, and a signed statement of who they are coming back through the browser.',
      how: 'The regional app redirects the browser to Northbridge\'s identity provider. Priya signs in with the council\'s MFA. The provider returns a signed assertion; the broker in the UK region turns it into a session token with claims sub, tenant = northbridge and region = uk.',
      delivery: 'Someone else\'s service. If it is down, Northbridge\'s staff cannot sign in and nobody else is affected. The assertion is single-use and short-lived.',
      alts: others(signinWays),
      ways: signinWays,
      examples: [
        { title: 'Session token claims', lang: 'json', code: `{ "sub": "u_81c2", "tenant": "northbridge", "region": "uk",
  "roles": ["practitioner"], "amr": ["mfa"],
  "iat": 1794905400, "exp": 1794934200 }`, note: 'tenant comes from the connection Priya signed in through. region is added by the UK broker. exp is 8 hours after iat.' },
      ],
    },
    {
      id: 'app', from: 'user', to: 'api', d: 'M158,235 H255', label: 'requests', at: 'above',
      mode: 'call', via: 'HTTPS', chip: 0.5,
      travels: 'Every action the practitioner takes: create a note with its consent record, ask for an upload address, poll status, open the draft, resolve flags, save edits, approve, export. Each carries the session token.',
      how: 'HTTPS with TLS to the UK app. The app checks the token\'s signature, that region is uk, and that the tenant exists in its local table, before anything else. This design assumes TLS 1.3, and accepts nothing below TLS 1.2.',
      delivery: 'Request and reply with a timeout. Create and approve carry an idempotency key so a retry after a dropped reply does not make a second note or a second approval.',
      alts: others(appWays),
      ways: appWays,
      examples: [
        { title: 'Create a note', lang: 'http', code: `POST /v1/notes HTTP/1.1
Host: uk.notes.example
Authorization: Bearer <session token>
Idempotency-Key: 5d0e6c1a-visit-1000
Content-Type: application/json

{ "template": "care-act-assessment",
  "consent": { "kind": "verbal", "at": "2026-11-17T10:01:00Z" },
  "audio": { "format": "mp3", "bytes": 15360000 } }`, note: 'No consent, no note: the field is required and stored on the note row.' },
        { title: 'Response', lang: 'json', code: `{ "note_id": "7f3a...", "status": "uploading",
  "upload": { "parts": 3, "expires_in": 600,
    "urls": ["https://audio.uk.notes.example/..."] },
  "delete_after": "2027-03-03T10:41:00Z" }`, note: 'The note has a deletion date before it has any audio: 106 days after creation, pulled in to approval plus 30 days when Priya approves.' },
      ],
    },
    {
      id: 'wrong', from: 'user', to: 'other', d: 'M22,235 H8 V10 H1260 V50', label: 'wrong region', at: 'right',
      mode: 'call', via: 'HTTPS', chip: 0.98, chipY: 30, cold: true,
      travels: 'A request for a UK council that arrives at the US stack by mistake.',
      how: 'The US app checks the token. region is uk, not us, and northbridge is not in the US tenants table. It replies 421 Misdirected Request with no body beyond the code, stores nothing, and writes a refusal line to its own operational log with the tenant slug and no content.',
      delivery: 'Refused before any body is read. Two independent checks (token region, local tenant table) and a third in the schema: the US database cannot hold a row for a UK tenant.',
      alts: others(wrongWays),
      ways: wrongWays,
      examples: [
        { title: 'Response', lang: 'http', code: `HTTP/1.1 421 Misdirected Request
Content-Type: application/json

{ "error": "wrong_region" }`, note: 'The reply does not say which region is right. The browser goes back to the global router to find out.' },
      ],
    },
    {
      id: 'upload', from: 'user', to: 'blobs', d: 'M158,255 H205 V632 H780 V411', label: 'audio', at: 'right',
      mode: 'write', via: 'signed URL', chip: 0.9, chipY: 520,
      travels: 'The recording itself, in parts, from the browser straight to the audio store in the UK.',
      how: 'The app gives the browser one signed address per part, valid for 10 minutes, each naming the path northbridge/7f3a. The browser sends the parts and then tells the app it has finished. The object is encrypted with note 7f3a\'s data key.',
      delivery: 'Each part can be re-sent; the store keeps the last copy of a part. The upload counts only when the app has confirmed the final size and checksum. Parts of unconfirmed uploads are removed after 24 hours.',
      alts: others(uploadWays),
      ways: uploadWays,
    },
    {
      id: 'sql', from: 'api', to: 'db', d: 'M335,273 V350', label: 'rows, tenant set', at: 'left',
      mode: 'write', via: 'SQL', chip: 0.5,
      travels: 'Note rows, review decisions, edits and approvals, each in a transaction that first sets the tenant, and each with its audit line.',
      how: 'BEGIN; SET LOCAL app.tenant_id; the statements; a call to audit.append; COMMIT. The app connects as app_rw, which cannot bypass row-level security.',
      delivery: 'All or nothing. An approval and its audit line commit together or not at all.',
      alts: others(sqlWays),
      ways: sqlWays,
      examples: [
        { title: 'Statement', lang: 'sql', code: `BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO notes (tenant_id, note_id, author_id, template_id,
  status, consent, consent_at, wrapped_key, delete_after)
VALUES ($1, $2, $3, 'care-act-assessment', 'uploading',
  'verbal', $4, $5, now() + interval '106 days');
SELECT audit.append('user', 'u_81c2', 'note.created', $2,
  NULL, NULL, '{"consent": "verbal"}');
COMMIT;`, note: 'SET LOCAL lasts for this transaction only, so the next request on the same pooled connection starts with no tenant.' },
      ],
    },
    {
      id: 'keys', from: 'api', to: 'kms', d: 'M400,273 V292 H485', label: 'unwrap note key', at: 'below',
      mode: 'call', via: 'KMS', chip: 0.5,
      travels: 'A note\'s wrapped data key going in, the usable data key coming back, held in memory for the length of the request.',
      how: 'When a note is created the app asks the key service for a new data key under Northbridge\'s key and stores the wrapped copy on the note row. To show a draft it asks the service to unwrap it. The service checks the caller\'s identity and logs the call.',
      delivery: 'A network call with a short timeout. Safe to repeat. If it fails, the note cannot be read; the app says so.',
      alts: others(keysWays),
      ways: keysWays,
    },
    {
      id: 'jobs', from: 'api', to: 'pipeline', d: 'M415,228 H710', label: 'jobs', at: 'above',
      mode: 'async', via: 'job queue', chip: 0.5,
      travels: '"Transcribe note 7f3a", then "draft", then "check": one small row per stage, holding ids only.',
      how: 'The app inserts a row into the jobs table in the same transaction that marks the upload confirmed. Workers claim rows with FOR UPDATE SKIP LOCKED, skipping any council that already has 8 running.',
      delivery: 'At least once. A worker that dies leaves a locked row whose lock times out; another worker repeats the stage. Each job has a unique idempotency key (transcribe:7f3a) and each stage checks for an existing result first.',
      alts: others(jobsWays),
      ways: jobsWays,
      examples: [
        { title: 'Statement', lang: 'sql', code: `INSERT INTO jobs (tenant_id, note_id, kind, idempotency_key)
VALUES ($1, $2, 'transcribe', 'transcribe:7f3a')
ON CONFLICT (idempotency_key) DO NOTHING;
-- INSERT 0 1 the first time, INSERT 0 0 on a retry`, note: 'A browser that confirms the same upload twice queues one job.' },
      ],
    },
    {
      id: 'audio', from: 'pipeline', to: 'blobs', d: 'M800,273 V345', label: 'read audio', at: 'right',
      mode: 'call', via: 'GET', chip: 0.5,
      travels: 'The encrypted recording, read once by the worker that will send it for transcription.',
      how: 'The worker fetches northbridge/7f3a from the audio store and decrypts it in memory with the note\'s data key.',
      delivery: 'A read. Safe to repeat. The decrypted audio is never written to the worker\'s disk.',
      alts: others(audioWays),
      ways: audioWays,
    },
    {
      id: 'pkeys', from: 'pipeline', to: 'kms', d: 'M720,273 V292 H635', label: 'unwrap note key', at: 'below',
      mode: 'call', via: 'KMS', chip: 0.5,
      travels: 'The same unwrap as the app\'s, from a worker.',
      how: 'Before each stage the worker unwraps the note\'s data key to read the audio or the transcript. The worker\'s identity is separate from the app\'s, so the key service\'s log shows which of them read which note.',
      delivery: 'Safe to repeat. A failure fails the stage, which retries.',
      alts: others(pkeysWays),
      ways: pkeysWays,
    },
    {
      id: 'vendor', from: 'pipeline', to: 'vendors', d: 'M860,273 V310 H1221', label: 'audio, then transcript', at: 'below',
      mode: 'external', via: 'HTTPS', chip: 0.62,
      travels: 'For speech to text: the audio, and back come segments with speaker, start and end time and a confidence for each. For drafting: the transcript, the council\'s template and the release\'s prompt, and back come sentences with their cited segment numbers. For the check: sentences with their cited segments, and back come verdicts.',
      how: 'HTTPS to the vendor\'s in-country endpoint with a dated model name and the zero-retention setting. Before each call the worker writes a vendor_calls row with the vendor, purpose, endpoint region, retention terms and size; after it, the vendor\'s request id.',
      delivery: 'No guarantee: someone else\'s server. A timeout per call (speech to text 5 minutes, LLM 2 minutes; this design\'s choices), 3 retries with backoff, a circuit breaker per vendor, then the fallback engine. A retry after a timeout may mean the vendor processed the audio twice; under zero-retention terms neither copy is kept.',
      alts: others(vendorWays),
      ways: vendorWays,
      examples: [
        { title: 'Drafting request (shape)', lang: 'json', code: `{ "model": "<dated snapshot from release 42>",
  "store": false,
  "input": {
    "template": "care-act-assessment (Northbridge v7)",
    "segments": [
      { "n": 141, "speaker": "person",
        "text": "No, he's never hit me. He shouts, that's all." }
    ] },
  "output_schema": {
    "sentences": [
      { "section": "string", "text": "string",
        "cites": ["segment numbers"] } ] } }`, note: 'A sketch, not any vendor\'s real API. The points are the dated model, the no-storage setting and an output that forces citations.' },
        { title: 'Drafting response (one sentence)', lang: 'json', code: `{ "section": "Risks and safeguarding", "sent_no": 23,
  "text": "Mr A said his son sometimes hits him.",
  "cites": [141] }`, note: 'Sentence 23 cites segment 141, which says the opposite. Step 7 catches it.' },
      ],
    },
    {
      id: 'check', from: 'pipeline', to: 'checker', d: 'M876,235 H980', label: 'draft and segments', at: 'above',
      mode: 'local', via: 'in-process', chip: 0.5,
      travels: 'The draft\'s sentences with their citations and the transcript segments, and back come a verdict per sentence and a list of flags.',
      how: 'A function call inside the worker. The checker\'s own model calls go out on the vendor line and are recorded like any other.',
      delivery: 'In-process, so it cannot be lost. If the checker\'s model call fails, sentences are stored as "unchecked", which blocks approval of high-risk ones.',
      alts: others(checkWays),
      ways: checkWays,
      examples: [
        { title: 'Checker result', lang: 'json', code: `{ "sent_no": 23, "verdict": "contradicted", "high_risk": true,
  "cites": [141],
  "reason": "Segment 141 denies being hit." }`, note: 'The reason is shown to the practitioner beside the sentence, with a play button for 21:07.' },
      ],
    },
    {
      id: 'results', from: 'pipeline', to: 'db', d: 'M740,273 V365 H654', label: 'transcript, draft, flags', at: 'left',
      mode: 'write', via: 'SQL', chip: 0.76,
      travels: '212 transcript segments after speech to text; 38 draft sentences with citations after drafting; verdicts and 2 flags after the check; a vendor_calls row per call; the next stage\'s job; an audit line per stage.',
      how: 'Each stage ends with one transaction: set the tenant, write the results, queue the next job, append the audit line, mark this job done.',
      delivery: 'All or nothing per stage. A repeated stage finds its results already present and does nothing.',
      alts: others(resultsWays),
      ways: resultsWays,
    },
    {
      id: 'relay', from: 'db', to: 'audit', d: 'M560,430 V550', label: 'audit lines', at: 'right',
      mode: 'write', via: 'same transaction', chip: 0.25,
      travels: 'One line per action, added to the council\'s chain in the same transaction, then copied each hour with the chain\'s latest hash to locked storage.',
      how: 'audit.append locks the council\'s chain head, computes the new hash, inserts the line and moves the head. An hourly job writes the new lines and the head hash to an object store with deletion locked for the audit retention period.',
      delivery: 'The line exists if and only if the action committed. The hourly copy is at least once; lines are keyed by (tenant, seq), so a repeat overwrites with the same bytes.',
      alts: others(relayWays),
      ways: relayWays,
    },
    {
      id: 'paste', from: 'user', to: 'cms', d: 'M90,265 V477', label: 'approved text', at: 'right',
      mode: 'external', via: 'copy and paste', chip: 0.5,
      travels: 'The approved note, section by section, carried by the practitioner into the council\'s case system. Or a downloaded file imported by the council.',
      how: 'The export screen shows each template section with a copy button, with Mr A\'s initials and the visit time at the top. Priya pastes each into the matching field of the case record. Each copy and each download is an audit line with the text\'s keyed fingerprint.',
      delivery: 'A person, so no guarantee. We know the text was copied, not where it was pasted. The case system\'s copy is the record from this point.',
      alts: others(pasteWays),
      ways: pasteWays,
      examples: [
        { title: 'Export file (JSON)', lang: 'json', code: `{ "note_id": "7f3a...", "template": "care-act-assessment",
  "approved_by": "u_81c2",
  "approved_at": "2026-11-17T11:31:00Z",
  "ai_assisted": true, "release": 42,
  "fingerprint": "hmac-sha256:9b1c...",
  "sections": [
    { "name": "Risks and safeguarding", "text": "..." } ] }`, note: 'ai_assisted and release travel with the note, so the council\'s record can say an AI tool helped draft it.' },
      ],
    },
    {
      id: 'writeback', from: 'api', to: 'cms', d: 'M262,273 V505 H185', label: 'write-back (option)', at: 'right',
      mode: 'external', via: 'connector', chip: 0.55, cold: true,
      travels: 'The approved note sent to the case system\'s API as an unsigned draft on a case the practitioner chose.',
      how: 'Off by default and enabled per council. The practitioner picks the case inside our app from a list fetched with their own delegated access, or pastes the case reference. The connector posts with an idempotency key of note id and version. The practitioner must still open the case system and sign the entry.',
      delivery: 'At least once with an idempotency key, through an outbox, with retries while the case system is down. The export is not marked complete until the case system returns its own id.',
      alts: others(writebackWays),
      ways: writebackWays,
    },
    {
      id: 'sync', from: 'api', to: 'control', d: 'M415,206 H450 V108 H680', label: 'counts up', at: 'below',
      mode: 'call', via: 'HTTPS pull', chip: 0.56,
      reply: {
        id: 'releases', label: 'releases down', chip: 'releases',
        how: 'The reply to the same request carries the current releases and this region\'s rollout rows, signed by the control plane.',
        delivery: 'Read-only and repeatable. The region keeps the last good answer and ignores one whose signature fails.',
      },
      travels: 'Up: yesterday\'s and today\'s counts per council, template and release (notes, sentences, unsupported, contradicted, median edit distance), and evaluation results. Down: releases and rollout percentages. Nothing personal in either direction.',
      how: 'Every 30 seconds the UK app calls the control plane. The request carries any new count rows; the reply carries the configuration. The region opens the connection; the control plane has no way to open one into a region.',
      delivery: 'Counts are upserts keyed by (tenant, day, template, release), so sending them twice is harmless. If the call fails the region carries on with what it has.',
      alts: others(syncWays),
      ways: syncWays,
      examples: [
        { title: 'Counts sent up', lang: 'json', code: `{ "region": "uk", "rows": [
  { "tenant": "northbridge", "day": "2026-11-17",
    "template": "care-act-assessment", "release": 42,
    "notes": 50, "sentences": 2000, "unsupported": 82,
    "contradicted": 9, "edit_distance_p50": 0.31 } ] }`, note: '50 notes and 2,000 sentences: enough to compare with release 40\'s 6,000 the same day. No note ids.' },
        { title: 'Reply', lang: 'json', code: `{ "releases": [ { "id": 40, "status": "live" },
                { "id": 42, "status": "rolled_back" } ],
  "rollout": [ { "tenant": "northbridge", "release": 40,
                 "percent": 100, "set_by": "halt-rule" } ],
  "signature": "..." }`, note: 'After the halt rule fires, the next pull carries the rollback.' },
      ],
    },
    {
      id: 'directory', from: 'control', to: 'edge', d: 'M680,72 H370', label: 'council directory', at: 'above',
      mode: 'async', via: 'publish', chip: 0.18, cold: true,
      travels: 'The list of council slugs, sign-in domains and regions.',
      how: 'When a council is added the control plane publishes a new copy of the directory to the router. The router serves its copy.',
      delivery: 'The whole file each time, with a version number. The router keeps the last good copy if a publish fails.',
      alts: others(directoryWays),
      ways: directoryWays,
    },
    {
      id: 'purge-db', from: 'deleter', to: 'db', d: 'M990,422 H654', label: 'delete rows', at: 'below',
      mode: 'write', via: 'SQL', chip: 0.8, cold: true,
      travels: 'The due-note query, then one DELETE per note that removes the note row and, by cascade, its segments, sentences and flags, with a deletion receipt in the same transaction.',
      how: 'Per council, with that council\'s tenant set: select up to 500 due notes not on hold, delete each note\'s audio first, then the row, then append the receipt.',
      delivery: 'Repeatable. A note already gone is skipped. The receipt is written in the transaction that deletes the row, so there is no deletion without a receipt.',
      alts: others(purgeDbWays),
      ways: purgeDbWays,
    },
    {
      id: 'purge-audio', from: 'deleter', to: 'blobs', d: 'M990,370 H880', label: 'delete audio', at: 'above',
      mode: 'write', via: 'DELETE', chip: 0.5, cold: true,
      travels: 'A delete for the object northbridge/7f3a and a listing by prefix to confirm it is gone.',
      how: 'The worker deletes the object and every version of it, then lists the note\'s prefix and expects nothing.',
      delivery: 'Repeatable. Deleting a missing object succeeds. If the store is unreachable, the row is not deleted either, so the note is retried whole.',
      alts: others(purgeAudioWays),
      ways: purgeAudioWays,
    },
    {
      id: 'purge-vendor', from: 'deleter', to: 'vendors', d: 'M1150,400 H1306 V350', label: 'stored-data check', at: 'below',
      mode: 'external', via: 'HTTPS', chip: 0.46, cold: true,
      travels: 'A monthly question to each vendor\'s account API: what do you hold for our account? The answer is compared with vendor_calls.',
      how: 'Where a vendor offers a way to list stored requests, files or batch inputs, the worker lists them and expects nothing older than the agreed window. It also sends a tracer each week: a synthetic recording with a unique phrase, recorded in vendor_calls, which should be findable nowhere at the vendor afterwards. Where a vendor offers no such listing, the only detectors are the contract\'s audit right, the vendor\'s own assurance reports and its incident notices.',
      delivery: 'Best effort. This is a check, not a guarantee: it can prove a vendor kept something, not that it kept nothing.',
      alts: others(purgeVendorWays),
      ways: purgeVendorWays,
    },
  ],

  keyNotes: [
    { mode: 'external', text: '"OIDC" is the council\'s sign-in. "copy and paste" is a person carrying text between two systems.' },
    { mode: 'write', text: '"same transaction" means the audit line commits with the action it records. "signed URL" is a short-lived address that allows one upload.' },
    { mode: 'async', text: '"job queue" is a table in the regional database; workers claim rows from it.' },
    { mode: 'call', text: '"KMS" is the regional key management service. "HTTPS pull" is the region asking the control plane; the control plane never calls a region.' },
  ],

  tour: [
    step({
      title: 'Sign-in finds the right country',
      text: 'Priya, a social worker at Northbridge Council, opens the app before a home visit. The Global router is sent only her email\'s domain, northbridge.gov.uk, and answers "UK". She signs in at the council\'s own identity provider and reaches the UK app with a token that names her, her council and the region.',
      focus: ['user', 'edge', 'idp', 'api'],
      path: ['lookup', 'signin', 'app'],
      labels: ['northbridge.gov.uk?', 'Priya signs in, with MFA', 'token: northbridge, uk'],
      context: 'Priya, a social worker at Northbridge Council, opens the app before a home visit.',
      problem: 'Three countries, one web address. Each customer\'s data must stay in its country, so the very first request has to land in the right one, and the thing that decides must not itself collect personal data.',
      left: 'A global login service would hold every practitioner\'s email and session in one country, and the residency promise would be false before any note existed.',
      options: 'Route by the user\'s location: wrong, because a UK worker abroad would be sent abroad. A separate address per country: nothing global, but users arrive at the wrong one. A global lookup that maps a council\'s domain to a region and holds nothing else.',
      why: 'The lookup needs only public-grade facts: a council\'s name and where it is hosted. Sign-in itself happens in the region, through the council\'s identity provider, so the council controls leavers and MFA. The tenant in the token comes from the sign-in connection, never from anything typed.',
      wrong: 'The directory can be wrong or stale, and the router is a global dependency for new sign-ins. So the region does not trust it: step 2.',
      q: 'What is in the token?',
      a: 'Who she is, her council (tenant) and the region, with an 8-hour life. The regional app checks all three on every request.',
    }),
    step({
      title: 'A request reaches the wrong region',
      text: 'A bad build of the web app sends Priya\'s first request to the US stack. The US app checks her token: the region is uk, and Northbridge is not in its tenant table. It answers 421, reads no body and stores nothing. Her browser asks the Global router again and goes to the UK.',
      focus: ['user', 'other', 'edge'],
      path: ['wrong', 'lookup'],
      labels: ['request for a UK council', 'ask again: UK'],
      failed: ['wrong'],
      recovery: true,
      hide: ['writeback', 'directory', 'purge-db', 'purge-audio', 'purge-vendor'],
      context: 'A bad build of the web app sends Priya\'s first request to the US stack.',
      problem: 'Routing is software and will be wrong one day: a bad build, a stale cache, a mistyped setting. If a region accepts whatever reaches it, one routing bug moves UK care data to the US.',
      left: 'A recording of a vulnerable adult in the UK would be stored, and perhaps sent to a US vendor endpoint, before anyone noticed. That is a reportable breach caused by a typo.',
      options: 'Trust the router. Forward a misdirected request to the right region, which hides the bug and passes the data through the wrong country. Redirect, which may come after an upload body has been sent. Refuse.',
      why: 'Refusing turns a leak into an error. There are three independent checks: the token\'s region claim, the region\'s own tenant table, and a CHECK in the schema so the US database cannot hold a UK tenant\'s row. The refusal is logged and alerts, because it means routing is broken.',
      wrong: 'The request headers did reach a US server, including the token. The token is useless there and expires in 8 hours. If the build is bad for everyone, UK users are locked out until it is rolled back: an outage, chosen over a breach.',
      q: 'Why 421?',
      a: 'It is the HTTP status for a request sent to a server that is not able to answer for it. The reply says nothing else, so it leaks nothing about which councils exist where.',
    }),
    step({
      title: 'Consent, then upload',
      text: 'At 10:00 Priya asks Mr A if she may record, and he agrees. She ticks consent, and the UK app creates note 7f3a with that consent, a deletion date and its own encryption key. After the 32-minute visit her browser uploads the 15 MB recording straight to the Audio store in the UK.',
      focus: ['user', 'api', 'db', 'kms', 'blobs'],
      path: ['app', 'sql', 'keys', 'upload'],
      labels: ['new note, consent: verbal', 'note 7f3a, delete by 3 March', 'new data key, wrapped', '15 MB in 3 parts'],
      context: 'At 10:00 Priya asks Mr A if she may record, and he agrees.',
      problem: 'The recording is the most sensitive thing in the system and it arrives over a patchy connection from a laptop. It needs a lawful basis the council is happy with, an owner, a deadline and encryption from the first byte.',
      left: 'Audio with no consent record cannot be defended. Audio with no deletion date is the copy that gets forgotten. A 15 MB upload through the app server fails at 90% and starts again.',
      options: 'Upload through the app or directly to storage. One encryption key for the region, one per council, or one per note. Consent as a tick on the note, or as a spoken statement on the recording, or both.',
      why: 'The note row is created first, so every later object has a parent with a tenant, a consent record and a delete_after. One council\'s published record describes verbal consent first, and deleting the recording and using paper notes if someone objects. Direct upload in parts survives a dropped connection. A data key per note, wrapped by the council\'s key, means this one recording can be made unreadable on its own.',
      wrong: 'Mr A may not have understood what he agreed to; that is practice, not software, and the design can only make withdrawal easy. If he changes his mind, one button deletes the recording at once (step 12). The device may sleep mid-recording.',
      q: 'Why does the note get a deletion date before it has any audio?',
      a: 'So nothing can exist without one. It starts at 106 days from creation, the ceiling, and is pulled in to 30 days after approval when Priya approves.',
    }),
    step({
      title: 'The job waits its turn',
      text: 'The UK app confirms the upload and, in the same database transaction, queues a job: transcribe note 7f3a. Another council is uploading a backlog of 300 recordings. The queue lets each council run 8 jobs at once, so Priya\'s job is picked up next, not 301st.',
      focus: ['api', 'db', 'pipeline'],
      path: ['sql', 'jobs'],
      labels: ['upload confirmed + job, one transaction', 'transcribe:7f3a'],
      context: 'The UK app confirms the upload and, in the same database transaction, queues a job: transcribe note 7f3a.',
      problem: 'Processing takes minutes and depends on outside vendors, so it cannot run inside a web request. And councils share the workers: one large council clearing a backlog can fill the queue.',
      left: 'With a plain first-in, first-out queue, 300 recordings from one council at 4 minutes each on 70 workers hold everyone else up for about 17 minutes. Small teams learn the tool is slow on Mondays and stop using it.',
      options: 'A broker with a queue per council: isolation, but 400 queues. One shared queue: simple and unfair. A jobs table in the regional database with a per-council cap in the claim query.',
      why: 'The table is in the same transaction as the note, so there is never a confirmed upload without a job. Fairness is one WHERE clause: skip councils with 8 running, prefer the council with fewest. The job\'s idempotency key, transcribe:7f3a, means a double-clicked "finish upload" queues one job.',
      wrong: 'The cap is soft: two workers can both see 7 running. A table queue needs care at much higher volume. A council with a real emergency backlog is slowed by its own cap; the cap is a per-council setting.',
      q: 'What is a noisy neighbour?',
      a: 'One customer on shared infrastructure whose load slows the others. Here, a 1,000-person council\'s backlog delaying a 20-person team.',
    }),
    step({
      title: 'Speech to text, inside the country',
      text: 'A pipeline worker reads the recording, unwraps note 7f3a\'s key and sends the audio to the speech-to-text vendor\'s UK endpoint, on terms that forbid keeping it. Before the call it records what is being sent and to whom. Back come 212 segments, each with a speaker, a time and a confidence.',
      focus: ['pipeline', 'blobs', 'kms', 'vendors', 'db'],
      path: ['audio', 'pkeys', 'vendor', 'results'],
      labels: ['encrypted audio', 'unwrap key', '15 MB to the UK endpoint, retention 0', '212 segments + vendor_calls row'],
      context: 'A pipeline worker reads the recording, unwraps note 7f3a\'s key and sends the audio to the speech-to-text vendor\'s UK endpoint, on terms that forbid keeping it.',
      problem: 'This is the moment the data leaves our walls. The vendor is a sub-processor: the residency promise and the 120-day promise both have to hold inside a company we do not run.',
      left: 'A default API endpoint may process the audio in another country, and a default account may keep requests for weeks. Nobody would know which notes were affected.',
      options: 'Self-host a speech model in each region: no sub-processor, but GPUs in three countries. Use a vendor\'s default endpoint. Use a vendor\'s in-country endpoint on zero-retention terms, and record every call.',
      why: 'Vendor quality with the least to run. The controls are an in-country endpoint, written retention terms, a pinned model, and a vendor_calls row per call with the request id and terms. The schema refuses a row whose endpoint is outside the UK. One council\'s published record names Deepgram with Whisper as fallback and says vendors do not train on the data (2025); the fallback must meet the same terms.',
      wrong: 'Zero retention is a promise we cannot inspect: step 13. Accuracy is worse for strong accents (one council\'s published record says so) and for several speakers at once, so each segment keeps its confidence and low ones are shown to the reviewer.',
      q: 'What is a sub-processor?',
      a: 'The council is the controller, the supplier is its processor, and a company the supplier passes data to is a sub-processor. Councils are told who they are; one council\'s published record lists them.',
    }),
    step({
      title: 'The draft is written by release 42',
      text: 'The worker works out which release writes this note. Northbridge is a canary council: 25% of its notes use the new release 42, and note 7f3a falls in that quarter. The LLM gets the transcript, Northbridge\'s template and release 42\'s prompt, and must return every sentence with the segment numbers it rests on: 38 sentences.',
      focus: ['pipeline', 'vendors', 'db', 'control'],
      path: ['vendor', 'results'],
      labels: ['transcript + template, release 42', '38 sentences with citations, release 42'],
      context: 'The worker works out which release writes this note.',
      problem: 'The draft will inform a statutory record. A year from now someone must be able to say exactly which prompt and which model wrote it, and a new prompt must be tried on a few notes before it writes all of them.',
      left: 'With a prompt edited in place and a model alias that the vendor moves, "which version wrote this?" has no answer, and a bad change reaches every council at once.',
      options: 'Prompts in code, shipped with each deploy. Prompts in a table, edited live. Immutable numbered releases (prompt hash, dated model, checker version) assigned to councils by percentage.',
      why: 'A release never changes, so the release number on the note is a complete answer. Assignment by a hash of the note id means a retry gets the same release. Asking for citations in the output costs tokens but makes every sentence checkable. The council\'s own template stays in its region; only the base prompt is global.',
      wrong: 'The model can cite a segment that does not say what the sentence says. It does here: sentence 23. A pinned snapshot is eventually retired by the vendor, which forces a new release on the vendor\'s timetable.',
      q: 'What is a canary council?',
      a: 'A council that has agreed to receive new releases first, on a share of its notes, so problems show up on 50 notes and not 20,000.',
    }),
    step({
      title: 'A safeguarding detail nobody said',
      text: 'Sentence 23 of the draft reads "Mr A said his son sometimes hits him." It cites segment 141, where Mr A says "No, he\'s never hit me. He shouts, that\'s all." The Grounding check marks it contradicted and high risk. It also finds something the draft left out: segment 163, "I haven\'t taken the water tablets since the fall."',
      focus: ['pipeline', 'checker', 'db'],
      path: ['check', 'results'],
      labels: ['38 sentences, 212 segments', '37 supported, 1 contradicted, 1 omission'],
      failed: ['check'],
      context: 'Sentence 23 of the draft reads "Mr A said his son sometimes hits him."',
      problem: 'The model has turned a denial into an allegation, in fluent, confident prose, in the section a duty team reads first. It has also dropped a medicine and a fall. A tired reviewer reading 38 good-looking sentences may not catch either.',
      left: 'An invented allegation of abuse enters a care record and may trigger a safeguarding enquiry against the son. The missed tablets and the fall, which matter, are not on file.',
      options: 'Rely on the reviewer. Remove unsupported sentences automatically. Quote the transcript only. Check every sentence against its cited segments with a second model, check risky segments for omissions, and flag.',
      why: 'Flags point the human at 2 sentences out of 38. Nothing is removed silently, because the checker can be wrong and a wrongly removed disclosure is worse. High-risk flags block approval in the database, not only on the screen. The unsupported rate becomes a number to gate releases on. This check is this design\'s proposal; it describes no real supplier\'s practice.',
      wrong: 'The checker is a model. It will pass some invented sentences and flag some true ones. Its miss rate has to be measured by people re-checking a sample each week. Too many flags and reviewers stop reading them.',
      q: 'What does "grounded" mean?',
      a: 'That a sentence can be traced to something actually said in the recording. Here, to numbered transcript segments that a second model agrees support it.',
    }),
    step({
      title: 'Priya reviews, edits and approves',
      text: 'At 11:20 Priya opens the draft. Two flags sit at the top. She plays the audio at 21:07, hears the denial, and rewrites sentence 23. She adds the missed tablets and the fall. Only when both high-risk flags are resolved will the UK app let her approve, at 11:31. It records that she changed 34% of the words.',
      focus: ['user', 'api', 'kms', 'blobs', 'db'],
      path: ['app', 'sql'],
      labels: ['resolve 2 flags, edit, approve', 'approved by Priya, edit distance 0.34'],
      context: 'At 11:20 Priya opens the draft.',
      problem: 'The human is the final control, and the weakest: people trust fluent text and are short of time. Approval has to mean she read it, and the system needs to learn from what she changed.',
      left: 'Approval becomes a click. The record says a professional wrote it, but nobody did. And the team never finds out which templates or releases produce drafts that need rewriting.',
      options: 'No friction: one Approve button. Heavy friction: retype or tick every sentence. Targeted friction: resolve each high-risk flag, with audio one click away, then approve. Measure the edits.',
      why: 'Friction only where the risk is keeps review fast: 11 minutes here against hours of typing. Edit distance (the share of words changed between draft and approved text) is a free quality signal per council, template and release. Review time is a second: a long note approved in 20 seconds was not read. The approved text is the practitioner\'s, and the audit line says so.',
      wrong: 'Automation bias: a reviewer can resolve a flag as "kept" without listening. Low edit distance can mean good drafts or lazy review. A practice lead\'s weekly sample of approved notes against audio is the check on the humans.',
      q: 'What is edit distance?',
      a: 'The number of word insertions, deletions and replacements needed to turn the draft into the approved text, divided by the length. 0 is untouched; 0.34 means about a third was changed.',
    }),
    step({
      title: 'Release 42 is rolled back for Northbridge',
      text: 'By 16:00 the UK app has sent the day\'s counts to the Control plane. On release 42, 4.1% of Northbridge\'s sentences were flagged unsupported; on release 40, 1.3%. The halt rule fires and puts Northbridge back on release 40. Within a minute the UK pipeline stops using 42 and redrafts the 31 notes not yet approved.',
      focus: ['api', 'control', 'pipeline', 'db'],
      path: ['sync', 'releases', 'jobs'],
      labels: ['82 of 2,000 against 78 of 6,000', 'northbridge: release 40 at 100%', 'redraft 31 notes'],
      context: 'By 16:00 the UK app has sent the day\'s counts to the Control plane.',
      problem: 'Release 42 passed evaluation and still made drafts worse for this one council, whose custom template it handles badly. Note 7f3a was one of 50 it wrote today. Nobody will notice from a single note.',
      left: 'Release 42 goes to every council next week. Practitioners at Northbridge spend longer fixing drafts, some invented sentences get through, and trust in the tool goes.',
      options: 'Evaluate offline only and ship to everyone. Ship to everyone and watch complaints. Stage by council and by percentage, compare the two releases inside the same council on the same day, and halt automatically.',
      why: 'Same council, same day, same template is a fair comparison: 2,000 sentences against 6,000. Only counts leave the region, so the control plane can decide without seeing a note. Rollback is two row changes that regions pull within 60 seconds. The audit log knows which 50 notes release 42 wrote: 31 are redrafted, 19 already approved are listed for the practice lead.',
      wrong: 'Some of the 19 have already been pasted into the case system; we can tell the council, not fix their record. A small council produces too few sentences in a day for the rule to fire. If the Control plane is down, each region needs a local way to pin a release.',
      q: 'Why did evaluation not catch it?',
      a: 'The test set for Northbridge\'s custom template had 10 cases and none with an empty risks section and a denial. The second story follows this from the release\'s side, and ends with that case added.',
    }),
    step({
      title: 'Every action has left a line',
      text: 'Each thing that happened to note 7f3a was written to the Audit log in the same database transaction as the action: created with consent, transcribed, drafted by release 42, two flags raised, opened, flags resolved, approved by Priya. The lines are chained by hash and cannot be changed. They hold versions and fingerprints, not the text.',
      focus: ['api', 'pipeline', 'db', 'audit'],
      path: ['sql', 'relay'],
      labels: ['action + audit line, one commit', 'line 9 of chain northbridge'],
      context: 'Each thing that happened to note 7f3a was written to the Audit log in the same database transaction as the action: created with consent, transcribed, drafted by release 42, two flags raised, opened, flags resolved, approved by Priya.',
      problem: 'A care record is evidence. Someone will ask who wrote a sentence, the AI or the worker, and what the AI was. The note will be deleted within months; the answer must survive without keeping the content.',
      left: 'With ordinary logs, lines are dropped under load, expire after weeks and can be edited by anyone with access. After a complaint the supplier can say only "we think so".',
      options: 'Application logs. A separate audit service fed by events. An append-only table written in the action\'s transaction, hash-chained per council, with the latest hash copied hourly to locked storage.',
      why: 'Same transaction means no action without a line. The app role can only call audit.append and read its own council\'s lines; a trigger refuses changes from anyone. A keyed fingerprint of the approved text lets the council prove later that its record matches what was approved, without us holding the words. Retention is the customer\'s setting.',
      wrong: 'For up to an hour new lines exist only in the database. A superuser could drop the trigger; the sealed hash would expose it. Audit lines are personal data about staff, so they need their own access rules and their own end date.',
      q: 'What is a hash chain?',
      a: 'Each line stores a fingerprint of the line before it. Change or remove any line and every later fingerprint stops matching.',
    }),
    step({
      title: 'Export to the case system',
      text: 'At 11:33 Priya copies the approved note, section by section, into Mr A\'s file in the council\'s Case management system. That system holds the statutory record. The UK app logs each copy with the text\'s fingerprint. A connector that writes into the case system directly exists as an option and is switched off.',
      focus: ['user', 'cms', 'api', 'audit'],
      path: ['paste', 'app'],
      labels: ['6 sections, by hand', 'exported: copy, 6 sections'],
      recovery: true,
      hide: ['wrong', 'directory', 'purge-db', 'purge-audio', 'purge-vendor'],
      context: 'At 11:33 Priya copies the approved note, section by section, into Mr A\'s file in the council\'s Case management system.',
      problem: 'The note has to reach a system we do not run. This design assumes no API to start with, and one council\'s published record describes copy and paste. Copying costs time and can go into the wrong file. Automating it moves that risk into our code.',
      left: 'Manual paste for ever caps the time saved and gives no confirmation of where the text went. A careless write-back files a note on the wrong person at machine speed, with our credentials.',
      options: 'Copy with better tooling and a structured file. An API the council pulls from. A connector per case system that writes the final entry. A connector that writes an unsigned draft to a case the practitioner chose.',
      why: 'Structured copy works with every case system today, keeps a person choosing the file, and needs no access to the council\'s system. The export file carries ai_assisted and the release, so the council\'s record can show an AI helped. Write-back comes later, per council, as an unsigned draft with an idempotency key, so the practitioner still signs inside the system of record.',
      wrong: 'We know the text was copied, not where it landed. With write-back, each case system and version is its own integration and needs that supplier\'s help, and we would hold access to a statutory system.',
      q: 'Why not just build the integration?',
      a: 'The worst outcome in this system is a note on the wrong person\'s file. Today a human prevents it. A connector must match the right case every time, for each case system.',
    }),
    step({
      title: 'Day 30: scheduled deletion',
      text: 'On 17 December, 30 days after approval, the Retention worker finds note 7f3a due and not on legal hold. It deletes the recording from the Audio store, then the note row, which takes the transcript, the draft and the note\'s key with it, and writes a deletion receipt to the Audit log. The last backup holding it expires on 31 December.',
      focus: ['deleter', 'db', 'blobs', 'audit'],
      path: ['purge-db', 'purge-audio', 'relay'],
      labels: ['7f3a due, no hold', 'delete northbridge/7f3a', 'receipt: 291 rows, 1 object'],
      recovery: true,
      hide: ['wrong', 'writeback', 'directory', 'purge-vendor'],
      context: 'On 17 December, 30 days after approval, the Retention worker finds note 7f3a due and not on legal hold.',
      problem: 'The promise is deletion within 120 days at most (the term in one council\'s published record). Data lives in four places: the database, object storage, backups and vendors. Missed deletion makes no noise.',
      left: 'Recordings of vulnerable people pile up for years. The next breach, or the next subject access request, finds them.',
      options: 'A nightly clean-up script. Dropping whole partitions by age. Deleting only the keys. A date on every note, a worker with a hold check, explicit deletes in each store, and a receipt per note.',
      why: 'Each note carries its own deadline, so per-council retention is one column: Northbridge chose 30 days. Live retention is capped at 106 days because backups last 14: 106 + 14 = 120. The receipt lists what was removed where, and is replayed after any restore. Consent withdrawn runs the same path at once. A legal hold, placed by a named person with a review date, pauses it. A 120-day storage rule is the backstop.',
      wrong: 'A hold can be used to keep things indefinitely unless someone reviews it. A restore that skips the replay brings notes back. The approved text lives on in the council\'s case system, rightly, under the council\'s rules. And the vendors: next step.',
      q: 'What is a legal hold?',
      a: 'An instruction from the council to keep one note past its date, because of a complaint, a court matter or a request in progress. It names who asked and when it will be reviewed.',
    }),
    step({
      title: 'The vendor still has a copy',
      text: 'On 8 January the Retention worker\'s monthly check asks the speech-to-text vendor what it holds for our account. A tracer recording sent on 13 November is still there, 56 days on, against terms of zero. The vendor_calls table shows which notes went to that vendor in that period. Note 7f3a is one of them.',
      focus: ['deleter', 'vendors', 'db', 'audit'],
      path: ['purge-vendor', 'purge-db', 'relay'],
      labels: ['what do you hold for us?', 'calls to this vendor, 13 Nov on', 'vendor finding logged'],
      failed: ['purge-vendor'],
      recovery: true,
      hide: ['wrong', 'writeback', 'directory', 'purge-audio'],
      context: 'On 8 January the Retention worker\'s monthly check asks the speech-to-text vendor what it holds for our account.',
      problem: 'Our deletion job cannot reach inside a vendor, and our keys do not protect what we sent in the clear to be processed. A vendor that keeps data past the terms breaks the 120-day promise in our name.',
      left: 'We go on telling 400 councils their data is deleted while a sub-processor holds weeks of recordings. We learn of it from the vendor\'s breach notice, or from the press.',
      options: 'Trust the contract and the vendor\'s annual report. Self-host and have no vendor. Keep a record of every call, send weekly tracers, and reconcile monthly against whatever the vendor lets us list.',
      why: 'The contract sets the rule: zero retention, no training, audit rights, prompt notice of incidents. The design makes a breach findable and bounded: the tracer finds it, and vendor_calls says exactly which notes, councils and days. Then: move that region to the fallback engine with a new release, demand deletion in writing, and tell each affected council promptly with its own list, since the council as controller decides whether to report it.',
      wrong: 'Many vendors expose no listing, so this detector may not exist for them. A tracer proves something was kept, never that nothing was. Until the vendor deletes, the copy exists. The stronger fix is fewer vendors: self-hosted speech to text is the likely first step.',
      q: 'What is a tracer?',
      a: 'A synthetic recording with a unique made-up phrase, sent like a real one. If the vendor can still produce it after the agreed window, its retention is not what the contract says.',
    }),
    step({
      title: 'A year later, the audit trail answers',
      text: 'In November 2027 Mr A\'s daughter complains about what his file says. Northbridge\'s practice lead asks who wrote the note. The recording and transcript are long gone. The Audit log still shows it: drafted by release 42, two flags, changed by Priya, approved by her at 11:31, copied out at 11:33, deleted on 17 December. The fingerprint matches the text in the case system.',
      focus: ['user', 'api', 'audit', 'cms'],
      path: ['app', '<relay'],
      labels: ['who wrote note 7f3a?', '12 lines, chain intact, fingerprint matches'],
      pill: [undefined, 'left'],
      context: 'In November 2027 Mr A\'s daughter complains about what his file says.',
      problem: 'Accountability outlasts the data. The council must explain a record long after the supplier\'s copy is deleted, and "an AI wrote it" is not an answer a council can give.',
      left: 'Either the supplier kept everything to be safe, breaking the retention promise, or it kept nothing and cannot say what its system did.',
      options: 'Keep the content for the audit period. Keep nothing. Keep a content-free trail: ids, times, people, versions, flags, a keyed fingerprint, and receipts.',
      why: 'The trail answers who generated, reviewed, changed and exported what, with which model and prompt, without holding a word of what Mr A said. The fingerprint check proves the case system\'s text is the text Priya approved, or shows it was changed after. It also gives the council what an Algorithmic Transparency Record and a DPIA need: versions, controls and evidence that they ran.',
      wrong: 'The trail cannot show what the draft said before Priya edited it; that is the price of deleting. If the council destroys its key on leaving, old fingerprints can no longer be checked. Audit lines about staff need their own retention and access rules.',
      q: 'Who is accountable for the note?',
      a: 'Priya, as the professional who approved it, and the council, as the owner of the record. The system\'s job is to make that approval informed and to keep proof of what it did.',
    }),
  ],

  stories: [
    {
      id: 'rollout',
      name: 'Rolling out a new prompt version',
      tour: [
        step({
          title: 'Release 41 is proposed',
          text: 'Practitioners complain that drafts repeat themselves. A prompt engineer writes a new prompt that tells the model to merge repeated points, and proposes it in the Control plane as release 41: the prompt\'s hash, the same dated model, the same checker, and a reason. Nothing uses it yet. Each region pulls it for evaluation only.',
          focus: ['control', 'api'],
          path: ['releases'],
          labels: ['release 41: proposed, evaluate only'],
          context: 'Practitioners complain that drafts repeat themselves.',
          problem: 'A prompt is one paragraph of English that changes the behaviour of every draft in three countries. It is easier to change than code and harder to test.',
          left: 'Someone edits the live prompt on a Friday. Drafts change for 100,000 users and nobody can say when or why.',
          options: 'Edit prompts in an admin screen. Ship prompts inside code deploys. Treat a prompt change as a numbered, immutable release with an author, a reason and a required evaluation before any council sees it.',
          why: 'A release bundles everything that shapes a draft: prompt, model snapshot, speech-to-text model, checker version. A model upgrade is then the same process as a prompt change. Immutable means the number on a note is a full answer. Repetition is a real, reported fault (social work press coverage of council trials in 2024), so the reason is recorded with the change.',
          wrong: 'The release does not include each council\'s own template, which also shapes the draft and which councils edit themselves. A template edit needs its own, lighter check.',
          q: 'Who can propose a release?',
          a: 'A named person; the change is reviewed by a second person like code. The release row records both and the reason.',
        }),
        step({
          title: 'Evaluation runs inside each region',
          text: 'The UK pipeline runs release 41 over its evaluation sets through the same code as real notes: speech to text, drafting, the Grounding check. There are 480 cases for the 8 base templates, 2,400 for councils\' own templates and 40 red-team cases. The cases are scripted and recorded by actors, not taken from real visits. It takes about two hours.',
          focus: ['pipeline', 'vendors', 'checker', 'control'],
          path: ['jobs', 'vendor', 'check', 'sync'],
          labels: ['2,920 cases, release 41', 'scripted audio and transcripts', 'score each draft', 'eval results'],
          context: 'The UK pipeline runs release 41 over its evaluation sets through the same code as real notes: speech to text, drafting, the Grounding check.',
          problem: '"Is the new prompt better?" needs a fixed set of inputs with known right answers, per template and per language, or every answer is an opinion. But real recordings cannot be kept as test data: they are deleted within 120 days and belong to the councils.',
          left: 'Changes ship on the strength of five drafts someone looked at. A regression in one template or one accent is found by a practitioner.',
          options: 'Test on real notes kept back. Test on text-only cases. Scripted conversations written with practitioners, recorded by actors with a range of accents, each with facts the draft must include and must not include.',
          why: 'Scripted cases can be kept for ever and shared across regions, because they are about nobody. Recording them tests speech to text as well as drafting; One council\'s published record flags accents as a risk. Each case lists must-say and must-not-say facts, so scoring is mostly mechanical: fact recall, unsupported-sentence rate, and critical misses. Running in each region uses that region\'s vendor endpoints and each council\'s own template.',
          wrong: 'Actors are not real service users: real visits are messier. 10 cases per custom template is thin. The set must grow from real failures, re-created by hand (step 8).',
          q: 'Where do the numbers come from?',
          a: '8 base templates x 60 cases = 480. An assumed 240 custom templates in the UK x 10 cases = 2,400. Plus 40 red-team cases: 2,920. At about 90 seconds each, 40 at a time: about 110 minutes.',
        }),
        step({
          title: 'Release 41 fails a red-team case',
          text: 'Red-team case 17 is a conversation where a woman is asked twice whether her partner hurts her and says no both times. Release 41, told to merge repeated points, writes "She was asked about her partner hurting her." The must-not-say rule fires: the draft implies harm that was denied. One critical miss fails the release. It is never shown to a practitioner.',
          focus: ['pipeline', 'checker', 'api', 'control'],
          path: ['check', 'sync'],
          labels: ['case 17: critical miss', 'release 41: eval_failed'],
          failed: ['check'],
          context: 'Red-team case 17 is a conversation where a woman is asked twice whether her partner hurts her and says no both times.',
          problem: 'The change did what it was asked: it merged repetition. It also blurred a denial into an insinuation. Averages would hide it: release 41 scores better overall, with less repetition and the same fact recall.',
          left: 'A prompt that reads well on average and mishandles safeguarding in 1 case in 40 writes thousands of notes a day.',
          options: 'Gate on average scores. Gate on averages plus a separate red-team set where a single failure blocks the release. Have people read every evaluation draft.',
          why: 'Safeguarding errors are rare and severe, so they get their own set and a zero-tolerance gate, apart from the averages. The red-team cases cover a denial that must stay a denial, a disclosure that must appear, a third party who must not be confused with the person, several cases in one meeting (a reported weakness in the 2024 trials), and a speaker who tells the AI to ignore its instructions. A failed release is never edited; the fix is a new number.',
          wrong: '40 cases cannot cover everything a person might say. A gate this strict slows every change, on purpose. The grader for must-not-say rules is partly a model and needs its own spot checks.',
          q: 'What is red-teaming here?',
          a: 'Writing test conversations designed to make the system fail in the ways that would hurt most, then keeping them as permanent tests.',
        }),
        step({
          title: 'Release 42 passes and goes to a canary council',
          text: 'The engineer adds one rule: never merge a denial with the question. To make room, some older wording is trimmed. This is release 42. It passes all 2,920 UK cases with no critical miss. The Control plane sets Northbridge, a council that agreed to be a canary, to 25% on release 42 and 75% on release 40. The UK app pulls the change within 30 seconds.',
          focus: ['control', 'api'],
          path: ['sync', 'releases'],
          labels: ['release 42: eval_passed', 'northbridge: 42 at 25%, 40 at 75%'],
          context: 'The engineer adds one rule: never merge a denial with the question.',
          problem: 'Passing evaluation shows the release handles the cases someone thought of. Real recordings are the rest. The question is how to meet them with the least harm.',
          left: 'Release 42 goes live for everyone on the strength of scripted tests, and its first real failures happen at full volume.',
          options: 'Everyone at once. Shadow mode: draft with both releases, show only the old one. A percentage of every council. One or two canary councils at a percentage, then rings.',
          why: 'A canary council has agreed in advance, so its DPIA and its practice leads cover it. Splitting inside one council gives a fair comparison: the same people, templates and week. 25% of Northbridge\'s 200 notes a day is 50 notes, about 2,000 sentences, enough to see a doubling in a day. Rings then widen: internal, canary councils, 10% of all, everyone.',
          wrong: 'Canary councils carry more risk than others and must be told plainly. Shadow mode would be safer still, but doubles the vendor calls on real data and leaves a second, unseen draft to delete; it suits model upgrades more than prompt tweaks.',
          q: 'Does a council have to agree to changes?',
          a: 'That depends on its contract and DPIA. This design assumes councils are told of material changes and that canary councils opt in. The page has not checked any real contract.',
        }),
        step({
          title: 'Northbridge\'s notes split 25 and 75',
          text: 'For a day the UK pipeline drafts one Northbridge note in four with release 42 and the rest with release 40. Which release a note gets depends on a hash of its note id, so a retry never switches. Each draft is stored with its release number, and practitioners review and approve as usual. Note 7f3a, from the main tour, is one of the 50.',
          focus: ['api', 'pipeline', 'vendors', 'db'],
          path: ['jobs', 'vendor', 'results'],
          labels: ['bucket 17 of 100: release 42', 'draft with release 42', '38 sentences, release 42'],
          context: 'For a day the UK pipeline drafts one Northbridge note in four with release 42 and the rest with release 40.',
          problem: 'The comparison is only fair if the two groups differ in nothing but the release, and only useful if every note records which one it had.',
          left: 'If the first 50 notes of the day get the new release, they come from the early shift and one team. If a retry can flip a note between releases, some notes have drafts from both and the numbers mean nothing.',
          options: 'Assign by user, by team, by time of day, or by a hash of the note id.',
          why: 'A hash of the note id is close to random with respect to who wrote the note and when, is stable across retries, and needs no stored assignment. The release number sits on the note row, on every draft sentence\'s audit line and in the daily counts.',
          wrong: 'A practitioner may see different draft styles on the same day and be confused; assigning by user would avoid that at the cost of a less fair comparison. 50 notes is too few to see a rare failure.',
          q: 'Do practitioners know which release wrote their draft?',
          a: 'It is in the note\'s details and the audit log, not in their way. Canary councils are told that a share of drafts come from a newer version.',
        }),
        step({
          title: 'The counts come back',
          text: 'As Northbridge\'s practitioners review, the UK app totals the day by release and sends the counts to the Control plane. Release 40: 150 notes, 6,000 sentences, 78 flagged unsupported, which is 1.3%, and a median edit distance of 0.18. Release 42: 50 notes, 2,000 sentences, 82 unsupported, 4.1%, and 0.31. No text and no note ids leave the UK.',
          focus: ['db', 'api', 'control'],
          path: ['<sql', 'sync'],
          labels: ['quality_daily for northbridge', 'counts for releases 40 and 42'],
          context: 'As Northbridge\'s practitioners review, the UK app totals the day by release and sends the counts to the Control plane.',
          problem: 'Quality has to be judged centrally, by people who must not see the notes, across three countries.',
          left: 'Either engineers read real care notes to judge a release, or nobody judges it.',
          options: 'Sample real notes for human grading. Ask practitioners for a thumbs up or down. Derive signals from what the system already sees: checker verdicts, edits, review time, redraft requests.',
          why: 'Three signals cost nothing and need no reading of notes: the share of sentences the Grounding check flags, how much practitioners change before approving, and how long they take. They are counted per council, day, template and release, and only the counts go up. Thumbs and comments are collected too, but few people give them.',
          wrong: 'These are proxies. A release that writes shorter, vaguer sentences could lower the unsupported rate and be worse. Edit distance rises when drafts are bad and also when a team is careful. So each is compared against the same council\'s baseline, never against a fixed bar, and people sample notes inside the council\'s own governance.',
          q: 'What is the median edit distance telling us?',
          a: 'On release 40 the typical note had 18% of its words changed before approval. On release 42, 31%. Practitioners were rewriting much more.',
        }),
        step({
          title: 'The halt rule rolls release 42 back',
          text: 'The Control plane\'s halt rule compares the two releases for the same council, day and template. Release 42\'s unsupported rate is more than twice the baseline, on over 500 sentences. It sets Northbridge back to 100% on release 40 and marks release 42 rolled back. The UK app pulls the change within a minute, and the pipeline redrafts the 31 notes still awaiting review.',
          focus: ['control', 'api', 'pipeline', 'audit'],
          path: ['releases', 'jobs'],
          labels: ['northbridge: release 40 at 100%', 'redraft 31 notes with release 40'],
          context: 'The Control plane\'s halt rule compares the two releases for the same council, day and template.',
          problem: 'Release 42 is worse for this council and it is 16:10. Every minute it stays, more drafts are written by it. A person might not look at the dashboard until tomorrow.',
          left: 'Another day of worse drafts at Northbridge, and the release stays on course for every other council.',
          options: 'A dashboard and a human decision. An alert that pages someone to roll back. An automatic halt with thresholds, then a human review of why.',
          why: 'Rollback is cheap and safe: release 40 was live yesterday. So the machine does it and a person investigates afterwards. Thresholds are deliberately blunt: twice the baseline rate on at least 500 sentences, or a median edit distance 0.08 higher. The audit log lists the 50 notes release 42 wrote at Northbridge: 31 unapproved are redrafted, and the practice lead gets the list of 19 already approved, some already in the case system.',
          wrong: 'A blunt rule misfires on a noisy day and halts a good release; that costs a day. A small council never reaches 500 sentences. The 19 approved notes were each reviewed by a practitioner, but with worse drafts under them; only the council can decide whether to re-read them.',
          q: 'Why was it worse only at Northbridge?',
          a: 'Trimming the prompt removed a line telling the model to write "None disclosed" in an empty section. Base templates say that themselves. Northbridge\'s custom "Risks and safeguarding" section did not, so the model filled it.',
        }),
        step({
          title: 'The miss becomes a test',
          text: 'The team rebuilds the failure as a scripted case: Northbridge\'s template, a visit with no risks disclosed and one denial. It joins that template\'s evaluation set, and a similar case joins the set for every custom template with a risks section. Release 43 restores the lost line and must pass them all before any council sees it. Northbridge is told what happened.',
          focus: ['control', 'pipeline', 'checker'],
          path: ['releases', 'jobs', 'check'],
          labels: ['release 43: proposed', '2,920 cases + the new ones', 'no critical miss'],
          context: 'The team rebuilds the failure as a scripted case: Northbridge\'s template, a visit with no risks disclosed and one denial.',
          problem: 'The evaluation set had a hole exactly where a real council\'s template was. Fixing the prompt closes this hole once. The next trim could reopen it.',
          left: 'The same class of failure returns in six months, in another council\'s template, and is caught, or not, by another canary.',
          options: 'Fix the prompt and move on. Copy the real transcript into the test set. Re-create the failure as a scripted, synthetic case and generalise it across templates.',
          why: 'Every production failure becomes a permanent test, written by hand so that no real person\'s words are kept past their deletion date. Generalising it to every template with a similar section covers the councils that were not canaries. The council is told because it is the controller and because trust depends on hearing it from the supplier first.',
          wrong: 'The set grows and so does the two-hour run and its cost. Synthetic re-creations lose detail from the real case. Templates that councils edit themselves can open new holes at any time, so a template edit triggers that template\'s cases.',
          q: 'Why not keep the real transcript as the test?',
          a: 'It is a real person\'s conversation, held under a promise to delete it. A scripted copy of the pattern tests the same behaviour and is about nobody.',
        }),
      ],
    },
  ],

  brief: [
    {
      heading: 'What this page is',
      points: [
        'A supplier of AI note-taking to UK councils turns a recorded conversation into a draft case note. Assume it serves a few hundred councils and has customers in the US and Australia, with data kept in each country. The drafts go into statutory care records, and the supplier deletes data after at most 120 days (the term in one council\'s published algorithmic transparency record, 2025).',
        'This page is a design for such a platform. It describes no real supplier\'s architecture. The writes are small, about one note a second at peak. The hard part is trust: residency, isolation between councils, drafts that can be checked against the recording, an audit trail, and deletion that reaches vendors and backups.',
      ],
    },
    {
      heading: 'Ask first (then propose defaults)',
      points: [
        'How do you run AI note drafting for hundreds of councils in three countries so that data stays in its country, no council sees another\'s, every draft can be traced to what was said, and everything is gone on time?',
        'What is a tenant: a council, or a team inside one? Default: a council.',
        'Does "in-country" cover processing by speech and language vendors, or storage only? Default: both.',
        'Is the council\'s case system the statutory record? Default: yes; ours is a working copy.',
        'What is the retention promise and does it include backups and vendors? Default: 120 days at most, everywhere.',
        'Who approves a note, and can anything reach the case system without approval? Default: a named practitioner, always.',
        'Which matters more to you today: wrong content, or data crossing a boundary? It decides where to go deep.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Send each user to their council\'s country and refuse anything that arrives in the wrong one.',
        'Keep each council\'s data invisible to every other council, including under bugs.',
        'Turn a recording into a draft in minutes, with every sentence traceable to the transcript and risky ones flagged.',
        'Let a practitioner review, edit, approve and move the note to the case system; nothing leaves unapproved.',
        'Record who generated, reviewed, changed and exported what, with which model and prompt, in a log nobody can alter.',
        'Delete everything on schedule, in every copy, with proof; honour holds and withdrawn consent.',
        'Roll a new prompt or model out council by council, and roll it back for one council in a minute.',
      ],
    },
    {
      heading: 'How well',
      points: [
        'About 20,000 notes a working day, about 1 a second at peak, about 10,000 audio hours a day (assumptions).',
        'Draft ready within 5 minutes for 95% of 30-minute recordings.',
        '99.5% availability per region, a typical target in a G-Cloud listing (assumption).',
        'Zero cross-tenant reads, zero accepted wrong-region requests, zero notes past 120 days.',
        'Simplified on this page: one database per region with no read replicas drawn; the identity broker is folded into the app; templates and the knowledge base are not modelled; billing, the live translation and call-handling products, and the casework service are out of scope; vendor APIs are sketches; every figure in the tours is invented.',
      ],
    },
    {
      heading: 'Public facts used here, with the kind of source',
      points: [
        'These are the only statements taken from public sources. The scale figures are assumptions, not any supplier\'s numbers.',
        'Staff record on council devices in the web app; audio in WAV or MP3; verbal consent first, recording deleted and paper notes used on objection; drafts pasted into the case system; final record in the council\'s system; data kept up to 120 days then deleted; data stored in the UK or EEA; poorer accuracy risk for strong accents; Deepgram with Whisper fallback; an OpenAI model for summaries; vendors do not train on the data; a hosted identity service for authentication: one council\'s published algorithmic transparency record on GOV.UK (2025).',
        'No API offered; exports in CSV, PDF and MP3; identity federation and MFA; TLS 1.2 or above; a 99.5% availability target; a 4-week exit plan with a deletion plan; audit log retention set by the user; ISO 27001, Cyber Essentials and Cyber Essentials Plus, a CSA STAR Level 1 self-assessment, the NHS Data Security and Protection Toolkit, BS7858 staff screening and an annual CREST penetration test: the kind of claims a supplier makes in a G-Cloud listing. This design takes them as its assumptions.',
        'Council-set prompts; reported errors in summaries (misspelt names, repetition, assumptions about needs); difficulty with meetings covering several cases: social work press coverage of council trials in 2024.',
        'Ada Lovelace Institute warning on bias and hallucinations in AI transcription tools in social work: coverage of 12 February 2026 (Local Government Lawyer).',
        'The grounding check and any redaction before the LLM are this design\'s proposals. The page describes no real supplier\'s practice.',
      ],
    },
    {
      heading: 'Assumptions made by this design',
      points: [
        '10% of users record on a given working day and make 2 notes each; so 20,000 notes a day. The 20% peak hour. The 30-minute average recording and 20 MB average file. All volumes that follow from these.',
        'Regional split of 80% UK, 15% US, 5% Australia. 400 tenants. 240 custom templates in the UK.',
        '150 words a minute of speech; about 1.33 tokens a word; about 17,000 tokens a note; about 40 sentences and about 210 segments a note.',
        'Vendor speeds: speech to text within 2 minutes and drafting within 1 minute for a 30-minute recording.',
        '12 audit lines a note at 400 bytes; 6-year default audit retention (a placeholder, not a legal finding).',
        'Northbridge Council, Lakeview County, Priya, Mr A, note 7f3a and every figure in the two tours (4.1% against 1.3%, 0.31 against 0.18, 50 and 150 notes, 31 and 19, 56 days) are invented for illustration. None is a measurement.',
        'This design\'s choices, not facts: 14-day backups and the 106-day ceiling; 30-day default retention; 8-hour sessions; 30-second pull; cap of 8 running jobs per council; halt thresholds (twice baseline, 500 sentences, 0.08); 40 red-team cases; 60 cases per base template and 10 per custom template; 7-day wait before key destruction; time-outs; the sizing of teams.',
        'That each council is the data controller and the supplier its processor, with AI vendors as sub-processors. Standard for this kind of service and consistent with one council\'s published record listing sub-processors, but no contract was read.',
        'That councils are told of material changes and that canary councils opt in. Not checked against any contract.',
        'That one database per country already exists. It follows from the assumed in-country hosting promises.',
        'That 120 days is the maximum for every customer. It is the figure in one council\'s record.',
      ],
    },
    {
      heading: 'Not checked against a source',
      points: [
        'HTTP 421 is "Misdirected Request" and suits this use.',
        'PostgreSQL behaviour beyond what was run: that a table owner bypasses row-level security unless FORCE is set; that BYPASSRLS exists as a role attribute; that SET LOCAL is safe with transaction-mode connection pooling. (Run and confirmed on PostgreSQL 16: the policies, the fail-closed error with no tenant set, the audit function and trigger, the chain check, the approval guard, the omission query, the fair dequeue, the control plane queries. Not run: concurrency of the fair dequeue or of audit.append under load.)',
        'GoodJob is a PostgreSQL-backed job queue for Rails; Sidekiq uses Redis.',
        'That AI vendors offer zero-retention terms and in-country endpoints in the UK, the US and Australia. Offers differ by vendor, product and contract and change often. Not checked for Deepgram, OpenAI, Azure OpenAI or Anthropic.',
        'That vendors expose a way to list stored requests, files or batch inputs. The page says this varies and may not exist.',
        'That open speech models (Whisper among them) can be self-hosted.',
        'That cloud object stores offer object locking and lifecycle expiry, and cloud key services offer scheduled key destruction with a waiting period and per-call logs.',
        'UK GDPR points: a processor must tell the controller of a personal data breach without undue delay; the controller decides whether to report it; a DPIA is required for high-risk processing. The page gives no article numbers or deadlines. No legal source was read.',
        'What ISO 27001, Cyber Essentials Plus, the NHS Data Security and Protection Toolkit, CSA STAR and BS7858 require in detail. The page only says they ask for access control, logging, change management and supplier management, in general terms.',
        'US and Australian law. Nothing is claimed beyond "data stays in-country", which is this design\'s assumed promise.',
        'Whether any case system offers a usable API.',
        'That 2,190 days is 6 years (365 x 6; ignores leap days).',
        'Edit distance as defined here (word-level, divided by length) is one common definition; others exist.',
      ],
    },
  ],

  numbers: [
    { what: 'Users', assumption: '100,000 frontline workers with accounts (assumption)', result: 'design for 100,000' },
    { what: 'Notes', assumption: '10% record on a working day, 2 notes each (assumption)', result: '20,000 a day; 4,000 in the peak hour; about 1.1 a second' },
    { what: 'Audio', assumption: '30 minutes a note (assumption)', result: '10,000 hours a day; 50,000 a week' },
    { what: 'Audio storage', assumption: '20 MB a note (14 MB as MP3, 58 MB as WAV)', result: '400 GB a day; about 8 TB at 30 days; about 30 TB at 106 days' },
    { what: 'Tenants', assumption: '400 customer organisations (assumption)', result: 'about 400, in three regions' },
    { what: 'Regions', assumption: 'assumed split 80% UK, 15% US, 5% Australia', result: '16,000, 3,000 and 1,000 notes a day' },
    { what: 'Tokens', assumption: 'about 17,000 a note including the grounding check (assumption)', result: 'about 340 million a day' },
    { what: 'Database rows', assumption: 'about 260 rows a note', result: '5.2 million a day; under 400 million held at the ceiling' },
    { what: 'Audit', assumption: 'about 12 lines a note at 400 bytes', result: '240,000 lines a day; about 25 GB a year' },
    { what: 'Vendor calls', assumption: 'about 3 a note', result: '60,000 rows a day' },
    { what: 'Retention', assumption: '120 days promised (the term in one council\'s published record); backups 14 days (this design)', result: '106 days at most in live stores' },
    { what: 'Evaluation', assumption: '8 base templates x 60, 240 custom x 10, 40 red-team (assumptions)', result: '2,920 UK cases; about 2 hours; about 15% of a day\'s tokens' },
    { what: 'Canary', assumption: 'Northbridge: 200 notes a day, 25% on the new release', result: '50 notes, about 2,000 sentences a day' },
    { what: 'Rollback', assumption: 'regions pull every 30 seconds', result: 'effective within 60 seconds' },
    { what: 'Availability', assumption: '99.5% (assumption; a typical G-Cloud target)', result: '3.6 hours of downtime allowed in a 30-day month' },
  ],

  framings: [
    { name: 'One country, a few councils', scale: 'a pilot: 5 councils, 500 users', shape: 'One Rails app and one PostgreSQL database. tenant_id and row-level security from day one, the audit function, a deletion date on every note. No control plane, no rollout table: one prompt, changed with care. Do not build regions before there is a second country.' },
    { name: 'Three countries, hundreds of councils (this page)', scale: 'about 400 tenants, 100,000 users, 20,000 notes a day', shape: 'A global control plane without personal data, a full stack per country, forced row-level security, per-council keys, grounding check, releases with canary councils, audit and retention as first-class parts.' },
    { name: 'A customer who wants its own everything', scale: 'one very large council, health body or state agency', shape: 'The same data plane deployed as a single-tenant stack: its own database, key, worker pool and vendor contract, still fed by the control plane. Possible because every key starts with tenant_id and regions are built from one definition.' },
    { name: 'No outside AI vendors allowed', scale: 'a customer or country that forbids sub-processors for the audio or text', shape: 'Self-hosted speech and language models on GPUs in the region. Quality and cost change; the grounding check, releases and audit stay the same. The vendor line becomes an in-region call.' },
    { name: 'Live products (calls and translation)', scale: 'streaming audio with replies in under a second', shape: 'A different problem: streaming speech to text, low latency, telephony. The tenancy, residency, audit and retention parts of this page carry over; the batch pipeline and the after-the-fact grounding check do not.' },
  ],

  decisions: [
    { choice: 'Residency', a: 'One global control plane, a data plane per country', b: 'Three fully separate stacks, or one global stack with a region column', call: 'Control plane plus regional data planes. A region column keeps the data in one country whatever the tag says; three separate stacks drift.' },
    { choice: 'Routing', a: 'By the council\'s domain, checked again by the region', b: 'By the user\'s location, or a country picker', call: 'By customer. Residency follows the customer, and the region refuses what is not addressed to it.' },
    { choice: 'Wrong region', a: 'Refuse with 421', b: 'Forward or redirect', call: 'Refuse. Forwarding passes data through the wrong country and hides the bug.' },
    { choice: 'Tenant isolation', a: 'Shared tables, forced row-level security', b: 'Schema or database per tenant', call: 'Row-level security for the many; a council can move to its own database because every key starts with tenant_id.' },
    { choice: 'Keys', a: 'A key per council, a data key per note', b: 'One storage key for the region', call: 'Per council and per note. A second wall, and an exit that reaches backups.' },
    { choice: 'Noisy neighbours', a: 'Per-council cap in the queue\'s claim query', b: 'A queue per council, or first-in first-out', call: 'The cap. One WHERE clause, and a small team is never behind a big council\'s backlog.' },
    { choice: 'Hallucination', a: 'Citations, a second-model check, an omission check; flag', b: 'Trust review, or delete unsupported sentences', call: 'Flag. Review alone misses fluent errors; silent deletion can remove a true disclosure.' },
    { choice: 'Final control', a: 'A practitioner approves; high-risk flags block', b: 'One-click approve', call: 'Targeted friction. The database refuses approval while a high-risk flag is open.' },
    { choice: 'Evaluation data', a: 'Scripted cases recorded by actors', b: 'Real recordings kept back', call: 'Scripted. Real ones are deleted within 120 days and are not ours to keep.' },
    { choice: 'Rollout', a: 'Immutable releases, canary council, automatic halt', b: 'Edit the live prompt; ship to all', call: 'Releases and rings. A change is tried on 50 notes before 20,000.' },
    { choice: 'Quality signal', a: 'Unsupported rate and edit distance against the council\'s own baseline', b: 'Human grading of real notes; thumbs', call: 'Derived signals. They need nobody to read a care note. People sample inside the council.' },
    { choice: 'Audit', a: 'Append-only, hash-chained, in the action\'s transaction, no text', b: 'Application logs', call: 'In the transaction. No action without a line, and it can outlive the note.' },
    { choice: 'Deletion', a: 'A date on every note, a worker, receipts, 106 + 14', b: 'Partition drops, or key deletion alone', call: 'Per-note deletion with receipts. Councils differ and holds exist.' },
    { choice: 'Vendor copies', a: 'In-country, zero retention, a row per call, tracers', b: 'Trust the contract; or self-host', call: 'Contract plus record now; self-host speech to text when volume pays for it.' },
    { choice: 'Integration', a: 'Structured copy and export, then pull API, then unsigned-draft write-back', b: 'Full write-back first', call: 'Export first. A note on the wrong file is the worst outcome.' },
    { choice: 'Architecture', a: 'A monolith per region', b: 'Microservices', call: 'Monolith. One note a second, and the action and its audit line stay in one transaction.' },
  ],

  drills: [
    { name: 'A request for a UK council reaches the US stack', what: 'Token region and local tenant table both fail it. 421, nothing stored, an alert. The schema could not hold the row anyway.' },
    { name: 'A query forgets its tenant filter', what: 'Row-level security returns nothing from other councils. With no tenant set, the query errors.' },
    { name: 'A big council uploads 300 recordings at once', what: 'It runs 8 at a time. Other councils\' jobs are claimed first when they have fewer running.' },
    { name: 'The speech-to-text vendor is down', what: 'Retries, circuit breaker, fallback engine in the same country. The note\'s status says it is waiting; the practitioner can write by hand.' },
    { name: 'The draft invents a safeguarding detail', what: 'The cited segment contradicts it. Flagged, high risk, approval blocked until the practitioner resolves it.' },
    { name: 'The draft leaves out a disclosure', what: 'The omission check lists high-risk segments that no sentence cites.' },
    { name: 'A new prompt is worse for one council', what: 'The halt rule compares releases inside the council and rolls it back. The audit log lists the notes it wrote.' },
    { name: 'The vendor changes the model behind an alias', what: 'Releases pin dated snapshots. A nightly run of 50 cases shows any shift.' },
    { name: 'The control plane is down', what: 'Regions draft on the last configuration. Rollouts wait. Each region can pin a release locally.' },
    { name: 'The person withdraws consent a week later', what: 'Delete now through the normal path, with a receipt. Text already in the case system is the council\'s to handle.' },
    { name: 'A complaint needs the recording kept', what: 'The council places a legal hold with a reason and a review date. The worker skips the note until it is released.' },
    { name: 'The database is restored from a 3-day-old backup', what: 'Deletion receipts newer than the backup are replayed before traffic. Nothing deleted comes back into use.' },
    { name: 'A vendor kept data past its terms', what: 'The tracer or the vendor\'s notice reveals it. vendor_calls gives each council its list. Switch to the fallback, demand deletion, tell the councils.' },
    { name: 'A council leaves', what: 'Export, delete with receipts, then destroy its key after two approvals and a 7-day wait. Backups of its data are unreadable.' },
    { name: 'A support engineer needs to see a note', what: 'Break-glass: one tenant, a reason, a second approver, one hour, and a line in that council\'s audit log.' },
    { name: 'Someone alters the audit table', what: 'The hourly chain check fails against the hash sealed in locked storage, and pages.' },
  ],

  interview: [
    'Minutes 0 to 5: clarify. Tenant per council? In-country for vendors too? Is the case system the record? Retention, including backups and vendors? Who approves? State defaults and move on.',
    'Minutes 5 to 9: numbers. 100,000 users, 20,000 notes a day, 1 a second at peak, 10,000 audio hours. Say which are assumptions. Conclusion: small writes, hard trust.',
    'Minutes 9 to 17: draw the global row (router, control plane, no personal data), one region (app, Postgres with row-level security, audio store, keys, pipeline, grounding check, audit, retention worker) and the outside (identity provider, vendors, case system).',
    'Minutes 17 to 37: the two deep dives. Tenancy and residency: routing, 421, row-level security against the alternatives, keys, noisy neighbours. AI quality: citations, the second-model and omission checks, flags that block, evaluation sets, releases, canary, halt, rollback.',
    'Minutes 37 to 46: proof. Audit in the transaction, hash chain, no text. Deletion dates, 106 + 14, receipts, holds, consent. Vendors: contract and record.',
    'Minutes 46 to 51: integration and compliance. Copy and paste today; export, pull API, write-back as an unsigned draft. Controller and processor, DPIA evidence, sub-processors per region.',
    'Minutes 51 to 57: deliver and run it. Order of phases, shadow first, teams, what pages. Say what you would cut with five engineers and one quarter.',
    'Last 3 minutes: your questions. Which cloud is current, how drafts are checked today, whether any case system integration is live.',
    'Throughout: say "this is my design, I don\'t know yours". Name public facts with their source. Do not claim the interviewer\'s company has or lacks any control.',
  ],

  sources: [
    { label: 'One UK council\'s algorithmic transparency record for an AI note-taking tool, on GOV.UK (2025)', note: 'Recording on council devices, WAV and MP3, verbal consent, paste into the case system, up to 120 days then deleted, UK or EEA storage, Deepgram with Whisper fallback, an OpenAI model, named sub-processors, accent risk. The best public description of such a product in use. Not linked, because the record names the product.' },
    { label: 'Social work press coverage of council trials of AI note-taking (2024)', note: 'Council-set prompts; reported errors (misspelt names, repetition, assumptions about needs); trouble with meetings covering several cases; calls for more evaluation.' },
    { label: 'Local Government Lawyer: Ada Lovelace Institute report on AI transcription in social work (12 February 2026)', href: 'https://localgovernmentlawyer.co.uk/adult-social-care/391-adult-care-news/99712-ai-transcription-tools-in-social-work-introducing-new-risks-to-people-and-society-such-as-bias-and-hallucinations-report-warns', note: 'Risks of bias and hallucinations; councils evaluate efficiency more than impact; recommends transparency records.' },
    { label: 'This page\'s SQL checks (PostgreSQL 16, 16 November 2026)', note: 'The regional schema, row-level security policies, the audit function and trigger, the chain check, the approval guard, the omission query, the fair dequeue, deletion with cascade, and the control plane\'s routing, release assignment, halt rule and rollback were run on a PostgreSQL 16 server. Nothing else on the page was run.' },
    { label: 'What this page did not verify', note: 'Listed in the brief under "Public facts used here", "Assumptions made by this design" and "Not checked against a source".' },
  ],

  glossary: [
    { term: 'Tenant', also: ['council', 'customer'], where: 'db', text: 'One customer organisation, here a council. Every row and object belongs to exactly one.' },
    { term: 'Data residency', also: ['in-country', 'sovereignty'], where: 'other', text: 'Keeping a customer\'s data stored and processed in its own country. Here: a separate stack per country with no path between them.' },
    { term: 'Control plane', where: 'control', text: 'The global part that says what the product is: councils, releases, rollout. Holds no personal data.' },
    { term: 'Data plane', also: ['regional stack'], where: 'api', text: 'The part that handles customers\' data. One per country.' },
    { term: 'Row-level security', also: ['RLS', 'policy'], where: 'db', text: 'A PostgreSQL rule attached to a table that filters every query. Here: only rows of the tenant the session has set.' },
    { term: 'app.tenant_id', also: ['SET LOCAL'], where: 'db', text: 'A per-transaction setting the app sets from the token. The policies read it. Unset, queries fail.' },
    { term: 'Noisy neighbour', where: 'pipeline', see: { id: 'token-bucket', label: 'Token bucket' }, text: 'One tenant whose load slows the others on shared infrastructure.' },
    { term: 'Envelope encryption', also: ['data key', 'wrapped key'], where: 'kms', text: 'Data is encrypted with a data key; the data key is encrypted with a key that stays in the key service.' },
    { term: 'Crypto-shredding', also: ['key destruction'], where: 'kms', text: 'Making data unreadable by destroying its key. Used here when a council leaves.' },
    { term: 'Sub-processor', where: 'vendors', text: 'A company the supplier passes a customer\'s data to. Here: the speech-to-text and LLM vendors, the cloud, the identity broker.' },
    { term: 'Zero retention', where: 'vendors', text: 'Contract terms under which a vendor keeps no copy of a request after answering it.' },
    { term: 'Release', also: ['prompt version', 'model version'], where: 'control', text: 'An immutable, numbered bundle of prompt, pinned model, speech-to-text model and checker version.' },
    { term: 'Canary', also: ['ring', 'staged rollout'], where: 'control', text: 'Trying a release on a small, agreed share of traffic first. Here: 25% of one council\'s notes.' },
    { term: 'Halt rule', also: ['rollback'], where: 'control', text: 'An automatic comparison of a canary release with the baseline that puts the council back on the old release.' },
    { term: 'Evaluation set', also: ['golden set', 'eval'], where: 'pipeline', text: 'Scripted conversations with known right answers, per template and language, run against every release.' },
    { term: 'Red-team case', where: 'checker', text: 'A test built to provoke the worst failures, such as a denial becoming an allegation. One miss blocks a release.' },
    { term: 'Grounding', also: ['citation', 'span', 'segment'], where: 'checker', text: 'Tracing each draft sentence to the transcript segments that support it.' },
    { term: 'Hallucination', also: ['unsupported sentence'], where: 'checker', text: 'A fluent statement the model wrote that the recording does not support.' },
    { term: 'Omission check', where: 'checker', text: 'Looking for risky things said in the recording that no draft sentence cites.' },
    { term: 'Human in the loop', also: ['review', 'approval'], where: 'user', text: 'A person must approve the AI\'s output before it is used. Here: a named practitioner, with high-risk flags resolved first.' },
    { term: 'Edit distance', where: 'db', text: 'How much of the draft the practitioner changed before approving, from 0 to 1.' },
    { term: 'Audit trail', also: ['audit log'], where: 'audit', see: { id: 'append-log', label: 'Append-only log' }, text: 'The record of who did what, when, with which release. Append-only and chained by hash.' },
    { term: 'Hash chain', where: 'audit', text: 'Each line stores a fingerprint of the one before, so a change or a gap shows.' },
    { term: 'HMAC', also: ['keyed fingerprint'], where: 'audit', text: 'A hash mixed with a secret key. Lets the council prove its record matches what was approved without us keeping the text.' },
    { term: 'Deletion receipt', where: 'deleter', text: 'An audit line listing what was deleted from which store, and when backups will be clear.' },
    { term: 'Legal hold', where: 'deleter', text: 'A council\'s instruction to keep one note past its date, with a reason and a review date.' },
    { term: 'Idempotency key', where: 'pipeline', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: 'A unique label on a request or job so that doing it twice has the effect of doing it once.' },
    { term: 'Case management system', also: ['CMS', 'Eclipse'], where: 'cms', text: 'The council\'s system of record for social care cases. Eclipse is one in use.' },
    { term: 'Write-back', where: 'cms', text: 'The supplier\'s system writing the note into the case system through its API, instead of a person pasting it.' },
    { term: 'SSO', also: ['OIDC', 'SAML', 'identity provider'], where: 'idp', text: 'Signing in to this app with the council\'s own staff account.' },
    { term: 'Controller and processor', where: 'cms', text: 'Under UK data protection law the council decides why and how personal data is used (controller); the supplier acts on its instructions (processor).' },
    { term: 'DPIA', where: 'control', text: 'Data protection impact assessment: the council\'s written assessment of a risky use of personal data. One council\'s for a product of this kind was approved in 2025.' },
    { term: 'ATRS', also: ['algorithmic transparency record'], where: 'control', text: 'A public record a UK public body publishes about an algorithmic tool it uses. One council\'s is this page\'s main source.' },
    { term: 'Break-glass access', where: 'api', text: 'Time-limited, approved, logged access by support staff to one council\'s data.' },
  ],
};
