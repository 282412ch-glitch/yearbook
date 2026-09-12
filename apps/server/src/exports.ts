import AdmZip from 'adm-zip';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { TaskItem } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';
import { renderYearbookHtml } from './yearbooks.js';
import { cancelTask, createTask, failTask, finishTask, getTask, retryTask, startTask, updateTask } from './tasks.js';

export type ExportFormat = 'html' | 'pdf';
const safeName = (value: string) => value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'yearbook';
type ExportRuntime = { controller: AbortController; promise: Promise<void> };
const activeExports = new WeakMap<DataStore, Map<string, ExportRuntime>>();
const pausedExports = new WeakSet<DataStore>();
function runningExports(store: DataStore) { let active = activeExports.get(store); if (!active) { active = new Map(); activeExports.set(store, active); } return active; }

function browserCandidates() {
  const configured = process.env.YEARBOOK_BROWSER?.trim();
  if (configured) return [configured];
  if (process.platform !== 'win32') return ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'];
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((value): value is string => !!value);
  return [
    'msedge.exe', 'chrome.exe', 'chromium.exe',
    ...roots.flatMap(root => [
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
    ]),
  ];
}

function runBrowser(browser: string, htmlPath: string, pdfPath: string, profileDir: string, signal: AbortSignal) {
  return new Promise<void>((resolvePromise, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileDir}`, `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    const abort = () => { child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', error => { signal.removeEventListener('abort', abort); reject(error); });
    child.once('exit', code => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else if (code === 0) resolvePromise(); else reject(new Error(`浏览器退出码 ${code ?? '未知'}`)); });
  });
}

async function findPdfBrowser(htmlPath: string, pdfPath: string, profileDir: string, signal: AbortSignal) {
  let lastError: unknown;
  for (const candidate of browserCandidates()) {
    if (signal.aborted) throw signal.reason;
    try { await runBrowser(candidate, htmlPath, pdfPath, profileDir, signal); await access(pdfPath); return candidate; }
    catch (error) { lastError = error; }
  }
  throw new AppError(409, 'PDF_BROWSER_UNAVAILABLE', `当前电脑没有可用于打印 PDF 的 Chromium 浏览器。HTML 已可离线阅读，请在浏览器中选择“打印为 PDF”${lastError instanceof Error ? `（${lastError.message}）` : ''}`);
}

async function executeExport(store: DataStore, taskId: string, yearbookId: string, format: ExportFormat, controller: AbortController) {
  let htmlPath: string | null = null;
  let outputPath: string | null = null;
  const profileDir = resolve(store.dataDir, 'tmp', `pdf-browser-${randomUUID()}`);
  const duration = await store.write(() => getTask(store, taskId).maxDurationMs);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(duration)]);
  const write = <T>(operation: () => T | Promise<T>) => store.write(() => {
    if (signal.aborted || pausedExports.has(store)) throw new AppError(409, 'EXPORT_STOPPED', '导出已中止，可在任务页重试');
    const task = getTask(store, taskId);
    if (task.status === 'cancelled' || task.cancelRequested) throw new AppError(409, 'EXPORT_STOPPED', '导出已取消');
    return operation();
  });
  try {
    await write(() => startTask(store, taskId, '正在读取年册内容'));
    const html = await write(() => renderYearbookHtml(store, yearbookId));
    await write(() => updateTask(store, taskId, { progress: 30, message: '正在生成离线资源' }));
    const book = await write(() => {
      const row = store.db.prepare('SELECT year, title FROM yearbooks WHERE id = ?').get(yearbookId) as { year: number; title: string } | undefined;
      if (!row) throw new AppError(404, 'NOT_FOUND', '这本年册不存在');
      return row;
    });
    const outputDir = join(store.dataDir, 'exports');
    await mkdir(outputDir, { recursive: true });
    const stem = `${book.year}-${safeName(book.title || '年册')}-${taskId}-${randomUUID().slice(0, 8)}`;
    htmlPath = join(outputDir, `${stem}.html`);
    await writeFile(htmlPath, html, { flag: 'wx' });
    if (format === 'html') {
      const zipPath = join(outputDir, `${stem}.zip`);
      outputPath = zipPath;
      const zip = new AdmZip();
      zip.addFile('index.html', Buffer.from(html, 'utf8'));
      zip.addFile('README.txt', Buffer.from('这是《一年一册》的离线年册。双击 index.html 即可在没有网络时阅读。\r\n', 'utf8'));
      await writeFile(zipPath, zip.toBuffer(), { flag: 'wx' });
      const finished = await write(() => finishTask(store, taskId, { format, filename: `${stem}.zip` }, `exports/${stem}.zip`, '离线 HTML 已完成'));
      if (finished.status !== 'completed') await rm(zipPath, { force: true }).catch(() => undefined);
      else outputPath = null;
      return;
    }
    await write(() => updateTask(store, taskId, { progress: 55, message: '正在调用本机浏览器打印 PDF' }));
    const pdfPath = join(outputDir, `${stem}.pdf`);
    outputPath = pdfPath;
    await findPdfBrowser(htmlPath, pdfPath, profileDir, signal);
    const finished = await write(() => finishTask(store, taskId, { format, filename: `${stem}.pdf` }, `exports/${stem}.pdf`, 'PDF 已完成'));
    if (finished.status !== 'completed') await rm(pdfPath, { force: true }).catch(() => undefined);
    else outputPath = null;
  } catch (error) {
    const message = signal.aborted ? '导出已取消、超时或因应用维护中止，可在任务页重试' : error instanceof AppError ? error.message : error instanceof Error ? error.message : '导出失败，请重试';
    await store.write(() => failTask(store, taskId, message));
  } finally {
    if (htmlPath) await rm(htmlPath, { force: true }).catch(() => undefined);
    if (outputPath) await rm(outputPath, { force: true }).catch(() => undefined);
    if (profileDir.startsWith(resolve(store.dataDir, 'tmp') + sep)) await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }
}

