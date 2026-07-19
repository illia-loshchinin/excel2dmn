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
  importDmn,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);
const cfg = loadConfig({});

// Minimal Camunda 8 DMN: modeler execution-platform metadata + a C8-only `number` typeRef.
const C8_DMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="definitions_D1" name="D1" namespace="http://camunda.org/schema/1.0/dmn" modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.6.0">
  <decision id="D1" name="D1">
    <decisionTable id="D1_decisionTable">
      <input id="amount" label="Amount">
        <inputExpression id="amount_expression" typeRef="number"><text>amount</text></inputExpression>
      </input>
      <output id="ok" name="ok" typeRef="boolean" />
      <rule id="rule_1">
        <inputEntry id="amount_1"><text>&gt; 10</text></inputEntry>
        <outputEntry id="ok_1"><text>true</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;

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

  it('surfaces the detected platform on import (camunda8)', async () => {
    const { platform } = await importDmn('c8.dmn', { config: cfg, xml: C8_DMN, write: false });
    expect(platform).toBe('camunda8');
  });

  it('surfaces the detected platform on import (camunda7)', async () => {
    const golden = readFileSync(fx('shipping_rates.expected.dmn'), 'utf8');
    const { platform } = await importDmn('c7.dmn', { config: cfg, xml: golden, write: false });
    expect(platform).toBe('camunda7');
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
