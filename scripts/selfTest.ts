import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const chromePath = "C:\\Users\\000\\.cache\\puppeteer\\chrome\\win64-155.0.8059.79\\chrome-win64\\chrome.exe";

const enPage = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Morning Market</title></head><body>
<h1 id="heading">Morning Market Notes</h1>
<p id="lead">The harbor opened early, and the bakers were already selling warm bread to fishermen.</p>
<p id="second">Prices rose slightly after the rain, but the crowd stayed cheerful.</p>
<a id="more" href="https://example.com/tide">Read the tide table</a>
<button id="btn" title="Refresh the board" aria-label="Reload notes">Refresh</button>
<img id="boat" alt="Red fishing boat" width="32" height="32" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
<input id="search" placeholder="Search the stalls">
<pre><code id="code">const keep = "DO_NOT_TRANSLATE_CODE";</code></pre>
<script>window.__secret = "DO_NOT_TRANSLATE_THIS_TOKEN";</script>
</body></html>`;

const zhPage = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>码头</title></head><body>
<h1 id="title">清晨的码头</h1>
<p id="lead">渔船回来的时候，面包店已经把热面包摆上了木桌。</p>
<p id="second">雨后价格略涨，人群却依然轻松。</p>
</body></html>`;

const autoPage = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Auto</title></head><body>
<p id="en">The lighthouse kept its beam on the narrow channel.</p>
<p id="zh">灯塔照着狭窄的航道。</p>
</body></html>`;

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** 断言失败时抛出带场景的错误。 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** 打印当前自测步骤。 */
function step(message: string): void {
  process.stdout.write(`[self-test] ${message}\n`);
}

/** 等待一段时间。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** 判断文本里有没有中文。 */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/** 判断文本里有没有英文单词。 */
function hasLatin(text: string): boolean {
  return /[A-Za-z]{3,}/.test(text);
}

/** 启动只含三张夹具页的本地服务。 */
async function startServer(): Promise<{ server: Server; port: number }> {
  const pages: Record<string, string> = { "/en": enPage, "/zh": zhPage, "/auto": autoPage };
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    const body = pages[path];
    if (!body) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

class Cdp {
  socket: WebSocket;
  next = 1;
  pending = new Map<number, PendingCall>();

  /** 把调试消息转成文本。 */
  async readData(data: unknown): Promise<string> {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
    return String(data);
  }

  /** 连上一个调试目标。 */
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      void this.readData(event.data)
        .then((text) => {
          const message = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
          if (!message.id || !this.pending.has(message.id)) return;
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending?.reject(new Error(message.error.message || "CDP 调用失败"));
          else pending?.resolve(message.result);
        })
        .catch((error: unknown) => {
          for (const pending of this.pending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
          this.pending.clear();
        });
    });
  }

  /** 发送一条 CDP 命令。 */
  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.next;
    this.next += 1;
    const result = await new Promise<unknown>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`CDP 超时：${method}`));
      }, 180000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectCall(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    return (result ?? {}) as Record<string, unknown>;
  }

  /** 在目标里执行表达式并返回值。 */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const remote = result.result as { value?: T } | undefined;
    const details = result.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    if (details) throw new Error(details.exception?.description || details.text || "页面脚本执行失败");
    return remote?.value as T;
  }

  /** 关闭调试连接。 */
  close(): void {
    this.socket.close();
  }
}

/** 连接到调试目标。 */
async function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("调试连接失败")), { once: true });
  });
  return new Cdp(socket);
}

/** 读取 Chrome 当前的调试目标。 */
async function listTargets(port: number): Promise<TargetInfo[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`调试列表失败：${response.status}`);
  return (await response.json()) as TargetInfo[];
}

/** 反复查找某个调试目标。 */
async function waitForTarget(port: number, predicate: (target: TargetInfo) => boolean, label: string): Promise<TargetInfo> {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const targets = await listTargets(port).catch(() => [] as TargetInfo[]);
    last = targets.map((target) => `${target.type} ${target.url}`).join(" | ");
    const found = targets.find(predicate);
    if (found?.webSocketDebuggerUrl) return found;
    await delay(250);
  }
  throw new Error(`找不到${label}：${last}`);
}

/** 等待 Chrome 调试端口可连接。 */
async function waitForVersion(port: number): Promise<string> {
  let last = "未连接";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const body = (await response.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Chrome 调试端口没有起来：${last}`);
}

