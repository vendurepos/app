import { describe, expect, it } from 'vitest';
import { signOutLockReason } from './sign-out-lock';

const open = { saving: false, savesInFlight: 0, closing: false, holdsPayment: false };

describe('signOutLockReason', () => {
  it('nothing pending: no reason, so Sign out is open', () => {
    expect(signOutLockReason(open)).toBeUndefined();
  });

  it('a sale saving or a save in flight: waits until the sale is saved', () => {
    expect(signOutLockReason({ ...open, saving: true }))
      .toBe('Sign out waits until the sale is saved.');
    expect(signOutLockReason({ ...open, savesInFlight: 2 }))
      .toBe('Sign out waits until the sale is saved.');
  });

  it('a register closing wins over a save', () => {
    expect(signOutLockReason({ saving: true, savesInFlight: 1, closing: true, holdsPayment: false }))
      .toBe('Sign out waits for the register to finish closing.');
  });

  it('a sale holding a payment: take the rest or cancel it first', () => {
    expect(signOutLockReason({ ...open, holdsPayment: true }))
      .toBe('Take the rest of the payment or cancel it before signing out.');
  });

  it('a sale saving (or failed) with its payment held says it waits for the save', () => {
    expect(signOutLockReason({ ...open, saving: true, holdsPayment: true }))
      .toBe('Sign out waits until the sale is saved.');
  });

  it('a register closing with a payment held says it waits for the closing', () => {
    expect(signOutLockReason({ ...open, closing: true, holdsPayment: true }))
      .toBe('Sign out waits for the register to finish closing.');
  });

  it('locked exactly when a save, a closing or a held payment locks it', () => {
    for (const saving of [false, true]) {
      for (const savesInFlight of [0, 1]) {
        for (const closing of [false, true]) {
          for (const holdsPayment of [false, true]) {
            const state = { saving, savesInFlight, closing, holdsPayment };
            expect(signOutLockReason(state) !== undefined)
              .toBe(state.saving || state.savesInFlight > 0 || state.closing || state.holdsPayment);
          }
        }
      }
    }
  });
});
