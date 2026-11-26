import { StateStore } from "./storage.js";
import {
  AccountRecord,
  AccountTier,
  BridgeConfig,
  BridgeError,
  InteractionMode,
  PersistedState,
  QuotaCooldownEntry,
} from "./types.js";

export interface RouteRequest {
  explicitAccount?: string;
  mode: InteractionMode;
  model?: string;
  conversationId?: string;
  allowParallel?: boolean;
  busyAccounts?: ReadonlySet<string>;
  nowMs?: number;
}

export interface RouteDecision {
  candidates: string[];
  lockedReason?: "explicit_account" | "conversation_owner";
  skippedCooldowns: Array<{ accountId: string; until: string; reason?: string }>;
}

const PRO_ONLY_MODES = new Set<InteractionMode>(["video", "deep_research", "canvas"]);

export function inferAccountTier(
  availableModes: string[],
  models: Array<{ name: string; description?: string }>,
): AccountTier {
  const advancedModels = models.filter((m) =>
    /hydrogen|neon|carbon|pro|thinking|deeper|everyday/i.test(`${m.name} ${m.description ?? ""}`),
  );
  if (advancedModels.length > 0) {
    const hasUnlocked = advancedModels.some(
      (m) => !/需升级订阅|upgrade/i.test(m.description ?? ""),
    );
    return hasUnlocked ? "pro" : "free";
  }
  if (
    availableModes.includes("video") ||
    availableModes.includes("deep_research") ||
    availableModes.includes("canvas")
  ) {
    return "pro";
  }
  if (models.length > 0 || availableModes.length > 0) return "free";
  return "unknown";
}

export function getActiveCooldown(
  account: AccountRecord | undefined,
  mode: InteractionMode,
  nowMs = Date.now(),
): QuotaCooldownEntry | null {
  const entry = account?.quotaCooldowns?.[mode];
  if (!entry || !entry.until) return null;
  const untilMs = Date.parse(entry.until);
  if (Number.isNaN(untilMs) || untilMs <= nowMs) {
    return null;
  }
  return entry;
}

export function getActiveCooldownsMap(
  account: AccountRecord,
  nowMs = Date.now(),
): Partial<Record<InteractionMode, QuotaCooldownEntry>> {
  const result: Partial<Record<InteractionMode, QuotaCooldownEntry>> = {};
  if (!account.quotaCooldowns) return result;
  for (const [k, entry] of Object.entries(account.quotaCooldowns)) {
    if (!entry?.until) continue;
    const untilMs = Date.parse(entry.until);
    if (!Number.isNaN(untilMs) && untilMs > nowMs) {
      result[k as InteractionMode] = entry;
    }
  }
  return result;
}

function accountSupportsRequest(
  account: AccountRecord,
  mode: InteractionMode,
  model?: string,
): boolean {
  if (account.lastAuthStatus === "need_auth") {
    return false;
  }
  if (Array.isArray(account.lastAvailableModes) && account.lastAvailableModes.length > 0) {
    if (!account.lastAvailableModes.includes(mode)) {
      return false;
    }
  } else if (PRO_ONLY_MODES.has(mode) && account.tier === "free") {
    return false;
  }

  if (model && model.trim() && !/^auto$/i.test(model.trim())) {
    if (account.tier === "free") {
      return false;
    }
  }

  return true;
}

function tierRank(tier: AccountTier | undefined, preferPro: boolean): number {
  const t = tier ?? "unknown";
  if (preferPro) {
    return t === "pro" ? 0 : t === "unknown" ? 1 : 2;
  }
  return t === "free" ? 0 : t === "unknown" ? 1 : 2;
}

/**
 * Compute ordered candidate accounts honoring:
 * 1. Explicit account override (strictly no silent switch)
 * 2. Conversation owner lock (strictly same account for existing conversationId)
 * 3. Capability + model eligibility filter
 * 4. Per-(account, mode) quota cooldown filter
 * 5. Routing policy sort (pro_first vs free_first)
 */
