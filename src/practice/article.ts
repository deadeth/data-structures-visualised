/**
 * The tutorial behind a pairing practice page (`#/p/<id>/guide`): one long-form article, kept as Markdown in
 * `src/practice/<id>/guide.md` and turned here into a small typed tree. No DOM.
 *
 * Only this subset of Markdown is read:
 *
 *   # Title                         the first line, and only there
 *   ## 1. Overview                  a numbered section
 *   ### 3.1. Counting Failures      a numbered sub-section
 *   paragraphs                      lines joined until a blank line
 *   ```java ... ```                 Java, highlighted
 *   ``` ... ```                     plain characters: pictures and traces
 *   1. ordered and - bullet lists   one level, no nesting
 *   **bold**, `code`, [text](https://...)
 *
 * Anything else (tables, images, HTML, block quotes, nested lists, footnotes, rules, italics, other fences or
 * heading depths) is an error with its line number, never passed through as text.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'bold'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; href: string; children: Inline[] };

export type ArticleBlock =
  | { kind: 'heading'; level: 2 | 3; number: string; text: Inline[]; line: number }
  | { kind: 'paragraph'; text: Inline[]; line: number }
  | { kind: 'code'; lang: 'java' | null; lines: string[]; line: number }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][]; line: number };

export interface Article {
  title: Inline[];
  blocks: ArticleBlock[];
}

export interface ArticleError {
  /** 1-based line in the file. */
  line: number;
  message: string;
}

/** The words of inline content, without markup. */
export function plainOf(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.text : plainOf(n.children))).join('');
}

/** Inline markup in one run of text. Errors are pushed with the given line. */
export function parseInline(text: string, line: number, errors: ArticleError[]): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) {
        errors.push({ line, message: 'a ` is not closed' });
        buf += text.slice(i);
        break;
      }
      flush();
      out.push({ t: 'code', text: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end < 0 || end === i + 2) {
        errors.push({ line, message: '** is not closed' });
        i += 2;
        continue;
      }
      flush();
      out.push({ t: 'bold', children: parseInline(text.slice(i + 2, end), line, errors) });
      i = end + 2;
      continue;
    }
    const italicUnderscore = c === '_' && (i === 0 || /[\s(]/.test(text[i - 1])) && /^_[^\s_][^_]*_(?![\p{L}\p{N}])/u.test(text.slice(i));
    if (c === '*' || italicUnderscore) {
      errors.push({ line, message: c === '*' ? 'a single * (italics) is not in the subset; put a literal * in `code`' : 'italics (_text_) are not in the subset' });
      buf += c;
      i++;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      errors.push({ line, message: 'images are not in the subset' });
      buf += c;
      i++;
      continue;
    }
    if (c === '<' && /^<\/?[A-Za-z][^>]*>/.test(text.slice(i))) {
      errors.push({ line, message: 'HTML is not in the subset' });
      buf += c;
      i++;
      continue;
    }
    if (c === '[') {
      if (text[i + 1] === '^') errors.push({ line, message: 'footnotes are not in the subset' });
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[2], children: parseInline(m[1], line, errors) });
        i += m[0].length;
        continue;
      }
      if (/^\[[^\]]+\]\[[^\]]*\]/.test(text.slice(i))) errors.push({ line, message: 'reference links are not in the subset; write [text](https://...)' });
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const FENCE = /^```(.*)$/;
const BULLET = /^[-*+] +(.*)$/;
const ORDERED = /^(\d+)\. +(.*)$/;
const HEADING = /^(#{1,6})(?: +(.*))?$/;

/** Parse an article. `article` is set only when there are no errors. */
export function parseArticle(src: string): { article?: Article; errors: ArticleError[] } {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const errors: ArticleError[] = [];
  const blocks: ArticleBlock[] = [];
  let title: Inline[] = [];

  const first = /^# +(.+)$/.exec(lines[0] ?? '');
  if (!first) errors.push({ line: 1, message: 'the first line should be the title, written "# Title"' });
  else title = parseInline(first[1].trim(), 1, errors);

  let i = first ? 1 : 0;
  while (i < lines.length) {
    const raw = lines[i];
    const n = i + 1;
    const line = raw.trimEnd();
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code.
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      if (lang && lang !== 'java') errors.push({ line: n, message: `fence language "${lang}": only \`\`\`java or a bare \`\`\` is allowed` });
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trimEnd() !== '```') body.push(lines[j++].replace(/\s+$/, ''));
      if (j >= lines.length) {
        errors.push({ line: n, message: 'a code fence is not closed' });
        break;
      }
      blocks.push({ kind: 'code', lang: lang === 'java' ? 'java' : null, lines: body, line: n });
      i = j + 1;
      continue;
    }

    // Things outside the subset that start a line.
    const before = errors.length;
    if (/^\s*(?:~~~|```)/.test(raw)) errors.push({ line: n, message: 'a fence must start at the left edge, with ```' });
    else if (/^ {0,3}>/.test(raw)) errors.push({ line: n, message: 'block quotes are not in the subset' });
    else if (/^ {0,3}\|/.test(raw)) errors.push({ line: n, message: 'tables are not in the subset' });
    else if (/^ {0,3}([-*_])(?: *\1){2,} *$/.test(raw)) errors.push({ line: n, message: 'horizontal rules are not in the subset' });
    else if (/^ {0,3}<[A-Za-z/!]/.test(raw)) errors.push({ line: n, message: 'HTML is not in the subset' });
    else if (/^\[\^[^\]]+\]:/.test(raw)) errors.push({ line: n, message: 'footnotes are not in the subset' });
    else if (/^ {0,3}\[[^\]]+\]: /.test(raw)) errors.push({ line: n, message: 'reference link definitions are not in the subset' });
    else if (/^\s+(?:[-*+]|\d+\.) /.test(raw)) errors.push({ line: n, message: 'nested or indented list items are not in the subset' });
    else if (/^( {4}|\t)/.test(raw)) errors.push({ line: n, message: 'indented code is not in the subset; use a ``` fence' });
    if (errors.length > before) {
      i++;
      continue;
    }

    // Headings.
    const hd = HEADING.exec(line);
    if (hd) {
      const level = hd[1].length;
      const text = (hd[2] ?? '').trim();
      if (level === 1) errors.push({ line: n, message: 'only the first line may be a # title' });
      else if (level > 3) errors.push({ line: n, message: `${'#'.repeat(level)} headings are not in the subset; use ## or ###` });
      else {
        const num = level === 2 ? /^(\d+)\. +(.+)$/.exec(text) : /^(\d+\.\d+)\. +(.+)$/.exec(text);
        if (!num) errors.push({ line: n, message: level === 2 ? 'a ## heading should be numbered "## 1. Title"' : 'a ### heading should be numbered "### 1.1. Title"' });
        else blocks.push({ kind: 'heading', level: level as 2 | 3, number: num[1], text: parseInline(num[2], n, errors), line: n });
      }
      i++;
      continue;
    }
    if (/^(=+|-+) *$/.test(line) && i > 0 && lines[i - 1].trim()) {
      errors.push({ line: n, message: 'underlined headings are not in the subset' });
      i++;
      continue;
    }

    // Lists: items of one kind, one level, an item's text running on over unindented or indented lines.
    const b0 = BULLET.exec(line);
    const o0 = ORDERED.exec(line);
    if (b0 || o0) {
      const ordered = !!o0;
      const items: Inline[][] = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j].trimEnd();
        const b = BULLET.exec(l);
        const o = ORDERED.exec(l);
        if (!(ordered ? o : b)) break;
        let text = ordered ? o![2] : b![1];
        const at = j + 1;
        j++;
        while (j < lines.length && lines[j].trim() && !BULLET.exec(lines[j].trimEnd()) && !ORDERED.exec(lines[j].trimEnd()) && !FENCE.test(lines[j]) && !HEADING.test(lines[j])) {
          if (/^\s+(?:[-*+]|\d+\.) /.test(lines[j])) break;
          text += ` ${lines[j].trim()}`;
          j++;
        }
        items.push(parseInline(text.trim(), at, errors));
      }
      const next = lines[j]?.trimEnd() ?? '';
      if (next && (ordered ? BULLET.test(next) : ORDERED.test(next))) errors.push({ line: j + 1, message: 'a list changes kind without a blank line between' });
      blocks.push({ kind: 'list', ordered, start: ordered ? Number(o0![1]) : 1, items, line: n });
      i = j;
      continue;
    }

    // A paragraph: lines up to a blank line or the start of another block.
    let text = line.trim();
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j].trimEnd();
      if (!l.trim() || FENCE.test(l) || HEADING.test(l) || BULLET.test(l) || ORDERED.test(l)) break;
      if (/^ {0,3}(?:>|\|)/.test(lines[j]) || /^(=+|-+) *$/.test(l)) break;
      text += ` ${l.trim()}`;
      j++;
    }
    blocks.push({ kind: 'paragraph', text: parseInline(text, n, errors), line: n });
    i = j;
  }

  errors.sort((a, b) => a.line - b.line);
  return errors.length ? { errors } : { article: { title, blocks }, errors };
}

