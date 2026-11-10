import { beforeEach, expect, it, vi } from 'vitest';
import { useCSSVariable } from 'uniwind';
import { stackColors, useStackColors } from './theme-colors';

vi.mock('uniwind', () => ({ useCSSVariable: vi.fn() }));

beforeEach(() => { vi.mocked(useCSSVariable).mockReset(); });

it('the header takes the card colour, its title and buttons the foreground, the screen the background', () => {
  for (const tokens of [
    ['#161b22', '#c9d1d9', '#0d1117'],
    ['#ffffff', '#111827', '#f8f9fa'],
  ]) {
    const [card, foreground, background] = tokens;
    expect(stackColors(tokens)).toEqual({
      headerStyle: { backgroundColor: card },
      headerTintColor: foreground,
      headerTitleStyle: { fontWeight: '600', color: foreground },
      contentStyle: { backgroundColor: background },
    });
  }
  vi.mocked(useCSSVariable).mockReturnValue(['#161b22', '#c9d1d9', '#0d1117']);
  expect(useStackColors()).toEqual({
    headerStyle: { backgroundColor: '#161b22' },
    headerTintColor: '#c9d1d9',
    headerTitleStyle: { fontWeight: '600', color: '#c9d1d9' },
    contentStyle: { backgroundColor: '#0d1117' },
  });
  expect(useCSSVariable).toHaveBeenCalledTimes(1);
  expect(useCSSVariable).toHaveBeenCalledWith(['--color-card', '--color-foreground', '--color-background']);
});

it('a token that has not resolved falls back to the light colour', () => {
  for (const tokens of [[undefined, '', 42], ['', 42, undefined], [42, undefined, '']]) {
    expect(stackColors(tokens)).toEqual({
      headerStyle: { backgroundColor: '#ffffff' },
      headerTintColor: '#111827',
      headerTitleStyle: { fontWeight: '600', color: '#111827' },
      contentStyle: { backgroundColor: '#f8f9fa' },
    });
  }
});
