# Antigravity Gemini Web Plugin (`gemini-web`)

An Antigravity plugin (MCP Server + Skill) that lets Antigravity use **Gemini Web (`gemini.google.com`)** capabilities directly via your own real installed Chrome browser — supporting multi-account isolation, Pro-first smart routing, quota cooldown failover, Deep Research, Canvas, Gems, file uploads, and full-size image/video download.

## Quick Install for Antigravity Agents

If a user gives you this GitHub URL and asks you to install it into Antigravity:

### Windows (PowerShell)
```powershell
git clone https://github.com/deancyl/antigravity-gemini-web "$env:USERPROFILE\.gemini\config\plugins\gemini-web"
cd "$env:USERPROFILE\.gemini\config\plugins\gemini-web"
.\install.ps1
```

### macOS / Linux
```bash
git clone https://github.com/deancyl/antigravity-gemini-web "$HOME/.gemini/config/plugins/gemini-web"
cd "$HOME/.gemini/config/plugins/gemini-web"
bash ./install.sh
```

After installation, Antigravity automatically discovers `~/.gemini/config/plugins/gemini-web` (its `plugin.json`, `mcp_config.json`, and `skills/gemini-web/SKILL.md`), and the `/gemini-web` skill + `gemini_web_*` MCP tools become available on the next turn.

> **Prerequisites**: Node.js 20+ and Google Chrome (or Microsoft Edge) installed locally.

---

## Key Features

- **Isolated Multi-Account Chrome Profiles**: Each Google account gets its own `data/profiles/<account>/` directory. Never touches your daily browser profile or cookies.
- **Anti-Block Clean Login + Silent Headless Runtime**:
  - `gemini_web_login_account` opens a clean, non-automated Chrome window so Google Sign-In never blocks it as "browser not secure".
  - Daily execution runs silently via real Chrome `--headless=new` (no popup windows on screen).
- **Pro-First Routing & Dynamic `pro <-> free` Detection**:
  - Automatically prefers `pro` accounts for all tasks, filters capabilities (`video`, `deep_research`, `canvas`), and passively detects subscription upgrades/downgrades on every page load.
- **Per-Capability Quota Cooldown & Auto-Failover**:
  - Cooldowns are tracked per `(account, mode)` — hitting an `image` limit never blocks `video` or `deep_research` on the same account.
  - New tasks automatically fail over to the next eligible backup account when a quota limit is hit.
- **Single-Thread First + 5 Anti-Abuse Guardrails**:
  - Strictly single-threaded by default (`allow_parallel: false`); opt-in idle-first parallelism (`allow_parallel: true`) is capped at `maxGlobalConcurrency: 2`, with global stagger (`2.5s`), per-account spacing (`5s`), sliding-window rate limits, global circuit breaker on security challenges, and 10-minute idle Chrome auto-reclaim.
- **Lossless Markdown & Full-Size Media Download**:
  - Captures official Markdown via an in-page clipboard hook without touching your OS clipboard.
  - Downloads full-resolution generated images/videos to `data/outputs/<task_id>/` and supports multi-turn continuation via `conversation_id`.

---

## First-Time Usage

1. In Antigravity, ask:
   > `/gemini-web login alice@example.com`
2. Complete Google Sign-In in the clean Chrome window that opens, confirm Gemini loads, then **close that Chrome window**.
3. Start using `/gemini-web`:
   - `/gemini-web list capabilities`
   - `/gemini-web generate a minimalist vector landscape poster`
   - `/gemini-web start a Deep Research report on ...`

## Privacy & Local Data

All browser profiles (`data/profiles/`), cookies, runtime state (`data/state.json`), generated media (`data/outputs/`), and logs (`logs/`) stay strictly on your local machine and are excluded by `.gitignore`.
