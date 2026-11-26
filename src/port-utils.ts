import net from "node:net";

/**
 * Non-destructively test whether a TCP port is available on the given host.
 */
export function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Find an available port starting from basePort with adaptive fallback increments.
 */
export async function findAvailablePort(
  basePort: number,
  host = "127.0.0.1",
  maxAttempts = 50,
  reservedPorts: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = basePort + offset;
    if (candidate > 65535) break;
    if (reservedPorts.has(candidate)) continue;
    if (await isPortAvailable(candidate, host)) {
      return candidate;
    }
  }
  throw new Error(`无法在 ${host}:${basePort}-${basePort + maxAttempts - 1} 范围内找到可用端口`);
}

export async function waitForHttpReady(
  url: string,
  timeoutMs = 15000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(2000, timeoutMs));
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
