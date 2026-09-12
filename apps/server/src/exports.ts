import AdmZip from 'adm-zip';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { TaskItem } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';
import { getYearbook } from './yearbooks.js';
import { captureYearbookRenderSnapshot, renderYearbookSnapshot } from './yearbook-template.js';
import { exportFontLicenses } from './export-fonts.js';
import { printYearbookPdf } from './pdf-browser.js';
import { cancelTask, createTask, failTask, finishTask, getTask, retryTask, startTask, updateTask } from './tasks.js';

export type ExportFormat = 'html' | 'pdf';
const safeName = (value: string) => value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'yearbook';
type ExportRuntime = { controller: AbortController; promise: Promise<void> };
const activeExports = new WeakMap<DataStore, Map<string, ExportRuntime>>();
const pausedExports = new WeakSet<DataStore>();
function runningExports(store: DataStore) { let active = activeExports.get(store); if (!active) { active = new Map(); activeExports.set(store, active); } return active; }

async function executeExport(store: DataStore, taskId: string, yearbookId: string, format: ExportFormat, controller: AbortController) {
  let htmlPath: string | null = null;
  let outputPath: string | null = null;
  const profileDir = resolve(store.dataDir, 'tmp', `pdf-browser-${randomUUID()}`);
  const duration = await store.write(() => getTask(store, taskId).maxDurationMs);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(duration)]);
  const write = <T>(operation: () => T | Promise<T>) => store.write(() => {
    if (signal.aborted || pausedExports.has(store)) throw new AppError(409, 'EXPORT_STOPPED', '导出已中止，可在任务页重试');
    const task = getTask(store, taskId);
    if (task.deletedAt || task.status === 'cancelled' || task.cancelRequested) throw new AppError(409, 'EXPORT_STOPPED', '导出已取消');
    return operation();
  });
  try {
    await write(() => startTask(store, taskId, '正在读取年册内容'));
    const snapshot = await write(() => captureYearbookRenderSnapshot(store, getYearbook(store, yearbookId)));
    const book = snapshot.book;
    await write(() => updateTask(store, taskId, { progress: 15, message: '正在整理照片与离线中文字体' }));
    // File I/O and font embedding do not hold the database write queue or block cancellation.
    const html = await renderYearbookSnapshot(snapshot, signal);
    await write(() => updateTask(store, taskId, { progress: 40, message: '离线资源已就绪' }));
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
      zip.addFile('README.txt', Buffer.from('这是《一年一册》的离线年册。\r\n解压后双击 index.html，在断网或应用关闭时也能阅读。照片、样式与中文字体均已嵌入该页面。\r\n可在 Edge 或 Chrome 中打印，纸张选择 A4，建议关闭浏览器页眉和页脚。\r\n“素材来源”可跳转至本页保留的记录或原始素材索引。字体许可证见 FONT-LICENSES.txt。\r\n', 'utf8'));
      zip.addFile('FONT-LICENSES.txt', Buffer.from(await exportFontLicenses(), 'utf8'));
      zip.addFile('manifest.json', Buffer.from(JSON.stringify({ formatVersion: 1, application: '一年一册', yearbookId: book.id, year: book.year, template: book.template, savedAt: book.updatedAt, exportedAt: new Date().toISOString(), sourceRecordIds: [...snapshot.records.keys()], mediaIds: [...snapshot.media.keys()], assets: 'embedded-in-index.html' }, null, 2), 'utf8'));
      await writeFile(zipPath, zip.toBuffer(), { flag: 'wx' });
      const finished = await write(() => finishTask(store, taskId, { format, filename: `${stem}.zip`, template: book.template, savedAt: book.updatedAt }, `exports/${stem}.zip`, '离线 HTML 已完成，包含照片与中文字体'));
      if (finished.status !== 'completed') await rm(zipPath, { force: true }).catch(() => undefined);
      else outputPath = null;
      return;
    }
    await write(() => updateTask(store, taskId, { progress: 55, message: '正在调用本机浏览器打印 PDF' }));
    const pdfPath = join(outputDir, `${stem}.pdf`);
    outputPath = pdfPath;
    const printed = await printYearbookPdf(htmlPath, pdfPath, profileDir, signal, (progress, message) => write(() => updateTask(store, taskId, { progress, message })));
    const finished = await write(() => finishTask(store, taskId, { format, filename: `${stem}.pdf`, template: book.template, savedAt: book.updatedAt, ...printed }, `exports/${stem}.pdf`, 'PDF 已完成，可按 A4 打印'));
    if (finished.status !== 'completed') await rm(pdfPath, { force: true }).catch(() => undefined);
    else outputPath = null;
  } catch (error) {
    const message = signal.aborted
      ? signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
        ? '导出超过最大执行时间，可减少照片后重试，或先导出离线 HTML'
        : '导出已取消或因应用维护中止，可在任务页重试'
      : error instanceof AppError ? error.message : error instanceof Error ? error.message : '导出失败，请重试';
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
  if (task.yearbookId !== yearbookId) throw new AppError(409, 'EXPORT_KEY_CONFLICT', '这个导出请求编号已用于另一本年册，请重新发起导出');
  resumeExport(store, task);
  return task;
}

export function resumeExport(store: DataStore, task: TaskItem) {
  if (task.deletedAt || task.status !== 'pending' || !task.yearbookId || !/^yearbook-(html|pdf)$/.test(task.kind)) return;
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
