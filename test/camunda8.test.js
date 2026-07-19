import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkbook, buildDmn, reparse, loadConfig, dmnToModels } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);
const c8 = loadConfig({ overrides: { platform: 'camunda8' } });

async function firstModel(file, cfg) {
  const models = await parseWorkbook(fx(file), cfg);
  return models[0];
}

describe('Camunda 8 output', () => {
  it('produces byte-identical DMN to the golden C8 file', async () => {
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', c8), c8);
    const expected = readFileSync(fx('shipping_rates.c8.expected.dmn'), 'utf8');
    expect(xml).toBe(expected);
  });

  it('emits modeler execution-platform metadata on <definitions>', async () => {
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', c8), c8);
    expect(xml).toContain('xmlns:modeler="http://camunda.org/schema/modeler/1.0"');
    expect(xml).toContain('modeler:executionPlatform="Camunda Cloud"');
    expect(xml).toContain('modeler:executionPlatformVersion="8.6.0"');
  });

  it('omits all Camunda 7 extension attributes and namespace', async () => {
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', c8), c8);
    expect(xml).not.toContain('xmlns:camunda');
    expect(xml).not.toContain('historyTimeToLive');
    expect(xml).not.toContain('versionTag');
  });

  it('keeps the default (unprefixed) MODEL namespace and preserves modeler prefix', async () => {
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', c8), c8);
    expect(xml).toContain('<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"');
    // toDefaultNamespace() must not strip the modeler: attribute prefix.
    expect(xml).toContain('modeler:executionPlatform');
  });

  it('re-parses via dmn-moddle with zero warnings', async () => {
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', c8), c8);
    const { warnings } = await reparse(xml);
    expect(warnings).toHaveLength(0);
  });

  it('respects a configured execution platform version', async () => {
    const cfg = loadConfig({
      overrides: { platform: 'camunda8', camunda8: { executionPlatformVersion: '8.7.5' } },
    });
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', cfg), cfg);
    expect(xml).toContain('modeler:executionPlatformVersion="8.7.5"');
  });
});

describe('Camunda 8 numeric normalization', () => {
  it('normalizes C7-only integer/long/double to number in C8 output', async () => {
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', c8), c8);
    expect(xml).toContain('typeRef="number"');
    expect(xml).not.toContain('typeRef="integer"');
    expect(xml).not.toContain('typeRef="long"');
    expect(xml).not.toContain('typeRef="double"');
  });

  it('normalizes long to number in C8 output', async () => {
    const model = await firstModel('shipping_rates_DMN.xlsx', c8);
    model.decisions[0].inputs[0].typeRef = 'long'; // orderTotal → long
    const xml = await buildDmn(model, c8);
    expect(xml).toContain('typeRef="number"');
    expect(xml).not.toContain('typeRef="long"');
  });

  it('leaves integer/double untouched under Camunda 7', async () => {
    const c7 = loadConfig({});
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', c7), c7);
    expect(xml).toContain('typeRef="integer"');
    expect(xml).toContain('typeRef="double"');
    expect(xml).not.toContain('typeRef="number"');
  });

  it('can be disabled via types.camunda8NumericAlias = null', async () => {
    const cfg = loadConfig({
      overrides: { platform: 'camunda8', types: { camunda8NumericAlias: null } },
    });
    const xml = await buildDmn(await firstModel('shipping_rates_DMN.xlsx', cfg), cfg);
    expect(xml).toContain('typeRef="integer"');
  });
});

describe('Camunda 8 type relaxation', () => {
  it("accepts the full DMN type set (e.g. 'number') with no error or warning", async () => {
    const model = await firstModel('number_type.xlsx', c8);
    expect(model.decisions[0].inputs[0].typeRef).toBe('number');
    expect((model.__warnings || []).some((w) => /Camunda type/.test(w.message))).toBe(false);
    const xml = await buildDmn(model, c8);
    expect(xml).toContain('typeRef="number"');
  });

  it("still rejects 'number' under Camunda 7 (default)", async () => {
    await expect(parseWorkbook(fx('number_type.xlsx'), loadConfig({}))).rejects.toThrow(
      /not a Camunda type/,
    );
  });
});

describe('Camunda 8 reverse detection', () => {
  it('detects platform camunda8 from modeler:executionPlatform on import', async () => {
    const xml = readFileSync(fx('shipping_rates.c8.expected.dmn'), 'utf8');
    const [model] = await dmnToModels(xml, loadConfig({}));
    expect(model.__platform).toBe('camunda8');
    expect(model.__camunda8.executionPlatformVersion).toBe('8.6.0');
  });

  it('detects platform camunda7 from a Camunda 7 file on import', async () => {
    const xml = readFileSync(fx('shipping_rates.expected.dmn'), 'utf8');
    const [model] = await dmnToModels(xml, loadConfig({}));
    expect(model.__platform).toBe('camunda7');
  });
});
