/** The second screen's page for this till's store: `?store=` prefills the display page's store field (lib/display-page.tsx). */
export function displayPageUrl(origin: string, storeUrl: string): string {
  return `${origin.replace(/\/$/, '')}/display?store=${encodeURIComponent(storeUrl)}`;
}
