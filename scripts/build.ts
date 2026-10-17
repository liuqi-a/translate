import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

/** 计算 PNG 块需要的 CRC32。 */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG 数据块。 */
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

/** 判断像素是否落在圆角矩形内。 */
function insideRoundRect(x: number, y: number, size: number, radius: number): boolean {
  const max = size - 1;
  if (x < 0 || y < 0 || x > max || y > max) return false;
  const dx = x < radius ? radius - x : x > max - radius ? x - (max - radius) : 0;
  const dy = y < radius ? radius - y : y > max - radius ? y - (max - radius) : 0;
  return dx * dx + dy * dy <= radius * radius;
}

/** 判断像素是否属于图标里的两道文字线。 */
function isMark(x: number, y: number, size: number): boolean {
  const margin = size * 0.28;
  const barHeight = Math.max(2, size * 0.08);
  const top = size * 0.34;
  const gap = size * 0.12;
  const first = y >= top && y < top + barHeight && x >= margin && x <= size - margin;
  const second = y >= top + barHeight + gap && y < top + barHeight * 2 + gap && x >= margin && x <= size * 0.68;
  return first || second;
}

/** 画一张朱印风格的扩展图标。 */
function createIcon(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.22);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!insideRoundRect(x, y, size, radius)) continue;
      const index = (y * size + x) * 4;
      const mark = isMark(x, y, size);
      pixels[index] = mark ? 255 : 163;
      pixels[index + 1] = mark ? 248 : 59;
      pixels[index + 2] = mark ? 242 : 50;
      pixels[index + 3] = 255;
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 找到本机可执行的 esbuild。 */
function findEsbuild(): string {
  const local = resolve(root, "node_modules", "esbuild", "bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
  if (existsSync(local)) return local;
  const cache = resolve(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx");
  const found: string[] = [];
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      const candidate = join(cache, entry, "node_modules", "@esbuild", "win32-x64", "esbuild.exe");
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  if (found.length === 0) throw new Error("找不到 esbuild，请先运行 npm install");
  return found.sort().at(-1) ?? found[0];
}

/** 用 esbuild 打包一份入口脚本。 */
function bundleEntry(entry: string, outfile: string, format: "esm" | "iife"): void {
  const result = spawnSync(
    findEsbuild(),
    [entry, `--outfile=${outfile}`, "--bundle", `--format=${format}`, "--platform=browser", "--target=chrome120", "--legal-comments=none"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`打包失败：${entry}`);
}

/** 把三份入口脚本打包进 dist。 */
function bundleScripts(): void {
  bundleEntry(resolve(root, "src/background/serviceWorker.ts"), resolve(dist, "background.js"), "esm");
  bundleEntry(resolve(root, "src/content/content.ts"), resolve(dist, "content.js"), "iife");
  bundleEntry(resolve(root, "src/popup/popup.ts"), resolve(dist, "popup.js"), "iife");
}

/** 清空并生成可加载的扩展目录。 */
async function main(): Promise<void> {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(resolve(dist, "icons"), { recursive: true });
  writeFileSync(resolve(dist, "manifest.json"), readFileSync(resolve(root, "public/manifest.json")));
  writeFileSync(resolve(dist, "popup.html"), readFileSync(resolve(root, "src/popup/popup.html")));
  writeFileSync(resolve(dist, "popup.css"), readFileSync(resolve(root, "src/popup/popup.css")));
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(resolve(dist, "icons", `icon${size}.png`), createIcon(size));
  }
  bundleScripts();
}

await main();
