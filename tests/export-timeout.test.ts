import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataStore } from '../apps/server/src/db.js';
import { pauseExports, resumeExport, resumeExports, retryExport } from '../apps/server/src/exports.js';
import { createTask, getTask } from '../apps/server/src/tasks.js';
import { saveYearbook } from '../apps/server/src/yearbooks.js';

const printing = vi.hoisted(() => ({ mode: 'hang' as 'hang' | 'fail' }));
vi.mock('../apps/server/src/pdf-browser.js', async importOriginal => {
  const original = await importOriginal<typeof import('../apps/server/src/pdf-browser.js')>();
  return { ...original, printYearbookPdf: async (_html: string, pdf: string, _profile: string, signal: AbortSignal) => {
    if (printing.mode === 'fail') throw new Error('模拟浏览器再次启动失败');
    await writeFile(pdf, '%PDF-incomplete-test-output');
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } };
});

describe('导出任务的执行时限', () => {
  let root: string; let store: DataStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'yearbook 导出超时 ')); store = new DataStore(join(root, '独立 数据')); printing.mode = 'hang'; });
  afterEach(async () => {
    await pauseExports(store); await store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('测试清理路径越界');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  async function settled(id: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const task = await store.write(() => getTask(store, id));
      if (['failed', 'completed', 'cancelled'].includes(task.status)) return task;
      await new Promise(yes => setTimeout(yes, 20));
    }
    throw new Error('超时任务未退出');
  }

  it('无响应的打印阶段会超时并清理不完整文件，重试不会卡在旧执行中', async () => {
    const book = saveYearbook(store, { year: 2024, title: '有界导出', chapters: [] });
    const task = createTask(store, { kind: 'yearbook-pdf', yearbookId: book.id, maxDurationMs: 1000 });
    resumeExport(store, task);
    const timedOut = await settled(task.id);
    expect(timedOut.status).toBe('failed'); expect(timedOut.errorMessage).toContain('超过最大执行时间');
    expect(timedOut.outputPath).toBeNull();
    await pauseExports(store);
    expect(await readdir(join(store.dataDir, 'exports'))).toEqual([]);
    printing.mode = 'fail'; resumeExports(store);
    await retryExport(store, task.id);
    const retried = await settled(task.id);
    expect(retried.status).toBe('failed'); expect(retried.attempts).toBe(2);
    expect(retried.errorMessage).toContain('再次启动失败');
    expect(retried.errorMessage).not.toContain('超过最大执行时间');
  });
});
