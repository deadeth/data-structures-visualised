/**
 * Pages whose content ships only as an encrypted file. Each entry names the design ids the file
 * holds (with their extras and walkthroughs) and where the file is served. The page is listed as
 * `label` until it is opened. scripts/lock/lock.mjs writes the files; see scripts/lock/README.md.
 */
export interface LockedEntry {
  /** Design ids whose design, extras and walkthrough are in this file. */
  ids: string[];
  /** Path of the encrypted file under the site's base (the file lives in `public/`). */
  blob: string;
  /** What the sidebar shows until the page is opened. */
  label: string;
}

export const LOCKED: LockedEntry[] = [{ ids: ['money-moved-dashboard'], blob: 'locked/a1.bin', label: 'Locked page' }];

/** The entry that holds a design id, if that id is locked. */
export const lockedEntry = (id: string): LockedEntry | undefined => LOCKED.find((e) => e.ids.includes(id));

/** Every locked design id. */
export const LOCKED_IDS: string[] = LOCKED.flatMap((e) => e.ids);

/** The file's address, under Vite's base path. */
export const blobUrl = (e: LockedEntry): string => `${import.meta.env.BASE_URL}${e.blob}`;