/** 新开一个标签页。 */
async function openTab(port: number, url: string): Promise<void> {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  let response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) response = await fetch(endpoint);
  if (!response.ok) throw new Error(`无法打开页面 ${url}`);
}

/** 跑通弹窗、整页、划词、总结和中英方向。 */
async function main(): Promise<void> {
  assert(apiKey.length > 20, "缺少 DEEPSEEK_API_KEY");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]) {
    delete process.env[name];
  }
  const { server, port: pagePort } = await startServer();
  const origin = `http://127.0.0.1:${pagePort}`;
  const userDataDir = await mkdtemp(resolve(tmpdir(), "moye-profile-"));
  const debugPort = pagePort + 1;
  const dist = resolve(root, "dist");
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const sessions: Cdp[] = [];
  try {
    const browserSocket = await waitForVersion(debugPort);
    const browser = await connect(browserSocket);
    sessions.push(browser);
    const loaded = await browser.send("Extensions.loadUnpacked", { path: dist });
    const extensionId = String(loaded.id ?? "");
    assert(extensionId.length > 10, "扩展没有加载");
    const workerTarget = await waitForTarget(
      debugPort,
      (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
      "扩展后台",
    );
    const worker = await connect(workerTarget.webSocketDebuggerUrl);
    sessions.push(worker);
    step("扩展已加载");

    /** 把接口配置写入扩展。 */
    async function seed(direction: string): Promise<void> {
      await worker.evaluate(
        `(async () => { await chrome.storage.local.set({ moyeSettings: { apiKey: ${JSON.stringify(apiKey)}, baseUrl: "https://api.deepseek.com", model: "deepseek-flash", direction: ${JSON.stringify(direction)} } }); return true; })()`,
      );
    }

    /** 打开夹具页并连上它。 */
    async function openFixture(path: string): Promise<Cdp> {
      const url = `${origin}${path}`;
      await openTab(debugPort, url);
      const target = await waitForTarget(debugPort, (item) => item.type === "page" && item.url === url, path);
      const page = await connect(target.webSocketDebuggerUrl);
      sessions.push(page);
      await page.evaluate(`(async () => {
        for (let i = 0; i < 40 && !document.querySelector("[data-moye-root]"); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!document.querySelector("[data-moye-root]")) throw new Error("内容脚本没有注入");
        return true;
      })()`);
      return page;
    }

    /** 让后台向页面发送指令。 */
    async function sendAction(url: string, type: string): Promise<{ ok?: boolean; message?: string; error?: string; translated?: number }> {
      const result = await worker.evaluate<{ ok?: boolean; message?: string; error?: string; translated?: number }>(
        `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((item) => item.url === ${JSON.stringify(url)});
          if (!tab?.id) return { ok: false, error: "找不到页面：" + tabs.map((item) => item.url).join(" | ") };
          try { return await chrome.tabs.sendMessage(tab.id, { type: ${JSON.stringify(type)} }); }
          catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
        })()`,
      );
      if (!result?.ok) throw new Error(`${type} 失败：${result?.error ?? "无返回"}`);
      return result;
    }

    await seed("en-zh");
    step("测试弹窗连接");
    await openTab(debugPort, `chrome-extension://${extensionId}/popup.html`);
    const popupTarget = await waitForTarget(
      debugPort,
      (target) => target.type === "page" && target.url.includes("/popup.html"),
      "弹窗",
    );
    const popup = await connect(popupTarget.webSocketDebuggerUrl);
    sessions.push(popup);
    const formState = await popup.evaluate<{ keyLength: number; model: string; active: boolean }>(`(async () => {
      for (let i = 0; i < 40; i += 1) {
        const key = document.querySelector("#apiKey");
        const baseUrl = document.querySelector("#baseUrl");
        if (key instanceof HTMLInputElement && baseUrl instanceof HTMLInputElement && key.value.length > 20 && baseUrl.value.includes("api.deepseek.com")) {
          const model = document.querySelector("#model");
          return {
            keyLength: key.value.length,
            model: model instanceof HTMLInputElement ? model.value : "",
            active: document.querySelector("[data-direction='en-zh']")?.classList.contains("active") ?? false,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("弹窗没有读到设置");
    })()`);
    assert(formState.keyLength > 20, "密钥没有填入弹窗");
    assert(formState.model === "deepseek-flash", formState.model);
    assert(formState.active, "默认方向不是英译中");
    await popup.evaluate(`document.querySelector("#test")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    const statusText = await popup.evaluate<string>(`(async () => {
      for (let i = 0; i < 80; i += 1) {
        const status = document.querySelector("#status");
        if (status && (status.classList.contains("ok") || status.classList.contains("error")) && status.textContent) return status.textContent;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return document.querySelector("#status")?.textContent ?? "";
    })()`);
    assert(statusText.includes("连接成功"), statusText);
    assert(statusText.toLowerCase().includes("deepseek"), statusText);

    step("整页英译中");
    const enUrl = `${origin}/en`;
    const en = await openFixture("/en");
    const before = await en.evaluate<{
      lead: string;
      second: string;
      button: string;
      title: string;
      alt: string;
      placeholder: string;
      href: string;
    }>(`({
      lead: document.querySelector("#lead")?.textContent ?? "",
      second: document.querySelector("#second")?.textContent ?? "",
      button: document.querySelector("#btn")?.textContent ?? "",
      title: document.querySelector("#btn")?.getAttribute("title") ?? "",
      alt: document.querySelector("#boat")?.getAttribute("alt") ?? "",
      placeholder: document.querySelector("#search")?.getAttribute("placeholder") ?? "",
      href: document.querySelector("#more")?.getAttribute("href") ?? "",
    })`);
    const translated = await sendAction(enUrl, "translate-page");
    assert((translated.translated ?? 0) >= 5, translated.message ?? "翻译数量不足");
    const after = await en.evaluate<{
      lead: string;
      button: string;
      title: string;
      alt: string;
      placeholder: string;
      href: string;
      code: string;
      script: string;
    }>(`({
      lead: document.querySelector("#lead")?.textContent ?? "",
      button: document.querySelector("#btn")?.textContent ?? "",
      title: document.querySelector("#btn")?.getAttribute("title") ?? "",
      alt: document.querySelector("#boat")?.getAttribute("alt") ?? "",
      placeholder: document.querySelector("#search")?.getAttribute("placeholder") ?? "",
      href: document.querySelector("#more")?.getAttribute("href") ?? "",
      code: document.querySelector("#code")?.textContent ?? "",
      script: document.querySelector("script")?.textContent ?? "",
    })`);
    assert(after.lead !== before.lead && hasChinese(after.lead), after.lead);
    assert(after.button.trim() !== before.button.trim() && hasChinese(after.button), after.button);
    assert(after.title !== before.title && hasChinese(after.title), after.title);
    assert(after.alt !== before.alt && hasChinese(after.alt), after.alt);
    assert(after.placeholder !== before.placeholder && hasChinese(after.placeholder), after.placeholder);
    assert(after.href === before.href, "链接被改写");
    assert(after.code.includes("DO_NOT_TRANSLATE_CODE"), "代码被翻译了");
    assert(after.script.includes("DO_NOT_TRANSLATE_THIS_TOKEN"), "脚本被翻译了");

    step("恢复原文");
    await sendAction(enUrl, "restore-page");
    const restored = await en.evaluate<{ lead: string; title: string; placeholder: string }>(`({
      lead: document.querySelector("#lead")?.textContent ?? "",
      title: document.querySelector("#btn")?.getAttribute("title") ?? "",
      placeholder: document.querySelector("#search")?.getAttribute("placeholder") ?? "",
    })`);
    assert(restored.lead === before.lead, restored.lead);
    assert(restored.title === before.title, restored.title);
    assert(restored.placeholder === before.placeholder, restored.placeholder);

    step("划词翻译");
    await en.evaluate(`(() => {
      const element = document.querySelector("#second");
      if (!element) throw new Error("缺少第二段");
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const rect = range.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left, clientY: rect.bottom }));
      return true;
    })()`);
    const selectionText = await en.evaluate<string>(`(async () => {
      for (let i = 0; i < 20; i += 1) {
        const button = document.querySelector("[data-moye-root]")?.shadowRoot?.querySelector(".moye-go");
        if (button instanceof HTMLButtonElement) {
          button.click();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      for (let i = 0; i < 80; i += 1) {
        const result = document.querySelector("[data-moye-root]")?.shadowRoot?.querySelector(".moye-result");
        const text = result?.textContent ?? "";
        if (text && text !== "正在翻译…" && /[\\u4e00-\\u9fff]/.test(text)) return text;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return document.querySelector("[data-moye-root]")?.shadowRoot?.innerHTML ?? "没有划词结果";
    })()`);
    assert(hasChinese(selectionText), selectionText);
    const second = await en.evaluate<string>(`document.querySelector("#second")?.textContent ?? ""`);
    assert(second === before.second, "划词不应改写原文");

    step("网页总结");
    await sendAction(enUrl, "summarize-page");
    const summaryText = await en.evaluate<string>(
      `document.querySelector("[data-moye-root]")?.shadowRoot?.querySelector(".summary")?.textContent ?? ""`,
    );
    assert(summaryText.trim().length > 20 && hasChinese(summaryText), summaryText);

    step("自动识别中英");
    await seed("auto");
    const auto = await openFixture("/auto");
    const autoBefore = await auto.evaluate<{ en: string; zh: string }>(`({
      en: document.querySelector("#en")?.textContent ?? "",
      zh: document.querySelector("#zh")?.textContent ?? "",
    })`);
    await sendAction(`${origin}/auto`, "translate-page");
    const autoAfter = await auto.evaluate<{ en: string; zh: string }>(`({
      en: document.querySelector("#en")?.textContent ?? "",
      zh: document.querySelector("#zh")?.textContent ?? "",
    })`);
    assert(autoAfter.en !== autoBefore.en && hasChinese(autoAfter.en), autoAfter.en);
    assert(autoAfter.zh !== autoBefore.zh && hasLatin(autoAfter.zh), autoAfter.zh);

    step("整页中译英");
    await seed("zh-en");
    const zh = await openFixture("/zh");
    const zhBefore = await zh.evaluate<string>(`document.querySelector("#lead")?.textContent ?? ""`);
    await sendAction(`${origin}/zh`, "translate-page");
    const zhLead = await zh.evaluate<string>(`document.querySelector("#lead")?.textContent ?? ""`);
    assert(zhLead !== zhBefore && hasLatin(zhLead) && !zhLead.includes("渔船回来"), zhLead);

    step("弹窗按钮可以触发翻译");
    await popup.evaluate(`document.querySelector("[data-direction='zh-en']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await popup.evaluate(`document.querySelector("#translate")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    const popupStatus = await popup.evaluate<string>(`(async () => {
      for (let i = 0; i < 80; i += 1) {
        const status = document.querySelector("#status");
        const text = status?.textContent ?? "";
        if (status && (status.classList.contains("ok") || status.classList.contains("error")) && text && !text.includes("正在翻译")) return text;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return document.querySelector("#status")?.textContent ?? "";
    })()`);
    assert(popupStatus.includes("已翻译") || popupStatus.includes("没有需要翻译"), popupStatus);
    step("全部通过");
  } finally {
    for (const session of sessions) session.close();
    if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    await delay(500);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
