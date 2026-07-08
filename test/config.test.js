import { describe, it, expect } from 'vitest';
import { deepMerge, DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { toNcNameId, colLetter } from '../src/ids.js';

describe('config', () => {
  it('deep-merges overrides over defaults', () => {
    const merged = deepMerge(DEFAULT_CONFIG, { hitPolicy: { default: 'FIRST' } });
    expect(merged.hitPolicy.default).toBe('FIRST');
    expect(merged.markers.id).toBe('id'); // untouched
  });
  it('renamed markers propagate', () => {
    const cfg = loadConfig({ overrides: { markers: { id: 'KEY' } } });
    expect(cfg.markers.id).toBe('KEY');
  });
});

describe('ids', () => {
  it('folds diacritics to UPPER_SNAKE', () => {
    expect(toNcNameId('Zürich Süd')).toBe('ZURICH_SUD');
    expect(toNcNameId('SHIPPING_RATES')).toBe('SHIPPING_RATES');
    expect(toNcNameId('Obsługi blokady')).toBe('OBSLUGI_BLOKADY');
  });
  it('maps column index to letter', () => {
    expect(colLetter(1)).toBe('A');
    expect(colLetter(19)).toBe('S');
    expect(colLetter(27)).toBe('AA');
  });
});
