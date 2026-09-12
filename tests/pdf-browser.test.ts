import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataStore } from '../apps/server/src/db.js';
import { pauseExports, readExport, requestExport, retryExport } from '../apps/server/src/exports.js';
import { pdfBrowserCandidates, printYearbookPdf, validatePdfFile } from '../apps/server/src/pdf-browser.js';
import { getTask } from '../apps/server/src/tasks.js';
import { renderYearbookHtml, saveYearbook } from '../apps/server/src/yearbooks.js';
import { exportLayoutFixture } from './export-layout-fixture.js';

// Real printing is exercised whenever Edge/Chrome is installed; missing-browser behavior always runs.
const browser = pdfBrowserCandidates().find(candidate => existsSync(candidate));
const edge = process.platform === 'win32' ? join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '';

describe('本机浏览器实际打印及失败恢复', () => {
  let root: string; let store: DataStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'yearbook PDF 中文 ')); store = new DataStore(join(root, '独立 数据')); });
  afterEach(async () => {
    await pauseExports(store); await store.close(); vi.unstubAllEnvs();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('测试清理路径越界');
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  async function settled(id: string) {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      const task = await store.write(() => getTask(store, id));
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
      await new Promise(yes => setTimeout(yes, 40));
    }
    throw new Error('打印任务未结束');
  }

  it.runIf(Boolean(browser))('实际生成两种模板的 A4 PDF，嵌入中文字体、照片并完整结束', async () => {
    vi.stubEnv('YEARBOOK_BROWSER', browser!);
    const fixture = await exportLayoutFixture(store);
    const pdfs = [];
    for (const book of [fixture.photoBook, fixture.textBook]) {
      const submitted = requestExport(store, book.id, 'pdf');
      const task = await settled(submitted.id);
      expect(task.status, task.errorMessage ?? task.message).toBe('completed');
      const result = task.result as { loadedFonts: number; images: number; bytes: number; savedAt: string };
      expect(result.loadedFonts).toBeGreaterThan(0); expect(result.images).toBe(6); expect(result.savedAt).toBe(book.updatedAt);
      const output = await readExport(store, task.id);
      expect(output.mime).toBe('application/pdf'); expect(output.buffer.length).toBe(result.bytes);
      const pdf = output.buffer.toString('latin1');
      expect(pdf.startsWith('%PDF-')).toBe(true); expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(pdf).toContain('/ToUnicode'); expect(pdf).toMatch(/\/FontFile[23]\b/);
      expect(pdf).toContain('/Subtype /Image');
      const boxes = [...pdf.matchAll(/\/MediaBox\s*\[0\s+0\s+([\d.]+)\s+([\d.]+)\]/g)];
      expect(boxes.length).toBeGreaterThan(2);
      for (const box of boxes) { expect(Number(box[1])).toBeCloseTo(595, 0); expect(Number(box[2])).toBeCloseTo(842, 0); }
      pdfs.push(output.buffer);
    }
    expect(pdfs[0].equals(pdfs[1])).toBe(false);
    await pauseExports(store);
    expect(await readdir(join(store.dataDir, 'tmp'))).toEqual([]);
  }, 45000);

  it('错误浏览器路径给出明确原因，核心离线 HTML 仍能导出', async () => {
    vi.stubEnv('YEARBOOK_BROWSER', join(root, '不存在的 浏览器.exe'));
    const book = saveYearbook(store, { year: 2024, title: '无浏览器也能保存', chapters: [] });
    const submitted = requestExport(store, book.id, 'pdf');
    const failed = await settled(submitted.id);
    expect(failed.status).toBe('failed'); expect(failed.errorMessage).toContain('YEARBOOK_BROWSER'); expect(failed.outputPath).toBeNull();
    const html = requestExport(store, book.id, 'html');
    expect((await settled(html.id)).status).toBe('completed');
    if (browser) {
      vi.stubEnv('YEARBOOK_BROWSER', browser);
      await retryExport(store, submitted.id);
      const retried = await settled(submitted.id);
      expect(retried.status, retried.errorMessage ?? retried.message).toBe('completed');
      expect(retried.attempts).toBe(2);
      expect((await readdir(join(store.dataDir, 'exports'))).filter(name => name.endsWith('.pdf'))).toHaveLength(1);
    }
  }, 45000);

  it.runIf(Boolean(edge && existsSync(edge)))('Windows Edge 完整路径支持中文和空格路径，取消后能关闭本次独立浏览器', async () => {
    vi.stubEnv('YEARBOOK_BROWSER', edge);
    const book = saveYearbook(store, { year: 2024, title: 'Edge 字体打印', introBody: '中文与空格路径可离线打印。' });
    const htmlPath = join(root, '打印 年册.html'); await writeFile(htmlPath, await renderYearbookHtml(store, book.id));
    const controller = new AbortController(); let ready = false;
    await expect(printYearbookPdf(htmlPath, join(root, '取消.pdf'), join(root, '取消打印 profile'), controller.signal, async progress => {
      if (progress === 66) { ready = true; controller.abort(new Error('用户取消打印')); }
    })).rejects.toThrow('用户取消打印');
    expect(ready).toBe(true);
    const successful = requestExport(store, book.id, 'pdf');
    const task = await settled(successful.id);
    expect(task.status, task.errorMessage ?? task.message).toBe('completed');
    expect((task.result as { browser: string }).browser).toBe('msedge.exe');
    await pauseExports(store);
    expect(await readdir(join(store.dataDir, 'tmp'))).toEqual([]);
  }, 45000);

  it('截断或伪装的 PDF 不能通过完整性校验', async () => {
    const invalid = join(root, 'broken.pdf');
    await writeFile(invalid, '%PDF-1.7\n' + 'x'.repeat(1000));
    await expect(validatePdfFile(invalid)).rejects.toThrow('完整');
    await writeFile(invalid, '<html>failed</html>\n%%EOF');
    await expect(validatePdfFile(invalid)).rejects.toThrow('完整');
  });
});
