import crypto from "node:crypto";
import http from "node:http";
import {
  clearAccountQuotaCooldown,
  getActiveCooldownsMap,
  isTierStale,
  resolveAccountCandidates,
} from "./account-router.js";
import { ChromeManager } from "./chrome-manager.js";
import { ExecutionGuard } from "./execution-guard.js";
import { GeminiEngine } from "./gemini-engine.js";
import { findAvailablePort } from "./port-utils.js";
import {
  appendLog,
  buildPaths,
  loadConfig,
  sanitizeSegment,
  StateStore,
} from "./storage.js";
import {
  AskOptions,
  BridgeError,
  InteractionMode,
  TaskRecord,
} from "./types.js";

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new BridgeError("INVALID_INPUT", "请求体过大（超过 2MB）"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new BridgeError("INVALID_INPUT", "无效的 JSON 请求体"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof BridgeError) {
    const status =
      err.code === "INVALID_INPUT"
        ? 400
        : err.code === "NEED_AUTH" || err.code === "NEED_USER_ACTION"
          ? 401
          : err.code === "TIMEOUT"
            ? 504
            : 500;
    return { status, body: err.toJSON() };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: msg,
      },
    },
  };
}

export interface RunningDaemon {
  host: string;
  port: number;
  token: string;
  stop: () => Promise<void>;
}

