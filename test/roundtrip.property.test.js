import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dmnToModels, buildDmn, loadConfig } from '../src/index.js';

// Property-based tests (fast-check): DMN → model → DMN must keep every piece of user text
// intact, whatever characters it holds — XML specials, quotes, FEEL syntax, any Unicode.

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig({});
const golden = readFileSync(join(here, 'fixtures', 'shipping_rates.expected.dmn'), 'utf8');

// Text a user can type into a cell: any Unicode except what XML 1.0 cannot carry
// (C0 controls other than tab/newline, lone surrogates, U+FFFE/U+FFFF). Leading/trailing
// whitespace is excluded because cells are trimmed on read.
const xmlChar = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 1 })
  .filter((c) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿\r]/u.test(c));
const cellText = fc
  .array(xmlChar, { minLength: 1, maxLength: 30 })
  .map((cs) => cs.join(''))
  .filter((s) => s.trim() === s && s.length > 0);

// A FEEL string literal holding arbitrary text, escaped the FEEL way.
const feelString = cellText.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

async function baseModel() {
  const [model] = await dmnToModels(golden, cfg);
  return model;
}

describe('DMN round-trip properties', () => {
  it('keeps rule descriptions and labels verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(cellText, { minLength: 1, maxLength: 5 }),
        cellText,
        cellText,
        async (descriptions, inputLabel, outputLabel) => {
          const model = await baseModel();
          const d = model.decisions[0];
          d.rules.forEach((r, i) => (r.description = descriptions[i % descriptions.length]));
          d.inputs[0].label = inputLabel;
          d.outputs[0].label = outputLabel;

          const [back] = await dmnToModels(await buildDmn(model, cfg), cfg);
          const b = back.decisions[0];
          expect(b.rules.map((r) => r.description)).toEqual(d.rules.map((r) => r.description));
          expect(b.inputs[0].label).toBe(inputLabel);
          expect(b.outputs[0].label).toBe(outputLabel);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('keeps string-literal rule entries verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(feelString, { minLength: 2, maxLength: 2 }),
        async ([region, method]) => {
          const model = await baseModel();
          const d = model.decisions[0];
          d.rules[0].inputEntries[1] = region; // Region (string input)
          d.rules[0].outputEntries[0] = method; // shippingMethod (string output)

          const xml = await buildDmn(model, cfg);
          const [back] = await dmnToModels(xml, cfg);
          const r = back.decisions[0].rules[0];
          expect(r.inputEntries[1]).toBe(region);
          expect(r.outputEntries[0]).toBe(method);
          // Building is deterministic: the rebuilt model yields byte-identical XML.
          expect(await buildDmn(back, cfg)).toBe(xml);
        },
      ),
      { numRuns: 100 },
    );
  });
});
