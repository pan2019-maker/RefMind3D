// @ts-expect-error The app intentionally does not ship Node runtime typings;
// Vitest still runs this regression check in Node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('progressive image layer layout', () => {
  it('stacks the decoded image over the thumbnail instead of placing it below the node', () => {
    const stylesheet = readFileSync(new URL('../../app/styles.css', import.meta.url), 'utf8');

    expect(stylesheet).toMatch(
      /\.image-node-base,\s*\.image-node-detail\s*\{[^}]*position:\s*absolute\s*!important;[^}]*inset:\s*0;/s
    );
    expect(stylesheet).toMatch(/\.image-node-base\s*\{[^}]*z-index:\s*1;/s);
    expect(stylesheet).toMatch(/\.image-node-detail\s*\{[^}]*z-index:\s*2;/s);
  });
});
