import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildProgram } from '../src/cli.js';

describe('cli', () => {
  it('reports the version from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(buildProgram().version()).toBe(pkg.version);
  });
});
