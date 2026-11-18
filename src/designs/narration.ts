/**
 * Recorded narration for design tours: what each step says, how it is written for a voice, and a hash
 * that ties a recorded clip to the words it was made from. Shared by the page (src/ui/design-audio.ts)
 * and the render script (scripts/audio/render.mjs), so both agree on the words and the hash.
 */
import type { TourStep } from './types';

/** The words spoken for step `n` (1-based): its title, its text, then the story's problem, consequence and fix. */
export function narrationOf(step: TourStep, n: number): string {
  const end = (t: string) => (/[.!?]["')]?$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
  const parts = [`Step ${n}. ${end(step.title)}`, end(step.text)];
  if (step.story) {
    const { context, problem, consequence, fix } = step.story;
    // The context often opens the way the step's text does; then it is said once.
    const head = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '').split(/\s+/).slice(0, 6).join(' ');
    if (context && head(context) !== head(step.text)) parts.push(end(context));
    for (const t of [problem, consequence, fix]) if (t) parts.push(end(t));
  }
  return parts.join('\n\n');
}

/** FNV-1a, 32 bits, over the UTF-16 code units, as 8 hex digits. The same in Node and the browser. */
export function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---- spoken: text rewritten for a voice -----------------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A whole number from 0 to 999,999 in words, British style ("one hundred and five"). */
export function words(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${words(n % 100)}` : ''}`;
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  return `${words(th)} thousand${rest ? (rest < 100 ? ' and ' : ' ') + words(rest) : ''}`;
}

const ORD: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
function ordinal(n: number): string {
  const w = words(n);
  const m = w.match(/([a-z]+)$/)!;
  const last = m[1];
  const o = ORD[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return w.slice(0, -last.length) + o;
}

/** Each character of an identifier said on its own: "a1f3" to "a one f three". */
const spell = (s: string) => s.split('').map((c) => (/\d/.test(c) ? ONES[Number(c)] : /a/i.test(c) ? 'eh' : c.toUpperCase())).join(' ');

/** Digits said one by one, for codes, ids and slot-like numbers with leading zeros. */
const digits = (s: string) => s.split('').map((c) => ONES[Number(c)]).join(' ');

/** A time like 10:20:09 or 10:21 said as a clock time. */
function clock(h: string, m: string, s?: string): string {
  const hh = Number(h);
  const mm = Number(m);
  const mins = mm === 0 ? "o'clock" : mm < 10 ? `oh ${words(mm)}` : words(mm);
  const head = mm === 0 ? `${words(hh)} o'clock` : `${words(hh)} ${mins}`;
  const ss = Number(s ?? 0);
  if (!ss) return head;
  return `${head} and ${words(ss)} second${ss === 1 ? '' : 's'}`;
}

/**
 * Words a voice says badly, and what to say instead. Whole words only, case as written.
 * Longer keys first where one contains another (applied in order).
 */
const SAY: [RegExp, string][] = [
  [/\bRocksDB\b/g, 'Rocks D B'],
  [/\bScyllaDB\b/g, 'Silla D B'],
  [/\bDynamoDB\b/g, 'Dynamo D B'],
  [/\bMongoDB\b/g, 'Mongo D B'],
  [/\bDuckDB\b/g, 'Duck D B'],
  [/\bTigerBeetle\b/g, 'Tiger Beetle'],
  [/\bPostgreSQL\b/g, 'Postgres Q L'],
  [/\bMySQL\b/g, 'My S Q L'],
  [/\bNoSQL\b/g, 'No S Q L'],
  [/\bSQL\b/g, 'S Q L'],
  [/\bgRPC\b/g, 'g R P C'],
  [/\bSimHash\b/g, 'Sim hash'],
  [/\bMinHash\b/g, 'Min hash'],
  [/\bWARCs\b/g, 'warks'],
  [/\bWARC\b/g, 'wark'],
  [/\bwarcs\b/g, 'warks'],
  [/\bwarc\b/g, 'wark'],
  [/\bURLs\b/g, 'U R Ls'],
  [/\bURL\b/g, 'U R L'],
  [/\bURIs\b/g, 'U R Is'],
  [/\bURI\b/g, 'U R I'],
  [/\bAPIs\b/g, 'A-P-Is'],
  [/\bAPI\b/g, 'A-P-I'],
  [/\bDNS\b/g, 'D N S'],
  [/\bHTTPS\b/g, 'H T T P S'],
  [/\bHTTP\/2\b/g, 'H T T P two'],
  [/\bHTTP\b/g, 'H T T P'],
  [/\bHTML\b/g, 'H T M L'],
  [/\bCSS\b/g, 'C S S'],
  [/\bJSON\b/g, 'Jason'],
  [/\bJS\b/g, 'JavaScript'],
  [/\bIPs\b/g, 'I Ps'],
  [/\bIPv4\b/g, 'I P v four'],
  [/\bIPv6\b/g, 'I P v six'],
  [/\bIP\b/g, 'I P'],
  [/\bTCP\b/g, 'T C P'],
  [/\bTLS\b/g, 'T L S'],
  [/\bTTLs\b/g, 'T T Ls'],
  [/\bTTL\b/g, 'T T L'],
  [/\bKMS\b/g, 'K M S'],
  [/\bS3\b/g, 'S three'],
  [/\bGCS\b/g, 'G C S'],
  [/\bAWS\b/g, 'A-W-S'],
  [/\bCDN\b/g, 'C D N'],
  [/\bCPUs\b/g, 'C P Us'],
  [/\bCPU\b/g, 'C P U'],
  [/\bGPUs\b/g, 'G P Us'],
  [/\bGPU\b/g, 'G P U'],
  [/\bSSDs\b/g, 'S S Ds'],
  [/\bSSD\b/g, 'S S D'],
  [/\bNVMe\b/g, 'N V M E'],
  [/\bGB\b/g, 'gigabytes'],
  [/\bTB\b/g, 'terabytes'],
  [/\bPB\b/g, 'petabytes'],
  [/\bMB\b/g, 'megabytes'],
  [/\bKB\b/g, 'kilobytes'],
  [/\bGbit\/s\b/g, 'gigabits a second'],
  [/\bMbit\/s\b/g, 'megabits a second'],
  [/\bms\b/g, 'milliseconds'],
  [/\bLLMs\b/g, 'L L Ms'],
  [/\bLLM\b/g, 'L L M'],
  [/\bSLA\b/g, 'S-L-A'],
  [/\bSLO\b/g, 'S L O'],
  [/\bUUID\b/g, 'U U I D'],
  [/\bUTC\b/g, 'U T C'],
  [/\bUTF-8\b/g, 'U T F eight'],
  [/\bETag\b/g, 'E tag'],
  [/\bPOST\b/g, 'post'],
  [/\bGET\b/g, 'get'],
  [/\bPUT\b/g, 'put'],
  [/\bHEAD\b/g, 'head'],
  [/\bOK\b/g, 'okay'],
  [/\bCRC\b/g, 'C R C'],
  [/\bFNV\b/g, 'F N V'],
  [/\bSHA[- ]?256\b/g, 'shah two five six'],
  [/\bAES\b/g, 'A-E-S'],
  [/\bPCI\b/g, 'P C I'],
  [/\bFSCS\b/g, 'F S C S'],
  [/\bKYC\b/g, 'K Y C'],
  [/\bETL\b/g, 'E T L'],
  [/\bOLTP\b/g, 'O L T P'],
  [/\bOLAP\b/g, 'O L A P'],
  [/\bACID\b/g, 'acid'],
  [/\bCDC\b/g, 'C D C'],
  [/\bRPC\b/g, 'R P C'],
  [/\bRPS\b/g, 'requests a second'],
  [/\bQPS\b/g, 'queries a second'],
  [/\bk8s\b/g, 'Kubernetes'],
  [/\bKafka\b/g, 'Kafka'],
  [/\bCassandra\b/g, 'Cassandra'],
  [/\betcd\b/g, 'et C D'],
  [/\bZooKeeper\b/g, 'Zoo Keeper'],
  [/\bRedis\b/g, 'Reddis'],
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const date = (y: string, m: string, d: string) => `the ${ordinal(Number(d))} of ${MONTHS[Number(m) - 1]} ${y}`;

/** Words of a host name: "Example.org" to "example dot org". */
function sayHost(host: string): string {
  return host.toLowerCase().split('.').map((p) => (p === 'www' ? 'w w w' : p === 'uk' ? 'u k' : p)).join(' dot ');
}

const EXT: Record<string, string> = { txt: 't x t', json: 'Jason', gz: 'g z', ts: 't s', md: 'm d', py: 'p y', warc: 'wark', xml: 'x m l', html: 'h t m l', csv: 'c s v', onnx: 'onyx', mp3: 'm p three', bin: 'bin' };
/** One piece of a name with dots in it: "000183.warc.gz" to "000183 dot wark dot g z". */
const sayDotted = (seg: string) => seg.split('.').map((p, i) => (i > 0 && EXT[p.toLowerCase()] ? EXT[p.toLowerCase()] : p)).join(' dot ');

/**
 * An address said aloud: "https://example.org/news" to "example dot org slash news",
 * "HTTPS://Example.org:443/about#team" to "example dot org port 443 slash about hash team".
 * The scheme is dropped: every address in the tours is a web address.
 */
function sayAddress(a: string): string {
  let rest = a.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  let frag = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    frag = ` hash ${rest.slice(hash + 1)}`;
    rest = rest.slice(0, hash);
  }
  const hadScheme = rest !== a.replace(/#.*$/, '') || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/|$)/i.test(rest);
  const parts = rest.split('/');
  const out: string[] = [];
  parts.forEach((seg, i) => {
    if (i === 0) {
      if (!seg) return;
      const [h, port] = seg.split(':');
      out.push(hadScheme && /\./.test(h) ? sayHost(h) + (port ? ` port ${port}` : '') : sayDotted(seg));
      return;
    }
    out.push(seg ? `slash ${sayDotted(seg.replace(/[{}]/g, '').replace(/_/g, ' '))}` : 'slash');
  });
  // A trailing "/" makes an empty last segment: "slash" once is enough.
  return (out.join(' ').replace(/(slash )+slash$/, 'slash') + frag).replace(/^slash slash$/, 'slash').trim();
}

/**
 * Rewrites written text so a speech engine reads it naturally: symbols, numbers, times, addresses, paths,
 * identifiers and abbreviations. Used only by the render script; the page hashes the written text.
 * Each rule was checked against the phonemes the voice's engine (espeak-ng, through Piper) produces.
 */
export function spoken(input: string): string {
  let t = input;

  // Code in backticks: the ticks go; what is inside is handled like any other text below.
  t = t.replace(/`([^`]*)`/g, '$1');
  // Latin abbreviations, before anything reads their dots as names.
  t = t.replace(/\be\.g\.,?\s*/g, 'for example, ').replace(/\bi\.e\.,?\s*/g, 'that is, ').replace(/\betc\./g, 'and so on.').replace(/\bvs\.?\s/g, 'versus ');
  // max(a, b, c) and min(...): said as words.
  t = t.replace(/\bmax\(([^)]*)\)/g, 'the largest of $1').replace(/\bmin\(([^)]*)\)/g, 'the smallest of $1');
  // Timestamps: 2026-11-12T10 (an hour bucket), 20261112T105500Z, 2026-11-12.
  t = t.replace(/\b(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\b/g, (_m, y, mo, d, h, mi, s) => `${date(y, mo, d)}, ${clock(h, mi, s)}`);
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})T(\d{2})\b/g, (_m, y, mo, d, h) => `${date(y, mo, d)}, hour ${Number(h)}`);
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y, mo, d) => date(y, mo, d));
  // IPv4 addresses and ranges: 10.0.0.0/8 to "10 dot 0 dot 0 dot 0 slash 8".
  t = t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?\b/g, (_m, a, b, c, d, n) => `${a} dot ${b} dot ${c} dot ${d}${n ? ` slash ${n}` : ''}`);
  // A name and version: ExampleBot/1.0 to "Example Bot version 1.0".
  t = t.replace(/\b([A-Z][a-z]+)([A-Z][a-z]+)\/(\d+(?:\.\d+)*)\b/g, '$1 $2 version $3');
  // Addresses and paths: any word with a slash in it (not a/b fractions or units), or a scheme.
  t = t.replace(/(?:[a-z][a-z0-9+.-]*:\/\/)?[A-Za-z0-9._{}#:-]*\/[A-Za-z0-9._{}#:/-]*/gi, (m) => {
    if (/^\d+\/\d+$/.test(m) || /^[A-Za-z]+\/s$/.test(m) || /^[a-z]+\/[a-z]+$/i.test(m) && !/^[a-z0-9-]+\.[a-z]/i.test(m) && !m.startsWith('/')) return m;
    const tail = m.match(/[.:,]+$/)?.[0] ?? '';
    return sayAddress(m.slice(0, m.length - tail.length)) + tail;
  });
  // Files and bare host names: robots.txt, example.org, blog.example.net.
  t = t.replace(/\b([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)\.(txt|xml|html|json|gz|warc|md|ts|py|csv|onnx|mp3)\b/g, (m) => sayDotted(m));
  t = t.replace(/\b(?:[A-Za-z0-9-]+\.)+(?:org|com|net|io|uk|dev)\b/gi, (m) => sayHost(m));
  // Dotted identifiers in code: crawl.urls_due, crawl.pages.
  t = t.replace(/\b([a-z][a-z0-9]*)\.([a-z][a-z0-9_]*)\b/g, '$1 dot $2');

  // Clock times: 10:20:09, 10:21.
  t = t.replace(/\b(\d{1,2}):(\d{2}):(\d{2})\b/g, (_m, h, m, s) => clock(h, m, s));
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h, m) => clock(h, m));
  t = t.replace(/\b(\d+):(\d+)\b/g, '$1 to $2');

  // Symbols.
  t = t.replace(/\s*÷\s*/g, ' divided by ');
  t = t.replace(/\s*×\s*/g, ' times ');
  t = t.replace(/≈\s*/g, 'about ').replace(/~\s*(?=\d)/g, 'about ');
  t = t.replace(/\s*(?:→|->)\s*/g, ' to ').replace(/\s*←\s*/g, ' from ');
  t = t.replace(/\s*(?:≤|<=)\s*/g, ' at most ').replace(/\s*(?:≥|>=)\s*/g, ' at least ');
  t = t.replace(/\s+<\s+/g, ' less than ').replace(/\s+>\s+/g, ' more than ');
  t = t.replace(/\s*≠\s*/g, ' is not ').replace(/\s*±\s*/g, ' plus or minus ');
  t = t.replace(/\s+&\s+/g, ' and ').replace(/\s+\+\s+/g, ' plus ').replace(/\s+=\s+/g, ' equals ');
  t = t.replace(/\s+[–—]\s+/g, ', ').replace(/(\d)[–—](\d)/g, '$1 to $2').replace(/[–—]/g, ', ');
  t = t.replace(/\.\.\./g, ',').replace(/…/g, ',');
  // Percentiles: p95 to "ninety-fifth percentile".
  t = t.replace(/\bp(\d{2})\b/g, (_m, n) => `${ordinal(Number(n))} percentile`);
  // Money: £1.20, €3, $2.5m, £40k.
  t = t.replace(/([£€$])(\d[\d,]*)(?:\.(\d{1,2}))?\s*(k|m|bn|million|billion|thousand)?\b/g, (_m, cur: string, a: string, p: string | undefined, mult: string | undefined) => {
    const name = cur === '£' ? ['pound', 'pounds', 'pence'] : cur === '€' ? ['euro', 'euros', 'cents'] : ['dollar', 'dollars', 'cents'];
    const big = mult ? ` ${({ k: 'thousand', m: 'million', bn: 'billion' } as Record<string, string>)[mult] ?? mult}` : '';
    if (big) return `${a}${p ? `.${p}` : ''}${big} ${name[1]}`;
    const main = `${a} ${a === '1' ? name[0] : name[1]}`;
    return p && Number(p) ? `${main} ${Number(p.padEnd(2, '0'))} ${name[2]}` : main;
  });
  t = t.replace(/(\d)\s*%/g, '$1 per cent');
  // Units after a number: 8.4 s, 1 s, 300 ms.
  t = t.replace(/\b(\d+(?:\.\d+)?) s\b/g, (_m, n) => `${n} ${n === '1' ? 'second' : 'seconds'}`);
  t = t.replace(/\b(\d+(?:\.\d+)?) ?ms\b/g, '$1 milliseconds');
  // Multipliers: x20, 20x.
  t = t.replace(/\bx(\d+)\b/g, 'times $1').replace(/\b(\d+)x\b/g, '$1 times');
  // RFC numbers are said in pairs: RFC 9309 to "R F C ninety-three oh nine".
  t = t.replace(/\bRFC (\d{2})(\d{2})\b/g, (_m, a, b) => `R F C ${words(Number(a))} ${b.startsWith('0') ? `oh ${words(Number(b))}` : words(Number(b))}`);
  // Versions: v1 to "version 1"; quarters: q4 to "Q4".
  t = t.replace(/\bv(\d+)\b/g, 'version $1').replace(/\bq([1-4])\b/g, 'Q $1');

  // Identifiers: fetch-03, crawler-07 ("crawler zero seven"), slot-0417; L417-55120.
  t = t.replace(/\b([A-Za-z]+)-(\d+)\b/g, (_m, w: string, n: string) => `${w} ${n.startsWith('0') ? digits(n) : n}`);
  t = t.replace(/\b([A-Z])(\d+)-(\d+)\b/g, '$1 $2 $3');
  // Hex: 0x1f, fingerprints like 41d7a0c95e6b2f03, ETags like 6731-a91c (said character by character).
  t = t.replace(/\b0x([0-9a-f]+)\b/gi, (_m, x: string) => `hex ${spell(x.toLowerCase())}`);
  t = t.replace(/\b[0-9a-f]{3,}(?:-[0-9a-f]{3,})*\b/g, (x) => (/[a-f]/.test(x) && /\d/.test(x) ? x.split('-').map(spell).join(', ') : x));
  // snake_case: already_known to "already known".
  t = t.replace(/\b([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/g, (m) => m.split('_').join(' '));
  // Code such as lease(worker="fetch-03", max=8): the equals sign and the quotes go.
  t = t.replace(/(\w)=("?)/g, '$1 $2');
  // SQL keywords in capitals are read as words.
  t = t.replace(/\b(INSERT|SELECT|UPDATE|DELETE|WHERE|FROM|INTO|VALUES|ON CONFLICT|DO NOTHING|DO UPDATE|RETURNING|ORDER BY|LIMIT|BEGIN|COMMIT|ROLLBACK|FOR UPDATE)\b/g, (m) => m.toLowerCase());

  // Abbreviations and product names.
  for (const [re, say] of SAY) t = t.replace(re, say);
  // Plain lowercase "urls" in identifiers (discovered-urls).
  t = t.replace(/-?\burls\b/g, ' U R Ls');

  // Numbers with leading zeros are said digit by digit; not the "024" in 1,024 or the "05" in 0.05.
  t = t.replace(/(?<![\d,.])\b0\d+\b/g, (m) => digits(m));

  // Brackets and quotes read as pauses.
  t = t.replace(/\s*\(\s*/g, ', ').replace(/\s*\)\s*(?=[.,;:!?])/g, '').replace(/\s*\)\s*/g, ', ');
  t = t.replace(/["“”]/g, '').replace(/(^|\s)'([^']+)'(?=[\s.,;:!?]|$)/g, '$1$2');
  t = t.replace(/,\s*,/g, ',').replace(/,\s*([.;:!?])/g, '$1').replace(/:\s*,/g, ':');
  t = t.replace(/[ \t]+/g, ' ').replace(/ +([.,;:!?])/g, '$1').replace(/\n /g, '\n');
  return t.trim();
}
