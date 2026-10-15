import type { SyncNotice } from '@tallyui/core';
import { POS_ACCESS_REFUSED_TEXT } from './sign-in';
import { storageStartMessage } from './storage-start-failure';

// A till notice (TallyUI #261): the store refused the session, so the pull stays stopped until the cashier signs in again.
export const SESSION_ENDED_TEXT = 'Your session has ended. Sign in again to keep selling.';
export type CatalogueRefusal = 'session_ended' | 'access_refused';
export type CatalogueError = { text: string; refusal: CatalogueRefusal | null };
export type CatalogueStatus = { wasActive: boolean; failed: boolean; errorShown: boolean; dead: boolean; paused: boolean };
export const INITIAL_CATALOGUE_STATUS: CatalogueStatus = {
  wasActive: false,
  failed: false,
  errorShown: false,
  dead: false,
  paused: false,
};
export type CatalogueEvent =
  | { type: 'notice'; notice: SyncNotice | undefined }
  | { type: 'active'; active: boolean }
  | { type: 'error'; error: unknown }
  | { type: 'received' }
  | { type: 'health'; status: 'ok' | 'stalled' | 'dead' }
  | { type: 'start-failed'; error: unknown };
/** One step: the next state, the error to show (undefined: leave the shown error as it is; null: clear it), and whether a run just completed clean. */
export type CatalogueStep = { state: CatalogueStatus; error?: CatalogueError | null; synced?: boolean };

export function catalogueStatus(state: CatalogueStatus, event: CatalogueEvent): CatalogueStep {
  if (state.dead) return { state };
  switch (event.type) {
    case 'notice': {
      const { notice } = event;
      // From TallyUI 3.0 a refused session reaches notice$, never error$, and the pull pauses without an error.
      // A forbidden notice stands until the store answers a pull again: the errors rethrown meanwhile don't replace it.
      // The pull still retries on TallyUI's store schedule, but the app asks the cashier to sign in again (ADR 0023).
      const paused = notice?.fixedBy === 'till' || notice?.code === 'forbidden';
      const error: CatalogueError | undefined = notice?.code === 'unauthorized'
        ? { text: SESSION_ENDED_TEXT, refusal: 'session_ended' }
        : notice?.code === 'forbidden'
          ? { text: POS_ACCESS_REFUSED_TEXT, refusal: 'access_refused' } : undefined;
      return error ? { state: { ...state, paused, errorShown: true }, error }
        : { state: { ...state, paused } };
    }
    case 'active': {
      if (state.paused) return { state };
      // A new run starts clean; received$ also clears an error recovered by a retry within the same run.
      const failed = event.active && !state.wasActive ? false : state.failed;
      if (state.wasActive && !event.active && !failed) {
        return { state: { ...state, wasActive: false, failed, errorShown: false }, error: null, synced: true };
      }
      return { state: { ...state, wasActive: event.active, failed } };
    }
    case 'error': {
      if (state.paused) return { state };
      let inner: any = event.error;
      while (inner.parameters?.errors?.[0]) inner = inner.parameters.errors[0];
      return {
        state: { ...state, failed: true, errorShown: true },
        error: { text: inner.message ?? String(inner), refusal: null },
      };
    }
    case 'received':
      if (state.paused || !state.errorShown) return { state };
      return { state: { ...state, failed: false, errorShown: false }, error: null };
    case 'health':
      if (event.status !== 'dead') return { state };
      return {
        state: { ...state, dead: true },
        error: { text: 'Local storage stopped responding. Reload this page.', refusal: null },
      };
    case 'start-failed':
      return {
        state,
        error: { text: storageStartMessage(event.error) ?? (event.error as { message?: string }).message ?? String(event.error), refusal: null },
      };
  }
}
