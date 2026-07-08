import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  dmnToModels,
  modelsToWorkbook,
  parseWorkbook,
  buildDmn,
  loadConfig,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);
const cfg = loadConfig({});

describe('reverse importer (dmn → xlsx)', () => {
  it('round-trips dmn → xlsx → dmn byte-identically', async () => {
    const golden = readFileSync(fx('shipping_rates.expected.dmn'), 'utf8');
    const models = await dmnToModels(golden, cfg);
    const out = join(tmpdir(), `rt-${Date.now()}.xlsx`);
    await modelsToWorkbook(models, cfg, out);
    const reModels = await parseWorkbook(out, cfg);
    const rebuilt = await buildDmn(reModels[0], cfg);
    expect(rebuilt).toBe(golden);
    rmSync(out, { force: true });
  });

  it('recovers hit policy and rule descriptions from DMN', async () => {
    const golden = readFileSync(fx('shipping_rates.expected.dmn'), 'utf8');
    const [model] = await dmnToModels(golden, cfg);
    const d = model.decisions[0];
    expect(d.hitPolicy).toBe('UNIQUE');
    expect(d.rules[0].description).toBe('standard EU parcel');
  });

  it('recovers allowed values from a DMN that has them', async () => {
    const avCfg = loadConfig({
      overrides: { header: { allowedValuesOffset: 3, labelOffset: 4 }, rules: { startOffset: 5 } },
    });
    const [srcModel] = await parseWorkbook(fx('allowed_values_DMN.xlsx'), avCfg);
    const xml = await buildDmn(srcModel, avCfg);
    const [model] = await dmnToModels(xml, cfg);
    expect(model.decisions[0].inputs.find((i) => i.expression === 'region').allowedValues).toBe('"EU","US"');
    expect(model.decisions[0].outputs[0].allowedValues).toBe('"BRONZE","SILVER","GOLD"');
  });
});
