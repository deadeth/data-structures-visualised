# 0001. Static site: Vite, TypeScript, no UI framework, hash routing, GitHub Pages

Status: accepted (10 November 2026)

## Context
The site is a set of self-contained animated pages for one owner, hosted free, with no server.

## Decision
- Vite and TypeScript, no UI framework. A small `h()` helper in `src/core/dom.ts` builds DOM nodes.
- Hash routing (`#/s/<id>`, `#/d/<id>`, `#/search/<q>`, `#/compare`) so it works on GitHub Pages from any sub-path. `vite.config.ts` uses a relative `base`.
- Each structure page is loaded lazily from `src/structures/<id>/index.ts`; `src/catalog.ts` is the only registry.
- Fonts (Atkinson Hyperlegible Next and Mono) are self-hosted through `@fontsource-variable`.
- GitHub Actions runs tests and the build on every push to `main` and publishes `dist/`.

## Consequences
- No framework to learn or upgrade, and the bundle stays small.
- State handling is by hand. The two big renderers (`stage.ts`, `design-page.ts`) are long files.
- The font has no unslashed zero, which reviewers keep noticing in prose. Changing typeface is the only fix.
