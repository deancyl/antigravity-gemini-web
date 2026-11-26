import { BridgeConfig, BridgeError } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ExecutionGuardStatus {
  activeCount: number;
  queuedCount: number;
  busyAccounts: string[];
  maxGlobalConcurrency: number;
  circuitBreakerOpenUntil: string | null;
  circuitBreakerReason: string | null;
  requestsLastMinute: number;
}

interface Waiter {
  allowParallel: boolean;
  resolve: () => void;
}

/**
 * Anti-abuse concurrency & pacing governor:
 * - Single-threaded by default (allowParallel=false waits for activeCount === 0)
 * - Controlled parallel (allowParallel=true) capped at maxGlobalConcurrency
 * - Global stagger + per-account minimum interval
 * - Global per-minute & per-account hourly sliding-window rate limits
 * - Global circuit breaker when any account hits anti-bot/security challenges
 */
export class ExecutionGuard {
  private readonly config: Pick<
    BridgeConfig,
    | "maxGlobalConcurrency"
    | "minGlobalStaggerMs"
    | "minAccountIntervalMs"
    | "maxRequestsPerMinute"
    | "maxRequestsPerHourPerAccount"
    | "circuitBreakerMinutes"
  >;

  private activeCount = 0;
  private activeSerial = false;
  private readonly waiters: Waiter[] = [];
  private readonly busyAccounts = new Set<string>();

  private lastGlobalStartMs = 0;
  private readonly lastAccountStartMs = new Map<string, number>();
  private readonly globalMinuteWindow: number[] = [];
  private readonly accountHourWindows = new Map<string, number[]>();

  private circuitOpenUntilMs = 0;
  private circuitReason: string | null = null;

  constructor(
    config: Pick<
      BridgeConfig,
      | "maxGlobalConcurrency"
      | "minGlobalStaggerMs"
      | "minAccountIntervalMs"
      | "maxRequestsPerMinute"
      | "maxRequestsPerHourPerAccount"
      | "circuitBreakerMinutes"
    >,
  ) {
    this.config = config;
  }

  getBusyAccounts(): ReadonlySet<string> {
    return new Set(this.busyAccounts);
  }

  getStatus(nowMs = Date.now()): ExecutionGuardStatus {
    this.pruneWindows(nowMs);
    const open = this.circuitOpenUntilMs > nowMs;
    return {
      activeCount: this.activeCount,
      queuedCount: this.waiters.length,
      busyAccounts: Array.from(this.busyAccounts),
      maxGlobalConcurrency: Math.max(1, this.config.maxGlobalConcurrency || 2),
      circuitBreakerOpenUntil: open ? new Date(this.circuitOpenUntilMs).toISOString() : null,
      circuitBreakerReason: open ? this.circuitReason : null,
      requestsLastMinute: this.globalMinuteWindow.length,
    };
  }

  tripCircuitBreaker(reason: string, nowMs = Date.now()): string {
    const mins = Math.max(1, this.config.circuitBreakerMinutes || 10);
    this.circuitOpenUntilMs = nowMs + mins * 60 * 1000;
    this.circuitReason = reason;
    return new Date(this.circuitOpenUntilMs).toISOString();
  }

  clearCircuitBreaker(): void {
    this.circuitOpenUntilMs = 0;
    this.circuitReason = null;
  }

  assertCircuitClosed(nowMs = Date.now()): void {
    if (this.circuitOpenUntilMs > nowMs) {
      const untilIso = new Date(this.circuitOpenUntilMs).toISOString();
      throw new BridgeError(
        "CIRCUIT_BREAKER_OPEN",
        `因近期有账号触发安全验证/异常流量风控，全局保护熔断已开启（至 ${untilIso}），暂停自动调度以防同 IP 连坐。原因：${this.circuitReason ?? "未知"}`,
        { until: untilIso, reason: this.circuitReason },
      );
    }
  }

  private pruneWindows(nowMs: number): void {
    const oneMinAgo = nowMs - 60_000;
    while (this.globalMinuteWindow.length > 0 && this.globalMinuteWindow[0] <= oneMinAgo) {
      this.globalMinuteWindow.shift();
    }
    const oneHourAgo = nowMs - 3_600_000;
    for (const [acc, arr] of this.accountHourWindows.entries()) {
      while (arr.length > 0 && arr[0] <= oneHourAgo) {
        arr.shift();
      }
      if (arr.length === 0) {
        this.accountHourWindows.delete(acc);
      }
    }
  }

  checkAndRecordRateLimit(accountId: string, nowMs = Date.now()): void {
    this.pruneWindows(nowMs);
    const maxPerMin = Math.max(1, this.config.maxRequestsPerMinute || 6);
    if (this.globalMinuteWindow.length >= maxPerMin) {
      throw new BridgeError(
        "RATE_LIMITED",
        `已达全局每分钟请求上限（${maxPerMin} 次/分钟），为防止滥用与风控已拦截本次请求，请稍后再试。`,
        { maxRequestsPerMinute: maxPerMin, currentCount: this.globalMinuteWindow.length },
      );
    }

    const maxPerHour = Math.max(1, this.config.maxRequestsPerHourPerAccount || 30);
    const accArr = this.accountHourWindows.get(accountId) ?? [];
    if (accArr.length >= maxPerHour) {
      throw new BridgeError(
        "RATE_LIMITED",
        `账号 '${accountId}' 已达每小时请求上限（${maxPerHour} 次/小时），请稍后再试或切换其他账号。`,
        { accountId, maxRequestsPerHourPerAccount: maxPerHour, currentCount: accArr.length },
      );
    }

    this.globalMinuteWindow.push(nowMs);
    accArr.push(nowMs);
    this.accountHourWindows.set(accountId, accArr);
  }

  private canAcquire(allowParallel: boolean): boolean {
    const cap = Math.max(1, this.config.maxGlobalConcurrency || 2);
    if (!allowParallel) {
      return this.activeCount === 0;
    }
    return !this.activeSerial && this.activeCount < cap;
  }

  private async acquireSlot(allowParallel: boolean): Promise<void> {
    if (this.canAcquire(allowParallel)) {
      this.activeCount += 1;
      if (!allowParallel) this.activeSerial = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ allowParallel, resolve });
    });
    this.activeCount += 1;
    if (!allowParallel) this.activeSerial = true;
  }

  private releaseSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.activeCount === 0) {
      this.activeSerial = false;
    }
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (this.canAcquire(w.allowParallel)) {
        this.waiters.splice(i, 1);
        w.resolve();
        return;
      }
    }
  }

  async acquireExecution<T>(
    options: { allowParallel: boolean; accountId: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    this.assertCircuitClosed();
    await this.acquireSlot(options.allowParallel);
    try {
      this.assertCircuitClosed();
      this.checkAndRecordRateLimit(options.accountId);

      // Apply anti-burst pacing (global stagger + per-account minimum interval)
      const now = Date.now();
      const globalWait = Math.max(0, this.lastGlobalStartMs + (this.config.minGlobalStaggerMs || 0) - now);
      const accLast = this.lastAccountStartMs.get(options.accountId) ?? 0;
      const accWait = Math.max(0, accLast + (this.config.minAccountIntervalMs || 0) - now);
      const waitMs = Math.max(globalWait, accWait);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const startMark = Date.now();
      this.lastGlobalStartMs = startMark;
      this.lastAccountStartMs.set(options.accountId, startMark);
      this.busyAccounts.add(options.accountId);

      return await fn();
    } finally {
      this.busyAccounts.delete(options.accountId);
      this.releaseSlot();
    }
  }
}
