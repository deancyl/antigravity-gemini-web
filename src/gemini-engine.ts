import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Locator, Page } from "playwright-core";
import {
  findStaleFallbackAccounts,
  inferAccountTier,
  isTierStale,
  recordAccountQuotaCooldown,
  resolveAccountCandidates,
} from "./account-router.js";
import { ChromeManager, ManagedChromeSession } from "./chrome-manager.js";
import { ExecutionGuard } from "./execution-guard.js";
import {
  appendLog,
  BridgePaths,
  loadSelectors,
  resolveOutputDir,
  StateStore,
} from "./storage.js";
import {
  AccountRefreshSummary,
  AccountTier,
  AccountTierProbeResult,
  AskOptions,
  AskResult,
  BridgeConfig,
  BridgeError,
  CapabilitySnapshot,
  InteractionMode,
  MediaAsset,
  SelectorsConfig,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractConversationIdFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const appMatch = u.pathname.match(/\/app\/([a-zA-Z0-9_-]+)/);
    if (appMatch && appMatch[1]) return appMatch[1];
    const gemMatch = u.pathname.match(/\/gem\/[^/]+\/([a-zA-Z0-9_-]+)/);
    if (gemMatch && gemMatch[1]) return gemMatch[1];
  } catch {
    // fallback below
  }
  return `conv-${crypto.randomBytes(6).toString("hex")}`;
}

export function buildConversationUrl(
  appUrl: string,
  language: string,
  conversationId?: string,
  gemUrl?: string,
): string {
  const langSuffix = language ? `?hl=${encodeURIComponent(language)}` : "";
  if (conversationId && conversationId.trim()) {
    const trimmed = conversationId.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    return `${appUrl.replace(/\/+$/, "")}/${encodeURIComponent(trimmed)}${langSuffix}`;
  }
  if (gemUrl && /^https?:\/\//i.test(gemUrl.trim())) {
    return gemUrl.trim();
  }
  return `${appUrl.replace(/\/+$/, "")}${langSuffix}`;
}

