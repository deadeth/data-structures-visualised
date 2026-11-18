import type { Design } from './types';
import type { Extras } from './extras/types';

export interface DesignEntry {
  id: string;
  name: string;
  hint: string;
  /** The interview question this design answers, as it would be asked. Shown at the top of rehearsal mode and the crib. */
  question: string;
  load: () => Promise<Design>;
  /** The interview extras (opening, pushes, how to lead it, a timed rehearsal), when they have been written. */
  extras?: () => Promise<Extras>;
}

/** Every system design page. A design's data loads only when its page or the search needs it. */
export const DESIGNS: DesignEntry[] = [
  {
    id: 'web-crawler',
    name: 'Distributed web crawler',
    hint: 'Follow one URL round the crawl loop',
    question: 'Design a distributed web crawler.',
    load: () => import('./web-crawler').then((m) => m.webCrawler),
    extras: () => import('./extras/web-crawler').then((m) => m.extras),
  },
  {
    id: 'ledger',
    name: 'Ledger service',
    hint: 'Follow one Faster Payment through a strictly consistent ledger',
    question: 'Design a ledger service that must ensure strict consistency for account balances while supporting high-frequency transaction writes.',
    load: () => import('./ledger').then((m) => m.ledger),
    extras: () => import('./extras/ledger').then((m) => m.extras),
  },
  {
    id: 'fraud-alerts',
    name: 'Suspicious transaction alerts',
    hint: 'Follow one held payment to the owner and back',
    question: 'How would you design a notification system that alerts small business owners of suspicious transactions in real-time, considering varying user preferences?',
    load: () => import('./fraud-alerts').then((m) => m.fraudAlerts),
    extras: () => import('./extras/fraud-alerts').then((m) => m.extras),
  },
  {
    id: 'card-processing',
    name: 'Credit card processing system',
    hint: 'Follow one card purchase from tap to settlement',
    question: 'Design a credit card processing system.',
    load: () => import('./card-processing').then((m) => m.cardProcessing),
    extras: () => import('./extras/card-processing').then((m) => m.extras),
  },
  {
    id: 'ai-phone-agent',
    name: 'AI phone agent for a council helpline',
    hint: 'Follow one call from the ring to a person, or one turn in milliseconds',
    question: "How do you build a voice agent that answers a council's housing and social care line, replies within about a second, and gets a person on the line the moment a call is urgent?",
    load: () => import('./ai-phone-agent').then((m) => m.aiPhoneAgent),
    extras: () => import('./extras/ai-phone-agent').then((m) => m.extras),
  },
  {
    id: 'ai-case-notes',
    name: 'AI case notes pipeline',
    hint: 'Follow one recorded visit to a signed case note, or a council\'s data being deleted',
    question: 'A social worker records a 52-minute home visit on poor signal. How does it become a case note she has checked and signed, in minutes, without losing the audio, inventing a sentence or keeping anything past 120 days?',
    load: () => import('./ai-case-notes').then((m) => m.aiCaseNotes),
    extras: () => import('./extras/ai-case-notes').then((m) => m.extras),
  },
  {
    id: 'ai-notes-governance',
    name: 'Trustworthy AI notes across councils and countries',
    hint: 'Follow one note from a home visit to deletion, or a prompt release to its rollback',
    question: "How do you run AI note drafting for hundreds of councils in three countries so that data stays in its country, no council sees another's, every draft can be traced to what was said, and everything is gone on time?",
    load: () => import('./ai-notes-governance').then((m) => m.aiNotesGovernance),
    extras: () => import('./extras/ai-notes-governance').then((m) => m.extras),
  },
];

export const design = (id: string) => DESIGNS.find((d) => d.id === id);

/** Goes up by one each time a design joins after start-up (a locked page once opened), so the search index knows to rebuild. */
export let designsVersion = 0;

/** Add a design at run time, or replace one with the same id: how a locked page joins the site once opened. */
export function registerDesign(entry: DesignEntry): void {
  const i = DESIGNS.findIndex((d) => d.id === entry.id);
  if (i >= 0) DESIGNS[i] = entry;
  else DESIGNS.push(entry);
  designsVersion++;
}
