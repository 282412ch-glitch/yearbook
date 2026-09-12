import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '../apps/server/src/db.js';
import { cancelExport, pauseExports, readExport, requestExport, retryExport } from '../apps/server/src/exports.js';
import { getTask, recoverInterruptedTasks } from '../apps/server/src/tasks.js';
import { saveYearbook } from '../apps/server/src/yearbooks.js';

describe('导出任务取消、重试与资料库生命周期', () => {
  let root: string; let store: DataStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'yearbook 导出生命周期 ')); store = new DataStore(join(root, '中文 空格')); });
  afterEach(async () => {
    await pauseExports(store); await store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('测试清理路径越界');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  function book() { return saveYearbook(store, { year: 2024, title: '生命周期验收', introBody: '取消后重试仍可离线阅读。' }); }
  async function completed(id: string) {
    for (let i = 0; i < 100; i++) {
      const task = await store.write(() => getTask(store, id));
      if (['completed', 'failed', 'cancelled'].includes(task.status)) { expect(task.status, task.errorMessage || task.message).toBe('completed'); return; }
      await new Promise(yes => setTimeout(yes, 10));
    }
    throw new Error('导出任务未结束');
  }
  function holdWrites() {
    let release!: () => void;
    const barrier = new Promise<void>(yes => { release = yes; });
    const settled = store.write(() => barrier);
    return { release, settled };
  }

  it('启动前取消后立即重试，仅保留一次成功导出且幂等键不产生重复任务', async () => {
    const saved = book(); const gate = holdWrites();
    const task = requestExport(store, saved.id, 'html', 'cancel-then-retry');
    const cancellation = cancelExport(store, task.id);
    gate.release(); await gate.settled; await cancellation;
    expect(getTask(store, task.id).status).toBe('cancelled');
    await retryExport(store, task.id); await completed(task.id);
    expect(requestExport(store, saved.id, 'html', 'cancel-then-retry').id).toBe(task.id);
    expect((await readdir(join(store.dataDir, 'exports'))).filter(name => name.endsWith('.zip'))).toHaveLength(1);
    const output = await readExport(store, task.id);
    expect(new AdmZip(output.buffer).readAsText('index.html')).toContain('取消后重试仍可离线阅读。');
  });

  it('维护暂停等待旧执行退出，关闭重开后可重试且没有旧任务写入已关闭数据库', async () => {
    const saved = book(); const gate = holdWrites();
    const task = requestExport(store, saved.id, 'html', 'pause-close-retry');
    const pausing = pauseExports(store);
    gate.release(); await gate.settled; await pausing;
    expect(getTask(store, task.id).status).toBe('failed');
    expect(await readdir(join(store.dataDir, 'exports'))).toHaveLength(0);
    const path = store.dataDir;
    await store.close(); store = new DataStore(path); recoverInterruptedTasks(store);
    await retryExport(store, task.id); await completed(task.id);
    expect((await readdir(join(store.dataDir, 'exports'))).filter(name => name.endsWith('.zip'))).toHaveLength(1);
  });
});
