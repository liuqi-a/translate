import {
  errorMessage,
  isDirection,
  normalizeSettings,
  readSettings,
  writeSettings,
  type ActionResult,
  type Direction,
  type Settings,
} from "../shared/settings";

/** 按 id 获取节点，缺失时直接提示。 */
function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少节点 ${id}`);
  return element as T;
}

const apiKeyInput = byId<HTMLInputElement>("apiKey");
const baseUrlInput = byId<HTMLInputElement>("baseUrl");
const modelInput = byId<HTMLInputElement>("model");
const statusNode = byId<HTMLParagraphElement>("status");
const dot = byId<HTMLSpanElement>("dot");
const form = byId<HTMLFormElement>("settingsForm");
const toggleKeyButton = byId<HTMLButtonElement>("toggleKey");
const testButton = byId<HTMLButtonElement>("test");
const translateButton = byId<HTMLButtonElement>("translate");
const summarizeButton = byId<HTMLButtonElement>("summarize");
const restoreButton = byId<HTMLButtonElement>("restore");
const directionButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-direction]")];
const actionButtons = [translateButton, summarizeButton, restoreButton, testButton];

let direction: Direction = "en-zh";

/** 更新底部状态和右上角指示点。 */
function setStatus(text: string, tone: "ok" | "error" | "busy" | ""): void {
  statusNode.textContent = text;
  statusNode.className = tone;
  dot.className = tone ? `dot ${tone}` : "dot";
}

/** 切换当前翻译方向的选中态。 */
function setDirection(next: Direction): void {
  direction = next;
  for (const button of directionButtons) {
    button.classList.toggle("active", button.dataset.direction === next);
  }
}

/** 锁定或放开会发起请求的按钮。 */
function setBusy(busy: boolean): void {
  for (const button of actionButtons) button.disabled = busy;
}

/** 读取表单并写入本地存储。 */
async function persistForm(): Promise<Settings> {
  const settings = normalizeSettings({
    apiKey: apiKeyInput.value,
    baseUrl: baseUrlInput.value,
    model: modelInput.value,
    direction,
  });
  if (!/^https?:\/\/.+/i.test(settings.baseUrl)) {
    throw new Error("Base URL 需要以 http:// 或 https:// 开头");
  }
  await writeSettings(settings);
  baseUrlInput.value = settings.baseUrl;
  modelInput.value = settings.model;
  return settings;
}

/** 找到当前窗口里要操作的普通网页。 */
async function findWebTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const active = tabs.find((tab) => tab.active && !!tab.url && /^https?:/i.test(tab.url));
  if (active) return active;
  return tabs.find((tab) => !!tab.url && /^https?:/i.test(tab.url));
}

/** 把指令发给页面；内容脚本缺失时补注入一次。 */
async function sendToPage(message: { type: string }): Promise<ActionResult> {
  const tab = await findWebTab();
  if (!tab?.id) throw new Error("请先打开一个普通网页");
  try {
    return (await chrome.tabs.sendMessage(tab.id, message)) as ActionResult;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return (await chrome.tabs.sendMessage(tab.id, message)) as ActionResult;
    } catch {
      throw new Error("无法在此页面运行，请换一个普通网页");
    }
  }
}

/** 保存设置后执行整页翻译、总结或恢复。 */
async function runPageAction(type: string, pending: string): Promise<void> {
  setBusy(true);
  setStatus(pending, "busy");
  try {
    await persistForm();
    const result = await sendToPage({ type });
    if (!result?.ok) throw new Error(result?.error || "操作失败");
    setStatus(result.message || "已完成", "ok");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

/** 用表单中的密钥测试 OpenAI 兼容接口。 */
async function testConnection(): Promise<void> {
  setBusy(true);
  setStatus("正在连接…", "busy");
  try {
    const settings = await persistForm();
    const result = (await chrome.runtime.sendMessage({
      type: "test-connection",
      settings,
    })) as { ok?: boolean; model?: string; error?: string };
    if (!result?.ok) throw new Error(result?.error || "连接失败");
    setStatus(`连接成功 · ${result.model || settings.model}`, "ok");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

/** 把已保存的设置填回表单。 */
async function loadForm(): Promise<void> {
  const settings = await readSettings();
  apiKeyInput.value = settings.apiKey;
  baseUrlInput.value = settings.baseUrl;
  modelInput.value = settings.model;
  setDirection(settings.direction);
}

for (const button of directionButtons) {
  button.addEventListener("click", () => {
    const value = button.dataset.direction;
    if (isDirection(value)) setDirection(value);
  });
}

toggleKeyButton.addEventListener("click", () => {
  const visible = apiKeyInput.type === "text";
  apiKeyInput.type = visible ? "password" : "text";
  toggleKeyButton.textContent = visible ? "显示" : "隐藏";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    try {
      await persistForm();
      setStatus("设置已保存", "ok");
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  })();
});

testButton.addEventListener("click", () => {
  void testConnection();
});

translateButton.addEventListener("click", () => {
  void runPageAction("translate-page", "正在翻译当前页面…");
});

summarizeButton.addEventListener("click", () => {
  void runPageAction("summarize-page", "正在总结此页…");
});

restoreButton.addEventListener("click", () => {
  void runPageAction("restore-page", "正在恢复原文…");
});

void loadForm();
