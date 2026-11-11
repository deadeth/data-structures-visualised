# Design review brief: the "Distributed web crawler" page

You are an independent design reviewer. The subject is one page of a public teaching site ("Data structures, visualised", for systems design interview preparation): an interactive high-level design of a distributed web crawler, at route `#/d/web-crawler`. Also in scope: the site search that looks things up on it (the search box in the sidebar, and `#/search/<query>`, for example `#/search/simhash`), and deep links into the page (`#/d/web-crawler/c/<component>`, `/f/<connection>`, `/g/<glossary-term>`, `/t/<tour step number>`). The other pages of the site are NOT in scope except as the design system this page should belong to.

What the page is meant to do: let a reader follow one URL round the crawl loop with a guided tour (a magenta token travels the connections; restart, back, play, next, speed; arrow keys, Space, Escape), open any component to see what it does, why it is there, numbers, how it fails, alternatives and what to say in an interview, and see HOW the parts talk: each connection carries a chip naming its method, line style encodes the mode with a legend, and connections open to explain the call. Below the diagram are notes, tables, a glossary and sources.

## How to look at it
- A built snapshot of the site is in a scratch folder the coordinator names (built into its dist/). Serve it yourself on a free port, for example with Node: `import { preview } from 'vite'` run from that folder with `preview({ preview: { port: 0, host: '127.0.0.1' } })`, then read the URL from `server.resolvedUrls`. Do not use a dev server on the repo: other people are editing it.
- Drive it with puppeteer-core and /usr/bin/google-chrome (`--no-sandbox`). Take real screenshots and look at them with the Read tool. Measure: contrast with numbers, text sizes in rendered pixels, overlaps by bounding boxes, overflow by scrollWidth, what is on screen on every step of the tour, focus order, the accessibility tree.
- Source for reference only (read, never edit): /home/claude/data-structures-visualised/src/ui/design-page.ts, src/ui/design.css, src/designs/web-crawler.ts, src/ui/search.ts, src/styles.css (design tokens).
- Sizes to check: 1920x1080, 1440x900, 1366x768, 1024x768, 768x1024, 390x844, and 844x390 landscape.

## Rules
- Do not edit anything in /home/claude/data-structures-visualised or the frozen build. No git commands. Write scripts and screenshots only in your own folder (given in your prompt).
- Other reviewers are working at the same time: use your own port, don't kill other processes.
- Judge what you see and measure. You have no history of this page and need none.

## Score six categories, each out of 10
1. Visual design and identity (including whether the diagram is clear or crowded)
2. Clarity: following the tour, the token, and how the parts communicate
3. Controls and interaction
4. Layout and responsiveness
5. Written content (component notes, connection notes, tables, glossary, tour text; also technical accuracy of the system design itself)
6. Accessibility (WCAG 2.2 AA)

9 means a professional product with only cosmetic leftovers; 10 means you could find nothing worth an hour of work. Be strict and fair. Any score under 9 must come with the specific changes that would bring it to 9.

## Report (your final message, plain text, under 800 words)
1. `SCORES: 1=<n> 2=<n> 3=<n> 4=<n> 5=<n> 6=<n>`
2. MUST changes (anything holding a category under 9): category, what you measured, where (size, selector or file if known), the concrete change.
3. NICE changes: short list.
4. What works well: three lines at most.
