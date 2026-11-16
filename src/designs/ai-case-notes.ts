import type { Design, Example } from './types';

/**
 * AI case notes: from a recorded visit to a reviewed note.
 *
 * Built from a content spec of 16 November 2026. The design is this page's own and describes
 * no real supplier's architecture. Facts from public sources carry the kind of source; scale
 * figures are labelled assumptions.
 * The spec's section 7 (unverified) is summarised in the sources entry "What this page did not verify".
 *
 * Example followed (all illustrative, all fictional): Priya, an adult social care worker at
 * Northshire Council (made up; uses Eclipse), records a Care Act assessment with Mr Hughes and his
 * daughter on Tuesday 17 November 2026, 14:05 to 14:57: 52 minutes, Opus at 32 kbit/s, 12.48 MB in
 * three parts (5 MiB, 5 MiB, 1.9 MiB). Recording rec_7f3a, template "Care Act assessment" v7.
 * Upload complete 15:07:10, Deepgram fails 15:07:42, Whisper transcript 15:09:30, LLM timeout
 * 15:11:31, draft saved 15:12:20, draft ready 15:12:45, reviewed 16:20 to 16:29, copied into Eclipse
 * 16:33, deleted 17 March 2027 (day 120).
 *
 * SQL on this page was run on PostgreSQL 18.6 (PGlite) on 16 November 2026 (spec's schema and test).
 */

const createRecording: Example = {
  title: 'Create the recording (safe to send twice)',
  lang: 'sql',
  code: `INSERT INTO recordings (id, tenant_id, worker_id,
                        client_recording_id, delete_after)
SELECT gen_random_uuid(), t.id, $2, $3,
       now() + make_interval(days => t.retention_days)
FROM tenants t WHERE t.id = $1
ON CONFLICT (tenant_id, client_recording_id) DO UPDATE
  SET client_recording_id = EXCLUDED.client_recording_id
RETURNING id, state, delete_after;`,
  note: `The second call returns the first call's row. The council's retention_days has a CHECK of 1 to 120.`,
};

const missingParts: Example = {
  title: 'Which parts are missing?',
  lang: 'sql',
  code: `SELECT n AS part_no
FROM generate_series(1, $2::int) AS n
WHERE NOT EXISTS (
  SELECT 1 FROM upload_parts p
  WHERE p.recording_id = $1 AND p.part_no = n);`,
  note: `After the drop in step 4 this returns part 2. The store's own part list is the authority; this table is the app's copy.`,
};

const completeUpload: Example = {
  title: 'Complete the upload: state and next step together',
  lang: 'sql',
  code: `WITH moved AS (
  UPDATE recordings
  SET state = 'uploaded', uploaded_at = now(),
      bytes = $2, sha256 = $3
  WHERE id = $1 AND state = 'uploading'
    AND consent = 'given'
  RETURNING id, tenant_id)
INSERT INTO pipeline_steps (recording_id, tenant_id, step)
SELECT id, tenant_id, 'transcribe' FROM moved
ON CONFLICT DO NOTHING
RETURNING recording_id;`,
  note: `Run twice, the second returns no row. The GoodJob job row is inserted in the same transaction.`,
};

const claimStep: Example = {
  title: 'Claim a step (the lease)',
  lang: 'sql',
  code: `UPDATE pipeline_steps
SET status = 'running', attempts = attempts + 1,
    locked_until = now() + make_interval(secs => $3),
    provider = $4
WHERE recording_id = $1 AND step = $2 AND attempts < 5
  AND (status = 'pending'
       OR (status = 'running' AND locked_until < now()))
RETURNING attempts;`,
  note: `No row back means another worker holds it, or it is done, dead or cancelled: stop. A lease that has run out can be taken over.`,
};

const saveDraft: Example = {
  title: 'Save the draft once',
  lang: 'sql',
  code: `WITH d AS (
  INSERT INTO drafts (recording_id, tenant_id, generation,
    template_version_id, model, body_enc, statements)
  VALUES ($1, $2, 1, $3, $4, $5, $6)
  ON CONFLICT (recording_id, generation) DO NOTHING
  RETURNING id)
UPDATE recordings
SET state = 'draft_ready', draft_ready_at = now()
WHERE id = $1 AND state = 'summarising'
  AND EXISTS (SELECT 1 FROM d)
RETURNING id;`,
  note: `Two runs of the same job: the first saves, the second inserts nothing and moves nothing (checked: one draft, the first one's).`,
};

const sloQuery: Example = {
  title: 'Draft-ready time in the last hour (the SLO)',
  lang: 'sql',
  code: `SELECT count(*) AS drafts,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY
    extract(epoch FROM draft_ready_at - uploaded_at))
    AS p95_seconds,
  avg((draft_ready_at - uploaded_at
       <= interval '10 minutes')::int) AS within_10_min
FROM recordings
WHERE draft_ready_at >= now() - interval '1 hour';`,
  note: `Run by a role that may read metadata across councils. It reads no content.`,
};

const stuckSteps: Example = {
  title: 'Stuck and dead steps',
  lang: 'sql',
  code: `SELECT r.tenant_id, r.id, r.state, s.step, s.attempts,
       s.last_error, now() - r.uploaded_at AS age
FROM recordings r
JOIN pipeline_steps s ON s.recording_id = r.id
WHERE s.status = 'dead'
   OR (s.status IN ('pending','running')
       AND r.uploaded_at < now() - interval '30 minutes')
ORDER BY age DESC;`,
  note: `Ids, states and error classes only. last_error holds a class such as "provider_5xx", never text from a transcript.`,
};

const costQuery: Example = {
  title: 'Cost per audio hour, by day',
  lang: 'sql',
  code: `SELECT date_trunc('day', started_at) AS day,
       sum(cost_micros) / 1e6 AS dollars,
       sum(audio_s) / 3600.0 AS audio_hours,
       (sum(cost_micros) / 1e6)
         / nullif(sum(audio_s) / 3600.0, 0)
         AS dollars_per_audio_hour
FROM vendor_calls
WHERE started_at >= now() - interval '7 days'
GROUP BY 1 ORDER BY 1;`,
  note: `Every paid call is a row, including the ones that timed out, so retries show up in the cost.`,
};

