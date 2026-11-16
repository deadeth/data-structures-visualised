# Locked pages

Some design pages are readable only with a password. Their source lives in `private/`, which git ignores. The repo and the built site hold only encrypted copies.

| File | What it is | Committed |
| --- | --- | --- |
| `private/` | The locked pages' source: `designs/<id>.ts`, `designs/extras/<id>.ts`, `reading/walkthroughs/<id>.ts`, and `designs/entries.ts` (sidebar name, hint and interview question for each id) | No |
| `public/locked/<name>.bin` | What the browser opens: the designs, extras and walkthroughs of one manifest entry | Yes |
| `locked/source.bin` | Every file under `private/`, so the source can be restored on any clone | Yes |
| `src/locked/manifest.ts` | Which design ids are locked, and which `.bin` holds them | Yes |

Both `.bin` files are JSON: `{ v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, salt, iv, ct }`, base64, where `ct` is AES-256-GCM under a key derived from the password with PBKDF2-SHA256. Each run of `lock.mjs` uses a fresh salt and IV.

## Restore the source on a new clone

```
LOCK_PASSWORD='…' node scripts/lock/unlock.mjs
```

It writes `private/`. A file there that differs from the sealed copy and was changed after `locked/source.bin` was written is left alone and named; add `--force` to overwrite it.

## Edit a locked page and seal it again

1. Edit the files in `private/`. They import their types from `src/` by the same relative paths as before, so the type imports do not resolve there; `tsc` does not check `private/`. To type-check a change, copy the file into `src/` for a moment, run `npx tsc --noEmit`, and delete the copy.
2. Seal:

   ```
   LOCK_PASSWORD='…' node scripts/lock/lock.mjs
   ```

   This replaces `public/locked/*.bin` and `locked/source.bin`.
3. Run `npx vitest run`: `src/locked/bundle.test.ts` builds the site and fails if any plain text from `private/` reached the build.
4. Commit both `.bin` files. Never commit `private/`.

To lock another design, move its three files into `private/` the same way, add its id to an entry in `src/locked/manifest.ts` and its details to `private/designs/entries.ts`, remove it from `src/designs/index.ts`, then seal.

## In the browser

Any address under a locked id shows a password form. A right password registers the pages into the site's own registries (`registerDesign` in `src/designs/index.ts`, `registerWalkthrough` in `src/reading/index.ts`), renames the sidebar entry, and keeps the password in `sessionStorage` so the tab stays open until it is closed. Search and the home page include the pages only after that.
