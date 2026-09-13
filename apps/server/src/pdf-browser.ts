import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors.js';

export type PdfPrintResult = { browser: string; bytes: number; loadedFonts: number; images: number };
type Progress = (progress: number, message: string) => Promise<unknown>;
type CdpResult = Record<string, any>;
type Pending = { resolve: (value: CdpResult) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> };

export function pdfBrowserCandidates() {
  const configured = process.env.YEARBOOK_BROWSER?.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (configured) return [configured];
  if (process.platform !== 'win32') return ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'];
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
  return [...new Set([
    ...roots.flatMap(root => [
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
    ]),
    'msedge.exe', 'chrome.exe', 'chromium.exe',
  ])];
}

/** A small CDP transport using Node 24's WebSocket; no browser automation package is needed. */
class DevTools {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private constructor(private socket: WebSocket, private signal: AbortSignal) {
    socket.addEventListener('message', event => {
      let response: CdpResult;
      try { response = JSON.parse(String(event.data)); } catch { this.rejectAll(new Error('浏览器返回了无法解析的数据')); return; }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(`浏览器打印接口出错：${String(response.error.message ?? '未知错误').slice(0, 180)}`));
      else pending.resolve(response.result ?? {});
    });
    socket.addEventListener('close', () => this.rejectAll(new Error('打印浏览器已关闭')));
    socket.addEventListener('error', () => this.rejectAll(new Error('无法连接打印浏览器')));
    signal.addEventListener('abort', this.onAbort, { once: true });
  }
  private onAbort = () => this.rejectAll(this.signal.reason);
  private rejectAll(reason: unknown) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
  }
  static async connect(url: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => finish(new Error('连接打印浏览器超时')), 10000);
      const onOpen = () => finish();
      const onError = () => finish(new Error('无法连接打印浏览器'));
      const onAbort = () => finish(signal.reason);
      function finish(error?: unknown) {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort);
        socket.removeEventListener('open', onOpen); socket.removeEventListener('error', onError);
        if (error) { socket.close(); reject(error); } else resolvePromise();
      }
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return new DevTools(socket, signal);
  }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResult> {
    this.signal.throwIfAborted();
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('打印浏览器连接已断开'));
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器打印操作超时，请在任务页重试')); }, 60000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  requestBrowserClose() {
    if (this.socket.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify({ id: ++this.nextId, method: 'Browser.close' })); } catch { /* The owned process is terminated below if necessary. */ }
    }
  }
  dispose() {
    this.signal.removeEventListener('abort', this.onAbort);
    this.rejectAll(new Error('打印会话已结束'));
    this.socket.close();
  }
}

type BrowserRuntime = { child: ChildProcess; stopped: Promise<void>; hasStopped: () => boolean; cdp?: DevTools; startupError: () => Error | undefined };

function launch(browser: string, profileDir: string): BrowserRuntime {
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--do-not-de-elevate',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--noerrdialogs',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let ended = false; let error: Error | undefined;
  const stopped = new Promise<void>(resolvePromise => {
    child.once('error', reason => { error = reason; ended = true; resolvePromise(); });
    child.once('exit', () => { ended = true; resolvePromise(); });
  });
  return { child, stopped, hasStopped: () => ended, startupError: () => error };
}

async function closeOwnedBrowser(runtime: BrowserRuntime) {
  runtime.cdp?.requestBrowserClose();
  if (!runtime.hasStopped()) await Promise.race([runtime.stopped, delay(1500)]);
  if (!runtime.hasStopped() && runtime.child.pid) {
    if (process.platform === 'win32') {
      // Only the PID created above and its descendants; never stop the user's open browser.
      const killer = spawn('taskkill.exe', ['/PID', String(runtime.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise<void>(resolvePromise => {
        const timer = setTimeout(() => { killer.kill(); resolvePromise(); }, 2000);
        const finish = () => { clearTimeout(timer); resolvePromise(); };
        killer.once('error', finish); killer.once('exit', finish);
      });
    } else runtime.child.kill('SIGKILL');
    if (!runtime.hasStopped()) await Promise.race([runtime.stopped, delay(2000)]);
  }
  runtime.cdp?.dispose();
}

async function devToolsAddress(runtime: BrowserRuntime, profileDir: string, signal: AbortSignal) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (runtime.hasStopped()) throw runtime.startupError() ?? new Error('浏览器在准备打印前退出');
    try {
      const [rawPort, endpoint] = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      const port = Number(rawPort);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(endpoint)) return `ws://127.0.0.1:${port}${endpoint}`;
    } catch { /* Chromium writes this file after its debugging socket is ready. */ }
    await delay(60, undefined, { signal });
  }
  throw new Error('打印浏览器启动超时');
}

