import {
  errorMessage,
  readSettings,
  type ActionResult,
  type Direction,
  type Summary,
  type TargetLanguage,
} from "../shared/settings";

declare global {
  interface Window {
    __moyeLoaded?: boolean;
  }
}

interface WorkItem {
  core: string;
  target: TargetLanguage;
  apply: (value: string) => void;
}

interface TextRecord {
  node: Text;
  original: string;
}

interface AttrRecord {
  element: Element;
  name: string;
  original: string;
}

interface DockAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface BatchResponse {
  ok?: boolean;
  texts?: string[];
  error?: string;
}

interface SummaryResponse {
  ok?: boolean;
  summary?: Summary;
  error?: string;
}

const skipSelector = "script,style,noscript,code,pre,kbd,samp,textarea,svg,canvas,iframe,[data-moye-root]";
const overlayCss = `
  * { box-sizing: border-box; }
  .hidden { display: none !important; }
  .dock, .bubble, .summary {
    position: fixed;
    z-index: 2147483646;
    color: #1d1a16;
    font: 13px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .dock {
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(560px, calc(100vw - 24px));
    padding: 8px 8px 8px 14px;
    border: 1px solid #e4d9c8;
    border-radius: 999px;
    background: #fffdf8;
    box-shadow: 0 12px 32px rgba(40, 24, 16, 0.14);
  }
  .dock span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bubble {
    width: 280px;
    padding: 12px;
    border: 1px solid #e4d9c8;
    border-radius: 16px;
    background: #fffdf8;
    box-shadow: 0 16px 40px rgba(40, 24, 16, 0.16);
  }
  .summary {
    top: 16px;
    right: 16px;
    width: min(360px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 16px;
    border: 1px solid #e4d9c8;
    border-radius: 18px;
    background: #fffdf8;
    box-shadow: 0 18px 50px rgba(40, 24, 16, 0.16);
  }
  .kicker { color: #a33b32; font-size: 12px; letter-spacing: 0.06em; }
  .source { margin: 8px 0; color: #6f675e; }
  .result, .moye-overview { margin: 8px 0 0; font-size: 14px; white-space: pre-wrap; }
  .summary h2 { margin: 0; font-size: 16px; }
  .summary-head, .summary-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .summary ul { margin: 8px 0 0; padding-left: 18px; }
  .summary li + li { margin-top: 4px; }
  .danger { color: #a33b32; }
  button {
    height: 30px;
    border: 1px solid #e4d9c8;
    border-radius: 999px;
    background: #fff;
    color: #1d1a16;
    font: inherit;
    padding: 0 12px;
    cursor: pointer;
  }
  button.primary { border-color: transparent; background: #a33b32; color: #fffaf6; }
  button:disabled { opacity: 0.6; cursor: default; }
`;

const textRecords: TextRecord[] = [];
const attrRecords: AttrRecord[] = [];
let translatedText = new WeakSet<Text>();
let translatedAttrs = new WeakMap<Element, Set<string>>();
let jobToken = 0;
let host!: HTMLElement;
let shadow!: ShadowRoot;
let dock!: HTMLElement;
let bubble!: HTMLElement;
let summary!: HTMLElement;

/** 启动内容脚本，避免重复注入时注册多套监听。 */
function start(): void {
  if (window.__moyeLoaded) return;
  mountOverlay();
  window.__moyeLoaded = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void dispatchPageMessage(message, sendResponse);
    return isPageMessage(message);
  });
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideBubble();
      hideSummary();
    }
  });
}

/** 判断消息是否要由页面脚本处理。 */
function isPageMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: string }).type;
  return type === "translate-page" || type === "summarize-page" || type === "restore-page";
}

/** 分发整页翻译、总结和恢复原文。 */
async function dispatchPageMessage(
  message: unknown,
  sendResponse: (response: ActionResult) => void,
): Promise<void> {
  if (!isPageMessage(message)) return;
  const type = (message as { type: string }).type;
  try {
    if (type === "translate-page") {
      reply(sendResponse, await translatePage());
      return;
    }
    if (type === "summarize-page") {
      reply(sendResponse, await summarizePage());
      return;
    }
    reply(sendResponse, restorePage());
  } catch (error) {
    reply(sendResponse, { ok: false, error: errorMessage(error) });
  }
}

/** 安全回传结果；弹窗关掉时忽略断开的通道。 */
function reply(sendResponse: (response: ActionResult) => void, result: ActionResult): void {
  try {
    sendResponse(result);
  } catch {
    // 弹窗关闭后不再回传。
  }
}

