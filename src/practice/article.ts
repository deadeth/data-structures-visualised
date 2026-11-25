/**
 * The tutorial behind a pairing practice page (`#/p/<id>/guide`): one long-form article, kept as Markdown in
 * `src/practice/<id>/guide.md` and turned here into a small typed tree. No DOM.
 *
 * Only this subset of Markdown is read:
 *
 *   # Title                         the first line, and only there
 *   *An all-italic paragraph.*      straight under the title: the standfirst
 *   ## 1. Overview                  a numbered section
 *   ### 3.1. Counting Failures      a numbered sub-section
 *   paragraphs                      lines joined until a blank line
 *   ---                             a rule, after a blank line (also *** or ___)
 *   ```java ... ```                 Java, highlighted
 *   ``` ... ``` or ```text ... ```  plain characters: pictures and traces
 *   1. ordered and - or * bullets   one level, no nesting
 *   | a | b | over | --- | --- |    a pipe table: a header row, a separator row, body rows
 *   **bold**, *italic*, `code`, [text](https://...)
 *
 * Leading and trailing blank lines inside a fence are dropped. Anything else (images, HTML, block quotes,
 * nested lists, footnotes, _underscore_ italics, other fences or heading depths) is an error with its line
 * number, never passed through as text.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'bold'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; href: string; children: Inline[] };

export type ArticleBlock =
  | { kind: 'heading'; level: 2 | 3; number: string; text: Inline[]; line: number }
  | { kind: 'paragraph'; text: Inline[]; line: number }
  /** `lines` has no blank lines at either end; `first` is the file line of `lines[0]`. */
  | { kind: 'code'; lang: 'java' | null; lines: string[]; line: number; first: number }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][]; line: number }
  /**
   * A rule. `shown` is false where it would only double a divider the page draws anyway: straight after the
   * standfirst or at the start, straight before a `##` heading, or at the end.
   */
  | { kind: 'rule'; shown: boolean; line: number }
  /** Rows are kept as written; a row with more or fewer cells than the head is for the checks to report. */
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][]; line: number };

export interface Article {
  title: Inline[];
  /** An all-italic first paragraph under the title, without its italics. */
  standfirst?: Inline[];
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

/** Where a code span opened at `i` closes, or -1. */
const codeEnd = (text: string, i: number) => text.indexOf('`', i + 1);

/**
 * Where emphasis opened at `i` (with `**` or `*`) closes, or -1. Code spans inside are skipped, so a `*` in
 * code never closes it; inside italics a `**...**` pair is skipped too. The closing mark follows a non-space.
 */
function emphasisEnd(text: string, i: number, mark: '**' | '*'): number {
  let j = i + mark.length;
  while (j < text.length) {
    if (text[j] === '`') {
      const e = codeEnd(text, j);
      if (e < 0) return -1;
      j = e + 1;
      continue;
    }
    if (mark === '**' && text.startsWith('**', j)) return /\s/.test(text[j - 1]) ? -1 : j;
    if (mark === '*' && text.startsWith('**', j)) {
      const e = emphasisEnd(text, j, '**');
      if (e < 0) return -1;
      j = e + 2;
      continue;
    }
    if (mark === '*' && text[j] === '*') return /\s/.test(text[j - 1]) ? -1 : j;
    j++;
  }
  return -1;
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
      const end = codeEnd(text, i);
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
      const end = /\s/.test(text[i + 2] ?? ' ') ? -1 : emphasisEnd(text, i, '**');
      if (end < 0) {
        errors.push({ line, message: '** is not closed' });
        i += 2;
        continue;
      }
      flush();
      out.push({ t: 'bold', children: parseInline(text.slice(i + 2, end), line, errors) });
      i = end + 2;
      continue;
    }
    if (c === '*') {
      const end = /\s/.test(text[i + 1] ?? ' ') ? -1 : emphasisEnd(text, i, '*');
      if (end < 0) {
        errors.push({ line, message: 'a * (italics) is not closed; put a literal * in `code`' });
        buf += c;
        i++;
        continue;
      }
      flush();
      out.push({ t: 'em', children: parseInline(text.slice(i + 1, end), line, errors) });
      i = end + 1;
      continue;
    }
    if (c === '_' && (i === 0 || /[\s(]/.test(text[i - 1])) && /^_[^\s_][^_]*_(?![\p{L}\p{N}])/u.test(text.slice(i))) {
      errors.push({ line, message: 'italics with _ are not in the subset; write *text*' });
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
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const TABLE_ROW = /^ {0,3}\|/;
const SETEXT = /^(=+|-+) *$/;

/** The cells of one table row: split at pipes outside code spans (`\|` is a literal pipe), outer pipes dropped. */
export function tableCells(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let code = false;
  const t = row.trim();
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cell += c;
    } else if (c === '|' && !code) {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  if (t.startsWith('|')) cells.shift();
  if (t.endsWith('|') && !t.endsWith('\\|') && cells.length) cells.pop();
  return cells.map((x) => x.trim());
}

const SEPARATOR_CELL = /^:?-+:?$/;

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
      if (lang && lang !== 'java' && lang !== 'text') errors.push({ line: n, message: `fence language "${lang}": only \`\`\`java, \`\`\`text or a bare \`\`\` is allowed` });
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trimEnd() !== '```') body.push(lines[j++].replace(/\s+$/, ''));
      if (j >= lines.length) {
        errors.push({ line: n, message: 'a code fence is not closed' });
        break;
      }
      let firstLine = n + 1;
      while (body.length && !body[0].trim()) {
        body.shift();
        firstLine++;
      }
      while (body.length && !body.at(-1)!.trim()) body.pop();
      blocks.push({ kind: 'code', lang: lang === 'java' ? 'java' : null, lines: body, line: n, first: firstLine });
      i = j + 1;
      continue;
    }

