import {
  defaultSettings,
  errorMessage,
  normalizeSettings,
  readSettings,
  type Settings,
  type Summary,
  type TargetLanguage,
} from "../shared/settings";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatResult {
  content: string;
  model: string;
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 判断目标语言是否合法。 */
function isTarget(value: unknown): value is TargetLanguage {
  return value === "中文" || value === "英文";
}

/** 校验密钥和 Base URL，并给出可尝试的接口地址。 */
function endpointCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error("Base URL 需要以 http:// 或 https:// 开头");
  }
  if (/\/chat\/completions$/i.test(trimmed)) return [trimmed];
  if (/\/v\d+$/i.test(trimmed)) return [`${trimmed}/chat/completions`];
  return [`${trimmed}/chat/completions`, `${trimmed}/v1/chat/completions`];
}

/** 确认调用模型前已经填了密钥。 */
function ensureSettings(settings: Settings): void {
  if (!settings.apiKey.trim()) throw new Error("请先填写 API Key");
  endpointCandidates(settings.baseUrl);
}

/** 从错误响应里抽出简短说明。 */
function readError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // 保留原始文本片段。
  }
  return raw.replace(/\s+/g, " ").slice(0, 240);
}

/** 去掉模型偶尔包裹的 Markdown 代码块。 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/** 把模型输出解析成 JSON 值。 */
function parseJsonValue(raw: string): unknown {
  const trimmed = stripFence(raw);
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[\[{]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("模型返回的不是合法 JSON");
  }
}

/** 向 OpenAI 兼容接口发送一次对话请求。 */
async function postChat(
  url: string,
  settings: Settings,
  messages: ChatMessage[],
  jsonMode: boolean,
  maxTokens: number,
  extra: boolean,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: settings.model.trim() || defaultSettings.model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
  };
  if (extra) {
    body.thinking = { type: "disabled" };
    if (jsonMode) body.response_format = { type: "json_object" };
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    throw new Error(`网络请求失败：${errorMessage(error)}`);
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(`接口错误 ${response.status}：${readError(raw)}`);
  let data: {
    model?: string;
    choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new Error("模型返回的不是合法 JSON");
  }
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("翻译结果长度不匹配：输出被截断");
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("接口未返回文本");
  return { content, model: data.model || settings.model };
}

/** 按候选地址调用模型，参数不兼容时去掉扩展字段再试。 */
async function completeOnce(
  settings: Settings,
  messages: ChatMessage[],
  jsonMode: boolean,
  maxTokens: number,
): Promise<ChatResult> {
  ensureSettings(settings);
  const urls = endpointCandidates(settings.baseUrl);
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await postChat(url, settings, messages, jsonMode, maxTokens, true);
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      if (message.includes("400") || message.includes("422")) {
        try {
          return await postChat(url, settings, messages, false, maxTokens, false);
        } catch (inner) {
          lastError = inner;
        }
      }
      if (message.includes("404") || message.includes("405") || message.includes("网络请求失败")) continue;
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("请求失败");
}

/** 调用模型，网络抖动时自动再试一次。 */
async function complete(
  settings: Settings,
  messages: ChatMessage[],
  jsonMode: boolean,
  maxTokens: number,
): Promise<ChatResult> {
  try {
    return await completeOnce(settings, messages, jsonMode, maxTokens);
  } catch (error) {
    if (!errorMessage(error).includes("网络请求失败")) throw error;
    return completeOnce(settings, messages, jsonMode, maxTokens);
  }
}

/** 组装批量翻译提示词。 */
function translateMessages(texts: string[], target: TargetLanguage): ChatMessage[] {
  return [
    {
      role: "system",
      content: '你是翻译引擎。只输出 JSON 对象 {"items": string[]}，不要 Markdown，不要解释。',
    },
    {
      role: "user",
      content: `把 items 中每条文本翻译成${target}。数组长度和顺序必须不变。保留数字、专名、URL、邮箱、代码和占位符。\n${JSON.stringify({ items: texts })}`,
    },
  ];
}

/** 把一批文本翻译成目标语言。 */
async function translateBatch(texts: string[], target: TargetLanguage): Promise<string[]> {
  const settings = await readSettings();
  const result = await complete(settings, translateMessages(texts, target), true, 4096);
  const parsed = parseJsonValue(result.content);
  const source = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed.items ?? parsed.translations
      : undefined;
  if (!Array.isArray(source)) throw new Error("模型返回的不是合法 JSON");
  if (source.length !== texts.length) {
    throw new Error(`翻译结果长度不匹配：期望 ${texts.length} 实际 ${source.length}`);
  }
  return source.map((item) => (typeof item === "string" ? item : String(item ?? "")));
}

/** 组装网页总结提示词。 */
function summaryMessages(text: string, target: TargetLanguage): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        '你是网页摘要助手。只输出 JSON：{"title": string, "overview": string, "points": string[]}。不要编造正文没有的事实。',
    },
    {
      role: "user",
      content: `用${target}总结下面的网页正文。overview 用一句话，points 写 4 到 6 条，每条不超过 40 字。\n\n${text}`,
    },
  ];
}

/** 把网页正文总结成标题、概述和要点。 */
async function summarize(text: string, target: TargetLanguage): Promise<Summary> {
  const settings = await readSettings();
  const result = await complete(settings, summaryMessages(text, target), true, 1200);
  const parsed = parseJsonValue(result.content);
  if (!isRecord(parsed)) throw new Error("模型返回的不是合法 JSON");
  const points = Array.isArray(parsed.points)
    ? parsed.points.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const overview = typeof parsed.overview === "string" ? parsed.overview.trim() : "";
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "页面总结";
  if (!overview && points.length === 0) throw new Error("总结内容为空");
  return { title, overview, points };
}

/** 用当前设置发一条最短请求，确认接口可用。 */
async function testConnection(settings: Settings): Promise<string> {
  const result = await complete(
    settings,
    [{ role: "user", content: "只回复小写单词 pong" }],
    false,
    32,
  );
  return result.model;
}

/** 接收弹窗和内容脚本的翻译、总结与连通性请求。 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRecord(message) || typeof message.type !== "string") return false;

  if (message.type === "translate-batch") {
    const texts = message.texts;
    if (!Array.isArray(texts) || texts.some((item) => typeof item !== "string") || !isTarget(message.target)) {
      sendResponse({ ok: false, error: "翻译参数无效" });
      return true;
    }
    void translateBatch(texts, message.target)
      .then((items) => sendResponse({ ok: true, texts: items }))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === "summarize") {
    if (typeof message.text !== "string" || !isTarget(message.target)) {
      sendResponse({ ok: false, error: "总结参数无效" });
      return true;
    }
    void summarize(message.text, message.target)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === "test-connection") {
    const settings = normalizeSettings(message.settings);
    void testConnection(settings)
      .then((model) => sendResponse({ ok: true, model, message: "连接成功" }))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  return false;
});