/** 按当前方向翻译页面可见文本。 */
async function translatePage(): Promise<ActionResult> {
  const token = ++jobToken;
  const settings = await readSettings();
  const items = collectWork(settings.direction);
  if (items.length === 0) {
    showDock("没有需要翻译的文本", [{ label: "关闭", onClick: hideDock }]);
    return { ok: true, message: "没有需要翻译的文本", translated: 0 };
  }
  const groups = new Map<TargetLanguage, WorkItem[]>();
  for (const item of items) {
    const list = groups.get(item.target) ?? [];
    list.push(item);
    groups.set(item.target, list);
  }
  const chunks = [...groups.entries()].flatMap(([target, group]) =>
    chunkItems(group, 1800, 20).map((chunk) => ({ target, items: chunk })),
  );
  let done = 0;
  let fatal: unknown = null;
  showDock(`正在翻译 0/${items.length}`, [{ label: "取消", onClick: () => cancelJob(token) }]);
  await runPool(chunks, 3, async (chunk) => {
    if (token !== jobToken || fatal) return;
    try {
      const translated = await translateChunk(
        chunk.items.map((item) => item.core),
        chunk.target,
      );
      if (token !== jobToken || fatal) return;
      chunk.items.forEach((item, index) => {
        const value = translated[index]?.trim();
        item.apply(value || item.core);
      });
      done += chunk.items.length;
      showDock(`正在翻译 ${done}/${items.length}`, [{ label: "取消", onClick: () => cancelJob(token) }]);
    } catch (error) {
      if (!fatal) fatal = error;
    }
  });
  if (token !== jobToken) return { ok: false, error: "已取消", translated: done };
  if (fatal && done === 0) return { ok: false, error: errorMessage(fatal) };
  const message = fatal
    ? `已翻译 ${done} 处，部分失败：${errorMessage(fatal).slice(0, 120)}`
    : `已翻译 ${done} 处`;
  showDock(message, [
    { label: "恢复原文", onClick: () => restorePage(), primary: true },
    { label: "关闭", onClick: hideDock },
  ]);
  return fatal ? { ok: false, error: message, translated: done } : { ok: true, message, translated: done };
}

/** 取消当前翻译任务。 */
function cancelJob(token: number): void {
  if (jobToken === token) jobToken += 1;
  showDock("已取消", [{ label: "关闭", onClick: hideDock }]);
}

/** 收集还没翻译过的文本节点和属性。 */
function collectWork(direction: Direction): WorkItem[] {
  const items: WorkItem[] = [];
  if (!document.body) return items;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const node = current;
    current = walker.nextNode();
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (!parent || parent.closest(skipSelector) || parent.closest("[translate='no']")) continue;
    if (parent.isContentEditable || translatedText.has(textNode) || !isVisible(parent)) continue;
    const original = textNode.nodeValue ?? "";
    const edges = splitEdges(original);
    if (!hasTranslatable(edges.core)) continue;
    const target = resolveTarget(edges.core, direction);
    if (!shouldTranslate(edges.core, target)) continue;
    items.push({
      core: edges.core,
      target,
      apply(value: string) {
        textNode.nodeValue = `${edges.lead}${value}${edges.tail}`;
        translatedText.add(textNode);
        textRecords.push({ node: textNode, original });
      },
    });
  }
  const elements = document.body.querySelectorAll(
    "[title], [alt], [placeholder], [aria-label], input[type='button'], input[type='submit'], input[type='reset']",
  );
  for (const element of elements) {
    if (!(element instanceof HTMLElement)) continue;
    if (element.closest(skipSelector) || element.closest("[translate='no']") || !isVisible(element)) continue;
    for (const name of attributeNames(element)) {
      if (translatedAttrs.get(element)?.has(name)) continue;
      const original = element.getAttribute(name) ?? "";
      if (!hasTranslatable(original)) continue;
      const target = resolveTarget(original, direction);
      if (!shouldTranslate(original, target)) continue;
      items.push({
        core: original.trim(),
        target,
        apply(value: string) {
          element.setAttribute(name, value);
          const marked = translatedAttrs.get(element) ?? new Set<string>();
          marked.add(name);
          translatedAttrs.set(element, marked);
          attrRecords.push({ element, name, original });
        },
      });
    }
  }
  return items;
}

/** 列出元素上需要翻译的属性。 */
function attributeNames(element: Element): string[] {
  const names = ["title", "alt", "placeholder", "aria-label"].filter((name) => element.hasAttribute(name));
  if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type) && element.hasAttribute("value")) {
    names.push("value");
  }
  return names;
}

/** 判断元素当前是否可见。 */
function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return element.getClientRects().length > 0;
}

/** 拆出文本两端的空白，避免翻译后贴死。 */
function splitEdges(text: string): { lead: string; core: string; tail: string } {
  const matched = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return { lead: matched?.[1] ?? "", core: matched?.[2] ?? "", tail: matched?.[3] ?? "" };
}

