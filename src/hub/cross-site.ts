/**
 * Cross-site write rejection, shared by both HTTP surfaces.
 *
 * Its own module rather than an export from either server: the nest and each
 * gaggle both mount `/api/control/*`, and importing one server from the other to
 * share ten lines would drag a whole dashboard's worth of dependencies with it.
 */

/**
 * Is this a mutating request a *browser* sent from another site?
 *
 * Worth stating why this appeared late. These endpoints used to mean "restart a
 * process"; they now mean "dispatch an agent that writes code and opens a pull
 * request", and that changes what a drive-by page on an unrelated site is worth.
 * Both servers bind loopback, an attacker cannot read the response, and every
 * ticket action needs a UUID they would have to guess — but `POST
 * /api/control/sync` needs no id at all, and the handlers parse a body regardless
 * of `Content-Type`, so a plain form post reaches them with no preflight.
 *
 * `Sec-Fetch-Site` is set by the browser and page script cannot forge it. The test
 * is deliberately "present and cross-site" rather than "must be same-origin":
 * curl, the CLI, and the gaggle-to-hub calls send no such header at all, and
 * demanding one would break every non-browser client in order to defend against a
 * browser-only attack. `none` means the user typed the URL or used a bookmark,
 * which is not cross-site.
 */
export function crossSiteWrite(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  const site = req.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}
