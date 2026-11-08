/** Full page load that replaces the current history entry. */
export function replaceLocation(href: string): void {
  window.location.replace(href);
}
