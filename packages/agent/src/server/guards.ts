/**
 * Local-only guards. The server binds to 127.0.0.1 and is unauthenticated
 * (single local user by design), but loopback binding alone does not stop
 * browsers: any webpage can open a cross-origin WebSocket to 127.0.0.1 (CORS
 * does not apply to WS), and DNS rebinding lets a page read the REST API with
 * same-origin fetches. These checks close both holes.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * True when the Origin header is absent (non-browser clients like the TUI or
 * curl) or names a local page (any port — the vite dev server on :5173
 * proxies /ws and forwards the browser's Origin).
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
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
