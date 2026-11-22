import type { SalesCardId, SalesPanelId } from '@tallyui/components';
import type { SalesFigures } from '@tallyui/pos';

/** The card's TallyUI panel, or null for Orders and Refunds (no panel in 4.2.0: they open the Orders screen, TallyUI/tallyui#1215). */
export function cardPanel(card: SalesCardId): SalesPanelId | null {
  switch (card) {
    case 'payments':
    case 'products':
    case 'categories':
    case 'taxes':
      return card;
    // Stand-in: remove when TallyUI/tallyui#1215 ships Orders/Refunds panels or a per-card open control.
    case 'orders':
    case 'refunds':
      return null;
  }
}

/** The panel's scope line: the period as Print summary words it ("2026-11-17" or "2026-11-17 – 2026-11-18"), then " · <tillOnly>" when the figures are this till's own. */
export function panelScope(figures: SalesFigures, tillOnly: string | null): string {
  const { from, to } = figures.range;
  const period = from === to ? from : `${from} – ${to}`;
  return tillOnly ? `${period} · ${tillOnly}` : period;
}

/** TallyUI's file name, unchanged for the store's figures; for this till's own, "sales-<card>-this-till-<from>-<to>.csv" (8.1n's marker). */
export function panelCsvFileName(card: SalesPanelId, filename: string, tillOnly: string | null): string {
  const prefix = `sales-${card}-`;
  if (tillOnly === null || !filename.startsWith(prefix)) return filename;
  return `sales-${card}-this-till-${filename.slice(prefix.length)}`;
}
