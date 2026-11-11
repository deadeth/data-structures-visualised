import type { Design } from './types';

/** Every system design page. A design's data loads only when its page or the search needs it. */
export const DESIGNS: { id: string; name: string; hint: string; load: () => Promise<Design> }[] = [
  {
    id: 'web-crawler',
    name: 'Distributed web crawler',
    hint: 'Follow one URL round the crawl loop',
    load: () => import('./web-crawler').then((m) => m.webCrawler),
  },
  {
    id: 'ledger',
    name: 'Ledger service',
    hint: 'Follow one Faster Payment through a strictly consistent ledger',
    load: () => import('./ledger').then((m) => m.ledger),
  },
  {
    id: 'fraud-alerts',
    name: 'Suspicious transaction alerts',
    hint: 'Follow one held payment to the owner and back',
    load: () => import('./fraud-alerts').then((m) => m.fraudAlerts),
  },
];

export const design = (id: string) => DESIGNS.find((d) => d.id === id);
