import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiDraftItem, AiTaskDetail, ModelProfile, TaskItem, TaskList, TaskStatus, YearbookItem } from '@yearbook/shared';
import { DataStore } from '../apps/server/src/db.js';
import { createTask, failTask, finishTask, getTask, listTasks, restoreTask, retryTask, startTask, trashTask, updateTask } from '../apps/server/src/tasks.js';
import { saveYearbook } from '../apps/server/src/yearbooks.js';
import { backup, createTestWorkspace, json, record, restore, type TestWorkspace } from './helpers.js';
import { startMockModel } from './mock-model.js';

describe('任务回收站状态与请求去重', () => {
  let workspace: TestWorkspace; let store: DataStore;
  beforeEach(async () => { workspace = await createTestWorkspace(); store = new DataStore(join(workspace.root, '任务 资料')); });
  afterEach(async () => { await store.close(); await workspace.dispose(); });

  it.each<TaskStatus>(['pending', 'running', 'completed', 'failed', 'cancelled'])('%s 任务可移入并恢复，保留进度与结果且不会自动执行', status => {
    const task = createTask(store, { kind: 'test-task' });
    const saved = updateTask(store, task.id, { status, progress: 45, result: { savedStage: '三月' }, toolCalls: 2, errorMessage: status === 'failed' ? '测试失败原因' : null });
    const trashed = trashTask(store, task.id);
    const active = status === 'pending' || status === 'running';
    expect(trashed).toMatchObject({ status: active ? 'cancelled' : status, progress: 45, result: saved.result, toolCalls: 2, errorMessage: saved.errorMessage, deletedAt: expect.any(String) });
    if (active) expect(trashed.cancelRequested).toBe(true);
    expect(trashTask(store, task.id)).toEqual(trashed);
    expect(listTasks(store).total).toBe(0);
    expect(listTasks(store, { deleted: 'true' }).items).toEqual([trashed]);
    expect(() => retryTask(store, task.id)).toThrow('请先恢复');
    expect(() => startTask(store, task.id)).toThrow('请先恢复');
    expect(finishTask(store, task.id, { late: true }, null)).toEqual(trashed);
    expect(failTask(store, task.id, '迟到错误')).toEqual(trashed);
    const revived = restoreTask(store, task.id);
    expect(revived).toEqual({ ...trashed, deletedAt: null, updatedAt: revived.updatedAt });
    expect(restoreTask(store, task.id)).toEqual(revived);
    expect(listTasks(store).items).toEqual([revived]);
    expect(listTasks(store, { deleted: 'true' }).total).toBe(0);
  });

  it('移入后同一请求键可创建新任务，恢复旧任务不与新任务冲突', () => {
    const input = { kind: 'test-task', idempotencyKey: 'task-submit-1' };
    const original = createTask(store, input);
    expect(createTask(store, input).id).toBe(original.id);
    trashTask(store, original.id);
    const next = createTask(store, input);
    expect(next.id).not.toBe(original.id);
    restoreTask(store, original.id);
    expect(createTask(store, input).id).toBe(next.id);
    expect(getTask(store, original.id).status).toBe('cancelled');
    expect(listTasks(store).total).toBe(2);
  });

  it('状态、年册、分页及总数始终限定在选中的任务列表内', () => {
    const book = saveYearbook(store, { year: 2024, title: '任务筛选测试' });
    const tasks = Array.from({ length: 4 }, (_, index) => {
      const task = createTask(store, { kind: 'test-task', yearbookId: index < 3 ? book.id : null });
      return updateTask(store, task.id, { status: index === 0 ? 'completed' : 'failed' });
    });
    for (const task of tasks.slice(1)) trashTask(store, task.id);
    expect(listTasks(store, { yearbookId: book.id }).items.map(task => task.id)).toEqual([tasks[0].id]);
    const page = listTasks(store, { deleted: 'true', yearbookId: book.id, status: 'failed', limit: '1', offset: '1' });
    expect(page.total).toBe(2); expect(page.items).toHaveLength(1);
    expect(page.items[0].yearbookId).toBe(book.id);
    expect(listTasks(store, { deleted: 'true', status: 'completed' }).total).toBe(0);
  });
});

