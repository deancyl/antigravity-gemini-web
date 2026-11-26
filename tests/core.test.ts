import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearAccountQuotaCooldown,
  inferAccountTier,
  isTierStale,
  recordAccountQuotaCooldown,
  resolveAccountCandidates,
} from "../src/account-router.js";
import { detectBrowserExecutable } from "../src/browser-finder.js";
import { startDaemon } from "../src/daemon.js";
import { ExecutionGuard } from "../src/execution-guard.js";
import { buildConversationUrl, extractConversationIdFromUrl } from "../src/gemini-engine.js";
import { findAvailablePort } from "../src/port-utils.js";
import {
  assertInsideBaseDir,
  buildPaths,
  readJsonSafe,
  readTextUtf8Sig,
  resolveAccountProfileDir,
  sanitizeSegment,
  StateStore,
  writeJsonAtomic,
} from "../src/storage.js";
import { BridgeError } from "../src/types.js";

function createTempToolRoot(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-web-bridge-test-"));
  fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "config", "config.json"),
    JSON.stringify({ daemonHost: "127.0.0.1", daemonPort: 28790, defaultAccount: "default" }),
    "utf8",
  );
  // Copy real selectors.json
  const realPaths = buildPaths();
  fs.copyFileSync(realPaths.selectorsFile, path.join(tmp, "config", "selectors.json"));
  return tmp;
}

