/**
 * 9.5e: an overlay drawn over the till leaves the receipt marker visible, so window.print() would print the overlay.
 * A dialog containing the marker is the receipt's own parent and does not cover it.
 */
export function coveredByDialog(node: Node, root: ParentNode): boolean {
  return Array.from(root.querySelectorAll('[role="dialog"]')).some((d) => !d.contains(node));
}
