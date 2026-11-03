/** The address a driver opens. Built from where HR is looking at it, so it matches the deployment. */
export function applyUrl(slug: string): string {
  return `${window.location.origin}/apply/${slug}`;
}