async function readyDocument(cdp: DevTools, sessionId: string, htmlPath: string, signal: AbortSignal) {
  const url = pathToFileURL(resolve(htmlPath)).href;
  await cdp.command('Page.enable', {}, sessionId);
  await cdp.command('Network.enable', {}, sessionId);
  // The document is intentionally printable with network access disabled.
  await cdp.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  const navigation = await cdp.command('Page.navigate', { url }, sessionId);
  if (navigation.errorText) throw new AppError(409, 'PDF_DOCUMENT_FAILED', '打印浏览器无法打开本地年册文件');
  while (true) {
    signal.throwIfAborted();
    const ready = await cdp.command('Runtime.evaluate', { expression: `document.readyState === 'complete' && document.URL === ${JSON.stringify(url)}`, returnByValue: true }, sessionId);
    if (ready.result?.value === true) break;
    await delay(50, undefined, { signal });
  }
  const result = await cdp.command('Runtime.evaluate', {
    expression: `(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, image => image.decode()));
      const fonts = Array.from(document.fonts);
      if (fonts.some(font => font.status === 'error') || !fonts.some(font => font.status === 'loaded')) throw new Error('FONT_LOAD_FAILED');
      if (Array.from(document.images).some(image => !image.complete || image.naturalWidth === 0)) throw new Error('IMAGE_LOAD_FAILED');
      return { loadedFonts: fonts.filter(font => font.status === 'loaded').length, images: document.images.length };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails || !Number.isInteger(result.result?.value?.loadedFonts)) throw new AppError(409, 'PDF_ASSET_FAILED', '中文字体或照片未能完整载入，未生成 PDF，请重试');
  return result.result.value as { loadedFonts: number; images: number };
}

export async function validatePdfFile(path: string) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(8); const tail = Buffer.alloc(Math.min(1024, size));
    await file.read(header, 0, header.length, 0);
    await file.read(tail, 0, tail.length, Math.max(0, size - tail.length));
    if (size < 300 || !header.toString('ascii').startsWith('%PDF-') || !/%%EOF\s*$/.test(tail.toString('ascii'))) throw new AppError(409, 'PDF_INCOMPLETE', '浏览器没有生成完整的 PDF，请在任务页重试');
    return size;
  } finally { await file.close(); }
}

/** Print with an isolated Chromium profile, wait for real assets, then validate the complete PDF. */
export async function printYearbookPdf(htmlPath: string, pdfPath: string, profilesDir: string, signal: AbortSignal, progress: Progress = async () => undefined): Promise<PdfPrintResult> {
  let runtime: BrowserRuntime | undefined;
  let selected = '';
  const candidates = pdfBrowserCandidates();
  for (let index = 0; index < candidates.length; index++) {
    signal.throwIfAborted();
    const browser = candidates[index];
    if (browser.includes('/') || browser.includes('\\')) {
      try { await access(browser); } catch { continue; }
    }
    const profileDir = join(profilesDir, `browser-${index}`);
    await mkdir(profileDir, { recursive: true });
    runtime = launch(browser, profileDir);
    try {
      const url = await devToolsAddress(runtime, profileDir, signal);
      runtime.cdp = await DevTools.connect(url, signal);
      selected = browser;
      break;
    } catch {
      await closeOwnedBrowser(runtime); runtime = undefined;
      signal.throwIfAborted();
    }
  }
  if (!runtime?.cdp) throw new AppError(409, 'PDF_BROWSER_UNAVAILABLE', process.env.YEARBOOK_BROWSER
    ? 'YEARBOOK_BROWSER 指定的浏览器无法启动，请填写本机 Edge 或 Chrome 可执行文件的完整路径后重试。也可以先导出离线 HTML'
    : '没有找到可用于打印的 Edge 或 Chrome，请安装其中一种浏览器后重试。也可以先导出离线 HTML');
  try {
    const cdp = runtime.cdp;
    const target = await cdp.command('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId as string;
    await progress(66, '正在载入离线中文字体与照片');
    const assets = await readyDocument(cdp, sessionId, htmlPath, signal);
    await progress(78, '字体和照片已就绪，正在排版 A4 页面');
    const printed = await cdp.command('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, transferMode: 'ReturnAsStream', generateTaggedPDF: true, generateDocumentOutline: true }, sessionId);
    if (typeof printed.stream !== 'string') throw new AppError(409, 'PDF_RESPONSE_INVALID', '浏览器没有返回 PDF 数据，请在任务页重试');
    const file = await open(pdfPath, 'wx');
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await cdp.command('IO.read', { handle: printed.stream, size: 1024 * 1024 }, sessionId);
        if (typeof chunk.data !== 'string') throw new AppError(409, 'PDF_RESPONSE_INVALID', 'PDF 数据不完整，请在任务页重试');
        await file.writeFile(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
        if (chunk.eof) break;
      }
    } finally { await file.close(); }
    await cdp.command('IO.close', { handle: printed.stream }, sessionId);
    await progress(94, '正在检查 PDF 文件完整性');
    const bytes = await validatePdfFile(pdfPath);
    return { browser: basename(selected), bytes, ...assets };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof AppError) throw error;
    throw new AppError(409, 'PDF_PRINT_FAILED', error instanceof Error ? `PDF 打印失败：${error.message}` : 'PDF 打印失败，请在任务页重试');
  } finally { await closeOwnedBrowser(runtime); }
}
