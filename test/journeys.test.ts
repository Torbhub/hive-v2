import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coherenceErrors } from '../src/journeys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('journey registry coherence', () => {
  it('is internally sound and every referenced file exists', () => {
    expect(coherenceErrors(ROOT)).toEqual([]);
  });
});
