import { describe, expect, it } from 'vitest';
import { signOutLockReason } from './sign-out-lock';

describe('signOutLockReason', () => {
  it('nothing pending: no reason, so Sign out is open', () => {
    expect(signOutLockReason({ saving: false, savesInFlight: 0, closing: false })).toBeUndefined();
  });

  it('a sale saving or a save in flight: waits until the sale is saved', () => {
    expect(signOutLockReason({ saving: true, savesInFlight: 0, closing: false }))
      .toBe('Sign out waits until the sale is saved.');
    expect(signOutLockReason({ saving: false, savesInFlight: 2, closing: false }))
      .toBe('Sign out waits until the sale is saved.');
  });

  it('a register closing wins over a save', () => {
    expect(signOutLockReason({ saving: true, savesInFlight: 1, closing: true }))
      .toBe('Sign out waits for the register to finish closing.');
  });

  it('locked exactly when the old condition locked it', () => {
    for (const saving of [false, true]) {
      for (const savesInFlight of [0, 1]) {
        for (const closing of [false, true]) {
          const state = { saving, savesInFlight, closing };
          expect(signOutLockReason(state) !== undefined)
            .toBe(state.saving || state.savesInFlight > 0 || state.closing);
        }
      }
    }
  });
});
