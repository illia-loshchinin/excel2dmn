import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkbook, buildDmn, reparse, loadConfig } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);

// Opt-in allowed-values layout: type at M+2, allowed values at M+3, label at M+4, rules at M+5.
const cfg = loadConfig({
  overrides: { header: { allowedValuesOffset: 3, labelOffset: 4 }, rules: { startOffset: 5 } },
});

describe('allowed values (opt-in, swapped row order)', () => {
  it('reads the allowed-values row above the label row', async () => {
    const [model] = await parseWorkbook(fx('allowed_values_DMN.xlsx'), cfg);
    const d = model.decisions[0];
    expect(d.rules).toHaveLength(3);
    expect(d.inputs.find((i) => i.expression === 'region').allowedValues).toBe('"EU","US"');
    expect(d.inputs.find((i) => i.expression === 'region').label).toBe('Region');
    expect(d.outputs[0].allowedValues).toBe('"BRONZE","SILVER","GOLD"');
  });

  it('emits <inputValues>/<outputValues> and re-parses cleanly', async () => {
    const [model] = await parseWorkbook(fx('allowed_values_DMN.xlsx'), cfg);
    const xml = await buildDmn(model, cfg);
    expect(xml).toContain('<inputValues>');
    expect(xml).toContain('<outputValues>');
    const { warnings } = await reparse(xml);
    expect(warnings).toHaveLength(0);
  });
});
