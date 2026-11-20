import { Platform } from 'react-native';

/**
 * Print-only marks, beside TallyUI's print-hide: `[data-print="only"]` shows on paper and never on screen, and
 * `[data-print="sheet"]` lets a side sheet grow to its content on paper (the unpaid bill, CHECKLIST 2.11b).
 */
export function injectPrintOnlyStyle(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || document.getElementById('pos-print-only-style')) return;
  const style = document.createElement('style');
  style.id = 'pos-print-only-style';
  style.textContent = '@media screen { [data-print="only"] { display: none !important } } '
    + '@media print { [data-print="sheet"] { position: static !important; height: auto !important; max-width: none !important; border: 0 !important } }';
  document.head.appendChild(style);
}
