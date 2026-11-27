import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountRecord,
  BridgeConfig,
  BridgeError,
  DaemonInfo,
  PersistedState,
  SelectorsConfig,
} from "./types.js";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export interface BridgePaths {
  rootDir: string;
  configDir: string;
  configFile: string;
  selectorsFile: string;
  dataDir: string;
  profilesDir: string;
  outputsDir: string;
  logsDir: string;
  stateFile: string;
  daemonFile: string;
}

export function resolveDefaultRootDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  // dist/src/storage.js -> rootDir is ../.. ; src/storage.ts -> rootDir is ..
  const parentName = path.basename(currentDir);
  if (parentName === "src") {
    const grandParent = path.dirname(currentDir);
    if (path.basename(grandParent) === "dist") {
      return path.dirname(grandParent);
    }
    return grandParent;
  }
  return path.dirname(currentDir);
}

export function buildPaths(rootDir: string = resolveDefaultRootDir()): BridgePaths {
  const resolvedRoot = path.resolve(rootDir);
  const configDir = path.join(resolvedRoot, "config");
  const dataDir = path.join(resolvedRoot, "data");
  return {
    rootDir: resolvedRoot,
    configDir,
    configFile: path.join(configDir, "config.json"),
    selectorsFile: path.join(configDir, "selectors.json"),
    dataDir,
    profilesDir: path.join(dataDir, "profiles"),
    outputsDir: path.join(dataDir, "outputs"),
    logsDir: path.join(resolvedRoot, "logs"),
    stateFile: path.join(dataDir, "state.json"),
    daemonFile: path.join(dataDir, "daemon.json"),
  };
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Strip UTF-8 BOM if present (Windows utf-8-sig compatibility).
 */
export function readTextUtf8Sig(filePath: string): string {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Atomic file write: write temp file -> flush -> rename/replace.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(data, null, 2) + "\n";
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Safe JSON loader that NEVER silently overwrites corrupted persistence files.
 * On corruption, preserves a timestamped .corrupted backup and throws or returns backup info.
 */
export function readJsonSafe<T>(
  filePath: string,
  fallbackFactory: () => T,
  options: { preserveOnCorrupt?: boolean } = {},
): { data: T; recoveredFromCorruption: boolean; backupPath?: string } {
  if (!fs.existsSync(filePath)) {
    return { data: fallbackFactory(), recoveredFromCorruption: false };
  }
  try {
    const text = readTextUtf8Sig(filePath);
    const parsed = JSON.parse(text) as T;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Root JSON value is not an object");
    }
    return { data: parsed, recoveredFromCorruption: false };
  } catch (err) {
    if (options.preserveOnCorrupt !== false) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${filePath}.corrupted.${stamp}`;
      try {
        fs.copyFileSync(filePath, backupPath);
      } catch {
        // Ignore secondary copy error; original file remains untouched until explicit write.
      }
      throw new BridgeError(
        "INTERNAL_ERROR",
        `持久化文件损坏，已备份至 ${backupPath}，拒绝静默覆盖原数据: ${err instanceof Error ? err.message : String(err)}`,
        { filePath, backupPath },
      );
    }
    return { data: fallbackFactory(), recoveredFromCorruption: true };
  }
}

/**
 * Sanitize user-provided account/task identifiers to prevent path traversal
 * and Windows reserved device name locks (CON, PRN, NUL, COM1, etc.).
 */
export function sanitizeSegment(raw: string, fieldName = "id"): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new BridgeError("INVALID_INPUT", `${fieldName} 不能为空`);
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new BridgeError("INVALID_INPUT", `${fieldName} 包含非法路径字符: ${raw}`);
  }
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  if (!cleaned) {
    throw new BridgeError("INVALID_INPUT", `${fieldName} 清洗后为空: ${raw}`);
  }
  const upperBase = cleaned.split(".")[0].toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(upperBase)) {
    return `_${cleaned}`;
  }
  return cleaned.slice(0, 64);
}

/**
 * Verify resolved targetPath strictly remains inside baseDir (anti zip-slip / sibling escape).
 */
export function assertInsideBaseDir(baseDir: string, targetPath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new BridgeError(
      "INVALID_INPUT",
      `目标路径越界：${resolvedTarget} 不在允许目录 ${resolvedBase} 内`,
    );
  }
  return resolvedTarget;
}

export function resolveAccountProfileDir(paths: BridgePaths, rawAccountId: string): {
  accountId: string;
  profileDir: string;
} {
  const accountId = sanitizeSegment(rawAccountId, "account");
  const profileDir = assertInsideBaseDir(paths.profilesDir, path.join(paths.profilesDir, accountId));
  return { accountId, profileDir };
}

export function resolveOutputDir(paths: BridgePaths, taskId: string): string {
  const safeTaskId = sanitizeSegment(taskId, "taskId");
  const outDir = assertInsideBaseDir(paths.outputsDir, path.join(paths.outputsDir, safeTaskId));
  ensureDir(outDir);
  return outDir;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  daemonHost: "127.0.0.1",
  daemonPort: 18790,
  cdpPortBase: 19222,
  preferredBrowser: "chrome",
  chromeExecutablePath: "",
  windowMode: "headless",
  language: "en",
  proxyServer: "",
  defaultAccount: "default",
  routingPolicy: "pro_first",
  quotaCooldownMinutes: {
    chat: 30,
    image: 60,
    canvas: 60,
    deep_research: 120,
    video: 360,
  },
  maxGlobalConcurrency: 2,
  minGlobalStaggerMs: 2500,
  minAccountIntervalMs: 5000,
  maxRequestsPerMinute: 6,
  maxRequestsPerHourPerAccount: 30,
  circuitBreakerMinutes: 10,
  idleSessionMinutes: 10,
  tierRefreshHours: 24,
  tierReconcileIntervalMinutes: 60,
  navigationTimeoutMs: 45000,
  responseTimeoutMs: 180000,
  longTaskTimeoutMs: 900000,
  mediaWaitTimeoutMs: 180000,
};

export function loadConfig(paths: BridgePaths): BridgeConfig {
  if (!fs.existsSync(paths.configFile)) {
    return { ...DEFAULT_CONFIG };
  }
  const parsed = JSON.parse(readTextUtf8Sig(paths.configFile)) as Partial<BridgeConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...(parsed && typeof parsed === "object" ? parsed : {}),
  };
}

export function loadSelectors(paths: BridgePaths): SelectorsConfig {
  if (!fs.existsSync(paths.selectorsFile)) {
    throw new BridgeError("INTERNAL_ERROR", `缺少选择器配置文件: ${paths.selectorsFile}`);
  }
  return JSON.parse(readTextUtf8Sig(paths.selectorsFile)) as SelectorsConfig;
}

export function createEmptyState(defaultAccount = "default"): PersistedState {
  return {
    version: 1,
    defaultAccount,
    accounts: {},
    conversations: {},
    tasks: {},
  };
}

export class StateStore {
  private readonly paths: BridgePaths;
  private state: PersistedState;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(paths: BridgePaths, defaultAccount = "default") {
    this.paths = paths;
    ensureDir(paths.dataDir);
    ensureDir(paths.profilesDir);
    ensureDir(paths.outputsDir);
    ensureDir(paths.logsDir);

    const { data } = readJsonSafe<PersistedState>(
      paths.stateFile,
      () => createEmptyState(defaultAccount),
      { preserveOnCorrupt: true },
    );

    this.state = {
      version: typeof data.version === "number" ? data.version : 1,
      defaultAccount:
        typeof data.defaultAccount === "string" && data.defaultAccount.trim()
          ? data.defaultAccount
          : defaultAccount,
      accounts: data.accounts && typeof data.accounts === "object" ? data.accounts : {},
      conversations:
        data.conversations && typeof data.conversations === "object" ? data.conversations : {},
      tasks: data.tasks && typeof data.tasks === "object" ? data.tasks : {},
    };
  }

  getSnapshot(): PersistedState {
    return structuredClone(this.state);
  }

  async mutate<T>(fn: (draft: PersistedState) => T): Promise<T> {
    let result!: T;
    this.writeQueue = this.writeQueue.then(() => {
      result = fn(this.state);
      writeJsonAtomic(this.paths.stateFile, this.state);
    });
    await this.writeQueue;
    return result;
  }

  async ensureAccount(rawAccountId: string, label?: string): Promise<AccountRecord> {
    const { accountId, profileDir } = resolveAccountProfileDir(this.paths, rawAccountId);
    ensureDir(profileDir);
    return this.mutate((draft) => {
      const existing = draft.accounts[accountId];
      if (existing) {
        existing.profileDir = profileDir;
        if (label !== undefined) existing.label = label;
        return existing;
      }
      const created: AccountRecord = {
        id: accountId,
        label,
        profileDir,
        createdAt: new Date().toISOString(),
        lastAuthStatus: "unknown",
      };
      draft.accounts[accountId] = created;
      return created;
    });
  }

  readDaemonInfo(): DaemonInfo | null {
    if (!fs.existsSync(this.paths.daemonFile)) return null;
    try {
      const parsed = JSON.parse(readTextUtf8Sig(this.paths.daemonFile)) as Partial<DaemonInfo>;
      if (
        parsed &&
        parsed.app === "gemini-web-bridge" &&
        typeof parsed.port === "number" &&
        typeof parsed.host === "string" &&
        typeof parsed.pid === "number" &&
        typeof parsed.token === "string"
      ) {
        return parsed as DaemonInfo;
      }
      return null;
    } catch {
      return null;
    }
  }

  writeDaemonInfo(info: DaemonInfo): void {
    writeJsonAtomic(this.paths.daemonFile, info);
  }

  clearDaemonInfoIfOwner(pid: number): void {
    const current = this.readDaemonInfo();
    if (current && current.pid === pid) {
      try {
        fs.unlinkSync(this.paths.daemonFile);
      } catch {
        // ignore if already removed
      }
    }
  }
}

export function appendLog(paths: BridgePaths, level: "INFO" | "WARN" | "ERROR", message: string): void {
  try {
    ensureDir(paths.logsDir);
    const day = new Date().toISOString().slice(0, 10);
    const logPath = path.join(paths.logsDir, `bridge-${day}.log`);
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Logging must never crash core operations
  }
}
