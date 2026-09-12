import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordInputSchema } from '@yearbook/shared';
import { DataStore } from '../apps/server/src/db.js';
import { pauseExports, readExport, requestExport } from '../apps/server/src/exports.js';
import { mediaFiles } from '../apps/server/src/media.js';
import { saveRecord } from '../apps/server/src/records.js';
import { getTask } from '../apps/server/src/tasks.js';
import { getYearbook, renderYearbookHtml, saveYearbook } from '../apps/server/src/yearbooks.js';
import { captureYearbookRenderSnapshot, renderYearbookSnapshot } from '../apps/server/src/yearbook-template.js';
import { exportLayoutFixture } from './export-layout-fixture.js';

describe('当前保存稿、离线资源与年册模板', () => {
  let root: string; let store: DataStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'yearbook 导出内容 ')); store = new DataStore(join(root, '中文 空格资料')); });
  afterEach(async () => {
    await pauseExports(store); await store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('测试清理路径越界');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  });
  async function settled(id: string) {
    for (let index = 0; index < 250; index++) {
      const task = await store.write(() => getTask(store, id));
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
      await new Promise(yes => setTimeout(yes, 20));
    }
    throw new Error('导出未结束');
  }

  it('离线ZIP带完整照片、字体和许可证，保留排序、来源、纯照片记录及封面附记', async () => {
    const fixture = await exportLayoutFixture(store);
    saveRecord(store, recordInputSchema.parse({ body: 'UNSELECTED_PRIVATE_MATERIAL', occurredOn: '2024-03-01' }));
    const submitted = requestExport(store, fixture.photoBook.id, 'html');
    expect((await settled(submitted.id)).status).toBe('completed');
    const output = await readExport(store, submitted.id);
    const zip = new AdmZip(output.buffer);
    const html = zip.readAsText('index.html');
    expect(zip.readAsText('FONT-LICENSES.txt')).toContain('SIL OPEN FONT LICENSE');
    expect(zip.readAsText('FONT-LICENSES.txt')).toContain('Noto Sans SC');
    expect(zip.readAsText('FONT-LICENSES.txt')).toContain('Noto Serif SC');
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.sourceRecordIds).toHaveLength(3);
    expect(manifest.mediaIds).toHaveLength(3);
    expect(manifest.savedAt).toBe(fixture.photoBook.updatedAt);
    expect(html).not.toContain('UNSELECTED_PRIVATE_MATERIAL');
    expect(html).not.toContain('二月空月份不应出现');
    expect(html).not.toContain('不会重复的空封面');
    expect(html).toContain('用户填写过的封面附记必须保留在这一页');
    expect(html).toContain('仅有照片也会进入年册');
    expect(html.indexOf('选集第一张：竖向照片')).toBeLessThan(html.indexOf('选集第二张：横向照片'));
    const images = [...html.matchAll(/<img src="([^"]+)"/g)];
    expect(images).toHaveLength(6);
    for (const [, source] of images) {
      expect(source).toMatch(/^data:image\/jpeg;base64,/);
      expect(Buffer.from(source.split(',')[1], 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
    const fonts = [...html.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)];
    expect(fonts.length).toBeGreaterThan(1);
    for (const [, source] of fonts) expect(Buffer.from(source, 'base64').subarray(0, 4).toString()).toBe('wOF2');
    expect(html).not.toMatch(/src=\"(?:https?:|\/api\/)/);
    expect(html).not.toContain('src:local(');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(target), `dangling source: ${target}`).toBe(true);
  });

  it('两种模板使用同一份完整内容，照片版先呈现图片，文字版先呈现正文', async () => {
    const fixture = await exportLayoutFixture(store);
    const photo = await renderYearbookHtml(store, fixture.photoBook.id);
    const text = await renderYearbookHtml(store, fixture.textBook.id);
    for (const [template, html] of [['photo', photo], ['text', text]] as const) {
      expect(html).toContain(`data-template="${template}"`);
      expect(html).toContain('长中文排版核对第 22 段');
      expect(html).toContain('全书末尾核对');
      const record = html.split(`data-record-id="${fixture.records[0].id}">`)[1].split('</article>')[0];
      const imageAt = record.indexOf('<figure'); const proseAt = record.indexOf('早上沿着河边慢慢走');
      expect(imageAt).toBeGreaterThan(-1); expect(proseAt).toBeGreaterThan(-1);
      expect(imageAt < proseAt).toBe(template === 'photo');
    }
  });

  it('保存时明确删除所有章节会保持空册，并可导出封面', async () => {
    saveRecord(store, recordInputSchema.parse({ body: '不会被自动添回册中', occurredOn: '2024-01-01' }));
    const empty = saveYearbook(store, { year: 2024, title: '只有封面', chapters: [] });
    expect(empty.chapters).toEqual([]);
    const html = await renderYearbookHtml(store, empty.id);
    expect(html).toContain('<h1>只有封面</h1>');
    expect(html).not.toContain('不会被自动添回册中');
    expect(html).not.toContain('data-kind="month"');
    const automatic = saveYearbook(store, { year: 2024 });
    expect(automatic.chapters.some(chapter => chapter.kind === 'month')).toBe(true);
    const exported = requestExport(store, empty.id, 'html');
    expect((await settled(exported.id)).status).toBe('completed');
    expect(new AdmZip((await readExport(store, exported.id)).buffer).readAsText('index.html')).toContain('只有封面');
  });

  it('快照在异步导出期间不混入后来修改的记录和年册', async () => {
    const record = saveRecord(store, recordInputSchema.parse({ body: '导出开始时保存的原话', occurredOn: '2024-03-01' }));
    const book = saveYearbook(store, { year: 2024, title: '旧标题' });
    const snapshot = captureYearbookRenderSnapshot(store, book);
    saveRecord(store, recordInputSchema.parse({ body: '稍后修改的内容', occurredOn: '2024-03-01' }), record.id);
    saveYearbook(store, { year: book.year, title: '新标题', template: book.template, chapters: book.chapters.map(({ position, createdAt, updatedAt, ...chapter }) => ({ ...chapter, blocks: chapter.blocks.map(({ position: _position, createdAt: _created, updatedAt: _updated, ...block }) => block) })) }, book.id);
    const original = await renderYearbookSnapshot(snapshot);
    expect(original).toContain('导出开始时保存的原话'); expect(original).toContain('<title>旧标题</title>');
    expect(original).not.toContain('稍后修改的内容');
    const current = await renderYearbookHtml(store, book.id);
    expect(current).toContain('稍后修改的内容'); expect(current).toContain('<title>新标题</title>');
  });

  it('素材缺失会明确失败，避免交付悄悄丢照片的年册', async () => {
    const fixture = await exportLayoutFixture(store);
    const snapshot = captureYearbookRenderSnapshot(store, fixture.photoBook);
    await unlink(join(store.dataDir, mediaFiles(snapshot.media.get(fixture.media[1].id)!).display));
    const task = requestExport(store, fixture.photoBook.id, 'html');
    const result = await settled(task.id);
    expect(result.status).toBe('failed'); expect(result.errorMessage).toContain('照片'); expect(result.errorMessage).toContain('备份');
    expect(result.outputPath).toBeNull();
  });

  it('用户文字和照片说明保持转义，原始素材可在离线文档中回查', async () => {
    const fixture = await exportLayoutFixture(store);
    const source = fixture.records[0];
    const book = saveYearbook(store, { year: 2024, title: '<script>alert("标题")</script>', chapters: [{
      kind: 'custom', title: '回顾 & 原文', body: '<img src="https://example.invalid/leak">', sourceRecordIds: [source.id], blocks: [
        { type: 'paragraph', body: '采用的草稿正文', recordId: source.id },
        { type: 'image', mediaId: fixture.media[0].id, caption: '"><script>alert("照片")</script>' },
      ],
    }] });
    const html = await renderYearbookHtml(store, book.id);
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src="https:');
    expect(html).toContain(`href="#source-${source.id}"`);
    expect(html).toContain(`id="source-${source.id}"`);
    expect(html).toContain('早上沿着河边慢慢走');
    expect(html).toContain('展开原始素材');
  });

  it('不同年册误用同一幂等键时不会交付另一本的导出', async () => {
    const first = saveYearbook(store, { year: 2024, title: '第一本', chapters: [] });
    const second = saveYearbook(store, { year: 2024, title: '第二本', chapters: [] });
    requestExport(store, first.id, 'html', 'same-export-key');
    expect(() => requestExport(store, second.id, 'html', 'same-export-key')).toThrow('另一本年册');
    expect(getYearbook(store, second.id).title).toBe('第二本');
  });
});
