import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { yearbookInputSchema, type YearbookBlockInput, type YearbookChapterInput, type YearbookInput, type YearbookItem, type YearbookVersion } from '@yearbook/shared';
import { appendYearbookPhotos, moveYearbookItem, parseYearbookDraft, withYearbookDraftIds } from '../apps/web/src/yearbook-ordering.js';
import { createTestWorkspace, json, photo, record, upload } from './helpers.js';

function block(patch: Partial<YearbookBlockInput> = {}): YearbookBlockInput {
  return { id: randomUUID(), type: 'paragraph', body: '留下的原话。', caption: '', mediaId: null, recordId: null, ...patch };
}
function chapter(patch: Partial<YearbookChapterInput> = {}): YearbookChapterInput {
  return { id: randomUUID(), kind: 'photos', title: '这一年的照片', body: '请保留这一段说明。', sourceRecordIds: [], blocks: [], ...patch };
}
function input(chapters: YearbookChapterInput[]): YearbookInput {
  return { year: 2024, title: '我们的年册', template: 'photo', introBody: '一年中的一些日子。', coverMediaId: null, chapters };
}
function editable(book: YearbookItem): YearbookInput {
  return {
    year: book.year, title: book.title, template: book.template, coverMediaId: book.coverMediaId, introBody: book.introBody,
    chapters: book.chapters.map(({ id, kind, title, body, sourceRecordIds, blocks }) => ({
      id, kind, title, body, sourceRecordIds,
      blocks: blocks.map(({ id: blockId, type, body: blockBody, mediaId, recordId, caption }) => ({ id: blockId, type, body: blockBody, mediaId, recordId, caption })),
    })),
  };
}

