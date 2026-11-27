import { detectBrowserExecutable } from "./browser-finder.js";
import { DaemonClient } from "./daemon-client.js";
import { buildPaths, loadConfig, loadSelectors } from "./storage.js";

async function main(): Promise<void> {
  const [command = "doctor", arg1, arg2] = process.argv.slice(2);
  const client = new DaemonClient();

  if (command === "doctor") {
    const paths = buildPaths();
    const config = loadConfig(paths);
    const selectors = loadSelectors(paths);
    const browser = detectBrowserExecutable(config);
    const running = await client.getRunningDaemon();
    console.log(
      JSON.stringify(
        {
          ok: true,
          nodeVersion: process.version,
          rootDir: paths.rootDir,
          browser,
          daemonRunning: Boolean(running),
          daemonInfo: running
            ? { pid: running.pid, host: running.host, port: running.port, startedAt: running.startedAt }
            : null,
          config: {
            daemonPort: config.daemonPort,
            cdpPortBase: config.cdpPortBase,
            windowMode: config.windowMode,
            language: config.language,
            defaultAccount: config.defaultAccount,
          },
          selectorsAppUrl: selectors.appUrl,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify(await client.health(), null, 2));
    return;
  }

  if (command === "accounts") {
    console.log(JSON.stringify(await client.request("GET", "/api/accounts"), null, 2));
    return;
  }

  if (command === "refresh") {
    const scopeOrAccount = arg1 || "stale";
    const body =
      scopeOrAccount === "stale" || scopeOrAccount === "all"
        ? { scope: scopeOrAccount }
        : { scope: "single", account: scopeOrAccount };
    console.log(JSON.stringify(await client.request("POST", "/api/accounts/refresh", body, 180000), null, 2));
    return;
  }

  if (command === "login") {
    const res = await client.request("POST", "/api/accounts/login", {
      ...(arg1 ? { account: arg1 } : {}),
      ...(arg2 ? { label: arg2 } : {}),
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "capabilities") {
    const res = await client.request("POST", "/api/capabilities", {
      ...(arg1 ? { account: arg1 } : {}),
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "stop") {
    const res = await client.shutdownIfRunning();
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    return;
  }

  console.error("用法: node dist/src/cli.js <doctor|status|accounts|login [account] [label]|capabilities [account]|stop>");
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
