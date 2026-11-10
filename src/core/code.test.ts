import { describe, expect, it } from 'vitest';
import { codeProblems, listing, regionNames, tokenise } from './code';

const PY = `class T:
    # region find
    def find(self, key):
        """Look for key."""
        node = self.root  #@start
        while node:  #@loop
            node = node.next  #@loop,step
        return None
    # endregion

    # region add
    def add(self, key):
        self.items.append(key)  #@write
    # endregion
`;

const JAVA = `class T {
    // region find
    /** Look for key. */
    Node find(int key) {
        Node node = root; //@start
        while (node != null) { //@loop
            node = node.next; //@loop,step
        }
        return null;
    }
    // endregion

    // region add
    void add(int key) {
        items.add(key); //@write
    }
    // endregion
}
`;

describe('code listings', () => {
  it('extracts regions, strips markers and dedents', () => {
    expect(regionNames(PY, 'python')).toEqual(['find', 'add']);
    const l = listing(PY, 'python', ['find']);
    expect(l.lines).toEqual(['def find(self, key):', '    """Look for key."""', '    node = self.root', '    while node:', '        node = node.next', '    return None']);
    expect(l.anchors.get('start')).toEqual([2]);
    expect(l.anchors.get('loop')).toEqual([3, 4]);
    expect(l.anchors.get('step')).toEqual([4]);
  });

  it('joins several regions with a blank line and keeps anchor indexes right', () => {
    const l = listing(JAVA, 'java', ['add', 'find']);
    expect(l.lines[0]).toBe('void add(int key) {');
    expect(l.lines[3]).toBe('');
    expect(l.lines[l.anchors.get('write')![0]]).toBe('    items.add(key);');
    expect(l.lines[l.anchors.get('start')![0]]).toBe('    Node node = root;');
    expect(l.lines.join('\n')).not.toMatch(/@|region/);
  });

  it('throws for a region that does not exist', () => {
    expect(() => listing(PY, 'python', ['nope'])).toThrow(/nope/);
  });

  it('reports anchors that are missing in one language or unknown to a frame', () => {
    const ops = [{ id: 'find', code: ['find'] }, { id: 'add', code: ['add'] }, { id: 'plain' }];
    expect(codeProblems({ python: PY, java: JAVA }, ops, new Map([['find', new Set(['start', 'loop'])]]))).toEqual([]);
    expect(codeProblems({ python: PY, java: JAVA.replace(' //@start', '') }, ops, new Map())).toHaveLength(1);
    expect(codeProblems({ python: PY, java: JAVA }, ops, new Map([['add', new Set(['ghost'])]]))).toHaveLength(1);
  });

  it('colours keywords, comments, strings, numbers and defined names', () => {
    const kinds = (line: string, lang: 'python' | 'java') => tokenise(line, lang).filter((t) => t.text.trim()).map((t) => `${t.kind}:${t.text.trim()}`);
    expect(kinds('def find(self, key):  # look', 'python')).toEqual(['keyword:def', 'name:find', 'plain:(', 'keyword:self', 'plain:, key):', 'comment:# look']);
    expect(kinds('    """Look for key."""', 'python')).toEqual(['string:"""Look for key."""']);
    expect(kinds('return x + 12', 'python')).toEqual(['keyword:return', 'plain:x +', 'number:12']);
    expect(kinds('/** Look for key. */', 'java')).toEqual(['comment:/** Look for key. */']);
    expect(kinds('private Node findLeaf(int key) { // walk', 'java')).toEqual(['keyword:private', 'plain:Node', 'name:findLeaf', 'plain:(', 'keyword:int', 'plain:key) {', 'comment:// walk']);
    expect(tokenise('a1 = b', 'python').map((t) => t.kind)).toEqual(['plain']);
  });
});
