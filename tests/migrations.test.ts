import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordInputSchema, yearbookInputSchema, type RecordItem, type YearbookItem } from '@yearbook/shared';
import { DATABASE_NAME, MIGRATIONS, migrate, type DataStore } from '../apps/server/src/db.js';
import { importMedia, mediaFiles } from '../apps/server/src/media.js';
import { saveRecord, type MediaRow } from '../apps/server/src/records.js';
import { saveYearbook } from '../apps/server/src/yearbooks.js';
import { createTestWorkspace, json, photo, restore, type TestWorkspace } from './helpers.js';

describe('旧版备份结构验证后升级', () => {
  let workspace: TestWorkspace;
  afterEach(async () => { if (workspace) await workspace.dispose(); });
  it.each([1, 2])('恢复只有迁移 %i 的旧资料，升级后原图、记录和原有版本关联完整', async version => {
    workspace = await createTestWorkspace();
    const legacy = join(workspace.root, `旧版 ${version} 资料`);
    for (const directory of ['', 'media', 'display', 'thumbnails', 'tmp']) await mkdir(join(legacy, directory), { recursive: true });
    const db = new Database(join(legacy, DATABASE_NAME));
    let saved: RecordItem; let book: YearbookItem | undefined; let files: string[];
    const original = await photo({ color: '#346961' });
    try {
      db.pragma('foreign_keys = ON'); migrate(db, version);
      const store = { db, dataDir: legacy } as DataStore;
      const imported = await importMedia(store, original, '旧照片 中文.jpg');
      saved = saveRecord(store, recordInputSchema.parse({ body: '升级前写下的日子。', occurredOn: '2008-02-29', media: [{ id: imported.item.id, caption: '还在原来的相册里' }], people: ['家人'], tags: ['旧时光'] }));
      if (version >= 2) book = saveYearbook(store, yearbookInputSchema.parse({ year: 2008, title: '旧版手工年册', introBody: '手工文字不能丢失。' }));
      const rows = db.prepare('SELECT * FROM media').all() as MediaRow[];
      files = [DATABASE_NAME, ...rows.flatMap(row => Object.values(mediaFiles(row)))];
    } finally { db.close(); }
    const zip = new AdmZip();
    const manifest = { format: 'yearbook-backup', formatVersion: 1, appVersion: '0.1.0', id: randomUUID(), createdAt: new Date().toISOString(),
      migrations: MIGRATIONS.filter(item => item.version <= version).map(({ version, checksum }) => ({ version, checksum })), files: [] as { path: string; size: number; sha256: string }[] };
    for (const path of files!) { const bytes = await readFile(join(legacy, path)); zip.addFile(path, bytes); manifest.files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    let target = await workspace.open('恢复后的 新目录');
    await restore(target, zip.toBuffer());
    expect(await json<RecordItem>(target, 'GET', `/api/records/${saved!.id}`)).toEqual(saved!);
    expect((await target.inject({ method: 'GET', url: saved!.media[0].originalUrl })).rawPayload.equals(original)).toBe(true);
    if (book) expect((await json<YearbookItem>(target, 'GET', `/api/yearbooks/${book.id}`)).introBody).toBe('手工文字不能丢失。');
    await target.close();
    const restored = new Database(join(workspace.root, '恢复后的 新目录', DATABASE_NAME));
    try { migrate(restored); migrate(restored); expect(restored.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([1, 2, 3, 4].map(version => ({ version }))); expect(restored.pragma('foreign_key_check')).toEqual([]); }
    finally { restored.close(); }
    target = await workspace.open('恢复后的 新目录');
    expect((await json<RecordItem>(target, 'GET', `/api/records/${saved!.id}`)).body).toBe(saved!.body);
  });
  it('拒绝迁移缺口，不能通过跳号忽略未执行的升级', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
      expect(() => migrate(db)).toThrow('不连续');
    } finally { db.close(); }
  });
});
