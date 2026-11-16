import type { Extras } from './types';

/**
 * Interview extras for "AI phone agent for a council helpline".
 *
 * From a content spec of 16 November 2026. Figures as on the design page; all
 * volumes, latencies and prices are this page's assumptions: 30 councils at 1,500 calls a day,
 * 45,000 calls, 450 at once in the busy hour, 1,500 planned at a surge, 50 calls a worker and 40
 * workers, about 1.1 seconds mouth to ear, recall 99% and precision about 50%, about 7p a minute.
 * The design is this page's and describes no real supplier's product.
 */
export const extras: Extras = {
  opening: [
    "Before I draw anything, a few questions, because the answers change the design. Which lines is this for: housing, social care, both? What is the agent allowed to do, and what must it never do? What counts as urgent, and who decides? Who takes an urgent call, at what hours, and what happens when they're all busy? Which languages? How many calls a day, and how bad is Monday morning? Is the call recorded, and what are callers told?",
    "If you're happy, I'll assume this. One council line to start, English, office hours with a duty desk behind it. The agent takes details, answers simple questions, books or routes. It never decides eligibility. Urgent means the council's list: risk to life, safeguarding, domestic abuse, nowhere to sleep tonight. And one rule above all the others: it must never stand between a person and a human.",
    "On scale I'll assume thirty councils at fifteen hundred calls a day each: forty-five thousand calls, about four hundred and fifty at once in the busy hour, and I'll plan for fifteen hundred at once after a storm. That's small. The hard parts aren't volume. They're three things: replying within about a second so it feels like a conversation, catching the urgent call reliably, and getting a person on the line fast with the story already told.",
    "The shape: the carrier streams each call's audio over a WebSocket to one media worker, which holds that call in memory. Audio streams to speech-to-text, a state machine with an LLM inside each state decides what to say, and text-to-speech streams the reply back. Everything streams, which is how I get to about a second. Next to the conversation, a separate urgency monitor reads every utterance. When it fires, a handover service rings the duty officer, plays a ten-second summary, and joins the call. Afterwards a job files a draft note to the council's system.",
    "I'd like to go deep on the latency budget, the urgency threshold and what happens when no human is free, then on running stateful workers through deploys and provider failures. And I'll finish with how I'd roll it out safely, because I wouldn't let it answer a real call until it had run in shadow. Where would you like to start?",
  ],

  pushes: [
    {
      q: 'Where does the second go? Break down the latency.',
      a: [
        "About 1.1 seconds mouth to ear, all approximate: 100 ms phone network in, 300 ms waiting to be sure they've finished, 50 ms for the final transcript, 250 ms to the LLM's first token, 100 ms to finish the first clause, 150 ms to first audio from text-to-speech, 150 ms network out.",
        "About 250 ms of that is the phone network, which I can't touch or measure. So my service level is at our edge: half of turns under 900 ms, 95% under 1.5 s.",
        'The tricks are all the same trick: start each stage before the last one finishes. Stream audio to speech-to-text while they talk. Stream tokens. Send the first clause to the voice while the rest is being written.',
        'Then the small things: warm connections, short prompts because the state machine carries the rules, a small model, recorded clips for fixed lines, and a filler at 700 ms when a turn is going to be late.',
        'Without streaming the same stages come to about 2.4 seconds.',
      ],
    },
    {
      q: 'Why not use a speech-to-speech model and skip the pipeline?',
      a: [
        "It would save about 300 ms and sound more natural. I'd watch it closely.",
        'But I want text in the middle. The urgency monitor, the guardrails and the audit trail all read text before anything is spoken. With speech-to-speech, checks run after the words are already audio.',
        'And the transcript becomes a by-product that may not match what was said, which is a problem for a council record.',
        'It also ties the whole call to one vendor, where three stages let me put a second provider behind each.',
      ],
    },
    {
      q: "Audio over a WebSocket means TCP. Isn't UDP the right answer?",
      a: [
        'For audio, yes: with UDP a late packet is skipped. With TCP it holds up everything behind it.',
        "But the WebSocket here runs between the carrier's data centre and our cloud, where loss is rare. The lossy part, the caller's mobile, is already on the phone network.",
        "In exchange I run ordinary servers and no SIP equipment. For a small team that's the right trade today.",
        "I'd move to a SIP trunk and RTP at about ten times the volume, or sooner if TCP stalls show in the tail of the latency numbers.",
      ],
    },
    {
      q: 'How do you know the caller has finished speaking?',
      a: [
        'Voice activity detection in the worker tells me speech has stopped. Then the wait depends on the words so far: 300 ms after a complete-looking sentence, up to 1.2 seconds after "my date of birth is".',
        "It's the largest piece of the budget and it's pure waiting, so it's worth tuning per state: longer for dates and addresses.",
        "It will sometimes cut in. That's why interruption has to work both ways.",
        'Later optimisation: start the LLM on the partial text during the wait and discard if they carry on.',
      ],
    },
    {
      q: 'What happens when the caller talks over the agent?',
      a: [
        'The inbound stream is always being heard. Three frames of speech, about 60 ms, and I tell the carrier to clear its queued audio, cancel the voice and LLM streams, and listen.',
        "I pace outbound audio so the carrier never holds more than a fraction of a second, or clearing wouldn't help.",
        'I record which words were actually played, so the next prompt reflects what the caller heard.',
        'False triggers are the cost: coughs, a television, speakerphone echo. "Mm-hm" is treated as agreement.',
      ],
    },
    {
      q: 'How do you set the urgency threshold?',
      a: [
        'From the costs of the two mistakes. A false alarm costs a duty officer about two minutes. A miss leaves someone at risk talking to software.',
        "So recall first: 99% or better on a labelled set, and I accept precision of about 50%. On my assumptions about 8% of calls get an urgent transfer and half didn't need it.",
        'The threshold is per category and per council, set from labelled transcripts, and re-checked before every release of the prompt, the model or the keyword list.',
        "The council sees the false alarm rate and owns the decision to move it. It's their staff time and their duty of care.",
      ],
    },
    {
      q: 'Is 99% recall good enough?',
      a: [
        'No, not alone. At 1,800 urgent calls a day across thirty councils, 1% is 18 people a day.',
        'So there are layers. The caller can always ask for a person. The agent closes every call by asking whether anyone is at risk right now. A different, larger model re-reads every call within a minute and a disagreement raises a callback. And people review a sample.',
        "And I'd say this to the council plainly, with the numbers. The comparison is with today, where the caller may wait forty minutes in a queue or get voicemail. I'd want that baseline measured before claiming anything.",
      ],
    },
    {
      q: 'How do you measure false negatives? Nothing errors when you miss one.',
      a: [
        "That's the difficulty. Three sources. A 1% random sample of unflagged calls reviewed by people each day: the only unbiased estimate.",
        'Every call where the after-call sweep disagreed with the live monitor.',
        'And outcomes from the council: a case that turned out urgent within a few days of a call we treated as routine.',
        "One council's sample is about 15 calls a day, too few to see a 1-in-100 event quickly. So I pool across councils and report a range, not a point.",
        'Every confirmed miss goes into the labelled set, so the test gets harder over time.',
      ],
    },
    {
      q: 'What if no human is free?',
      a: [
        "I can't see who's free from outside the council's phone system, so I ring down a chain: duty officers for 20 seconds, the team leader for 20, the out-of-hours emergency duty team for 30.",
        "The agent stays on the whole time and tells the caller the truth. It gives the 999 line straight away if there's danger now.",
        'If the chain runs out, at about 70 seconds, a priority callback alerts the duty manager until someone acknowledges it, the agent confirms the best number, and it keeps trying while the caller stays. It never hangs up first.',
        "And I show the council its time-to-answer per hour. If the chain is exhausted every Monday, that's a staffing decision, and they need to see it.",
      ],
    },
    {
      q: 'Walk me through the transfer mechanically.',
      a: [
        "The session calls the handover service with a handover id it made once, so retries can't ring two people.",
        'The service asks the carrier to place a second call to the officer. The caller is still on the media stream with the agent.',
        'When the officer answers they hear a ten-second summary built from the captured fields by a template, not an LLM call, and press 1. The key press stops voicemail being joined to someone in crisis.',
        "Then the service redirects the caller's call into a conference with the officer. That ends the media stream, so the agent leaves at that moment.",
        "If the handover service is down, the session falls back to a plain redirect to the first number. No summary, but a person. I'd check the carrier's API details before committing to this exact sequence.",
      ],
    },
    {
      q: 'A media worker dies with 50 calls on it.',
      a: [
        'The carrier sees the WebSocket close and runs the next instruction it was given: ask the router again.',
        'The router sees the call has a checkpoint and assigns a new worker. It loads the script state, the fields and the last six turns and says "Sorry, I lost you for a moment."',
        'The gap is 2 to 3 seconds. The checkpoint may be a turn behind, so one question may be asked twice.',
        'A call already flagged urgent skips all that and goes to a person.',
        '50 is a cap I chose partly for this: it limits how many people one crash touches.',
      ],
    },
    {
      q: 'We ship several times a day. How, with calls held in memory?',
      a: [
        "Two answers. First, most changes aren't code. Scripts, prompts, keyword lists and handover chains are versioned data loaded per call. They ship without touching a worker, behind the same test set.",
        'Second, when the worker does change: drain. New workers take new calls, old ones take none and stop when their last call ends, with a 30-minute limit.',
        'New code is live for new calls in a minute or two, starting with 5% of calls. The old version lingers for the length of a call.',
        "If the brain turns out to change far more often than the audio code, I'd split it into its own stateless service. That costs 10 to 20 ms a turn, so I'd wait until it hurt.",
      ],
    },
    {
      q: "How do you autoscale? There's a storm at 3 pm and calls triple.",
      a: [
        'Scale on calls per worker, not CPU: add workers past 30 of 50. Keep 30% spare. A worker takes about a minute to start, so the spare is what absorbs the first minute.',
        'Monday 9 am is predictable: scale on a schedule at 8:30.',
        "A storm isn't. Past capacity the router forwards new calls to the council's own queue. It never queues people behind the agent.",
        "The real ceilings are other people's: the carrier's concurrent-call limit and each provider's limits on streams and requests. Those are contract terms to agree before the storm, and I'd test them.",
        "Per-council caps stop one council's storm taking everyone's capacity.",
      ],
    },
    {
      q: 'Text-to-speech stalls mid-sentence. What does the caller hear?',
      a: [
        'About half a second of silence, then the sentence again from its start in a slightly different voice.',
        'Each stage has a deadline of about three times its normal time. For the voice: first audio in 400 ms, no gap over 300 ms. On a miss, cancel and switch to the second provider.',
        'A circuit breaker across the fleet moves everyone to the second provider after 5 failures in 30 seconds.',
        'If both are down, a recorded apology plays and the call is transferred. The fixed lines are recordings so that this path has no dependency on the thing that failed.',
      ],
    },
    {
      q: 'A state machine sounds rigid. Why not let the model run the conversation?',
      a: [
        'Because a council has to approve what it says, and I have to be able to test it. With states I can list every path.',
        'The model still does the language: understanding messy answers, extracting fields, wording the next question kindly.',
        'Short per-state prompts are also why the first token comes back in about a quarter of a second.',
        "The cost is stiffness when a caller jumps around, and scripts to maintain. I'd accept that for this domain. For a lower-risk line I'd loosen it.",
      ],
    },
    {
      q: 'A caller says "ignore your instructions" or asks where someone lives.',
      a: [
        "The rules that matter aren't in the prompt. Tools are allowed per state, only after the identity fields are collected, and no tool returns an address or case notes.",
        "So the worst a manipulated model can do is say something unhelpful. It can't disclose what it never receives.",
        "Name, date of birth and postcode link a call to a case for staff. They don't prove identity, and I treat them that way.",
      ],
    },
    {
      q: "What's different about a domestic abuse call?",
      a: [
        'The caller may not be alone, and the person calling about a case may be the abuser.',
        "So nothing sensitive is spoken back to the caller's end. The summary goes to the officer on the other call.",
        "No text message or callback to the caller's number unless they've said it's safe.",
        "Lookups return the minimum. And the category list and the wording come from the council's safeguarding lead, not from engineers.",
      ],
    },
    {
      q: 'Thirty councils share this. How do you keep them apart?',
      a: [
        'Every row carries the council through its line; the adapters and credentials are per council; recordings sit under a per-council path.',
        'A per-line cap on calls at once stops a noisy neighbour.',
        'Scripts, keyword lists, thresholds, voices and chains are per council data.',
        "Region is the bigger split. I'd assume UK data stays in the UK or EEA, US on US servers, Australian in Australia. So it's a deployment per region, not one global system.",
      ],
    },
    {
      q: 'Where does the data go, and for how long?',
      a: [
        'Audio and text pass through three providers per call. I need regional endpoints and contracts that say no retention and no training.',
        "Our copy: 120 days, then deleted, with backups gone 35 days later. 120 is the figure one council's published record gives for an AI note-taking tool; I've assumed it here.",
        "The lasting record is the note in the council's system, a draft until staff accept it.",
        'A caller who objects to recording is transferred to a person, unrecorded.',
        "I'd expect the council to publish a transparency record for this, as one council did for AI note-taking.",
      ],
    },
    {
      q: "Accents, other languages, callers who can't use speech well?",
      a: [
        "Phone audio is 8 kHz, and a council's own record for the notes product lists poorer accuracy for strong accents as a risk. I'd assume it's worse here.",
        'So: read back critical details, and after two low-confidence turns go to a person. Measure recognition and urgency recall by accent group where the data allows, because an average hides this.',
        "Other languages: detect in the first two utterances. Supported ones switch; the rest go to a person with the language noted. A language isn't supported until it has its own urgency test set.",
        'Press 0 works throughout. Longer waits for relay calls or on request. And the phone line to a human stays; the agent is a faster route for some, not the only route.',
      ],
    },
    {
      q: 'What does it cost, and what would you cut?',
      a: [
        "About 7p a minute on prices I've assumed, so about 28p for a four-minute call. I'd check every price before quoting it.",
        'Text-to-speech is about 5p of the 7. The model is under half a penny.',
        "So the levers are: recorded clips for fixed lines, shorter replies, and a cheaper voice. I would not cut the second LLM call for urgency; it's the cheapest safety there is.",
        "The cost that isn't on the bill is review: about 410 sampled calls a day is roughly two people.",
      ],
    },
    {
      q: 'Would you build all this?',
      a: [
        'No. Telephony, speech-to-text, the LLM and the voice are bought.',
        "For the pilot I'd also buy or borrow the turn-taking: a hosted voice-agent platform or an open-source framework. Endpointing and barge-in are hard and not what makes this product different.",
        "I'd build the three things that are: the urgency monitor and its test set, the handover with its chain, and the record into the council's system.",
        "I'd bring the media path in-house when I need what a platform won't give me: partial transcripts for early detection, my own deadlines and fallbacks, data residency.",
      ],
    },
    {
      q: 'How do you test it before a release?',
      a: [
        'A labelled set of real, consented transcripts per category. Every change to a prompt, model, keyword list or threshold runs against it; recall below 99% blocks the release.',
        'Scripted conversations for every path through each state machine, run against both LLM providers.',
        'Simulated callers: recorded audio played into a test number, including interruptions, silence and noise, with latency measured.',
        'Then shadow mode on live calls, then 5% of calls, watching transfer rate, abandoned calls and sweep disagreements.',
      ],
    },
    {
      q: "How do you know it's good for residents and not just cheaper?",
      a: [
        "That's the criticism made of AI in social work generally: a 2026 Ada Lovelace Institute report said councils measure efficiency, not the effect on people.",
        "So I'd measure the resident's side from day one: time to reach a person on urgent calls against the old queue, abandoned calls, how often people ask for a human, complaints, and outcomes by group.",
        "And I'd publish the miss-rate estimate to the council with its uncertainty.",
        'If the agent makes urgent callers slower to reach a person than the old queue did, it should be switched off for that line.',
      ],
    },
  ],

  lead: {
    phases: [
      { name: 'Shadow', ships: 'One council, one line. The script as a state machine, the urgency monitor, and a labelled set built from consented recordings and staff role-play. The agent answers nobody; its flags are compared with what staff did.', why: 'Recall is the risk that could hurt someone. Prove it before a resident hears the agent.' },
      { name: 'Pilot behind a staffed desk', ships: 'The agent answers 10% of calls on that line in office hours, on a hosted or open-source voice pipeline. Our own handover service with the chain. Every call reviewed.', why: 'Learn about real callers at a volume where people can check everything. The handover is built first because it is the safety net for everything else.' },
      { name: 'Own the media path', ships: 'Call router, media workers, draining, checkpoints, a second provider behind each stage, deadlines and circuit breakers.', why: 'Needed before volume: partial transcripts for early detection, our own fallbacks, deploys that drop nothing.' },
      { name: 'The record', ships: 'After-call jobs, the summary, adapters for the first two case systems, the 120-day delete, the review tool.', why: 'Staff time is only saved when the note lands in their system. Until then the pilot files by secure message.' },
      { name: 'Scale out', ships: 'More councils and lines, scheduled scaling, per-council caps, out-of-hours chains, a second language, a second carrier.', why: 'Each is a contract or staffing matter as much as an engineering one, so they come when a council needs them.' },
    ],
    migration: [
      "The number stays with the council. Its phone system forwards a share of calls to ours: 10%, 25%, 50%, all. Going back is switching the forward off.",
      "The council's existing queue stays in place as the overflow target and the carrier's fallback. It is never decommissioned as part of this work.",
      'Two weeks of shadow first: compare the monitor\'s flags with what staff recorded on the same calls.',
      "Before go-live: the council's DPIA, a published transparency record, the script and urgency list signed off by its safeguarding lead, the chain's numbers test-called at each hour they claim to cover.",
      'Train the duty desk on what the spoken summary sounds like and what pressing 1 does. Run test calls with them.',
      "Agree in writing what the agent does not change: the council's staffing of the duty desk.",
    ],
    slos: [
      { name: 'Turn latency at our edge', target: '50% of turns under 900 ms, 95% under 1.5 s, per council per hour', why: 'It is what makes it a conversation. Measured from last speech frame in to first audio frame out.' },
      { name: 'Urgent flag to a phone ringing', target: '99% within 3 seconds', why: 'The part of handover speed we control.' },
      { name: 'Urgent flag to a person on the call', target: '90% within 60 seconds, reported per line', why: 'Shared with the council: it depends on their staffing. Reported so they can see it.' },
      { name: 'Urgency recall', target: '99% or better on the labelled set for every release; live miss rate estimated monthly from review', why: 'The safety measure. A release gate, not only a dashboard.' },
      { name: 'Calls answered or overflowed', target: "99.9% of calls answered by the agent within 3 seconds or forwarded to the council's queue", why: "A phone line must never be dead. 99.5% is a typical G-Cloud target for a web service; a call path needs better." },
      { name: 'Calls dropped by us', target: 'Under 0.1%, and zero from deploys', why: 'A dropped call may be someone who does not ring back.' },
      { name: 'Note filed', target: '99% within 5 minutes of the call ending', why: 'Staff act on the note.' },
    ],
    oncall: [
      'Pages now: turn latency over 1.5 s at the 95th percentile for 5 minutes; overflow above 5% of calls for 5 minutes; both providers of any stage failing; the handover service erroring; reconnects after worker crashes above a handful.',
      "Pages now, to the council's duty manager and to us: an urgent handover whose chain was exhausted.",
      'Pages now after a release: a jump in sweep disagreements, transfer rate or abandoned calls against the previous version. Roll back first, ask why after.',
      "Waits for the morning: one council's note filing failing (notes are queued); a breaker open on one provider while the second is healthy; cost per minute drifting; a slow rise in abandoned calls.",
      'Weekly, with the safeguarding lead: every confirmed miss, read in full.',
    ],
    teams: [
      { name: 'Voice platform', owns: 'Call router, media workers, provider connections, latency, capacity, deploys. Carries the pager for the call path.' },
      { name: 'Conversation and safety', owns: 'Scripts, the brain, the urgency monitor, the labelled set, the release gate, the review tool.' },
      { name: 'Integrations (forward deployed)', owns: "Council adapters, onboarding, handover chains, each council's settings." },
      { name: 'Practice lead (a social work or safeguarding professional)', owns: 'The definition of urgent, the wording, the review of misses. Not an engineering role, and the design does not work without one.' },
      { name: 'The council', owns: "The script's sign-off, the lawful basis and notice, the duty desk's staffing, and the record." },
    ],
    buildBuy: [
      { part: 'Telephony', call: 'Buy', why: 'Carrier relationships and number rules are not this product.' },
      { part: 'Speech-to-text, LLM, text-to-speech', call: 'Buy, two providers each', why: 'Better than we could run, and the second provider is the resilience plan.' },
      { part: 'Turn-taking pipeline (endpointing, barge-in)', call: 'Borrow first, own later', why: 'A hosted platform or open-source framework for the pilot. In-house when we need partial transcripts, our own deadlines and regional control.' },
      { part: 'Urgency monitor and labelled set', call: 'Build', why: "It is the product's reason to exist, and the labelled set is the asset." },
      { part: 'Handover service', call: 'Build', why: 'Small, critical, and specific to how councils staff duty desks.' },
      { part: 'Scripts and their editor', call: 'Build', why: 'Councils must read and approve them; versions tie to test results.' },
      { part: 'Job queue', call: 'Use what the team runs', why: 'A Postgres-backed queue is enough at 6 jobs a second.' },
      { part: 'Council adapters', call: 'Build, one per case system', why: 'Nobody sells them. Reuse across councils on the same vendor.' },
      { part: 'Review tool', call: 'Build small', why: 'A queue of calls with audio, transcript, signals and two buttons. It feeds the labelled set.' },
    ],
    cost: [
      'About 7p a call minute on assumed prices: text-to-speech 5p, telephony 1p, speech-to-text 0.5p, LLM 0.3p, compute and storage 0.2p. About 28p a call, about £12,600 a day at 180,000 minutes.',
      'Text-to-speech is about 70% of it. Recorded clips for fixed lines, shorter replies and a cheaper voice are the levers.',
      'Compute is small: 40 two-core workers at the surge.',
      'Hedged LLM requests add about 5%. The urgency classifier doubles LLM calls and is still under a fifth of a penny a minute.',
      'People: 24-hour on-call for a phone line; about two reviewers for a 1% sample (about 410 calls a day at 2 minutes each); onboarding engineers per council.',
      "The comparison a council will make is with a call handler's time. Do not quote a saving until the abandoned-call and transfer rates are known: a call the agent takes and then transfers costs both.",
    ],
    risks: [
      { risk: 'An urgent call is missed and someone is harmed.', answer: 'Recall gate on every release, the closing question, the after-call sweep, sampled review, and honest numbers given to the council. And the caller can always ask for a person.' },
      { risk: 'A council cuts duty staff because the agent exists, and the chain runs out more often.', answer: 'Agree staffing in the contract, show time-to-answer per hour, and alert both sides when chains are exhausted.' },
      { risk: 'The agent works worse for some accents or languages, and the average hides it.', answer: 'Measure recognition confidence and urgency recall by group where data allows; low confidence routes to a person; do not launch a language without its own test set.' },
      { risk: 'A provider outage or price change in the live path.', answer: 'Two providers per stage, tested on both every release; a scripted mode that needs no LLM; recorded clips that need no voice provider.' },
      { risk: 'Public trust: an AI on a crisis line is a headline waiting to happen.', answer: "Say it is an AI in the first sentence, offer a person in the same sentence, publish a transparency record, and measure the resident's side, not only minutes saved." },
      { risk: 'A caller manipulates the agent into disclosing something.', answer: 'Disclosure limits are in the tool service, not the prompt. No tool returns addresses or notes.' },
      { risk: 'Release pace against call safety.', answer: 'Scripts and prompts as data behind the same gate; workers drain; new versions take 5% of calls first.' },
      { risk: "The summary in the council's record is wrong.", answer: 'Marked as an AI draft, linked to transcript and audio, accepted by a member of staff. Track how often staff edit it.' },
    ],
  },

  rehearsal: [
    {
      stage: 'Clarify',
      minutes: 5,
      prompt: "Design an AI agent that answers a council's phone line, triages, and escalates urgent calls to a person. Ask before you draw.",
      cover: [
        'Which lines; what the agent may and may not do.',
        'What is urgent, who answers, what hours, what if they are busy.',
        'Languages, volume, Monday and storm peaks.',
        'Recording notice, objection, accessibility.',
        'State the rule: never block the way to a person.',
      ],
    },
    {
      stage: 'Numbers',
      minutes: 5,
      prompt: 'Size it, and say what the numbers tell you.',
      cover: [
        '45,000 calls a day, 4 minutes each, 450 at once, 1,500 at a surge.',
        '50 calls a worker, 40 workers.',
        '4% urgent: 1,800 a day; 1% of that missed is 18.',
        'About 1.1 seconds mouth to ear; about 250 ms of it is the phone network.',
        'Conclusion: small volume; the hard parts are latency, recall and handover.',
      ],
    },
    {
      stage: 'Draw',
      minutes: 15,
      prompt: 'Draw the system and walk one call through it.',
      cover: [
        "Caller, carrier, router with overflow to the council's queue.",
        'Media worker: session, brain, urgency monitor. One WebSocket per call; why not request and response.',
        'Streaming speech-to-text, LLM, text-to-speech, a second provider behind each.',
        'Tools and the council system; least disclosure.',
        'Handover service, the chain, the duty officer.',
        'Store, checkpoint per turn, after-call jobs, 120-day delete.',
      ],
    },
    {
      stage: 'Deep dives',
      minutes: 25,
      prompt: 'Take each in about five minutes: latency budget; urgency detection and threshold; warm transfer and no human free; stateful workers, scaling and deploys; a provider stalls mid-call.',
      cover: [
        'The seven stages of the budget and the one trick: start each stage before the last ends.',
        'Endpointing and barge-in.',
        'Three signals in parallel, any one fires; recall 99%, precision 50%; why 99% is not enough alone.',
        'Second call, spoken summary, press 1, join; the chain; the agent never hangs up first.',
        'Calls per worker, 30% spare, drain, scripts as data, crash and checkpoint.',
        'Deadlines of three times normal, second provider, recorded apology, transfer.',
      ],
    },
    {
      stage: 'Run it',
      minutes: 6,
      prompt: 'How do you ship it and know it is working?',
      cover: [
        'Shadow, then 10% behind a staffed desk, then ramp.',
        'Service levels: turn latency, flag to ring, recall gate, answered or overflowed.',
        'What pages: exhausted chains, latency, overflow, both providers down.',
        'Sampled review and the sweep for misses.',
        '7p a minute, mostly voice. Who owns what, including a practice lead.',
      ],
    },
    {
      stage: 'Your questions',
      minutes: 4,
      prompt: 'Ask them something worth their time.',
      cover: [
        'How does your agent decide a call is low-risk today, and who at a council signs that off?',
        'Where does a call go when the agent is unsure?',
        'What does the team measure on the resident\'s side?',
        'Which cloud is current?',
      ],
    },
  ],
};
