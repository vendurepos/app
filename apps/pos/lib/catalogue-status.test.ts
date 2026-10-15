import { describe, expect, it } from 'vitest';
import { catalogueStatus, INITIAL_CATALOGUE_STATUS, SESSION_ENDED_TEXT, type CatalogueEvent } from './catalogue-status';
import { POS_ACCESS_REFUSED_TEXT } from './sign-in';

describe('catalogueStatus', () => {
  it('reports a clean run only on its falling edge', () => {
    expect(catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'active', active: false })).not.toHaveProperty('synced');
    const active = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'active', active: true });
    expect(active).not.toHaveProperty('error');
    expect(active).not.toHaveProperty('synced');
    expect(catalogueStatus(active.state, { type: 'active', active: false })).toEqual({
      state: INITIAL_CATALOGUE_STATUS, error: null, synced: true,
    });
  });

  it('unwraps nested pull errors and prevents a failed run from reporting synced', () => {
    const active = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'active', active: true });
    const error = { parameters: { errors: [{ parameters: { errors: [new Error('Pull failed')] } }] } };
    const failed = catalogueStatus(active.state, { type: 'error', error });
    expect(failed.error).toEqual({ text: 'Pull failed', refusal: null });
    expect(failed.state).toEqual({ ...active.state, failed: true, errorShown: true });
    const stillActive = catalogueStatus(failed.state, { type: 'active', active: true });
    expect(stillActive.state.failed).toBe(true);
    const ended = catalogueStatus(stillActive.state, { type: 'active', active: false });
    expect(ended).not.toHaveProperty('synced');
    expect(ended).not.toHaveProperty('error');
  });

  it('starts a new run clean after a failed run', () => {
    let { state } = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'active', active: true });
    ({ state } = catalogueStatus(state, { type: 'error', error: new Error('Pull failed') }));
    ({ state } = catalogueStatus(state, { type: 'active', active: false }));
    const restarted = catalogueStatus(state, { type: 'active', active: true });
    expect(restarted.state).toEqual({ ...state, wasActive: true, failed: false });
    expect(restarted).not.toHaveProperty('error');
    expect(catalogueStatus(restarted.state, { type: 'active', active: false })).toEqual({
      state: INITIAL_CATALOGUE_STATUS, error: null, synced: true,
    });
  });

  it('clears a shown error on receipt and ignores receipt when nothing is shown', () => {
    const ignored = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'received' });
    expect(ignored).toEqual({ state: INITIAL_CATALOGUE_STATUS });
    expect(ignored.state).toBe(INITIAL_CATALOGUE_STATUS);
    let { state } = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'active', active: true });
    ({ state } = catalogueStatus(state, { type: 'error', error: new Error('Pull failed') }));
    const received = catalogueStatus(state, { type: 'received' });
    expect(received).toEqual({ state: { ...state, failed: false, errorShown: false }, error: null });
    expect(catalogueStatus(received.state, { type: 'active', active: false }).synced).toBe(true);
    const again = catalogueStatus(received.state, { type: 'received' });
    expect(again).toEqual({ state: received.state });
    expect(again.state).toBe(received.state);
  });

  it('keeps an unauthorized till refusal over later active, received and error events', () => {
    const active = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'active', active: true });
    const refused = catalogueStatus(active.state, {
      type: 'notice', notice: { code: 'unauthorized', fixedBy: 'till', since: 0 },
    });
    expect(refused.error).toEqual({ text: SESSION_ENDED_TEXT, refusal: 'session_ended' });
    expect(refused.state).toEqual({ ...active.state, paused: true, errorShown: true });
    const events: CatalogueEvent[] = [
      { type: 'active', active: false }, { type: 'active', active: true },
      { type: 'received' }, { type: 'error', error: new Error('Later failure') },
    ];
    for (const event of events) {
      const step = catalogueStatus(refused.state, event);
      expect(step).toEqual({ state: refused.state });
      expect(step.state).toBe(refused.state);
    }
  });

  it('holds a forbidden store refusal until the notice clears and a clean run completes', () => {
    const refused = catalogueStatus(INITIAL_CATALOGUE_STATUS, {
      type: 'notice', notice: { code: 'forbidden', fixedBy: 'store', since: 0 },
    });
    expect(refused.error).toEqual({ text: POS_ACCESS_REFUSED_TEXT, refusal: 'access_refused' });
    expect(refused.state).toEqual({ ...INITIAL_CATALOGUE_STATUS, paused: true, errorShown: true });
    const ignored = catalogueStatus(refused.state, { type: 'error', error: new Error('403') });
    expect(ignored).toEqual({ state: refused.state });
    expect(ignored.state).toBe(refused.state);
    const cleared = catalogueStatus(ignored.state, { type: 'notice', notice: undefined });
    expect(cleared).toEqual({ state: { ...refused.state, paused: false } });
    const active = catalogueStatus(cleared.state, { type: 'active', active: true });
    expect(catalogueStatus(active.state, { type: 'active', active: false })).toEqual({
      state: INITIAL_CATALOGUE_STATUS, error: null, synced: true,
    });
  });

  it('updates pause state for other notices without replacing the shown error', () => {
    const failed = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'error', error: 'Pull failed' });
    expect(failed.error).toEqual({ text: 'Pull failed', refusal: null });
    const paused = catalogueStatus(failed.state, {
      type: 'notice', notice: { code: 'other', fixedBy: 'till', since: 0 },
    });
    expect(paused).toEqual({ state: { ...failed.state, paused: true } });
    expect(catalogueStatus(paused.state, {
      type: 'notice', notice: { code: 'other', fixedBy: 'store', since: 0 },
    })).toEqual({ state: failed.state });
  });

  it('shows dead storage and ignores every later event', () => {
    const dead = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'health', status: 'dead' });
    expect(dead).toEqual({
      state: { ...INITIAL_CATALOGUE_STATUS, dead: true },
      error: { text: 'Local storage stopped responding. Reload this page.', refusal: null },
    });
    const events: CatalogueEvent[] = [
      { type: 'notice', notice: { code: 'unauthorized', fixedBy: 'till', since: 0 } },
      { type: 'notice', notice: undefined },
      { type: 'active', active: true }, { type: 'active', active: false },
      { type: 'error', error: new Error('Later pull failure') }, { type: 'received' },
      { type: 'health', status: 'ok' }, { type: 'health', status: 'stalled' }, { type: 'health', status: 'dead' },
      { type: 'start-failed', error: new Error('Later start failure') },
    ];
    for (const event of events) {
      const step = catalogueStatus(dead.state, event);
      expect(step).toEqual({ state: dead.state });
      expect(step.state).toBe(dead.state);
    }
  });

  it('ignores ok and stalled health statuses', () => {
    for (const status of ['ok', 'stalled'] as const) {
      const step = catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'health', status });
      expect(step).toEqual({ state: INITIAL_CATALOGUE_STATUS });
      expect(step.state).toBe(INITIAL_CATALOGUE_STATUS);
    }
  });

  it('uses storage start wording, otherwise the error message or string value', () => {
    const error = new Error('no OPFS');
    error.name = 'StorageUnavailableError';
    expect(catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'start-failed', error })).toEqual({
      state: INITIAL_CATALOGUE_STATUS,
      error: { text: "This browser window can't keep VendurePOS's data, as in a private window. Open VendurePOS in a normal window.", refusal: null },
    });
    for (const error of [new Error('Start failed'), 'Start failed']) {
      expect(catalogueStatus(INITIAL_CATALOGUE_STATUS, { type: 'start-failed', error })).toEqual({
        state: INITIAL_CATALOGUE_STATUS, error: { text: 'Start failed', refusal: null },
      });
    }
  });

  it('never mutates its input state', () => {
    let state = Object.freeze({ ...INITIAL_CATALOGUE_STATUS });
    const events: CatalogueEvent[] = [
      { type: 'active', active: true }, { type: 'error', error: new Error('Pull failed') },
      { type: 'received' }, { type: 'active', active: false },
      { type: 'notice', notice: { code: 'forbidden', fixedBy: 'store', since: 0 } },
      { type: 'notice', notice: undefined }, { type: 'start-failed', error: new Error('Start failed') },
      { type: 'health', status: 'dead' },
    ];
    for (const event of events) {
      const before = { ...state };
      const step = catalogueStatus(state, event);
      expect(state).toEqual(before);
      state = Object.freeze(step.state);
    }
  });
});
