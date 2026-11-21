export const DEMO_PUBLIC_NOTE = 'Grind the filter beans for a pour-over, please.';
export const DEMO_STAFF_NOTE = 'Regular: offer the coffee club card next visit.';

/** The demo order history entries for seeded order '2' (DEMO-000002): one public note, one private note, and one state change the notes read must filter out. */
export const DEMO_ORDER_HISTORY: Record<string, { id: string; type: string; createdAt: string; isPublic: boolean; data: Record<string, unknown> }[]> = {
  '2': [
    { id: 'h1', type: 'ORDER_STATE_TRANSITION', createdAt: '2026-01-01T10:00:00.000Z', isPublic: true, data: { from: 'ArrangingPayment', to: 'PaymentSettled' } },
    { id: 'h2', type: 'ORDER_NOTE', createdAt: '2026-01-01T10:01:00.000Z', isPublic: true, data: { note: DEMO_PUBLIC_NOTE } },
    { id: 'h3', type: 'ORDER_NOTE', createdAt: '2026-01-01T10:02:00.000Z', isPublic: false, data: { note: DEMO_STAFF_NOTE } },
  ],
};
