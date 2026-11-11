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
  },
];

export const design = (id: string) => DESIGNS.find((d) => d.id === id);
