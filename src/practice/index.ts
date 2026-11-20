import { javaPath } from './java';
import type { Guide, Practice } from './types';

/**
 * Every pairing practice page. A page is a folder, `src/practice/<id>/`, and is listed once it has a
 * `page.ts` (default export `Practice`); a folder with Java and no `page.ts` yet is not listed anywhere.
 * The guide is `src/practice/guide.ts` (default export `Guide`); until it exists `GUIDE` is undefined.
 *
 * The words are loaded with the site (the sidebar, home page and search need titles and summaries).
 * The Java is loaded only when a page opens: each file is its own small chunk, fetched as text.
 */
const pageFiles = import.meta.glob<{ default?: Practice }>('./*/page.ts', { eager: true });
const guideFiles = import.meta.glob<{ default?: Guide }>('./guide.ts', { eager: true });
const javaFiles = import.meta.glob<string>(['./*/starter/Solution.java', './*/solution/*/Solution.java'], { query: '?raw', import: 'default' });

/** The development fixture's id. It opens at `#/p/fixture-practice` in development only. */
export const FIXTURE_ID = 'fixture-practice';

export interface PracticeSources {
  /** `starter/Solution.java`, or '' when the folder has none. */
  starter: string;
  /** `solution/s<n>/Solution.java` by stage number. */
  stages: Map<number, string>;
}

export interface PracticeEntry {
  /** The folder name. */
  id: string;
  page: Practice;
  /** Whether `starter/Solution.java` exists. */
  hasStarter: boolean;
  /** The stage numbers that have a `solution/s<n>/Solution.java`, in order. */
  stageFiles: number[];
  /** Where the files are, for messages: `src/practice/<id>` or `src/practice/__fixtures__/<id>`. */
  dir: string;
  /** The Java, fetched on first call and kept. */
  sources(): Promise<PracticeSources>;
}

type Loaders = Record<string, () => Promise<string>>;

/** One entry from a page and the Java loaders of its folder (paths as the glob gives them). */
function makeEntry(id: string, page: Practice, java: Loaders, dir: string): PracticeEntry {
  const mine = Object.entries(java).flatMap(([path, load]) => {
    const p = javaPath(path);
    return p && p.id === id ? [{ stage: p.stage, load }] : [];
  });
  const starter = mine.find((f) => f.stage === 'starter');
  const stages = mine.filter((f): f is { stage: number; load: () => Promise<string> } => f.stage !== 'starter').sort((a, b) => a.stage - b.stage);
  let loaded: Promise<PracticeSources> | null = null;
  return {
    id,
    page,
    hasStarter: !!starter,
    stageFiles: stages.map((s) => s.stage),
    dir,
    sources: () =>
      (loaded ??= (async () => {
        const [st, ...rest] = await Promise.all([starter ? starter.load() : Promise.resolve(''), ...stages.map((s) => s.load())]);
        return { starter: st, stages: new Map(stages.map((s, i) => [s.stage, rest[i]])) };
      })()),
  };
}

const folderOf = (path: string) => /^\.\/([^/]+)\//.exec(path)?.[1] ?? '';

/** The guide, or undefined until `guide.ts` is written. */
export const GUIDE: Guide | undefined = Object.values(guideFiles)[0]?.default;

const rank = (id: string) => {
  const i = GUIDE?.order.indexOf(id) ?? -1;
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

/** Every listed page: the guide's order first, then the rest by title. Never the fixture. */
export const PRACTICES: PracticeEntry[] = Object.entries(pageFiles)
  .flatMap(([path, m]) => (m.default ? [makeEntry(folderOf(path), m.default, javaFiles, `src/practice/${folderOf(path)}`)] : []))
  .sort((a, b) => rank(a.id) - rank(b.id) || a.page.title.localeCompare(b.page.title));

/** Folders that hold Java, with or without a `page.ts`: the shape tests skip those without one. */
export const JAVA_FOLDERS: string[] = [...new Set(Object.keys(javaFiles).map(folderOf))].sort();

/** A listed page by id. */
export const practice = (id: string): PracticeEntry | undefined => PRACTICES.find((p) => p.id === id);

/**
 * A page by id for the router: a listed page, or in development the fixture. In a production build the
 * fixture's globs are dead code and are dropped, so neither its words nor its Java reach `dist/`.
 */
export async function loadPractice(id: string): Promise<PracticeEntry | undefined> {
  const found = practice(id);
  if (found || !import.meta.env.DEV) return found;
  const pages = import.meta.glob<{ default?: Practice }>('./__fixtures__/*/page.ts');
  const java = import.meta.glob<string>(['./__fixtures__/*/starter/Solution.java', './__fixtures__/*/solution/*/Solution.java'], { query: '?raw', import: 'default' });
  const path = `./__fixtures__/${id}/page.ts`;
  const load = pages[path];
  if (!load) return undefined;
  const page = (await load()).default;
  return page ? makeEntry(id, page, java, `src/practice/__fixtures__/${id}`) : undefined;
}

/** The title for the window and the sidebar. */
export function practiceTitle(id?: string): string | undefined {
  if (!id) return GUIDE?.title ?? 'Pairing practice';
  return practice(id)?.page.title;
}