export const aiCaseNotes: Design = {
  id: 'ai-case-notes',
  name: 'AI case notes: from a recorded visit to a reviewed note',
  blurb: `Design the pipeline behind an AI note-taker for social work: record on a phone or laptop, upload over a bad connection, transcribe with a fallback provider, summarise into the council's template, have the worker review and sign, copy into the case system, delete at 120 days. Follow one recording through four failures, or follow a council's data being deleted.`,
  tourName: 'A visit becomes a note',
  rest: 'Press Play to follow one recording from a home visit to the case record, or open any box or chip. In the diagram, arrows move and Enter opens.',
  restTouch: 'Press Play to follow one recording from a home visit to the case record, or tap any box or chip to open it.',
  size: { w: 1355, h: 650 },
  frame: { x: 228, y: 66, w: 847, h: 574, label: 'Notes service', note: 'One Rails codebase, one stack per region' },
  keyNotes: [
    { mode: 'async', text: `"GoodJob" means a job row in PostgreSQL, picked up by a worker process. A job can run more than once, so every job checks before it writes.` },
    { mode: 'external', text: `Deepgram, Whisper and the LLM are paid by use. A retry costs money as well as time.` },
    { mode: 'write', text: `"SQL" lines to PostgreSQL also carry the next job, in the same transaction as the state change.` },
  ],

  components: [
    {
      id: 'device',
      name: `Worker's device`,
      short: 'Device',
      tech: 'browser, local store',
      x: 100, y: 300, w: 150, h: 96, kind: 'input',
      lines: ['records offline', 'uploads in parts'],
      what: `The council-issued phone or laptop the worker records on, running the notes web app. One council's published record says staff record on council-issued devices through the web app, and that the audio is WAV or MP3 with metadata. In this design the page asks for the microphone, records with the browser's MediaRecorder, and writes a slice of audio to local storage every 10 seconds. Nothing in this step needs a network. When the worker stops, an upload manager sends the file in parts and keeps trying until the server confirms every part.`,
      why: `Home visits have poor signal, and a recording cannot be taken again: the conversation happened once. So the device must be able to finish a 90-minute recording with no connection at all, survive a tab crash losing at most 10 seconds, and upload later without the worker watching it.`,
      built: [
        { name: 'MediaRecorder with a 10-second timeslice', what: `The browser's recording API hands the page a chunk of encoded audio every 10 seconds.`, why: `A crash or a flat battery loses at most the last slice. Opus at 32 kbit/s is plenty for speech and is about a quarter of the size of 128 kbit/s MP3.` },
        { name: 'Local store (IndexedDB or the origin private file system)', what: `Storage that belongs to the web app on that device.`, why: `The recording has to live somewhere before there is signal. The slices are deleted only after the server has confirmed the whole upload and its checksum.` },
        { name: 'Upload manager', what: `Page code that splits the file into parts of 5 MiB, sends each to a presigned URL, records each success, and retries with backoff and jitter.`, why: `A part is the unit of loss. If the signal drops, only the part in flight is sent again.` },
        { name: 'Client recording id', what: `A UUID made on the device when recording starts.`, why: `Every request about this recording carries it, so "create this recording" can be sent twice and still make one row.` },
        { name: 'Consent prompt and "Stop and delete"', what: `The app asks the worker to confirm verbal consent before recording starts, and offers one button that stops and wipes the recording.`, why: `One council's published record says consent is verbal and comes first, and that if someone objects the recording is deleted and paper notes are used.` },
      ],
      numbers: [
        { text: '14.4 MB an hour of audio at 32 kbit/s; the example visit is 12.48 MB.', from: '32,000 bits a second ÷ 8 = 4 kB a second × 3,600 = 14.4 MB an hour. 52 minutes × 60 × 4 kB = 12,480 kB. The bitrate is this design\'s choice.' },
        { text: 'A 16 kHz mono WAV is 115 MB an hour, eight times larger.', from: `16,000 samples × 2 bytes = 32 kB a second × 3,600 = 115 MB. One council's published record names WAV and MP3, so the server must accept both.` },
        { text: 'A lost part costs up to 84 seconds on a weak connection.', from: '5 MiB = 41.9 megabits. At an assumed 0.5 Mbit/s uplink that is 84 seconds. The uplink speed is an assumption.' },
        { text: 'A 90-minute visit is 21.6 MB, five parts.', from: '90 × 60 × 4 kB = 21,600 kB = 20.6 MiB: four parts of 5 MiB and one of 0.6 MiB.' },
      ],
      fails: `The battery dies, the tab is closed, the phone locks and the browser stops recording, or local storage fills. A crash loses at most 10 seconds; on reopening, the app finds the slices and offers to carry on or upload what it has. A wake lock keeps the screen on while recording. If the browser cannot keep recording with the screen locked, the app says so before the visit starts, not after. The risk that remains: a lost or broken device before upload loses the recording. Nothing in software fixes that; the worker's own notes are the fallback, as they were before.`,
      alternatives: [
        {
          name: 'Record locally, upload in parts afterwards', chosen: true, good: 'Works with no signal at all.', cost: 'The audio exists only on the device until upload finishes.',
          what: 'Record to local storage in 10-second slices. When the worker stops, upload in 5 MiB parts and retry until done.',
          pros: ['No network needed during the visit.', 'A drop costs one part, not the file.', 'Nothing reaches the server until the worker stops, so a withdrawal of consent mid-meeting is a local delete.'],
          cons: ['A lost device before upload loses the recording.', 'The draft cannot start until the upload ends.'],
        },
        {
          name: 'Stream the audio to the server while recording', good: 'The server has the audio as it happens; the draft can start sooner.', cost: 'Needs a connection for the whole visit.',
          what: 'Open a WebSocket and send audio frames live, transcribing as they arrive.',
          pros: ['Nothing to lose if the device dies.', 'Live transcript possible.'],
          cons: ['Home visits often have no usable signal.', 'Battery and data use for 90 minutes.', 'Audio is on the server before the meeting ends, so a withdrawal means a server-side delete every time.'],
        },
        {
          name: 'Native app', good: 'Reliable background recording and upload.', cost: 'Two more codebases and app-store releases for a team that ships a web app daily.',
          what: 'An iOS and Android app with its own recorder and background upload service.',
          pros: ['Keeps recording with the screen locked.', 'Background upload the operating system will finish.'],
          cons: ['Councils must approve and deploy an app to managed devices.', 'Three clients to keep in step.', `One council's published record describes a web app; this would be new.`],
        },
      ],
      say: 'The device is the only copy until upload completes, so I record locally in 10-second slices, upload in parts, and never delete the local copy until the server confirms the checksum.',
      see: [{ id: 'retries-breaker', label: 'Retries and backoff' }, { id: 'idempotency-keys', label: 'Idempotency keys' }],
    },
    {
      id: 'app',
      name: 'Rails app',
      tech: 'Rails, Postgres RLS',
      x: 350, y: 300, w: 150, h: 64, kind: 'node',
      what: `The web application: sign-in, the recorder page, upload sessions, the list of a worker's recordings, and the JSON endpoints behind them. Sign-in is delegated to an identity provider with single sign-on to the council (a hosted identity service appears as a sub-processor for authentication in one council's published record; this design assumes identity federation and multi-factor authentication). For uploads the app never touches audio bytes. It creates the recording row, opens a multipart upload in object storage, hands out presigned URLs for parts, and on completion checks size and checksum, then moves the recording to uploaded and creates the transcribe job in one transaction.`,
      why: `This design assumes a typical stack for a small UK product team: Rails, PostgreSQL and background jobs. A lean team that ships several times a day is best served by one application that owns the state machine. The app is also where tenancy is enforced: every request sets the council for its database transaction before any query runs.`,
      built: [
        { name: 'Upload session endpoints', what: 'POST /recordings (create, idempotent on the client recording id), GET /recordings/:id/parts (which parts the store has), POST /recordings/:id/complete.', why: `The device can ask "where was I?" after any interruption, on any device state.` },
        { name: 'Tenant context', what: `A wrapper that runs SET LOCAL app.tenant_id at the start of every transaction, from the signed-in user's council.`, why: `PostgreSQL row-level security then hides every other council's rows even if application code forgets a WHERE.` },
        { name: 'State machine', what: `One column, recordings.state, changed only by compare-and-set updates (... WHERE state = 'uploading').`, why: 'Two requests or two jobs racing cannot both move the same recording.' },
      ],
      numbers: [
        { text: 'About 2,400 upload sessions an hour at peak, 40 a minute.', from: '40,000 recordings a week (assumption, see Numbers) ÷ 5 working days = 8,000 a day; ÷ 10 working hours = 800 an hour; × 3 for the peak (assumption) = 2,400.' },
        { text: 'About 5 small requests per upload, so about 200 a minute at peak for uploads.', from: 'create + list parts + 3 part URLs batched into one + complete, plus one resume: about 5. 40 × 5 = 200 a minute, about 3 a second. Small for one Rails app.' },
      ],
      fails: `The app is down or deploying. Recording is unaffected, because it needs no server. Uploads pause and resume: the device retries with backoff. Part uploads already under way carry on, because they go to object storage and their URLs stay valid for an hour. The guard against a double "complete" is the compare-and-set on state: the second call matches no row and returns the same answer.`,
      alternatives: [
        {
          name: 'One Rails monolith', chosen: true, good: 'One deploy, one state machine, the stack this design assumes.', cost: 'Web and job code share a codebase and a release.',
          what: 'Web requests and background jobs live in one Rails application and one PostgreSQL database. Job workers run the same code in separate processes.',
          pros: ['Enqueueing a job and changing state can share a transaction.', 'One place to enforce tenancy.', `Matches the skills of a typical Rails team.`],
          cons: ['A bad deploy affects everything.', 'Job workers must be deployed with a long drain so a release does not kill paid calls.'],
        },
        {
          name: 'Separate services for upload, pipeline and review', good: 'Independent scaling and releases.', cost: 'Network calls, three deploys and a distributed state machine for 3 requests a second.',
          what: 'An upload service, a pipeline service and a review service, each with its own store, talking over queues.',
          pros: ['Teams can release separately.', 'A pipeline fault cannot take the review screen down.'],
          cons: ['State spread across services needs sagas or outboxes.', 'Three places to get tenancy right.', 'Nothing at this size needs it.'],
        },
      ],
      say: `I'd keep it one Rails app: the team knows Rails and Postgres, the load is a few requests a second, and one database lets a state change and its next job commit together.`,
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }],
    },
    {
      id: 'kms',
      name: 'Key service',
      short: 'Keys',
      tech: 'cloud KMS, key per council',
      x: 350, y: 135, w: 190, h: 56, kind: 'shared',
      what: `The cloud's key management service holds one key per council. Object storage uses that council's key to encrypt its audio (server-side encryption with a named key). The Rails app asks the key service to unwrap a per-council data key, which it uses to encrypt the text columns that hold content: transcript lines, draft bodies and final notes. AES-256 at rest and TLS 1.3 in transit are the usual public claims; a key per council is this design's choice.`,
      why: `Three reasons. A bug or a stolen database dump exposes ciphertext, and the key for one council opens nothing of another's. Access to a key is logged by the cloud, outside our application. And when a council leaves, destroying its key makes every copy of its content unreadable, including copies in backups that cannot be edited.`,
      built: [
        { name: 'Envelope encryption', what: `Content is encrypted with a data key; the data key is stored encrypted by the council's key in the key service.`, why: 'The key service is called once per process per council (the unwrapped data key is cached in memory for 5 minutes), not once per row.' },
        { name: 'Key per council', what: 'One key in the key service for each tenant, named in tenants.kms_key_ref.', why: 'Isolation and deletion by key destruction.' },
      ],
      numbers: [
        { text: 'A few hundred keys.', from: 'Assume about 300 customer organisations. One key each. Cloud key services price per key per month at about a dollar (assumption), so a few hundred dollars a month.' },
        { text: 'At most one unwrap per council per process every 5 minutes.', from: `This design's cache time. 300 councils × 20 processes × 12 an hour = 72,000 calls an hour at the very most.` },
      ],
      fails: `The key service is unreachable. Processes with a cached data key carry on for up to 5 minutes; after that, reads and writes of content fail closed, and recordings queue on devices and in the job queue. Metadata and the state machine are not encrypted this way, so the ops view still works. The risk that remains: a key destroyed by mistake destroys a council's content for good. Destruction is scheduled with a waiting period (cloud key services offer one), needs two people, and is audited.`,
      alternatives: [
        {
          name: 'A key per council, envelope encryption', chosen: true, good: 'Isolation, an access log outside the app, and deletion by destroying a key.', cost: 'Key handling in the application and no SQL search over content.',
          what: 'One key per tenant in the cloud key service. Object storage uses it directly; the app uses it to wrap data keys for text columns.',
          pros: ['A leaked dump is ciphertext.', 'Leaving councils are erased from backups by key destruction.', 'Councils can be told exactly who used their key and when.'],
          cons: ['Content cannot be searched or indexed in SQL.', 'A lost key is lost data.', 'More moving parts in every read and write.'],
        },
        {
          name: 'One platform key (disk and bucket encryption only)', good: 'Nothing to build.', cost: 'No per-council isolation and no way to erase one council from backups.',
          what: `Rely on the database's and bucket's default encryption at rest with one provider-managed key.`,
          pros: ['Free and invisible.', 'Meets a plain reading of AES-256 at rest.'],
          cons: ['A database dump is readable by anyone who can read the database.', `Backups hold every council's content until they expire.`],
        },
        {
          name: 'Keys held by each council', good: 'The council can cut off access itself.', cost: 'Every council needs a cloud account and key operations skills.',
          what: 'Each council creates a key in its own cloud account and grants the supplier use of it.',
          pros: ['Strongest story for a cautious council.', `Revocation is in the council's hands.`],
          cons: [`Onboarding 300 councils' cloud teams.`, 'An expired grant looks like an outage.'],
        },
      ],
      say: 'One key per council: a leaked dump is ciphertext, key use is logged outside our app, and when a council leaves I destroy the key and the backups go dark with it.',
    },
    {
      id: 'store',
      name: 'Object storage',
      short: 'Object store',
      tech: 'S3 or GCS, key per council',
      x: 600, y: 125, w: 190, h: 60, kind: 'store',
      what: `Holds the audio and nothing else. One bucket per region, one prefix per council, each object encrypted with that council's key. The device uploads parts straight here through presigned URLs; the app only opens and completes the upload. The cloud is not fixed by this design, so the page says "S3 or GCS" and the first clarifying question is which. The mechanics below are S3's multipart upload; GCS's resumable upload does the same job with a session URL and byte offsets.`,
      why: `Audio is large, written once and read two or three times (transcription, playback at review, a fallback). That is what object storage is for. Sending bytes through Rails would tie up web processes for minutes on slow connections, and a host such as Heroku cuts a request off after 30 seconds.`,
      built: [
        { name: 'Multipart upload', what: 'The app opens an upload and gets an upload id; the device PUTs numbered parts of at least 5 MiB (the last may be smaller); the app completes it with the list of part numbers and ETags, and the store assembles one object.', why: 'A part number makes each PUT idempotent. Sending part 2 again replaces part 2.' },
        { name: 'Presigned URLs', what: 'A URL the app signs that allows one PUT of one part to one key for one hour.', why: `The device needs no cloud credentials, and the URL cannot be used for another council's prefix.` },
        { name: 'Lifecycle rules as a backstop', what: 'The bucket deletes any object older than 125 days and aborts unfinished multipart uploads after 7 days.', why: 'The retention job is the control; the rule catches whatever it missed. 125 and not 120, so the job and its receipts always go first.' },
        { name: 'No versioning on the audio prefix', what: 'No versioning on the audio prefix, or versions expired by the same rule.', why: 'With versioning on, a delete only adds a marker and the audio is still there.' },
      ],
      numbers: [
        { text: 'About 0.9 TB of new audio a week; about 15 TB held at any time.', from: '30,000 audio hours a week (assumption, see Numbers) × 30 MB an hour = 900 GB. 30 MB an hour is double the Opus figure, to allow for MP3 and some WAV. Held for 120 days = 17.1 weeks × 900 GB = 15.4 TB.' },
        { text: 'About $350 a month to store it.', from: '15,400 GB × an assumed $0.023 per GB-month = $354. If every file were WAV it would be 59 TB and about $1,360. Storage is not what costs money here.' },
        { text: 'The example is one object of 12.48 MB in three parts.', from: '5 MiB + 5 MiB + 1.9 MiB.' },
      ],
      fails: `A part PUT fails or stalls: the device retries that part. The device crashes between the last part and "complete": on reopening it asks the app which parts exist and completes. A completed object is the wrong size or checksum: the app refuses to move to uploaded, tells the device, and the device (which still has the file) starts a new upload. The store itself is down: uploads wait on devices. The risk that remains: an orphan. An object whose database row was never completed, or was deleted. A weekly sweep lists the prefix and compares it with live rows.`,
      alternatives: [
        {
          name: 'Multipart upload direct to object storage', chosen: true, good: 'Resumable per part, bytes never touch our servers.', cost: 'Parts are at least 5 MiB, so a drop re-sends up to 5 MiB.',
          what: 'The app signs one URL per part. The device PUTs parts straight to the bucket and reports each ETag. The app completes the upload.',
          pros: ['No audio through Rails.', 'The store handles assembly and integrity.', 'Nothing new to run.'],
          cons: ['A 5 MiB part is 84 seconds at 0.5 Mbit/s; a drop repeats it.', 'The device and app must track parts.', 'Unfinished uploads need a clean-up rule.'],
        },
        {
          name: 'tus resumable upload server', good: 'Resumes at the exact byte.', cost: 'A server to run, and audio passes through it.',
          what: 'Run tusd in front of the bucket. The device PATCHes bytes from an offset; after a drop it asks for the current offset and carries on.',
          pros: ['No minimum part: a drop loses nothing already received.', 'An open protocol with ready-made clients.'],
          cons: ['A new stateful service to run and secure.', 'Audio flows through our network.', 'Its own storage of partial uploads to clean.'],
        },
        {
          name: 'One PUT through Rails (Active Storage direct upload)', good: 'Three lines of code.', cost: 'Not resumable; one drop at 95% starts again.',
          what: 'The browser sends the whole file in one request to a signed URL.',
          pros: ['Built into Rails.', 'Fine for small files on good connections.'],
          cons: ['A 20 MB file on 0.5 Mbit/s takes over 5 minutes and must not drop once.', 'No progress to resume from.'],
        },
      ],
      say: `Parts go straight from the device to the bucket with presigned URLs. Part numbers make each PUT idempotent, so resuming is "ask which parts you have, send the rest".`,
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }],
      tables: [
        {
          title: 'Object keys',
          lang: 'text',
          code: `Bucket   notes-audio-uk          (one bucket per region)
Key      t/<tenant_id>/r/<recording_id>/audio.webm
Example  t/1111.../r/7f3a.../audio.webm   12,480,000 bytes
Encrypt  SSE with the council's key (tenants.kms_key_ref)
Rules    abort unfinished multipart uploads after 7 days
         expire objects after 125 days (backstop only)`,
          note: 'The council id is in the key, so a presigned URL or an access policy can be limited to one council\'s prefix. Not run.',
        },
      ],
      queries: [
        {
          title: 'The upload, call by call',
          lang: 'http',
          code: `POST /bucket/key?uploads              -> UploadId   (app)
PUT  /bucket/key?partNumber=1&uploadId=...          (device)
PUT  /bucket/key?partNumber=2&uploadId=...   fails, retried
PUT  /bucket/key?partNumber=3&uploadId=...
GET  /bucket/key?uploadId=...         -> parts 1,2,3 (app)
POST /bucket/key?uploadId=...         complete       (app)`,
          note: `Sketch of S3's multipart calls, not run. Each PUT returns an ETag that the complete call must list.`,
        },
      ],
    },
    {
      id: 'db',
      name: 'PostgreSQL',
      short: 'Postgres',
      tech: 'state, text, audit',
      x: 595, y: 330, w: 170, h: 130, kind: 'store',
      what: `The system's memory. One row per recording holds its state, its council, its consent flag and its delete-by date. Beside it: the parts received, one row per pipeline step (who holds it, how many attempts), every paid vendor call with its request id and cost, the transcript as numbered lines, each draft with the lines every statement cites, the worker's final note, the council's template versions, an append-only audit log, and deletion receipts. Content columns are encrypted with the council's key. Every table carries tenant_id and a row-level security policy.`,
      why: `The state of a recording must be in one place that transactions protect. The queue only says "something to do"; this says what is true. With state here, any job can be run twice, a lost job can be found by a query ("uploaded more than 15 minutes ago and not transcribed"), and a deletion can be proved by a row.`,
      built: [
        { name: 'State machine in a column', what: `uploading, uploaded, transcribing, transcribed, summarising, draft_ready, reviewed, exported, plus failed and deleted. Every move is UPDATE ... WHERE state = <the one before> AND consent = 'given'.`, why: 'A compare-and-set needs no lock service, and a withdrawn consent stops every later write.' },
        { name: 'Step table', what: 'pipeline_steps, one row per recording and step, with status, attempts and a lease (locked_until).', why: 'The row is the idempotency key for a step. A second worker that claims the same step matches no row and stops.' },
        { name: 'Row-level security', what: `A policy on each table, tenant_id = current_setting('app.tenant_id')::uuid, forced even for the table owner.`, why: `If the setting is missing the query errors; it does not return every council's rows (checked on PGlite).` },
        { name: 'Append-only audit log', what: `The application's database role has INSERT and SELECT on audit_events, and no UPDATE or DELETE.`, why: 'The log is evidence, so the application that is being audited must not be able to rewrite it.' },
      ],
      numbers: [
        { text: 'About 100 KB a recording; about 70 GB held at any time.', from: 'A 45-minute transcript is about 6,750 words, about 40 KB of text; about 400 line rows with overhead, a draft and a note of about 10 KB each, steps, calls and audit rows: call it 100 KB (assumption). 40,000 recordings a week × 17.1 weeks = 684,000 recordings × 100 KB = 68 GB.' },
        { text: 'About 3 jobs and under 20 small transactions a second at peak.', from: '40 recordings a minute × about 4 jobs = 160 jobs a minute = 2.7 a second. Each job is a claim, a save and a few inserts.' },
        { text: 'Metadata kept after deletion is under 2 KB a recording.', from: 'The recordings row, step rows, vendor call rows, audit rows and receipts, with no content. 2 million recordings a year × 2 KB = 4 GB a year.' },
      ],
      fails: `The primary fails: a managed replica is promoted; uploads to object storage carry on, completes and jobs wait and retry. A job writes a transcript and crashes before commit: nothing was written; the step is claimed again when its lease runs out. A missing tenant setting: the query raises an error. The risk that remains: a role with BYPASSRLS, or a migration run as a superuser, sees everything; such roles are for migrations and the retention job only, never for web requests.`,
      alternatives: [
        {
          name: 'Shared tables with row-level security', chosen: true, good: 'One schema to migrate; the database enforces isolation.', cost: `Every connection must set the tenant, and one council's load shares the database with the rest.`,
          what: 'All councils in one set of tables. Each transaction sets app.tenant_id; a policy on every table filters on it.',
          pros: ['One migration for 300 councils.', 'A forgotten WHERE clause leaks nothing.', 'Works with a transaction-mode connection pool because SET LOCAL ends with the transaction.'],
          cons: ['Policies must be on every table, and tested.', 'A superuser or BYPASSRLS role sees all.', 'A noisy council shares the buffer cache.'],
        },
        {
          name: 'A schema or database per council', good: 'Strong separation, easy per-council export and drop.', cost: '300 schemas to migrate on every deploy, several times a day.',
          what: 'Each council gets its own schema (or database) with the same tables.',
          pros: ['DROP SCHEMA is a clean exit.', 'A council can be moved or restored alone.'],
          cons: ['Migrations run 300 times.', 'Connection pools per schema.', 'Cross-council operations (ops view, cost) need a fan-out.'],
        },
        {
          name: 'Filter in application code only', good: 'Nothing to set up.', cost: `One missed scope leaks one council's case notes to another.`,
          what: 'Every query includes WHERE tenant_id = ? through a default scope.',
          pros: ['Simple.', 'No database features to learn.'],
          cons: ['A raw query, a join or a console session can skip it.', 'Nothing enforces it.'],
        },
      ],
      say: `Postgres holds the truth: one state column moved by compare-and-set, one row per step as its idempotency key, and row-level security so a missing WHERE clause returns nothing, not another council's notes.`,
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }, { id: 'leader-replication', label: 'Leader and replicas' }, { id: 'outbox', label: 'Transactional outbox' }],
      tables: [
        {
          title: 'recordings: one row per visit, and its state',
          lang: 'sql',
          code: `CREATE TABLE recordings (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants,
  worker_id           uuid NOT NULL,
  client_recording_id uuid NOT NULL,   -- made on the device
  state   text NOT NULL DEFAULT 'uploading' CHECK (state IN
    ('uploading','uploaded','transcribing','transcribed',
     'summarising','draft_ready','reviewed','exported',
     'failed','deleted')),
  consent text NOT NULL DEFAULT 'given'
          CHECK (consent IN ('given','withdrawn')),
  duration_s     int,
  bytes          bigint,
  sha256         text,
  object_key     text,
  upload_id      text,                 -- multipart upload id
  created_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_at    timestamptz,
  draft_ready_at timestamptz,
  delete_after   timestamptz NOT NULL,
  legal_hold_id  uuid REFERENCES legal_holds,
  deleted_at     timestamptz,
  UNIQUE (tenant_id, client_recording_id)
);`,
          note: `The UNIQUE on the device's id makes "create" safe to send twice. delete_after is set at birth and is NOT NULL: nothing exists without a date to go.`,
        },
        {
          title: 'pipeline_steps and vendor_calls',
          lang: 'sql',
          code: `CREATE TABLE pipeline_steps (
  recording_id uuid NOT NULL REFERENCES recordings,
  tenant_id    uuid NOT NULL,
  step   text NOT NULL
         CHECK (step IN ('transcribe','summarise','check')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
         ('pending','running','done','dead','cancelled')),
  attempts     int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  provider     text,
  last_error   text,            -- error class, no content
  finished_at  timestamptz,
  PRIMARY KEY (recording_id, step)
);
CREATE TABLE vendor_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL, recording_id uuid NOT NULL,
  step text NOT NULL, provider text NOT NULL,
  model text NOT NULL, request_id text,
  audio_s int, tokens_in int, tokens_out int,
  cost_micros bigint NOT NULL DEFAULT 0,
  outcome text NOT NULL,        -- ok, timeout, 5xx, filtered
  started_at timestamptz NOT NULL DEFAULT now(),
  duration_ms int
);`,
          note: `The step's primary key is its idempotency key. vendor_calls does two jobs: cost per hour of audio, and the list of vendors to chase when the recording is deleted.`,
        },
        {
          title: 'transcript lines',
          lang: 'sql',
          code: `CREATE TABLE transcript_segments (
  recording_id uuid NOT NULL
    REFERENCES transcripts ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  seq       int NOT NULL,       -- the line number cited
  speaker   smallint,           -- null when not labelled
  start_ms  int NOT NULL, end_ms int NOT NULL,
  text_enc  bytea NOT NULL,     -- encrypted, council's key
  confidence real,
  PRIMARY KEY (recording_id, seq)
);`,
        },
        {
          title: 'drafts and the final note',
          lang: 'sql',
          code: `CREATE TABLE drafts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recording_id uuid NOT NULL REFERENCES recordings,
  tenant_id    uuid NOT NULL,
  generation   int NOT NULL DEFAULT 1,  -- 2 if regenerated
  template_version_id bigint NOT NULL
    REFERENCES template_versions,
  model       text NOT NULL,
  body_enc    bytea NOT NULL,   -- statements with their lines
  statements  int NOT NULL,
  unsupported int,              -- null until checked
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, generation)
);
CREATE TABLE notes (
  recording_id uuid PRIMARY KEY REFERENCES recordings,
  tenant_id uuid NOT NULL,
  draft_id  bigint NOT NULL REFERENCES drafts,
  body_enc  bytea NOT NULL,     -- the worker's final text
  statements_kept int NOT NULL, statements_edited int NOT NULL,
  statements_removed int NOT NULL, statements_added int NOT NULL,
  signed_off_by uuid NOT NULL,
  signed_off_at timestamptz NOT NULL,
  exported_at timestamptz,
  export_method text
    CHECK (export_method IN ('copy','file','api'))
);`,
          note: 'UNIQUE (recording_id, generation) is what stops a retried job making a second draft. The draft is never edited; the note is a separate row that belongs to the worker.',
        },
        {
          title: 'row-level security, audit and receipts',
          lang: 'sql',
          code: `ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recordings
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK
    (tenant_id = current_setting('app.tenant_id')::uuid);

REVOKE UPDATE, DELETE ON audit_events FROM app_rw;

CREATE TABLE deletion_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL, recording_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('retention',
    'consent_withdrawn','tenant_exit','request')),
  target text NOT NULL CHECK (target IN ('device',
    'object_store','database','deepgram','whisper','llm')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','done','not_held','expires_at_vendor')),
  evidence jsonb NOT NULL DEFAULT '{}',
  attempts int NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  UNIQUE (recording_id, target)
);`,
          note: 'The schema file shows the policy on recordings only; the same policy goes on every table with a tenant_id. With no tenant set, a query raises an error (checked). One receipt per recording and place it was held.',
        },
      ],
      queries: [createRecording, missingParts, completeUpload, claimStep, saveDraft, sloQuery],
    },
    {
      id: 'queue',
      name: 'Job queue',
      short: 'Jobs',
      tech: 'GoodJob, in Postgres',
      x: 965, y: 313, w: 150, h: 60, kind: 'queue',
      what: `The list of work to do: "transcribe rec_7f3a", "summarise rec_7f3a". Rails teams commonly use Sidekiq or GoodJob. This design uses GoodJob, which keeps jobs as rows in PostgreSQL, so a job is created in the same transaction as the state change that calls for it. Worker processes take jobs, and a job that raises an error is retried later with a growing wait. A scheduled "sweeper" job runs every minute and re-creates the job for any step that has been pending or running past its lease.`,
      why: `The pipeline is a chain of slow, paid, external calls. They cannot run inside a web request, and they will fail. A queue gives each step its own retry, its own timeout and its own pool of workers. Keeping the queue in the same database removes the one failure a separate queue adds: the state says "uploaded" but the job was never enqueued, or the job runs before the row is committed.`,
      built: [
        { name: 'GoodJob', what: `A job backend for Rails' Active Job that stores jobs in PostgreSQL and locks them with advisory locks. It has scheduled (cron) jobs and a dashboard.`, why: 'Enqueue and state change commit together, and there is no Redis to run. At about 3 jobs a second, a database queue is far inside its limits.' },
        { name: 'Separate pools', what: 'One pool of worker processes for transcription, one for summarising, one for everything else, each with its own thread count.', why: 'A provider outage that fills the transcription pool with waiting retries cannot stop summaries or deletions.' },
        { name: 'Retry policy', what: `5 attempts with waits of about 15 seconds, 1 minute, 4 minutes, 15 minutes and 1 hour, each with random jitter, honouring a provider's Retry-After. Only timeouts, 5xx and 429 are retried; a 4xx such as "audio unreadable" is not.`, why: 'Retrying a request that can never succeed burns money and hides the fault.' },
        { name: 'Dead step', what: `After 5 attempts the step is marked dead and the recording failed. The worker sees "We could not draft this note yet; your recording is safe", and the ops view lists it.`, why: 'A parked failure a person can see beats a silent loop.' },
        { name: 'Fairness', what: 'At most 10 steps in flight per council when the queue is backed up.', why: `One council uploading a backlog on Monday morning must not delay every other council's drafts.` },
        { name: 'Sweeper', what: 'Every minute, find steps whose lease has run out or that have sat pending for 5 minutes with no job, and enqueue them again.', why: 'The queue is a hint; the step table is the truth. Any lost job is found within a minute.' },
      ],
      numbers: [
        { text: 'About 160,000 jobs a week; under 3 a second at peak.', from: '40,000 recordings × about 4 jobs (transcribe, summarise, check, notify) = 160,000. Peak 40 recordings a minute × 4 = 160 a minute = 2.7 a second.' },
        { text: 'About 60 to 120 transcriptions in flight at peak.', from: '40 a minute arriving × 1.5 to 3 minutes each (45 to 90 minutes of audio at an assumed 30 times real time) = 60 to 120. That sizes the transcription pool: 5 processes of 25 threads.' },
        { text: 'Worst-case retry span is about 80 minutes.', from: '15 s + 1 min + 4 min + 15 min + 60 min = 80 min 15 s, before jitter.' },
      ],
      fails: `A worker process is killed mid-job by a deploy: the lease runs out and the sweeper re-enqueues; the step runs again and may pay for a second vendor call. To make that rare, transcription workers drain for up to 10 minutes on shutdown. A job runs twice at once (a frozen worker wakes after its lease was taken): both reach the save, and the unique constraint lets one in. The queue table bloats under a long backlog: old finished jobs are pruned daily. The risk that remains: the queue shares the database, so a database outage stops everything at once. That is accepted; a separate queue would not help, because every step needs the database anyway.`,
      alternatives: [
        {
          name: 'GoodJob (jobs in PostgreSQL)', chosen: true, good: 'Job and state change commit together; nothing extra to run.', cost: 'Queue load lands on the main database.',
          what: `Jobs are rows. Enqueue is an INSERT in the caller's transaction. Workers lock rows and run them.`,
          pros: ['No job without its state change, and no state change without its job.', 'One less service than Sidekiq and Redis.', 'Jobs can be queried with SQL for the ops view.'],
          cons: ['Throughput is bounded by the database; fine at 3 a second, not at 3,000.', 'Long-held locks and table bloat need watching.', `Shares the database's outages.`],
        },
        {
          name: 'Sidekiq (jobs in Redis)', good: `Very fast, widely known, the common choice in Rails.`, cost: 'Enqueue is not in the database transaction.',
          what: 'Jobs are pushed to Redis after the database commit. Worker threads pop and run them.',
          pros: ['Thousands of jobs a second.', 'Mature retries and dashboard.', 'Keeps queue load off Postgres.'],
          cons: ['Commit then push can lose the job; push then commit can run it before the row exists.', 'Needs an outbox or the sweeper to be safe.', 'Redis to run and keep durable.'],
        },
        {
          name: 'A workflow engine (Temporal or a cloud step service)', good: 'Durable timers, retries and history per recording, built in.', cost: 'A new platform for a four-step chain.',
          what: 'Each recording is a workflow whose steps are activities. The engine persists progress and retries.',
          pros: ['Long waits and human steps are first class.', 'A full history per recording.'],
          cons: ['A cluster or a vendor to run and learn.', `The state machine moves out of the team's Rails code.`, 'Worth it at tens of steps, not four.'],
        },
        {
          name: 'One job that does everything', good: 'Simplest to write.', cost: 'A failure in the last step repeats the first, and pays for it again.',
          what: 'A single job transcribes, summarises and checks in sequence.',
          pros: ['One class.', 'No orchestration.'],
          cons: ['An LLM timeout re-runs a paid transcription.', 'One timeout for steps of very different lengths.', 'No per-step pools.'],
        },
      ],
      say: 'Jobs live in Postgres, so the state change and its next job commit together. The step table is the truth and the queue is a hint: a sweeper finds anything lost within a minute, and every job checks before it writes.',
      see: [{ id: 'outbox', label: 'Transactional outbox' }, { id: 'retries-breaker', label: 'Retries and circuit breakers' }, { id: 'idempotency-keys', label: 'Idempotency keys' }, { id: 'token-bucket', label: 'Token bucket' }, { id: 'saga', label: 'Sagas' }],
    },
    {
      id: 'transcriber',
      name: 'Transcription worker',
      short: 'Transcribe',
      tech: 'Rails job, breaker',
      x: 965, y: 165, w: 170, h: 140, kind: 'node',
      lines: ['Deepgram first', 'Whisper if it fails'],
      what: `A pool of job workers that turns audio into numbered lines of text. A worker claims the step, signs a short-lived URL for the audio and asks Deepgram to transcribe it with speaker labels. It waits for the answer with a timeout sized to the audio. If Deepgram is failing, a circuit breaker sends the work to Whisper: the worker downloads the audio, cuts it into 10-minute pieces at silences, transcribes the pieces in parallel and joins them with corrected timestamps. It then saves the lines, marks the step done and creates the summarise step, all in one transaction. One council's published record names Deepgram with OpenAI Whisper as the fallback; the switching here is this design's.`,
      why: `Transcription is the slowest and most expensive step, and it depends on someone else's service. The worker exists to hide that: one interface with two providers behind it, so the rest of the pipeline sees "lines of text" whichever engine produced them.`,
      built: [
        { name: 'Provider adapter', what: 'One Ruby interface, transcribe(recording) -> lines, with a Deepgram and a Whisper implementation. Each returns the same shape: sequence number, speaker (or none), start, end, text, confidence.', why: 'A third provider, or a self-hosted model, is a new class and a config change.' },
        { name: 'Circuit breaker', what: 'A counter per provider. 5 failures in 30 seconds open it for 60 seconds; then one trial call decides whether to close it. An ops switch can force it open.', why: 'When Deepgram is down, every job should not each spend its retries finding that out. Whether the breaker is tripped is shared through one row in the database, read every 5 seconds, so all processes agree.' },
        { name: 'Timeout by length', what: '60 s + audio seconds ÷ 5, capped at 30 minutes. For 52 minutes: 60 + 624 = 684 seconds. The lease is the timeout plus one minute.', why: 'A fixed timeout is either too short for 90 minutes or too long for 5.' },
        { name: 'Chunker for the fallback', what: `ffmpeg re-encodes to 16 kHz mono and cuts at the silence nearest each 10-minute mark; each piece is sent separately and its timestamps are shifted by the piece's start.`, why: `Whisper's hosted API limits file size (25 MB; unverified), a failed piece is retried alone, and pieces run in parallel.` },
        { name: 'Names list', what: 'The worker can type the names of the people present before recording; they are passed to the provider as vocabulary hints where it supports them.', why: 'Misspelt names were among the errors social workers reported (press coverage of a 2024 council trial).' },
      ],
      numbers: [
        { text: 'A 52-minute visit takes about 1 minute 45 seconds on the primary.', from: '3,120 seconds ÷ an assumed 30 times real time = 104 seconds. The speed is an assumption; measure it.' },
        { text: 'Timeout 684 seconds, lease 744 seconds for the example.', from: '60 + 3,120 ÷ 5 = 684; + 60 = 744.' },
        { text: '6 pieces on the fallback.', from: '52 minutes ÷ 10 = 5 full pieces and one of about 2 minutes.' },
        { text: 'A wasted transcription costs about 39 cents.', from: '52 ÷ 60 × an assumed $0.45 an audio hour = $0.39. That is the price of a job killed after the vendor finished.' },
      ],
      fails: `Deepgram returns errors or hangs: retry with backoff; the breaker opens; work moves to Whisper. Both are down: steps wait in pending, drafts are late, the SLO burns, and the worker sees "transcribing is delayed; your recording is safe". The audio is unreadable (a 4xx from both): the step goes dead at once and ops are told; retrying will not help. The worker process is killed mid-call: the lease runs out, the step runs again and the first call's cost is wasted. The risk that remains: the fallback is not equal to the primary. Without speaker labels the summary can attribute words to the wrong person, so the transcript row records has_speakers = false and the review screen says so.`,
      alternatives: [
        {
          name: 'Wait for the answer in the job, with a long drain on deploy', chosen: true, good: 'Simplest: one call, one result, one transaction.', cost: 'A thread is held for one to three minutes, and a killed worker wastes a paid call.',
          what: 'The job sends the request and blocks until the transcript returns or the timeout fires. Transcription workers get 10 minutes to finish on shutdown.',
          pros: ['No inbound webhook to secure.', 'The result is saved by the code that asked for it.', '120 waiting threads at peak is cheap.'],
          cons: ['Deploys several times a day can kill calls that outlast the drain.', 'Thread count caps concurrency.', 'A hung connection holds a thread until the timeout.'],
        },
        {
          name: 'Submit with a callback', good: 'Nothing in flight in our processes; deploys lose no work.', cost: 'A public webhook, lost callbacks and a second state to track.',
          what: 'The job submits the audio URL with a callback URL and ends. The provider POSTs the result to the app, which verifies a signed token and saves the transcript.',
          pros: ['Survives any deploy.', 'Concurrency limited only by the provider.', 'Fits very long audio.'],
          cons: ['A webhook endpoint that receives transcripts must be authenticated and idempotent.', 'A callback that never comes needs the sweeper to poll.', 'Two code paths for one step.'],
        },
        {
          name: 'Self-hosted Whisper on GPUs as the primary', good: 'No vendor sees the audio; cost falls with volume.', cost: `GPU capacity, queues and model upgrades become the team's job.`,
          what: 'Run an open Whisper model on our own GPU machines and send every recording there.',
          pros: ['Audio stays in our cloud account.', 'At the assumed volume the list-price vendor bill is about $58,000 a month, which a GPU fleet could undercut.'],
          cons: ['Capacity planning for a 3 times peak.', 'Speaker labels need a second model.', 'A lean product team becomes an inference team.'],
        },
      ],
      say: 'One interface, two providers. A breaker moves traffic to Whisper when Deepgram fails, the timeout scales with audio length, and the save is one transaction that also creates the next step. I say out loud that the fallback is worse: no speaker labels, and review is told.',
      see: [{ id: 'retries-breaker', label: 'Retries and circuit breakers' }, { id: 'idempotency-keys', label: 'Idempotency keys' }],
    },
    {
      id: 'deepgram',
      name: 'Deepgram',
      tech: 'speech to text',
      x: 1225, y: 120, w: 140, h: 56, kind: 'outside',
      what: `The primary speech-to-text provider, as named in one council's published transparency record. We send it a URL to fetch the audio from and options (language, speaker labels, punctuation, vocabulary hints); it returns words with timestamps, speaker numbers and confidence. One council's published record says vendors are said not to train on the data, and reports a vendor claim of 98% transcription accuracy, which the record does not verify. It also warns of poorer accuracy for strong accents.`,
      why: 'A specialist provider is faster and cheaper than running models ourselves at this size, and returns speaker labels in the same call. Buying it is the right first choice; what it costs and what it keeps are contract questions.',
      built: [
        { name: 'Pre-recorded transcription with a fetch URL', what: 'The request names a presigned URL valid for 15 minutes; the provider downloads the object itself.', why: 'The audio never passes through our worker on the main path.' },
        { name: 'Speaker labels (diarisation)', what: 'The provider tags each word with a speaker number. It does not know who the speakers are.', why: `"The daughter said" and "Mr Hughes said" are different facts in a case note.` },
      ],
      numbers: [
        { text: 'About $0.45 an audio hour (assumption).', from: 'Public list prices for hosted speech to text run at about $0.004 to $0.008 a minute, so $0.26 to $0.46 an hour. This page uses $0.45. A volume contract would be lower. Not checked against a current price list.' },
        { text: 'About $13,500 a week at the assumed volume.', from: `30,000 audio hours × $0.45. That is four fifths of the pipeline's variable cost.` },
        { text: 'A concurrency limit of about 100 requests is assumed.', from: 'Providers cap concurrent requests per account; the real figure is in the contract. Peak need is 60 to 120, so the limit must be raised or the queue will smooth it.' },
      ],
      fails: 'An outage, slow responses, a 429 for too many requests, or a wrong transcript. The first three are handled by timeouts, backoff and the breaker. A wrong transcript is not an error the pipeline can see: low average confidence is recorded and shown at review, and accuracy is measured offline on a consented sample, by accent group. The risk that remains: a fluent, confident, wrong transcript of a quiet or accented speaker.',
      alternatives: [
        {
          name: 'Deepgram primary, Whisper fallback', chosen: true, good: 'Matches the public record; two independent providers.', cost: 'Two integrations whose outputs differ.',
          what: 'Send everything to Deepgram. Fail over to Whisper on errors.',
          pros: ['An outage at one does not stop drafts.', 'Speaker labels on the main path.'],
          cons: ['Fallback output has no speaker labels (assumption).', 'Two sub-processors to contract, assess and delete from.'],
        },
        {
          name: 'One provider only', good: 'One contract, one behaviour.', cost: 'Its outage is ours.',
          what: 'Use a single speech-to-text vendor and queue during its outages.',
          pros: ['Consistent transcripts.', `One fewer sub-processor in every council's DPIA.`],
          cons: ['Drafts stop when it stops.', 'No bargaining position on price.'],
        },
        {
          name: 'Split traffic by measured accuracy', good: 'Each recording goes to the engine that is best for it.', cost: 'Needs an evaluation set by language and accent, kept current.',
          what: 'Route by language, audio quality or council to whichever provider scores best on a test set.',
          pros: ['Better accuracy where one engine is weak.', 'Both paths are always warm.'],
          cons: ['An evaluation programme to run.', 'Harder to explain to a council which engine heard their residents.'],
        },
      ],
      say: 'Deepgram is the primary because the public record says so. I treat its price and its retention as contract terms, and its accuracy as something I measure by accent group, not something I quote.',
    },
    {
      id: 'whisper',
      name: 'Whisper',
      tech: 'via Azure OpenAI',
      x: 1225, y: 210, w: 140, h: 56, kind: 'outside',
      what: `The fallback speech-to-text model, as named in one council's published record ("OpenAI Whisper as fallback"). Azure and OpenAI both appear in that record's list of sub-processors; this page assumes Whisper is called through Azure OpenAI so that it sits in the same region and contract as the LLM. It takes an audio file and returns text with segment timestamps. It is used only when the breaker on Deepgram is open, or when ops force it.`,
      why: `A fallback from a different company fails for different reasons. If the fallback shared the primary's cloud region or network path, one incident would take both.`,
      built: [
        { name: 'File upload per piece', what: 'Each 10-minute piece is sent as its own request and returns its own segments.', why: 'The hosted API limits file size (25 MB; unverified), and a failed piece is retried alone.' },
      ],
      numbers: [
        { text: 'About $0.36 an audio hour (assumption).', from: 'A list price of $0.006 a minute × 60. Not checked against a current price list.' },
        { text: '6 requests for the example, about 40 seconds each in parallel (assumption).', from: '52 minutes in 10-minute pieces. The speed is an assumption.' },
      ],
      fails: `It is down as well: steps wait and retry; the worker is told the draft is delayed. It returns text for a silent stretch that nobody said, a known weakness of this model family reported in published research (not verified here): pieces that are mostly silence are skipped using the audio's energy, and the grounding check and the worker's review are the remaining guards. Timestamps drift at piece boundaries: pieces are cut at silences, never mid-word.`,
      alternatives: [
        {
          name: 'Whisper through Azure OpenAI as a cold standby', chosen: true, good: 'Different vendor, same cloud contract as the LLM.', cost: 'Rarely exercised, so it can rot.',
          what: 'Keep the integration deployed and send it 1% of traffic all the time, so it is known to work.',
          pros: ['Independent of Deepgram.', 'The 1% keeps credentials, quotas and code proven.'],
          cons: ['No speaker labels (assumption).', 'A second transcript style for the summariser to cope with.', 'The 1% gets a worse experience unless both results are compared offline instead.'],
        },
        {
          name: 'No fallback: queue until the primary returns', good: 'Every transcript has the same quality.', cost: 'Drafts are late by the length of the outage.',
          what: 'Hold steps in pending while Deepgram is down.',
          pros: ['One behaviour.', 'No second sub-processor.'],
          cons: ['A two-hour outage on a Monday means two hours of late notes.', 'Breaks the draft-ready objective.'],
        },
      ],
      say: 'The fallback is a different company on purpose, and I send it a trickle all the time, because a standby that is never used does not work on the day.',
    },
    {
      id: 'summariser',
      name: 'Summary worker',
      short: 'Summarise',
      tech: 'Rails job, prompt store',
      x: 965, y: 436, w: 170, h: 96, kind: 'node',
      lines: ['council template', 'grounding check'],
      what: `A pool of job workers that turns a transcript into a draft note in the council's template, and then checks it. It loads the numbered transcript lines and the live version of the council's template (headings, guidance and a prompt), and asks the LLM for structured output: for each section, a list of statements, each with the transcript line numbers it rests on. It saves that as the draft. A second call, the grounding check, gives the model each statement with only its cited lines and asks whether the lines support it. Statements that fail are kept but flagged. Social work press coverage of council trials in 2024 describes a transcript, a summary and suggested actions from council-set prompts; the checks and the structure here are this design's.`,
      why: `A case note is a statutory record. The two ways a summary fails are saying something that was not said, and leaving out something that was. Social workers in a 2024 council trial reported errors of the first kind: assumptions about needs, repetition, misspelt names (social work press coverage). Asking the model to cite lines makes every sentence checkable by a machine and, more to the point, by the worker in one click.`,
      built: [
        { name: 'Template versions', what: `Each council's template is a row with numbered, immutable versions; one is live. Every draft records the version and the model that made it.`, why: `When a council asks "why did the note say that in March?", the exact prompt can be shown. Rolling back is pointing "live" at the previous version.` },
        { name: 'Structured output', what: 'The model must return JSON matching a schema: sections, statements, cited line numbers.', why: 'Citations can be validated in code (every statement cites at least one line that exists) before any second call.' },
        { name: 'Grounding check', what: 'A second LLM call that sees statements and their cited lines and marks each supported, partly supported or unsupported.', why: 'It catches invented or over-stated sentences cheaply. It does not catch omissions.' },
        { name: 'Chunk then merge, for the long tail', what: 'Above 30,000 transcript tokens (about two and a half hours of speech), split at speaker turns into 20-minute pieces, extract statements with line numbers from each, then write the note from the extracted statements.', why: 'Most visits fit a modern context window whole (a 90-minute visit is about 18,000 tokens), and one pass keeps context. Chunking is for the tail, and for multi-case meetings.' },
        { name: 'Token budget', what: 'A cap per recording (for example 200,000 tokens across all calls and retries) and per council per day.', why: 'A retry loop or a three-hour upload must not run up a bill unseen.' },
      ],
      numbers: [
        { text: 'A 52-minute visit is about 12,500 tokens of transcript.', from: '52 minutes × 150 words a minute (assumption) = 7,800 words × 1.33 tokens a word = 10,400; plus about 20% for line numbers and speaker tags = 12,500.' },
        { text: 'About 35,000 input and 2,700 output tokens per audio hour, both calls together.', from: 'Per 45-minute recording: summarise 11,000 + 2,000 of prompt = 13,000 in, 1,500 out; check 13,000 in, 500 out. Total 26,000 in, 2,000 out; × 60 ÷ 45 = 34,700 and 2,700.' },
        { text: 'About 11 cents an audio hour for the LLM (assumption).', from: '34,700 × an assumed $2.50 per million input tokens = $0.087; 2,700 × an assumed $10 per million output = $0.027. Prices are assumptions.' },
        { text: 'About 1.1 million tokens a minute at peak.', from: `40 recordings a minute × 28,000 tokens. The provider's tokens-per-minute quota must cover it.` },
      ],
      fails: `The LLM call times out or returns a 5xx: retry with backoff. The retry is paid for again, and the unique constraint on (recording, generation) stops a second draft. The output is not valid JSON or cites a line that does not exist: one repair attempt, then retry, then dead. The provider's content filter refuses the request because the transcript describes violence or self-harm, which social work conversations do: this is a permanent error for that deployment, so the step fails over to a second deployment or stops with a clear message; it must never produce a note with the hard part missing. The risk that remains: a supported-looking sentence that subtly changes meaning, and anything left out. The worker's review is the control for both.`,
      alternatives: [
        {
          name: 'One pass with cited lines, then a check pass', chosen: true, good: 'Every sentence traceable; invented statements flagged before a person reads them.', cost: 'Two LLM calls per note, and the checker can be wrong too.',
          what: 'Generate the note as statements with line numbers. Validate the citations in code. Ask the model to judge each statement against its lines.',
          pros: ['One click from a sentence to the words and audio behind it.', 'About 11 cents an audio hour for both calls.', 'A measurable number: share of statements unsupported.'],
          cons: ['A second model call can pass a wrong sentence or flag a right one.', 'Does nothing for omissions.', 'Adds about 25 seconds.'],
        },
        {
          name: 'Free-text summary, no citations', good: 'Simplest, shortest prompt, most fluent prose.', cost: 'Nothing ties a sentence to what was said.',
          what: `Ask for a note under the template's headings and save the text.`,
          pros: ['One call.', 'Reads naturally.'],
          cons: ['The worker must re-read the whole transcript to check it.', 'No machine check is possible.', 'No way to measure grounding.'],
        },
        {
          name: 'Extract quotes only (no generated prose)', good: 'Cannot invent: every line is a quote.', cost: 'Not a case note; the worker writes the analysis from scratch.',
          what: 'Select and arrange verbatim transcript lines under each heading.',
          pros: ['Nothing is paraphrased.', 'Trivially checkable.'],
          cons: ['Saves far less time.', 'Speech is messy to read.', 'Transcription errors are carried straight into the record.'],
        },
        {
          name: 'Chunk and merge always', good: 'Works for any length; chunks run in parallel.', cost: 'Loses context across chunks and adds a merge step that can itself invent.',
          what: 'Split every transcript, summarise the pieces, merge.',
          pros: ['No context limit.', 'Bounded cost per call.'],
          cons: ['A point made at minute 5 and qualified at minute 40 lands in different chunks.', 'More calls for the common case that fits whole.'],
        },
      ],
      say: 'Every statement in the draft carries the transcript lines it rests on. Code checks the citations exist, a second call checks the lines support the sentence, and anything unsupported is flagged for the worker. That catches inventions, not omissions, and I say so.',
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }, { id: 'retries-breaker', label: 'Retries and circuit breakers' }, { id: 'serialization', label: 'Serialisation' }],
    },
    {
      id: 'llm',
      name: 'LLM',
      tech: 'OpenAI model on Azure',
      x: 1225, y: 436, w: 160, h: 56, kind: 'outside',
      what: `The language model that writes the draft and runs the check. One council's published record says summaries are produced by an OpenAI model. This page assumes one OpenAI model deployed in Azure OpenAI in the same region as the data (the record says UK or EEA), with the model version pinned.`,
      why: `A hosted model in the council's region, under a contract that forbids training on the data, is the fastest way to a good draft. Pinning the version matters because a provider's silent model update changes every council's notes overnight.`,
      built: [
        { name: 'Pinned deployment', what: 'The request names a deployment tied to one model version.', why: 'A new version is a change we test and roll out, not something that happens to us.' },
        { name: 'Second deployment', what: 'Another deployment (another region inside the allowed geography, or another model) behind the same adapter and its own breaker.', why: 'Quota exhaustion and regional incidents happen; so does a content filter that one deployment applies and another, with an approved configuration, does not.' },
      ],
      numbers: [
        { text: 'About 35 seconds to write the example draft, 25 to check it (assumption).', from: '1,700 output tokens at an assumed 50 tokens a second = 34 s; the check returns about 500 tokens plus reading time.' },
        { text: 'Request timeout 120 seconds.', from: `About three times the expected time. This design's choice.` },
        { text: 'About $3,300 a week at the assumed volume.', from: '30,000 audio hours × $0.11.' },
      ],
      fails: `Slow or failed calls (timeout, backoff, breaker, second deployment). Rate limits (429): honour Retry-After and let the queue smooth the peak. A refusal by the content filter (see the Summary worker). A model retirement: the provider withdraws old versions on a published schedule, so each template is re-tested on the next version before the date. The risk that remains: the model writes fluent, plausible text that is wrong. That is what the citations, the check and the review are for.`,
      alternatives: [
        {
          name: 'Hosted OpenAI model on Azure, in region', chosen: true, good: 'Matches the public record and the residency promise.', cost: `Quotas, filters and retirements are the provider's to set.`,
          what: `Call a pinned deployment in the data's region; keep a second deployment as standby.`,
          pros: ['No model to run.', 'In-region processing.', 'Contract terms on training and retention.'],
          cons: ['Tokens-per-minute quota must be bought ahead of peaks.', 'Default content filters can refuse the very conversations social workers have.', 'Version retirements force re-testing.'],
        },
        {
          name: 'Several providers behind one adapter', good: 'Outage and price cover; best model per task.', cost: 'Each prompt must be tested on each model.',
          what: 'Route between OpenAI and Anthropic models (a team may use both) by health, cost or task.',
          pros: [`One vendor's incident is survivable.`, 'Bargaining power.'],
          cons: ['A template version becomes a template-and-model version.', 'Two sets of sub-processor terms for every council.'],
        },
        {
          name: 'Self-hosted open model', good: 'Nothing leaves our account.', cost: 'GPUs, serving and a quality gap to close.',
          what: 'Serve an open-weights model on our own GPUs.',
          pros: ['Strongest data story.', 'No per-token bill.'],
          cons: ['A serving platform to build and staff.', 'Quality on long, messy transcripts must be proven.', 'Fixed cost whatever the volume.'],
        },
      ],
      say: 'I pin the model version, keep a second deployment behind a breaker, and treat the content filter as a real failure mode here, because safeguarding conversations are exactly what a default filter refuses.',
      see: [{ id: 'retries-breaker', label: 'Retries and circuit breakers' }, { id: 'token-bucket', label: 'Token bucket' }],
    },
    {
      id: 'review',
      name: 'Review and export',
      short: 'Review',
      tech: 'Rails, editor',
      x: 400, y: 560, w: 170, h: 96, kind: 'node',
      lines: ['draft beside transcript', 'worker signs'],
      what: `The screen where the draft becomes the worker's note. It shows the draft on one side and the transcript on the other. Selecting a statement highlights the lines it cites and plays that stretch of audio. Flagged statements are marked "No support found in the transcript" and must each be kept, edited or removed before sign-off. The worker names the speakers ("Speaker 1 is Mr Hughes"), edits freely, and signs. Signing saves the note as a new row that belongs to the worker; the draft is never changed. Export then offers each section to copy, or a file. One council's published record says practitioners edit the draft and then paste it into the case system.`,
      why: `The worker was in the room; the model was not. The final record is the worker's professional judgement, and the software has to make that true in practice, not only in the terms of use. So the draft cannot leave the system unread: there is no export before sign-off, and every flagged statement needs a decision.`,
      built: [
        { name: 'Side-by-side editor with citations', what: 'Each statement links to its transcript lines and their audio.', why: 'Checking a sentence takes seconds, so checking happens.' },
        { name: 'Edit tracking', what: 'On sign-off the app records, per statement, kept, edited, removed or added, and stores the counts on the note. The draft and the note are both kept until day 120.', why: 'The counts show how much of each draft survives review, by council and template version. They are a quality signal for us and an audit trail for the council: what the machine wrote and what the worker signed are both on record.' },
        { name: 'Sign-off', what: `An explicit "This is my record of the visit" action that moves the recording to reviewed and writes an audit event.`, why: 'Authorship should be an act, not a default.' },
        { name: 'Export', what: `Copy per section (formatted for the case system's fields), or download as a file. Copying or downloading marks the note exported, with the method.`, why: `This design assumes no API to start with, and exports in CSV, PDF and MP3; paste is what councils do today.` },
      ],
      numbers: [
        { text: '23 statements in the example draft; 1 flagged, 2 edited, 1 removed.', from: 'Illustrative.' },
        { text: '9 minutes to review the example.', from: `Illustrative. One council's evaluation of a 2024 trial reported follow-up notes falling from 4 hours to 1.5 hours (social work press coverage); review time is part of what remains.` },
      ],
      fails: `The worker signs without reading. Software cannot prevent that, but it can make it visible: time from open to sign-off, and flagged statements kept without edit, are reported to the council in aggregate, never as a league table of individuals. Two tabs edit the same note: the save carries a version number and the second save is refused with the other's changes shown. The draft is for the wrong person because two visits were recorded back to back: the note header shows the date, time and length, and the worker picks the person. The risk that remains: automation bias. A fluent draft is easy to trust, and trust grows with every good one.`,
      alternatives: [
        {
          name: 'Review required, draft and note kept apart', chosen: true, good: `The record is the worker's, and the difference is auditable.`, cost: 'A step the worker cannot skip on a busy day.',
          what: 'No export until sign-off. Flagged statements need a decision. Draft immutable, note separate.',
          pros: ['Authorship is explicit.', 'Draft against final is evidence and a quality measure.', 'Unsupported statements cannot slip through unseen.'],
          cons: ['Adds minutes per note.', 'A determined user can still click through.', 'Edit data is itself personal data and must be deleted on time.'],
        },
        {
          name: 'Draft is editable in place, export any time', good: 'Fastest for the worker.', cost: 'No record of what the model wrote, and unread drafts reach the case file.',
          what: 'One document. The worker may copy it out at once.',
          pros: ['No friction.', 'Simplest data model.'],
          cons: ['Cannot show what changed.', 'Nothing stands between a hallucination and the statutory record.'],
        },
        {
          name: 'Second reviewer for flagged notes', good: 'A second pair of eyes where the risk is highest.', cost: 'Supervisor time councils do not have.',
          what: 'Notes with unsupported statements or safeguarding terms go to a senior practitioner before export.',
          pros: ['Stronger control on the riskiest notes.'],
          cons: ['Delays the record.', 'A queue for supervisors.', `A council's choice, so offer it as a setting.`],
        },
      ],
      say: `The draft is the machine's and the note is the worker's, kept as two rows. Nothing exports before sign-off, every flagged sentence needs a decision, and I measure how much of each draft survives review.`,
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }],
    },
    {
      id: 'cms',
      name: 'Case management system',
      short: 'Case system',
      tech: 'Eclipse, Liquidlogic, Mosaic',
      x: 115, y: 560, w: 200, h: 64, kind: 'outside',
      what: `The council's system of record for social care: Eclipse, Liquidlogic and Mosaic are among those in use in England. The final note lives here, under the council's own retention rules, long after the supplier's copy is gone. Today the worker pastes the note in. One council's published record is inconsistent on whether the tool "integrates" with case systems; this page assumes it does not.`,
      why: `It is where the record must end up, and it is not ours. Each council's system is configured differently, with its own forms and fields. Designing as if a clean API existed would be designing for a world the research does not show.`,
      built: [
        { name: 'Copy per section', what: 'Each template section has a copy button that puts clean text on the clipboard.', why: 'Case system forms have a box per heading.' },
        { name: 'Export adapter', what: `One interface, export(note, target), with "clipboard" and "file" implementations today and room for one per case system.`, why: 'When a supplier offers an API and a council asks for it, it is a new class, with the worker still pressing the button.' },
      ],
      numbers: [
        { text: '5 sections, so 5 pastes for the example.', from: 'The fictional template has 5 headings.' },
      ],
      fails: `The worker pastes the note into the wrong person's record. The supplier cannot see or stop that; the note's header carries the visit date, time and the worker's name to make a mismatch obvious. The worker never pastes it: the recording sits in reviewed; a reminder goes at 7 days, and at 120 days it is deleted regardless, with a warning 14 days before. The case system is down: nothing is lost, the note waits in the notes app.`,
      alternatives: [
        {
          name: 'Copy or file, the worker pastes', chosen: true, good: 'Works with every case system today.', cost: `Manual, and "exported" is the worker's click, not proof.`,
          what: 'Offer per-section copy and a file download. Mark the note exported when used.',
          pros: ['No dependency on any supplier.', 'The worker sees exactly what enters the record.'],
          cons: ['Wrong-record pastes are possible.', 'No confirmation the note arrived.', 'Minutes per note.'],
        },
        {
          name: `Write through the case system's API`, good: 'One click, into the right record, confirmed.', cost: `An integration per supplier and per council's configuration.`,
          what: `The worker picks the person from the case system inside the notes app; the note is posted to that record through the supplier's API.`,
          pros: ['No paste errors.', `A real exported state with the record's id.`, 'Could pre-fill names for the transcriber.'],
          cons: ['Depends on each supplier offering and licensing an API (not verified).', 'Field mapping per council.', 'The notes app would hold case identifiers, which widens what it stores.'],
        },
        {
          name: 'Browser extension that fills the form', good: 'No supplier API needed.', cost: 'Breaks when the supplier changes a page; councils must allow an extension.',
          what: 'An extension reads the note from the notes app and types it into the open case system form.',
          pros: ['Works without the supplier.'],
          cons: ['Fragile.', 'Hard to get onto managed devices.', 'Security review of an extension that can read case pages.'],
        },
      ],
      say: `Today it is paste, and I'd design for that honestly: per-section copy behind an export interface, so an API integration is a new adapter when a supplier and a council are ready, not a rewrite.`,
    },
    {
      id: 'retention',
      name: 'Retention worker',
      short: 'Retention',
      tech: 'scheduled Rails job',
      x: 965, y: 585, w: 170, h: 96, kind: 'node',
      lines: ['120 days at most', 'writes receipts'],
      what: `The job that deletes. Every hour it selects recordings whose delete-by date has passed and that are not under a legal hold, in batches of 500. For each it deletes the audio object, deletes the content rows (transcript lines, drafts, note, parts), blanks the object key on the recording row, marks it deleted, and writes one receipt per place the content was held: object store, database, and each vendor that received it. A consent withdrawal runs the same code at once, for one recording. When a council leaves, it runs for the whole council and then schedules the council's key for destruction. One council's published record says its supplier keeps data for up to 120 days and then deletes it; the council's own case system holds the lasting record.`,
      why: `Deleting on time is a promise in every council's data protection assessment. A promise needs a mechanism that is hard to forget and easy to prove. The mechanism is a date on every row from birth, a job that works from that date, a backstop in the bucket, and a receipt for each delete.`,
      built: [
        { name: 'Delete-by date at birth', what: `delete_after = created_at + the council's retention_days, NOT NULL, with a CHECK that retention_days is 1 to 120.`, why: 'No code path can create a recording without an end date, and no council can be configured past the contractual limit.' },
        { name: 'Idempotent deletes', what: 'Deleting an object that is gone succeeds; deleting rows that are gone deletes nothing; receipts are unique per recording and target.', why: 'The job can crash anywhere and run again.' },
        { name: 'Receipts', what: `A row per recording and target with a status of done, not held, or expires at vendor, and evidence such as counts, the vendor's request id and dates. No content.`, why: `"Prove it" is a query.` },
        { name: 'Legal hold', what: `A council's information governance lead can place a hold on recordings with a reason; the job skips held rows; placing and releasing are audited.`, why: 'A complaint, an inquiry or a court case can require that evidence is kept.' },
        { name: 'Verification sweep', what: 'Weekly, list the bucket prefix and compare with live rows; count rows past their date by more than 24 hours. Both should be zero.', why: 'A deletion job that silently stops looks exactly like one with nothing to do.' },
      ],
      numbers: [
        { text: 'About 8,000 recordings to delete a working day, steady state.', from: 'What comes in goes out 120 days later: 40,000 a week ÷ 5.' },
        { text: '16 batches of 500 a day; minutes of work.', from: '8,000 ÷ 500.' },
        { text: `Backups expire after 35 days (this design's choice), so content is gone from every copy by day 155 at the latest.`, from: '120 + 35. This must be stated in the contract; see the pushes.' },
      ],
      fails: `A delete in object storage fails: the receipt stays pending, the row is not marked deleted, and the next run retries. A vendor delete call fails: its receipt stays pending and is retried daily; an alert fires if any receipt is pending for more than 7 days. The job stops running: an alert on "rows overdue by 24 hours > 0", and the bucket's 125-day rule removes the audio anyway. A restore from backup brings deleted content back: the restore runbook ends by re-running the retention job, which deletes again from the delete-by dates. The risk that remains: copies outside the system, such as a transcript a worker pasted into an email. The system cannot delete those; the council's policy has to cover them.`,
      alternatives: [
        {
          name: 'Delete-by date on the row, hourly job, receipts, bucket rule as backstop', chosen: true, good: 'Provable, per-council, handles holds and withdrawals with one code path.', cost: 'A job to run and watch.',
          what: 'The date is data. A job acts on it and records what it did. The bucket rule catches misses.',
          pros: ['One mechanism for retention, withdrawal and exit.', 'Receipts answer an auditor.', 'Holds and shorter council periods are a column.'],
          cons: ['A job that can fail silently unless measured.', 'Vendor deletion depends on each vendor.'],
        },
        {
          name: 'Bucket lifecycle rule and table partitions dropped by date', good: 'Nothing to run; the platform deletes.', cost: 'No holds, no per-council periods, no receipts, and nothing for vendors.',
          what: 'Expire objects at 120 days by rule; partition content tables by month and drop old partitions.',
          pros: ['Cannot be forgotten.', 'Dropping a partition is instant.'],
          cons: ['A month partition holds days 90 to 120 together, so drops are late or early.', 'A legal hold cannot exempt one row from a dropped partition.', 'No evidence per recording.'],
        },
        {
          name: 'Delete content at export, keep nothing', good: 'The least data held.', cost: 'No transcript to check a disputed note against, and no reprocessing.',
          what: 'As soon as the worker exports, delete audio, transcript and draft.',
          pros: ['Smallest exposure.', 'Simple story.'],
          cons: ['A complaint a month later has no evidence.', 'A worker cannot reopen the transcript.', 'Offer it as a council setting: retention_days can be as low as 1.'],
        },
      ],
      say: 'Every recording is born with a delete-by date the schema will not let exceed 120 days. One job handles retention, withdrawn consent and a council leaving, and writes a receipt per place the data was held, vendors included.',
      see: [{ id: 'idempotency-keys', label: 'Idempotency keys' }, { id: 'saga', label: 'Sagas' }],
    },
    {
      id: 'ops',
      name: 'Ops view and alerts',
      short: 'Ops view',
      tech: 'dashboard, pager',
      x: 575, y: 608, w: 140, h: 56, kind: 'shared',
      what: `What the team on call looks at. One page shows, across all councils and with no content: recordings in each state, the oldest in each state, steps that are dead with their error class, the breaker state for each provider, draft-ready time over the last hour against the objective, cost per audio hour today, and deletion receipts pending or overdue. From it an engineer can re-drive a dead step, force a provider's breaker open or closed, and pause a council. Alerts go to a pager for the few things that need a person now.`,
      why: `The pipeline's failures are quiet. A stuck recording looks like nothing happening. A worker waiting for a note about a child protection visit should not be the monitoring system. And the people operating the service must be able to do that without reading case material.`,
      built: [
        { name: 'Metadata-only role', what: `The ops view connects with a database role that can read states, timings, counts and error classes, and cannot read the encrypted content columns' key.`, why: `Operating the service does not require seeing anyone's transcript.` },
        { name: 'Break-glass access', what: `Reading a specific recording's content to investigate a fault needs a named reason and the council's permission, lasts an hour, and writes an audit event the council can see.`, why: 'Support sometimes needs it; it must be rare and visible.' },
        { name: 'Re-drive', what: 'A button that resets a dead step to pending with its attempts cleared.', why: 'After a fix, recovery is one action per fault class, not a script.' },
      ],
      numbers: [
        { text: 'Page when 95% of drafts in the last 30 minutes took over 10 minutes, or any recording has waited over 30 minutes.', from: `This design's objective (see SLOs).` },
        { text: `Cost alarm when today's cost per audio hour passes $0.75.`, from: 'One third above the $0.56 expected. A retry storm or a prompt that doubled in size shows here first.' },
      ],
      fails: 'The dashboard is down: alerts are computed by a separate scheduled job, so paging does not depend on the page. Alerts are noisy: only four conditions page; the rest are a daily report. The risk that remains: a quality fault that no metric sees, such as a prompt change that makes notes subtly worse. Grounding rate and edit rate by template version are the nearest signals, and both lag.',
      alternatives: [
        {
          name: 'A small internal page over SQL, plus four pages', chosen: true, good: `Shows exactly this pipeline's states; cheap to build in Rails.`, cost: 'The team maintains it.',
          what: 'A Rails admin page reading the step and recording tables with the metadata role, and a scheduled job that evaluates alert rules.',
          pros: ['Built on the tables that are the truth.', 'Re-drive and breaker switches beside the numbers.', 'No content exposure.'],
          cons: ['Another screen to maintain.', 'Not a general metrics system.'],
        },
        {
          name: `The job library's dashboard only`, good: 'Free.', cost: 'Shows jobs, not recordings, and may show job arguments.',
          what: `Use GoodJob's or Sidekiq's built-in web view.`,
          pros: ['Nothing to build.'],
          cons: ['A recording stuck with no job at all does not appear.', 'No SLO, no cost, no deletion view.'],
        },
        {
          name: 'A metrics and tracing platform', good: 'Rich graphs, traces per recording, mature alerting.', cost: 'Another sub-processor unless self-hosted, and care needed that no content leaks into logs.',
          what: 'Emit metrics and traces to a hosted observability product.',
          pros: ['Good for latency and error analysis.', 'On-call tooling built in.'],
          cons: ['Log lines and traces must be scrubbed of personal data.', 'Does not replace the state queries.'],
        },
      ],
      say: 'The ops view reads the step table, not the queue, shows no content, and pages on four things: drafts late, a recording stuck, both providers down, and deletions overdue.',
      see: [{ id: 'retries-breaker', label: 'Retries and circuit breakers' }],
      queries: [stuckSteps, costQuery],
    },
  ],

  flows: [
    {
      id: 'api', from: 'device', to: 'app', d: 'M175,300 H275', label: 'upload session, review', at: 'above',
      travels: 'Create recording, list parts, complete upload; later the review screen\'s reads and saves. Never audio.',
      mode: 'external', via: 'HTTPS', chip: 0.5,
      reply: {
        id: 'api-reply', label: 'part URLs, then the draft',
        how: 'The app answers with the recording id, presigned URLs for the parts still missing and, later, the draft and transcript for review.',
        delivery: 'A lost reply is asked for again; every request is safe to repeat.',
      },
      how: `JSON over HTTPS with the worker's session. Every request names the device's client recording id.`,
      delivery: 'No promise: the connection can drop at any point. Every call is idempotent (create is keyed by the client recording id; complete is a compare-and-set), so the device repeats until it gets an answer.',
      alts: ['A WebSocket for live progress.', 'Background sync through a service worker.'],
      ways: [
        { name: 'Idempotent HTTPS requests, repeated until answered', chosen: true, what: `Plain requests the device retries with backoff. The server's answer to a repeat is the same as to the first.`, pros: ['Works across drops, reloads and app restarts.', 'Nothing to keep open.'], cons: ['Progress is polled.', 'Every endpoint must be written to be repeated.'] },
        { name: 'WebSocket session', what: 'One long connection for control messages and progress.', pros: [`Live progress and push of "draft ready".`], cons: ['Drops with the signal, so the idempotent requests are needed anyway.'] },
      ],
      examples: [
        {
          title: 'Request', lang: 'http',
          code: `POST /recordings
Idempotency-Key: c0a1...e7   (the client recording id)
{ "client_recording_id": "c0a1...e7",
  "duration_s": 3120, "bytes": 12480000,
  "sha256": "9f2c...", "mime": "audio/webm;codecs=opus",
  "consent": { "given": true, "at": "2026-11-17T14:04:40Z" },
  "template": "care-act-assessment" }`,
          note: 'Sent when the worker stops recording. Sending it twice returns the same recording.',
        },
        {
          title: 'Response', lang: 'json',
          code: `{ "id": "7f3a...", "state": "uploading",
  "part_size": 5242880,
  "parts": [ { "n": 1, "url": "https://...partNumber=1..." },
             { "n": 2, "url": "https://...partNumber=2..." },
             { "n": 3, "url": "https://...partNumber=3..." } ],
  "delete_after": "2027-03-17T14:57:00Z" }`,
          note: 'URLs are valid for one hour and for one part each. Sketch, not run.',
        },
      ],
    },
    {
      id: 'parts', from: 'device', to: 'store', d: 'M100,252 V50 H640 V95', label: 'audio parts', at: 'below',
      travels: 'The audio, 5 MiB at a time, each part with a checksum header.',
      mode: 'external', via: 'HTTPS PUT', chip: 0.71,
      how: 'The device PUTs each part to its presigned URL and keeps the ETag from the response. Up to two parts at once on a good connection, one at a time on a poor one.',
      delivery: 'No promise. A part either returns an ETag or is sent again. Sending part 2 twice leaves one part 2.',
      alts: ['tus: resume at the byte.', 'One PUT of the whole file.', 'Through the Rails app.'],
      ways: [
        { name: 'Presigned multipart PUTs', chosen: true, what: 'One URL per part, straight to the bucket.', pros: ['Resumable per part.', 'No audio through our servers.'], cons: ['A drop re-sends up to 5 MiB.'] },
        { name: 'tus', what: 'PATCH bytes from an offset to a tus server.', pros: ['Resumes at the byte.'], cons: ['A server to run; audio passes through it.'] },
        { name: 'Single PUT', what: 'The whole file in one request.', pros: ['Trivial.'], cons: ['One drop starts again.'] },
      ],
    },
    {
      id: 'mpu', from: 'app', to: 'store', d: 'M425,285 H470 V125 H505', label: 'open and complete upload', at: 'right',
      travels: 'Create multipart upload; list parts; complete with part numbers and ETags; sign part URLs (signing is local and needs no call).',
      mode: 'call', via: 'S3 API', chip: 0.45,
      how: `Three calls per recording from the app: create, list (on resume and before complete), complete. After complete the app reads the object's size and checksum.`,
      delivery: 'Each call is retried on failure. Complete is safe to repeat: a second complete for a finished upload is treated as success after checking the object exists.',
      alts: [`Let the device call the store's multipart API with temporary credentials.`],
    },
    {
      id: 'key', from: 'app', to: 'kms', d: 'M350,268 V163', label: 'data key', at: 'left',
      travels: 'A request to unwrap the council\'s data key; the reply is the key, held in memory for 5 minutes.',
      mode: 'call', via: 'KMS API', chip: 0.5,
      how: `The app and the job workers call the key service when they first touch a council's content, and cache the result.`,
      delivery: 'Retried; on failure content reads and writes fail closed.',
      alts: ['One platform key and no call.', 'A key service call per row (too slow, too costly).'],
    },
    {
      id: 'sql', from: 'app', to: 'db', d: 'M425,315 H510', label: 'recording, state, next step', at: 'below',
      travels: 'The recording row, part records, the move to uploaded, the first step and its job, and later the note and audit events from review.',
      mode: 'write', via: 'SQL', chip: 0.5,
      reply: {
        id: 'sql-read', label: 'missing parts, draft, transcript', mode: 'call',
        how: 'Reads for resume and for the review screen.',
        delivery: `Plain reads inside the tenant's transaction.`,
      },
      how: 'Every transaction starts with SET LOCAL app.tenant_id. State moves are compare-and-set updates.',
      delivery: 'Durable on commit. Each statement is written to be repeated (ON CONFLICT, WHERE state = ...).',
      alts: ['A separate upload service with its own store.'],
      examples: [createRecording, missingParts, completeUpload],
    },
    {
      id: 'enq', from: 'db', to: 'queue', d: 'M680,313 H890', label: 'same transaction', at: 'above',
      travels: 'The job row for the step just created.',
      mode: 'local', via: 'in the database',
      how: `The queue's tables are in the same PostgreSQL database, so the job INSERT is part of the transaction that changed the state.`,
      delivery: 'Both commit or neither does. This is the reason for a database-backed queue.',
      alts: ['Sidekiq: push to Redis after commit, with the sweeper as the safety net.', 'An outbox table relayed to an external queue.'],
      ways: [
        { name: 'Job row in the same transaction', chosen: true, what: 'INSERT the job with the state change.', pros: ['No lost or early jobs.'], cons: ['Queue load on the main database.'] },
        { name: 'Outbox then relay', what: 'Write an outbox row in the transaction; a relay publishes to Redis or a broker.', pros: ['Works with any queue.'], cons: ['A relay to run; a little more delay.'] },
        { name: 'Push after commit', what: 'Commit, then push to Redis.', pros: ['Simple.'], cons: ['A crash between the two loses the job; only the sweeper finds it.'] },
      ],
    },
    {
      id: 'job-stt', from: 'queue', to: 'transcriber', d: 'M965,283 V235', label: 'transcribe job', at: 'below',
      travels: 'The recording id and council id. No content.',
      mode: 'async', via: 'GoodJob', chip: 0.5,
      how: 'A transcription worker locks the job row, sets the tenant, and claims the step.',
      delivery: 'At least once. A job can run twice (a killed or frozen worker); the claim on pipeline_steps lets one run proceed, and the save is guarded.',
      alts: ['Sidekiq.', `A workflow engine's activity task.`],
      examples: [claimStep],
    },
    {
      id: 'job-sum', from: 'queue', to: 'summariser', d: 'M965,343 V388', label: 'summarise job', at: 'below',
      travels: 'The recording id and council id.',
      mode: 'async', via: 'GoodJob', chip: 0.5,
      how: 'As above, on the summary pool. The check runs as a second step claimed by the same pool.',
      delivery: 'At least once; one draft per (recording, generation) whatever happens.',
      alts: ['Run summarise in the transcribe job (rejected: a failure repeats a paid transcription).'],
    },
    {
      id: 'stt', from: 'transcriber', to: 'deepgram', d: 'M1050,120 H1155', label: 'audio URL', at: 'above',
      travels: 'A presigned URL to the audio valid for 15 minutes, language, speaker labels on, vocabulary hints. Deepgram fetches the audio from the store itself.',
      mode: 'external', via: 'HTTPS', chip: 0.5,
      reply: {
        id: 'stt-reply', label: 'words, speakers, times',
        how: 'The transcript as words with start, end, speaker number and confidence.',
        delivery: 'If the reply is lost, the call is made and paid for again.',
      },
      how: `One request per recording; the worker waits with a timeout of 60 seconds plus a fifth of the audio's length.`,
      delivery: `No promise. Timeouts, 5xx and 429 are retried with backoff and counted by the breaker; a 4xx is not retried. The vendor's request id is stored in vendor_calls for cost and for deletion.`,
      alts: ['Submit with a callback URL.', 'Upload the bytes instead of a URL.', 'Stream the audio live.'],
      ways: [
        { name: 'Wait for the response', chosen: true, what: 'Block the job thread until the transcript returns.', pros: ['One code path.', 'No webhook.'], cons: ['Holds a thread for minutes.', 'A killed worker wastes the call.'] },
        { name: 'Callback', what: 'Submit, end the job, receive the result by webhook.', pros: ['Deploy-proof.'], cons: ['Webhook security; lost callbacks need polling.'] },
      ],
      examples: [
        {
          title: 'Request (sketch)', lang: 'http',
          code: `POST /v1/listen?diarize=true&punctuate=true&language=en-GB
Authorization: Token ...
{ "url": "https://notes-audio-uk.../audio.webm?X-Sig=..." }`,
          note: `A sketch from memory of the provider's pre-recorded API, not run and not checked against its documentation.`,
        },
      ],
    },
    {
      id: 'stt-fb', from: 'transcriber', to: 'whisper', d: 'M1050,210 H1155', label: '10-minute pieces', at: 'above',
      travels: 'The audio itself, in six pieces for the example, as file uploads.',
      mode: 'external', via: 'HTTPS', chip: 0.5, cold: true,
      reply: {
        id: 'stt-fb-reply', label: 'text and times, no speakers',
        how: 'Segments with timestamps relative to each piece.',
        delivery: 'A failed piece is retried alone.',
      },
      how: 'Used only when the Deepgram breaker is open or ops force it, and for a 1% trickle to keep it proven.',
      delivery: `No promise; retried per piece. Each piece's request id is stored.`,
      alts: ['A second Deepgram region.', 'Self-hosted Whisper.'],
    },
    {
      id: 'audio-read', from: 'transcriber', to: 'store', d: 'M880,120 H695', label: 'read audio to split', at: 'above',
      travels: `The whole audio object, down to the worker's local disk, for ffmpeg.`,
      mode: 'call', via: 'S3 API', chip: 0.5, cold: true,
      how: 'Only the fallback needs the bytes in our process. The temporary file is deleted when the job ends, whatever the outcome.',
      delivery: 'A read; retried.',
      alts: ['Give Whisper a URL (its hosted API takes file uploads; unverified).'],
    },
    {
      id: 'tx-save', from: 'transcriber', to: 'db', d: 'M880,190 H650 V265', label: 'lines, done, next step', at: 'above',
      travels: 'The transcript row, its numbered lines (encrypted), the vendor call record, the step marked done, the recording moved to transcribed, the summarise step and its job.',
      mode: 'write', via: 'SQL', chip: 0.35,
      how: `One transaction. Its first statement is the guarded move WHERE state = 'transcribing' AND consent = 'given'; if that matches no row, the job writes nothing and ends.`,
      delivery: `All or nothing. Run twice, the second run's guard matches no row.`,
      alts: ['Write the transcript to object storage and keep only a pointer.'],
      ways: [
        { name: 'Lines as rows in PostgreSQL', chosen: true, what: 'One row per transcript line, text encrypted.', pros: ['Citations are (recording, line number).', 'Deleted with the same job as everything else.'], cons: ['About 40 KB a recording in the database.'] },
        { name: 'Transcript as a JSON object in the bucket', what: 'Store one file; keep its key in the database.', pros: ['Keeps the database small.'], cons: ['A second place to delete from and to secure.', 'Citations need the file loaded.'] },
      ],
    },
    {
      id: 'llm-call', from: 'summariser', to: 'llm', d: 'M1050,436 H1145', label: 'prompt and transcript', at: 'above',
      travels: `The template version's prompt, the numbered transcript lines, and a JSON schema for the answer. For the check: the statements and their cited lines.`,
      mode: 'external', via: 'HTTPS', chip: 0.5,
      reply: {
        id: 'llm-reply', label: 'statements with line numbers',
        how: 'JSON: sections, statements, cited lines. For the check: a verdict per statement.',
        delivery: 'A lost or late reply means the call is made, and paid for, again.',
      },
      how: 'Two calls per recording, each with a 120-second timeout. Token counts and the request id go to vendor_calls.',
      delivery: 'No promise. Retried with backoff on timeouts, 5xx and 429. A content-filter refusal is not retried on the same deployment.',
      alts: ['Stream the answer token by token.', 'A batch API at a discount, answering within hours.', 'One call per template section.'],
      ways: [
        { name: 'Two plain calls with structured output', chosen: true, what: 'One request for the note, one for the check; wait for each.', pros: ['Simple.', 'Output validated against a schema.'], cons: ['Nothing shown to the worker until both finish.'] },
        { name: 'Batch API', what: 'Submit jobs in bulk for a lower price and a reply within hours.', pros: ['Cheaper per token (assumption).'], cons: ['Breaks the ten-minute objective.'] },
        { name: 'One call per section, in parallel', what: 'Each heading is its own request over the same transcript.', pros: ['Faster wall-clock; a failed section retries alone.'], cons: ['Five times the input tokens unless the provider discounts cached input.', 'Sections can contradict each other.'] },
      ],
      examples: [
        {
          title: `The answer's shape`, lang: 'json',
          code: `{ "sections": [
  { "heading": "Views of the person",
    "statements": [
      { "id": "s14",
        "text": "Mr Hughes agreed to a move into
                 residential care.",
        "lines": [212, 213] },
      { "id": "s15",
        "text": "He said he manages the stairs once a day.",
        "lines": [98] } ] } ] }`,
          note: 's14 is the statement the check flags in step 11. Lines 212 and 213 are a suggestion from his daughter and his refusal. (The text is wrapped here for width; JSON strings do not contain line breaks.)',
        },
      ],
    },
    {
      id: 'sum-save', from: 'summariser', to: 'db', d: 'M880,436 H655 V395', label: 'draft, check result', at: 'below',
      travels: 'The draft (encrypted), statement counts, the vendor call records, the check\'s verdicts, the move to draft_ready.',
      mode: 'write', via: 'SQL', chip: 0.4,
      reply: {
        id: 'sum-read', label: 'transcript lines, template v7', mode: 'call',
        how: 'The job reads the lines and the live template version before calling the model.',
        delivery: 'A read.',
      },
      how: 'INSERT ... ON CONFLICT (recording_id, generation) DO NOTHING, and the state moves only if the insert happened.',
      delivery: 'One draft per generation however many times the job runs.',
      alts: ['Overwrite the draft on each run (rejected: a late duplicate could replace the draft a worker is already reading).'],
      examples: [saveDraft],
    },
    {
      id: 'to-review', from: 'app', to: 'review', d: 'M370,332 V512', label: 'review screen', at: 'right',
      travels: `The worker's requests for the review screen, routed inside the Rails app.`,
      mode: 'local', via: 'in-process',
      how: 'Review is a part of the same application; drawn as its own box because it is its own stage. Its database reads and writes travel on the SQL line.',
      delivery: 'A method call.',
      alts: ['A separate front-end application calling an API.'],
    },
    {
      id: 'export', from: 'review', to: 'cms', d: 'M315,560 H215', label: `the worker's note`, at: 'above',
      travels: `The signed note, section by section, through the worker's clipboard or as a downloaded file.`,
      mode: 'external', via: 'copy or file', chip: 0.5,
      how: `The worker presses copy for each section and pastes it into the case system's form. The notes app records that the copy happened, the method and the time.`,
      delivery: `None that software can give. "Exported" means the worker copied it, not that the case system has it.`,
      alts: [`The supplier's API.`, 'A browser extension.', 'Email the file (rejected: an uncontrolled copy).'],
      ways: [
        { name: 'Copy per section', chosen: true, what: 'Clipboard, one heading at a time.', pros: ['Works everywhere today.'], cons: ['Manual; wrong-record risk; no confirmation.'] },
        { name: 'File download', what: 'A document attached to the case.', pros: ['One action.'], cons: ['Not searchable as fields; a file left in Downloads.'] },
        { name: 'Supplier API', what: `Post the note to the person's record.`, pros: ['Right record, confirmed.'], cons: ['Per supplier and per council; not available as far as the research shows.'] },
      ],
    },
    {
      id: 'ret-db', from: 'retention', to: 'db', d: 'M880,550 H600 V395', label: 'due rows out, receipts in', at: 'below',
      travels: 'Deletes of content rows, the tombstone update on the recording, and deletion receipts.',
      mode: 'write', via: 'SQL', chip: 0.4,
      reply: {
        id: 'ret-due', label: '500 recordings due', mode: 'call',
        how: 'The batch select, skipping locked rows and holds.',
        delivery: 'A read with row locks.',
      },
      how: 'Runs hourly with a role allowed to work across councils; each recording is one transaction.',
      delivery: 'Idempotent. A crash mid-batch leaves some done and some not; the next run picks up the rest.',
      alts: ['Drop partitions by date.', 'Delete inline when the worker exports.'],
      examples: [
        {
          title: 'Pick what is due', lang: 'sql',
          code: `SELECT id, tenant_id, object_key
FROM recordings
WHERE delete_after <= now() AND deleted_at IS NULL
  AND legal_hold_id IS NULL
ORDER BY delete_after
LIMIT 500
FOR UPDATE SKIP LOCKED;`,
          note: 'A held recording is not selected (checked). SKIP LOCKED lets two runs work side by side.',
        },
        {
          title: 'Delete the content, keep the proof', lang: 'sql',
          code: `BEGIN;
DELETE FROM notes       WHERE recording_id = $1;
DELETE FROM drafts      WHERE recording_id = $1;
DELETE FROM transcripts WHERE recording_id = $1; -- lines cascade
DELETE FROM upload_parts WHERE recording_id = $1;
UPDATE recordings
SET state = 'deleted', deleted_at = now(),
    object_key = NULL, sha256 = NULL, upload_id = NULL
WHERE id = $1 AND deleted_at IS NULL;
INSERT INTO deletion_receipts
  (tenant_id, recording_id, reason, target, status,
   evidence, done_at)
VALUES ($2, $1, 'retention', 'database', 'done',
  '{"segments":412,"drafts":1,"notes":1}', now())
ON CONFLICT (recording_id, target) DO NOTHING;
INSERT INTO deletion_receipts
  (tenant_id, recording_id, reason, target)
SELECT DISTINCT tenant_id, recording_id, 'retention', provider
FROM vendor_calls WHERE recording_id = $1
ON CONFLICT (recording_id, target) DO NOTHING;
COMMIT;`,
          note: 'The last statement opens one pending receipt per vendor that ever received this recording. The audio object is deleted before this transaction, so a row is never marked deleted while its audio exists.',
        },
        {
          title: 'Withdraw consent', lang: 'sql',
          code: `WITH w AS (
  UPDATE recordings
  SET consent = 'withdrawn', delete_after = now()
  WHERE id = $1 AND consent = 'given'
  RETURNING id)
UPDATE pipeline_steps s SET status = 'cancelled'
FROM w
WHERE s.recording_id = w.id
  AND s.status IN ('pending','running')
RETURNING s.step;`,
          note: 'After this, a transcription that was already running finds its guarded save matches no row (checked).',
        },
        {
          title: 'Proof for one council, last 30 days', lang: 'sql',
          code: `SELECT r.id, r.deleted_at,
  count(*) FILTER (WHERE d.status = 'pending')
    AS still_pending,
  jsonb_object_agg(d.target, d.status) AS targets
FROM recordings r
JOIN deletion_receipts d ON d.recording_id = r.id
WHERE r.tenant_id = $1
  AND r.deleted_at >= now() - interval '30 days'
GROUP BY r.id, r.deleted_at;`,
          note: 'One line per deleted recording: where it was held and the state of each delete.',
        },
      ],
    },
    {
      id: 'ret-store', from: 'retention', to: 'store', d: 'M1050,585 H1331 V30 H660 V95', label: 'delete audio', at: 'below',
      travels: `A delete for the recording's object key, and an abort for any unfinished upload.`,
      mode: 'write', via: 'S3 API', chip: 0.68, cold: true,
      how: 'Delete the object, then confirm with a HEAD that it is gone, then write the object-store receipt.',
      delivery: 'Deleting a missing object succeeds, so the call is safe to repeat.',
      alts: [`Rely on the bucket's lifecycle rule alone.`],
    },
    {
      id: 'ret-vendor', from: 'retention', to: 'deepgram', d: 'M1050,565 H1318 V120 H1295', label: 'vendor deletion', at: 'left',
      travels: `For each vendor call recorded for this recording: the vendor's request id, in a delete request where the vendor offers one. The line is drawn to Deepgram and stands for every sub-processor that received content (Deepgram, Whisper, the LLM).`,
      mode: 'external', via: 'HTTPS', chip: 0.45, cold: true,
      how: `Three outcomes per vendor, each recorded on a receipt. "Not held": the contract says the vendor keeps nothing after responding. "Done": the vendor's delete endpoint confirmed. "Expires at vendor": the vendor keeps request data for a fixed period and the receipt records the date it lapses.`,
      delivery: 'Retried daily while pending. An alert fires at 7 days.',
      alts: ['Trust the contract and record nothing per recording.'],
      ways: [
        { name: 'A receipt per vendor per recording', chosen: true, what: 'Use vendor_calls to know who received what, and record how each copy ended.', pros: [`An exact answer to "where did this person's data go?"`], cons: [`Depends on what each vendor offers; some receipts will only ever say when the vendor's own copy lapses.`] },
        { name: 'Contract only', what: 'Rely on zero-retention terms.', pros: ['Nothing to build.'], cons: ['No per-recording evidence; nothing notices if the term changes.'] },
      ],
    },
    {
      id: 'ret-key', from: 'retention', to: 'kms', d: 'M1050,605 H1344 V14 H330 V107', label: 'schedule key destruction', at: 'below',
      travels: `A request to schedule the leaving council's key for destruction after a waiting period.`,
      mode: 'call', via: 'KMS API', chip: 0.72, cold: true,
      how: 'Only when a council leaves, after export and after the per-recording deletes. Needs two approvers.',
      delivery: `A scheduled destruction can be cancelled during the waiting period; after it, no copy of that council's content can be read, in backups or anywhere else.`,
      alts: ['Keep the key and rely on row deletes and backup expiry.'],
    },
    {
      id: 'ops-db', from: 'ops', to: 'db', d: 'M530,580 V395', label: 'states, ages, costs', at: 'left',
      travels: 'Counts by state, the oldest item per state, dead steps, cost per audio hour, receipts pending. No content.',
      mode: 'call', via: 'SQL', chip: 0.5, cold: true,
      how: 'Read-only queries with the metadata role, every 30 seconds; re-drive and breaker switches are small writes.',
      delivery: 'Reads.',
      alts: ['Scrape metrics into a monitoring product.'],
      examples: [stuckSteps, costQuery, sloQuery],
    },
  ],

  tour: [
    {
      title: 'Consent, then record with no signal',
      text: 'Tuesday 17 November 2026, 14:05. Priya asks Mr Hughes and his daughter whether she may record, confirms it in the app and presses record. The browser saves a slice of audio to the device every 10 seconds. The house has one bar of signal; nothing here needs it.',
      focus: ['device'],
      path: [],
      labels: ['recording, 10-second slices'],
      story: {
        context: `A Care Act assessment at home, 52 minutes long. One council's published transparency record describes the practice this page copies: verbal consent first, recording on a council-issued device through the web app.`,
        problem: 'The conversation happens once. Signal on home visits is poor, the visit is long, and the people in the room can say no at any point.',
        consequence: `If recording needs a connection, it fails in exactly the homes where it is needed. If the audio lives only in the page's memory, a closed tab loses the visit.`,
        fix: `Record locally, in 10-second slices written to the device's storage, and upload afterwards. Ask the worker to confirm consent before the microphone opens, and keep a "Stop and delete" button on screen. What can still go wrong: until upload, the device holds the only copy. A lost phone loses the recording, and Priya falls back on her own notes, as she would have before.`,
      },
      explain: [
        { q: 'Before drawing anything, what would you ask?', a: 'Who records, and on what device? How long are visits? Is there signal? How is consent given and withdrawn? Which languages? How soon must the draft be ready? Does each council have its own template? Must the worker review before the note leaves? Then propose defaults: council devices, up to 90 minutes, offline-capable, verbal consent, English first, draft within 10 minutes, a template per council, review required.' },
        { q: 'Why not stream the audio live?', a: 'It would start the transcript sooner, but it needs a connection for the whole visit and puts audio on the server before the meeting ends. Recording locally works everywhere, and if consent is withdrawn mid-meeting nothing has left the device.' },
        { q: 'Why 10-second slices?', a: 'It bounds the loss from a crash or flat battery to 10 seconds. Shorter slices mean more writes for little gain.' },
      ],
    },
    {
      title: 'A row, a delete-by date and three part URLs',
      text: '14:57. Priya stops. The device has 12.48 MB and asks the app to create the recording, using an id it made itself. The app writes a row in state uploading with a delete-by date of 17 March 2027, opens a multipart upload in the bucket and returns three presigned URLs.',
      focus: ['device', 'app', 'db', 'store'],
      path: ['api', 'sql', 'mpu', 'api-reply'],
      labels: ['create, client id c0a1', 'uploading, delete by 17 March', 'open multipart upload', '3 part URLs'],
      story: {
        context: 'The recording exists only on the device. The first request to the server may be sent, lost and sent again.',
        problem: 'Creating the recording must be safe to repeat, the audio must not flow through the web servers, and nothing should exist on the server without a date on which it will be deleted.',
        consequence: 'A repeated create would make two recordings and two notes for one visit. Audio through Rails would hold web processes for minutes on a weak connection. Data without a delete-by date is the data that gets forgotten.',
        fix: `The device's own id is the idempotency key: the table has UNIQUE (tenant, client id) and the insert returns the existing row on a repeat. The row is born with delete_after = now + 120 days, NOT NULL, and the council's period has a CHECK of at most 120. The app signs one URL per 5 MiB part so the device can talk to the bucket directly. What can still go wrong: an upload opened and never finished. The bucket aborts those after 7 days.`,
      },
      explain: [
        { q: 'Why does the device make the id?', a: `So the request can be retried without the server's reply. If the server made the id, a lost reply would leave the device not knowing whether a recording exists.` },
        { q: 'Where is the tenant enforced?', a: `The app sets the council for the database transaction from the signed-in user, and row-level security filters every table on it. The object key and the presigned URLs carry the council's prefix.` },
        { q: 'What is a presigned URL?', a: 'A URL the app signs with its own credentials that allows one specific request, here one PUT of one part, for an hour. The device needs no cloud credentials.' },
      ],
    },
    {
      title: 'Part 1 goes straight to the bucket',
      text: '14:58. The device PUTs the first 5 MiB to its URL. The bucket answers with an ETag, a fingerprint of the part, and the device notes it. One of three parts is safe.',
      focus: ['device', 'store'],
      path: ['parts'],
      labels: ['part 1 of 3, 5 MiB'],
      story: {
        context: 'Priya is walking back to her car. The upload runs in the background on a weak connection.',
        problem: 'A 12 MB file on about half a megabit a second takes over three minutes. The connection will not hold that long.',
        consequence: 'With a single request, a drop at 95% starts again from zero, and on a bad day never finishes.',
        fix: 'Multipart upload: numbered parts, each acknowledged with an ETag. A part number makes the PUT idempotent, since sending part 1 again just replaces part 1. The local slices stay on the device until the whole upload is confirmed. What can still go wrong: parts are at least 5 MiB, so a drop mid-part costs up to 84 seconds of re-sending at this speed. A tus server would resume at the byte, at the price of running one.',
      },
      explain: [
        { q: 'Why 5 MiB?', a: 'It is the smallest part S3 accepts, except the last. Smaller parts would lose less per drop but are not allowed; larger parts lose more.' },
        { q: 'Why not send parts through the Rails app?', a: 'Web processes would be tied up for minutes each. Direct to the bucket, the app handles a few small requests per recording.' },
        { q: 'Is the audio encrypted?', a: `In transit by TLS. At rest by the bucket, with the council's own key. The per-council key is this design's choice.` },
      ],
    },
    {
      title: 'The signal drops mid-upload',
      text: '14:58:40. In the stairwell the connection dies with part 2 at 60%. The PUT fails. The device still has every slice. It waits, tries again after 2 seconds, then 4, then 8, up to once a minute, and shows Priya "Saved on this device. Will upload when there is signal."',
      focus: ['device', 'store'],
      path: ['parts'],
      labels: ['part 2, lost at 60%'],
      failed: ['parts'],
      story: {
        context: 'Part 1 is in the bucket. Part 2 was three fifths sent. Part 3 has not started.',
        problem: 'The device cannot tell a dead connection from a slow one, and the worker is not watching the screen.',
        consequence: 'An upload that gives up quietly leaves a visit on a phone until someone notices there is no note. An upload that hammers a dead connection drains the battery.',
        fix: 'Retry the failed part with exponential backoff and jitter, capped at a minute, for as long as it takes. Keep the state on the device: which parts have ETags. Tell the worker plainly that the recording is safe locally. The server row stays in uploading. What can still go wrong: the phone is switched off for the weekend. The ops view shows recordings in uploading for over 24 hours, by council, and the app nags when next opened.',
      },
      explain: [
        { q: 'What happened to the 60% of part 2 that arrived?', a: 'The bucket discards an incomplete part. Only whole, acknowledged parts count.' },
        { q: 'Why backoff and jitter?', a: 'Backoff stops a dead connection being hammered. Jitter stops many devices that lost signal together (a mobile mast, the office Wi-Fi) from all retrying at the same instant.' },
        { q: 'Does the tab have to stay open?', a: 'In a web app, largely yes. A service worker can help on some browsers. This is the strongest argument for a native app, and the page says so.' },
      ],
    },
    {
      title: 'Ask, resume, complete',
      text: '15:06. Signal returns in the car. The device asks the app which parts it has: part 1. It sends parts 2 and 3, then calls complete. The app checks the assembled object is 12,480,000 bytes with the right checksum, moves the row to uploaded and creates the transcribe step and its job, in one transaction, at 15:07:10.',
      focus: ['device', 'app', 'store', 'db', 'queue'],
      path: ['api', 'api-reply', 'parts', 'api', 'mpu', 'sql', 'enq'],
      labels: ['which parts do you have?', 'missing: 2 and 3', 'parts 2 and 3', 'complete', 'assemble, check size and checksum', 'uploaded + transcribe step', 'job'],
      story: {
        context: 'Eight minutes have passed. The page may have been reloaded; the device may hold stale ideas about what was sent.',
        problem: 'After any interruption the two sides must agree on what exists, and "upload finished" must lead to exactly one transcription.',
        consequence: 'Guessing re-sends parts already stored or, worse, skips one. Completing twice could start two pipelines. Marking the row uploaded without creating the job leaves a recording that nobody will ever process.',
        fix: `The server is asked, never assumed: it lists the parts the bucket holds. Complete is a compare-and-set (WHERE state = 'uploading'), so a second complete changes nothing. The state change, the step row and the job row commit together, because the queue lives in the same database. Only now does the device delete its local slices. What can still go wrong: the object's checksum does not match. The app refuses, and the device, which still has the file, starts again.`,
      },
      explain: [
        { q: 'What would break with Sidekiq here?', a: `Sidekiq's jobs live in Redis. Commit then push can lose the job in a crash between the two; push then commit can run the job before the row exists. You fix it with an outbox or a sweeper. With jobs in Postgres the problem does not arise.` },
        { q: 'Why check the checksum?', a: 'The device computed a SHA-256 while recording. Comparing it with the stored object proves the server has exactly what the device had before the device deletes its copy.' },
        { q: 'What does the worker see?', a: '"Uploaded. Your draft will be ready in a few minutes." And a notification when it is.' },
      ],
    },
    {
      title: 'A worker claims the job; Deepgram is down',
      text: '15:07:12. A transcription worker takes the job and claims the step: attempt 1, lease 744 seconds. It signs a URL for the audio and calls Deepgram. Deepgram answers 503. So do the calls from every other job in the pool.',
      focus: ['queue', 'transcriber', 'db', 'deepgram'],
      path: ['job-stt', 'tx-save', 'stt'],
      labels: ['transcribe rec_7f3a', 'claim: attempt 1, lease 744 s', 'audio URL: 503'],
      failed: ['stt'],
      story: {
        context: `The audio is safe and the job is running. The slowest, dearest step depends on another company's service, and that service is having an incident.`,
        problem: 'Failures here are normal. They come as errors, as hangs and as rate limits, and each needs a different response. Every retry of a call that did complete costs money.',
        consequence: 'Without a timeout, a hung call holds a thread for ever. Without backoff, retries pile onto a struggling provider. If every job discovers the outage separately, each wastes its own attempts and drafts are an hour late.',
        fix: `The claim gives the step a lease, so only one worker runs it and a dead worker's step is taken over. The call has a timeout sized to the audio (60 s + length ÷ 5 = 684 s). Timeouts, 5xx and 429 are retried with backoff; a 4xx is not. A circuit breaker counts failures across the pool: 5 in 30 seconds and it opens. What can still go wrong: a slow provider that never quite fails. The breaker also counts calls that pass their expected duration.`,
      },
      explain: [
        { q: 'What is the lease for?', a: `It is the step's lock with an expiry. If the worker dies, nobody has to release anything: after 744 seconds another worker may claim the step.` },
        { q: 'Why is the job keyed by recording and step?', a: 'The queue delivers at least once. The primary key (recording, step) means a second copy of the job finds the step taken or done and stops.' },
        { q: 'Why not retry a 4xx?', a: '"Audio unreadable" will be unreadable next time. The step goes straight to dead, the worker is told, and ops see it.' },
      ],
    },
    {
      title: 'The breaker opens and Whisper takes over',
      text: '15:07:45. Five failures in 30 seconds: the breaker opens. The worker downloads the audio, cuts it into 6 pieces at silences and sends them to Whisper in parallel. At 15:09:30 it saves 412 numbered lines, marked "no speaker labels", moves the recording to transcribed and creates the summarise step, in one transaction.',
      focus: ['transcriber', 'store', 'whisper', 'db', 'queue'],
      path: ['audio-read', 'stt-fb', 'stt-fb-reply', 'tx-save', 'enq'],
      labels: ['read 12.48 MB', '6 pieces of 10 minutes', 'text and times, no speakers', '412 lines, transcribed', 'summarise job'],
      recovery: true,
      hide: ['ret-store', 'ret-vendor', 'ret-key', 'ops-db'],
      story: {
        context: `The primary is out. One council's published record names OpenAI Whisper as the fallback; the mechanics of switching here are this design's.`,
        problem: 'The fallback is a different product: it takes file uploads with a size limit, and this page assumes it returns no speaker labels.',
        consequence: 'Without a fallback, a two-hour outage is two hours of late notes on every visit. With a careless one, the pipeline quietly produces worse drafts and nobody downstream knows why.',
        fix: `The adapter hides the difference in shape, not in quality. Pieces of 10 minutes keep within the limit, retry alone and run in parallel; timestamps are shifted by each piece's start. The transcript row records the provider and has_speakers = false, and that follows the recording to the prompt and to the review screen. After 60 seconds the breaker lets one call try Deepgram again. What can still go wrong: a fallback used twice a year will not work when needed, so 1% of traffic goes to it every day.`,
      },
      explain: [
        { q: 'What is a circuit breaker?', a: 'A switch in front of a dependency. After enough failures it "opens" and calls fail at once or go elsewhere. After a wait it lets one trial call through; success closes it.' },
        { q: 'Why not also re-transcribe with Deepgram later?', a: 'You could, when the breaker closes and before the worker has reviewed. It costs a second transcription (about 39 cents here) and changes the draft under the worker. This design does not; it tells the worker which engine was used.' },
        { q: 'Why is the save one transaction?', a: 'Lines, "step done", the new state and the next job either all exist or none do. A crash before commit leaves the step to be claimed again.' },
      ],
    },
    {
      title: `The council's template becomes the prompt`,
      text: `15:09:31. A summary worker claims the step. It loads the 412 lines and version 7 of Northshire's "Care Act assessment" template: five headings, guidance for each, and the prompt. It sends about 14,500 tokens to the model and asks for JSON: under each heading, statements, each with the line numbers it rests on.`,
      focus: ['queue', 'summariser', 'db', 'llm'],
      path: ['job-sum', 'sum-read', 'llm-call'],
      labels: ['summarise rec_7f3a', '412 lines + template v7', '14,500 tokens in'],
      story: {
        context: 'There is a transcript. Each council wants its own form filled in: press coverage of a 2024 trial describes drafts made from council-set prompts.',
        problem: 'A prompt is code that changes behaviour for every note, and councils will ask months later why a note said what it said. The model can also write things nobody said.',
        consequence: 'An edited-in-place prompt cannot be rolled back or explained. A free-text summary cannot be checked except by reading the whole transcript again, which removes the time saved.',
        fix: 'Templates have immutable numbered versions; one is live; each draft records the version and the pinned model. The output is structured: every statement must cite transcript lines, and code rejects a statement that cites none or cites a line that does not exist. Because this transcript has no speaker labels, the prompt is told so and asked not to attribute speech. What can still go wrong: a citation proves a statement points somewhere, not that it is right. That is the next check.',
      },
      explain: [
        { q: 'Does a 52-minute transcript fit in the context window?', a: 'Easily: about 12,500 tokens. A 90-minute visit is about 18,000. Chunking is for the tail (over about two and a half hours) and multi-case meetings, which a 2024 council trial found the tool struggled with (press coverage).' },
        { q: 'How does a new prompt version go live?', a: `Run it on a test set of consented or synthetic transcripts with reference notes; compare grounding and omissions with the live version; give it to 5% of that council's recordings; promote or roll back. Rolling back is moving the "live" pointer.` },
        { q: 'What about cost?', a: 'The model is the small part: about 11 cents an audio hour against about 45 for transcription (both assumptions). A per-recording token cap stops a loop or a three-hour file running away.' },
      ],
    },
    {
      title: 'The model does not answer in time',
      text: `15:11:31. Two minutes have passed and no answer has come. The worker's 120-second timeout fires and the job raises an error. The step goes back to pending, to be tried again in about 15 seconds. The provider may have finished the answer anyway; if so it is paid for and never seen.`,
      focus: ['summariser', 'llm', 'db'],
      path: ['llm-call'],
      labels: ['no answer in 120 s'],
      failed: ['llm-call'],
      story: {
        context: 'The prompt was sent at 15:09:31. A normal answer takes about 35 seconds.',
        problem: 'A timeout tells you nothing about what happened at the other end. The model may be overloaded, the connection may have stalled, or the answer may have been complete and lost on the way back.',
        consequence: `Waiting for ever blocks a thread and a worker's afternoon. Retrying at once adds load to a struggling service. And if the first attempt is in fact still alive somewhere, two answers will try to become two drafts.`,
        fix: 'A timeout about three times the expected duration, then a retry with backoff and jitter, at most 5 attempts. Each attempt, including this failed one, is a row in vendor_calls, so the wasted cost is visible. A per-recording token cap bounds the damage. What can still go wrong: repeated timeouts on one deployment. A breaker moves summaries to a second deployment, as for transcription.',
      },
      explain: [
        { q: 'Why not stream the response and never time out?', a: 'Streaming helps you notice a stall sooner (no tokens for 20 seconds) but you still need a deadline, and the job still needs to be safe to run twice.' },
        { q: 'Can you ask the provider not to charge for it?', a: 'No. A request that reached the model is billed whether or not you read the answer. That is why retries show up in cost per audio hour.' },
        { q: 'What if the refusal is a content filter, not a timeout?', a: 'That is permanent for that deployment. Do not retry it; fail over to a deployment with an approved filter setting, or stop and tell the worker the draft could not be made. Never save a note with the difficult part missing.' },
      ],
    },
    {
      title: 'The retry saves exactly one draft',
      text: `15:11:46. Attempt 2 sends the same prompt and gets 23 statements back at 15:12:20. The save is an insert with a unique key on (recording, generation 1). It succeeds. Had the first attempt's worker still been alive and tried to save as well, its insert would have done nothing and it would have stopped.`,
      focus: ['summariser', 'llm', 'db'],
      path: ['llm-call', 'llm-reply', 'sum-save'],
      labels: ['attempt 2', '23 statements, cited', 'draft 1 saved once'],
      story: {
        context: 'The queue delivers a job at least once. A worker frozen past its lease, or killed by a deploy after the model answered and before the commit, means the same step can run twice, sometimes at the same moment.',
        problem: 'The model is not deterministic. Two runs give two different drafts.',
        consequence: 'Two drafts for one visit: the worker reviews one while the other overwrites it, or the list shows the visit twice. In a statutory record, "which one did the worker sign?" must have one answer.',
        fix: 'The database decides, not the workers. INSERT ... ON CONFLICT (recording_id, generation) DO NOTHING, and the move to the next state happens only if the insert did. The first to commit wins; the other writes nothing. A deliberate "regenerate" by the worker is generation 2, a new row, and the first is kept. What can still go wrong: nothing here stops the cost of the duplicate call. Only a longer drain and sensible leases reduce that.',
      },
      explain: [
        { q: 'Why not check "does a draft exist?" before inserting?', a: 'Two workers can both check, both see none, and both insert. Only a unique constraint closes that gap.' },
        { q: 'Is this the same idea as an idempotency key in payments?', a: 'Yes. The key is (recording, step, generation), the stored result is the draft row, and a repeat returns to the same outcome.' },
        { q: 'Why keep generation 1 if the worker regenerates?', a: 'The audit trail is "what the machine wrote, what the worker signed". Overwriting loses the first half.' },
      ],
    },
    {
      title: 'The check flags a sentence nobody said',
      text: `15:12:21. The check step sends each statement with its cited lines back to the model. 22 are supported. Statement 14 says "Mr Hughes agreed to a move into residential care" and cites lines 212 and 213: "We've talked about whether a care home might be the answer" and "I'm not going anywhere." Verdict: unsupported. The draft is ready at 15:12:45 with one flag, 5 minutes 35 seconds after the upload completed.`,
      focus: ['summariser', 'llm', 'db'],
      path: ['llm-call', 'llm-reply', 'sum-save'],
      labels: ['23 statements + their lines', '22 supported, 1 not', 'draft ready, 1 flagged'],
      failed: ['llm-call'],
      story: {
        context: `The draft reads well. One sentence turns a daughter's suggestion and a father's refusal into his agreement. With no speaker labels, the model had less to go on.`,
        problem: 'Fluent, wrong text is the characteristic failure of a language model, and this text is headed for a statutory record about where a man will live. Social workers in a 2024 council trial reported exactly this kind of error: assumptions about needs (press coverage).',
        consequence: 'If the sentence reaches the case file, a later decision may rest on consent that was never given.',
        fix: 'A second call sees only statements and their cited lines and marks each supported, partly supported or unsupported. Flagged statements stay in the draft, marked, and cannot be exported until the worker decides on each. What can still go wrong: the checker is a model too, so it misses some and wrongly flags others. And it cannot see what is missing: a disclosure the summary left out cites no lines and raises no flag. The check is this design\'s.',
      },
      explain: [
        { q: 'Why flag and not delete?', a: `The check can be wrong, and the worker was there. Removing text silently hides the system's doubt from the person best placed to resolve it.` },
        { q: 'How do you catch omissions?', a: 'Not with grounding. Offline, compare notes with human-marked key facts on a test set. Online, the review screen lists transcript passages no statement cites, longest first, so the worker can scan what was left out.' },
        { q: 'What do you measure?', a: 'Share of statements unsupported, by template version and model, and how often workers remove a flagged statement against how often they keep it. If workers keep most flagged statements, the checker is too strict.' },
      ],
    },
    {
      title: 'Priya reviews, edits and signs',
      text: '16:20, back at the office. Priya opens the draft beside the transcript. A banner says the backup engine was used and speakers are not labelled. She clicks the flagged sentence, hears lines 212 and 213, and removes it. She corrects "Hughs" to "Hughes" twice, adds a line of her own, and presses "This is my record of the visit" at 16:29.',
      focus: ['device', 'app', 'review', 'db'],
      path: ['api', 'to-review', 'sql'],
      labels: ['open draft', 'review', 'signed: 2 edited, 1 removed, 1 added'],
      story: {
        context: `The draft is draft_ready. One council's published record says practitioners edit the draft before it goes anywhere.`,
        problem: `The note must be the worker's professional record, and a good-looking draft invites a quick click.`,
        consequence: 'If drafts can be exported unread, the review exists on paper only, and the machine has become the author of the case file.',
        fix: 'No export before sign-off. Each flagged statement needs a decision. A click on any statement shows and plays its source, so checking is quick. Signing writes a separate note row owned by the worker, with counts of statements kept, edited, removed and added, and an audit event; the draft is never changed. What can still go wrong: automation bias. People trust fluent text, more so after many good drafts. The council sees, in aggregate, review times and how flagged statements are handled, and decides what its practice standard is.',
      },
      explain: [
        { q: 'Why keep both the draft and the note?', a: 'Evidence and learning. A dispute can be answered with what the model wrote and what the worker changed. The counts show which templates and model versions need the most correction.' },
        { q: 'Are edits used to train a model?', a: `Not in this design. One council's published record says vendors are said not to train on the data. Edit counts are used as a quality signal; edit text is content and is deleted at day 120 with the rest.` },
        { q: 'Who names the speakers?', a: 'The worker, at review. The transcriber only knows "speaker 1" and "speaker 2", and here not even that.' },
      ],
    },
    {
      title: 'Into the case record',
      text: `16:33. Priya copies the five sections one by one into Mr Hughes's record in Eclipse. The notes app marks the recording exported, by copy, and writes an audit event. The note now lives in the council's system, under the council's retention rules.`,
      focus: ['review', 'cms', 'db', 'app'],
      path: ['export', 'to-review', 'sql'],
      labels: ['5 sections, pasted by Priya', 'exported', 'exported by copy, 16:33'],
      story: {
        context: `The signed note is in the notes app. The system of record is the council's case management system.`,
        problem: `There is no dependable way in. One council's published record describes paste, and this design assumes no API to start with. Each council configures its case system differently.`,
        consequence: 'Building for an API that is not there would delay everything. Ignoring export leaves the note stranded in a system that will delete it in 120 days.',
        fix: `Per-section copy formatted for the case system's boxes, and a file download, behind one export interface. "Exported" records the worker's action and method. An adapter per supplier can be added when a supplier and a council are ready, with the worker still pressing the button. What can still go wrong: a paste into the wrong person's record, which the notes app cannot see. The note's header carries the visit's date, time and length to make a mismatch obvious. And "exported" is a claim, not proof.`,
      },
      explain: [
        { q: 'Would you build the integration?', a: 'Not first. I would ask which case systems cover most users and whether their suppliers offer write APIs, then build one adapter with one council as a pilot. Until then, make paste as quick and safe as it can be.' },
        { q: 'What is in the audit log?', a: `Who did what to which recording and when: consent recorded, uploaded, viewed, edited, signed, exported, deleted. Ids and counts, never content. The application's database role cannot update or delete it.` },
        { q: 'What if the worker never exports?', a: 'A reminder at 7 days, a warning 14 days before deletion, and deletion at day 120 regardless.' },
      ],
    },
    {
      title: 'Day 120: only the receipt is left',
      text: '17 March 2027. The retention worker finds rec_7f3a past its delete-by date and not on hold. It deletes the audio object, the transcript, the draft and the note, marks the row deleted, and writes receipts: object store done, database done, vendors recorded. The note lives on in Eclipse. Follow the second story for how this works and how it is proved.',
      focus: ['retention', 'db', 'store'],
      path: ['ret-due', 'ret-store', 'ret-db'],
      labels: ['rec_7f3a is due', 'delete audio', 'content rows out, receipts in'],
      recovery: true,
      hide: ['stt-fb', 'audio-read', 'ret-vendor', 'ret-key', 'ops-db'],
      story: {
        context: `The recording did its job four months ago. One council's published record says its supplier keeps data for up to 120 days and then deletes it.`,
        problem: `Audio and transcripts of people's most private conversations are a liability every day they exist, and "we delete after 120 days" is a claim an auditor will test.`,
        consequence: 'A system that keeps things by default will have years of recordings in a bucket the day it is breached.',
        fix: 'The delete-by date was set at birth in step 2. An hourly job deletes what is due, in the order audio, then rows, and writes a receipt for each place the content was held. A bucket rule at 125 days is the backstop. What is kept is metadata with no content: ids, timings, costs, audit events, receipts. What can still go wrong: vendor copies, backups and legal holds, which the second story follows.',
      },
      explain: [
        { q: 'Why delete the audio before the rows?', a: 'If the job crashes in between, the row still points at the object and the next run finishes the work. The other order could leave audio with no row pointing at it.' },
        { q: 'What stays after deletion?', a: 'That a recording existed, when, how long, what it cost, who did what, and proof of deletion. Under 2 KB, no words spoken.' },
        { q: 'Could the council choose less than 120 days?', a: 'Yes: retention_days is per council, between 1 and 120.' },
      ],
    },
  ],

  stories: [
    {
      id: 'deletion',
      name: `A council's data is deleted`,
      tour: [
        {
          title: 'Every recording is born with a date to go',
          text: `When a device creates a recording, the app sets delete_after to now plus the council's retention period. Northshire's is 120 days, the most the schema allows. The column is NOT NULL. From its first second on the server, the recording has an end date.`,
          focus: ['app', 'db'],
          path: ['sql'],
          labels: ['delete_after = created + 120 days'],
          story: {
            context: `One council's published record says its supplier keeps data up to 120 days. This design also assumes an exit plan with a GDPR deletion plan.`,
            problem: 'Retention added later, as a clean-up script, always has gaps: tables it does not know about, rows with no date, councils with special terms.',
            consequence: 'The gap is found by an auditor or after a breach, and the data that should not have existed is the data that leaks.',
            fix: `Make the date part of the data. NOT NULL on delete_after; a CHECK that a council's period is 1 to 120 days; one job that acts on the date. A council can choose less, never more. What can still go wrong: content stored somewhere the job does not know about. So content lives in exactly three places (the bucket, four content tables, vendors), and adding a fourth means adding a receipt target, which is a schema change someone must review.`,
          },
          explain: [
            { q: 'Why not a global constant of 120 days in code?', a: 'Councils differ, contracts change, and a date on the row survives a code change. The legal maximum is enforced where it cannot be bypassed: a CHECK constraint.' },
            { q: 'Who decides the period?', a: `The council, as the organisation responsible for the data, within the supplier's maximum. This page assumes the council is the data controller and the supplier its processor.` },
          ],
        },
        {
          title: 'Consent is withdrawn mid-meeting',
          text: 'Wednesday, 10:40. Twenty-five minutes into another visit, Ms Okafor says she would rather not be recorded. Priya taps "Stop and delete". The device wipes its slices. Nothing had been uploaded. The app records one audit event: recording discarded at the person\'s request, no content. Priya takes notes on paper.',
          focus: ['device', 'app', 'db'],
          path: ['api', 'sql'],
          labels: ['discarded, consent withdrawn', 'audit event, no content'],
          story: {
            context: `One council's published record says that if someone objects, the recording is deleted and paper notes are used.`,
            problem: 'Consent can be withdrawn at any moment, by someone who may be frightened or unwell, and it must be honoured at once without the worker needing signal or a help desk.',
            consequence: 'If withdrawal needs a server, it fails in the same homes where upload fails. If it is slow or awkward, workers will promise to "delete it later".',
            fix: `Because recording is local and upload starts only after stop, a withdrawal during the meeting is a local delete, done in a second, offline. The server is told when there is signal, and keeps only the fact. What can still go wrong: deleted slices on a phone's storage are not forensically erased; device encryption, which this page assumes councils enforce on their devices, is the control for that.`,
          },
          explain: [
            { q: 'Why record that it happened at all?', a: 'So the council can show consent is being respected, and so a missing note for a visit has an explanation. The event holds no words and no audio.' },
            { q: 'Is this a reason to prefer local recording over streaming?', a: 'Yes. With live streaming the audio is already on the server and at a vendor when the person changes their mind.' },
          ],
        },
        {
          title: 'Withdrawn after upload, with a job in flight',
          text: `A different case: the person rings the office an hour after a visit and withdraws. That recording is in transcribing, and a worker is waiting on the provider. The app sets consent = 'withdrawn', delete_after = now, and cancels its steps. Ninety seconds later the transcript arrives; the worker's guarded save matches no row, so it writes nothing and discards the text.`,
          focus: ['app', 'db', 'transcriber'],
          path: ['sql', 'tx-save'],
          labels: ['consent withdrawn, steps cancelled', 'save refused: 0 rows'],
          failed: ['tx-save'],
          story: {
            context: `Jobs run for minutes and cannot be interrupted mid-call. The withdrawal and the job's save race each other.`,
            problem: 'A delete that runs while a job is in flight can be undone by that job writing its result a moment later.',
            consequence: 'The person was told their recording was deleted, and a transcript of it appears in the database afterwards, with a draft to follow.',
            fix: `Every write in the pipeline begins with UPDATE recordings ... WHERE state = <expected> AND consent = 'given'. After withdrawal that matches no row, so the job stops before writing content. The retention worker then deletes the audio at once and opens a vendor receipt for the call that did happen. What can still go wrong: the vendor did receive and process the audio. That cannot be undone, only deleted there and recorded; the next steps cover it.`,
          },
          explain: [
            { q: 'Why not just kill the job?', a: 'Killing a thread mid-call is unreliable, and the provider would finish anyway. A guard at the write is certain.' },
            { q: 'What if the note had already been pasted into the case system?', a: `Then the council's record holds it, and what happens to that is the council's decision under its own rules. The supplier's copy is deleted and the council is told.` },
          ],
        },
        {
          title: 'The hourly job picks what is due',
          text: 'Every hour the retention worker selects up to 500 recordings whose delete-by date has passed, that are not deleted and not on hold, oldest first, locking the rows it takes and skipping rows another run has locked. Today Northshire has 212 due.',
          focus: ['retention', 'db'],
          path: ['ret-due'],
          labels: ['212 due for Northshire'],
          recovery: true,
          hide: ['stt-fb', 'audio-read', 'ret-vendor', 'ret-key', 'ops-db'],
          story: {
            context: 'Steady state: about 8,000 recordings reach day 120 each working day across all councils.',
            problem: 'The job must be safe to run twice, to crash, and to run in parallel, and it must never be the reason the database slows down.',
            consequence: `A long single transaction deleting 8,000 recordings' rows holds locks and bloats the tables. A job that dies at row 3,000 and starts again from the top never finishes.`,
            fix: 'Small batches, one transaction per recording, FOR UPDATE SKIP LOCKED so two runs share the work, and an index on delete_after for live rows. Each recording is complete or untouched. What can still go wrong: the job silently stops being scheduled. An alert fires when any recording is more than 24 hours past its date.',
          },
          explain: [
            { q: 'Why hourly and not nightly?', a: 'Withdrawals set delete_after = now and should not wait for night. Hourly also keeps batches small.' },
            { q: 'What does SKIP LOCKED do?', a: 'A second run ignores rows the first has locked and takes the next ones, so they never wait on each other.' },
          ],
        },
        {
          title: 'A legal hold keeps one back',
          text: `One of the 212 is evidence in a complaint. Northshire's information governance lead placed a hold on it last month, with a reference. The job's query excludes held rows, so 211 go and one stays. Placing the hold was audited; so will releasing it be, and on release the recording is deleted at the next run.`,
          focus: ['retention', 'db'],
          path: ['ret-due'],
          labels: ['211 to delete, 1 held: ref 2291'],
          recovery: true,
          hide: ['stt-fb', 'audio-read', 'ret-vendor', 'ret-key', 'ops-db'],
          story: {
            context: 'A complaint, an inquiry or a court can require that a record is preserved.',
            problem: 'A deletion job that cannot be paused for one item destroys evidence. A deletion job that is easy to pause stops deleting.',
            consequence: 'Either the council is in breach of a duty to preserve, or holds become a way to keep everything.',
            fix: `A hold is a row with a reason, a named person and a date, attached to specific recordings. Only a council's designated role can place one. The ops view lists holds by age, and holds over 90 days are reported to the council for review. What can still go wrong: a hold conflicts with the 120-day term. An alternative is to hand the held material to the council as a sealed export and delete on time; which applies is a contract question to ask.`,
          },
          explain: [
            { q: 'Who can place a hold?', a: 'The council, not the supplier\'s staff and not the worker. The council is responsible for the data and for the legal duty.' },
            { q: 'Does a hold stop a consent withdrawal?', a: 'That is a legal question for the council. The system records both and deletes only when the hold is released.' },
          ],
        },
        {
          title: 'Audio first, then rows, then receipts',
          text: 'For each of the 211, the worker deletes the audio object and confirms it is gone, then in one transaction deletes the note, drafts and transcript, blanks the object key, marks the row deleted, writes the database receipt and opens one receipt per vendor that received the recording.',
          focus: ['retention', 'store', 'db'],
          path: ['ret-store', 'ret-db'],
          labels: ['delete audio, confirm gone', 'content out, receipts in'],
          recovery: true,
          hide: ['stt-fb', 'audio-read', 'ret-vendor', 'ret-key', 'ops-db'],
          story: {
            context: `Content is in two of our stores, and copies may be in three vendors'.`,
            problem: 'Two stores cannot be changed in one transaction. A crash between them must leave a state the next run can finish from.',
            consequence: 'Rows first, then a crash: audio remains in the bucket with nothing pointing at it, and no job will ever find it.',
            fix: 'Order the steps so that every crash leaves a pointer: audio first, while the row still holds its key; then the rows. Every delete is idempotent, so the next run repeats safely. Receipts are unique per recording and target. The bucket has no versioning on this prefix, so a delete is a delete. What can still go wrong: an orphan from some other bug. A weekly sweep lists the bucket and compares it with live rows.',
          },
          explain: [
            { q: 'Is this a saga?', a: 'A small one. Steps across stores that cannot share a transaction, done in an order where each can be retried, with a record of progress. There is no compensation because deletion only goes forwards.' },
            { q: 'What about database backups?', a: 'They cannot be edited. They expire after 35 days in this design, so content is gone from every copy by day 155. That is said in the contract, and any restore ends by re-running this job.' },
          ],
        },
        {
          title: 'A vendor does not confirm',
          text: 'The worker turns to vendors. For the LLM the contract says nothing is kept after the response: the receipt is marked "not held". For the speech provider it sends a delete for each request id. The call fails with a 500. The receipt stays pending and is tried again tomorrow. After 7 days pending, it raises an alert for the team.',
          focus: ['retention', 'deepgram', 'db'],
          path: ['ret-vendor', 'ret-db'],
          labels: ['delete request ids: 500', 'receipt still pending'],
          failed: ['ret-vendor'],
          recovery: true,
          hide: ['stt-fb', 'audio-read', 'ret-store', 'ret-key', 'ops-db'],
          story: {
            context: `One council's published record lists its sub-processors: cloud hosts, an identity service, a content delivery network, and speech and language model providers. Audio and transcripts go to at least the speech and language providers.`,
            problem: `"Deleted" means every copy. The copies at vendors are outside our systems and each vendor has its own rules, which this page has not verified.`,
            consequence: `A council asks for proof that a person's data is gone, and the true answer is "from our systems; we do not know about the vendors".`,
            fix: 'vendor_calls records every request id, so the system knows exactly who received what. Each vendor copy ends in one of three recorded ways: not held (by contract), deleted (confirmed by the vendor), or expires at the vendor on a stated date. Failures retry daily and alert at 7 days. What can still go wrong: a vendor with no delete endpoint and a retention window. Then the receipt can only state the expiry date, and the contract should aim for zero retention.',
          },
          explain: [
            { q: 'Do these vendors keep the data?', a: 'Not verified here. It is the first contract question for each: what is kept, for how long, for what purpose, and can it be switched off.' },
            { q: 'Why not mark the recording deleted only when all vendors confirm?', a: 'Our copy should go on time whatever a vendor does. The recording is deleted; the vendor receipts show what is still outstanding.' },
          ],
        },
        {
          title: 'Proof for the council',
          text: `On the first of the month Northshire's report is built from receipts: 4,310 recordings deleted, each with the date and the state of every target; 3 vendor receipts pending under 7 days; 1 hold; 0 recordings overdue. The weekly sweep found 0 objects in the bucket without a live row.`,
          focus: ['ops', 'db'],
          path: ['ops-db'],
          labels: ['4,310 deleted, 3 pending, 0 overdue'],
          recovery: true,
          hide: ['stt-fb', 'audio-read', 'ret-store', 'ret-vendor', 'ret-key'],
          story: {
            context: `The council signed a data protection impact assessment that relies on deletion. One council's, for a tool of this kind, was approved in 2025.`,
            problem: 'A deletion job that has stopped and one with nothing to do look the same from outside.',
            consequence: 'Nobody notices for months. The first to notice is the wrong person.',
            fix: `Measure the absence. Two numbers that must be zero: recordings more than 24 hours overdue, and objects with no live row. One report a council can read: counts and receipts, no content. What can still go wrong: the report is right about the system and silent about copies outside it, such as a transcript a worker emailed to a colleague. That is the council's policy to cover, and the page says so.`,
          },
          explain: [
            { q: 'What is in a receipt?', a: `The recording id, the target, the status, when, and evidence such as row counts or the vendor's request id. Nothing a person said.` },
            { q: 'Who checks the checker?', a: `The sweep reads the bucket itself, not the database's belief about the bucket. It is a separate job from the one that deletes.` },
          ],
        },
        {
          title: 'The council leaves: destroy the key',
          text: `Northshire ends its contract. Its admins export what they need. The retention worker runs for the whole council, ignoring dates but not holds. Then two engineers approve scheduling Northshire's key for destruction. After the waiting period the key is gone, and with it any copy of Northshire's content still sitting in a backup.`,
          focus: ['retention', 'db', 'store', 'kms'],
          path: ['ret-db', 'ret-store', 'ret-key'],
          labels: ['all of Northshire, reason: tenant exit', 'delete prefix t/northshire', 'schedule key destruction'],
          recovery: true,
          hide: ['stt-fb', 'audio-read', 'ret-vendor', 'ops-db'],
          story: {
            context: `This design assumes a four-week exit plan with a GDPR deletion plan, as suppliers of this kind state in G-Cloud listings.`,
            problem: 'Row deletes do not reach backups, replicas being rebuilt, or anything missed.',
            consequence: `A former customer's residents' data sits in a 35-day-old backup, readable by anyone who can restore it.`,
            fix: `Content was encrypted under the council's own key from the start, so destroying that key makes every remaining copy unreadable wherever it is. Do the ordinary deletes first, for the receipts, then the key. The key service's waiting period guards against a mistake. What can still go wrong: metadata is not under that key. What is kept after exit (billing records, the audit log for an agreed period) is written into the contract.`,
          },
          explain: [
            { q: 'Why not rely on key destruction alone?', a: 'Receipts per recording are the evidence a council expects, and deleting data you no longer need is better than keeping unreadable data.' },
            { q: 'What if a hold is active when the council leaves?', a: `The held items are exported to the council as a sealed package before deletion, with the council's written instruction.` },
          ],
        },
      ],
    },
  ],

  brief: [
    {
      heading: 'What this page is',
      points: [
        `An AI note-taking tool for UK councils records a meeting between a frontline worker and the person they support, transcribes it and drafts a case note that the worker edits and pastes into the council's case management system (as one council's published transparency record describes, 2025).`,
        `This page designs that pipeline in a typical stack for a small UK product team: Ruby on Rails, PostgreSQL, Sidekiq or GoodJob, object storage, Deepgram with Whisper as fallback, and an OpenAI model through Azure. The stack is this design's assumption; the architecture is this page's own and describes no real supplier's.`,
        'Throughput is small (about 40 uploads a minute at an assumed peak). The hard parts are a long upload on a bad connection, paid external calls that fail or hang, a draft that must not invent or omit, a record that belongs to the worker, and deleting everything on time with proof.',
      ],
    },
    {
      heading: 'Ask first (then propose defaults)',
      points: [
        `Who records, and on what? Default: a council-issued phone or laptop, in the browser, as one council's published record describes.`,
        'How long, and with what signal? Default: 30 to 90 minutes, often none. So recording must work offline.',
        'How is consent given, and what if it is withdrawn? Default: verbal, first; withdrawal means delete at once.',
        'Which languages and accents? Default: English first; measure accuracy by accent group.',
        'How soon is the draft needed? Default: within 10 minutes of upload.',
        'Does each council have its own template? Default: yes, with versions.',
        'Must the worker review before the note leaves? Default: yes, always.',
        `Where does the note go? Default: pasted into the council's case system.`,
        'How long is anything kept? Default: 120 days at most.',
        'Which cloud and queue today? Ask.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Record a visit of up to 90 minutes with no connection and lose at most 10 seconds to a crash.',
        'Upload over a poor connection, resuming after any interruption, without the worker watching.',
        `Produce a draft in the council's template in which every statement points to the words it rests on.`,
        'Make the worker the author: review, edit, sign, then export.',
        'Delete audio, transcript, draft and note by day 120, sooner on withdrawal, and prove it.',
        `Keep each council's data apart from every other's.`,
      ],
    },
    {
      heading: 'How well',
      points: [
        'Draft ready within 10 minutes for 95% of recordings; within 30 for 99%.',
        'No recording lost once the device has been told it is uploaded.',
        'About 40 uploads a minute at an assumed peak; about 3 jobs a second. Small.',
        'About 56 cents of vendor cost per audio hour (assumption).',
        'Simplified on this page: one region; one recording per visit and one template per recording; English only in the example; the web app only; vendor request shapes are sketches; prices, speeds and limits are assumptions; the legal points are not legal advice.',
      ],
    },
  ],

  numbers: [
    { what: 'Users', assumption: '100,000 frontline workers with accounts (assumption)', result: 'design for 100,000' },
    { what: 'A small start', assumption: 'assume 1,000 hours of audio a week', result: 'the floor: about 1,300 recordings a week at 45 minutes' },
    { what: 'Design load', assumption: '20% of workers record in a week × 2 recordings × 45 minutes (assumptions)', result: `40,000 recordings and 30,000 audio hours a week, 30 times the small start` },
    { what: 'Uploads', assumption: '5-day week, 10-hour day, 3 times peak (assumptions)', result: '8,000 a day; 800 an hour; 2,400 an hour or 40 a minute at peak' },
    { what: 'Jobs', assumption: 'about 4 per recording', result: '160,000 a week; under 3 a second at peak' },
    { what: 'Audio size', assumption: 'Opus at 32 kbit/s; budget 30 MB an hour for mixed formats', result: '14.4 MB an hour recorded; 0.9 TB a week; 15.4 TB held for 120 days; about $350 a month' },
    { what: 'Database', assumption: 'about 100 KB a recording (assumption)', result: 'about 70 GB held' },
    { what: 'Transcription time', assumption: '30 times real time (assumption)', result: '45 minutes in 90 s; 90 minutes in 3 minutes' },
    { what: 'Transcriptions in flight', assumption: '40 a minute × 1.5 to 3 minutes', result: '60 to 120 at peak' },
    { what: 'Tokens', assumption: '150 words a minute, 1.33 tokens a word, two calls', result: 'about 35,000 in and 2,700 out per audio hour; 1.1 million a minute at peak' },
    { what: 'Speech cost', assumption: '$0.45 an audio hour (assumption)', result: '$13,500 a week' },
    { what: 'LLM cost', assumption: '$2.50 and $10 per million tokens (assumption)', result: '$0.11 an audio hour; $3,300 a week' },
    { what: 'Total vendor cost', assumption: 'sum of the two', result: '$0.56 an audio hour; $0.42 a recording; $16,800 a week; about $73,000 a month' },
    { what: 'Turnaround', assumption: 'transcription + two model calls + queue', result: 'about 3 minutes typical; objective 10' },
    { what: 'Deletion', assumption: 'what arrives leaves 120 days later', result: 'about 8,000 recordings a working day' },
    { what: 'Backups', assumption: '35-day window (design choice)', result: 'gone from every copy by day 155' },
  ],

  framings: [
    { name: 'A small start', scale: 'about 1,000 audio hours a week (assumption)', shape: 'One Rails app, one Postgres, a job queue, one speech provider and an LLM. The state machine, step table, retention date and row-level security are worth having even here; the breaker and the check can follow.' },
    { name: 'This page', scale: '30,000 audio hours a week, 40 uploads a minute at peak (assumption)', shape: 'As drawn: local recording, multipart upload, jobs in Postgres, two speech providers behind a breaker, cited statements and a check, review and sign-off, retention with receipts, a key per council.' },
    { name: 'Ten times this', scale: '300,000 audio hours a week', shape: 'Same shape. Move the queue off the main database, submit transcription with callbacks so no threads wait, buy committed capacity from vendors, and cost out self-hosted speech to text. Read replicas for the review screen.' },
    { name: 'Three regions', scale: 'UK or EEA, United States, Australia', shape: 'One complete stack per region with in-region vendors. A council lives in one region. A global directory maps sign-in domains to regions and holds no personal data.' },
    { name: 'Live products', scale: 'a voice agent or live interpreter, with a budget of a few hundred milliseconds', shape: 'Not this pipeline. Streaming speech both ways, no retries, hand-over to a person. Shares tenancy, retention and audit only.' },
  ],

  decisions: [
    { choice: 'Where recording happens', a: 'On the device, in slices, upload after', b: 'Stream live to the server', call: 'On the device. Visits have no signal, and a withdrawal mid-meeting is then a local delete.' },
    { choice: 'Upload', a: 'Multipart, presigned, direct to the bucket', b: 'tus server; or one PUT', call: 'Multipart: nothing to run, no audio through Rails. tus if measured failures justify a server.' },
    { choice: 'Who makes the recording id', a: 'The device', b: 'The server', call: 'The device, so create can be retried without the reply.' },
    { choice: 'Where state lives', a: 'A state column in Postgres, compare-and-set', b: 'Implied by which jobs exist', call: 'The column. The queue is a hint; a sweeper repairs it from the truth.' },
    { choice: 'Queue', a: 'GoodJob in Postgres', b: 'Sidekiq in Redis', call: 'GoodJob at this size: job and state commit together. Sidekiq is fine with the sweeper.' },
    { choice: 'Orchestration', a: 'A chain of jobs, each creating the next', b: 'A workflow engine; or one big job', call: 'A chain. Four steps do not need a platform, and one big job repeats paid work.' },
    { choice: 'Waiting on the speech provider', a: 'Block in the job with a long drain', b: 'Submit with a callback', call: 'Block first: simpler. Callback when concurrency or deploy losses grow.' },
    { choice: 'When the primary fails', a: 'Fail over to Whisper behind a breaker', b: 'Queue until it returns', call: `Fail over, and say the draft is from the backup. Offer "wait for primary" as a council setting.` },
    { choice: 'Long recordings', a: 'One pass up to 30,000 tokens, chunk above', b: 'Always chunk and merge', call: 'One pass. A 90-minute visit is about 18,000 tokens; chunking loses context.' },
    { choice: 'Draft format', a: 'Statements with cited lines, then a check', b: 'Free text', call: 'Cited. It makes review quick and grounding measurable, for about 11 cents an audio hour.' },
    { choice: 'An unsupported statement', a: 'Flag it; the worker decides', b: 'Delete it', call: 'Flag. The checker can be wrong and the worker was there.' },
    { choice: 'Draft and note', a: 'Two rows; the draft never changes', b: 'One document edited in place', call: 'Two rows. Authorship is explicit and the difference is evidence.' },
    { choice: 'Export', a: 'Copy per section or file, behind an interface', b: 'Supplier API', call: 'Copy today. An adapter when a supplier and a council are ready.' },
    { choice: 'Tenancy', a: 'Shared tables with row-level security', b: 'A schema per council', call: 'Row-level security: one migration, enforced by the database, tested as the app role.' },
    { choice: 'Encryption', a: 'A key per council', b: 'One platform key', call: 'Per council: isolation, an outside access log, erasure by key destruction.' },
    { choice: 'Retention', a: 'A date on the row, an hourly job, receipts', b: 'Bucket rule and dropped partitions', call: 'The job, with the bucket rule as backstop. Holds, withdrawals and proof need per-recording control.' },
    { choice: 'Regions', a: 'A stack per region', b: 'One global stack with regional buckets', call: 'A stack per region. Residency is a promise about processing, not only storage.' },
  ],

  drills: [
    { name: 'The phone loses signal at 60% of part 2', what: 'Only that part is sent again. The device backs off, keeps the file and says it is safe locally.' },
    { name: 'The tab crashes mid-recording', what: 'At most 10 seconds lost. On reopening, the slices are found and the worker chooses to carry on or upload.' },
    { name: 'Complete is called twice', what: 'A compare-and-set on state: the second matches no row and returns the same answer.' },
    { name: 'Deepgram returns 503 for an hour', what: 'The breaker opens in 30 seconds; Whisper takes the work without speaker labels; one trial call a minute tests the primary.' },
    { name: 'Both speech providers are down', what: 'Steps wait and retry. Workers are told drafts are delayed and recordings are safe. The SLO burns and on-call is paged.' },
    { name: 'The LLM call hangs', what: '120-second timeout, retry with backoff, at most 5 attempts, one draft whatever happens.' },
    { name: 'A deploy kills a worker mid-transcription', what: 'The lease runs out, the sweeper re-enqueues, the call is paid for twice. A 10-minute drain makes it rare.' },
    { name: 'The same job runs twice at once', what: 'One claim wins. If both reach the save, the unique key lets one in.' },
    { name: 'The content filter refuses a transcript about abuse', what: 'Permanent for that deployment. Fail over to an approved one or stop with a clear message. Never a note with the hard part missing.' },
    { name: 'The check flags a sentence', what: 'It stays, marked. Export is blocked until the worker keeps, edits or removes it.' },
    { name: 'The summary leaves out a disclosure', what: 'Not caught by grounding. Uncited passages are listed at review; omissions are scored offline on marked test sets.' },
    { name: 'A three-hour recording', what: 'Timeout and lease scale with length; above 30,000 tokens, extract per piece then write.' },
    { name: 'One council uploads a week\'s backlog on Monday', what: 'At most 10 of its steps in flight while the queue is backed up; others are unaffected.' },
    { name: 'Consent withdrawn mid-meeting', what: 'A local delete. One audit event, no content.' },
    { name: 'Consent withdrawn while transcribing', what: 'Steps cancelled; the late save matches no row; audio deleted; a vendor receipt opened.' },
    { name: 'The retention job stops', what: 'Overdue count pages at 24 hours. The bucket rule removes audio at 125 days regardless.' },
    { name: 'A restore from backup', what: 'The runbook ends by running the retention job, which deletes again from the dates.' },
    { name: 'A council leaves', what: 'Export, delete with receipts, then destroy its key after a waiting period.' },
    { name: 'A query runs with no council set', what: `It raises an error. It does not return every council's rows.` },
  ],

  interview: [
    'Minutes 0 to 6: clarify. Device, length, signal, consent, languages, turnaround, template, review, retention, cloud. State defaults and move on.',
    `Minutes 6 to 10: numbers, saying whose they are. 1,000 hours a week is my assumed small start; 30,000 a week is my design load. 40 uploads a minute at peak, 3 jobs a second, 56 cents an audio hour. Conclusion: reliability, accuracy and deletion are the problems, not throughput.`,
    'Minutes 10 to 22: draw it and follow one recording. Device, app, bucket, Postgres with the state column and step table, queue, transcribe, summarise, review, case system, retention. Say why Rails and Postgres: one app and one database the team already knows.',
    'Minutes 22 to 42: the deep dives they pick. Upload resume; job runs twice; provider down; hallucination and omission; tenancy; deletion with proof.',
    'Minutes 42 to 55: run it and lead it. SLOs, four pages, cost and what drives it, phases, who owns what including the council, rollout to a new council, how accuracy is measured, the ethical position.',
    'Last 5 minutes: your questions. What vendors keep; how accuracy is measured today; what the team is on call for.',
  ],

  sources: [
    { label: 'One UK council\'s algorithmic transparency record for an AI note-taking tool, on GOV.UK (2025)', note: 'Not linked, because the record names the product. Council devices and the web app; WAV and MP3; Deepgram with OpenAI Whisper as fallback; an OpenAI model for summaries; edit then paste into the case system; verbal consent, delete on objection; up to 120 days; UK or EEA; sub-processors; a vendor claim of 98% accuracy, unverified; risk with strong accents.' },
    { label: 'Social work press coverage of a 2024 council trial of AI note-taking and its evaluation', note: 'Transcript, summary and suggested actions from council-set prompts; reported errors (misspelt names, repetition, assumptions about needs); trouble with multi-case meetings; time-saving figures.' },
    { label: `Local Government Lawyer: on the Ada Lovelace Institute's report (12 February 2026)`, href: 'https://localgovernmentlawyer.co.uk/adult-social-care/391-adult-care-news/99712-ai-transcription-tools-in-social-work-introducing-new-risks-to-people-and-society-such-as-bias-and-hallucinations-report-warns', note: 'Councils evaluate efficiency more than impact on people; recommends recording use under the transparency standard.' },
    { label: `This page's SQL checks (PGlite, 16 November 2026)`, note: 'The schema and 25 behaviours were run on PostgreSQL 18.6 compiled to WebAssembly, one connection. No pooler, no concurrency test, no timings.' },
    { label: 'What this page did not verify', note: `The scenario is a guess at a likely interview theme. The design is this page's and describes no real supplier's. Every volume, every price, speed and vendor limit, vendor retention and deletion behaviour, browser recording behaviour, and the legal points are unverified. Product behaviour of S3, GoodJob, Sidekiq, Deepgram, Whisper and Azure OpenAI is written from memory.` },
  ],

  glossary: [
    { term: 'Case note', also: ['note', 'record'], where: 'review', text: 'The worker\'s written record of a visit. A statutory record: decisions about someone\'s care rest on it.' },
    { term: 'Case management system', also: ['Eclipse', 'Liquidlogic', 'Mosaic'], where: 'cms', text: `The council's system of record for social care. The final note lives there.` },
    { term: 'Client recording id', where: 'device', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: `A UUID the device makes when recording starts. It makes "create this recording" safe to send twice.` },
    { term: 'Multipart upload', also: ['parts', 'resumable upload'], where: 'store', text: 'Sending a file as numbered parts that the store assembles. A lost part is sent again; the rest are kept.' },
    { term: 'Presigned URL', where: 'store', text: 'A URL signed by the app that allows one request, here one PUT of one part, for a limited time.' },
    { term: 'ETag', where: 'store', text: `The store's fingerprint of a part. The complete call must list each part's ETag.` },
    { term: 'State machine', also: ['recordings.state'], where: 'db', text: 'The fixed set of states a recording moves through, each move allowed only from the state before.' },
    { term: 'Compare-and-set', also: ['guarded update'], where: 'db', text: 'An update that names the value it expects to replace. If something else got there first it changes nothing.' },
    { term: 'Step', also: ['pipeline_steps'], where: 'db', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: 'One unit of pipeline work for one recording: transcribe, summarise, check. Its row is its idempotency key.' },
    { term: 'Lease', also: ['locked_until'], where: 'queue', text: 'A lock with an expiry. A worker that dies releases its step by doing nothing.' },
    { term: 'Sweeper', where: 'queue', text: 'A job that runs every minute and re-creates the job for any step left pending or past its lease.' },
    { term: 'Backoff and jitter', where: 'queue', see: { id: 'retries-breaker', label: 'Retries and circuit breakers' }, text: 'Waiting longer after each failure, with a random element so many clients do not retry together.' },
    { term: 'Circuit breaker', where: 'transcriber', see: { id: 'retries-breaker', label: 'Retries and circuit breakers' }, text: 'A switch that stops calling a failing provider for a while and sends work elsewhere.' },
    { term: 'Dead step', also: ['dead letter'], where: 'queue', text: 'A step that has used all its attempts. Parked, shown to the worker and to ops, re-driven after a fix.' },
    { term: 'Diarisation', also: ['speaker labels'], where: 'deepgram', text: 'Tagging each stretch of speech with a speaker number. It does not know names.' },
    { term: 'Template version', where: 'summariser', text: `An immutable, numbered copy of a council's headings, guidance and prompt. One is live.` },
    { term: 'Statement', where: 'summariser', text: 'One sentence of the draft, stored with the transcript line numbers it rests on.' },
    { term: 'Grounding', also: ['grounding check', 'citation'], where: 'summariser', text: 'Whether a statement is supported by the transcript lines it cites. Checked by code, then by a second model call.' },
    { term: 'Hallucination', where: 'llm', text: 'Fluent text from a model that is not supported by its input.' },
    { term: 'Omission', where: 'summariser', text: 'Something said in the visit that the draft leaves out. Grounding cannot see it.' },
    { term: 'Generation', where: 'db', text: 'Which draft this is for a recording. 1 by default; 2 if the worker asks for a new one.' },
    { term: 'Sign-off', where: 'review', text: `The worker's act of making the note theirs. Nothing exports before it.` },
    { term: 'Tenant', also: ['council'], where: 'db', text: 'One customer organisation. Every row carries its id.' },
    { term: 'Row-level security', also: ['RLS'], where: 'db', text: `A database rule that filters every query on a table, here to the current council's rows.` },
    { term: 'Envelope encryption', also: ['data key'], where: 'kms', text: 'Encrypt content with a data key; store the data key encrypted by a key in the key service.' },
    { term: 'Delete-by date', also: ['delete_after', 'retention'], where: 'retention', text: `The date a recording's content must be gone. Set at creation; never more than 120 days later.` },
    { term: 'Deletion receipt', where: 'retention', text: 'A row recording that one recording\'s content was removed from one place, with evidence and no content.' },
    { term: 'Legal hold', where: 'retention', text: `A council's instruction to keep specific recordings past their date, with a reason, until released.` },
    { term: 'Sub-processor', where: 'deepgram', text: `Another company that processes the data on the supplier's behalf, such as a speech or model provider.` },
    { term: 'DPIA', also: ['data protection impact assessment'], where: 'retention', text: `The council's written assessment of the risks of a new use of personal data. One council's, for a tool of this kind, was approved in 2025.` },
    { term: 'Break-glass access', where: 'ops', text: `Time-limited, logged access to content for a named reason, with the council's permission.` },
    { term: 'Automation bias', where: 'review', text: `The tendency to trust a machine's output, more so when it is usually right.` },
  ],
};
