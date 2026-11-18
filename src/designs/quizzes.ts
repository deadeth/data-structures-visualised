import type { Quiz } from './quiz/types';

/**
 * Every design's test, one file per design in `quiz/<design id>.ts` exporting `quiz`. Loaded only when its page opens;
 * the file names alone say which designs have one.
 */
const FILES = import.meta.glob<{ quiz: Quiz }>(['./quiz/*.ts', '!./quiz/types.ts', '!./quiz/mark.ts', '!./quiz/*.test.ts']);

const loaders = new Map<string, () => Promise<{ quiz: Quiz }>>();
for (const [path, load] of Object.entries(FILES)) loaders.set(/\/([^/]+)\.ts$/.exec(path)![1], load);

/** Whether this design has a test, without loading it. */
export const hasQuiz = (id: string): boolean => loaders.has(id);

/** The design's test, or undefined when none is written. */
export async function loadQuiz(id: string): Promise<Quiz | undefined> {
  const load = loaders.get(id);
  return load ? (await load()).quiz : undefined;
}
