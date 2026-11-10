import { beforeEach, expect, it, vi } from 'vitest';
import { useCSSVariable } from 'uniwind';
import { useStackColors } from './theme-colors';

vi.mock('uniwind', () => ({ useCSSVariable: vi.fn() }));

beforeEach(() => { vi.mocked(useCSSVariable).mockReset(); });

it('the header takes the card colour, its title and buttons the foreground, the screen the background', () => {
  for (const [card, foreground, background] of [
    ['#161b22', '#c9d1d9', '#0d1117'],
    ['#ffffff', '#111827', '#f8f9fa'],
  ]) {
    vi.mocked(useCSSVariable).mockReturnValue([card, foreground, background]);
    expect(useStackColors()).toEqual({
      headerStyle: { backgroundColor: card },
      headerTintColor: foreground,
      headerTitleStyle: { fontWeight: '600', color: foreground },
      contentStyle: { backgroundColor: background },
    });
  }
  expect(useCSSVariable).toHaveBeenCalledTimes(2);
  expect(useCSSVariable).toHaveBeenCalledWith(['--color-card', '--color-foreground', '--color-background']);
});

it('a token that has not resolved falls back to the light colour', () => {
  for (const tokens of [[undefined, '', 42], ['', 42, undefined], [42, undefined, '']]) {
    vi.mocked(useCSSVariable).mockReturnValue(tokens);
    expect(useStackColors()).toEqual({
      headerStyle: { backgroundColor: '#ffffff' },
      headerTintColor: '#111827',
      headerTitleStyle: { fontWeight: '600', color: '#111827' },
      contentStyle: { backgroundColor: '#f8f9fa' },
    });
  }
});
