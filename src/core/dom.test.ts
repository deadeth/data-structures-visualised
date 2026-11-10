import { describe, expect, it } from 'vitest';
import { costHtml } from './dom';

describe('costs in table cells', () => {
  it('keeps each big-O whole and sets the words around it in the text face', () => {
    expect(costHtml('O(log_B n) page reads')).toBe('<span class="big-o">O(log<sub>B</sub> n)</span> <span class="qualifier">page reads</span>');
    expect(costHtml('O(log n), O(n) worst')).toBe('<span class="big-o">O(log n)</span>, <span class="big-o">O(n)</span> <span class="qualifier">worst</span>');
    expect(costHtml('O(log_B n + k/B)')).toBe('<span class="big-o">O(log<sub>B</sub> n + k/B)</span>');
  });

  it('sets a cost with no big-O as words', () => {
    expect(costHtml('Not supported')).toBe('<span class="words">Not supported</span>');
    expect(costHtml('about K/N keys move')).toBe('<span class="words">about K/N keys move</span>');
  });
});
