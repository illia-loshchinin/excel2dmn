import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkbook, buildDmn, reparse, loadConfig, analyzeModel } from '../src/index.js';
import { ConversionError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);
const cfg = loadConfig({});

async function firstModel(file, overrides) {
  const c = overrides ? loadConfig({ overrides }) : cfg;
  const models = await parseWorkbook(fx(file), c);
  return models[0];
}

describe('Stage A — parse', () => {
  it('parses the reference workbook into the golden model', async () => {
    const model = await firstModel('shipping_rates_DMN.xlsx');
    const { __sheet, __warnings, ...clean } = model;
    void __sheet;
    void __warnings;
    const expected = JSON.parse(readFileSync(fx('shipping_rates.expected.model.json'), 'utf8'));
    expect(clean).toEqual(expected);
  });

  it('derives decision id/name and rule ids from rows', async () => {
    const d = (await firstModel('shipping_rates_DMN.xlsx')).decisions[0];
    expect(d.id).toBe('SHIPPING_RATES');
    expect(d.name).toBe('Shipping Rate Decision');
    expect(d.rules.map((r) => r.id)).toEqual(['rule_1', 'rule_2', 'rule_3', 'rule_4', 'rule_5']);
  });

  it('maps annotation cell to rule.description', async () => {
    const d = (await firstModel('shipping_rates_DMN.xlsx')).decisions[0];
    expect(d.rules[0].description).toBe('standard EU parcel');
  });

});

describe('Stage B — build', () => {
  it('produces byte-identical DMN to the golden file', async () => {
    const model = await firstModel('shipping_rates_DMN.xlsx');
    const xml = await buildDmn(model, cfg);
    const expected = readFileSync(fx('shipping_rates.expected.dmn'), 'utf8');
    expect(xml).toBe(expected);
  });

  it('re-parses via dmn-moddle with zero warnings', async () => {
    const model = await firstModel('shipping_rates_DMN.xlsx');
    const xml = await buildDmn(model, cfg);
    const { warnings, rootElement } = await reparse(xml);
    expect(warnings).toHaveLength(0);
    expect(rootElement.drgElement[0].decisionLogic.rule).toHaveLength(5);
  });

  it('emits default (unprefixed) MODEL namespace + camunda TTL', async () => {
    const model = await firstModel('shipping_rates_DMN.xlsx');
    const xml = await buildDmn(model, cfg);
    expect(xml).toContain('<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"');
    expect(xml).toContain('camunda:historyTimeToLive="P180D"');
    expect(xml).toContain('<description>standard EU parcel</description>');
    expect(xml).not.toContain('<annotation');
  });
});

describe('multi-sheet', () => {
  it('emits one model per DMN sheet, ignoring non-DMN sheets', async () => {
    const models = await parseWorkbook(fx('multi_sheet.xlsx'), cfg);
    expect(models.map((m) => m.decisions[0].id).sort()).toEqual(['RET_B', 'SHIP_A']);
  });
});

describe('validation', () => {
  it('rejects an unknown typeRef with a coordinate', async () => {
    await expect(parseWorkbook(fx('broken_type.xlsx'), cfg)).rejects.toThrow(ConversionError);
    await expect(parseWorkbook(fx('broken_type.xlsx'), cfg)).rejects.toThrow(/typeRef 'widget'/);
  });
});

describe('static analysis', () => {
  it('flags overlapping UNIQUE rules', async () => {
    const model = await firstModel('overlap.xlsx');
    const { findings } = analyzeModel(
      model,
      loadConfig({ overrides: { analysis: { enabled: true } } }),
    );
    expect(findings.some((f) => f.check === 'overlap' && f.severity === 'error')).toBe(true);
  });

  it('does NOT flag rules that differ on a boolean input (regression)', async () => {
    const model = await firstModel('repro_overlap.xlsx');
    const { findings } = analyzeModel(model, loadConfig({ overrides: { analysis: { enabled: true } } }));
    expect(findings.filter((f) => f.check === 'overlap')).toHaveLength(0);
  });

  it('still flags a genuine boolean overlap', async () => {
    const model = await firstModel('genuine_overlap.xlsx');
    const { findings } = analyzeModel(model, loadConfig({ overrides: { analysis: { enabled: true } } }));
    expect(findings.some((f) => f.check === 'overlap')).toBe(true);
  });

  it('reports no overlaps on the clean reference', async () => {
    const model = await firstModel('shipping_rates_DMN.xlsx');
    const { findings } = analyzeModel(
      model,
      loadConfig({ overrides: { analysis: { enabled: true } } }),
    );
    expect(findings.filter((f) => f.check === 'overlap')).toHaveLength(0);
  });
});