async function findFirstVisible(
  root: Page | Locator,
  selectors: string[],
  timeoutMs = 1500,
): Promise<{ locator: Locator; selector: string } | null> {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  while (true) {
    for (const selector of selectors) {
      try {
        const loc = root.locator(selector).first();
        if (await loc.isVisible().catch(() => false)) {
          return { locator: loc, selector };
        }
      } catch {
        // ignore invalid or unmatched selector
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(150);
  }
}

async function isAnyVisible(page: Page, selectors: string[], timeoutMs = 400): Promise<boolean> {
  return (await findFirstVisible(page, selectors, timeoutMs)) !== null;
}

function guessExtensionFromMime(mime?: string, fallbackUrl?: string): string {
  const lower = (mime ?? "").toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("mp4")) return ".mp4";
  if (lower.includes("webm")) return ".webm";
  if (fallbackUrl) {
    const clean = fallbackUrl.split("?")[0].toLowerCase();
    for (const ext of [".png", ".webp", ".jpg", ".jpeg", ".mp4", ".webm"]) {
      if (clean.endsWith(ext)) return ext;
    }
  }
  return ".bin";
}

export class GeminiEngine {
  private readonly paths: BridgePaths;
  private readonly config: BridgeConfig;
  private readonly store: StateStore;
  private readonly chromeManager: ChromeManager;
  private readonly guard: ExecutionGuard;

  constructor(
    paths: BridgePaths,
    config: BridgeConfig,
    store: StateStore,
    chromeManager: ChromeManager,
    guard?: ExecutionGuard,
  ) {
    this.paths = paths;
    this.config = config;
    this.store = store;
    this.chromeManager = chromeManager;
    this.guard = guard ?? new ExecutionGuard(config);
  }

  private getSelectors(): SelectorsConfig {
    return loadSelectors(this.paths);
  }

  private async captureDiagnostics(page: Page, taskId: string, label: string): Promise<{
    screenshotPath?: string;
    url: string;
    title: string;
  }> {
    const outDir = resolveOutputDir(this.paths, taskId || `diag-${Date.now()}`);
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
    const screenshotPath = path.join(outDir, `diag-${safeLabel}-${Date.now()}.png`);
    let savedScreenshot: string | undefined;
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      savedScreenshot = screenshotPath;
    } catch {
      // ignore screenshot failure
    }
    const url = page.url();
    const title = await page.title().catch(() => "");
    return { screenshotPath: savedScreenshot, url, title };
  }

  private async checkAuthAndChallenges(
    page: Page,
    accountId: string,
    selectors: SelectorsConfig,
  ): Promise<void> {
    const url = page.url();
    if (
      url.includes("accounts.google.com") ||
      (await isAnyVisible(page, selectors.loginIndicators, 800))
    ) {
      await this.store.mutate((draft) => {
        if (draft.accounts[accountId]) {
          draft.accounts[accountId].lastAuthStatus = "need_auth";
          draft.accounts[accountId].lastAuthCheckedAt = new Date().toISOString();
        }
      });
      throw new BridgeError(
        "NEED_AUTH",
        `账号 '${accountId}' 当前未登录或登录态已过期。请调用 gemini_web_login_account(account="${accountId}") 打开独立 Chrome 窗口完成登录后，关闭该登录窗口再重试。`,
        { accountId, currentUrl: url },
      );
    }

    if (await isAnyVisible(page, selectors.captchaIndicators, 600)) {
      const untilIso = this.guard.tripCircuitBreaker(
        `账号 '${accountId}' 触发 Google 安全验证/异常流量检查`,
      );
      throw new BridgeError(
        "NEED_USER_ACTION",
        `账号 '${accountId}' 触发了 Google 安全验证/人机校验，已开启全局保护熔断（至 ${untilIso}）以防同 IP 连坐。请调用 gemini_web_login_account(account="${accountId}") 在可见 Chrome 窗口中手动完成验证后再继续。`,
        { accountId, currentUrl: url, circuitBreakerOpenUntil: untilIso },
      );
    }

    // Zero-cost passive pro <-> free tier & email check (< 5ms DOM scan)
    const passiveSignal = await page
      .evaluate(() => {
        let hasUpgradeBtn = false;
        const buttons = Array.from(document.querySelectorAll("button, a"));
        for (const el of buttons) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const txt = (el.textContent || "").trim();
          if (/^(Upgrade|升级)$/i.test(txt)) {
            hasUpgradeBtn = true;
            break;
          }
        }
        let hasMembership = false;
        let email: string | null = null;
        const accEls = Array.from(
          document.querySelectorAll("a[href*='SignOutOptions'], a[aria-label*='@'], button[aria-label*='@']"),
        );
        for (const el of accEls) {
          const aria = el.getAttribute("aria-label") || "";
          const txt = (el.textContent || "").trim();
          if (/Google membership|\bPro\b|\bUltra\b/i.test(`${aria} ${txt}`)) {
            hasMembership = true;
          }
          if (!email) {
            const m = aria.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (m) email = m[0].toLowerCase();
          }
        }
        return { hasUpgradeBtn, hasMembership, email };
      })
      .catch(() => null);

    await this.store.mutate((draft) => {
      const acc = draft.accounts[accountId];
      if (!acc) return;
      const nowIso = new Date().toISOString();
      acc.lastAuthStatus = "authenticated";
      acc.lastAuthCheckedAt = nowIso;
      acc.lastUsedAt = nowIso;
      if (passiveSignal) {
        if (passiveSignal.email && (!acc.label || !acc.label.includes("@"))) {
          acc.label = passiveSignal.email;
        }
        if (passiveSignal.hasUpgradeBtn && !passiveSignal.hasMembership) {
          if (acc.tier !== "free") {
            appendLog(this.paths, "WARN", `Dynamic tier downgrade detected: account=${accountId} pro -> free`);
          }
          acc.tier = "free";
          acc.tierCheckedAt = nowIso;
        } else if (passiveSignal.hasMembership && !passiveSignal.hasUpgradeBtn) {
          if (acc.tier !== "pro") {
            appendLog(this.paths, "INFO", `Dynamic tier upgrade detected: account=${accountId} free -> pro`);
          }
          acc.tier = "pro";
          acc.tierCheckedAt = nowIso;
        }
      }
    });
  }

  private async detectQuotaWarning(page: Page, selectors: SelectorsConfig): Promise<string | undefined> {
    for (const sel of selectors.quotaToastIndicators) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 250 }).catch(() => false)) {
          const text = (await loc.innerText().catch(() => "")).trim();
          if (
            text &&
            /limit|quota|上限|额度|降级|switched to|try again later|unavailable/i.test(text)
          ) {
            return text;
          }
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  private async ensurePageLoaded(
    session: ManagedChromeSession,
    selectors: SelectorsConfig,
    targetUrl: string,
  ): Promise<void> {
    const page = session.page;
    const currentUrl = page.url();
    const shouldNavigate =
      !currentUrl ||
      currentUrl === "about:blank" ||
      !currentUrl.startsWith(targetUrl.split("?")[0]) ||
      targetUrl.includes("/app/") ||
      targetUrl.includes("/gem/");

    if (shouldNavigate) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs,
      });
      await sleep(1200);
    }

    await this.checkAuthAndChallenges(page, session.accountId, selectors);

    const promptReady = await findFirstVisible(page, selectors.promptInput, 12000);
    if (!promptReady) {
      // Re-check auth in case SPA redirected late
      await this.checkAuthAndChallenges(page, session.accountId, selectors);
      const diag = await this.captureDiagnostics(page, `load-${Date.now()}`, "prompt_not_found");
      throw new BridgeError(
        "SELECTOR_FAILED",
        `已打开 Gemini 页面但未定位到输入框，可能页面加载缓慢或前端结构已变更。`,
        diag,
      );
    }
  }

  async inspectCapabilities(rawAccountId?: string): Promise<CapabilitySnapshot> {
    const accountId = rawAccountId || this.store.getSnapshot().defaultAccount || this.config.defaultAccount;
    const selectors = this.getSelectors();

    return this.chromeManager.withAccountLock(accountId, async (session) => {
      const targetUrl = buildConversationUrl(selectors.appUrl, this.config.language);
      await this.ensurePageLoaded(session, selectors, targetUrl);
      const page = session.page;

      let currentModel: string | undefined;
      const models: Array<{ name: string; description?: string; disabled?: boolean }> = [];

      const picker = await findFirstVisible(page, selectors.modelPickerButton, 4000);
      if (picker) {
        // Wait briefly for picker label hydration on cold start
        for (let w = 0; w < 10; w++) {
          currentModel = (await picker.locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
          if (currentModel) break;
          await sleep(250);
        }
        await picker.locator.click().catch(() => undefined);
        await sleep(600);

        for (const itemSel of selectors.modelMenuItems) {
          const items = page.locator(itemSel);
          const count = await items.count().catch(() => 0);
          if (count > 0) {
            for (let i = 0; i < count; i++) {
              const item = items.nth(i);
              if (!(await item.isVisible().catch(() => false))) continue;
              const rawText = (await item.innerText().catch(() => "")).trim();
              if (!rawText) continue;
              const lines = rawText
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean);
              const name = lines[0] ?? rawText;
              const testId = (await item.getAttribute("data-test-id").catch(() => "")) ?? "";
              const isUpsell = /upsell/i.test(testId);
              const descParts = lines.length > 1 ? [lines.slice(1).join(" - ")] : [];
              if (isUpsell) descParts.push("(需升级订阅)");
              const description = descParts.length > 0 ? descParts.join(" ") : undefined;
              const disabled =
                (await item.getAttribute("aria-disabled").catch(() => null)) === "true" ||
                (await item.isDisabled().catch(() => false));
              if (!models.some((m) => m.name === name)) {
                models.push({ name, description, disabled });
              }
            }
            if (models.length > 0) break;
          }
        }
        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(250);
      }

      // Inspect available tools / mode chips
      const availableModes = new Set<string>(["chat"]);
      for (const [modeName, chipSelectors] of Object.entries(selectors.modeChips)) {
        if (await isAnyVisible(page, chipSelectors, 350)) {
          availableModes.add(modeName);
        }
      }
      const toolsBtn = await findFirstVisible(page, selectors.toolsMenuButton, 1500);
      if (toolsBtn) {
        await toolsBtn.locator.click().catch(() => undefined);
        await sleep(550);
        for (const [modeName, chipSelectors] of Object.entries(selectors.modeChips)) {
          if (await isAnyVisible(page, chipSelectors, 350)) {
            availableModes.add(modeName);
          }
        }
        // Also expand "More tools" submenu via hover (clicking after hover toggles it closed)
        if (selectors.moreToolsTrigger && selectors.moreToolsTrigger.length > 0) {
          const moreTools = await findFirstVisible(page, selectors.moreToolsTrigger, 800);
          if (moreTools) {
            await moreTools.locator.hover().catch(() => undefined);
            await sleep(700);
            for (const [modeName, chipSelectors] of Object.entries(selectors.modeChips)) {
              if (await isAnyVisible(page, chipSelectors, 350)) {
                availableModes.add(modeName);
              }
            }
          }
        }
        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(150);
        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(150);
      }

      // Inspect visible Gems links
      const gems: Array<{ name: string; url: string }> = [];
      for (const gemSel of selectors.gemLinks) {
        const loc = page.locator(gemSel);
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 30); i++) {
          const el = loc.nth(i);
          const href = await el.getAttribute("href").catch(() => null);
          const name = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
          if (href && name) {
            const absUrl = href.startsWith("http")
              ? href
              : `https://gemini.google.com${href.startsWith("/") ? "" : "/"}${href}`;
            if (!gems.some((g) => g.url === absUrl)) {
              gems.push({ name, url: absUrl });
            }
          }
        }
      }

      // Auto-detect logged-in Google email for account label
      const detectedEmail = await page
        .evaluate(() => {
          const els = Array.from(
            document.querySelectorAll("a[href*='SignOutOptions'], a[aria-label*='@'], button[aria-label*='@']"),
          );
          for (const el of els) {
            const aria = el.getAttribute("aria-label") || "";
            const m = aria.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (m) return m[0].toLowerCase();
          }
          return null;
        })
        .catch(() => null);

      const checkedAt = new Date().toISOString();
      const modesArray = Array.from(availableModes);
      const inferredTier = inferAccountTier(modesArray, models);
      await this.store.mutate((draft) => {
        if (draft.accounts[session.accountId]) {
          if (detectedEmail && (!draft.accounts[session.accountId].label || !draft.accounts[session.accountId].label?.includes("@"))) {
            draft.accounts[session.accountId].label = detectedEmail;
          }
          if (models.length > 0) {
            draft.accounts[session.accountId].lastModelList = models.map((m) => m.name);
          }
          draft.accounts[session.accountId].lastAvailableModes = modesArray;
          draft.accounts[session.accountId].tier = inferredTier;
          draft.accounts[session.accountId].tierCheckedAt = checkedAt;
          draft.accounts[session.accountId].lastAuthStatus = "authenticated";
          draft.accounts[session.accountId].lastAuthCheckedAt = checkedAt;
        }
      });

      return {
        accountId: session.accountId,
        authenticated: true,
        currentModel,
        models,
        availableModes: modesArray,
        gems,
        checkedAt,
      };
    });
  }

  private async selectModelOnPage(
    page: Page,
    selectors: SelectorsConfig,
    requestedModel: string,
    taskId: string,
  ): Promise<string> {
    const picker = await findFirstVisible(page, selectors.modelPickerButton, 3000);
    if (!picker) {
      const diag = await this.captureDiagnostics(page, taskId, "model_picker_missing");
      throw new BridgeError("SELECTOR_FAILED", "未找到页面左上角的模型切换按钮。", diag);
    }

    const currentText = (await picker.locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const targetLower = requestedModel.trim().toLowerCase();

    await picker.locator.click();
    await sleep(500);

    const seenNames: string[] = [];
    let exactMatch: { locator: Locator; name: string } | null = null;
    let partialMatch: { locator: Locator; name: string } | null = null;

    for (const itemSel of selectors.modelMenuItems) {
      const items = page.locator(itemSel);
      const count = await items.count().catch(() => 0);
      if (count === 0) continue;

      for (let i = 0; i < count; i++) {
        const item = items.nth(i);
        if (!(await item.isVisible().catch(() => false))) continue;
        const fullText = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!fullText) continue;
        const firstLine = fullText.split(/\s{2,}/)[0] || fullText;
        seenNames.push(firstLine);

        const disabled =
          (await item.getAttribute("aria-disabled").catch(() => null)) === "true" ||
          (await item.isDisabled().catch(() => false));
        if (disabled) continue;

        const lowerFull = fullText.toLowerCase();
        const lowerFirst = firstLine.toLowerCase();
        if (lowerFirst === targetLower || lowerFull === targetLower) {
          exactMatch = { locator: item, name: firstLine };
          break;
        }
        if (!partialMatch && (lowerFirst.includes(targetLower) || lowerFull.includes(targetLower))) {
          partialMatch = { locator: item, name: firstLine };
        }
      }
      if (exactMatch || partialMatch) break;
    }

    const chosen = exactMatch ?? partialMatch;
    if (!chosen) {
      await page.keyboard.press("Escape").catch(() => undefined);
      // If current picker already matches requested model, allow proceeding
      if (currentText.toLowerCase().includes(targetLower)) {
        return currentText;
      }
      throw new BridgeError(
        "MODEL_NOT_FOUND",
        `未在当前账号可用模型列表中找到 "${requestedModel}"。当前可见模型: ${seenNames.join(" | ") || "(空)"}`,
        { requestedModel, availableModels: seenNames, currentModel: currentText },
      );
    }

    await chosen.locator.click();
    await sleep(450);
    return chosen.name;
  }

  private async dismissOnboardingModal(page: Page): Promise<boolean> {
    const modalSelectors = [
      ".cdk-overlay-pane button:has-text('Try it')",
      ".cdk-overlay-pane button:has-text('Got it')",
      ".cdk-overlay-pane button:has-text('Continue')",
      ".cdk-overlay-pane button:has-text('试试看')",
      ".cdk-overlay-pane button:has-text('立即体验')",
      ".cdk-overlay-pane button:has-text('知道了')",
      "mat-dialog-container button:has-text('Try it')",
      "mat-dialog-container button:has-text('Got it')",
    ];
    const btn = await findFirstVisible(page, modalSelectors, 1200);
    if (!btn) return false;
    await btn.locator.click().catch(() => undefined);
    await sleep(600);
    return true;
  }

  private async dismissOverlays(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const overlayCount = await page.locator(".cdk-overlay-pane").count().catch(() => 0);
      if (overlayCount === 0) return;
      await page.keyboard.press("Escape").catch(() => undefined);
      await sleep(250);
    }
  }

  private async selectModeOnPage(
    page: Page,
    selectors: SelectorsConfig,
    mode: InteractionMode,
    taskId: string,
  ): Promise<void> {
    if (mode === "chat") return;
    // In continued conversations, Gemini keeps the active mode chip mounted in the composer (e.g. "Images" / "Videos")
    if (mode === "image") {
      const alreadyActive = await findFirstVisible(
        page,
        ["button:has-text('Images')", "button[aria-label*='Remove Images' i]", "button[aria-label*='Deselect Images' i]", "button:has-text('图片')"],
        400,
      );
      if (alreadyActive) {
        await this.dismissOnboardingModal(page);
        return;
      }
    }
    if (mode === "video") {
      const alreadyActive = await findFirstVisible(
        page,
        ["button[aria-label*='Deselect Videos' i]", "button[aria-label*='Remove Videos' i]", "button[aria-label*='Deselect Video' i]"],
        400,
      );
      if (alreadyActive) {
        await this.dismissOnboardingModal(page);
        return;
      }
    }
    const chipSelectors = selectors.modeChips[mode];
    if (!chipSelectors || chipSelectors.length === 0) {
      throw new BridgeError("MODE_NOT_FOUND", `未配置模式 "${mode}" 的选择器。`);
    }

    let chip = await findFirstVisible(page, chipSelectors, 1000);
    if (!chip) {
      const toolsBtn = await findFirstVisible(page, selectors.toolsMenuButton, 2000);
      if (toolsBtn) {
        await toolsBtn.locator.click();
        await sleep(550);
        chip = await findFirstVisible(page, chipSelectors, 1500);
        if (!chip && selectors.moreToolsTrigger && selectors.moreToolsTrigger.length > 0) {
          const moreTools = await findFirstVisible(page, selectors.moreToolsTrigger, 1000);
          if (moreTools) {
            await moreTools.locator.hover().catch(() => undefined);
            await sleep(700);
            chip = await findFirstVisible(page, chipSelectors, 1500);
            if (!chip) {
              await moreTools.locator.click().catch(() => undefined);
              await sleep(600);
              chip = await findFirstVisible(page, chipSelectors, 1500);
            }
          }
        }
      }
    }

    if (!chip) {
      await page.keyboard.press("Escape").catch(() => undefined);
      const diag = await this.captureDiagnostics(page, taskId, `mode_${mode}_missing`);
      throw new BridgeError(
        "MODE_NOT_FOUND",
        `当前账号页面未找到 "${mode}" 模式入口（可能是账号权限不支持、当前对话已锁定模式或前端文案变更）。`,
        { mode, ...diag },
      );
    }

    const isDisabled =
      (await chip.locator.getAttribute("aria-disabled").catch(() => null)) === "true" ||
      (await chip.locator.isDisabled().catch(() => false));
    if (isDisabled) {
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new BridgeError(
        "QUOTA_EXCEEDED",
        `当前账号的 "${mode}" 工具按钮处于禁用/灰显状态，可能已达额度上限。`,
        { mode },
      );
    }

    await chip.locator.click();
    await sleep(650);
    // Dismiss one-time feature onboarding dialog (e.g. "Create videos With Gemini Omni -> Try it")
    await this.dismissOnboardingModal(page);
    // Ensure any lingering Upload & tools / More tools cdk-overlay-pane is closed before uploading files
    await this.dismissOverlays(page);
  }

  private async uploadFilesOnPage(
    page: Page,
    selectors: SelectorsConfig,
    files: string[],
    taskId: string,
  ): Promise<void> {
    if (!files || files.length === 0) return;

    await this.dismissOnboardingModal(page);
    await this.dismissOverlays(page);

    const resolvedFiles = files.map((f) => {
      const resolved = path.resolve(f);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new BridgeError("INVALID_INPUT", `待上传文件不存在: ${resolved}`);
      }
      return resolved;
    });

    // Try direct hidden file input first
    for (const inputSel of selectors.fileInput) {
      const input = page.locator(inputSel).first();
      if ((await input.count().catch(() => 0)) > 0) {
        await input.setInputFiles(resolvedFiles);
        await sleep(1200);
        return;
      }
    }

    // Otherwise open upload menu and intercept file chooser
    const uploadBtn = await findFirstVisible(page, selectors.uploadMenuButton, 2500);
    if (!uploadBtn) {
      const diag = await this.captureDiagnostics(page, taskId, "upload_button_missing");
      throw new BridgeError("SELECTOR_FAILED", "未找到 Gemini 文件上传按钮。", diag);
    }

    await uploadBtn.locator.click();
    await sleep(400);

    const uploadOption = await findFirstVisible(page, selectors.uploadFileOption, 2000);
    if (uploadOption) {
      const optDisabled =
        (await uploadOption.locator.getAttribute("aria-disabled").catch(() => null)) === "true" ||
        (await uploadOption.locator.isDisabled().catch(() => false));
      if (optDisabled) {
        await page.keyboard.press("Escape").catch(() => undefined);
        const bannerText = (
          await page
            .locator("text=/until|Upgrade|Learn more|limit|上限|升级/i")
            .first()
            .innerText()
            .catch(() => "")
        ).trim();
        throw new BridgeError(
          "QUOTA_EXCEEDED",
          `当前账号的上传入口已灰显禁用，可能已触达视频/媒体滚动限额${bannerText ? `（页面提示: ${bannerText.slice(0, 120)}）` : ""}。`,
          { bannerText },
        );
      }
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 8000 }),
        uploadOption.locator.click(),
      ]);
      await fileChooser.setFiles(resolvedFiles);
      await sleep(1500);
      return;
    }

    // Re-check file input after opening menu
    for (const inputSel of selectors.fileInput) {
      const input = page.locator(inputSel).first();
      if ((await input.count().catch(() => 0)) > 0) {
        await input.setInputFiles(resolvedFiles);
        await sleep(1500);
        return;
      }
    }

    const diag = await this.captureDiagnostics(page, taskId, "upload_option_missing");
    throw new BridgeError("SELECTOR_FAILED", "已打开上传菜单但未能注入本地文件。", diag);
  }

  private async inputAndSendPrompt(
    page: Page,
    selectors: SelectorsConfig,
    prompt: string,
    taskId: string,
  ): Promise<void> {
    const inputFound = await findFirstVisible(page, selectors.promptInput, 5000);
    if (!inputFound) {
      const diag = await this.captureDiagnostics(page, taskId, "input_missing");
      throw new BridgeError("SELECTOR_FAILED", "未找到 Gemini 文本输入框。", diag);
    }

    const input = inputFound.locator;
    await input.click();
    await sleep(150);

    const tagName = await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => "div");
    if (tagName === "textarea" || tagName === "input") {
      await input.fill(prompt);
    } else {
      // For Quill / contenteditable editors, insert text cleanly without pressing Enter prematurely
      await page.keyboard.press("Control+A").catch(() => undefined);
      await page.keyboard.press("Backspace").catch(() => undefined);
      await input.evaluate((el, text) => {
        el.focus();
        // Use execCommand('insertText') first so Angular/Quill change listeners fire reliably
        const ok = document.execCommand && document.execCommand("insertText", false, text);
        if (!ok) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        }
      }, prompt);
    }

    await sleep(300);

    const sendBtn = await findFirstVisible(page, selectors.sendButton, 2500);
    if (sendBtn) {
      await sendBtn.locator.click();
    } else {
      await page.keyboard.press("Enter");
    }
  }

  private async getLatestResponseLocator(
    page: Page,
    selectors: SelectorsConfig,
  ): Promise<{ locator: Locator; count: number } | null> {
    for (const sel of selectors.responseContainers) {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      if (count > 0) {
        return { locator: loc.nth(count - 1), count };
      }
    }
    return null;
  }

  private async waitForResponseComplete(
    page: Page,
    selectors: SelectorsConfig,
    previousCount: number,
    mode: InteractionMode,
    timeoutMs: number,
    accountId: string,
  ): Promise<{ latestResponse: Locator | null; quotaWarning?: string }> {
    const deadline = Date.now() + timeoutMs;
    let sawGenerating = false;
    let stableTicks = 0;
    let lastTextLen = -1;
    let quotaWarning: string | undefined;

    await sleep(1200);

    while (Date.now() < deadline) {
      // Check mid-flight auth / quota warning
      if (page.url().includes("accounts.google.com")) {
        await this.checkAuthAndChallenges(page, accountId, selectors);
      }

      const toast = await this.detectQuotaWarning(page, selectors);
      if (toast) {
        quotaWarning = toast;
      }

      const stopVisible = await isAnyVisible(page, selectors.stopButton, 300);
      if (stopVisible) {
        sawGenerating = true;
        stableTicks = 0;
        await sleep(1000);
        continue;
      }

      const latest = await this.getLatestResponseLocator(page, selectors);
      const hasNewResponse = latest !== null && latest.count > previousCount;

      if (hasNewResponse && latest) {
        const hasCopyBtn =
          (await findFirstVisible(latest.locator, selectors.copyResponseButton, 300)) !== null;
        const hasMediaAction =
          (mode === "image" || mode === "video") &&
          (await findFirstVisible(
            latest.locator,
            [
              "button[aria-label*='Download full size' i]",
              "button[aria-label*='Download' i]",
              "button[aria-label*='下载']",
            ],
            300,
          )) !== null;
        const textLen = (await latest.locator.innerText().catch(() => "")).trim().length;

        const mediaReady = await this.checkMediaReadiness(page, latest.locator, selectors, mode);

        if (
          (hasCopyBtn || hasMediaAction) &&
          mediaReady &&
          (textLen > 0 || mode === "image" || mode === "video")
        ) {
          if (textLen === lastTextLen) {
            stableTicks += 1;
          } else {
            stableTicks = 0;
            lastTextLen = textLen;
          }
          if (stableTicks >= 2 || (sawGenerating && stableTicks >= 1)) {
            return { latestResponse: latest.locator, quotaWarning };
          }
        } else if (sawGenerating && textLen > 0 && mediaReady) {
          if (textLen === lastTextLen) {
            stableTicks += 1;
          } else {
            stableTicks = 0;
            lastTextLen = textLen;
          }
          if (stableTicks >= 4) {
            return { latestResponse: latest.locator, quotaWarning };
          }
        }
      }

      await sleep(1000);
    }

    const latest = await this.getLatestResponseLocator(page, selectors);
    if (latest && latest.count > previousCount) {
      return { latestResponse: latest.locator, quotaWarning };
    }

    throw new BridgeError(
      "TIMEOUT",
      `等待 Gemini 回复超时（${Math.round(timeoutMs / 1000)}s）。如为长任务，请使用异步任务接口并轮询状态。`,
      { currentUrl: page.url(), mode, quotaWarning },
    );
  }

  private async checkMediaReadiness(
    page: Page,
    latestResponse: Locator,
    selectors: SelectorsConfig,
    mode: InteractionMode,
  ): Promise<boolean> {
    if (mode !== "image" && mode !== "video") return true;

    if (mode === "image") {
      const imgs = latestResponse.locator("img");
      const count = await imgs.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const loaded = await imgs
          .nth(i)
          .evaluate((el) => {
            const img = el as HTMLImageElement;
            return img.complete && img.naturalWidth >= 128 && img.naturalHeight >= 128;
          })
          .catch(() => false);
        if (loaded) return true;
      }
      // If Gemini replied with a text explanation/refusal instead of an image, allow copy-btn completion
      const hasCopy = (await findFirstVisible(latestResponse, selectors.copyResponseButton, 250)) !== null;
      const textLen = (await latestResponse.innerText().catch(() => "")).trim().length;
      return hasCopy && textLen > 30;
    }

    if (mode === "video") {
      const vids = latestResponse.locator("video");
      const vCount = await vids.count().catch(() => 0);
      for (let i = 0; i < vCount; i++) {
        const ready = await vids
          .nth(i)
          .evaluate((el) => {
            const v = el as HTMLVideoElement;
            const src = v.currentSrc || v.src || v.querySelector("source")?.getAttribute("src") || "";
            return src.length > 0 || v.readyState >= 1;
          })
          .catch(() => false);
        if (ready) return true;
      }
      const dlBtn = await findFirstVisible(
        latestResponse,
        ["button[aria-label*='Download' i]", "button[aria-label*='下载']", "a[download]"],
        250,
      );
      if (dlBtn) return true;

      const text = (await latestResponse.innerText().catch(() => "")).trim();
      const isRefusalOrError =
        /i'm sorry|sorry,|unusually high traffic|full capacity|try again later|can't generate|cannot generate|unable to|reached your.*limit|usage limit|daily limit|violates|policy|抱歉|无法生成|上限|繁忙|稍后再试/i.test(
          text,
        );
      const hasCopy = (await findFirstVisible(latestResponse, selectors.copyResponseButton, 250)) !== null;
      if (isRefusalOrError && (hasCopy || text.length > 25)) return true;

      const inProgress =
        /generating your video|creating your video|rendering your video|processing your video|just a moment|may take a few|takes a few|working on your video|正在生成视频|视频生成中|请稍候/i.test(
          text,
        );
      if (inProgress) return false;
      return hasCopy && text.length > 40;
    }

    return true;
  }

  private async extractMarkdownText(
    page: Page,
    latestResponse: Locator | null,
    selectors: SelectorsConfig,
  ): Promise<{ text: string; source: "clipboard_hook" | "dom_fallback" }> {
    if (latestResponse) {
      const copyFound = await findFirstVisible(latestResponse, selectors.copyResponseButton, 1500);
      if (copyFound) {
        try {
          await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            w.__GEMINI_BRIDGE_CLIPBOARD__ = null;
            w.__GEMINI_BRIDGE_INTERCEPT_ACTIVE__ = true;
          });
          await copyFound.locator.click();
          await sleep(450);
          const captured = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            const val = typeof w.__GEMINI_BRIDGE_CLIPBOARD__ === "string" ? w.__GEMINI_BRIDGE_CLIPBOARD__ : null;
            w.__GEMINI_BRIDGE_INTERCEPT_ACTIVE__ = false;
            return val;
          });
          if (captured && captured.trim()) {
            return { text: captured.trim(), source: "clipboard_hook" };
          }
        } catch {
          await page
            .evaluate(() => {
              (window as unknown as Record<string, unknown>).__GEMINI_BRIDGE_INTERCEPT_ACTIVE__ = false;
            })
            .catch(() => undefined);
        }
      }

      const fallback = (await latestResponse.innerText().catch(() => "")).trim();
      return { text: fallback, source: "dom_fallback" };
    }
    return { text: "", source: "dom_fallback" };
  }

  private async extractCanvasContent(
    page: Page,
    selectors: SelectorsConfig,
  ): Promise<string | undefined> {
    const panel = await findFirstVisible(page, selectors.canvasPanel, 1000);
    if (!panel) return undefined;
    const text = (await panel.locator.innerText().catch(() => "")).trim();
    return text || undefined;
  }

  private async downloadMediaAssets(
    page: Page,
    latestResponse: Locator | null,
    selectors: SelectorsConfig,
    taskId: string,
  ): Promise<MediaAsset[]> {
    if (!latestResponse) return [];
    const assets: MediaAsset[] = [];
    const seenUrls = new Set<string>();
    const outDir = resolveOutputDir(this.paths, taskId);

    const saveBuffer = (
      kind: "image" | "video",
      buf: Buffer,
      mimeType: string | undefined,
      sourceUrl: string,
      index: number,
    ): MediaAsset | null => {
      if (buf.length < 1024) return null; // skip tiny icons/avatars
      const ext = guessExtensionFromMime(mimeType, sourceUrl);
      const fileName = `${kind}-${String(index).padStart(2, "0")}${ext}`;
      const targetPath = path.join(outDir, fileName);
      const tmpPath = `${targetPath}.tmp`;
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, targetPath);
      return {
        kind,
        localPath: targetPath,
        mimeType,
        sizeBytes: buf.length,
        sourceUrl: sourceUrl.startsWith("data:") ? "data:<inline>" : sourceUrl,
      };
    };

    // Scroll video into view and hover first so hover-only Download buttons become visible even on later turns
    const firstVid = latestResponse.locator("video").first();
    if ((await firstVid.count().catch(() => 0)) > 0) {
      await firstVid.scrollIntoViewIfNeeded().catch(() => undefined);
      await firstVid.hover().catch(() => undefined);
      await sleep(650);
    }

    // Priority 1: Use Gemini's official Download button (captures full-size uncompressed image/video)
    const dlBtns = latestResponse.locator(
      "button[aria-label*='Download full size' i], button[aria-label*='Download' i], button[aria-label*='下载'], a[download]",
    );
    const dlCount = await dlBtns.count().catch(() => 0);
    let dlIdx = 1;
    for (let i = 0; i < dlCount; i++) {
      const btn = dlBtns.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          btn.click(),
        ]);
        const suggested = download.suggestedFilename() || `media-${String(dlIdx).padStart(2, "0")}.png`;
        const ext = path.extname(suggested).toLowerCase() || ".png";
        const kind: "image" | "video" | "file" = [".mp4", ".webm", ".mov"].includes(ext)
          ? "video"
          : [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
            ? "image"
            : "file";
        const safeName = `${kind}-${String(dlIdx++).padStart(2, "0")}${ext}`;
        const targetPath = path.join(outDir, safeName);
        await download.saveAs(targetPath);
        if (fs.existsSync(targetPath)) {
          const stat = fs.statSync(targetPath);
          if (stat.size >= 1024) {
            assets.push({
              kind,
              localPath: targetPath,
              mimeType: kind === "video" ? "video/mp4" : `image/${ext.replace(".", "")}`,
              sizeBytes: stat.size,
              sourceUrl: download.url() || "gemini-download-button",
            });
          }
        }
      } catch {
        // Fall through to canvas/fetch extraction below
      }
    }

    if (assets.length > 0) {
      return assets;
    }

    const fetchFromBrowser = async (url: string): Promise<{ buf: Buffer; mimeType?: string } | null> => {
      if (url.startsWith("blob:") || url.startsWith("data:")) {
        const res = await page
          .evaluate(async (u) => {
            const resp = await fetch(u);
            const mime = resp.headers.get("content-type") || undefined;
            const ab = await resp.arrayBuffer();
            const bytes = new Uint8Array(ab);
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            return { b64: btoa(binary), mime };
          }, url)
          .catch(() => null);
        if (!res) return null;
        return { buf: Buffer.from(res.b64, "base64"), mimeType: res.mime };
      }

      if (/^https?:\/\//i.test(url)) {
        // Prefer in-browser fetch first so downloads use Chrome's system proxy & cookies (avoids Node ETIMEDOUT)
        const inPage = await page
          .evaluate(async (u) => {
            const resp = await fetch(u, { credentials: "include" });
            if (!resp.ok) return null;
            const mime = resp.headers.get("content-type") || undefined;
            const ab = await resp.arrayBuffer();
            const bytes = new Uint8Array(ab);
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            return { b64: btoa(binary), mime };
          }, url)
          .catch(() => null);
        if (inPage && inPage.b64) {
          return { buf: Buffer.from(inPage.b64, "base64"), mimeType: inPage.mime };
        }
        const resp = await page.request.get(url, { timeout: 60000 }).catch(() => null);
        if (!resp || !resp.ok()) return null;
        const mimeType = resp.headers()["content-type"];
        const buf = await resp.body();
        return { buf, mimeType };
      }
      return null;
    };

    // Priority 2: Collect generated images via fetch or offscreen canvas fallback (CSP-safe)
    const imgLoc = latestResponse.locator("img");
    const imgCount = await imgLoc.count().catch(() => 0);
    let imgIdx = 1;
    for (let i = 0; i < imgCount; i++) {
      const img = imgLoc.nth(i);
      const info = await img
        .evaluate((el) => {
          const im = el as HTMLImageElement;
          return {
            src: im.currentSrc || im.src || "",
            width: im.naturalWidth || 0,
            height: im.naturalHeight || 0,
          };
        })
        .catch(() => null);
      if (!info || !info.src || info.width < 128 || info.height < 128) continue;
      if (seenUrls.has(info.src)) continue;
      seenUrls.add(info.src);

      let downloaded = await fetchFromBrowser(info.src);
      if (!downloaded) {
        const dataUrl = await img
          .evaluate((el) => {
            const im = el as HTMLImageElement;
            const canvas = document.createElement("canvas");
            canvas.width = im.naturalWidth;
            canvas.height = im.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(im, 0, 0);
            return canvas.toDataURL("image/png");
          })
          .catch(() => null);
        if (dataUrl && dataUrl.startsWith("data:image/png;base64,")) {
          downloaded = {
            buf: Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"),
            mimeType: "image/png",
          };
        }
      }

      if (downloaded) {
        const asset = saveBuffer("image", downloaded.buf, downloaded.mimeType, info.src, imgIdx++);
        if (asset) assets.push(asset);
      }
    }

    // Priority 3: Collect generated videos scoped inside latestResponse
    const vidLoc = latestResponse.locator("video, video source");
    const vidCount = await vidLoc.count().catch(() => 0);
    let vidIdx = 1;
    for (let i = 0; i < vidCount; i++) {
      const src = await vidLoc
        .nth(i)
        .evaluate((el) => {
          const v = el as HTMLVideoElement;
          return v.currentSrc || el.getAttribute("src") || "";
        })
        .catch(() => "");
      if (!src || seenUrls.has(src)) continue;
      seenUrls.add(src);
      const downloaded = await fetchFromBrowser(src);
      if (downloaded) {
        const asset = saveBuffer("video", downloaded.buf, downloaded.mimeType, src, vidIdx++);
        if (asset) assets.push(asset);
      }
    }

    return assets;
  }

  /**
   * Layer 1/2/3 lightweight probe: loads Gemini home only (5ms passive Upgrade/Pro check)
   * without clicking any menus. Only runs full capability inspection if the account tier
   * actually changed (e.g. free -> pro or pro -> free), and optionally closes Chrome right after
   * so background checks consume zero persistent RAM.
   */
  async probeAccountTierLightweight(
    rawAccountId: string,
    options: { closeAfter?: boolean } = {},
  ): Promise<AccountTierProbeResult> {
    this.guard.assertCircuitClosed();
    const selectors = this.getSelectors();
    const beforeSnap = this.store.getSnapshot();
    const previousTier: AccountTier = beforeSnap.accounts[rawAccountId]?.tier ?? "unknown";
    let authenticated = false;
    let currentTier: AccountTier = previousTier;
    let fullCapabilityRefreshed = false;
    let errorMsg: string | undefined;

    try {
      await this.chromeManager.withAccountLock(rawAccountId, async (session) => {
        const targetUrl = buildConversationUrl(selectors.appUrl, this.config.language);
        await this.ensurePageLoaded(session, selectors, targetUrl);
        authenticated = true;
        // Ensure tierCheckedAt is always updated on a successful lightweight home check
        const nowIso = new Date().toISOString();
        await this.store.mutate((draft) => {
          const acc = draft.accounts[session.accountId];
          if (acc) {
            acc.tierCheckedAt = nowIso;
          }
        });
      });

      const afterSnap = this.store.getSnapshot();
      currentTier = afterSnap.accounts[rawAccountId]?.tier ?? previousTier;

      if (authenticated && currentTier !== previousTier) {
        await this.inspectCapabilities(rawAccountId);
        fullCapabilityRefreshed = true;
        currentTier = this.store.getSnapshot().accounts[rawAccountId]?.tier ?? currentTier;
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof BridgeError && err.code === "NEED_USER_ACTION") {
        throw err;
      }
    } finally {
      if (options.closeAfter) {
        await this.chromeManager.closeSession(rawAccountId).catch(() => undefined);
      }
    }

    return {
      accountId: rawAccountId,
      previousTier,
      currentTier,
      changed: currentTier !== previousTier,
      authenticated,
      fullCapabilityRefreshed,
      checkedAt: new Date().toISOString(),
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  }

  /**
   * Strictly single-threaded sequential refresh for stale or all accounts.
   */
  async refreshAccounts(options: {
    scope: "stale" | "all" | "single";
    account?: string;
    closeAfter?: boolean;
    maxAccounts?: number;
    spacingMs?: number;
  }): Promise<AccountRefreshSummary> {
    this.guard.assertCircuitClosed();
    const snap = this.store.getSnapshot();
    let targets: string[] = [];

    if (options.scope === "single" && options.account) {
      targets = [options.account];
    } else {
      const refreshHours = this.config.tierRefreshHours ?? 24;
      targets = Object.values(snap.accounts)
        .filter((acc) => {
          if (acc.lastAuthStatus === "need_auth") return false;
          if (options.scope === "stale") return isTierStale(acc, refreshHours);
          return true;
        })
        .sort((a, b) =>
          (a.tierCheckedAt || a.lastAuthCheckedAt || "").localeCompare(
            b.tierCheckedAt || b.lastAuthCheckedAt || "",
          ),
        )
        .map((acc) => acc.id);
    }

    if (typeof options.maxAccounts === "number" && options.maxAccounts > 0) {
      targets = targets.slice(0, options.maxAccounts);
    }

    const results: AccountTierProbeResult[] = [];
    const spacingMs = Math.max(0, options.spacingMs ?? this.config.minGlobalStaggerMs ?? 2500);

    for (let i = 0; i < targets.length; i++) {
      this.guard.assertCircuitClosed();
      if (i > 0 && spacingMs > 0) {
        await sleep(spacingMs);
      }
      const res = await this.probeAccountTierLightweight(targets[i], {
        closeAfter: options.closeAfter ?? true,
      });
      results.push(res);
    }

    return {
      scope: options.scope,
      checkedCount: results.length,
      changedCount: results.filter((r) => r.changed).length,
      results,
    };
  }

  /**
   * Layer 2 fallback: when all known Pro accounts are exhausted/cooled, probe stale non-Pro
   * accounts sequentially to see if any was recently upgraded to Pro.
   */
  private async probeStaleAccountsForPromotion(
    mode: InteractionMode,
    excludeAccounts: ReadonlySet<string>,
  ): Promise<string | null> {
    const staleFallbacks = findStaleFallbackAccounts(this.store.getSnapshot(), this.config, {
      mode,
      excludeAccounts,
    });
    for (const acc of staleFallbacks) {
      appendLog(
        this.paths,
        "INFO",
        `Pro pool exhausted for mode=${mode}; probing stale account=${acc.id} for possible Pro upgrade`,
      );
      const probe = await this.probeAccountTierLightweight(acc.id, { closeAfter: false });
      if (probe.authenticated && probe.currentTier === "pro") {
        appendLog(
          this.paths,
          "INFO",
          `Stale account=${acc.id} promoted to Pro during exhaustion fallback!`,
        );
        return acc.id;
      }
      await this.chromeManager.closeSession(acc.id).catch(() => undefined);
    }
    return null;
  }

  async ask(options: AskOptions): Promise<AskResult> {
    this.guard.assertCircuitClosed();
    const mode: InteractionMode = options.mode ?? "chat";
    const allowParallel = Boolean(options.allowParallel) && !options.conversationId;
    const triedAccounts = new Set<string>();
    const failoverHistory: Array<{ fromAccount: string; toAccount: string; reason: string }> = [];

    let route;
    try {
      route = resolveAccountCandidates(this.store.getSnapshot(), this.config, {
        explicitAccount: options.account,
        mode,
        model: options.model,
        conversationId: options.conversationId,
        allowParallel,
        busyAccounts: this.guard.getBusyAccounts(),
      });
    } catch (err) {
      // Layer 2: Before throwing ALL_ACCOUNTS_QUOTA_EXCEEDED, probe stale cold accounts for a newly upgraded Pro
      if (
        err instanceof BridgeError &&
        err.code === "ALL_ACCOUNTS_QUOTA_EXCEEDED" &&
        !options.account &&
        !options.conversationId
      ) {
        const promotedId = await this.probeStaleAccountsForPromotion(mode, triedAccounts);
        if (promotedId) {
          failoverHistory.push({
            fromAccount: "pro_pool_cooled",
            toAccount: promotedId,
            reason: "stale_account_promoted_to_pro",
          });
          route = resolveAccountCandidates(this.store.getSnapshot(), this.config, {
            mode,
            model: options.model,
            allowParallel,
            busyAccounts: this.guard.getBusyAccounts(),
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const candidates = [...route.candidates];

    for (let idx = 0; idx < candidates.length; idx++) {
      const accountId = candidates[idx];
      triedAccounts.add(accountId);
      try {
        const res = await this.guard.acquireExecution({ allowParallel, accountId }, () =>
          this.askOnSingleAccount(accountId, options),
        );
        if (failoverHistory.length > 0) {
          res.failoverHistory = failoverHistory;
        }
        return res;
      } catch (err) {
        if (err instanceof BridgeError && err.code === "QUOTA_EXCEEDED") {
          const cd = await recordAccountQuotaCooldown(
            this.store,
            this.config,
            accountId,
            mode,
            err.message,
          );
          let nextAccount = candidates[idx + 1];
          // Layer 2: if no more known candidates left, probe stale cold accounts before giving up
          if (!nextAccount && !route.lockedReason) {
            const promotedId = await this.probeStaleAccountsForPromotion(mode, triedAccounts);
            if (promotedId) {
              candidates.push(promotedId);
              nextAccount = promotedId;
            }
          }
          if (nextAccount && !route.lockedReason) {
            failoverHistory.push({
              fromAccount: accountId,
              toAccount: nextAccount,
              reason: err.message,
            });
            appendLog(
              this.paths,
              "WARN",
              `Quota exceeded on account=${accountId} mode=${mode} (cooldown until ${cd.until}); failing over to ${nextAccount}`,
            );
            continue;
          }
          if (failoverHistory.length > 0) {
            throw new BridgeError(
              "ALL_ACCOUNTS_QUOTA_EXCEEDED",
              `所有可用账号在 '${mode}' 模式下均已触发限额（最后尝试: ${accountId}，冷却至 ${cd.until}）。`,
              { mode, failoverHistory, lastCooldownUntil: cd.until },
            );
          }
          throw new BridgeError("QUOTA_EXCEEDED", err.message, {
            ...(err.details ?? {}),
            accountId,
            mode,
            cooldownUntil: cd.until,
          });
        }
        throw err;
      }
    }

    throw new BridgeError("ALL_ACCOUNTS_QUOTA_EXCEEDED", `没有可用于 '${mode}' 模式的账号。`);
  }

  private async askOnSingleAccount(accountId: string, options: AskOptions): Promise<AskResult> {
    const startTs = Date.now();
    const mode: InteractionMode = options.mode ?? "chat";
    const taskId = options.taskId || `ask-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const selectors = this.getSelectors();

    return this.chromeManager.withAccountLock(accountId, async (session) => {
      let targetUrl = buildConversationUrl(
        selectors.appUrl,
        this.config.language,
        options.conversationId,
      );

      // Resolve Gem by URL or name if specified
      if (options.gem && !options.conversationId) {
        if (/^https?:\/\//i.test(options.gem)) {
          targetUrl = options.gem;
        } else {
          await this.ensurePageLoaded(session, selectors, targetUrl);
          const gemTargetLower = options.gem.trim().toLowerCase();
          let matchedGemUrl: string | null = null;
          for (const gemSel of selectors.gemLinks) {
            const loc = session.page.locator(gemSel);
            const count = await loc.count().catch(() => 0);
            for (let i = 0; i < count; i++) {
              const name = (await loc.nth(i).innerText().catch(() => "")).trim().toLowerCase();
              const href = await loc.nth(i).getAttribute("href").catch(() => null);
              if (href && name.includes(gemTargetLower)) {
                matchedGemUrl = href.startsWith("http")
                  ? href
                  : `https://gemini.google.com${href.startsWith("/") ? "" : "/"}${href}`;
                break;
              }
            }
            if (matchedGemUrl) break;
          }
          if (!matchedGemUrl) {
            throw new BridgeError(
              "GEM_NOT_FOUND",
              `未在侧边栏找到名为 "${options.gem}" 的 Gem，可先调用 gemini_web_list_capabilities 查看可见 Gems 或直接传入完整 /gem/... 链接。`,
              { gem: options.gem },
            );
          }
          targetUrl = matchedGemUrl;
        }
      }

      await this.ensurePageLoaded(session, selectors, targetUrl);
      const page = session.page;

      let activeModel: string | undefined;
      if (options.model && options.model.trim()) {
        activeModel = await this.selectModelOnPage(page, selectors, options.model, taskId);
      } else {
        const picker = await findFirstVisible(page, selectors.modelPickerButton, 1000);
        if (picker) {
          activeModel = (await picker.locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        }
      }

      await this.selectModeOnPage(page, selectors, mode, taskId);

      if (options.files && options.files.length > 0) {
        await this.uploadFilesOnPage(page, selectors, options.files, taskId);
      }

      const before = await this.getLatestResponseLocator(page, selectors);
      const previousCount = before?.count ?? 0;

      await this.inputAndSendPrompt(page, selectors, options.prompt, taskId);

      const effectiveTimeout =
        options.timeoutMs ??
        (mode === "video" || mode === "deep_research"
          ? this.config.longTaskTimeoutMs
          : mode === "image"
            ? this.config.mediaWaitTimeoutMs
            : this.config.responseTimeoutMs);

      const { latestResponse, quotaWarning } = await this.waitForResponseComplete(
        page,
        selectors,
        previousCount,
        mode,
        effectiveTimeout,
        session.accountId,
      );

      const { text, source } = await this.extractMarkdownText(page, latestResponse, selectors);
      const canvasText =
        mode === "canvas" ? await this.extractCanvasContent(page, selectors) : undefined;
      const media = await this.downloadMediaAssets(page, latestResponse, selectors, taskId);

      // Detect hard quota refusal (no media produced in image/video, or explicit quota refusal text)
      const looksLikeQuotaRefusal =
        /reached your.*limit|usage limit|daily limit|image generation limit|video generation limit|已达上限|额度已用完|达到.*上限/i.test(
          `${quotaWarning ?? ""} ${text}`,
        );
      if (
        looksLikeQuotaRefusal &&
        ((mode === "image" || mode === "video") ? media.length === 0 : text.length < 400)
      ) {
        throw new BridgeError(
          "QUOTA_EXCEEDED",
          `账号 '${session.accountId}' 的 '${mode}' 能力已触发限额: ${(quotaWarning || text).slice(0, 200)}`,
          { accountId: session.accountId, mode, quotaWarning, responseSnippet: text.slice(0, 200) },
        );
      }

      const finalUrl = page.url();
      const conversationId = extractConversationIdFromUrl(finalUrl);

      await this.store.mutate((draft) => {
        const now = new Date().toISOString();
        draft.conversations[conversationId] = {
          id: conversationId,
          accountId: session.accountId,
          url: finalUrl,
          title: options.prompt.slice(0, 80),
          model: activeModel,
          mode,
          createdAt: draft.conversations[conversationId]?.createdAt ?? now,
          updatedAt: now,
        };
      });

      appendLog(
        this.paths,
        "INFO",
        `ask done account=${session.accountId} mode=${mode} conv=${conversationId} chars=${text.length} media=${media.length}`,
      );

      return {
        accountId: session.accountId,
        conversationId,
        conversationUrl: finalUrl,
        modelRequested: options.model,
        modelActive: activeModel,
        mode,
        text,
        markdownSource: source,
        ...(canvasText ? { canvasText } : {}),
        media,
        ...(quotaWarning ? { quotaWarning } : {}),
        durationMs: Date.now() - startTs,
      };
    });
  }

  /**
   * Deep Research step 1: submit topic -> wait for research plan -> optionally auto-click "Start research".
   */
  async startDeepResearchPlan(options: {
    account?: string;
    topic: string;
    model?: string;
    autoStart: boolean;
    allowParallel?: boolean;
    taskId: string;
  }): Promise<{
    accountId: string;
    conversationId: string;
    conversationUrl: string;
    planText: string;
    needsConfirmation: boolean;
    completedResult?: AskResult;
  }> {
    this.guard.assertCircuitClosed();
    const allowParallel = Boolean(options.allowParallel);
    const triedAccounts = new Set<string>();
    let route;
    try {
      route = resolveAccountCandidates(this.store.getSnapshot(), this.config, {
        explicitAccount: options.account,
        mode: "deep_research",
        model: options.model,
        allowParallel,
        busyAccounts: this.guard.getBusyAccounts(),
      });
    } catch (err) {
      if (
        err instanceof BridgeError &&
        err.code === "ALL_ACCOUNTS_QUOTA_EXCEEDED" &&
        !options.account
      ) {
        const promotedId = await this.probeStaleAccountsForPromotion("deep_research", triedAccounts);
        if (promotedId) {
          route = resolveAccountCandidates(this.store.getSnapshot(), this.config, {
            mode: "deep_research",
            model: options.model,
            allowParallel,
            busyAccounts: this.guard.getBusyAccounts(),
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    const selectors = this.getSelectors();
    const candidates = [...route.candidates];

    for (let idx = 0; idx < candidates.length; idx++) {
      const accountId = candidates[idx];
      triedAccounts.add(accountId);
      try {
        return await this.guard.acquireExecution({ allowParallel, accountId }, () =>
          this.chromeManager.withAccountLock(accountId, async (session) => {
          const targetUrl = buildConversationUrl(selectors.appUrl, this.config.language);
          await this.ensurePageLoaded(session, selectors, targetUrl);
          const page = session.page;

          if (options.model) {
            await this.selectModelOnPage(page, selectors, options.model, options.taskId);
          }
          await this.selectModeOnPage(page, selectors, "deep_research", options.taskId);

      const before = await this.getLatestResponseLocator(page, selectors);
      const previousCount = before?.count ?? 0;

      await this.inputAndSendPrompt(page, selectors, options.topic, options.taskId);

      // Wait for either the Confirm / Start research button OR normal response completion
      const planDeadline = Date.now() + 90000;
      let confirmBtn: { locator: Locator; selector: string } | null = null;
      while (Date.now() < planDeadline) {
        confirmBtn = await findFirstVisible(page, selectors.deepResearchConfirmButton, 800);
        if (confirmBtn) break;
        const stopVisible = await isAnyVisible(page, selectors.stopButton, 300);
        const latest = await this.getLatestResponseLocator(page, selectors);
        if (!stopVisible && latest && latest.count > previousCount) {
          const textLen = (await latest.locator.innerText().catch(() => "")).trim().length;
          if (textLen > 60) {
            confirmBtn = await findFirstVisible(page, selectors.deepResearchConfirmButton, 1000);
            break;
          }
        }
        await sleep(1000);
      }

      const latest = await this.getLatestResponseLocator(page, selectors);
      const planText = latest ? (await latest.locator.innerText().catch(() => "")).trim() : "";
      const conversationUrl = page.url();
      const conversationId = extractConversationIdFromUrl(conversationUrl);

      if (confirmBtn && !options.autoStart) {
        return {
          accountId: session.accountId,
          conversationId,
          conversationUrl,
          planText,
          needsConfirmation: true,
        };
      }

      if (confirmBtn && options.autoStart) {
        const startTs = Date.now();
        await confirmBtn.locator.click();
        const { latestResponse, quotaWarning } = await this.waitForResponseComplete(
          page,
          selectors,
          previousCount,
          "deep_research",
          this.config.longTaskTimeoutMs,
          session.accountId,
        );
        const { text, source } = await this.extractMarkdownText(page, latestResponse, selectors);
        const canvasText = await this.extractCanvasContent(page, selectors);
        return {
          accountId: session.accountId,
          conversationId,
          conversationUrl: page.url(),
          planText,
          needsConfirmation: false,
          completedResult: {
            accountId: session.accountId,
            conversationId,
            conversationUrl: page.url(),
            modelRequested: options.model,
            mode: "deep_research",
            text: canvasText && canvasText.length > text.length ? canvasText : text,
            markdownSource: source,
            ...(canvasText ? { canvasText } : {}),
            media: [],
            ...(quotaWarning ? { quotaWarning } : {}),
            durationMs: Date.now() - startTs,
          },
        };
      }

      // If no confirm button appeared, wait for full completion directly
      const startTs = Date.now();
      const { latestResponse, quotaWarning } = await this.waitForResponseComplete(
        page,
        selectors,
        previousCount,
        "deep_research",
        this.config.longTaskTimeoutMs,
        session.accountId,
      );
      const { text, source } = await this.extractMarkdownText(page, latestResponse, selectors);
      return {
        accountId: session.accountId,
        conversationId,
        conversationUrl: page.url(),
        planText,
        needsConfirmation: false,
        completedResult: {
          accountId: session.accountId,
          conversationId,
          conversationUrl: page.url(),
          modelRequested: options.model,
          mode: "deep_research",
          text,
          markdownSource: source,
          media: [],
          ...(quotaWarning ? { quotaWarning } : {}),
          durationMs: Date.now() - startTs,
        },
      };
          }),
        );
      } catch (err) {
        if (err instanceof BridgeError && err.code === "QUOTA_EXCEEDED") {
          const cd = await recordAccountQuotaCooldown(
            this.store,
            this.config,
            accountId,
            "deep_research",
            err.message,
          );
          let nextAccount = candidates[idx + 1];
          if (!nextAccount && !route.lockedReason) {
            const promotedId = await this.probeStaleAccountsForPromotion(
              "deep_research",
              triedAccounts,
            );
            if (promotedId) {
              candidates.push(promotedId);
              nextAccount = promotedId;
            }
          }
          if (nextAccount && !route.lockedReason) {
            appendLog(
              this.paths,
              "WARN",
              `Deep Research quota exceeded on account=${accountId} (cooldown until ${cd.until}); failing over to ${nextAccount}`,
            );
            continue;
          }
          throw new BridgeError("ALL_ACCOUNTS_QUOTA_EXCEEDED", err.message, {
            ...(err.details ?? {}),
            accountId,
            mode: "deep_research",
            cooldownUntil: cd.until,
          });
        }
        throw err;
      }
    }

    throw new BridgeError("ALL_ACCOUNTS_QUOTA_EXCEEDED", "没有可用于 Deep Research 的账号。");
  }

  async confirmDeepResearch(
    accountId: string,
    conversationUrl: string,
    taskId: string,
  ): Promise<AskResult> {
    const startTs = Date.now();
    const selectors = this.getSelectors();

    return this.chromeManager.withAccountLock(accountId, async (session) => {
      await this.ensurePageLoaded(session, selectors, conversationUrl);
      const page = session.page;

      const confirmBtn = await findFirstVisible(page, selectors.deepResearchConfirmButton, 5000);
      if (confirmBtn) {
        await confirmBtn.locator.click();
      }

      const { latestResponse, quotaWarning } = await this.waitForResponseComplete(
        page,
        selectors,
        0,
        "deep_research",
        this.config.longTaskTimeoutMs,
        session.accountId,
      );
      const { text, source } = await this.extractMarkdownText(page, latestResponse, selectors);
      const canvasText = await this.extractCanvasContent(page, selectors);
      const finalUrl = page.url();
      const conversationId = extractConversationIdFromUrl(finalUrl);

      return {
        accountId: session.accountId,
        conversationId,
        conversationUrl: finalUrl,
        mode: "deep_research",
        text: canvasText && canvasText.length > text.length ? canvasText : text,
        markdownSource: source,
        ...(canvasText ? { canvasText } : {}),
        media: [],
        ...(quotaWarning ? { quotaWarning } : {}),
        durationMs: Date.now() - startTs,
      };
    });
  }
}
