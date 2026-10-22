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
  it('accepts the two valid platforms', () => {
    expect(loadConfig({ overrides: { platform: 'camunda7' } }).platform).toBe('camunda7');
    expect(loadConfig({ overrides: { platform: 'camunda8' } }).platform).toBe('camunda8');
  });
  it('rejects an unknown platform value', () => {
    expect(() => loadConfig({ overrides: { platform: 'c8' } })).toThrow(/Invalid platform/);
  });
  it('rejects a Camunda 8 config whose fallback hit policy C8 does not support', () => {
    const c8 = (hp) =>
      loadConfig({ overrides: { platform: 'camunda8', hitPolicy: { default: hp } } });
    expect(() => c8('PRIORITY')).toThrow(/not supported by Camunda 8/);
    expect(() => c8('OUTPUT ORDER')).toThrow(/not supported by Camunda 8/);
    expect(c8('FIRST').hitPolicy.default).toBe('FIRST');
    // Camunda 7 still allows them.
    expect(
      loadConfig({ overrides: { hitPolicy: { default: 'PRIORITY' } } }).hitPolicy.default,
    ).toBe('PRIORITY');
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
