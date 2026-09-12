import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordInputSchema, yearbookInputSchema, type BackupInfo, type LetterDetail, type LetterList, type LetterSummary, type RecordItem, type YearbookItem } from '@yearbook/shared';
import { DATABASE_NAME, MIGRATIONS, migrate, type DataStore } from '../apps/server/src/db.js';
import { importMedia, mediaFiles } from '../apps/server/src/media.js';
import { saveRecord } from '../apps/server/src/records.js';
import { saveYearbook } from '../apps/server/src/yearbooks.js';
import { backup, createTestWorkspace, json, photo, record, restore, upload, type TestWorkspace } from './helpers.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Manifest = { format: string; formatVersion: number; migrations: { version: number; checksum: string }[]; files: { path: string; size: number; sha256: string }[] };

describe('未来信备份、恢复与 004 → 005 升级', () => {
  let workspace: TestWorkspace;
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2036, 11, 31, 23, 0, 0));
    workspace = await createTestWorkspace(); app = await workspace.open('原信件 数据');
  });
  afterEach(async () => { await workspace.dispose(); vi.useRealTimers(); });

  it('新目录恢复有序照片、草稿、封存与已读状态和软删除；到期访问后原信可完整读回', async () => {
    const original = [await photo({ color: '#8d745e' }), await photo({ color: '#50785e', width: 70, height: 120 })];
    const media = (await upload(app, original.map((buffer, index) => ({ buffer, filename: `信件照片 ${index}.jpg` })))).items;
    const source = await record(app, { body: '普通记录保持关联', occurredOn: '2036-12-31', media: [{ id: media[0].id, caption: '记录图注' }] });
    const book = await json<YearbookItem>(app, 'POST', '/api/yearbooks', { year: 2036, title: '和信一起备份的年册', coverMediaId: media[0].id }, 201);
    const draft = await json<LetterDetail>(app, 'POST', '/api/letters', { body: '没写完的草稿', media: [{ id: media[0].id, caption: '草稿图注' }] }, 201);
    const future = await json<LetterDetail>(app, 'POST', '/api/letters', { title: '明天再拆', body: '年末封存的原正文', unlockOn: '2037-01-01', media: [{ id: media[1].id, caption: '竖图在前' }, { id: media[0].id, caption: '横图在后' }] }, 201);
    await json(app, 'POST', `/api/letters/${future.id}/seal`, {});
    const ready = await json<LetterDetail>(app, 'POST', '/api/letters', { body: '今天读过的信', unlockOn: '2036-12-31' }, 201);
    await json(app, 'POST', `/api/letters/${ready.id}/seal`, {});
    const read = await json<LetterDetail>(app, 'POST', `/api/letters/${ready.id}/read`, {});
    const trash = await json<LetterDetail>(app, 'POST', '/api/letters', { body: '删除也保留的草稿', media: [{ id: media[0].id }] }, 201);
    await json(app, 'DELETE', `/api/letters/${trash.id}`);
    const copy = await backup(app);
    const inventory = JSON.parse(new AdmZip(copy.buffer).getEntry('manifest.json')!.getData().toString('utf8')) as Manifest;
    expect(inventory.migrations.map(item => item.version)).toEqual(MIGRATIONS.map(item => item.version));
    let target = await workspace.open('全新目录 恢复信件');
    const before = await json<LetterDetail>(target, 'POST', '/api/letters', { body: '恢复之前的信' }, 201);
    const result = (await restore(target, copy.buffer)).json<{ restored: true; preRestoreBackup: BackupInfo }>();
    expect(result.restored).toBe(true);
    expect(await json(target, 'GET', `/api/letters/${draft.id}`)).toEqual(draft);
    expect(await json(target, 'GET', `/api/letters/${read.id}`)).toEqual(read);
    expect((await json<LetterList>(target, 'GET', '/api/letters?deleted=true')).items[0].id).toBe(trash.id);
    expect((await json<LetterDetail>(target, 'GET', `/api/letters/${future.id}`)).canRead).toBe(false);
    expect((await target.inject({ method: 'GET', url: media[1].displayUrl })).statusCode).toBe(403);
    expect((await json<YearbookItem>(target, 'GET', `/api/yearbooks/${book.id}`)).coverMediaId).toBe(media[0].id);
    expect((await json<RecordItem>(target, 'GET', `/api/records/${source.id}`)).media[0].id).toBe(media[0].id);
    const preRestore = await target.inject({ method: 'GET', url: `/api/backups/${result.preRestoreBackup.id}/download` });
    const rescued = await workspace.open('恢复前 信件找回');
    await restore(rescued, preRestore.rawPayload);
    expect(await json(rescued, 'GET', `/api/letters/${before.id}`)).toEqual(before);
    await target.close();
    vi.setSystemTime(new Date(2037, 0, 1, 0, 0, 0));
    target = await workspace.open('全新目录 恢复信件');
    expect((await json<LetterSummary>(target, 'GET', '/api/letters/summary')).dueUnread).toBe(1);
    const recovered = await json<LetterDetail>(target, 'POST', `/api/letters/${future.id}/read`, {});
    expect(recovered.body).toBe(future.body);
    expect(recovered.media!.map(item => ({ id: item.id, caption: item.caption }))).toEqual(future.media!.map(item => ({ id: item.id, caption: item.caption })));
    for (const [index, photo] of media.entries()) expect((await target.inject({ method: 'GET', url: photo.originalUrl })).rawPayload.equals(original[index])).toBe(true);
    await target.close();
    const db = new Database(join(workspace.root, '全新目录 恢复信件', DATABASE_NAME), { readonly: true });
    try {
      expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect((db.prepare('SELECT COUNT(*) AS count FROM future_letters').get() as { count: number }).count).toBe(4);
    } finally { db.close(); }
  });

  it('按旧版 004 原结构验证并升级，保留原记录、媒体与年册，未来信初始为空', async () => {
    const legacy = join(workspace.root, '004 旧资料');
    for (const folder of ['', 'media', 'display', 'thumbnails', 'tmp']) await mkdir(join(legacy, folder), { recursive: true });
    const db = new Database(join(legacy, DATABASE_NAME));
    let source: RecordItem;
    let book: YearbookItem;
    let files: string[];
    const original = await photo({ color: '#427161' });
    try {
      db.pragma('foreign_keys = ON'); migrate(db, 4);
      const oldStore = { db, dataDir: legacy } as DataStore;
      const image = (await importMedia(oldStore, original, '旧照片.jpg')).item;
      source = saveRecord(oldStore, recordInputSchema.parse({ body: '升级前记录', occurredOn: '2036-12-31', media: [{ id: image.id, caption: '原图注' }] }));
      book = saveYearbook(oldStore, yearbookInputSchema.parse({ year: 2036, coverMediaId: image.id, title: '原手动年册' }));
      files = [DATABASE_NAME, ...Object.values(mediaFiles(db.prepare('SELECT hash,extension FROM media').get() as { hash: string; extension: string }))];
    } finally { db.close(); }
    const zip = new AdmZip();
    const manifest = { format: 'yearbook-backup', formatVersion: 1, appVersion: '0.1.0', id: randomUUID(), createdAt: new Date().toISOString(),
      migrations: MIGRATIONS.filter(item => item.version <= 4).map(({ version, checksum }) => ({ version, checksum })), files: [] as { path: string; size: number; sha256: string }[] };
    for (const path of files!) { const bytes = await readFile(join(legacy, path)); zip.addFile(path, bytes); manifest.files.push({ path, size: bytes.length, sha256: hash(bytes) }); }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await restore(app, zip.toBuffer());
    expect(await json(app, 'GET', `/api/records/${source!.id}`)).toEqual(source!);
    expect((await json<YearbookItem>(app, 'GET', `/api/yearbooks/${book!.id}`)).title).toBe('原手动年册');
    expect((await app.inject({ method: 'GET', url: source!.media[0].originalUrl })).rawPayload.equals(original)).toBe(true);
    expect((await json<LetterList>(app, 'GET', '/api/letters')).total).toBe(0);
    await app.close();
    const upgraded = new Database(join(workspace.root, '原信件 数据', DATABASE_NAME));
    try {
      migrate(upgraded); migrate(upgraded);
      expect(upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(MIGRATIONS.map(({ version }) => ({ version })));
      expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    } finally { upgraded.close(); }
    app = await workspace.open('原信件 数据');
    const created = await json<LetterDetail>(app, 'POST', '/api/letters', { body: '升级后可继续写信' }, 201);
    expect(created.status).toBe('draft');
  });

  it.each(['日期无效', '照片顺序缺口', '封存内容被清空', '照片关联失效'] as const)('拒绝被重算文件哈希的坏备份：%s；保留现有数据', async kind => {
    const media = (await upload(app, [{ buffer: await photo({ color: '#809281' }), filename: '完整关联.jpg' }])).items[0];
    const letter = await json<LetterDetail>(app, 'POST', '/api/letters', { body: '现有信件不能丢', unlockOn: '2037-01-01', media: [{ id: media.id, caption: '有效图注' }] }, 201);
    await json(app, 'POST', `/api/letters/${letter.id}/seal`, {});
    const copy = await backup(app);
    const zip = new AdmZip(copy.buffer);
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8')) as Manifest;
    const alteredPath = join(workspace.root, `篡改副本 ${randomUUID()}.sqlite3`);
    await writeFile(alteredPath, zip.getEntry(DATABASE_NAME)!.getData());
    const altered = new Database(alteredPath);
    try {
      altered.pragma('foreign_keys = OFF');
      if (kind === '日期无效') altered.prepare("UPDATE future_letters SET unlock_on = '2037-02-29'").run();
      else if (kind === '照片顺序缺口') altered.prepare('UPDATE future_letter_media SET position = 7').run();
      else if (kind === '封存内容被清空') { altered.prepare('DELETE FROM future_letter_media').run(); altered.prepare("UPDATE future_letters SET body = ''").run(); }
      else altered.prepare('UPDATE future_letter_media SET media_id = ?').run(randomUUID());
    } finally { altered.close(); }
    const changed = await readFile(alteredPath);
    zip.updateFile(DATABASE_NAME, changed);
    const entry = manifest.files.find(file => file.path === DATABASE_NAME)!;
    entry.size = changed.length; entry.sha256 = hash(changed);
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const rejected = await restore(app, zip.toBuffer(), 400);
    expect(rejected.json().error.code).toBe('INVALID_BACKUP');
    expect((await json<LetterList>(app, 'GET', '/api/letters')).total).toBe(1);
    vi.setSystemTime(new Date(2037, 0, 1, 0));
    const intact = await json<LetterDetail>(app, 'GET', `/api/letters/${letter.id}`);
    expect(intact.body).toBe('现有信件不能丢'); expect(intact.media![0].caption).toBe('有效图注');
    expect((await app.inject({ method: 'GET', url: media.originalUrl })).statusCode).toBe(200);
  });
});
