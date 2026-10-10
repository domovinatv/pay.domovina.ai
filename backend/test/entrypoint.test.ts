import { describe, expect, it } from 'vitest';

import * as entry from '../src/index';

/// The Workers runtime treats every named export of the main module as an
/// entrypoint: a plain constant there fails `wrangler dev`/deploy with
/// "Incorrect type for map entry" (2026-10-10). Only the handler and DOs.
describe('worker entry module', () => {
  it('exports only the default handler and Durable Object classes', () => {
    expect(Object.keys(entry).sort()).toEqual(['IntentStream', 'default']);
  });
});