/** 判断一段文本是否值得送给模型。 */
function hasTranslatable(text: string): boolean {
  const core = text.trim();
  if (core.length < 2 || core.length > 4000) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(core)) return false;
  if (/^https?:\/\/\S+$/i.test(core)) return false;
  if (/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(core)) return false;
  return true;
}

/** 根据方向决定这条文本要译成哪种语言。 */
function resolveTarget(text: string, direction: Direction): TargetLanguage {
  if (direction === "en-zh") return "中文";
  if (direction === "zh-en") return "英文";
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return chinese > latin ? "英文" : "中文";
}

/** 跳过已经是目标语言的文本。 */
function shouldTranslate(text: string, target: TargetLanguage): boolean {
  if (target === "中文") return /[A-Za-z]/.test(text);
  return /[\u4e00-\u9fff]/.test(text);
}

/** 按字数把待翻译条目分成小批。 */
function chunkItems(items: WorkItem[], maxChars: number, maxItems: number): WorkItem[][] {
  const chunks: WorkItem[][] = [];
  let current: WorkItem[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length >= maxItems || size + item.core.length > maxChars)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.core.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 以有限并发跑完每一批。 */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  /** 不断取下一项，直到队列清空。 */
  async function takeNext(): Promise<void> {
    while (cursor < items.length) {
      const current = items[cursor];
      cursor += 1;
      await worker(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => takeNext()));
}

/** 翻译一批文本；结果对不齐时拆成两半重试。 */
async function translateChunk(texts: string[], target: TargetLanguage): Promise<string[]> {
  try {
    return await requestTranslate(texts, target);
  } catch (error) {
    if (texts.length <= 1 || !canSplit(error)) throw error;
    const middle = Math.ceil(texts.length / 2);
    const left = await translateChunk(texts.slice(0, middle), target);
    const right = await translateChunk(texts.slice(middle), target);
    return [...left, ...right];
  }
}

/** 判断这次失败是否适合拆批重试。 */
function canSplit(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("长度") || message.includes("JSON") || message.includes("合法");
}

/** 请后台调用模型翻译一组文本。 */
async function requestTranslate(texts: string[], target: TargetLanguage): Promise<string[]> {
  const response = (await chrome.runtime.sendMessage({
    type: "translate-batch",
    texts,
    target,
  })) as BatchResponse;
  if (!response?.ok || !Array.isArray(response.texts)) throw new Error(response?.error || "翻译失败");
  if (response.texts.length !== texts.length) {
    throw new Error(`翻译结果长度不匹配：期望 ${texts.length} 实际 ${response.texts.length}`);
  }
  return response.texts;
}

/** 提取正文并在页面右侧显示总结。 */
async function summarizePage(): Promise<ActionResult> {
  const token = ++jobToken;
  const text = extractPageText();
  if (text.length < 20) {
    showSummaryError("页面正文太少，无法总结");
    return { ok: false, error: "页面正文太少，无法总结" };
  }
  showSummaryLoading();
  const settings = await readSettings();
  const target = resolveTarget(text, settings.direction);
  const response = (await chrome.runtime.sendMessage({
    type: "summarize",
    text,
    target,
  })) as SummaryResponse;
  if (token !== jobToken) return { ok: false, error: "已取消" };
  if (!response?.ok || !response.summary) {
    const message = response?.error || "总结失败";
    showSummaryError(message);
    return { ok: false, error: message };
  }
  showSummary(response.summary);
  return { ok: true, message: "总结已显示在页面右侧" };
}

/** 读取文章、主内容或正文的纯文本。 */
function extractPageText(): string {
  const root = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  if (!root) return "";
  return root.innerText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000);
}

/** 把已替换的文本和属性改回原文。 */
function restorePage(): ActionResult {
  jobToken += 1;
  for (const record of textRecords) {
    if (record.node.isConnected) record.node.nodeValue = record.original;
  }
  for (const record of attrRecords) {
    if (record.element.isConnected) record.element.setAttribute(record.name, record.original);
  }
  textRecords.length = 0;
  attrRecords.length = 0;
  translatedText = new WeakSet();
  translatedAttrs = new WeakMap();
  showDock("已恢复原文", [{ label: "关闭", onClick: hideDock }]);
  return { ok: true, message: "已恢复原文" };
}

/** 选中文本后在附近放一个翻译气泡。 */
function onMouseUp(event: MouseEvent): void {
  if (event.composedPath().includes(host)) return;
  const selected = window.getSelection();
  const text = selected?.toString().trim() ?? "";
  if (!hasTranslatable(text)) {
    hideBubble();
    return;
  }
  const range = selected && selected.rangeCount > 0 ? selected.getRangeAt(0).getBoundingClientRect() : null;
  const x = range && range.width ? range.left : event.clientX;
  const y = range && range.height ? range.bottom : event.clientY;
  openBubble(text.slice(0, 3000), x, y);
}