describe('年册编辑排序与未完成草稿', () => {
  it('移动混排内容时保持对象、说明、照片与来源，且不修改原数组', () => {
    const sourceId = randomUUID();
    const blocks = [block(), block({ type: 'image', mediaId: randomUUID(), caption: '窗边的午后\n手动改过的说明' }), block({ type: 'quote', body: '“慢慢来。”' }), block({ type: 'record', recordId: sourceId })];
    const original = chapter({ blocks, sourceRecordIds: [sourceId] });
    const snapshot = JSON.stringify(original);
    const moved = moveYearbookItem(original.blocks, 1, 3);
    expect(moved).toEqual([blocks[0], blocks[2], blocks[3], blocks[1]]);
    expect(moved[3]).toBe(blocks[1]);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(parseYearbookDraft(input([{ ...original, blocks: moved }])).chapters[0]).toEqual({ ...original, blocks: moved });
  });

  it('首尾、空数组和无效位置不会丢失项目或生成假修改', () => {
    const empty: YearbookChapterInput[] = [];
    const items = [chapter(), chapter()];
    expect(moveYearbookItem(empty, 0, 1)).toBe(empty);
    for (const [from, to] of [[0, -1], [1, 2], [-1, 0], [2, 0], [0, 0], [0.5, 1], [0, Number.NaN]]) {
      expect(moveYearbookItem(items, from, to)).toBe(items);
    }
  });

  it('新章节和内容块获得稳定编号，旧编号及字段在重开时保持不变', () => {
    const old = chapter({ blocks: [block({ caption: '旧说明' }), block({ id: undefined })] });
    const unfinished = chapter({ id: undefined, blocks: [block({ id: undefined })] });
    const draft = withYearbookDraftIds(input([old, unfinished]));
    expect(draft.chapters[0].id).toBe(old.id);
    expect(draft.chapters[0].blocks[0].id).toBe(old.blocks[0].id);
    const ids = draft.chapters.flatMap(item => [item.id, ...item.blocks.map(itemBlock => itemBlock.id)]);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseYearbookDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(unfinished.id).toBeUndefined();
  });

  it('临时草稿恢复尚未选照片或记录的内容块，正式保存仍要求完成关联', () => {
    const draft = input([chapter({ blocks: [block({ type: 'image', mediaId: null, caption: '还没选完照片，说明已写好。' }), block({ type: 'record', recordId: null, body: '待补的记录' })] })]);
    expect(yearbookInputSchema.safeParse(draft).success).toBe(false);
    expect(parseYearbookDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    draft.chapters[0].blocks[0].mediaId = randomUUID();
    draft.chapters[0].blocks[1].recordId = randomUUID();
    expect(yearbookInputSchema.safeParse(draft).success).toBe(true);
    expect(() => parseYearbookDraft({ ...draft, template: 'unknown' })).toThrow();
    expect(() => parseYearbookDraft({ ...draft, key: 'unexpected' })).toThrow();
  });

  it('按勾选顺序追加照片，去重且保留已编辑的照片说明和来源', () => {
    const firstPhoto = randomUUID();
    const secondPhoto = randomUUID();
    const thirdPhoto = randomUUID();
    const firstSource = randomUUID();
    const secondSource = randomUUID();
    const existing = block({ type: 'image', mediaId: firstPhoto, caption: '我亲手改过的说明' });
    const original = chapter({ sourceRecordIds: [firstSource], blocks: [existing, block()] });
    const next = appendYearbookPhotos(original, [
      { mediaId: thirdPhoto, caption: '第三张先选', sourceRecordIds: [secondSource] },
      { mediaId: firstPhoto, caption: '不应覆盖旧说明', sourceRecordIds: [firstSource] },
      { mediaId: secondPhoto, caption: '第二张后选', sourceRecordIds: [firstSource, secondSource] },
      { mediaId: thirdPhoto, caption: '重复选择', sourceRecordIds: [secondSource] },
    ]);
    expect(next.blocks.map(item => item.mediaId)).toEqual([firstPhoto, null, thirdPhoto, secondPhoto]);
    expect(next.blocks[0]).toBe(existing);
    expect(next.blocks[0].caption).toBe('我亲手改过的说明');
    expect(next.sourceRecordIds).toEqual([firstSource, secondSource]);
    expect(next.id).toBe(original.id);
    expect(next.body).toBe(original.body);
    expect(original.blocks).toHaveLength(2);
    expect(appendYearbookPhotos(next, [{ mediaId: firstPhoto, caption: '', sourceRecordIds: [] }])).toBe(next);
  });

  it('到达内容块数量上限时拒绝追加，不截断已有文字或照片', () => {
    const original = chapter({ blocks: Array.from({ length: 1000 }, () => block()) });
    const before = JSON.stringify(original);
    expect(() => appendYearbookPhotos(original, [{ mediaId: randomUUID(), caption: '不能偷偷截断', sourceRecordIds: [] }])).toThrow('1000');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('真实保存、重开和版本快照保留章节与选集顺序、说明、编号和模板', async () => {
    const workspace = await createTestWorkspace();
    try {
      const app = await workspace.open('排序 数据');
      const uploaded = await upload(app, [
        { buffer: await photo({ color: '#345c71' }), filename: '河边.jpg' },
        { buffer: await photo({ color: '#748756' }), filename: '树林.jpg' },
        { buffer: await photo({ color: '#996345', width: 80, height: 120 }), filename: '窗边.jpg' },
      ]);
      const [first, second, third] = uploaded.items;
      const sourceA = await record(app, { title: '出门的一天', occurredOn: '2024-04-12', media: [{ id: first.id, caption: '河边原说明' }, { id: second.id, caption: '树林原说明' }] });
      const sourceB = await record(app, { title: '留在家的一天', occurredOn: '2024-08-09', media: [{ id: third.id, caption: '窗边原说明' }] });
      const longBody = '这是一段很长的中文，保存以后仍要完整保留。\n'.repeat(400);
      let saved = await json<YearbookItem>(app, 'POST', '/api/yearbooks', input([
        chapter({ kind: 'opening', title: '慢慢写下的开篇', body: longBody, blocks: [block({ type: 'quote', body: '“保留这句原话。”' })] }),
        chapter({ title: '三张照片的顺序', sourceRecordIds: [sourceA.id], blocks: [block({ type: 'image', mediaId: first.id, caption: '手动修改的河边说明' })] }),
      ]), 201);
      let draft = editable(saved);
      draft.chapters[1] = appendYearbookPhotos(draft.chapters[1], [
        { mediaId: third.id, caption: '窗边原说明', sourceRecordIds: [sourceB.id] },
        { mediaId: second.id, caption: '树林原说明', sourceRecordIds: [sourceA.id] },
      ]);
      saved = await json<YearbookItem>(app, 'PUT', `/api/yearbooks/${saved.id}`, draft);
      const beforeMove = editable(saved);
      const imageBlocks = beforeMove.chapters[1].blocks;
      draft = { ...beforeMove, template: 'text', chapters: moveYearbookItem(beforeMove.chapters, 1, 0) };
      draft.chapters[0] = { ...draft.chapters[0], blocks: moveYearbookItem(draft.chapters[0].blocks, 2, 0) };
      await json<YearbookItem>(app, 'PUT', `/api/yearbooks/${saved.id}`, draft);
      await app.close();
      const reopenedApp = await workspace.open('排序 数据');
      const reopened = await json<YearbookItem>(reopenedApp, 'GET', `/api/yearbooks/${saved.id}`);
      expect(reopened.template).toBe('text');
      expect(reopened.chapters.map(item => item.id)).toEqual([beforeMove.chapters[1].id, beforeMove.chapters[0].id]);
      expect(reopened.chapters[0].blocks.map(item => item.id)).toEqual([imageBlocks[2].id, imageBlocks[0].id, imageBlocks[1].id]);
      expect(reopened.chapters[0].blocks.map(item => item.mediaId)).toEqual([second.id, first.id, third.id]);
      expect(reopened.chapters[0].blocks.map(item => item.caption)).toEqual(['树林原说明', '手动修改的河边说明', '窗边原说明']);
      expect(new Set(reopened.chapters[0].sourceRecordIds)).toEqual(new Set([sourceA.id, sourceB.id]));
      expect(reopened.chapters[1].body).toBe(longBody);
      const versions = await json<YearbookVersion[]>(reopenedApp, 'GET', `/api/yearbooks/${saved.id}/versions`);
      expect(versions).toHaveLength(3);
      expect(versions[0].snapshot).toEqual(draft);
      expect(versions[1].snapshot.template).toBe('photo');
      const previewHead = await reopenedApp.inject({ method: 'HEAD', url: `/api/yearbooks/${saved.id}/preview` });
      expect(previewHead.statusCode).toBe(200);
      expect(previewHead.headers['content-type']).toContain('text/html');
      expect(previewHead.body).toBe('');
      const unavailablePreview = await reopenedApp.inject({ method: 'HEAD', url: `/api/yearbooks/${randomUUID()}/preview` });
      expect(unavailablePreview.statusCode).toBe(404);
    } finally { await workspace.dispose(); }
  });
});
