import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dmnToModels,
  modelsToWorkbook,
  parseWorkbook,
  buildDmn,
  loadConfig,
} from '../src/index.js';
import { isAnyType } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, 'fixtures', f);
const cfg = loadConfig({});

// Minimal DMN whose untyped columns use the aliases 'Any' (input) and 'Object' (output),
// as some Camunda/DMN tooling emits for untyped columns.
const DMN_WITH_ALIASES = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="definitions_D1" name="D1" namespace="http://camunda.org/schema/1.0/dmn">
  <decision id="D1" name="D1">
    <decisionTable id="D1_decisionTable">
      <input id="foo" label="Foo">
        <inputExpression id="foo_expression" typeRef="Any">
          <text>foo</text>
        </inputExpression>
      </input>
      <output id="bar" label="Bar" name="bar" typeRef="Object" />
      <rule id="rule_1">
        <inputEntry id="foo_1"><text>"x"</text></inputEntry>
        <outputEntry id="bar_1"><text>"y"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;

describe('untyped "any" aliases', () => {
  it('isAnyType matches any/none/object case-insensitively', () => {
    for (const v of ['any', 'Any', 'ANY', 'none', 'None', 'object', 'Object', 'OBJECT'])
      expect(isAnyType(v, cfg)).toBe(true);
    for (const v of ['', null, undefined, 'string', 'integer', 'date'])
      expect(isAnyType(v, cfg)).toBe(false);
  });

  it('import normalizes typeRef aliases (Any/Object) to canonical "any"', async () => {
    const [model] = await dmnToModels(DMN_WITH_ALIASES, cfg);
    expect(model.decisions[0].inputs[0].typeRef).toBe('any');
    expect(model.decisions[0].outputs[0].typeRef).toBe('any');
  });

  it('accepts aliases typed directly in the Excel type row and omits typeRef on export', async () => {
    // Import the golden model, then rewrite two columns to alias spellings a user might type.
    const golden = readFileSync(fx('shipping_rates.expected.dmn'), 'utf8');
    const [model] = await dmnToModels(golden, cfg);
    model.decisions[0].inputs[0].typeRef = 'Any'; // orderTotal
    model.decisions[0].outputs[0].typeRef = 'Object'; // shippingMethod

    const out = join(tmpdir(), `any-alias-${process.pid}.xlsx`);
    await modelsToWorkbook([model], cfg, out);
    // parseWorkbook must NOT throw — the aliases are valid.
    const [reparsed] = await parseWorkbook(out, cfg);
    rmSync(out, { force: true });

    const xml = await buildDmn(reparsed, cfg);
    // The two aliased columns emit no typeRef attribute (untyped == "Any" in Camunda).
    expect(xml).toContain('<inputExpression id="orderTotal_expression">');
    expect(xml).toMatch(/<output id="shippingMethod"[^>]*name="shippingMethod"(?![^>]*typeRef)/);
    // A typed column is still emitted verbatim.
    expect(xml).toContain('typeRef="string"');
  });

  it('omits typeRef for any-typed columns by default', async () => {
    const [model] = await dmnToModels(DMN_WITH_ALIASES, cfg);
    const xml = await buildDmn(model, cfg);
    expect(xml).toContain('<inputExpression id="foo_expression">'); // no typeRef attr
    expect(xml).toMatch(/<output id="bar"[^>]*name="bar"(?![^>]*typeRef)/);
  });

  it('emits a configurable placeholder typeRef for any-typed columns when set', async () => {
    const placeholderCfg = loadConfig({ overrides: { types: { anyDmnPlaceholder: 'Any' } } });
    const [model] = await dmnToModels(DMN_WITH_ALIASES, placeholderCfg);
    const xml = await buildDmn(model, placeholderCfg);
    expect(xml).toContain('<inputExpression id="foo_expression" typeRef="Any">');
    expect(xml).toContain('<output id="bar" label="Bar" name="bar" typeRef="Any" />');
    // The placeholder still round-trips back to canonical "any" on re-import.
    const [reimported] = await dmnToModels(xml, cfg);
    expect(reimported.decisions[0].inputs[0].typeRef).toBe('any');
    expect(reimported.decisions[0].outputs[0].typeRef).toBe('any');
  });
});