/** 点击页面空白处时收起气泡。 */
function onMouseDown(event: MouseEvent): void {
  if (!event.composedPath().includes(host)) hideBubble();
}

/** 翻译用户刚选中的文本。 */
async function translateSelection(text: string): Promise<void> {
  const result = document.createElement("p");
  result.className = "result moye-result";
  result.textContent = "正在翻译…";
  bubble.querySelector(".moye-result")?.remove();
  bubble.querySelector(".moye-go")?.setAttribute("disabled", "true");
  bubble.append(result);
  try {
    const settings = await readSettings();
    const [translated] = await translateChunk([text], resolveTarget(text, settings.direction));
    result.textContent = translated?.trim() || "没有译出内容";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "复制";
    copyButton.addEventListener("click", () => {
      void copyText(result.textContent ?? "", copyButton);
    });
    bubble.append(copyButton);
  } catch (error) {
    result.classList.add("danger");
    result.textContent = errorMessage(error);
  }
}

/** 复制译文，失败时给出按钮提示。 */
async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
}

/** 创建隔离在 Shadow DOM 里的浮层。 */
function mountOverlay(): void {
  host = document.createElement("div");
  host.setAttribute("data-moye-root", "");
  host.setAttribute("translate", "no");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;overflow:visible;";
  shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${overlayCss}</style><div class="dock hidden"></div><div class="bubble hidden"></div><section class="summary hidden"></section>`;
  dock = shadow.querySelector(".dock") as HTMLElement;
  bubble = shadow.querySelector(".bubble") as HTMLElement;
  summary = shadow.querySelector(".summary") as HTMLElement;
  document.documentElement.append(host);
}

/** 显示底部进度或完成条。 */
function showDock(text: string, actions: DockAction[]): void {
  dock.replaceChildren();
  const label = document.createElement("span");
  label.textContent = text;
  dock.append(label);
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    if (action.primary) button.className = "primary";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action.onClick();
    });
    dock.append(button);
  }
  dock.classList.remove("hidden");
}

/** 关闭底部提示条。 */
function hideDock(): void {
  dock.classList.add("hidden");
  dock.replaceChildren();
}

/** 在选区附近打开划词气泡。 */
function openBubble(text: string, x: number, y: number): void {
  bubble.replaceChildren();
  const width = 280;
  bubble.style.left = `${Math.min(Math.max(8, x), window.innerWidth - width - 8)}px`;
  bubble.style.top = `${Math.min(Math.max(8, y + 8), window.innerHeight - 120)}px`;
  const title = document.createElement("div");
  title.className = "kicker";
  title.textContent = "划词翻译";
  const source = document.createElement("p");
  source.className = "source";
  source.textContent = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary moye-go";
  button.textContent = "翻译";
  button.addEventListener("click", () => {
    void translateSelection(text);
  });
  bubble.append(title, source, button);
  bubble.classList.remove("hidden");
}

/** 关闭划词气泡。 */
function hideBubble(): void {
  bubble.classList.add("hidden");
  bubble.replaceChildren();
}

/** 显示总结加载状态。 */
function showSummaryLoading(): void {
  summary.replaceChildren();
  const row = document.createElement("div");
  row.className = "summary-top";
  const title = document.createElement("h2");
  title.textContent = "正在总结…";
  row.append(title, closeButton());
  summary.append(row);
  summary.classList.remove("hidden");
}

/** 渲染总结结果。 */
function showSummary(data: Summary): void {
  summary.replaceChildren();
  const head = document.createElement("div");
  head.className = "summary-head";
  const title = document.createElement("h2");
  title.className = "moye-title";
  title.textContent = data.title || "页面总结";
  head.append(title, closeButton());
  const overview = document.createElement("p");
  overview.className = "moye-overview";
  overview.textContent = data.overview;
  const list = document.createElement("ul");
  for (const point of data.points) {
    const item = document.createElement("li");
    item.textContent = point;
    list.append(item);
  }
  summary.append(head, overview, list);
  summary.classList.remove("hidden");
}

/** 在总结面板里显示错误。 */
function showSummaryError(message: string): void {
  summary.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "总结失败";
  const text = document.createElement("p");
  text.className = "danger moye-overview";
  text.textContent = message;
  summary.append(title, text, closeButton());
  summary.classList.remove("hidden");
}

/** 关闭总结面板。 */
function hideSummary(): void {
  summary.classList.add("hidden");
  summary.replaceChildren();
}

/** 创建总结面板的关闭按钮。 */
function closeButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "关闭";
  button.addEventListener("click", hideSummary);
  return button;
}

start();