    // A rule: after a blank line, so it cannot be read as underlining the line above.
    if (RULE.test(raw) && (i === 0 || !lines[i - 1].trim())) {
      blocks.push({ kind: 'rule', shown: true, line: n });
      i++;
      continue;
    }

    // A pipe table: a header row, a separator row, then body rows, up to the first line not starting with a pipe.
    if (TABLE_ROW.test(raw)) {
      const head = tableCells(line);
      const sep = lines[i + 1] !== undefined && TABLE_ROW.test(lines[i + 1]) ? tableCells(lines[i + 1].trimEnd()) : null;
      if (!sep || !sep.every((c) => SEPARATOR_CELL.test(c))) {
        errors.push({ line: n, message: 'a table needs a separator row such as | --- | --- | straight under its header row' });
        i++;
        while (i < lines.length && TABLE_ROW.test(lines[i])) i++;
        continue;
      }
      if (sep.length !== head.length) errors.push({ line: n + 1, message: `the separator row has ${sep.length} cells; the header has ${head.length}` });
      const rows: Inline[][][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) {
        const at = j + 1;
        rows.push(tableCells(lines[j].trimEnd()).map((c) => parseInline(c, at, errors)));
        j++;
      }
      if (j < lines.length && lines[j].trim()) errors.push({ line: j + 1, message: 'a table should be followed by a blank line' });
      blocks.push({ kind: 'table', head: head.map((c) => parseInline(c, n, errors)), rows, line: n });
      i = j;
      continue;
    }

    // Things outside the subset that start a line.
    const before = errors.length;
    if (/^\s*(?:~~~|```)/.test(raw)) errors.push({ line: n, message: 'a fence must start at the left edge, with ```' });
    else if (/^ {0,3}>/.test(raw)) errors.push({ line: n, message: 'block quotes are not in the subset' });
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
    if (SETEXT.test(line) && i > 0 && lines[i - 1].trim()) {
      errors.push({ line: n, message: 'underlined headings are not in the subset' });
      i++;
      continue;
    }
    if (RULE.test(raw)) {
      errors.push({ line: n, message: 'a rule needs a blank line above it' });
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
          if (/^\s+(?:[-*+]|\d+\.) /.test(lines[j]) || TABLE_ROW.test(lines[j]) || RULE.test(lines[j])) break;
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
      if (/^ {0,3}(?:>|\|)/.test(lines[j]) || SETEXT.test(l) || RULE.test(l)) break;
      text += ` ${l.trim()}`;
      j++;
    }
    blocks.push({ kind: 'paragraph', text: parseInline(text, n, errors), line: n });
    i = j;
  }

  // The standfirst: a first paragraph that is one run of italics, straight under the title.
  let standfirst: Inline[] | undefined;
  const lead = blocks[0];
  if (lead?.kind === 'paragraph' && lead.text.length === 1 && lead.text[0].t === 'em') {
    standfirst = lead.text[0].children;
    blocks.shift();
  }
  // A rule shows only where it divides something the page does not divide already.
  blocks.forEach((b, k) => {
    if (b.kind !== 'rule') return;
    const prev = blocks[k - 1];
    const next = blocks[k + 1];
    if (!prev || prev.kind === 'rule' || !next || (next.kind === 'heading' && next.level === 2)) b.shown = false;
  });

  errors.sort((a, b) => a.line - b.line);
  return errors.length ? { errors } : { article: { title, ...(standfirst ? { standfirst } : {}), blocks }, errors };
}

/**
 * The standfirst with its pointer back made a link: in its last run of text, the words after "Back to the
 * practice page: " up to the final full stop link to `href`. The words stay as written. Unchanged when the
 * phrase is not there.
 */
export function linkBack(nodes: Inline[], href: string): Inline[] {
  const k = nodes.length - 1;
  const last = nodes[k];
  if (!last || last.t !== 'text') return nodes;
  const m = /^([\s\S]*Back to the practice page: )([\s\S]*[^\s.])(\.?\s*)$/.exec(last.text);
  if (!m) return nodes;
  const out: Inline[] = [...nodes.slice(0, k), { t: 'text', text: m[1] }, { t: 'link', href, children: [{ t: 'text', text: m[2] }] }];
  if (m[3]) out.push({ t: 'text', text: m[3] });
  return out;
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
  // Rules before the first section are allowed: they draw nothing there.
  const firstHeading = a.blocks.findIndex((b) => b.kind !== 'rule');
  if (firstHeading < 0 || a.blocks[firstHeading].kind !== 'heading') out.push('the article should start with "## 1. Overview" straight after the title');
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
