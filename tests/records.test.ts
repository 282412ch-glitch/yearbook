import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, AppStats, CalendarData, Metadata, RecordItem, RecordList } from '@yearbook/shared';
import { createTestWorkspace, json, record, recordInput, type TestWorkspace } from './helpers.js';

describe('真实 SQLite 记录、检索和回顾接口', () => {
  let workspace: TestWorkspace;
  let app: FastifyInstance;
  beforeEach(async () => { workspace = await createTestWorkspace(); app = await workspace.open(); });
  afterEach(async () => { await workspace.dispose(); });

  it('补记往年和日期未定的记录，按发生日期排序并在重启后保持完整', async () => {
    const recent = await record(app, { title: '秋日', body: '在公园和妈妈散步。', occurredOn: '2025-09-12', people: ['妈妈', '妈妈'], tags: ['散步'], location: '北京', includeInYearbook: false });
    const old = await record(app, { body: '补记闰日的早餐。', occurredOn: '2024-02-29' });
    const undated = await record(app, { body: '日期还没想起来的一小段回忆。', occurredOn: null });
    const withReflection = await json<RecordItem>(app, 'POST', `/api/records/${old.id}/reflections`, { body: '现在回头看，还记得那一阵饭香。' });
    expect(withReflection.reflections).toHaveLength(1);
    expect(withReflection.reflections[0]).toMatchObject({ body: '现在回头看，还记得那一阵饭香。' });
    expect(withReflection.reflections[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(recent.people).toEqual(['妈妈']);
    expect(recent.createdAt.slice(0, 10)).not.toBe(recent.occurredOn);
    await app.close();
    app = await workspace.open();
    expect(await json<RecordItem>(app, 'GET', `/api/records/${old.id}`)).toEqual(withReflection);
    expect(await json<RecordItem>(app, 'GET', `/api/records/${recent.id}`)).toEqual(recent);
    const listing = await json<RecordList>(app, 'GET', '/api/records');
    expect(listing.total).toBe(3);
    expect(listing.items.map(item => item.id)).toEqual([recent.id, old.id, undated.id]);
    const calendar = await json<CalendarData>(app, 'GET', '/api/calendar?month=2024-02');
    expect(calendar).toEqual({ month: '2024-02', days: [{ date: '2024-02-29', count: 1 }], undated: 1 });
    expect(await json<CalendarData>(app, 'GET', '/api/calendar?month=2023-01')).toEqual({ month: '2023-01', days: [], undated: 1 });
  });

  it('中文关键词、人物、标签、年份和月份共同筛选，结果能够打开原记录', async () => {
    const wanted = await record(app, { title: '第一次独自烤面包', body: '和爸爸做了全麦面包，等发酵时一起下棋。', occurredOn: '2024-02-29', people: ['爸爸'], tags: ['家人', '烘焙'], location: '上海家中', isFirst: true });
    await record(app, { title: '二月面包', body: '外面买了全麦面包。', occurredOn: '2025-02-02', people: ['同事'], tags: ['早餐'] });
    await record(app, { body: '和爸爸下棋。', occurredOn: '2024-03-01', people: ['爸爸'], tags: ['家人'] });
    await json(app, 'POST', `/api/records/${wanted.id}/reflections`, { body: '现在也记得窗台上的茉莉花。' });
    const query = new URLSearchParams({ q: '全麦', year: '2024', month: '2', person: '爸爸', tag: '家人', first: 'true' });
    const result = await json<RecordList>(app, 'GET', `/api/records?${query}`);
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe(wanted.id);
    expect((await json<RecordItem>(app, 'GET', `/api/records/${result.items[0].id}`)).body).toBe(wanted.body);
    for (const word of ['上海', '烘焙', '茉莉花']) {
      expect((await json<RecordList>(app, 'GET', `/api/records?q=${encodeURIComponent(word)}`)).items.map(item => item.id)).toEqual([wanted.id]);
    }
    expect(await json<RecordList>(app, 'GET', `/api/records?q=${encodeURIComponent('未出现的句子')}`)).toEqual({ items: [], total: 0 });
    const meta = await json<Metadata>(app, 'GET', '/api/meta');
    expect(meta.years).toEqual([2025, 2024]);
    expect(meta.people).toEqual(expect.arrayContaining(['爸爸', '同事']));
    expect(meta.tags).toEqual(expect.arrayContaining(['家人', '烘焙', '早餐']));
  });

  it('把百分号、下划线和引号当作关键词，不扩大匹配或改变查询', async () => {
    const literal = await record(app, { body: "进度 100%，文件名 春_天，路径 C:\\照片，原话 '很好'。" });
    await record(app, { body: '普通日子也可以记一笔。' });
    for (const word of ['100%', '春_天', 'C:\\照片', "'很好'"]) {
      const result = await json<RecordList>(app, 'GET', `/api/records?q=${encodeURIComponent(word)}`);
      expect(result.items.map(item => item.id)).toEqual([literal.id]);
    }
    expect((await json<RecordList>(app, 'GET', `/api/records?q=${encodeURIComponent("' OR 1=1 --")}`)).total).toBe(0);
    expect((await json<RecordList>(app, 'GET', '/api/records?limit=1&offset=1')).items).toHaveLength(1);
    expect((await json<RecordList>(app, 'GET', '/api/records?limit=1&offset=1')).total).toBe(2);
  });

  it('软删除隐藏普通回顾和第一次视图，恢复后保留正文、人物和补记', async () => {
    const original = await record(app, { body: '第一次看海。', occurredOn: '2020-08-08', people: ['姐姐'], tags: ['旅行'], isFirst: true });
    const reflected = await json<RecordItem>(app, 'POST', `/api/records/${original.id}/reflections`, { body: '鞋里都是沙子。' });
    const deleted = await json<RecordItem>(app, 'DELETE', `/api/records/${original.id}`);
    expect(deleted.deletedAt).toBeTruthy();
    expect((await json<RecordList>(app, 'GET', '/api/records')).total).toBe(0);
    expect((await json<RecordList>(app, 'GET', '/api/records?first=true')).total).toBe(0);
    expect((await json<RecordList>(app, 'GET', '/api/records?deleted=true')).items.map(item => item.id)).toEqual([original.id]);
    expect((await json<CalendarData>(app, 'GET', '/api/calendar?month=2020-08')).days).toEqual([]);
    expect(await json(app, 'GET', '/api/memories?count=3')).toEqual({ items: [] });
    expect(await json<Metadata>(app, 'GET', '/api/meta')).toEqual({ people: [], tags: [], years: [] });
    const rejected = await json<ApiError>(app, 'PUT', `/api/records/${original.id}`, recordInput(original, { body: '不可直接编辑垃圾箱记录' }), 409);
    expect(rejected.error.code).toBe('RECORD_DELETED');
    await json(app, 'POST', `/api/records/${original.id}/reflections`, { body: '也不可追加' }, 409);
    const restored = await json<RecordItem>(app, 'POST', `/api/records/${original.id}/restore`);
    expect(restored).toMatchObject({ id: reflected.id, body: reflected.body, occurredOn: '2020-08-08', people: ['姐姐'], tags: ['旅行'], isFirst: true, reflections: reflected.reflections, deletedAt: null });
    expect((await json<RecordList>(app, 'GET', '/api/records?first=true')).items.map(item => item.id)).toEqual([original.id]);
    expect(await json<AppStats>(app, 'GET', '/api/stats')).toMatchObject({ records: 1, firsts: 1, photos: 0, years: [2020] });
    const edited = await json<RecordItem>(app, 'PUT', `/api/records/${original.id}`, recordInput(restored, { isFirst: false, occurredOn: null }));
    expect(edited.isFirst).toBe(false);
    expect(edited.occurredOn).toBeNull();
    expect((await json<RecordList>(app, 'GET', '/api/records?first=true')).total).toBe(0);
  });

  it('盲盒在零条、一条和多条素材下正常工作，避免短时间重复并不返回已删除记录', async () => {
    expect(await json(app, 'GET', '/api/memories')).toEqual({ items: [] });
    const first = await record(app, { body: '唯一的一条回忆。' });
    expect((await json<{ items: RecordItem[] }>(app, 'GET', `/api/memories?count=6&exclude=${first.id}`)).items.map(item => item.id)).toEqual([first.id]);
    const second = await record(app, { body: '第二条回忆。' });
    const third = await record(app, { body: '第三条回忆。' });
    const removed = await record(app, { body: '不再展示的记录。' });
    await json(app, 'DELETE', `/api/records/${removed.id}`);
    const next = await json<{ items: RecordItem[] }>(app, 'GET', `/api/memories?exclude=${first.id}`);
    expect([second.id, third.id]).toContain(next.items[0].id);
    await app.close();
    app = await workspace.open();
    const afterRestart = await json<{ items: RecordItem[] }>(app, 'GET', '/api/memories');
    expect(afterRestart.items[0].id).not.toBe(first.id);
    expect(afterRestart.items[0].id).not.toBe(next.items[0].id);
    const all = await json<{ items: RecordItem[] }>(app, 'GET', '/api/memories?count=6');
    expect(new Set(all.items.map(item => item.id))).toEqual(new Set([first.id, second.id, third.id]));
  });

  it('拒绝无效输入和不存在的照片，失败不留下半条记录', async () => {
    for (const input of [{ body: '' }, { body: '日期错误', occurredOn: '2025-02-29' }, { body: '无照片', media: [{ id: randomUUID(), caption: '' }] }, { body: '额外字段', arbitrary: true }]) {
      await json(app, 'POST', '/api/records', input, 400);
    }
    await json(app, 'GET', '/api/records?month=13', undefined, 400);
    await json(app, 'GET', '/api/calendar?month=0000-01', undefined, 400);
    await json(app, 'GET', '/api/calendar?month=2024-13', undefined, 400);
    await json(app, 'GET', '/api/memories?count=0', undefined, 400);
    await json(app, 'GET', '/api/records/not-an-id', undefined, 400);
    await json(app, 'GET', `/api/records/${randomUUID()}`, undefined, 404);
    expect((await json<RecordList>(app, 'GET', '/api/records')).total).toBe(0);
  });

  it('拒绝外部网站和非本机 Host 发来的写入', async () => {
    for (const headers of [{ host: 'attacker.example' }, { host: 'localhost', origin: 'https://attacker.example' }, { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/records', payload: { body: '不应保存' }, headers });
      expect(response.statusCode).toBe(403);
    }
    expect((await json<RecordList>(app, 'GET', '/api/records')).total).toBe(0);
    const health = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:4317' } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ app: 'yearbook', status: 'ok' });
  });
});
