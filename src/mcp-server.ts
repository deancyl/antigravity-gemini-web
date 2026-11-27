import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DaemonClient } from "./daemon-client.js";

function formatResult(payload: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const isError =
    typeof payload === "object" &&
    payload !== null &&
    "ok" in payload &&
    (payload as { ok?: unknown }).ok === false;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createGeminiWebMcpServer(rootDir?: string): McpServer {
  const client = new DaemonClient(rootDir);
  const server = new McpServer({
    name: "gemini-web-bridge",
    version: "1.0.0",
  });

  server.tool(
    "gemini_web_daemon_status",
    "检查 Gemini 网页版后台守护服务运行状态、端口与当前活动的 Chrome 会话。",
    {},
    async () => {
      try {
        const res = await client.health();
        return formatResult(res);
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_list_accounts",
    "列出所有已配置的 Gemini 网页版独立账号 Profile、默认账号、最近认证状态、等级与冷却状态；可选传入 refresh_stale=true 串行静默刷新所有超期未检账号，或 refresh_all=true 刷新全部账号等级。",
    {
      refresh_stale: z
        .boolean()
        .optional()
        .describe("设为 true 时先单线程静默刷新所有 tierStale 过期账号的会员等级（默认 false 不刷新）"),
      refresh_all: z
        .boolean()
        .optional()
        .describe("设为 true 时先单线程静默刷新全部已登录账号的会员等级（刚充值想立刻全量生效时使用，默认 false）"),
    },
    async ({ refresh_stale, refresh_all }) => {
      try {
        if (refresh_all === true || refresh_stale === true) {
          const scope = refresh_all === true ? "all" : "stale";
          return formatResult(
            await client.request("POST", "/api/accounts/refresh", { scope }, 180000),
          );
        }
        return formatResult(await client.request("GET", "/api/accounts"));
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_login_account",
    "以纯净无自动化标志的正式版 Chrome 打开指定账号的独立 Profile 窗口，供用户手动登录 Google 账号或完成安全验证。登录完成后请提醒用户关闭该登录窗口。",
    {
      account: z
        .string()
        .optional()
        .describe("账号标识（如 personal、work、ultra），留空则使用默认账号"),
      label: z.string().optional().describe("可选的账号备注名（如 个人Pro号 / 公司账号）"),
    },
    async ({ account, label }) => {
      try {
        return formatResult(
          await client.request("POST", "/api/accounts/login", {
            ...(account ? { account } : {}),
            ...(label ? { label } : {}),
          }),
        );
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_switch_account",
    "切换后续调用默认使用的 Gemini 网页版账号标识。",
    {
      account: z.string().min(1).describe("要设为默认的账号标识"),
    },
    async ({ account }) => {
      try {
        return formatResult(await client.request("POST", "/api/accounts/default", { account }));
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_close_session",
    "安全关闭指定账号或全部账号的受控 Chrome 自动化会话并释放 Profile 锁。",
    {
      account: z.string().optional().describe("指定账号标识；留空则关闭所有受控 Chrome 会话"),
    },
    async ({ account }) => {
      try {
        return formatResult(
          await client.request("POST", "/api/accounts/close-session", {
            ...(account ? { account } : {}),
          }),
        );
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_list_capabilities",
    "实时探测指定账号在 Gemini 网页版当前可见的模型列表、可用任务模式（Deep Research/Canvas/生图/视频）与 Gems 列表。",
    {
      account: z.string().optional().describe("账号标识，留空使用默认账号"),
    },
    async ({ account }) => {
      try {
        return formatResult(
          await client.request("POST", "/api/capabilities", {
            ...(account ? { account } : {}),
          }, 90000),
        );
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_ask",
    "向 Gemini 网页版发送提示词并同步等待回复。支持切换账号、指定模型、开启模式（chat/canvas/image/video）、使用 Gem、上传本地文件、传入 conversation_id 多轮续聊，并自动无损提取 Markdown 与下载生成的图片/视频到本地。",
    {
      prompt: z.string().min(1).describe("发送给 Gemini 网页版的提示词"),
      account: z.string().optional().describe("账号标识，留空使用默认账号"),
      model: z.string().optional().describe("目标模型名称或关键词（如 Flash、Pro、Thinking）"),
      mode: z
        .enum(["chat", "canvas", "image", "video"])
        .optional()
        .describe("任务模式，默认 chat；视频或长时间生成建议改用 gemini_web_start_task 异步执行"),
      gem: z.string().optional().describe("Gem 名称或完整 https://gemini.google.com/gem/... URL"),
      files: z.array(z.string()).optional().describe("待上传的本地文件绝对路径列表"),
      conversation_id: z
        .string()
        .optional()
        .describe("历史对话 ID 或完整对话 URL，用于多轮续聊；留空则开启新对话"),
      allow_parallel: z
        .boolean()
        .optional()
        .describe("默认 false（严格单线程）；仅在确实有必要且任务完全独立时设为 true 以启用空闲优先跨号并行"),
      timeout_ms: z.number().int().positive().optional().describe("可选等待超时（毫秒）"),
    },
    async ({ prompt, account, model, mode, gem, files, conversation_id, allow_parallel, timeout_ms }) => {
      try {
        return formatResult(
          await client.request(
            "POST",
            "/api/ask",
            {
              prompt,
              ...(account ? { account } : {}),
              ...(model ? { model } : {}),
              ...(mode ? { mode } : {}),
              ...(gem ? { gem } : {}),
              ...(files ? { files } : {}),
              ...(conversation_id ? { conversationId: conversation_id } : {}),
              ...(allow_parallel === true ? { allowParallel: true } : {}),
              ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
            },
            (timeout_ms ?? 240000) + 15000,
          ),
        );
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_start_task",
    "异步提交一个 Gemini 网页版后台长任务（推荐用于视频生成、批量生图或耗时推理），立即返回 task_id；任务在独立守护进程持久化运行，通过 gemini_web_get_task_status 轮询结果。",
    {
      prompt: z.string().min(1).describe("任务提示词"),
      account: z.string().optional().describe("账号标识"),
      model: z.string().optional().describe("目标模型名称或关键词"),
      mode: z
        .enum(["chat", "canvas", "image", "video"])
        .optional()
        .describe("任务模式（如 image / video / canvas / chat）"),
      gem: z.string().optional().describe("Gem 名称或 URL"),
      files: z.array(z.string()).optional().describe("本地上传文件路径列表"),
      conversation_id: z.string().optional().describe("可选历史对话 ID/URL"),
      allow_parallel: z
        .boolean()
        .optional()
        .describe("默认 false（严格单线程）；仅在确实有必要且任务完全独立时设为 true"),
    },
    async ({ prompt, account, model, mode, gem, files, conversation_id, allow_parallel }) => {
      try {
        return formatResult(
          await client.request("POST", "/api/tasks/ask", {
            prompt,
            ...(account ? { account } : {}),
            ...(model ? { model } : {}),
            ...(mode ? { mode } : {}),
            ...(gem ? { gem } : {}),
            ...(files ? { files } : {}),
            ...(conversation_id ? { conversationId: conversation_id } : {}),
            ...(allow_parallel === true ? { allowParallel: true } : {}),
          }),
        );
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_start_deep_research",
    "启动 Gemini 网页版 Deep Research 深度研究异步任务，立即返回 task_id。支持 auto_start=true 自动确认研究计划并跑完，或 auto_start=false 先停在 awaiting_confirmation 返回研究计划供审核。",
    {
      topic: z.string().min(1).describe("深度研究主题与具体要求"),
      account: z.string().optional().describe("账号标识"),
      model: z.string().optional().describe("可选模型关键词"),
      auto_start: z
        .boolean()
        .optional()
        .describe("是否自动点击“开始研究”按钮（默认 true）；设为 false 则先返回研究计划待确认"),
      allow_parallel: z
        .boolean()
        .optional()
        .describe("默认 false（严格单线程）；仅在确实需要与另一独立任务并行时设为 true"),
    },
    async ({ topic, account, model, auto_start, allow_parallel }) => {
      try {
        return formatResult(
          await client.request("POST", "/api/tasks/deep-research", {
            topic,
            ...(account ? { account } : {}),
            ...(model ? { model } : {}),
            ...(auto_start !== undefined ? { autoStart: auto_start } : {}),
            ...(allow_parallel === true ? { allowParallel: true } : {}),
          }),
        );
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_confirm_deep_research",
    "确认并开始执行处于 awaiting_confirmation 状态的 Deep Research 研究计划。",
    {
      task_id: z.string().min(1).describe("待确认的 Deep Research task_id"),
    },
    async ({ task_id }) => {
      try {
        return formatResult(
          await client.request("POST", `/api/tasks/${encodeURIComponent(task_id)}/confirm`),
        );
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_get_task_status",
    "查询后台异步任务的执行状态、研究计划、最终 Markdown 文本及已落盘的图片/视频路径；省略 task_id 时列出最近任务。",
    {
      task_id: z.string().optional().describe("任务 ID；留空返回最近 50 条任务列表"),
    },
    async ({ task_id }) => {
      try {
        const apiPath = task_id ? `/api/tasks/${encodeURIComponent(task_id)}` : "/api/tasks";
        return formatResult(await client.request("GET", apiPath));
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  server.tool(
    "gemini_web_list_conversations",
    "列出最近记录的 Gemini 网页版对话 ID、URL 与所属账号，方便接续历史上下文。",
    {},
    async () => {
      try {
        return formatResult(await client.request("GET", "/api/conversations"));
      } catch (err) {
        return formatResult({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );

  return server;
}

const isDirectMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));

if (isDirectMain) {
  const server = createGeminiWebMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
