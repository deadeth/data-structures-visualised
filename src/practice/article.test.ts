import { describe, expect, it } from 'vitest';
import { numberingProblems, parseArticle, plainOf, sectionsOf, type ArticleError } from './article';

const ok = (src: string) => {
  const r = parseArticle(src);
  expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  return r.article!;
};
const errs = (src: string): ArticleError[] => parseArticle(src).errors;

describe('tutorial article parser', () => {
  it('reads the title, numbered headings, paragraphs, lists and code', () => {
    const a = ok(
      [
        '# A **Title**',
        '',
        '## 1. Overview',
        '',
        'One line',
        'and its next line, with `code` and a [link](https://example.org/x).',
        '',
        '### 1.1. Sub',
        '',
        '1. first',
        '2. second runs',
        '   on here',
        '',
        '- a',
        '* b',
        '',
        '```java',
        '    int x = 1;',
        '',
        '```',
        '',
        '```',
        'a -> b',
        '```',
        '',
        '## 2. Conclusion',
        '',
        'The end.',
      ].join('\n'),
    );
    expect(plainOf(a.title)).toBe('A Title');
    expect(a.title[1]).toEqual({ t: 'bold', children: [{ t: 'text', text: 'Title' }] });
    expect(a.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'list', 'list', 'code', 'code', 'heading', 'paragraph']);
    const [h1, p, h2, ol, ul, java, bare] = a.blocks;
    expect(h1).toMatchObject({ level: 2, number: '1', line: 3 });
    expect(h2).toMatchObject({ level: 3, number: '1.1' });
    expect(p.kind === 'paragraph' && p.text).toEqual([
      { t: 'text', text: 'One line and its next line, with ' },
      { t: 'code', text: 'code' },
      { t: 'text', text: ' and a ' },
      { t: 'link', href: 'https://example.org/x', children: [{ t: 'text', text: 'link' }] },
      { t: 'text', text: '.' },
    ]);
    expect(ol.kind === 'list' && ol.ordered && ol.items.map(plainOf)).toEqual(['first', 'second runs on here']);
    expect(ul.kind === 'list' && !ul.ordered && ul.items.map(plainOf)).toEqual(['a', 'b']);
    expect(java).toMatchObject({ kind: 'code', lang: 'java', lines: ['    int x = 1;', ''] });
    expect(bare).toMatchObject({ kind: 'code', lang: null, lines: ['a -> b'] });
    expect(sectionsOf(a).map((s) => [s.number, s.title, s.blocks.length])).toEqual([['1', 'Overview', 7], ['2', 'Conclusion', 2]]);
    expect(numberingProblems(a)).toEqual([]);
  });

  it('keeps an ordered list that starts past 1, and code untouched by inline rules', () => {
    const a = ok('# T\n\n## 1. Overview\n\n3. three\n4. four\n\n```\n**not bold** `x` <b> * _y_\n```\n');
    expect(a.blocks[1]).toMatchObject({ kind: 'list', ordered: true, start: 3 });
    expect(a.blocks[2]).toMatchObject({ kind: 'code', lines: ['**not bold** `x` <b> * _y_'] });
  });

  it('allows snake_case and underscores inside words', () => {
    ok('# T\n\nMAX_VALUE and some_name are fine.\n');
  });

  it('refuses everything outside the subset, with its line', () => {
    const cases: [string, number, RegExp][] = [
      ['No title', 1, /first line should be the title/],
      ['# T\n\n# Again', 3, /only the first line/],
      ['# T\n\n#### Deep', 3, /#### headings/],
      ['# T\n\n## Overview', 3, /numbered "## 1. Title"/],
      ['# T\n\n### 1. Sub', 3, /numbered "### 1.1. Title"/],
      ['# T\n\n| a | b |\n|---|---|', 3, /tables/],
      ['# T\n\n> quoted', 3, /block quotes/],
      ['# T\n\n---', 3, /horizontal rules/],
      ['# T\n\n<div>x</div>', 3, /HTML/],
      ['# T\n\nSome <b>bold</b>.', 3, /HTML/],
      ['# T\n\n![alt](https://x.org/a.png)', 3, /images/],
      ['# T\n\nA note[^1].', 3, /footnotes/],
      ['# T\n\n[^1]: the note', 3, /footnotes/],
      ['# T\n\n- a\n  - nested', 4, /nested/],
      ['# T\n\n```python\nx\n```', 3, /fence language "python"/],
      ['# T\n\n```java\nx', 3, /not closed/],
      ['# T\n\n~~~\nx\n~~~', 3, /fence must start/],
      ['# T\n\nSome *italic* text.', 3, /single \*/],
      ['# T\n\nSome _italic_ text.', 3, /italics/],
      ['# T\n\nAn `open code span.', 3, /` is not closed/],
      ['# T\n\nAn **open bold.', 3, /\*\* is not closed/],
      ['# T\n\nSee [x][ref].', 3, /reference links/],
      ['# T\n\n[ref]: https://x.org', 3, /reference link definitions/],
      ['# T\n\nPara\n\n    indented code', 5, /indented code/],
      ['# T\n\nA heading\n=====', 4, /underlined headings/],
    ];
    for (const [src, line, re] of cases) {
      const e = errs(src);
      expect(e.some((x) => x.line === line && re.test(x.message)), `${JSON.stringify(src)} -> ${JSON.stringify(e)}`).toBe(true);
      expect(parseArticle(src).article).toBeUndefined();
    }
  });

  it('finds gaps and wrong names in the numbering', () => {
    const a = ok('# T\n\n## 1. Intro\n\n### 1.2. Skipped one\n\n## 3. End\n\n### 2.1. Counted from the second\n');
    const p = numberingProblems(a).join('\n');
    expect(p).toContain('sub-section "1.2" should be 1.1');
    expect(p).toContain('section "3" should be 2');
    // Sections are counted as written: after "## 3." (the second), "### 2.1." is in order.
    expect(p).not.toContain('"2.1"');
    expect(p).toContain('should be "Overview"');
    expect(p).toContain('should be "Conclusion"');
    expect(numberingProblems(ok('# T\n\nText first.\n\n## 1. Overview\n\n## 2. Conclusion\n')).join()).toContain('should start with');
  });
});
