import {
  vendureSignIn, vendureStoreSettings, vendureGlobalStockSettings,
} from '@tallyui/connector-vendure';
import { SignInError, StoreSettingsError } from '@tallyui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn } from './sign-in';

vi.mock('@tallyui/connector-vendure', async (importActual) => ({
  ...await importActual<typeof import('@tallyui/connector-vendure')>(),
  vendureSignIn: vi.fn(),
  vendureStoreSettings: vi.fn(),
  vendureGlobalStockSettings: vi.fn(),
}));

const values = {
  url: ' https://shop.example.com/admin-api/ ', email: ' cashier@example.com ',
  password: ' password with spaces ', channel_token: ' channel-1 ',
};
const settings = {
  currency: 'GBP', pricesIncludeTax: true, taxRatesPpm: { default: 200000 },
  pricingContext: { channel: 'channel-1' },
};
const stock = { trackInventory: true, outOfStockThreshold: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(vendureSignIn).mockResolvedValue({ token: 'test-token' });
  vi.mocked(vendureStoreSettings).mockResolvedValue(settings);
  vi.mocked(vendureGlobalStockSettings).mockResolvedValue(stock);
});

describe('signIn', () => {
  it('returns the full session and sends credentials and channel headers at the correct stages', async () => {
    const signal = new AbortController().signal;
    expect(await signIn(values, { signal })).toEqual({
      ok: true,
      session: {
        url: 'https://shop.example.com', email: 'cashier@example.com',
        channelToken: 'channel-1', token: 'test-token', settings, stock,
      },
    });
    expect(vendureSignIn).toHaveBeenCalledExactlyOnceWith(
      'https://shop.example.com', { email: 'cashier@example.com', password: values.password }, { signal },
    );
    const context = {
      connectorId: 'vendure', baseUrl: 'https://shop.example.com', signal,
      headers: { Authorization: 'Bearer test-token', 'vendure-token': 'channel-1' },
    };
    expect(vendureStoreSettings).toHaveBeenCalledExactlyOnceWith(context);
    expect(vendureGlobalStockSettings).toHaveBeenCalledExactlyOnceWith(context);
  });

  it.each([undefined, '   '])('uses the default channel for %j', async (channel_token) => {
    const result = await signIn({ ...values, channel_token });
    expect(result.ok && result.session.channelToken).toBeUndefined();
    expect(vendureStoreSettings).toHaveBeenCalledWith({
      connectorId: 'vendure', baseUrl: 'https://shop.example.com', signal: undefined,
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it.each([
    [new SignInError('invalid_credentials', 'Bad login'), 'Email or password is incorrect.'],
    [new SignInError('unsupported', 'Native auth is disabled.'), 'Native auth is disabled.'],
    [new SignInError('failed', 'Could not reach Vendure.'), 'Could not reach Vendure.'],
    [new SignInError('server_error', 'Server unavailable.'), 'Server unavailable.'],
    [new Error('Unexpected failure.'), 'Unexpected failure.'],
  ])('returns the sign-in failure message for %s', async (error, message) => {
    vi.mocked(vendureSignIn).mockRejectedValue(error);
    expect(await signIn(values)).toEqual({ ok: false, error: message });
    expect(vendureStoreSettings).not.toHaveBeenCalled();
    expect(vendureGlobalStockSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['settings', values.channel_token, ' Check the channel token.'],
    ['stock', values.channel_token, ' Check the channel token.'],
    ['settings', undefined, ''],
    ['stock', undefined, ''],
  ])('reports a %s read failure with channel token %j', async (stage, channel_token, hint) => {
    const message = 'Vendure GraphQL error: No Channel with the token "x" could be found';
    vi.mocked(stage === 'settings' ? vendureStoreSettings : vendureGlobalStockSettings)
      .mockRejectedValue(new StoreSettingsError('failed', message));
    expect(await signIn({ ...values, channel_token })).toEqual({
      ok: false, error: `Could not read the store settings: ${message}${hint}`,
    });
  });

  it.each([
    [{ url: 'shop.example.com' }, 'Enter the full server URL, starting with https://.'],
    [{ url: undefined }, 'Enter your Vendure server URL.'],
    [{ url: '', password: '' }, 'Enter your Vendure server URL.'],
    [{ password: '' }, 'Enter your email and password.'],
    [{ password: undefined }, 'Enter your email and password.'],
    [{ email: '   ' }, 'Enter your email and password.'],
    [{ email: undefined }, 'Enter your email and password.'],
  ])('rejects invalid fields %j before calling the connector', async (fields, error) => {
    expect(await signIn({ ...values, ...fields })).toEqual({ ok: false, error });
    expect(vendureSignIn).not.toHaveBeenCalled();
    expect(vendureStoreSettings).not.toHaveBeenCalled();
    expect(vendureGlobalStockSettings).not.toHaveBeenCalled();
  });

  it.each(['sign-in', 'settings', 'stock'])('rethrows AbortError at the %s stage', async (stage) => {
    const controller = new AbortController();
    controller.abort();
    const operation = stage === 'sign-in' ? vendureSignIn
      : stage === 'settings' ? vendureStoreSettings : vendureGlobalStockSettings;
    vi.mocked(operation).mockRejectedValue(controller.signal.reason);
    await expect(signIn(values, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
  });

  it('rethrows the signal AbortError when store settings wraps it', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    vi.mocked(vendureStoreSettings).mockImplementation(async () => {
      controller.abort(abortError);
      throw new StoreSettingsError('failed', 'This operation was aborted');
    });
    await expect(signIn(values, { signal: controller.signal })).rejects.toBe(abortError);
  });
});
