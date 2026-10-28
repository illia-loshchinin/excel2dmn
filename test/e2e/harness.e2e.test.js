import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  tempDir,
  runCli,
  writeWorkbook,
  readWorkbook,
  decisionSheet,
  parseDmn,
  firstTable,
  readText,
  listFiles,
} from './helpers.js';

describe('e2e harness', () => {
  let tmp;
  afterEach(() => tmp?.cleanup());

  it('builds a workbook, converts it with the CLI and re-parses the DMN', async () => {
    tmp = tempDir();
    const xlsx = join(tmp.dir, 'demo_DMN.xlsx');
    await writeWorkbook(xlsx, {
      'Demo DMN': decisionSheet(
        [
          { marker: 'policy', name: 'UNIQUE' },
          { marker: 'ID', name: 'DEMO' },
          { marker: 'input', name: 'amount', type: 'integer', label: 'Amount' },
          { marker: 'output', name: 'fee', type: 'double', label: 'Fee' },
        ],
        [
          [null, null, '< 100', 1.5],
          [null, null, '>= 100', 0],
        ],
      ),
    });
    const r = runCli([xlsx, '--out-dir', tmp.dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(listFiles(tmp.dir)).toContain('DEMO.dmn');
    const { decision, table } = firstTable(await parseDmn(readText(join(tmp.dir, 'DEMO.dmn'))));
    expect(decision.id).toBe('DEMO');
    expect(table.rule).toHaveLength(2);
    expect((await readWorkbook(xlsx))['Demo DMN'][1][2]).toBe('amount');
  });
});
