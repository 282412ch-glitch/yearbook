import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppStats, RecordItem, RecordList } from '@yearbook/shared';
import { createTestWorkspace, json, multipart, photo, record, recordInput, upload, type TestWorkspace } from './helpers.js';

describe('真实照片导入、方向、文件保留和记录关联', () => {
  let workspace: TestWorkspace;
  let app: FastifyInstance;
  beforeEach(async () => { workspace = await createTestWorkspace(); app = await workspace.open(); });
  afterEach(async () => { await workspace.dispose(); });

  it('按内容去重，原图字节不变，阅读图与缩略图正确旋转并保留 EXIF 日期为建议', async () => {
    const pixels = Buffer.alloc(120 * 80 * 3);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 120; x++) {
      const offset = (y * 120 + x) * 3;
      pixels[offset] = x < 60 ? 230 : 25;
      pixels[offset + 1] = x < 60 ? 25 : 220;
      pixels[offset + 2] = 20;
    }
    const rotated = await sharp(pixels, { raw: { width: 120, height: 80, channels: 3 } })
      .withMetadata({ orientation: 6 }).withExifMerge({ IFD2: { DateTimeOriginal: '2020:02:29 00:15:00' } }).jpeg({ quality: 95 }).toBuffer();
    const ordinary = await photo({ width: 1500, height: 900, color: '#364c64' });
    const imported = await upload(app, [{ buffer: rotated, filename: '竖着看.jpg' }, { buffer: rotated, filename: '另一个名字.jpg' }, { buffer: ordinary, filename: '横照片.jpg' }]);
    expect(imported.items).toHaveLength(2);
    expect(imported.duplicates).toBe(1);
    const first = imported.items[0];
    expect(first).toMatchObject({ width: 80, height: 120, suggestedDate: '2020-02-29', mime: 'image/jpeg' });
    const again = await upload(app, [{ buffer: rotated, filename: '再次导入.jpg' }]);
    expect(again.duplicates).toBe(1);
    expect(again.items[0].id).toBe(first.id);
    expect(await readdir(join(workspace.root, '本地 数据', 'media'))).toHaveLength(2);
    expect(await readdir(join(workspace.root, '本地 数据', 'display'))).toHaveLength(2);
    expect(await readdir(join(workspace.root, '本地 数据', 'thumbnails'))).toHaveLength(2);
    const original = await app.inject({ method: 'GET', url: first.originalUrl });
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.equals(rotated)).toBe(true);
    expect((await sharp(original.rawPayload).metadata()).orientation).toBe(6);
    for (const url of [first.displayUrl, first.thumbnailUrl]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      const metadata = await sharp(response.rawPayload).metadata();
      expect(metadata).toMatchObject({ width: 80, height: 120, format: 'jpeg' });
      expect(metadata.orientation).toBeUndefined();
      const top = await sharp(response.rawPayload).extract({ left: 40, top: 20, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      const bottom = await sharp(response.rawPayload).extract({ left: 40, top: 100, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      expect(top[0]).toBeGreaterThan(top[1] + 100);
      expect(bottom[1]).toBeGreaterThan(bottom[0] + 100);
    }
    const thumbnail = await app.inject({ method: 'GET', url: imported.items[1].thumbnailUrl });
    expect(await sharp(thumbnail.rawPayload).metadata()).toMatchObject({ width: 600, height: 360 });
    const undated = await record(app, { body: '', occurredOn: null, media: [{ id: first.id, caption: '' }] });
    expect(undated.occurredOn).toBeNull();
    expect(undated.media[0].suggestedDate).toBe('2020-02-29');
  });

  it('外部照片移动和应用重启后仍可用，单独调整照片顺序/说明不破坏其他记录', async () => {
    const external = join(workspace.root, '外部 原照片.jpg');
    const bytes = await photo({ color: '#79643f' });
    await writeFile(external, bytes);
    const imported = await upload(app, [{ buffer: await readFile(external), filename: '外部 原照片.jpg' }, { buffer: await photo({ color: '#d5c7a3' }), filename: '第二张.jpg' }]);
    const [first, second] = imported.items;
    const imageOnly = await record(app, { body: '', media: [{ id: first.id, caption: '门口的银杏' }, { id: second.id, caption: '桥上的夕阳' }] });
    const shared = await record(app, { body: '同一天的另一个片段。', media: [{ id: first.id, caption: '另一条记录自己的说明' }] });
    await rename(external, join(workspace.root, '外部照片已移动.jpg'));
    const reordered = await json<RecordItem>(app, 'PUT', `/api/records/${imageOnly.id}`, recordInput(imageOnly, { media: [{ id: second.id, caption: '夕阳先翻到' }, { id: first.id, caption: '银杏后翻到' }] }));
    expect(reordered.media.map(item => [item.id, item.caption])).toEqual([[second.id, '夕阳先翻到'], [first.id, '银杏后翻到']]);
    expect((await json<RecordList>(app, 'GET', `/api/records?q=${encodeURIComponent('夕阳先翻到')}`)).items.map(item => item.id)).toEqual([imageOnly.id]);
    await app.close();
    app = await workspace.open();
    expect(await json<RecordItem>(app, 'GET', `/api/records/${imageOnly.id}`)).toEqual(reordered);
    expect(await json<RecordItem>(app, 'GET', `/api/records/${shared.id}`)).toEqual(shared);
    const originalAfterRestart = await app.inject({ method: 'GET', url: first.originalUrl });
    expect(originalAfterRestart.statusCode).toBe(200);
    expect(originalAfterRestart.rawPayload.equals(bytes)).toBe(true);
    await json(app, 'PUT', `/api/records/${imageOnly.id}`, recordInput(reordered, { body: '照片已经从这一条移除。', media: [] }));
    await json(app, 'DELETE', `/api/records/${imageOnly.id}`);
    const other = await json<RecordItem>(app, 'GET', `/api/records/${shared.id}`);
    expect(other.media).toHaveLength(1);
    expect(other.media[0].caption).toBe('另一条记录自己的说明');
    expect((await app.inject({ method: 'GET', url: first.originalUrl })).rawPayload.equals(bytes)).toBe(true);
    expect((await app.inject({ method: 'GET', url: second.originalUrl })).statusCode).toBe(200);
    expect(await json<AppStats>(app, 'GET', '/api/stats')).toMatchObject({ records: 1, photos: 1 });
  });

  it('拒绝伪装图片与同一记录内的重复照片，校验失败保留已有内容', async () => {
    const existing = await record(app, { body: '已有的内容。' });
    const invalid = await app.inject({ method: 'POST', url: '/api/media', ...multipart([{ filename: '错误.jpg', buffer: Buffer.from('<html>not a photo</html>') }]) });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_PHOTO');
    expect(await readdir(join(workspace.root, '本地 数据', 'media'))).toEqual([]);
    const wrongField = await app.inject({ method: 'POST', url: '/api/media', ...multipart([{ filename: '文件.jpg', field: 'other', buffer: await photo() }]) });
    expect(wrongField.statusCode).toBe(400);
    const media = (await upload(app, [{ filename: '真的照片.jpg', buffer: await photo() }])).items[0];
    await json(app, 'PUT', `/api/records/${existing.id}`, recordInput(existing, { media: [{ id: media.id, caption: '一' }, { id: media.id, caption: '二' }] }), 400);
    expect(await json<RecordItem>(app, 'GET', `/api/records/${existing.id}`)).toEqual(existing);
  });
});
