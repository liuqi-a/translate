export type Direction = "en-zh" | "zh-en" | "auto";

export type TargetLanguage = "中文" | "英文";

export interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  direction: Direction;
}

export interface Summary {
  title: string;
  overview: string;
  points: string[];
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  translated?: number;
}

export const storageKey = "moyeSettings";

export const defaultSettings: Settings = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  direction: "en-zh",
};

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 判断翻译方向是否合法。 */
export function isDirection(value: unknown): value is Direction {
  return value === "en-zh" || value === "zh-en" || value === "auto";
}

/** 把存储或表单里的值补成完整设置。 */
export function normalizeSettings(value: unknown): Settings {
  const source = isRecord(value) ? value : {};
  const baseUrl = typeof source.baseUrl === "string" ? source.baseUrl.trim() : "";
  const model = typeof source.model === "string" ? source.model.trim() : "";
  return {
    apiKey: typeof source.apiKey === "string" ? source.apiKey : "",
    baseUrl: baseUrl || defaultSettings.baseUrl,
    model: model || defaultSettings.model,
    direction: isDirection(source.direction) ? source.direction : defaultSettings.direction,
  };
}

/** 读取本地保存的接口与翻译设置。 */
export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(storageKey);
  return normalizeSettings(stored[storageKey]);
}

/** 保存接口与翻译设置。 */
export async function writeSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [storageKey]: normalizeSettings(settings) });
}

/** 把未知错误转换成可展示的说明。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "出现未知错误";
}
