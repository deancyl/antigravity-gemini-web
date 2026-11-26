import { ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Browser, BrowserContext, chromium, Page } from "playwright-core";
import { detectBrowserExecutable } from "./browser-finder.js";
import { findAvailablePort, waitForHttpReady } from "./port-utils.js";
import { appendLog, BridgePaths, ensureDir, StateStore } from "./storage.js";
import { BridgeConfig, BridgeError } from "./types.js";

/**
 * Non-invasive clipboard interceptor injected into the browser context ONLY.
 * When clicking Gemini's official Copy button, captures lossless Markdown into
 * window.__GEMINI_BRIDGE_CLIPBOARD__ without overwriting the user's Windows clipboard.
 */
const CLIPBOARD_HOOK_SCRIPT = `
(() => {
  if (window.__GEMINI_BRIDGE_CLIPBOARD_HOOKED__) return;
  window.__GEMINI_BRIDGE_CLIPBOARD_HOOKED__ = true;
  window.__GEMINI_BRIDGE_CLIPBOARD__ = null;
  window.__GEMINI_BRIDGE_CLIPBOARD_TS__ = 0;

  const capture = (text) => {
    if (typeof text === 'string') {
      window.__GEMINI_BRIDGE_CLIPBOARD__ = text;
      window.__GEMINI_BRIDGE_CLIPBOARD_TS__ = Date.now();
    }
  };

  try {
    const clip = navigator.clipboard;
    if (clip) {
      const origWriteText = typeof clip.writeText === 'function' ? clip.writeText.bind(clip) : null;
      const origWrite = typeof clip.write === 'function' ? clip.write.bind(clip) : null;

      Object.defineProperty(clip, 'writeText', {
        configurable: true,
        writable: true,
        value: async (text) => {
          capture(String(text ?? ''));
          if (window.__GEMINI_BRIDGE_INTERCEPT_ACTIVE__) {
            return;
          }
          if (origWriteText) return origWriteText(text);
        }
      });

      Object.defineProperty(clip, 'write', {
        configurable: true,
        writable: true,
        value: async (items) => {
          try {
            if (Array.isArray(items)) {
              for (const item of items) {
                if (item && typeof item.getType === 'function' && item.types) {
                  const plainType = item.types.includes('text/plain') ? 'text/plain' : item.types[0];
                  if (plainType) {
                    const blob = await item.getType(plainType);
                    const text = await blob.text();
                    capture(text);
                  }
                }
              }
            }
          } catch {}
          if (window.__GEMINI_BRIDGE_INTERCEPT_ACTIVE__) {
            return;
          }
          if (origWrite) return origWrite(items);
        }
      });
    }
  } catch {}
})();
`;

export interface ManagedChromeSession {
  accountId: string;
  profileDir: string;
  cdpPort: number;
  child: ChildProcess;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastActivityAt: number;
}

export class ChromeManager {
  private readonly paths: BridgePaths;
  private readonly config: BridgeConfig;
  private readonly store: StateStore;
  private readonly sessions = new Map<string, ManagedChromeSession>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly reservedCdpPorts = new Set<number>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(paths: BridgePaths, config: BridgeConfig, store: StateStore) {
    this.paths = paths;
    this.config = config;
    this.store = store;
    this.startIdleReaper();
  }

