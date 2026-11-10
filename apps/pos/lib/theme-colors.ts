import { useCSSVariable } from 'uniwind';

// Light tokens from @tallyui/theme/src/tokens.css.
const LIGHT_CARD = '#ffffff';
const LIGHT_FOREGROUND = '#111827';
const LIGHT_BACKGROUND = '#f8f9fa';

export interface StackColors {
  headerStyle: { backgroundColor: string };
  headerTintColor: string;
  headerTitleStyle: { fontWeight: '600'; color: string };
  contentStyle: { backgroundColor: string };
}

/** The navigator's colours from the theme tokens, so the header follows light and dark. */
export function useStackColors(): StackColors {
  const [card, foreground, background] = useCSSVariable(['--color-card', '--color-foreground', '--color-background']);
  const foregroundColor = typeof foreground === 'string' && foreground.length > 0 ? foreground : LIGHT_FOREGROUND;
  return {
    headerStyle: { backgroundColor: typeof card === 'string' && card.length > 0 ? card : LIGHT_CARD },
    headerTintColor: foregroundColor,
    headerTitleStyle: { fontWeight: '600', color: foregroundColor },
    contentStyle: { backgroundColor: typeof background === 'string' && background.length > 0 ? background : LIGHT_BACKGROUND },
  };
}
