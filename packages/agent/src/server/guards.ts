/**
 * Local-only guards. The server binds to 127.0.0.1 and is unauthenticated
 * (single local user by design), but loopback binding alone does not stop
 * browsers: any webpage can open a cross-origin WebSocket to 127.0.0.1 (CORS
 * does not apply to WS), and DNS rebinding lets a page read the REST API with
 * same-origin fetches. These checks close both holes.
 *
 * A local *hostname* is necessary but not sufficient: every page served from
 * loopback shares 127.0.0.1/localhost, so without a port check any other
 * process bound to any localhost port (a random dev server on :3000, a
 * malicious `npm run` script) could drive this API too (H6). isLocalOrigin
 * additionally requires the Origin's port to be either the agent's own bound
 * port or an explicitly trusted dev-server port.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

function originPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Ports this server currently trusts an Origin header from. */
export interface OriginPolicy {
  /** The port the agent's HTTP/WS server is actually bound to. env.port can
   * be 0 (ephemeral, tests) so callers must read the *resolved* listen
   * port, not env.port, once the server is up. */
  ownPort: number;
  /** Extra trusted dev-server ports (vite on :5173 by default) — see
   * env.ts `devOriginPorts` / BOTTY_DEV_ORIGIN_PORTS. */
  devPorts: readonly number[];
}

/**
 * True when the Origin header is absent (non-browser clients like the TUI or
 * curl — they never send Origin, and are unaffected either way) or names a
 * local page on a *trusted* port: the agent's own bound port (the web app
 * served by this same process) or a configured dev-server port (the vite dev
 * server on :5173 proxies /api and /ws and forwards the browser's real
 * Origin). Any other origin is rejected, including other localhost ports —
 * loopback-bound does not mean this-app-only, so the port must match too.
 */
export function isLocalOrigin(origin: string | undefined, policy: OriginPolicy): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!isLocalHostname(url.hostname)) return false;
  const port = originPort(url);
  return port === policy.ownPort || policy.devPorts.includes(port);
}

/** True when a Host header (`host[:port]`) points at loopback — DNS-rebinding guard. */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return isLocalHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}
