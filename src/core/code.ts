/**
 * Example source code shown beside the animation.
 *
 * Each structure keeps one real, runnable file per language. Two kinds of
 * comment mark it up, and neither is shown to the reader:
 *
 *   # region insert        // region insert        start of a named block
 *   # endregion            // endregion            end of it
 *   x = y  #@place         x = y; //@place         this line is the "place" anchor
 *
 * An operation lists the regions it wants to show. Its frames name anchors,
 * and the panel highlights every line carrying one of them. The same anchor
 * names must exist in both languages, so one animation drives both listings.
 */
export type Lang = 'python' | 'java';

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
];

export interface Source {
  python: string;
  java: string;
}

export interface Listing {
  /** Lines as shown: markers stripped, each region dedented, one blank line between regions. */
  lines: string[];
  /** Anchor name to the indexes of the lines that carry it. */
  anchors: Map<string, number[]>;
}

const COMMENT: Record<Lang, string> = { python: '#', java: '//' };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patterns(lang: Lang) {
  const c = escape(COMMENT[lang]);
  return {
    region: new RegExp(`^\\s*${c}\\s*region\\s+([\\w-]+)\\s*$`),
    end: new RegExp(`^\\s*${c}\\s*endregion\\s*$`),
    anchor: new RegExp(`\\s*${c}@([\\w,-]+)\\s*$`),
  };
}

/** Every region in a source file, by name, with markers still in place. */
function regions(source: string, lang: Lang): Map<string, string[]> {
  const p = patterns(lang);
  const out = new Map<string, string[]>();
  let open: string | null = null;
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const start = p.region.exec(line);
    if (start) {
      open = start[1];
      if (!out.has(open)) out.set(open, []);
      continue;
    }
    if (p.end.test(line)) {
      open = null;
      continue;
    }
    if (open) out.get(open)!.push(line);
  }
  return out;
}

export function regionNames(source: string, lang: Lang): string[] {
  return [...regions(source, lang).keys()];
}

/** The listing for one operation: the named regions, in the order given. */
export function listing(source: string, lang: Lang, names: string[]): Listing {
  const p = patterns(lang);
  const all = regions(source, lang);
  const lines: string[] = [];
  const anchors = new Map<string, number[]>();
  for (const name of names) {
    const block = all.get(name);
    if (!block) throw new Error(`No ${lang} region called "${name}"`);
    // Trim blank lines at either end, then remove the indentation every line shares.
    let from = 0;
    let to = block.length;
    while (from < to && block[from].trim() === '') from++;
    while (to > from && block[to - 1].trim() === '') to--;
    const body = block.slice(from, to);
    const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length));
    if (lines.length) lines.push('');
    for (const raw of body) {
      let text = raw.slice(Number.isFinite(indent) ? Math.min(indent, raw.length - raw.trimStart().length) : 0);
      const mark = p.anchor.exec(text);
      if (mark) {
        text = text.slice(0, mark.index);
        for (const a of mark[1].split(',')) {
          if (!anchors.has(a)) anchors.set(a, []);
          anchors.get(a)!.push(lines.length);
        }
      }
      lines.push(text.replace(/\s+$/, ''));
    }
  }
  return { lines, anchors };
}

// ---- highlighting -----------------------------------------------------------

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'name';

export interface Token {
  text: string;
  kind: TokenKind;
}

const KEYWORDS: Record<Lang, Set<string>> = {
  python: new Set(
    'and as assert break class continue def del elif else except False finally for from if import in is lambda None nonlocal not or pass raise return self True try while with yield'.split(
      ' ',
    ),
  ),
  java: new Set(
    'abstract boolean break case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public record return static super switch this throw throws try var void while true false'.split(
      ' ',
    ),
  ),
};

/**
 * Split one line into tokens for colouring. Deliberately small: it knows
 * comments, strings, numbers, keywords and the name being defined, which is
 * all a short listing needs. Keep docstrings and block comments to one line.
 */
export function tokenise(line: string, lang: Lang): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  const comment = COMMENT[lang];
  let i = 0;
  let defining = false;
  const trimmed = line.trimStart();
  // A Javadoc or block comment line is all comment.
  if (lang === 'java' && (trimmed.startsWith('/*') || trimmed.startsWith('*'))) return line ? [{ text: line, kind: 'comment' }] : [];
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith(comment)) {
      push(rest, 'comment');
      break;
    }
    const str = /^("""[\s\S]*?"""|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(rest);
    if (str) {
      push(str[0], 'string');
      i += str[0].length;
      continue;
    }
    if (lang === 'python' && rest.startsWith('"""')) {
      push(rest, 'string');
      break;
    }
    const num = /^\d+(\.\d+)?/.exec(rest);
    if (num && !/[\w]/.test(line[i - 1] ?? '')) {
      push(num[0], 'number');
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(rest);
    if (word) {
      const w = word[0];
      if (KEYWORDS[lang].has(w)) {
        push(w, 'keyword');
        defining = w === 'def' || w === 'class' || w === 'record';
      } else if (defining || (lang === 'java' && /^\s*\(/.test(rest.slice(w.length)) && /(^|\s)(public|private|protected|static|void|boolean|int|[A-Z][\w<>,\s]*)\s+$/.test(line.slice(0, i)))) {
        push(w, 'name');
        defining = false;
      } else {
        push(w, 'plain');
      }
      i += w.length;
      continue;
    }
    push(line[i], 'plain');
    i++;
  }
  return out;
}

// ---- checks used by tests -----------------------------------------------------

/**
 * Problems with a structure's code listings, as sentences. Empty when all is
 * well. `used` maps each op id to the anchors its frames named.
 */
export function codeProblems(
  source: Source,
  ops: { id: string; code?: string[] }[],
  used: Map<string, Set<string>>,
): string[] {
  const problems: string[] = [];
  for (const op of ops) {
    if (!op.code) continue;
    const perLang = LANGS.map(({ id }) => {
      try {
        return listing(source[id], id, op.code!);
      } catch (e) {
        problems.push(`${op.id}: ${(e as Error).message}`);
        return null;
      }
    });
    if (perLang.some((l) => !l)) continue;
    const [py, java] = perLang as Listing[];
    for (const a of py.anchors.keys()) if (!java.anchors.has(a)) problems.push(`${op.id}: anchor "${a}" is in the Python listing but not the Java one`);
    for (const a of java.anchors.keys()) if (!py.anchors.has(a)) problems.push(`${op.id}: anchor "${a}" is in the Java listing but not the Python one`);
    for (const a of used.get(op.id) ?? []) {
      if (!py.anchors.has(a) || !java.anchors.has(a)) problems.push(`${op.id}: a frame names anchor "${a}", which its listing does not have`);
    }
  }
  return problems;
}