test("storage: atomic write, UTF-8 BOM tolerance, and corruption backup without silent wipe", () => {
  const tmp = createTempToolRoot();
  try {
    const file = path.join(tmp, "data", "sample.json");
    writeJsonAtomic(file, { hello: "world", count: 42 });

    // Verify immediate reopen/rewrite on Windows (no leaked file handle)
    const content = JSON.parse(readTextUtf8Sig(file)) as { hello: string; count: number };
    assert.equal(content.hello, "world");
    assert.equal(content.count, 42);

    // UTF-8 BOM stripping
    const bomFile = path.join(tmp, "data", "bom.json");
    fs.writeFileSync(bomFile, "\uFEFF{\"bom\":true}", "utf8");
    assert.deepEqual(JSON.parse(readTextUtf8Sig(bomFile)), { bom: true });

    // Corrupt JSON must NOT silently fallback and overwrite; must create .corrupted backup and throw
    const badFile = path.join(tmp, "data", "corrupt.json");
    fs.writeFileSync(badFile, "{broken json", "utf8");
    assert.throws(
      () => readJsonSafe(badFile, () => ({ empty: true }), { preserveOnCorrupt: true }),
      (err: unknown) => err instanceof BridgeError && err.code === "INTERNAL_ERROR",
    );
    const siblings = fs.readdirSync(path.dirname(badFile));
    assert.ok(siblings.some((f) => f.startsWith("corrupt.json.corrupted.")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage: path traversal rejection and Windows reserved device name guard", () => {
  assert.throws(() => sanitizeSegment("../escape"), /非法路径字符/);
  assert.throws(() => sanitizeSegment("foo/bar"), /非法路径字符/);
  assert.throws(() => sanitizeSegment("foo\\bar"), /非法路径字符/);
  assert.equal(sanitizeSegment("CON"), "_con");
  assert.equal(sanitizeSegment("nul"), "_nul");
  assert.equal(sanitizeSegment("COM1"), "_com1");
  assert.equal(sanitizeSegment("My Work#1"), "my-work-1");

  const tmp = createTempToolRoot();
  try {
    const paths = buildPaths(tmp);
    const { accountId, profileDir } = resolveAccountProfileDir(paths, "work-pro");
    assert.equal(accountId, "work-pro");
    assert.ok(profileDir.startsWith(paths.profilesDir));
    assert.throws(() => assertInsideBaseDir(paths.profilesDir, path.join(tmp, "other")), /越界/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("browser-finder: detects installed Chrome and fails explicitly on invalid custom path", () => {
  const detected = detectBrowserExecutable({ preferredBrowser: "chrome", chromeExecutablePath: "" });
  assert.equal(detected.browser, "chrome");
  assert.ok(fs.existsSync(detected.executablePath));

  assert.throws(
    () =>
      detectBrowserExecutable({
        preferredBrowser: "chrome",
        chromeExecutablePath: "Z:\\nonexistent\\chrome.exe",
      }),
    (err: unknown) => err instanceof BridgeError && err.code === "BROWSER_NOT_FOUND",
  );
});

test("port-utils: non-destructive adaptive port fallback skips occupied port", async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const occupiedPort = (blocker.address() as net.AddressInfo).port;
  try {
    const chosen = await findAvailablePort(occupiedPort, "127.0.0.1", 20);
    assert.notEqual(chosen, occupiedPort);
    assert.ok(chosen > occupiedPort);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("gemini-engine helpers: conversation URL parsing & building", () => {
  assert.equal(
    extractConversationIdFromUrl("https://gemini.google.com/app/abc123XYZ?hl=en"),
    "abc123XYZ",
  );
  assert.equal(
    extractConversationIdFromUrl("https://gemini.google.com/gem/mygem/conv999"),
    "conv999",
  );
  assert.equal(
    buildConversationUrl("https://gemini.google.com/app", "en", "abc123"),
    "https://gemini.google.com/app/abc123?hl=en",
  );
  assert.equal(
    buildConversationUrl("https://gemini.google.com/app", "en", "https://gemini.google.com/app/custom"),
    "https://gemini.google.com/app/custom",
  );
});

test("daemon: startup, health signature, token guard, account persistence, and graceful stop", async () => {
  const tmp = createTempToolRoot();
  const running = await startDaemon(tmp);
  try {
    const healthResp = await fetch(`http://${running.host}:${running.port}/api/health`);
    assert.equal(healthResp.status, 200);
    const health = (await healthResp.json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.app, "gemini-web-bridge");
    assert.equal(health.port, running.port);

    // Token guard must reject unauthorized requests
    const unauth = await fetch(`http://${running.host}:${running.port}/api/accounts`);
    assert.equal(unauth.status, 403);

    // Authorized default account switch persists to state.json
    const swResp = await fetch(`http://${running.host}:${running.port}/api/accounts/default`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": running.token,
      },
      body: JSON.stringify({ account: "work" }),
    });
    assert.equal(swResp.status, 200);
    const swJson = (await swResp.json()) as { ok: boolean; defaultAccount: string };
    assert.equal(swJson.ok, true);
    assert.equal(swJson.defaultAccount, "work");

    const store = new StateStore(buildPaths(tmp));
    assert.equal(store.getSnapshot().defaultAccount, "work");
    assert.ok(store.getSnapshot().accounts.work);
  } finally {
    await running.stop();
    // daemon.json must be cleaned up on graceful shutdown
    assert.equal(fs.existsSync(path.join(tmp, "data", "daemon.json")), false);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mcp-server: stdio initialize + tools/list exposes all gemini_web_* tools", async () => {
  const mcpEntry = path.resolve(buildPaths().rootDir, "dist", "src", "mcp-server.js");
  assert.ok(fs.existsSync(mcpEntry), `Missing built MCP entry: ${mcpEntry}`);

  const child = spawn(process.execPath, [mcpEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // ignore partial
      }
    }
  });

  const sendRpc = (msg: Record<string, unknown>): void => {
    child.stdin.write(JSON.stringify(msg) + "\n");
  };

  try {
    sendRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "unit-test", version: "1.0.0" },
      },
    });
    sendRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    sendRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !messages.some((m) => m.id === 2)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const listResp = messages.find((m) => m.id === 2) as
      | { result?: { tools?: Array<{ name: string }> } }
      | undefined;
    assert.ok(listResp?.result?.tools, "MCP tools/list response not received");
    const names = listResp.result.tools.map((t) => t.name);
    for (const expected of [
      "gemini_web_list_accounts",
      "gemini_web_login_account",
      "gemini_web_switch_account",
      "gemini_web_list_capabilities",
      "gemini_web_ask",
      "gemini_web_start_task",
      "gemini_web_start_deep_research",
      "gemini_web_confirm_deep_research",
      "gemini_web_get_task_status",
      "gemini_web_list_conversations",
    ]) {
      assert.ok(names.includes(expected), `Missing MCP tool: ${expected}`);
    }
  } finally {
    child.kill();
  }
});

test("account-router: pro_first policy, capability filtering, conversation lock, and quota cooldown failover", async () => {
  const tmp = createTempToolRoot();
  try {
    const store = new StateStore(buildPaths(tmp), "pro_primary");
    await store.ensureAccount("free_backup", "free_backup@example.com");
    await store.ensureAccount("pro_primary", "pro_primary@example.com");
    await store.mutate((draft) => {
      draft.defaultAccount = "pro_primary";
      draft.accounts.free_backup.tier = inferAccountTier(["chat", "image"], [
        { name: "Auto", description: "Adapts to your needs" },
        { name: "Deeper analysis", description: "4 Neon (需升级订阅)" },
      ]);
      draft.accounts.free_backup.lastAvailableModes = ["chat", "image"];
      draft.accounts.free_backup.lastAuthStatus = "authenticated";

      draft.accounts.pro_primary.tier = inferAccountTier(
        ["chat", "image", "video", "deep_research", "canvas"],
        [{ name: "Deeper analysis", description: "4 Neon" }],
      );
      draft.accounts.pro_primary.lastAvailableModes = ["chat", "image", "video", "deep_research", "canvas"];
      draft.accounts.pro_primary.lastAuthStatus = "authenticated";

      draft.conversations["conv-free-1"] = {
        id: "conv-free-1",
        accountId: "free_backup",
        url: "https://gemini.google.com/app/conv-free-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    const cfg = {
      defaultAccount: "pro_primary",
      routingPolicy: "pro_first" as const,
      quotaCooldownMinutes: { chat: 30, image: 60, canvas: 60, deep_research: 120, video: 360 },
    };

    // 1. pro_first orders pro before free for image, and only pro for video
    const imgRoute = resolveAccountCandidates(store.getSnapshot(), cfg, { mode: "image" });
    assert.deepEqual(imgRoute.candidates, ["pro_primary", "free_backup"]);

    const vidRoute = resolveAccountCandidates(store.getSnapshot(), cfg, { mode: "video" });
    assert.deepEqual(vidRoute.candidates, ["pro_primary"]);

    // 2. conversationId strictly locks to owning account
    const convRoute = resolveAccountCandidates(store.getSnapshot(), cfg, {
      mode: "image",
      conversationId: "conv-free-1",
    });
    assert.deepEqual(convRoute.candidates, ["free_backup"]);
    assert.equal(convRoute.lockedReason, "conversation_owner");

    // 3. When pro hits image quota cooldown, image automatically falls back to free account,
    //    while pro's video capability remains unaffected!
    await recordAccountQuotaCooldown(store, cfg, "pro_primary", "image", "You reached your image limit");
    const afterProImgCd = resolveAccountCandidates(store.getSnapshot(), cfg, { mode: "image" });
    assert.deepEqual(afterProImgCd.candidates, ["free_backup"]);
    assert.equal(afterProImgCd.skippedCooldowns.length, 1);

    const proVidStillReady = resolveAccountCandidates(store.getSnapshot(), cfg, { mode: "video" });
    assert.deepEqual(proVidStillReady.candidates, ["pro_primary"]);

    // 4. When BOTH accounts hit image cooldown, throws ALL_ACCOUNTS_QUOTA_EXCEEDED
    await recordAccountQuotaCooldown(store, cfg, "free_backup", "image", "Limit reached");
    assert.throws(
      () => resolveAccountCandidates(store.getSnapshot(), cfg, { mode: "image" }),
      (err: unknown) => err instanceof BridgeError && err.code === "ALL_ACCOUNTS_QUOTA_EXCEEDED",
    );

    // 5. Clearing cooldown restores eligibility
    await clearAccountQuotaCooldown(store, "pro_primary", "image");
    const restored = resolveAccountCandidates(store.getSnapshot(), cfg, { mode: "image" });
    assert.deepEqual(restored.candidates, ["pro_primary"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("execution-guard & idle-first routing: single-thread default, opt-in parallel cap, rate limit, circuit breaker, and tier staleness", async () => {
  const guard = new ExecutionGuard({
    maxGlobalConcurrency: 2,
    minGlobalStaggerMs: 0,
    minAccountIntervalMs: 0,
    maxRequestsPerMinute: 4,
    maxRequestsPerHourPerAccount: 10,
    circuitBreakerMinutes: 10,
  });

  // 1. Default allowParallel=false enforces strict single-threaded execution (max concurrency = 1)
  let peakSingle = 0;
  let activeSingle = 0;
  await Promise.all([
    guard.acquireExecution({ allowParallel: false, accountId: "pro_primary" }, async () => {
      activeSingle++;
      peakSingle = Math.max(peakSingle, activeSingle);
      await new Promise((r) => setTimeout(r, 40));
      activeSingle--;
    }),
    guard.acquireExecution({ allowParallel: false, accountId: "pro_backup" }, async () => {
      activeSingle++;
      peakSingle = Math.max(peakSingle, activeSingle);
      await new Promise((r) => setTimeout(r, 40));
      activeSingle--;
    }),
  ]);
  assert.equal(peakSingle, 1);

  // 2. Opt-in allowParallel=true allows up to maxGlobalConcurrency=2
  let peakParallel = 0;
  let activeParallel = 0;
  await Promise.all([
    guard.acquireExecution({ allowParallel: true, accountId: "pro_primary" }, async () => {
      activeParallel++;
      peakParallel = Math.max(peakParallel, activeParallel);
      await new Promise((r) => setTimeout(r, 50));
      activeParallel--;
    }),
    guard.acquireExecution({ allowParallel: true, accountId: "pro_backup" }, async () => {
      activeParallel++;
      peakParallel = Math.max(peakParallel, activeParallel);
      await new Promise((r) => setTimeout(r, 50));
      activeParallel--;
    }),
  ]);
  assert.equal(peakParallel, 2);

  // 3. 5th request within 1 minute hits global RATE_LIMITED (maxRequestsPerMinute=4)
  await assert.rejects(
    () => guard.acquireExecution({ allowParallel: false, accountId: "pro_primary" }, async () => "ok"),
    (err: unknown) => err instanceof BridgeError && err.code === "RATE_LIMITED",
  );

  // 4. Tripping circuit breaker blocks all new executions until cleared
  guard.tripCircuitBreaker("test captcha");
  assert.throws(
    () => guard.assertCircuitClosed(),
    (err: unknown) => err instanceof BridgeError && err.code === "CIRCUIT_BREAKER_OPEN",
  );
  guard.clearCircuitBreaker();
  guard.assertCircuitClosed();

  // 5. Idle-first routing prefers idle Pro account ONLY when allowParallel=true
  const now = new Date().toISOString();
  const mockState = {
    version: 1,
    defaultAccount: "pro_primary",
    accounts: {
      pro_primary: {
        id: "pro_primary",
        profileDir: "p1",
        createdAt: now,
        tier: "pro" as const,
        tierCheckedAt: now,
        lastAuthStatus: "authenticated" as const,
        lastAvailableModes: ["chat", "image", "video"],
      },
      pro_backup: {
        id: "pro_backup",
        profileDir: "p2",
        createdAt: now,
        tier: "pro" as const,
        tierCheckedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        lastAuthStatus: "authenticated" as const,
        lastAvailableModes: ["chat", "image", "video"],
      },
    },
    conversations: {},
    tasks: {},
  };
  const cfg = { defaultAccount: "pro_primary", routingPolicy: "pro_first" as const };
  const busySet = new Set(["pro_primary"]);

  const serialRoute = resolveAccountCandidates(mockState, cfg, {
    mode: "image",
    allowParallel: false,
    busyAccounts: busySet,
  });
  assert.equal(serialRoute.candidates[0], "pro_primary");

  const parallelRoute = resolveAccountCandidates(mockState, cfg, {
    mode: "image",
    allowParallel: true,
    busyAccounts: busySet,
  });
  assert.equal(parallelRoute.candidates[0], "pro_backup");

  // 6. Tier staleness check (24h TTL)
  assert.equal(isTierStale(mockState.accounts.pro_primary, 24), false);
  assert.equal(isTierStale(mockState.accounts.pro_backup, 24), true);
});
