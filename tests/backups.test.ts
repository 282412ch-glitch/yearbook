import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupInfo, RecordItem, RecordList } from '@yearbook/shared';
import { DATABASE_NAME, RESTORE_STATE_NAME } from '../apps/server/src/db.js';
import { backup, createTestWorkspace, json, photo, record, restore, upload, type TestWorkspace } from './helpers.js';

type BackupManifest = { format: string; formatVersion: number; migrations: { version: number; checksum: string }[]; files: { path: string; size: number; sha256: string }[] };
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
function manifest(zip: AdmZip): BackupManifest {
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('备份缺少版本清单');
  return JSON.parse(entry.getData().toString('utf8')) as BackupManifest;
}

describe('独立中文空格目录的备份、恢复与迁移', () => {
  let workspace: TestWorkspace;
  let app: FastifyInstance;
  beforeEach(async () => { workspace = await createTestWorkspace(); app = await workspace.open('原始 数据'); });
  afterEach(async () => { await workspace.dispose(); });

  it('生成一致性快照并在全新目录恢复全部关联，恢复前备份能够再次找回被替换的数据', async () => {
    const bytes = await photo({ width: 90, height: 160, color: '#7f6653', date: '2019:12:31 23:50:00' });
    const landscape = await photo({ width: 250, height: 100, color: '#60826c' });
    const media = (await upload(app, [{ buffer: bytes, filename: '冬天 竖图.jpg' }, { buffer: landscape, filename: '河边.jpg' }])).items;
    const saved = await record(app, { title: '和家人散步', body: '小河结冰了。', occurredOn: '2019-12-31', people: ['妈妈'], tags: ['家人', '散步'], location: '河边', isFirst: true, media: [{ id: media[1].id, caption: '河面' }, { id: media[0].id, caption: '围巾' }] });
    const expected = await json<RecordItem>(app, 'POST', `/api/records/${saved.id}/reflections`, { body: '后来还一起走过很多次。' });
    const deleted = await record(app, { body: '垃圾箱中也要保存的内容。', media: [{ id: media[0].id, caption: '共用原照片' }] });
    await json(app, 'DELETE', `/api/records/${deleted.id}`);
    await backup(app);
    const dataDir = join(workspace.root, '原始 数据');
    await writeFile(join(dataDir, 'credentials.json'), '{"testOnly":"must-not-enter-backup"}');
    await mkdir(join(dataDir, 'exports'), { recursive: true });
    await writeFile(join(dataDir, 'exports', 'temporary.html'), 'temporary-export-marker');
    await writeFile(join(dataDir, 'tmp', 'cache.bin'), 'cache-marker');
    const snapshot = await backup(app);
    const zip = new AdmZip(snapshot.buffer);
    const inventory = manifest(zip);
    expect(inventory).toMatchObject({ format: 'yearbook-backup', formatVersion: 1 });
    expect(inventory.migrations.map(item => item.version)).toEqual([1, 2, 3, 4]);
    expect(zip.getEntries()).toHaveLength(8); // DB, 2 originals, 2 displays, 2 thumbnails, manifest.
    expect(zip.getEntries().every(entry => /^(manifest\.json|yearbook\.sqlite3|(media|display|thumbnails)\/[^/]+)$/.test(entry.entryName))).toBe(true);
    for (const file of inventory.files) {
      const archived = zip.getEntry(file.path)?.getData();
      expect(archived, file.path).toBeDefined();
      expect(archived!.length).toBe(file.size);
      expect(hash(archived!)).toBe(file.sha256);
    }
    const later = await record(app, { body: '备份之后才写的记录。' });
    let target = await workspace.open('恢复 新目录');
    const previousPhoto = await photo({ color: '#373d70' });
    const previousMedia = (await upload(target, [{ buffer: previousPhoto, filename: '恢复前.jpg' }])).items[0];
    const previous = await record(target, { body: '恢复之前也不能丢失的记录。', media: [{ id: previousMedia.id, caption: '原有说明' }] });
    const result = (await restore(target, snapshot.buffer)).json<{ restored: true; preRestoreBackup: BackupInfo }>();
    expect(result.restored).toBe(true);
    expect(result.preRestoreBackup.id).toBeTruthy();
    expect(await json<RecordItem>(target, 'GET', `/api/records/${expected.id}`)).toEqual(expected);
    expect((await json<RecordList>(target, 'GET', '/api/records')).items.map(item => item.id)).toEqual([expected.id]);
    expect((await json<RecordList>(target, 'GET', '/api/records?deleted=true')).items.map(item => item.id)).toEqual([deleted.id]);
    expect((await target.inject({ method: 'GET', url: media[0].originalUrl })).rawPayload.equals(bytes)).toBe(true);
    expect((await target.inject({ method: 'GET', url: media[1].originalUrl })).rawPayload.equals(landscape)).toBe(true);
    const thumbnail = await target.inject({ method: 'GET', url: media[0].thumbnailUrl });
    expect(await sharp(thumbnail.rawPayload).metadata()).toMatchObject({ width: 90, height: 160 });
    await json(target, 'GET', `/api/records/${previous.id}`, undefined, 404);
    await json(target, 'GET', `/api/records/${later.id}`, undefined, 404);
    await target.close();
    const database = new Database(join(workspace.root, '恢复 新目录', DATABASE_NAME), { readonly: true });
    try {
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(database.pragma('foreign_key_check')).toEqual([]);
        expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    } finally { database.close(); }
    target = await workspace.open('恢复 新目录');
    expect(await json<RecordItem>(target, 'GET', `/api/records/${expected.id}`)).toEqual(expected);
    expect((await json<RecordItem>(app, 'GET', `/api/records/${later.id}`)).body).toBe(later.body);
    const downloadable = await target.inject({ method: 'GET', url: `/api/backups/${result.preRestoreBackup.id}/download` });
    expect(downloadable.statusCode).toBe(200);
    const rescue = await workspace.open('恢复前 数据找回');
    await restore(rescue, downloadable.rawPayload);
    expect(await json<RecordItem>(rescue, 'GET', `/api/records/${previous.id}`)).toEqual(previous);
    expect((await rescue.inject({ method: 'GET', url: previousMedia.originalUrl })).rawPayload.equals(previousPhoto)).toBe(true);
  });

  it.each(['非 ZIP 文件', '原图哈希不符', '夹带非白名单文件', '不支持的备份版本'] as const)('拒绝%s，原有记录、照片和已有备份保持可用', async kind => {
    const bytes = await photo();
    const media = (await upload(app, [{ buffer: bytes, filename: '原有.jpg' }])).items[0];
    const existing = await record(app, { body: '坏包不能覆盖这一条。', media: [{ id: media.id, caption: '原有照片' }] });
    const snapshot = await backup(app);
    let invalid: Buffer;
    if (kind === '非 ZIP 文件') invalid = Buffer.from('not a zip');
    else {
      const zip = new AdmZip(snapshot.buffer);
      if (kind === '原图哈希不符') {
        const original = manifest(zip).files.find(file => file.path.startsWith('media/'))!;
        const altered = Buffer.from(zip.getEntry(original.path)!.getData());
        altered[altered.length - 1] ^= 1;
        zip.updateFile(original.path, altered);
      } else if (kind === '夹带非白名单文件') zip.addFile('credentials.json', Buffer.from('test-only-secret-marker'));
      else zip.updateFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest(zip), formatVersion: 999 })));
      invalid = zip.toBuffer();
    }
    const rejected = await restore(app, invalid, 400);
    expect(rejected.json().error).toMatchObject({ code: 'INVALID_BACKUP' });
    expect(rejected.json().error.message).toContain('当前数据未修改');
    expect(await json<RecordItem>(app, 'GET', `/api/records/${existing.id}`)).toEqual(existing);
    expect((await app.inject({ method: 'GET', url: media.originalUrl })).rawPayload.equals(bytes)).toBe(true);
    expect((await json<{ items: BackupInfo[] }>(app, 'GET', '/api/backups')).items.map(item => item.id)).toEqual([snapshot.item.id]);
    expect(await readdir(join(workspace.root, '原始 数据', 'tmp'))).toEqual([]);
    const next = await record(app, { body: '拒绝坏包后仍可正常写入。' });
    expect((await json<RecordItem>(app, 'GET', `/api/records/${next.id}`)).body).toBe(next.body);
  });

  it('即使文件哈希被重新计算，也拒绝数据库中失效的照片关联', async () => {
    const media = (await upload(app, [{ buffer: await photo(), filename: '有效.jpg' }])).items[0];
    const existing = await record(app, { body: '照片关联必须完整。', media: [{ id: media.id, caption: '有效关系' }] });
    const snapshot = await backup(app);
    const zip = new AdmZip(snapshot.buffer);
    const inventory = manifest(zip);
    const alteredPath = join(workspace.root, '有坏关联的 数据库.sqlite3');
    await writeFile(alteredPath, zip.getEntry(DATABASE_NAME)!.getData());
    const alteredDb = new Database(alteredPath);
    try {
      alteredDb.pragma('foreign_keys = OFF');
      alteredDb.prepare('UPDATE record_media SET media_id = ?').run(randomUUID());
    } finally { alteredDb.close(); }
    const altered = await readFile(alteredPath);
    zip.updateFile(DATABASE_NAME, altered);
    const databaseManifest = inventory.files.find(file => file.path === DATABASE_NAME)!;
    databaseManifest.size = altered.length;
    databaseManifest.sha256 = hash(altered);
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(inventory)));
    const rejected = await restore(app, zip.toBuffer(), 400);
    expect(rejected.json().error.message).toContain('关联');
    expect(await json<RecordItem>(app, 'GET', `/api/records/${existing.id}`)).toEqual(existing);
  });

  it('恢复期间中断后，下次打开自动找回原数据库和已移动的原图', async () => {
    const bytes = await photo({ color: '#98685d' });
    const media = (await upload(app, [{ buffer: bytes, filename: '中断前.jpg' }])).items[0];
    const original = await record(app, { body: '中断后应回到这份记录。', occurredOn: '2024-06-01', media: [{ id: media.id, caption: '中断前的关联' }] });
    await app.close();
    const replacement = await workspace.open('临时替换 数据');
    const unwanted = await record(replacement, { body: '未完整恢复的替换数据。' });
    await replacement.close();
    const sourceDir = join(workspace.root, '原始 数据');
    const transaction = randomUUID();
    const rollback = join(sourceDir, 'tmp', `rollback-${transaction}`);
    await mkdir(rollback);
    await writeFile(join(sourceDir, RESTORE_STATE_NAME), JSON.stringify({ transaction }));
    await rename(join(sourceDir, DATABASE_NAME), join(rollback, DATABASE_NAME));
    await rename(join(sourceDir, 'media'), join(rollback, 'media'));
    await copyFile(join(workspace.root, '临时替换 数据', DATABASE_NAME), join(sourceDir, DATABASE_NAME));
    await mkdir(join(sourceDir, 'media'));
    app = await workspace.open('原始 数据');
    expect(await json<RecordItem>(app, 'GET', `/api/records/${original.id}`)).toEqual(original);
    await json(app, 'GET', `/api/records/${unwanted.id}`, undefined, 404);
    expect((await app.inject({ method: 'GET', url: media.originalUrl })).rawPayload.equals(bytes)).toBe(true);
    await expect(access(join(sourceDir, RESTORE_STATE_NAME))).rejects.toThrow();
    await app.close();
    app = await workspace.open('原始 数据');
    expect(await json<RecordItem>(app, 'GET', `/api/records/${original.id}`)).toEqual(original);
  });
});
