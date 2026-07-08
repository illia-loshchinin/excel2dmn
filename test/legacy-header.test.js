import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkbook, loadConfig } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);

describe('4-row header (default)', () => {
  it('reads all rules from a 4-row-header workbook (no allowed-values row)', async () => {
    const [model] = await parseWorkbook(fx('legacy_4row.xlsx'), loadConfig({}));
    expect(model.decisions[0].rules).toHaveLength(5);
    expect(model.decisions[0].rules.map((r) => r.row)).toEqual([5, 6, 7, 8, 9]);
  });
});
