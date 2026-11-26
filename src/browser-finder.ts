import fs from "node:fs";
import path from "node:path";
import { BridgeConfig, BridgeError, BrowserPreference } from "./types.js";

export interface DetectedBrowser {
  browser: BrowserPreference;
  executablePath: string;
}

export function getCandidateBrowserPaths(preferred: BrowserPreference = "chrome"): DetectedBrowser[] {
  if (process.platform === "darwin") {
    const chromeMac: DetectedBrowser[] = [
      { browser: "chrome", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    ];
    const edgeMac: DetectedBrowser[] = [
      { browser: "edge", executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ];
    return preferred === "edge" ? [...edgeMac, ...chromeMac] : [...chromeMac, ...edgeMac];
  }

  if (process.platform !== "win32") {
    const chromeLinux: DetectedBrowser[] = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].map((executablePath) => ({ browser: "chrome" as const, executablePath }));
    const edgeLinux: DetectedBrowser[] = [
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    ].map((executablePath) => ({ browser: "edge" as const, executablePath }));
    return preferred === "edge" ? [...edgeLinux, ...chromeLinux] : [...chromeLinux, ...edgeLinux];
  }

  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const chromeList: DetectedBrowser[] = [
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
  ]
    .filter(Boolean)
    .map((executablePath) => ({ browser: "chrome" as const, executablePath }));

  const edgeList: DetectedBrowser[] = [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    localAppData ? path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") : "",
  ]
    .filter(Boolean)
    .map((executablePath) => ({ browser: "edge" as const, executablePath }));

  return preferred === "edge" ? [...edgeList, ...chromeList] : [...chromeList, ...edgeList];
}

export function detectBrowserExecutable(
  config: Pick<BridgeConfig, "preferredBrowser" | "chromeExecutablePath">,
): DetectedBrowser {
  if (config.chromeExecutablePath && config.chromeExecutablePath.trim()) {
    const customPath = path.resolve(config.chromeExecutablePath.trim());
    if (fs.existsSync(customPath)) {
      const isEdge = path.basename(customPath).toLowerCase().includes("msedge");
      return {
        browser: isEdge ? "edge" : "chrome",
        executablePath: customPath,
      };
    }
    throw new BridgeError(
      "BROWSER_NOT_FOUND",
      `配置的浏览器路径不存在: ${customPath}，请检查 config/config.json 中的 chromeExecutablePath`,
      { configuredPath: customPath },
    );
  }

  const candidates = getCandidateBrowserPaths(config.preferredBrowser);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.executablePath)) {
      return candidate;
    }
  }

  throw new BridgeError(
    "BROWSER_NOT_FOUND",
    "未在常见系统安装路径探测到 Chrome 或 Edge，请在 config/config.json 中显式设置 chromeExecutablePath。",
    { checkedPaths: candidates.map((c) => c.executablePath) },
  );
}