export function resolveAccountCandidates(
  state: PersistedState,
  config: Pick<BridgeConfig, "defaultAccount" | "routingPolicy">,
  req: RouteRequest,
): RouteDecision {
  const nowMs = req.nowMs ?? Date.now();

  if (req.explicitAccount && req.explicitAccount.trim()) {
    return {
      candidates: [req.explicitAccount.trim()],
      lockedReason: "explicit_account",
      skippedCooldowns: [],
    };
  }

  if (req.conversationId && req.conversationId.trim()) {
    const convKey = req.conversationId.trim();
    const direct = state.conversations[convKey];
    const byUrl =
      direct ?? Object.values(state.conversations).find((c) => c.url === convKey);
    if (byUrl?.accountId) {
      return {
        candidates: [byUrl.accountId],
        lockedReason: "conversation_owner",
        skippedCooldowns: [],
      };
    }
  }

  const allAccounts = Object.values(state.accounts);
  if (allAccounts.length === 0) {
    return {
      candidates: [state.defaultAccount || config.defaultAccount || "default"],
      skippedCooldowns: [],
    };
  }

  const capable = allAccounts.filter((acc) =>
    accountSupportsRequest(acc, req.mode, req.model),
  );

  if (capable.length === 0) {
    // Fallback to defaultAccount if metadata wasn't populated or none matched
    const fallback = state.defaultAccount || config.defaultAccount || allAccounts[0].id;
    return {
      candidates: [fallback],
      skippedCooldowns: [],
    };
  }

  const eligible: AccountRecord[] = [];
  const skippedCooldowns: Array<{ accountId: string; until: string; reason?: string }> = [];

  for (const acc of capable) {
    const cd = getActiveCooldown(acc, req.mode, nowMs);
    if (cd) {
      skippedCooldowns.push({
        accountId: acc.id,
        until: cd.until,
        reason: cd.reason,
      });
    } else {
      eligible.push(acc);
    }
  }

  if (eligible.length === 0 && skippedCooldowns.length > 0) {
    const summary = skippedCooldowns
      .map((s) => `${s.accountId}(冷却至 ${s.until})`)
      .join(", ");
    throw new BridgeError(
      "ALL_ACCOUNTS_QUOTA_EXCEEDED",
      `所有具备 '${req.mode}' 能力的账号当前均处于限额冷却期：${summary}。请等待冷却恢复，或绑定新的备用账号（gemini_web_login_account）。`,
      { mode: req.mode, skippedCooldowns },
    );
  }

  const needsPro =
    PRO_ONLY_MODES.has(req.mode) ||
    Boolean(req.model && req.model.trim() && !/^auto$/i.test(req.model.trim()));
  const preferPro = config.routingPolicy !== "free_first" || needsPro;
  const defaultId = state.defaultAccount || config.defaultAccount;
  const busy = req.allowParallel ? req.busyAccounts : undefined;

  eligible.sort((a, b) => {
    const rDiff = tierRank(a.tier, preferPro) - tierRank(b.tier, preferPro);
    if (rDiff !== 0) return rDiff;
    // Idle-first scheduling ONLY when parallel execution is explicitly requested
    if (busy && busy.size > 0) {
      const aBusy = busy.has(a.id) ? 1 : 0;
      const bBusy = busy.has(b.id) ? 1 : 0;
      if (aBusy !== bBusy) return aBusy - bBusy;
    }
    if (a.id === defaultId && b.id !== defaultId) return -1;
    if (b.id === defaultId && a.id !== defaultId) return 1;
    return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
  });

  return {
    candidates: eligible.map((a) => a.id),
    skippedCooldowns,
  };
}

export function isTierStale(
  account: AccountRecord,
  tierRefreshHours = 24,
  nowMs = Date.now(),
): boolean {
  const ref = account.tierCheckedAt || account.lastAuthCheckedAt;
  if (!ref) return true;
  const refMs = Date.parse(ref);
  if (Number.isNaN(refMs)) return true;
  return nowMs - refMs > Math.max(1, tierRefreshHours) * 3_600_000;
}

export function parseCooldownDurationMs(
  reasonText: string | undefined,
  defaultMinutes: number,
): number {
  const text = (reasonText ?? "").toLowerCase();
  const hrMatch = text.match(/(\d+)\s*(?:hour|hr|小时)/);
  if (hrMatch) {
    const hrs = Math.min(24, Math.max(1, Number(hrMatch[1])));
    return hrs * 60 * 60 * 1000;
  }
  const minMatch = text.match(/(\d+)\s*(?:minute|min|分钟)/);
  if (minMatch) {
    const mins = Math.min(24 * 60, Math.max(5, Number(minMatch[1])));
    return mins * 60 * 1000;
  }
  return Math.max(5, defaultMinutes) * 60 * 1000;
}

export async function recordAccountQuotaCooldown(
  store: StateStore,
  config: Pick<BridgeConfig, "quotaCooldownMinutes">,
  accountId: string,
  mode: InteractionMode,
  reason?: string,
): Promise<QuotaCooldownEntry> {
  const defaultMin = config.quotaCooldownMinutes?.[mode] ?? 60;
  const durationMs = parseCooldownDurationMs(reason, defaultMin);
  const now = new Date();
  const entry: QuotaCooldownEntry = {
    recordedAt: now.toISOString(),
    until: new Date(now.getTime() + durationMs).toISOString(),
    reason,
  };

  await store.mutate((draft) => {
    const acc = draft.accounts[accountId];
    if (acc) {
      acc.quotaCooldowns = acc.quotaCooldowns ?? {};
      acc.quotaCooldowns[mode] = entry;
    }
  });

  return entry;
}

export async function clearAccountQuotaCooldown(
  store: StateStore,
  accountId: string,
  mode?: InteractionMode,
): Promise<boolean> {
  return store.mutate((draft) => {
    const acc = draft.accounts[accountId];
    if (!acc || !acc.quotaCooldowns) return false;
    if (mode) {
      const existed = Boolean(acc.quotaCooldowns[mode]);
      delete acc.quotaCooldowns[mode];
      return existed;
    }
    const hadAny = Object.keys(acc.quotaCooldowns).length > 0;
    acc.quotaCooldowns = {};
    return hadAny;
  });
}