  private startIdleReaper(): void {
    const idleMins = this.config.idleSessionMinutes ?? 10;
    if (idleMins <= 0) return;
    const ttlMs = idleMins * 60 * 1000;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [accountId, session] of this.sessions.entries()) {
        if (this.locks.has(accountId)) continue;
        if (now - session.lastActivityAt >= ttlMs) {
          appendLog(
            this.paths,
            "INFO",
            `Auto-reclaiming idle Chrome session for account=${accountId} (idle >= ${idleMins}m)`,
          );
          void this.closeSession(accountId);
        }
      }
    }, 60_000);
    this.idleTimer.unref();
  }

  /**
   * Launch a completely normal, un-instrumented real Chrome window bound to an isolated
   * profile directory so Google Login never rejects it as "This browser or app may not be secure".
   */
  async openLoginWindow(rawAccountId: string, label?: string): Promise<{
    accountId: string;
    profileDir: string;
    browserPath: string;
    url: string;
    closedManagedSession: boolean;
  }> {
    const account = await this.store.ensureAccount(rawAccountId, label);
    let closedManagedSession = false;

    // Close any automated CDP instance using this profile first so Chrome does not collide on SingletonLock.
    if (this.sessions.has(account.id)) {
      await this.closeSession(account.id);
      closedManagedSession = true;
      await new Promise((r) => setTimeout(r, 600));
    }

    const detected = detectBrowserExecutable(this.config);
    ensureDir(account.profileDir);

    const langParam = this.config.language ? `?hl=${encodeURIComponent(this.config.language)}` : "";
    const url = `https://gemini.google.com/app${langParam}`;

    // IMPORTANT: Zero automation flags and windowsHide: false (never pass CREATE_NO_WINDOW to Chrome!)
    const args = [
      `--user-data-dir=${path.resolve(account.profileDir)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      url,
    ];
    if (this.config.proxyServer && this.config.proxyServer.trim()) {
      args.push(`--proxy-server=${this.config.proxyServer.trim()}`);
    }

    const child = spawn(detected.executablePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();

    appendLog(
      this.paths,
      "INFO",
      `Opened manual login Chrome window for account=${account.id}, profile=${account.profileDir}`,
    );

    return {
      accountId: account.id,
      profileDir: account.profileDir,
      browserPath: detected.executablePath,
      url,
      closedManagedSession,
    };
  }

  /**
   * Serialize operations per account so concurrent calls never fight over the same tab/DOM.
   */
  async withAccountLock<T>(rawAccountId: string, fn: (session: ManagedChromeSession) => Promise<T>): Promise<T> {
    const account = await this.store.ensureAccount(rawAccountId);
    const prev = this.locks.get(account.id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.catch(() => undefined).then(() => next);
    this.locks.set(account.id, chained);

    await prev.catch(() => undefined);
    try {
      const session = await this.ensureSession(account.id, account.profileDir);
      session.lastActivityAt = Date.now();
      const result = await fn(session);
      session.lastActivityAt = Date.now();
      return result;
    } finally {
      release();
      if (this.locks.get(account.id) === chained) {
        this.locks.delete(account.id);
      }
    }
  }

  /**
   * On Windows, Chrome may leave windowless background processes (MainWindowHandle == 0,
   * e.g. via --restart or background apps) holding an isolated profile lock even after
   * the user closed the login window. Only clean up processes strictly scoped to this
   * exact profileDir when ZERO visible windows remain for that profile.
   */
  private cleanupWindowlessProfileProcesses(profileDir: string): {
    hadVisibleWindow: boolean;
    cleanedCount: number;
  } {
    if (process.platform !== "win32") {
      return { hadVisibleWindow: false, cleanedCount: 0 };
    }
    const resolvedDir = path.resolve(profileDir);
    const escapedForPs = resolvedDir.replace(/'/g, "''");
    const psScript = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      `$target = '${escapedForPs}'.ToLowerInvariant()`,
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($target) }",
      "$visible = @()",
      "$allPids = @()",
      "foreach ($p in $procs) {",
      "  $allPids += [int]$p.ProcessId",
      "  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue",
      "  if ($gp -and [int64]$gp.MainWindowHandle -ne 0) { $visible += [int]$p.ProcessId }",
      "}",
      "if ($visible.Count -gt 0) {",
      "  Write-Output ('VISIBLE:' + ($visible -join ','))",
      "} elseif ($allPids.Count -gt 0) {",
      "  foreach ($id in $allPids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
      "  Write-Output ('CLEANED:' + $allPids.Count)",
      "} else {",
      "  Write-Output 'NONE:0'",
      "}",
    ].join("\n");

    try {
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      const rawBuf = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: 10000 },
      );
      const out = rawBuf.toString("utf8").trim();
      if (/^VISIBLE:/m.test(out)) {
        return { hadVisibleWindow: true, cleanedCount: 0 };
      }
      const m = out.match(/^CLEANED:(\d+)/m);
      if (m) {
        const count = Number(m[1]) || 0;
        appendLog(
          this.paths,
          "INFO",
          `Cleaned ${count} windowless background browser process(es) holding profile ${resolvedDir}`,
        );
        return { hadVisibleWindow: false, cleanedCount: count };
      }
    } catch {
      // Non-fatal: proceed to normal launch check
    }
    return { hadVisibleWindow: false, cleanedCount: 0 };
  }

  private async ensureSession(accountId: string, profileDir: string): Promise<ManagedChromeSession> {
    const existing = this.sessions.get(accountId);
    if (existing) {
      if (existing.browser.isConnected()) {
        try {
          if (existing.page.isClosed()) {
            const pages = existing.context.pages().filter((p) => !p.isClosed());
            existing.page = pages[0] ?? (await existing.context.newPage());
            await existing.page.addInitScript(CLIPBOARD_HOOK_SCRIPT);
          }
          return existing;
        } catch {
          await this.closeSession(accountId);
        }
      } else {
        await this.closeSession(accountId);
      }
    }

    const detected = detectBrowserExecutable(this.config);
    ensureDir(profileDir);

    const cleanup = this.cleanupWindowlessProfileProcesses(profileDir);
    if (cleanup.hadVisibleWindow) {
      throw new BridgeError(
        "PROFILE_LOCKED_BY_LOGIN_WINDOW",
        `账号 '${accountId}' 的手动登录 Chrome 窗口仍处于打开状态，请先关闭该窗口再重试。`,
        { accountId, profileDir },
      );
    }
    if (cleanup.cleanedCount > 0) {
      await new Promise((r) => setTimeout(r, 600));
    }

    const cdpPort = await findAvailablePort(
      this.config.cdpPortBase,
      "127.0.0.1",
      100,
      this.reservedCdpPorts,
    );
    this.reservedCdpPorts.add(cdpPort);

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${path.resolve(profileDir)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1366,900",
    ];

    if (this.config.windowMode === "headless") {
      args.push("--headless=new");
    } else if (this.config.windowMode === "minimized") {
      args.push("--start-minimized");
    }

    if (this.config.proxyServer && this.config.proxyServer.trim()) {
      args.push(`--proxy-server=${this.config.proxyServer.trim()}`);
    }

    // Never pass CREATE_NO_WINDOW / windowsHide: true to Chrome GUI host!
    let exitedEarlyCode: number | null = null;
    const child = spawn(detected.executablePath, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    });

    child.once("exit", (code) => {
      exitedEarlyCode = code ?? 0;
    });

    const cdpUrl = `http://127.0.0.1:${cdpPort}/json/version`;
    const ready = await waitForHttpReady(cdpUrl, 12000, 250);

    if (!ready) {
      this.reservedCdpPorts.delete(cdpPort);
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore
      }
      const hasLockFile =
        fs.existsSync(path.join(profileDir, "SingletonLock")) ||
        fs.existsSync(path.join(profileDir, "lockfile"));

      if (exitedEarlyCode !== null || hasLockFile) {
        throw new BridgeError(
          "PROFILE_LOCKED_BY_LOGIN_WINDOW",
          `账号 '${accountId}' 的 Chrome Profile 已被另一个未受控的 Chrome 窗口占用（通常是刚才打开的手动登录窗口尚未关闭）。请先关闭该账号对应的 Chrome 窗口，再重试。`,
          { accountId, profileDir, exitedEarlyCode },
        );
      }

      throw new BridgeError(
        "INTERNAL_ERROR",
        `未能连接到账号 '${accountId}' 的 Chrome CDP 调试端口 (${cdpPort})。`,
        { accountId, cdpPort, browserPath: detected.executablePath },
      );
    }

    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const contexts = browser.contexts();
      const context = contexts[0] ?? (await browser.newContext({ viewport: { width: 1366, height: 900 } }));
      await context.addInitScript(CLIPBOARD_HOOK_SCRIPT);

      const pages = context.pages().filter((p) => !p.isClosed());
      const page = pages[0] ?? (await context.newPage());
      await page.addInitScript(CLIPBOARD_HOOK_SCRIPT);

      const session: ManagedChromeSession = {
        accountId,
        profileDir,
        cdpPort,
        child,
        browser,
        context,
        page,
        lastActivityAt: Date.now(),
      };

      browser.once("disconnected", () => {
        if (this.sessions.get(accountId) === session) {
          this.sessions.delete(accountId);
          this.reservedCdpPorts.delete(cdpPort);
        }
      });

      this.sessions.set(accountId, session);
      appendLog(
        this.paths,
        "INFO",
        `Connected CDP session for account=${accountId} on port=${cdpPort} (${detected.browser})`,
      );
      return session;
    } catch (err) {
      this.reservedCdpPorts.delete(cdpPort);
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  getActiveSessionSummary(): Array<{ accountId: string; cdpPort: number; connected: boolean }> {
    return Array.from(this.sessions.values()).map((s) => ({
      accountId: s.accountId,
      cdpPort: s.cdpPort,
      connected: s.browser.isConnected(),
    }));
  }

  async closeSession(accountId: string): Promise<boolean> {
    const session = this.sessions.get(accountId);
    if (!session) return false;
    this.sessions.delete(accountId);
    this.reservedCdpPorts.delete(session.cdpPort);

    try {
      await session.browser.close();
    } catch {
      // ignore
    }
    try {
      if (!session.child.killed) {
        session.child.kill();
      }
    } catch {
      // ignore
    }
    appendLog(this.paths, "INFO", `Closed Chrome CDP session for account=${accountId}`);
    return true;
  }

  async closeAllSessions(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }
}
