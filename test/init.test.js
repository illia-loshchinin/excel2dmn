import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { writeTemplate } from '../src/init-template.js';
import { parseWorkbook, buildDmn, reparse, loadConfig } from '../src/index.js';

describe('init template', () => {
  it('generates a workbook that round-trips to valid DMN', async () => {
    const cfg = loadConfig({});
    const out = join(tmpdir(), `e2d-${Date.now()}.xlsx`);
    await writeTemplate(out, cfg, { name: 'Sample Decision' });
    const models = await parseWorkbook(out, cfg);
    expect(models).toHaveLength(1);
    const xml = await buildDmn(models[0], cfg);
    const { warnings } = await reparse(xml);
    expect(warnings).toHaveLength(0);
    rmSync(out, { force: true });
  });
});
