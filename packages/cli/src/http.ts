import fs from 'node:fs';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

export async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json();
}

/** Poll until `url` responds 2xx, else throw with the tail of `logFile`. */
export async function waitHealthy(url: string, logFile: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  let tail = '';
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
    tail = lines.slice(-15).join('\n');
  } catch {
    /* no log yet */
  }
  throw new Error(`${url} not healthy after ${timeoutMs / 1000}s.\n--- ${logFile} (tail) ---\n${tail}`);
}