/** The `##` sections: number, title and the blocks under each, the heading first. */
export function sectionsOf(a: Article): { number: string; title: string; blocks: ArticleBlock[] }[] {
  const out: { number: string; title: string; blocks: ArticleBlock[] }[] = [];
  for (const b of a.blocks) {
    if (b.kind === 'heading' && b.level === 2) out.push({ number: b.number, title: plainOf(b.text), blocks: [b] });
    else out.at(-1)?.blocks.push(b);
  }
  return out;
}

/**
 * Faults in the numbering: `##` sections run 1..N without gaps, `###` sub-sections run `<section>.1`, `.2` ...
 * under their own section, the first section is "Overview", the last "Conclusion", and nothing comes before
 * the first section.
 */
export function numberingProblems(a: Article): string[] {
  const out: string[] = [];
  let sec = 0;
  let sub = 0;
  const firstHeading = a.blocks.findIndex((b) => b.kind === 'heading');
  if (firstHeading !== 0) out.push('the article should start with "## 1. Overview" straight after the title');
  for (const b of a.blocks) {
    if (b.kind !== 'heading') continue;
    if (b.level === 2) {
      sec++;
      sub = 0;
      if (b.number !== String(sec)) out.push(`line ${b.line}: section "${b.number}" should be ${sec}`);
    } else {
      sub++;
      if (b.number !== `${sec}.${sub}`) out.push(`line ${b.line}: sub-section "${b.number}" should be ${sec}.${sub}`);
    }
  }
  const secs = sectionsOf(a);
  if (secs[0] && secs[0].title !== 'Overview') out.push(`the first section is "${secs[0].title}"; it should be "Overview"`);
  if (secs.length && secs.at(-1)!.title !== 'Conclusion') out.push(`the last section is "${secs.at(-1)!.title}"; it should be "Conclusion"`);
  if (!secs.length) out.push('the article has no ## sections');
  return out;
}
