import type { Page } from '@playwright/test';

/**
 * A keyboard-wedge scan at scanner speed: each key's keydown and keyup, then Enter's, dispatched to the focus in one
 * synchronous loop, so every gap is well under WEDGE_KEY_GAP_MS however loaded the machine (Playwright's per-key round
 * trips can exceed it on a CI runner). Each key does what a real one would: an uncancelled printable keydown in a text
 * input inserts its character, an uncancelled Enter clicks a focused <button> (react-native-web leaves a native button's
 * press to that click), and the keyup always follows (it presses any other control), so a key the listener fails to
 * hold still reaches the field or presses the control.
 */
export async function wedgeScan(page: Page, code: string) {
  await page.evaluate((keys) => {
    for (const key of keys) {
      const target = document.activeElement ?? document.body;
      const init = { key, bubbles: true, cancelable: true };
      const typed = target.dispatchEvent(new KeyboardEvent('keydown', init));
      if (typed && key.length === 1 && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        document.execCommand('insertText', false, key);
      } else if (typed && key === 'Enter' && target instanceof HTMLButtonElement) {
        target.click();
      }
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    }
  }, [...code, 'Enter']);
}
