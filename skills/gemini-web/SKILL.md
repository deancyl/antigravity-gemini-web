---
name: gemini-web
description: >-
  Use Gemini Web (gemini.google.com) via the gemini-web-bridge MCP server.
  Activate whenever the user wants to use their Gemini web subscription or web-only
  features: switching Google accounts, selecting Gemini web models, running Deep Research,
  using Canvas or Gems, uploading files for web analysis, generating images/videos via
  Gemini web, or continuing an existing Gemini web conversation.
---

# Gemini Web Bridge

This skill drives the local `gemini-web-bridge` MCP server, which manages isolated
Chrome profiles per Google account (silent headless by default) and a persistent
local daemon so long-running web tasks (Deep Research, video generation) survive reconnects.

## Standard Workflow

### 1. Check Accounts & Authentication First
- Call `gemini_web_list_accounts` when unsure which account to use or whether any
  account has been initialized.
- **Default Account Naming Convention**: When binding a new Google account, use the
  email local-part prefix (before `@`) as `account` (e.g., `alice`) and the full
  email address as `label` (e.g., `alice@example.com`). If the user hasn't provided
  the email yet, `gemini_web_list_capabilities` automatically fills `label` with the
  detected Google email after login.
- If a tool returns `NEED_AUTH` or `NEED_USER_ACTION`:
  1. Call `gemini_web_login_account(account="<id>")` to open a clean, non-automated
     Chrome window bound to that account's isolated profile.
  2. Tell the user to complete Google Sign-In / 2FA / verification in that Chrome
     window and **close that login window** when finished.
  3. Stop and wait for the user's confirmation before retrying. Never attempt to
     bypass authentication or CAPTCHAs.
- If a tool returns `PROFILE_LOCKED_BY_LOGIN_WINDOW`, instruct the user to close the
  open manual login Chrome window for that account and retry.

### 2. Discover Live Models, Modes & Gems
- Before promising a specific web model or feature on an unfamiliar account, call
  `gemini_web_list_capabilities(account="<id>")` to read the live model menu,
  supported modes (`chat`, `deep_research`, `canvas`, `image`, `video`), and visible Gems.

### 3. Choose the Right Execution Tool
- **Quick Q&A / Canvas / File Upload / Single Image**:
  Call `gemini_web_ask(prompt, account?, model?, mode?, gem?, files?, conversation_id?, allow_parallel?)`.
  - Always save and reuse the returned `conversationId` when the user asks a
    follow-up question on the same topic or image.
- **Video Generation or Heavy Multi-Minute Tasks**:
  Use `gemini_web_start_task(...)` to get a `task_id` immediately, then poll
  `gemini_web_get_task_status(task_id="<id>")` until `status` is `completed` or `failed`.
- **Deep Research**:
  1. Call `gemini_web_start_deep_research(topic, account?, model?, auto_start=..., allow_parallel?)`.
     - Use `auto_start=false` when the user wants to review the research plan first;
       once `status === "awaiting_confirmation"`, present `researchPlan` and call
       `gemini_web_confirm_deep_research(task_id)` after user approval.
     - Use `auto_start=true` when the user wants an end-to-end report directly.
  2. Poll `gemini_web_get_task_status(task_id)` until completion.

### 4. Single-Thread First, Controlled Parallelism & Anti-Abuse Rules
- **Default to single-threaded execution (`allow_parallel` omitted or `false`)**:
  Evaluate first whether parallelism is genuinely necessary. For normal Q&A, single
  image/video requests, or tasks with sequential dependencies (e.g., draft copy ->
  generate image -> edit image), ALWAYS run single-threaded so extra Chrome sessions
  are not spawned unnecessarily.
- **Only set `allow_parallel: true` when BOTH conditions hold**:
  1. Tasks are strictly independent (no shared `conversation_id` or sequential output
     dependency); AND
  2. Parallelism gives clear user value (e.g., a multi-minute Deep Research / video
     task is already running while the user requests another independent task, or the
     user explicitly asks to generate multiple independent outputs concurrently).
- **Anti-Abuse & Circuit Breaker**:
  - Never issue bulk/automated high-frequency request loops. Respect `RATE_LIMITED`
    and `CIRCUIT_BREAKER_OPEN` immediately — stop and inform the user instead of retrying.

### 5. Smart Account Routing, Dynamic Tier Refresh & Quota Failover (Pro-First)
- When `account` is omitted on a new task, the bridge automatically routes using the
  configured `pro_first` policy:
  - Prefers `pro` accounts first (and prefers idle accounts when `allow_parallel: true`),
    filters by capability (`video` / `deep_research` / `canvas`), and skips accounts whose
    `(account, mode)` is in quota cooldown.
  - Every page load passively checks `pro <-> free` signals (`Upgrade` button vs
    `Google membership`/`Pro`) and updates `tier` dynamically. If `gemini_web_list_accounts`
    marks an account `tierStale: true`, call `gemini_web_list_capabilities(account)` to refresh.
  - On `QUOTA_EXCEEDED` for a new task, the bridge automatically records a per-mode
    cooldown on that account and fails over to the next eligible account, reporting
    `failoverHistory`.
- When `conversation_id` is passed, the bridge locks to the owning account. If that
  account hits `QUOTA_EXCEEDED`:
  - **Image editing relay**: omit `conversation_id` and pass the previously downloaded
    local image path in `files=[...]` so the bridge routes to a backup account seamlessly.
  - **Text continuation relay**: summarize prior context and start a fresh turn without
    `conversation_id` so the bridge routes to an available backup account.
- If `ALL_ACCOUNTS_QUOTA_EXCEEDED` is returned, report the cooldown expiry times and
  offer to bind a backup account via `gemini_web_login_account`.

### 6. Deliver Results & Local Media
- Generated images and videos are automatically downloaded to the plugin's local
  `data/outputs/<task_id>/` directory and returned in `media[].localPath`. Provide
  clickable `file://` links for saved files.
- If `quotaWarning` or `failoverHistory` is present in the response, explicitly surface
  it to the user instead of hiding potential model downgrades, rate limits, or account switches.

### 7. Troubleshooting UI Selector Drift
- If `SELECTOR_FAILED` or `MODE_NOT_FOUND` occurs, check the diagnostic screenshot
  path returned in `error.details.screenshotPath`. Selectors are centralized in
  `config/selectors.json` inside the plugin directory and can be hot-updated without
  rebuilding code.
