import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkbook, loadConfig } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);

describe('marker matching is case-insensitive (markers.caseInsensitive)', () => {
  it('parses mixed/upper-case markers by default', async () => {
    const [model] = await parseWorkbook(fx('mixed_case.xlsx'), loadConfig({}));
    const d = model.decisions[0];
    expect(d.id).toBe('MIXED');
    expect(d.hitPolicy).toBe('UNIQUE');
    expect(d.inputs).toHaveLength(1);
    expect(d.outputs).toHaveLength(1);
    expect(d.rules[0].description).toBe('note one');
  });

  it('honours markers.caseInsensitive:false (exact-case matching)', async () => {
    const cfg = loadConfig({ overrides: { markers: { caseInsensitive: false } } });
    await expect(parseWorkbook(fx('mixed_case.xlsx'), cfg)).rejects.toThrow();
  });
});
