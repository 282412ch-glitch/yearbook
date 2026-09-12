import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TaskItem, YearbookItem, YearbookList, YearbookVersion } from '@yearbook/shared';
import { createTestWorkspace, json, record, type TestWorkspace } from './helpers.js';

describe('年册结构、版本与离线导出', () => {
  let workspace: TestWorkspace;
  let app: FastifyInstance;
  beforeEach(async () => { workspace = await createTestWorkspace(); app = await workspace.open('年册 数据'); });
  afterEach(async () => { await workspace.dispose(); });

  it('按年份生成可编辑结构，保存章节/块/来源并保留版本', async () => {
    const source = await record(app, { title: '春天散步', body: '和家人在河边散步。', occurredOn: '2024-03-12', people: ['家人'], tags: ['春天'] });
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2024, title: '我们的 2024', template: 'text' }, 201);
    expect(book.chapters.some(chapter => chapter.kind === 'month')).toBe(true);
    const month = book.chapters.find(chapter => chapter.kind === 'month')!;
    expect(month.sourceRecordIds).toContain(source.id);
    const edited = await json<YearbookItem>(app, 'PUT', `/api/yearbooks/${book.id}`, {
      year: book.year, title: book.title, template: book.template, coverMediaId: null, introBody: '这一年从春天开始。',
      chapters: [{ id: month.id, kind: month.kind, title: '三月 · 河边', body: '保留原话。', sourceRecordIds: [source.id], blocks: [{ type: 'record', recordId: source.id, body: '', mediaId: null, caption: '原始记录' }] }],
    });
    expect(edited.introBody).toBe('这一年从春天开始。');
    expect(edited.chapters).toHaveLength(1);
    expect(edited.chapters[0].blocks[0].recordId).toBe(source.id);
    const versions = await json<YearbookVersion[]>(app, 'GET', `/api/yearbooks/${book.id}/versions`);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const old = await json<YearbookVersion>(app, 'GET', `/api/yearbooks/${book.id}/versions/${versions.at(-1)!.id}`);
    expect(old.snapshot.year).toBe(2024);
    await json(app, 'DELETE', `/api/yearbooks/${book.id}`);
    expect((await json<YearbookList>(app, 'GET', '/api/yearbooks')).total).toBe(0);
    await json(app, 'POST', `/api/yearbooks/${book.id}/restore`);
    expect((await json<YearbookItem>(app, 'GET', `/api/yearbooks/${book.id}`)).title).toBe(book.title);
  });

  it('生成离线 HTML ZIP，任务可查询且幂等键不重复创建', async () => {
    const source = await record(app, { body: '可以离线阅读的内容。', occurredOn: '2023-01-01' });
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2023, title: '离线测试' }, 201);
    const input = { format: 'html', idempotencyKey: 'offline-test-1' };
    const first = await json<TaskItem>(app, 'POST', `/api/yearbooks/${book.id}/export`, input, 202);
    const second = await json<TaskItem>(app, 'POST', `/api/yearbooks/${book.id}/export`, input, 202);
    expect(second.id).toBe(first.id);
    let task = first;
    for (let attempt = 0; attempt < 30 && !['completed', 'failed', 'cancelled'].includes(task.status); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      task = await json<TaskItem>(app, 'GET', `/api/tasks/${first.id}`);
    }
    expect(task.status).toBe('completed');
    expect(task.outputPath).toMatch(/^exports\/.*\.zip$/);
    const download = await app.inject({ method: 'GET', url: `/api/yearbooks/${book.id}/export/html?taskId=${first.id}` });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    expect(download.rawPayload.length).toBeGreaterThan(100);
    expect(source.id).toBeTruthy();
  });
});
