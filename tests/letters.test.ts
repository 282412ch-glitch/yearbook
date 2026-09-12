import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDate, recordInputSchema, type LetterDetail, type LetterEnvelope, type LetterList, type LetterSummary, type RecordList, type YearbookItem } from '@yearbook/shared';
import { DataStore } from '../apps/server/src/db.js';
import { importMedia } from '../apps/server/src/media.js';
import { getLetter, saveLetter, sealLetter } from '../apps/server/src/letters.js';
import { getAiScope, prepareAiTask, saveGeneratedDraft } from '../apps/server/src/ai/store.js';
import { executeProjectTool } from '../apps/server/src/ai/tools.js';
import { saveRecord } from '../apps/server/src/records.js';
import { backup, createTestWorkspace, json, photo, record, restore, upload, type TestWorkspace } from './helpers.js';

describe('给未来的信：独立草稿、封存、到期与照片边界', () => {
  let workspace: TestWorkspace;
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2036, 11, 31, 23, 59, 0));
    workspace = await createTestWorkspace();
    app = await workspace.open('信件 中文 空格');
  });
  afterEach(async () => { await workspace.dispose(); vi.useRealTimers(); });

  const create = (input: unknown = {}) => json<LetterDetail>(app, 'POST', '/api/letters', input, 201);

  it('未完成信件可保存，照片可排序和改说明，关闭重开后内容与文件完整', async () => {
    const draft = await create();
    expect(draft).toMatchObject({ body: '', media: [], unlockOn: null, sealedAt: null, status: 'draft', canRead: true });
    const bytes = [await photo({ color: '#a88d71' }), await photo({ color: '#737f94', width: 90, height: 150 })];
    const photos = (await upload(app, bytes.map((buffer, index) => ({ buffer, filename: `给未来 ${index}.jpg` })))).items;
    const input = { title: '写给以后的我', body: '先记住此刻窗外的树。\n下一次再把信写完。', unlockOn: null,
      media: [{ id: photos[1].id, caption: '第二张排在前面' }, { id: photos[0].id, caption: '第一张排到后面' }] };
    const saved = await json<LetterDetail>(app, 'PUT', `/api/letters/${draft.id}`, input);
    expect(saved.media!.map(item => item.id)).toEqual([photos[1].id, photos[0].id]);
    expect(saved.media!.map(item => item.caption)).toEqual(input.media.map(item => item.caption));
    await app.close(); app = await workspace.open('信件 中文 空格');
    expect(await json(app, 'GET', `/api/letters/${draft.id}`)).toEqual(saved);
    expect((await app.inject({ method: 'GET', url: photos[0].originalUrl })).rawPayload.equals(bytes[0])).toBe(true);
    expect((await json<LetterSummary>(app, 'GET', '/api/letters/summary')).totalDrafts).toBe(1);
    const list = await json<LetterList>(app, 'GET', '/api/letters?status=draft');
    expect(list.total).toBe(1); expect(list.items[0]).not.toHaveProperty('body'); expect(list.items[0]).not.toHaveProperty('media');
  });

  it('以本地午夜到期，关闭期间无需计时器；详情查看不等于拆阅，首次已读时间幂等', async () => {
    const bytes = await photo({ color: '#975355' });
    const media = (await upload(app, [{ buffer: bytes, filename: '未拆信的照片.jpg' }])).items[0];
    const draft = await create({ title: '新年再读', body: '保留到新年才出现的正文。', unlockOn: '2037-01-01', media: [{ id: media.id, caption: '信内独有的照片说明' }] });
    const sealed = await json<LetterDetail>(app, 'POST', `/api/letters/${draft.id}/seal`, {});
    expect(sealed).toMatchObject({ status: 'sealed', canRead: false, photoCount: 1, readAt: null });
    for (const value of [sealed, await json(app, 'GET', `/api/letters/${draft.id}`), await json(app, 'GET', '/api/letters'), await json(app, 'GET', '/api/letters/summary')]) {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain(draft.body!); expect(serialized).not.toContain(media.id);
      expect(serialized).not.toContain('信内独有的照片说明'); expect(serialized).not.toContain('/api/media/');
    }
    await json(app, 'POST', `/api/letters/${draft.id}/read`, {}, 403);
    for (const url of [media.originalUrl, media.displayUrl, media.thumbnailUrl]) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    await app.close();
    vi.setSystemTime(new Date(2037, 0, 1, 0, 0, 0));
    app = await workspace.open('信件 中文 空格');
    const summary = await json<LetterSummary>(app, 'GET', '/api/letters/summary');
    expect(summary).toMatchObject({ today: '2037-01-01', dueUnread: 1, sealedCount: 0 });
    expect(summary.due[0].id).toBe(draft.id);
    const preview = await json<LetterDetail>(app, 'GET', `/api/letters/${draft.id}`);
    expect(preview).toMatchObject({ body: draft.body, status: 'due', readAt: null, canRead: true });
    expect(preview.media![0].caption).toBe('信内独有的照片说明');
    expect((await app.inject({ method: 'GET', url: media.originalUrl })).rawPayload.equals(bytes)).toBe(true);
    expect((await json<LetterSummary>(app, 'GET', '/api/letters/summary')).dueUnread).toBe(1);
    const read = await json<LetterDetail>(app, 'POST', `/api/letters/${draft.id}/read`, {});
    vi.setSystemTime(new Date(2037, 0, 1, 8, 30, 0));
    expect(await json(app, 'POST', `/api/letters/${draft.id}/read`, {})).toEqual(read);
    expect(read.readAt).not.toBeNull(); expect(read.status).toBe('read');
    expect((await json<LetterSummary>(app, 'GET', '/api/letters/summary')).dueUnread).toBe(0);
  });

  it('封存要求查看日期和正文或照片，不能修改封存日期绕过限制，也不能篡改已到期正文', async () => {
    await json(app, 'POST', '/api/letters', { unlockOn: '2037-02-29' }, 400);
    await json(app, 'POST', '/api/letters', { unlockOn: '2036-12-31T00:00:00Z' }, 400);
    await json(app, 'POST', '/api/letters', { media: [{ id: randomUUID() }] }, 400);
    const draft = await create({ title: '只有信封标题' });
    await json(app, 'POST', `/api/letters/${draft.id}/read`, {}, 409);
    expect((await json<{ error: { code: string } }>(app, 'POST', `/api/letters/${draft.id}/seal`, {}, 400)).error.code).toBe('LETTER_UNLOCK_DATE');
    await json(app, 'PUT', `/api/letters/${draft.id}`, { title: '标题不能代替正文', unlockOn: localDate() });
    expect((await json<{ error: { code: string } }>(app, 'POST', `/api/letters/${draft.id}/seal`, {}, 400)).error.code).toBe('LETTER_EMPTY');
    await json(app, 'PUT', `/api/letters/${draft.id}`, { body: '正文', unlockOn: '2036-12-30' });
    await json(app, 'POST', `/api/letters/${draft.id}/seal`, {}, 400);
    await json(app, 'PUT', `/api/letters/${draft.id}`, { body: '正文保持原样', unlockOn: '2037-01-01' });
    const sealed = await json<LetterDetail>(app, 'POST', `/api/letters/${draft.id}/seal`, {});
    expect(await json(app, 'POST', `/api/letters/${draft.id}/seal`, {})).toEqual(sealed);
    await json(app, 'PUT', `/api/letters/${draft.id}`, { body: '偷偷改正文', unlockOn: '2036-12-31' }, 409);
    await json(app, 'POST', `/api/letters/${draft.id}/seal`, { unlockOn: '2036-12-31' }, 400);
    await json(app, 'POST', `/api/letters/${draft.id}/read`, { unlockOn: '2036-12-31' }, 400);
    vi.setSystemTime(new Date(2037, 0, 1, 0));
    expect((await json<LetterDetail>(app, 'GET', `/api/letters/${draft.id}`)).body).toBe('正文保持原样');
    await json(app, 'PUT', `/api/letters/${draft.id}`, { body: '到期之后也不能覆盖', unlockOn: '2037-01-01' }, 409);
    const media = (await upload(app, [{ buffer: await photo(), filename: '只附照片.jpg' }])).items[0];
    const photosOnly = await create({ unlockOn: '2037-01-01', media: [{ id: media.id, caption: '无需正文' }] });
    expect((await json<LetterDetail>(app, 'POST', `/api/letters/${photosOnly.id}/seal`, {})).status).toBe('due');
    await json(app, 'POST', '/api/letters', { media: [{ id: media.id }, { id: media.id }] }, 400);
  });

  it('四种状态、分页与回收站互相独立，删除不解封，恢复保留原正文和日期', async () => {
    const drafts = [await create(), await create({ title: '另一封草稿' })];
    const future = await create({ body: '未来正文', unlockOn: '2037-01-01' });
    const due = await create({ body: '今天待读', unlockOn: '2036-12-31' });
    const read = await create({ body: '今天已读', unlockOn: '2036-12-31' });
    for (const letter of [future, due, read]) await json(app, 'POST', `/api/letters/${letter.id}/seal`, {});
    await json(app, 'POST', `/api/letters/${read.id}/read`, {});
    for (const [status, expected] of [['draft', 2], ['sealed', 1], ['due', 1], ['read', 1]] as const) {
      expect((await json<LetterList>(app, 'GET', `/api/letters?status=${status}`)).total).toBe(expected);
    }
    const page1 = await json<LetterList>(app, 'GET', '/api/letters?limit=2&offset=0');
    const page2 = await json<LetterList>(app, 'GET', '/api/letters?limit=2&offset=2');
    expect(page1.total).toBe(5); expect(new Set([...page1.items, ...page2.items].map(item => item.id)).size).toBe(4);
    for (const query of ['status=unknown', 'limit=0', 'offset=-1', 'deleted=wrong']) await json(app, 'GET', `/api/letters?${query}`, undefined, 400);
    const trashed = await json<LetterEnvelope>(app, 'DELETE', `/api/letters/${future.id}`);
    expect(trashed.deletedAt).not.toBeNull(); expect(trashed.canRead).toBe(false);
    await json(app, 'PUT', `/api/letters/${future.id}`, { body: '删除也不能改', unlockOn: '2036-12-31' }, 409);
    await json(app, 'POST', `/api/letters/${future.id}/read`, {}, 409);
    expect((await json<LetterList>(app, 'GET', '/api/letters?deleted=true')).items.map(item => item.id)).toEqual([future.id]);
    const revived = await json<LetterEnvelope>(app, 'POST', `/api/letters/${future.id}/restore`, {});
    expect(revived).toMatchObject({ unlockOn: '2037-01-01', status: 'sealed', deletedAt: null });
    expect(await json(app, 'POST', `/api/letters/${future.id}/restore`, {})).toEqual(revived);
    await json(app, 'DELETE', `/api/letters/${drafts[0].id}`);
    expect((await json<LetterSummary>(app, 'GET', '/api/letters/summary')).totalDrafts).toBe(1);
    await json(app, 'DELETE', `/api/letters/${due.id}`);
    expect((await json<LetterSummary>(app, 'GET', '/api/letters/summary')).dueUnread).toBe(0);
    await json(app, 'POST', `/api/letters/${due.id}/restore`, {});
    expect((await json<LetterSummary>(app, 'GET', '/api/letters/summary')).dueUnread).toBe(1);
  });

  it('共享记录、年册和草稿的照片继续可读，独占封存照片不能经新关联解锁', async () => {
    const photos = (await upload(app, await Promise.all(['#886663', '#664f91', '#54745d', '#917354'].map(async (color, index) => ({ buffer: await photo({ color }), filename: `共享 ${index}.jpg` }))))).items;
    const ordinary = await record(app, { body: '记录自身的正文', media: [{ id: photos[0].id, caption: '记录的照片说明' }] });
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2036, coverMediaId: photos[1].id, chapters: [{ kind: 'custom', title: '手工章节' }] }, 201);
    const otherDraft = await create({ media: [{ id: photos[2].id, caption: '另一封草稿也使用' }] });
    const sealed = await create({ body: '信的独有正文', unlockOn: '2037-01-01', media: photos.map(photo => ({ id: photo.id, caption: '封存的说明' })) });
    await json(app, 'POST', `/api/letters/${sealed.id}/seal`, {});
    for (const photo of photos.slice(0, 3)) expect((await app.inject({ method: 'GET', url: photo.thumbnailUrl })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: photos[3].thumbnailUrl })).statusCode).toBe(403);
    await json(app, 'POST', '/api/records', { body: '不能绕过信封', media: [{ id: photos[3].id }] }, 403);
    await json(app, 'POST', '/api/letters', { media: [{ id: photos[3].id }] }, 403);
    await json(app, 'POST', '/api/yearbooks', { year: 2036, coverMediaId: photos[3].id }, 403);
    await json(app, 'POST', '/api/yearbooks', { year: 2036, chapters: [{ blocks: [{ type: 'image', mediaId: photos[3].id }] }] }, 403);
    await json(app, 'DELETE', `/api/letters/${sealed.id}`);
    expect((await app.inject({ method: 'GET', url: photos[3].thumbnailUrl })).statusCode).toBe(403);
    await json(app, 'POST', `/api/letters/${sealed.id}/restore`, {});
    await json(app, 'DELETE', `/api/records/${ordinary.id}`);
    expect((await app.inject({ method: 'GET', url: photos[0].thumbnailUrl })).statusCode).toBe(403);
    await json(app, 'POST', `/api/records/${ordinary.id}/restore`, {});
    expect((await app.inject({ method: 'GET', url: photos[0].thumbnailUrl })).statusCode).toBe(200);
    await json(app, 'DELETE', `/api/yearbooks/${book.id}`);
    expect((await app.inject({ method: 'GET', url: photos[1].thumbnailUrl })).statusCode).toBe(403);
    await json(app, 'POST', `/api/yearbooks/${book.id}/restore`, {});
    expect((await app.inject({ method: 'GET', url: photos[1].thumbnailUrl })).statusCode).toBe(200);
    await json(app, 'PUT', `/api/letters/${otherDraft.id}`, { body: '移除照片后的草稿' });
    expect((await app.inject({ method: 'GET', url: photos[2].thumbnailUrl })).statusCode).toBe(403);
    const ordinaryAgain = await json<{ body: string; media: { caption: string }[] }>(app, 'GET', `/api/records/${ordinary.id}`);
    expect(ordinaryAgain.body).toBe('记录自身的正文'); expect(ordinaryAgain.media[0].caption).toBe('记录的照片说明');
  });

  it('未来信从普通检索、月历、盲盒、自动年册和真实 Agent 素材范围排除', async () => {
    const visible = await record(app, { body: '公开记录素材', occurredOn: '2036-12-31' });
    const hidden = await create({ title: '只有信封的名字', body: '信件独有词海棠树', unlockOn: '2037-01-01' });
    await json(app, 'POST', `/api/letters/${hidden.id}/seal`, {});
    const today = await create({ body: '今天的信也不应混入记录', unlockOn: '2036-12-31' });
    await json(app, 'POST', `/api/letters/${today.id}/seal`, {});
    expect((await json<RecordList>(app, 'GET', '/api/records?q=海棠树')).total).toBe(0);
    expect((await json<RecordList>(app, 'GET', '/api/records')).items.map(item => item.id)).toEqual([visible.id]);
    expect((await json<{ items: { id: string }[] }>(app, 'GET', '/api/memories?count=6')).items.map(item => item.id)).toEqual([visible.id]);
    expect((await json<{ days: { count: number }[] }>(app, 'GET', '/api/calendar?month=2036-12')).days).toEqual([{ date: '2036-12-31', count: 1 }]);
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2036 }, 201);
    expect(JSON.stringify(book)).not.toContain(hidden.id); expect(JSON.stringify(book)).not.toContain(today.id);
    const store = new DataStore(join(workspace.root, 'Agent 独立资料'));
    try {
      const media = (await importMedia(store, await photo({ color: '#969481' }), '信内照片.jpg')).item;
      const source = saveRecord(store, recordInputSchema.parse({ body: '可用的日常记录', occurredOn: '2036-12-31' }));
      const letter = saveLetter(store, { body: 'AI 不能看到的海棠树', unlockOn: '2037-01-01', media: [{ id: media.id, caption: 'AI 不能看到的图注' }] });
      sealLetter(store, letter.id);
      const task = prepareAiTask(store, { kind: 'agent', year: 2036, instruction: '整理生活素材' }, 'tools');
      const scope = getAiScope(store, task.id);
      expect(scope.recordIds).toEqual([source.id]); expect(scope.mediaIds).toEqual([]);
      expect(JSON.stringify(scope)).not.toContain('海棠树');
      const context = { store, scope, retrievedIds: new Set<string>(), save: () => randomUUID() };
      const searched = executeProjectTool('search_records', { q: '海棠树' }, context);
      expect(searched.data).toMatchObject({ total: 0, records: [] });
      expect(() => executeProjectTool('get_records', { recordIds: [letter.id] }, context)).toThrow('未授权');
      expect(() => executeProjectTool('get_selected_media', { mediaIds: [media.id] }, context)).toThrow('授权素材');
      expect(() => prepareAiTask(store, { kind: 'chapter', recordIds: [letter.id] }, 'fixed')).toThrow('记录不存在');
      expect(() => prepareAiTask(store, { kind: 'chapter', recordIds: [source.id], selectedMediaIds: [media.id] }, 'fixed')).toThrow('记录关联');
    } finally { await store.close(); }
  });

  it('主动重导入完整原文件可去重复用，猜测照片编号无法取得重导入授权', async () => {
    const bytes = await photo({ color: '#a69374' });
    const image = (await upload(app, [{ buffer: bytes, filename: '独有原图.jpg' }])).items[0];
    const letter = await create({ body: '信内正文仍然封存', unlockOn: '2038-01-01', media: [{ id: image.id, caption: '不随重导入泄露的说明' }] });
    await json(app, 'POST', `/api/letters/${letter.id}/seal`, {});
    await json(app, 'POST', '/api/records', { body: '只知道编号不能添加', media: [{ id: image.id }] }, 403);
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(403);
    const imported = await upload(app, [{ buffer: bytes, filename: '用户再次选择的原图.jpg' }]);
    expect(imported.duplicates).toBe(1); expect(imported.items[0].id).toBe(image.id);
    expect((await app.inject({ method: 'GET', url: image.originalUrl })).rawPayload.equals(bytes)).toBe(true);
    const envelope = await json<LetterDetail>(app, 'GET', `/api/letters/${letter.id}`);
    expect(envelope).not.toHaveProperty('body'); expect(envelope).not.toHaveProperty('media');
    const saved = await record(app, { body: '主动重导入后保存的新记录', media: [{ id: image.id, caption: '新记录自己填写的图注' }] });
    expect(saved.media[0].caption).toBe('新记录自己填写的图注');
    await app.close(); app = await workspace.open('信件 中文 空格');
    expect((await app.inject({ method: 'GET', url: image.originalUrl })).rawPayload.equals(bytes)).toBe(true);
    expect((await json<LetterDetail>(app, 'GET', `/api/letters/${letter.id}`)).status).toBe('sealed');
  });

  it('重导入临时授权在封存、超时、重启与恢复后撤销，不跟随备份进入下一资料库', async () => {
    const bytes = await photo({ color: '#586594' });
    const image = (await upload(app, [{ buffer: bytes, filename: '需要撤销的照片.jpg' }])).items[0];
    const letter = await create({ body: '封存到后年', unlockOn: '2038-01-01', media: [{ id: image.id }] });
    await json(app, 'POST', `/api/letters/${letter.id}/seal`, {});
    await upload(app, [{ buffer: bytes, filename: '再次选择.jpg' }]);
    const second = await create({ body: '复制到另一封未来信', unlockOn: '2038-01-01', media: [{ id: image.id }] });
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(200);
    await json(app, 'POST', `/api/letters/${second.id}/seal`, {});
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(403);
    await upload(app, [{ buffer: bytes, filename: '再次选择.jpg' }]);
    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(403);
    await upload(app, [{ buffer: bytes, filename: '重启前选择.jpg' }]);
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(200);
    await app.close(); app = await workspace.open('信件 中文 空格');
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(403);
    const copy = await backup(app);
    await upload(app, [{ buffer: bytes, filename: '恢复前选择.jpg' }]);
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(200);
    await restore(app, copy.buffer);
    expect((await app.inject({ method: 'GET', url: image.thumbnailUrl })).statusCode).toBe(403);
    await json(app, 'POST', '/api/records', { body: '恢复后不能凭旧授权写入', media: [{ id: image.id }] }, 403);
  });

  it('已保存的 AI 草稿来源照片与年册历史版本仍可阅读，不泄漏信内的新图注', async () => {
    const store = new DataStore(join(workspace.root, '历史草稿 照片'));
    try {
      const media = (await importMedia(store, await photo({ color: '#866a91' }), '共用照片.jpg')).item;
      const source = saveRecord(store, recordInputSchema.parse({ body: '原记录素材', media: [{ id: media.id, caption: '原始照片说明' }] }));
      const task = prepareAiTask(store, { kind: 'chapter', recordIds: [source.id] }, 'fixed');
      saveGeneratedDraft(store, task.id, { title: '原始独立草稿', paragraphs: [{ text: '原记录素材', sourceRecordIds: [source.id] }], photos: [{ mediaId: media.id, caption: '原始草稿说明', sourceRecordIds: [source.id] }] });
      const letter = saveLetter(store, { body: '封存新正文', unlockOn: '2037-01-01', media: [{ id: media.id, caption: '不应泄露的新图注' }] });
      sealLetter(store, letter.id);
      saveRecord(store, recordInputSchema.parse({ body: source.body }), source.id);
      expect(getLetter(store, letter.id)).not.toHaveProperty('media');
      await store.close();
      const historical = await workspace.open('历史草稿 照片');
      expect((await historical.inject({ method: 'GET', url: media.displayUrl })).statusCode).toBe(200);
      const drafts = await historical.inject({ method: 'GET', url: '/api/ai/drafts' });
      expect(drafts.body).not.toContain('不应泄露的新图注');
    } finally { await store.close(); }
    const media = (await upload(app, [{ buffer: await photo({ color: '#355752' }), filename: '版本封面.jpg' }])).items[0];
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2036, coverMediaId: media.id, chapters: [{ title: '留存版本' }] }, 201);
    const letter = await create({ body: '新信正文', unlockOn: '2037-01-01', media: [{ id: media.id }] });
    await json(app, 'POST', `/api/letters/${letter.id}/seal`, {});
    await json(app, 'PUT', `/api/yearbooks/${book.id}`, { year: 2036, coverMediaId: null, chapters: [{ title: '去掉当前封面' }] });
    expect((await app.inject({ method: 'GET', url: media.thumbnailUrl })).statusCode).toBe(200);
  });

  it('恢复过程前开始但迟到的信件保存请求不能写入恢复后的资料库', async () => {
    const saved = await create({ body: '备份中的草稿' });
    const copy = await backup(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const bytes = Buffer.from(JSON.stringify({ body: '迟到的覆盖内容', unlockOn: '2037-01-01' }));
    const arrived = new Promise<void>(yes => app.server.once('request', () => setImmediate(yes)));
    const request = httpRequest(new URL(`/api/letters/${saved.id}`, address), { method: 'PUT', headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
    const response = new Promise<{ status: number; body: string }>((yes, no) => {
      request.once('error', no);
      request.once('response', incoming => { let body = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { body += chunk; }); incoming.once('end', () => yes({ status: incoming.statusCode!, body })); });
    });
    const split = Math.floor(bytes.length / 2); request.write(bytes.subarray(0, split)); await arrived;
    try {
      await restore(app, copy.buffer);
      request.end(bytes.subarray(split));
      const result = await response;
      expect(result.status).toBe(409); expect(JSON.parse(result.body).error.code).toBe('LIBRARY_RESTORED');
      expect((await json<LetterDetail>(app, 'GET', `/api/letters/${saved.id}`)).body).toBe('备份中的草稿');
    } finally { request.destroy(); }
  });
});
