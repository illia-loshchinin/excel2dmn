import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkbook, buildDmn, reparse, loadConfig } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);
const cfg = loadConfig({});

describe('Camunda output types', () => {
  it('accepts string/boolean/integer/long/double/date and emits them verbatim', async () => {
    const [model] = await parseWorkbook(fx('camunda_types.xlsx'), cfg);
    expect(model.decisions[0].outputs.map((o) => o.typeRef)).toEqual([
      'string', 'boolean', 'integer', 'long', 'double', 'date',
    ]);
    const xml = await buildDmn(model, cfg);
    expect(xml).toContain('typeRef="integer"');
    expect(xml).toContain('typeRef="long"');
    expect(xml).toContain('typeRef="double"');
    const { warnings } = await reparse(xml);
    expect(warnings).toHaveLength(0);
  });
});

describe('non-Camunda types', () => {
  it("rejects DMN/FEEL 'number' by default (Camunda uses integer/long/double)", async () => {
    await expect(parseWorkbook(fx('number_type.xlsx'), loadConfig({}))).rejects.toThrow(
      /not a Camunda type/,
    );
  });

  it("converts 'number' when nonCamundaTypeAction is 'warn' (with a warning)", async () => {
    const cfg = loadConfig({ overrides: { types: { nonCamundaTypeAction: 'warn' } } });
    const [model] = await parseWorkbook(fx('number_type.xlsx'), cfg);
    expect(model.decisions[0].inputs[0].typeRef).toBe('number');
    expect(model.__warnings.some((w) => /not a Camunda type/.test(w.message))).toBe(true);
  });
});