export async function startDaemon(rootDir?: string): Promise<RunningDaemon> {
  const paths = buildPaths(rootDir);
  const config = loadConfig(paths);
  const store = new StateStore(paths, config.defaultAccount);
  const guard = new ExecutionGuard(config);
  const chromeManager = new ChromeManager(paths, config, store);
  const engine = new GeminiEngine(paths, config, store, chromeManager, guard);

  const host = config.daemonHost || "127.0.0.1";
  const port = await findAvailablePort(config.daemonPort, host, 50);
  const token = crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();

  const runBackgroundTask = (taskId: string, runner: () => Promise<void>): void => {
    void runner().catch(async (err) => {
      const code = err instanceof BridgeError ? err.code : "INTERNAL_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      const details = err instanceof BridgeError ? err.details : undefined;
      appendLog(paths, "ERROR", `Task ${taskId} failed [${code}]: ${message}`);
      await store.mutate((draft) => {
        const task = draft.tasks[taskId];
        if (task) {
          task.status = code === "NEED_AUTH" ? "need_auth" : "failed";
          task.error = { code, message, details };
          task.updatedAt = new Date().toISOString();
        }
      });
    });
  };

  let shuttingDown = false;
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = urlObj.pathname;
      const method = (req.method || "GET").toUpperCase();

      // Health endpoint does not require token so probes can verify app identity safely
      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          app: "gemini-web-bridge",
          pid: process.pid,
          host,
          port,
          startedAt,
          uptimeSec: Math.round(process.uptime()),
          activeSessions: chromeManager.getActiveSessionSummary(),
          guard: guard.getStatus(),
        });
        return;
      }

      // Token guard for all non-health endpoints
      const reqToken = req.headers["x-bridge-token"];
      if (reqToken !== token) {
        sendJson(res, 403, {
          ok: false,
          error: { code: "INVALID_INPUT", message: "无效或缺失 x-bridge-token" },
        });
        return;
      }

      if (method === "POST" && pathname === "/api/shutdown") {
        sendJson(res, 200, { ok: true, message: "shutting down" });
        setTimeout(() => {
          void shutdown();
        }, 50);
        return;
      }

      if (method === "GET" && pathname === "/api/accounts") {
        const snap = store.getSnapshot();
        const active = new Map(
          chromeManager.getActiveSessionSummary().map((s) => [s.accountId, s]),
        );
        const accounts = Object.values(snap.accounts).map((acc) => ({
          ...acc,
          isDefault: acc.id === snap.defaultAccount,
          sessionActive: active.get(acc.id)?.connected ?? false,
          cdpPort: active.get(acc.id)?.cdpPort,
          activeCooldowns: getActiveCooldownsMap(acc),
          tierStale: isTierStale(acc, config.tierRefreshHours),
        }));
        sendJson(res, 200, {
          ok: true,
          defaultAccount: snap.defaultAccount,
          routingPolicy: config.routingPolicy,
          guard: guard.getStatus(),
          accounts,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/guard/reset-circuit") {
        guard.clearCircuitBreaker();
        sendJson(res, 200, { ok: true, guard: guard.getStatus() });
        return;
      }

      if (method === "POST" && pathname === "/api/accounts/clear-cooldown") {
        const body = await readJsonBody(req);
        if (typeof body.account !== "string" || !body.account.trim()) {
          throw new BridgeError("INVALID_INPUT", "缺少 account 参数");
        }
        const accountId = sanitizeSegment(body.account, "account");
        const mode = typeof body.mode === "string" ? (body.mode as InteractionMode) : undefined;
        const cleared = await clearAccountQuotaCooldown(store, accountId, mode);
        sendJson(res, 200, { ok: true, accountId, mode: mode ?? "all", cleared });
        return;
      }

      if (method === "POST" && pathname === "/api/accounts/login") {
        const body = await readJsonBody(req);
        const rawAccount = typeof body.account === "string" && body.account.trim()
          ? body.account
          : store.getSnapshot().defaultAccount;
        const label = typeof body.label === "string" ? body.label : undefined;
        const info = await chromeManager.openLoginWindow(rawAccount, label);
        sendJson(res, 200, { ok: true, ...info });
        return;
      }

      if (method === "POST" && pathname === "/api/accounts/default") {
        const body = await readJsonBody(req);
        if (typeof body.account !== "string" || !body.account.trim()) {
          throw new BridgeError("INVALID_INPUT", "缺少 account 参数");
        }
        const acc = await store.ensureAccount(body.account);
        await store.mutate((draft) => {
          draft.defaultAccount = acc.id;
        });
        sendJson(res, 200, { ok: true, defaultAccount: acc.id, account: acc });
        return;
      }

      if (method === "POST" && pathname === "/api/accounts/close-session") {
        const body = await readJsonBody(req);
        if (typeof body.account === "string" && body.account.trim()) {
          const accountId = sanitizeSegment(body.account, "account");
          const closed = await chromeManager.closeSession(accountId);
          sendJson(res, 200, { ok: true, accountId, closed });
        } else {
          await chromeManager.closeAllSessions();
          sendJson(res, 200, { ok: true, closedAll: true });
        }
        return;
      }

      if (method === "POST" && pathname === "/api/capabilities") {
        const body = await readJsonBody(req);
        const account = typeof body.account === "string" ? body.account : undefined;
        const caps = await engine.inspectCapabilities(account);
        sendJson(res, 200, { ok: true, ...caps });
        return;
      }

      if (method === "POST" && pathname === "/api/ask") {
        const body = await readJsonBody(req);
        if (typeof body.prompt !== "string" || !body.prompt.trim()) {
          throw new BridgeError("INVALID_INPUT", "prompt 不能为空");
        }
        const opts: AskOptions = {
          account: typeof body.account === "string" ? body.account : undefined,
          prompt: body.prompt,
          model: typeof body.model === "string" ? body.model : undefined,
          mode: (typeof body.mode === "string" ? body.mode : "chat") as InteractionMode,
          gem: typeof body.gem === "string" ? body.gem : undefined,
          files: Array.isArray(body.files) ? body.files.map(String) : undefined,
          conversationId:
            typeof body.conversationId === "string" ? body.conversationId : undefined,
          allowParallel: body.allowParallel === true,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
        };
        const result = await engine.ask(opts);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/tasks/ask") {
        const body = await readJsonBody(req);
        if (typeof body.prompt !== "string" || !body.prompt.trim()) {
          throw new BridgeError("INVALID_INPUT", "prompt 不能为空");
        }
        const snap = store.getSnapshot();
        const explicitAccount =
          typeof body.account === "string" && body.account.trim()
            ? sanitizeSegment(body.account, "account")
            : undefined;
        const mode = (typeof body.mode === "string" ? body.mode : "chat") as InteractionMode;
        const model = typeof body.model === "string" ? body.model : undefined;
        const conversationId =
          typeof body.conversationId === "string" ? body.conversationId : undefined;
        const allowParallel = body.allowParallel === true;
        const routePreview = resolveAccountCandidates(snap, config, {
          explicitAccount,
          mode,
          model,
          conversationId,
          allowParallel,
          busyAccounts: guard.getBusyAccounts(),
        });
        const accountId = routePreview.candidates[0];
        const taskId = `task-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
        const now = new Date().toISOString();
        const taskType: TaskRecord["type"] =
          mode === "image" ? "image" : mode === "video" ? "video" : "ask";

        const record: TaskRecord = {
          id: taskId,
          type: taskType,
          accountId,
          status: "queued",
          prompt: body.prompt,
          model,
          mode,
          gem: typeof body.gem === "string" ? body.gem : undefined,
          files: Array.isArray(body.files) ? body.files.map(String) : undefined,
          conversationId,
          createdAt: now,
          updatedAt: now,
        };

        await store.mutate((draft) => {
          draft.tasks[taskId] = record;
        });

        runBackgroundTask(taskId, async () => {
          await store.mutate((draft) => {
            if (draft.tasks[taskId]) {
              draft.tasks[taskId].status = "running";
              draft.tasks[taskId].updatedAt = new Date().toISOString();
            }
          });
          const result = await engine.ask({
            account: explicitAccount,
            prompt: record.prompt,
            model: record.model,
            mode: record.mode,
            gem: record.gem,
            files: record.files,
            conversationId: record.conversationId,
            allowParallel,
            taskId,
          });
          await store.mutate((draft) => {
            const t = draft.tasks[taskId];
            if (t) {
              t.accountId = result.accountId;
              t.status = "completed";
              t.conversationId = result.conversationId;
              t.conversationUrl = result.conversationUrl;
              t.result = result;
              t.updatedAt = new Date().toISOString();
            }
          });
        });

        sendJson(res, 202, { ok: true, task: record });
        return;
      }

      if (method === "POST" && pathname === "/api/tasks/deep-research") {
        const body = await readJsonBody(req);
        if (typeof body.topic !== "string" || !body.topic.trim()) {
          throw new BridgeError("INVALID_INPUT", "topic 不能为空");
        }
        const snap = store.getSnapshot();
        const explicitAccount =
          typeof body.account === "string" && body.account.trim()
            ? sanitizeSegment(body.account, "account")
            : undefined;
        const model = typeof body.model === "string" ? body.model : undefined;
        const allowParallel = body.allowParallel === true;
        const routePreview = resolveAccountCandidates(snap, config, {
          explicitAccount,
          mode: "deep_research",
          model,
          allowParallel,
          busyAccounts: guard.getBusyAccounts(),
        });
        const accountId = routePreview.candidates[0];
        const autoStart = body.autoStart !== false;
        const taskId = `dr-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
        const now = new Date().toISOString();

        const record: TaskRecord = {
          id: taskId,
          type: "deep_research",
          accountId,
          status: "queued",
          prompt: body.topic,
          model,
          mode: "deep_research",
          createdAt: now,
          updatedAt: now,
        };

        await store.mutate((draft) => {
          draft.tasks[taskId] = record;
        });

        runBackgroundTask(taskId, async () => {
          await store.mutate((draft) => {
            if (draft.tasks[taskId]) {
              draft.tasks[taskId].status = "running";
              draft.tasks[taskId].updatedAt = new Date().toISOString();
            }
          });
          const resPlan = await engine.startDeepResearchPlan({
            account: explicitAccount,
            topic: record.prompt,
            model: record.model,
            autoStart,
            allowParallel,
            taskId,
          });
          await store.mutate((draft) => {
            const t = draft.tasks[taskId];
            if (!t) return;
            t.accountId = resPlan.accountId;
            t.conversationId = resPlan.conversationId;
            t.conversationUrl = resPlan.conversationUrl;
            t.researchPlan = resPlan.planText;
            if (resPlan.needsConfirmation) {
              t.status = "awaiting_confirmation";
            } else if (resPlan.completedResult) {
              t.status = "completed";
              t.result = resPlan.completedResult;
            }
            t.updatedAt = new Date().toISOString();
          });
        });

        sendJson(res, 202, { ok: true, task: record });
        return;
      }

      if (method === "POST" && pathname.startsWith("/api/tasks/") && pathname.endsWith("/confirm")) {
        const taskId = decodeURIComponent(
          pathname.slice("/api/tasks/".length, -"/confirm".length),
        );
        const snap = store.getSnapshot();
        const existing = snap.tasks[taskId];
        if (!existing) {
          sendJson(res, 404, { ok: false, error: { code: "INVALID_INPUT", message: `任务不存在: ${taskId}` } });
          return;
        }
        if (!existing.conversationUrl) {
          throw new BridgeError("INVALID_INPUT", `任务 ${taskId} 缺少 conversationUrl，无法确认继续`);
        }

        await store.mutate((draft) => {
          if (draft.tasks[taskId]) {
            draft.tasks[taskId].status = "running";
            draft.tasks[taskId].updatedAt = new Date().toISOString();
          }
        });

        runBackgroundTask(taskId, async () => {
          const result = await engine.confirmDeepResearch(
            existing.accountId,
            existing.conversationUrl!,
            taskId,
          );
          await store.mutate((draft) => {
            const t = draft.tasks[taskId];
            if (t) {
              t.status = "completed";
              t.result = result;
              t.updatedAt = new Date().toISOString();
            }
          });
        });

        sendJson(res, 202, { ok: true, taskId, status: "running" });
        return;
      }

      if (method === "GET" && pathname === "/api/tasks") {
        const snap = store.getSnapshot();
        const tasks = Object.values(snap.tasks)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 50);
        sendJson(res, 200, { ok: true, tasks });
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/tasks/")) {
        const taskId = decodeURIComponent(pathname.slice("/api/tasks/".length));
        const snap = store.getSnapshot();
        const task = snap.tasks[taskId];
        if (!task) {
          sendJson(res, 404, { ok: false, error: { code: "INVALID_INPUT", message: `任务不存在: ${taskId}` } });
          return;
        }
        sendJson(res, 200, { ok: true, task });
        return;
      }

      if (method === "GET" && pathname === "/api/conversations") {
        const snap = store.getSnapshot();
        const conversations = Object.values(snap.conversations)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 50);
        sendJson(res, 200, { ok: true, conversations });
        return;
      }

      sendJson(res, 404, {
        ok: false,
        error: { code: "INVALID_INPUT", message: `未知接口: ${method} ${pathname}` },
      });
    } catch (err) {
      const { status, body } = normalizeError(err);
      sendJson(res, status, body);
    }
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    appendLog(paths, "INFO", `Daemon shutting down (pid=${process.pid}, port=${port})`);
    await chromeManager.closeAllSessions();
    store.clearDaemonInfoIfOwner(process.pid);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1500);
    });
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  store.writeDaemonInfo({
    app: "gemini-web-bridge",
    pid: process.pid,
    host,
    port,
    startedAt,
    token,
  });

  appendLog(paths, "INFO", `Daemon listening on http://${host}:${port} (pid=${process.pid})`);

  return { host, port, token, stop: shutdown };
}

// Direct entrypoint when launched as background daemon process
const isDirectMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));

if (isDirectMain || process.argv.includes("--daemon-main")) {
  const running = await startDaemon();
  const handleSignal = async (): Promise<void> => {
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void handleSignal());
  process.on("SIGTERM", () => void handleSignal());
}
