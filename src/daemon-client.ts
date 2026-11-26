import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPaths, loadConfig, StateStore } from "./storage.js";
import { BridgeError, DaemonInfo } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaemonClient {
  private readonly rootDir?: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir;
  }

  private getStore(): StateStore {
    const paths = buildPaths(this.rootDir);
    const config = loadConfig(paths);
    return new StateStore(paths, config.defaultAccount);
  }

  private async probeHealth(info: DaemonInfo): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const resp = await fetch(`http://${info.host}:${info.port}/api/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return false;
      const json = (await resp.json()) as Record<string, unknown>;
      return json?.ok === true && json?.app === "gemini-web-bridge";
    } catch {
      return false;
    }
  }

  async getRunningDaemon(): Promise<DaemonInfo | null> {
    const store = this.getStore();
    const info = store.readDaemonInfo();
    if (!info) return null;
    if (await this.probeHealth(info)) {
      return info;
    }
    return null;
  }

  async ensureDaemonRunning(): Promise<DaemonInfo> {
    const existing = await this.getRunningDaemon();
    if (existing) return existing;

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const daemonScript = path.join(currentDir, "daemon.js");
    if (!fs.existsSync(daemonScript)) {
      throw new BridgeError(
        "INTERNAL_ERROR",
        `守护服务入口不存在: ${daemonScript}，请先运行 npm run build。`,
      );
    }

    // Spawn Node background daemon silently (windowsHide: true is safe for non-GUI Node daemon)
    const child = spawn(process.execPath, [daemonScript, "--daemon-main"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(250);
      const ready = await this.getRunningDaemon();
      if (ready) return ready;
    }

    throw new BridgeError(
      "TIMEOUT",
      "自动拉起 gemini-web-bridge 后台守护服务超时，请查看 logs/ 目录排查原因。",
    );
  }

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST",
    apiPath: string,
    body?: Record<string, unknown>,
    timeoutMs = 240000,
  ): Promise<T> {
    const info = await this.ensureDaemonRunning();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`http://${info.host}:${info.port}${apiPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-bridge-token": info.token,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = (await resp.json().catch(() => ({}))) as T;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<Record<string, unknown>> {
    const info = await this.ensureDaemonRunning();
    const resp = await fetch(`http://${info.host}:${info.port}/api/health`);
    return (await resp.json()) as Record<string, unknown>;
  }

  async shutdownIfRunning(): Promise<{ stopped: boolean; pid?: number; port?: number }> {
    const info = await this.getRunningDaemon();
    if (!info) return { stopped: false };
    try {
      await fetch(`http://${info.host}:${info.port}/api/shutdown`, {
        method: "POST",
        headers: { "x-bridge-token": info.token },
      });
    } catch {
      // daemon may close socket immediately
    }
    return { stopped: true, pid: info.pid, port: info.port };
  }
}
