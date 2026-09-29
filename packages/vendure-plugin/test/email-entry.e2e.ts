import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderConfirmationHandler } from '@vendure/email-plugin';
import { describe, expect, it, vi } from 'vitest';

// EmailEventHandler keeps its filters in a private array; the default handler has exactly one.
const filterCount = (handler: unknown) => (handler as { filterFns: unknown[] }).filterFns.length;

describe('review 4: the email handler is separate, and lives in the @vendurepos/plugin/email entry', () => {
  it('tallyOrderConfirmationHandler is a handler of its own; importing the package leaves the default unchanged', async () => {
    const before = filterCount(orderConfirmationHandler);
    expect(before).toBe(1);
    const { tallyOrderConfirmationHandler } = await import('../src/email.js');
    await import('../src/index.js');
    expect(tallyOrderConfirmationHandler).not.toBe(orderConfirmationHandler);
    expect(filterCount(orderConfirmationHandler)).toBe(before);
    expect(filterCount(tallyOrderConfirmationHandler)).toBe(2);
    expect(tallyOrderConfirmationHandler.type).toBe(orderConfirmationHandler.type);
    expect(tallyOrderConfirmationHandler.event).toBe(orderConfirmationHandler.event);
    expect(tallyOrderConfirmationHandler.mockEvent).toBe(orderConfirmationHandler.mockEvent);
  });

  it('the main entry does not load @vendure/email-plugin', async () => {
    vi.resetModules();
    vi.doMock('@vendure/email-plugin', () => {
      throw new Error('the main entry loaded @vendure/email-plugin');
    });
    try {
      await expect(import('../src/index.js')).resolves.toHaveProperty('TallyPosPlugin');
      // Control: the mock does take effect for a module that needs the email plugin.
      await expect(import('../src/email.js')).rejects.toThrow();
    } finally {
      vi.doUnmock('@vendure/email-plugin');
      vi.resetModules();
    }
  });

  it('package.json exports the ./email subpath and makes @vendure/email-plugin an optional peer', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    expect(manifest.exports['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' });
    expect(manifest.exports['./email']).toEqual({ types: './dist/email.d.ts', default: './dist/email.js' });
    expect(manifest.peerDependencies['@vendure/email-plugin']).toBeDefined();
    expect(manifest.peerDependenciesMeta['@vendure/email-plugin']).toEqual({ optional: true });
  });
});
