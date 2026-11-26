export type WindowMode = "minimized" | "normal" | "headless";
export type BrowserPreference = "chrome" | "edge";
export type InteractionMode = "chat" | "deep_research" | "canvas" | "image" | "video";
export type RoutingPolicy = "pro_first" | "free_first";
export type AccountTier = "pro" | "free" | "unknown";

export type BridgeErrorCode =
  | "NEED_AUTH"
  | "NEED_USER_ACTION"
  | "QUOTA_EXCEEDED"
  | "ALL_ACCOUNTS_QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "CIRCUIT_BREAKER_OPEN"
  | "PROFILE_LOCKED_BY_LOGIN_WINDOW"
  | "BROWSER_NOT_FOUND"
  | "MODEL_NOT_FOUND"
  | "MODE_NOT_FOUND"
  | "GEM_NOT_FOUND"
  | "SELECTOR_FAILED"
  | "TIMEOUT"
  | "INVALID_INPUT"
  | "INTERNAL_ERROR";

export class BridgeError extends Error {
  public readonly code: BridgeErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export interface BridgeConfig {
  daemonHost: string;
  daemonPort: number;
  cdpPortBase: number;
  preferredBrowser: BrowserPreference;
  chromeExecutablePath: string;
  windowMode: WindowMode;
  language: string;
  proxyServer: string;
  defaultAccount: string;
  routingPolicy: RoutingPolicy;
  quotaCooldownMinutes: Record<InteractionMode, number>;
  maxGlobalConcurrency: number;
  minGlobalStaggerMs: number;
  minAccountIntervalMs: number;
  maxRequestsPerMinute: number;
  maxRequestsPerHourPerAccount: number;
  circuitBreakerMinutes: number;
  idleSessionMinutes: number;
  tierRefreshHours: number;
  navigationTimeoutMs: number;
  responseTimeoutMs: number;
  longTaskTimeoutMs: number;
  mediaWaitTimeoutMs: number;
}

export interface SelectorsConfig {
  appUrl: string;
  loginIndicators: string[];
  captchaIndicators: string[];
  quotaToastIndicators: string[];
  promptInput: string[];
  sendButton: string[];
  stopButton: string[];
  modelPickerButton: string[];
  modelMenuItems: string[];
  toolsMenuButton: string[];
  moreToolsTrigger?: string[];
  uploadMenuButton: string[];
  uploadFileOption: string[];
  fileInput: string[];
  modeChips: Record<Exclude<InteractionMode, "chat">, string[]>;
  deepResearchConfirmButton: string[];
  responseContainers: string[];
  copyResponseButton: string[];
  canvasPanel: string[];
  generatedImages: string[];
  generatedVideos: string[];
  mediaDownloadButtons: string[];
  gemLinks: string[];
}

export interface QuotaCooldownEntry {
  until: string;
  reason?: string;
  recordedAt: string;
}

export interface AccountRecord {
  id: string;
  label?: string;
  profileDir: string;
  createdAt: string;
  lastUsedAt?: string;
  lastAuthStatus?: "authenticated" | "need_auth" | "unknown";
  lastAuthCheckedAt?: string;
  lastModelList?: string[];
  lastAvailableModes?: string[];
  tier?: AccountTier;
  tierCheckedAt?: string;
  quotaCooldowns?: Partial<Record<InteractionMode, QuotaCooldownEntry>>;
}

export interface ConversationRecord {
  id: string;
  accountId: string;
  url: string;
  title?: string;
  model?: string;
  mode?: InteractionMode;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "need_auth";

export interface MediaAsset {
  kind: "image" | "video" | "file";
  localPath: string;
  mimeType?: string;
  sizeBytes: number;
  sourceUrl?: string;
}

export interface AskResult {
  accountId: string;
  conversationId: string;
  conversationUrl: string;
  modelRequested?: string;
  modelActive?: string;
  mode: InteractionMode;
  text: string;
  markdownSource: "clipboard_hook" | "dom_fallback";
  canvasText?: string;
  media: MediaAsset[];
  quotaWarning?: string;
  failoverHistory?: Array<{ fromAccount: string; toAccount: string; reason: string }>;
  durationMs: number;
}

export interface TaskRecord {
  id: string;
  type: "ask" | "deep_research" | "image" | "video";
  accountId: string;
  status: TaskStatus;
  prompt: string;
  model?: string;
  mode: InteractionMode;
  gem?: string;
  files?: string[];
  conversationId?: string;
  conversationUrl?: string;
  researchPlan?: string;
  result?: AskResult;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PersistedState {
  version: number;
  defaultAccount: string;
  accounts: Record<string, AccountRecord>;
  conversations: Record<string, ConversationRecord>;
  tasks: Record<string, TaskRecord>;
}

export interface DaemonInfo {
  app: "gemini-web-bridge";
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  token: string;
}

export interface CapabilitySnapshot {
  accountId: string;
  authenticated: boolean;
  currentModel?: string;
  models: Array<{ name: string; description?: string; disabled?: boolean }>;
  availableModes: string[];
  gems: Array<{ name: string; url: string }>;
  checkedAt: string;
}

export interface AskOptions {
  account?: string;
  prompt: string;
  model?: string;
  mode?: InteractionMode;
  gem?: string;
  files?: string[];
  conversationId?: string;
  allowParallel?: boolean;
  timeoutMs?: number;
  taskId?: string;
}
