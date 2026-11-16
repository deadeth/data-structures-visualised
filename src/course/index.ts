import type { Course } from './types';

/**
 * The course, loaded on demand. `course.ts` is found with `import.meta.glob`, so the site builds
 * whether or not the file exists yet. Until it does, the course page says the course is being
 * written; in development (`npm run dev`) it shows the fixture instead, so the page can be worked on.
 * The file may export the course as its default or as `course`.
 */
type CourseModule = { default?: Course; course?: Course };
const real = import.meta.glob<CourseModule>('./course.ts');
const fixture = import.meta.glob<CourseModule>('./__fixtures__/fixture-course.ts');

/** True when `src/course/course.ts` exists. */
export const COURSE_WRITTEN = Object.keys(real).length > 0;

let cached: Promise<Course | null> | null = null;

/** The course, or null while it is being written. */
export function loadCourse(): Promise<Course | null> {
  cached ??= (async () => {
    const pick = async (files: Record<string, () => Promise<CourseModule>>) => {
      const load = Object.values(files)[0];
      if (!load) return null;
      const m = await load();
      return m.default ?? m.course ?? null;
    };
    const c = await pick(real);
    if (c) return c;
    // A course that cannot be read in development falls back to the fixture; in the built site it reads "being written".
    return import.meta.env.DEV && !import.meta.env.VITEST ? pick(fixture) : null;
  })();
  return cached;
}