export function requestExport(store: DataStore, yearbookId: string, format: ExportFormat, idempotencyKey?: string | null): TaskItem {
  if (pausedExports.has(store)) throw new AppError(503, 'EXPORT_PAUSED', '资料维护进行中，请稍后导出');
  if (!store.db.prepare('SELECT id FROM yearbooks WHERE id = ? AND deleted_at IS NULL').get(yearbookId)) throw new AppError(404, 'NOT_FOUND', '这本年册不存在');
  const task = createTask(store, { kind: `yearbook-${format}`, yearbookId, idempotencyKey: idempotencyKey ?? null });
  resumeExport(store, task);
  return task;
}

export function resumeExport(store: DataStore, task: TaskItem) {
  if (task.status !== 'pending' || !task.yearbookId || !/^yearbook-(html|pdf)$/.test(task.kind)) return;
  const active = runningExports(store);
  if (pausedExports.has(store) || active.has(task.id)) return;
  const runtime: ExportRuntime = { controller: new AbortController(), promise: Promise.resolve() };
  active.set(task.id, runtime);
  const format = task.kind.slice('yearbook-'.length) as ExportFormat;
  runtime.promise = executeExport(store, task.id, task.yearbookId, format, runtime.controller).finally(() => active.delete(task.id));
  void runtime.promise.catch(() => undefined);
}

export async function cancelExport(store: DataStore, id: string) {
  const task = await store.write(() => cancelTask(store, id));
  const active = runningExports(store).get(id);
  active?.controller.abort();
  if (active) await active.promise;
  return task;
}
export async function retryExport(store: DataStore, id: string) {
  const active = runningExports(store).get(id); active?.controller.abort(); if (active) await active.promise;
  const task = await store.write(() => retryTask(store, id)); resumeExport(store, task); return task;
}
export async function pauseExports(store: DataStore) {
  pausedExports.add(store); const active = [...runningExports(store).values()];
  active.forEach(runtime => runtime.controller.abort()); await Promise.allSettled(active.map(runtime => runtime.promise));
}
export function resumeExports(store: DataStore) { pausedExports.delete(store); }

export async function readExport(store: DataStore, rawTaskId: string) {
  const task = getTask(store, rawTaskId);
  if (task.status !== 'completed' || !task.outputPath) throw new AppError(409, 'EXPORT_NOT_READY', '导出尚未完成，请稍后查看任务进度');
  const relative = task.outputPath.replace(/\\/g, '/');
  if (!/^exports\/[\p{L}\p{N}._-]+\.(zip|pdf)$/u.test(relative)) throw new AppError(400, 'EXPORT_PATH_INVALID', '导出文件路径无效');
  const path = resolve(store.dataDir, relative);
  if (!path.startsWith(resolve(store.dataDir, 'exports') + '\\') && !path.startsWith(resolve(store.dataDir, 'exports') + '/')) throw new AppError(400, 'EXPORT_PATH_INVALID', '导出文件路径越界');
  try { return { task, buffer: await readFile(path), filename: relative.slice(relative.lastIndexOf('/') + 1), mime: relative.endsWith('.pdf') ? 'application/pdf' : 'application/zip' }; }
  catch { throw new AppError(404, 'EXPORT_MISSING', '导出文件不存在，请重新导出'); }
}