describe('任务回收站 HTTP、运行中止与持久保存', () => {
  let workspace: TestWorkspace; let app: FastifyInstance; let mock: Awaited<ReturnType<typeof startMockModel>>;
  beforeEach(async () => { workspace = await createTestWorkspace(); app = await workspace.open('HTTP 任务'); mock = await startMockModel(); });
  afterEach(async () => { await workspace.dispose(); await mock.close(); });
  const profile = (model: string) => json<ModelProfile>(app, 'POST', '/api/model-profiles', { name: `本机测试 ${model}`, protocol: 'responses', baseUrl: mock.url, model, timeoutMs: 60000, credentialMode: 'none' }, 201);
  async function settled(id: string) {
    let task = await json<TaskItem>(app, 'GET', `/api/tasks/${id}`);
    await expect.poll(async () => {
      task = await json<TaskItem>(app, 'GET', `/api/tasks/${id}`);
      return task.status;
    }, { timeout: 5000 }).not.toMatch(/^(pending|running)$/);
    return task;
  }

  it('移入排队任务不影响正在执行的任务；运行任务移入后停止，恢复不会自动发出请求', async () => {
    const slow = await profile('timeout'); const fast = await profile('mock-all'); const source = await record(app);
    const running = await json<TaskItem>(app, 'POST', '/api/ai/tasks', { kind: 'polish', profileId: slow.id, recordIds: [source.id] }, 202);
    await expect.poll(() => mock.requests.filter(request => request.body.model === 'timeout').length).toBe(1);
    const queued = await json<TaskItem>(app, 'POST', '/api/ai/tasks', { kind: 'polish', profileId: fast.id, recordIds: [source.id] }, 202);
    expect((await json<TaskItem>(app, 'GET', `/api/tasks/${queued.id}`)).status).toBe('pending');
    expect(await json<TaskItem>(app, 'DELETE', `/api/tasks/${queued.id}`)).toMatchObject({ status: 'cancelled', deletedAt: expect.any(String), cancelRequested: true });
    expect((await json<TaskItem>(app, 'GET', `/api/tasks/${running.id}`)).status).toBe('running');
    const trashed = await json<TaskItem>(app, 'DELETE', `/api/tasks/${running.id}`);
    expect(trashed).toMatchObject({ status: 'cancelled', deletedAt: expect.any(String), cancelRequested: true });
    const denied = await json<{ error: { code: string } }>(app, 'POST', `/api/tasks/${running.id}/retry`, undefined, 409);
    expect(denied.error.code).toBe('TASK_IN_TRASH');
    expect((await json<TaskList>(app, 'GET', '/api/tasks')).total).toBe(0);
    expect((await json<TaskList>(app, 'GET', '/api/tasks?deleted=true')).total).toBe(2);
    const revived = await json<TaskItem>(app, 'POST', `/api/tasks/${queued.id}/restore`);
    expect(revived).toMatchObject({ status: 'cancelled', deletedAt: null });
    expect(mock.requests.filter(request => request.body.model === 'mock-all')).toHaveLength(0);
    await json(app, 'POST', `/api/tasks/${queued.id}/retry`);
    expect((await settled(queued.id)).status).toBe('completed');
    expect((await json<TaskItem>(app, 'GET', `/api/tasks/${running.id}`)).deletedAt).toBe(trashed.deletedAt);
    expect(mock.requests.filter(request => request.body.model === 'timeout')).toHaveLength(1);
  });

  it('完成和失败任务移入后保留草稿、阶段及导出文件，重启和备份恢复保留回收站', async () => {
    const valid = await profile('mock-all'); const invalid = await profile('malformed'); const source = await record(app);
    const generated = await json<TaskItem>(app, 'POST', '/api/ai/tasks', { kind: 'polish', profileId: valid.id, recordIds: [source.id] }, 202);
    expect((await settled(generated.id)).status).toBe('completed');
    const detail = await json<AiTaskDetail>(app, 'GET', `/api/ai/tasks/${generated.id}`);
    const draftId = (detail.task.result as { draftId: string }).draftId;
    const draft = await json<AiDraftItem>(app, 'GET', `/api/ai/drafts/${draftId}`);
    const failure = await json<TaskItem>(app, 'POST', '/api/ai/tasks', { kind: 'polish', profileId: invalid.id, recordIds: [source.id] }, 202);
    expect((await settled(failure.id)).status).toBe('failed');
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2024, title: '保留导出' }, 201);
    const exported = await json<TaskItem>(app, 'POST', `/api/yearbooks/${book.id}/export`, { format: 'html' }, 202);
    expect((await settled(exported.id)).status).toBe('completed');
    const downloadUrl = `/api/yearbooks/${book.id}/export/html?taskId=${exported.id}`;
    const originalDownload = await app.inject({ method: 'GET', url: downloadUrl });
    for (const task of [generated, failure, exported]) {
      const before = await json<TaskItem>(app, 'GET', `/api/tasks/${task.id}`);
      const trashed = await json<TaskItem>(app, 'DELETE', `/api/tasks/${task.id}`);
      expect(trashed).toEqual({ ...before, deletedAt: trashed.deletedAt, updatedAt: trashed.updatedAt });
      expect(await json(app, 'DELETE', `/api/tasks/${task.id}`)).toEqual(trashed);
    }
    expect((await json<TaskList>(app, 'GET', '/api/tasks')).total).toBe(0);
    expect((await json<AiTaskDetail>(app, 'GET', `/api/ai/tasks/${generated.id}`)).stages).toEqual(detail.stages);
    expect(await json<AiDraftItem>(app, 'GET', `/api/ai/drafts/${draftId}`)).toEqual(draft);
    expect((await app.inject({ method: 'GET', url: downloadUrl })).rawPayload).toEqual(originalDownload.rawPayload);
    const snapshot = await backup(app);
    const target = await workspace.open('恢复 任务'); await restore(target, snapshot.buffer);
    expect((await json<TaskList>(target, 'GET', '/api/tasks?deleted=true')).total).toBe(3);
    expect(await json<AiDraftItem>(target, 'GET', `/api/ai/drafts/${draftId}`)).toEqual(draft);
    await app.close(); app = await workspace.open('HTTP 任务');
    expect((await json<TaskList>(app, 'GET', '/api/tasks?deleted=true')).total).toBe(3);
    expect((await json<TaskItem>(app, 'POST', `/api/tasks/${generated.id}/restore`)).deletedAt).toBeNull();
    expect((await json<TaskList>(app, 'GET', '/api/tasks')).items.map(task => task.id)).toEqual([generated.id]);
    await json(app, 'DELETE', `/api/tasks/${randomUUID()}`, undefined, 404);
    await json(app, 'POST', `/api/tasks/${randomUUID()}/restore`, undefined, 404);
    await json(app, 'GET', '/api/tasks?deleted=invalid', undefined, 400);
  });
});
