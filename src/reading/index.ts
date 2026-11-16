import type { Concept, Reading } from './types';

/**
 * Every reading page. A writer adds a page by adding one file:
 * `concepts/<id>.ts` (a Concept) or `walkthroughs/<design id>.ts` (a Reading), each with a default export.
 * Nothing else needs registering. Test files beside them are not pages.
 */
const conceptFiles = import.meta.glob<{ default?: Concept }>(['./concepts/*.ts', '!./concepts/*.test.ts'], { eager: true });
const walkthroughFiles = import.meta.glob<{ default?: Reading }>(['./walkthroughs/*.ts', '!./walkthroughs/*.test.ts'], { eager: true });

/** Sidebar order of the concept groups. */
export const CONCEPT_GROUPS: Concept['group'][] = ['Data', 'Messaging', 'Reliability', 'Interview craft'];

/** Where a page came from, so the validation test can name the file. */
export interface ReadingFile {
  file: string;
  kind: 'concept' | 'walkthrough';
  page: Reading;
}

const baseName = (path: string) => path.replace(/^.*\//, '').replace(/\.ts$/, '');

export const READING_FILES: ReadingFile[] = [
  ...Object.entries(conceptFiles).flatMap(([path, m]) => (m.default ? [{ file: `src/reading/${path.slice(2)}`, kind: 'concept' as const, page: m.default }] : [])),
  ...Object.entries(walkthroughFiles).flatMap(([path, m]) => (m.default ? [{ file: `src/reading/${path.slice(2)}`, kind: 'walkthrough' as const, page: m.default }] : [])),
];

const groupRank = (g: string) => {
  const i = CONCEPT_GROUPS.indexOf(g as Concept['group']);
  return i < 0 ? CONCEPT_GROUPS.length : i;
};

/** Concept pages, sorted by group (in sidebar order), then by title. */
export const CONCEPTS: Concept[] = Object.values(conceptFiles)
  .flatMap((m) => (m.default ? [m.default] : []))
  .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.title.localeCompare(b.title));

/** Design walkthroughs, keyed by design id: the file's name, which is also the design page's id. */
export const WALKTHROUGHS: Map<string, Reading> = new Map(
  Object.entries(walkthroughFiles).flatMap(([path, m]) => (m.default ? [[baseName(path), m.default] as const] : [])),
);

export const concept = (id: string): Concept | undefined => CONCEPTS.find((c) => c.id === id);
export const walkthrough = (designId: string): Reading | undefined => WALKTHROUGHS.get(designId);

/** Inline markup reduced to its words, for search and for labels: **bold**, `code` and [label](#/...) lose their marks. */
export function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\((#\/[^)\s]*)\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}
