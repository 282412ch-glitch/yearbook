import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, rm, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { BackupInfo } from '@yearbook/shared';
import { idSchema, recordInputSchema, reflectionSchema, dateSchema, yearbookInputSchema, yearbookChapterKindSchema, yearbookBlockTypeSchema, yearbookTemplateSchema, unknownCapabilities } from '@yearbook/shared';
import { DATABASE_NAME, RESTORE_STATE_NAME, MIGRATIONS, migrate, openDatabase, type DataStore } from './db.js';
import { mediaFiles } from './media.js';
import { getRecord, type MediaRow } from './records.js';
import { AppError } from './errors.js';
import { validateAiBackupData, validateLetterBackupData } from './backup-validation.js';

export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const backupPattern = /^yearbook-(\d{8}T\d{9}Z)-([a-f0-9-]{36})\.zip$/;
const manifestSchema = z.object({
  format: z.literal('yearbook-backup'), formatVersion: z.literal(1), appVersion: z.literal('0.1.0'),
  id: idSchema, createdAt: z.string().datetime(),
  migrations: z.array(z.object({ version: z.number().int(), checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
  files: z.array(z.object({ path: z.string().max(200), size: z.number().int().nonnegative().max(MAX_EXPANDED_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(25000),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

function dateFromName(part: string) {
  return `${part.slice(0, 4)}-${part.slice(4, 6)}-${part.slice(6, 8)}T${part.slice(9, 11)}:${part.slice(11, 13)}:${part.slice(13, 15)}.${part.slice(15, 18)}Z`;
}

export async function listBackups(store: DataStore): Promise<BackupInfo[]> {
  const items: BackupInfo[] = [];
  for (const name of await readdir(join(store.dataDir, 'backups'))) {
    const match = name.match(backupPattern);
    if (!match || !idSchema.safeParse(match[2]).success) continue;
    const info = await stat(join(store.dataDir, 'backups', name));
    if (!info.isFile()) continue;
    items.push({ id: match[2], filename: name, createdAt: dateFromName(match[1]), size: info.size });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Caller holds DataStore.write for the complete snapshot and media read. */
export async function createBackup(store: DataStore): Promise<BackupInfo> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const filename = `yearbook-${createdAt.replace(/[-:.]/g, '')}-${id}.zip`;
  const staging = join(store.dataDir, 'tmp', `backup-${id}`);
  await mkdir(staging, { recursive: true });
  try {
    await store.db.backup(join(staging, DATABASE_NAME));
    const snapshot = new Database(join(staging, DATABASE_NAME));
    try {
      snapshot.prepare('UPDATE model_profiles SET credential_ref = NULL, capabilities_json = ?').run(JSON.stringify(unknownCapabilities()));
      snapshot.exec('VACUUM');
    } finally { snapshot.close(); }
    const media = store.db.prepare('SELECT * FROM media ORDER BY id').all() as MediaRow[];
    const expected = [DATABASE_NAME, ...media.flatMap(row => Object.values(mediaFiles(row)))];
    if (expected.length > 25000) throw new AppError(400, 'BACKUP_LIMIT', '当前内置备份最多支持 8,333 张照片，请使用数据目录的完整离线副本');
    const zip = new AdmZip();
    const manifest: Manifest = { format: 'yearbook-backup', formatVersion: 1, appVersion: '0.1.0', id, createdAt, migrations: MIGRATIONS.map(m => ({ version: m.version, checksum: m.checksum })), files: [] };
    let total = 0;
    for (const relative of expected) {
      const file = await readFile(join(relative === DATABASE_NAME ? staging : store.dataDir, relative));
      total += file.length;
      if (total > MAX_EXPANDED_BYTES) throw new AppError(400, 'BACKUP_LIMIT', '当前内置 ZIP 备份限未压缩数据 1 GB，请使用数据目录的完整离线副本');
      manifest.files.push({ path: relative, size: file.length, sha256: sha256(file) });
      zip.addFile(relative, file);
    }
    for (const row of media) {
      const original = manifest.files.find(file => file.path === mediaFiles(row).original)!;
      if (original.sha256 !== row.hash || original.size !== row.size) throw new AppError(409, 'MEDIA_CORRUPTED', '原图文件校验失败。现有数据未修改，请检查存储设备或从可信备份恢复');
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const buffer = zip.toBuffer();
    if (buffer.length > MAX_BACKUP_BYTES) throw new AppError(400, 'BACKUP_LIMIT', '当前内置 ZIP 备份限压缩后 512 MB，请使用数据目录的完整离线副本');
    const temporary = join(staging, 'backup.zip');
    await writeFile(temporary, buffer, { flag: 'wx' });
    await rename(temporary, join(store.dataDir, 'backups', filename));
    return { id, filename, createdAt, size: buffer.length };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

function validEntryPath(name: string) {
  return name === DATABASE_NAME || name === 'manifest.json' || /^(media\/[a-f0-9]{64}\.(jpg|png|webp|gif|avif|heif|tif)|(display|thumbnails)\/[a-f0-9]{64}\.jpg)$/.test(name);
}

function schemaDescription(db: Database.Database) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}

function checkDatabase(file: string, manifest: Manifest) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const reference = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('数据库完整性检查失败');
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('数据库存在失效的关联');
    const migrations = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
    const supported = MIGRATIONS.slice(0, migrations.length).map(m => ({ version: m.version, checksum: m.checksum }));
    if (!migrations.length || migrations.length > MIGRATIONS.length) throw new Error('数据库迁移版本不受支持');
    if (JSON.stringify(migrations) !== JSON.stringify(supported) || JSON.stringify(manifest.migrations) !== JSON.stringify(supported)) throw new Error('数据库版本与此应用不匹配');
    migrate(reference, migrations.at(-1)!.version);
    if (JSON.stringify(schemaDescription(db)) !== JSON.stringify(schemaDescription(reference))) throw new Error('数据库表结构不符合此应用版本');
    const rows = db.prepare('SELECT * FROM media').all() as MediaRow[];
    const mediaSchema = z.object({ id: idSchema, hash: z.string().regex(/^[a-f0-9]{64}$/), extension: z.enum(['jpg', 'png', 'webp', 'gif', 'avif', 'heif', 'tif']), filename: z.string().min(1).max(255), mime: z.string().startsWith('image/'), size: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(), suggested_date: dateSchema.nullable(), created_at: z.string().datetime() });
    for (const row of rows) mediaSchema.parse(row);
    for (const { id } of db.prepare('SELECT id FROM records').all() as { id: string }[]) {
      const record = getRecord({ db } as DataStore, id);
      recordInputSchema.parse({ title: record.title, body: record.body, occurredOn: record.occurredOn, people: record.people, tags: record.tags, location: record.location, isFirst: record.isFirst, includeInYearbook: record.includeInYearbook, media: record.media.map(m => ({ id: m.id, caption: m.caption })) });
      z.string().datetime().parse(record.createdAt);
      z.string().datetime().parse(record.updatedAt);
      z.string().datetime().nullable().parse(record.deletedAt);
      record.reflections.forEach(reflection => { idSchema.parse(reflection.id); reflectionSchema.parse({ body: reflection.body }); z.string().datetime().parse(reflection.createdAt); });
    }
    const yearbooks = (migrations.length >= 2 ? db.prepare('SELECT * FROM yearbooks').all() : []) as { id: string; year: number; title: string; template: string; cover_media_id: string | null; intro_body: string; created_at: string; updated_at: string; deleted_at: string | null }[];
    for (const book of yearbooks) {
      idSchema.parse(book.id); z.number().int().min(1).max(9999).parse(book.year); z.string().max(300).parse(book.title); yearbookTemplateSchema.parse(book.template);
      if (book.cover_media_id) { idSchema.parse(book.cover_media_id); if (!db.prepare('SELECT id FROM media WHERE id = ?').get(book.cover_media_id)) throw new Error('年册封面关联不存在'); }
      z.string().datetime().parse(book.created_at); z.string().datetime().parse(book.updated_at); z.string().datetime().nullable().parse(book.deleted_at);
      const chapters = db.prepare('SELECT * FROM yearbook_chapters WHERE yearbook_id = ? ORDER BY position').all(book.id) as { id: string; kind: string; title: string; body: string; position: number; created_at: string; updated_at: string }[];
      const chapterIds = new Set<string>();
      for (const chapter of chapters) {
        idSchema.parse(chapter.id); if (chapterIds.has(chapter.id)) throw new Error('年册章节编号重复'); chapterIds.add(chapter.id); yearbookChapterKindSchema.parse(chapter.kind); z.string().max(300).parse(chapter.title); z.string().max(100000).parse(chapter.body); z.number().int().nonnegative().parse(chapter.position);
        const blocks = db.prepare('SELECT * FROM yearbook_blocks WHERE chapter_id = ? ORDER BY position').all(chapter.id) as { id: string; type: string; body: string; media_id: string | null; record_id: string | null; caption: string; position: number; created_at: string; updated_at: string }[];
        for (const block of blocks) {
          idSchema.parse(block.id); yearbookBlockTypeSchema.parse(block.type); z.string().max(100000).parse(block.body); z.string().max(2000).parse(block.caption); z.number().int().nonnegative().parse(block.position);
          if (block.media_id) { idSchema.parse(block.media_id); if (!db.prepare('SELECT id FROM media WHERE id = ?').get(block.media_id)) throw new Error('年册图片关联不存在'); }
          if (block.record_id) { idSchema.parse(block.record_id); if (!db.prepare('SELECT id FROM records WHERE id = ?').get(block.record_id)) throw new Error('年册记录块关联不存在'); }
        }
        for (const source of db.prepare('SELECT record_id FROM yearbook_sources WHERE chapter_id = ?').all(chapter.id) as { record_id: string }[]) { idSchema.parse(source.record_id); if (!db.prepare('SELECT id FROM records WHERE id = ?').get(source.record_id)) throw new Error('年册来源记录关联不存在'); }
      }
      for (const version of db.prepare('SELECT snapshot_json FROM yearbook_versions WHERE yearbook_id = ?').all(book.id) as { snapshot_json: string }[]) yearbookInputSchema.parse(JSON.parse(version.snapshot_json));
    }
    validateAiBackupData(db, migrations.at(-1)!.version);
    validateLetterBackupData(db, migrations.at(-1)!.version);
    const required = new Set([DATABASE_NAME, ...rows.flatMap(row => Object.values(mediaFiles(row)))]);
    if (required.size !== manifest.files.length || manifest.files.some(file => !required.has(file.path))) throw new Error('媒体文件清单与数据库关联不一致');
    for (const row of rows) {
      const original = manifest.files.find(file => file.path === mediaFiles(row).original);
      if (!original || original.sha256 !== row.hash || original.size !== row.size) throw new Error('原图哈希与数据库不一致');
    }
  } finally { db.close(); reference.close(); }
}

async function validateAndExtract(buffer: Buffer, staging: string) {
  if (!buffer.length || buffer.length > MAX_BACKUP_BYTES) throw new AppError(413, 'BACKUP_SIZE', '请选择不超过 512 MB 的一年一册备份 ZIP');
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (entries.length < 2 || entries.length > 25001) throw new Error('文件数超出备份限制');
    const seen = new Set<string>();
    let expanded = 0;
    for (const entry of entries) {
      const mode = (entry.attr >>> 16) & 0o170000;
      if (entry.isDirectory || mode === 0o120000 || !validEntryPath(entry.entryName) || seen.has(entry.entryName)) throw new Error('备份包含重复、不允许或不安全的文件路径');
      seen.add(entry.entryName);
      expanded += entry.header.size;
      if (expanded > MAX_EXPANDED_BYTES || entry.header.size > MAX_EXPANDED_BYTES) throw new Error('解压大小超出备份限制');
    }
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry || manifestEntry.header.size > 10 * 1024 * 1024) throw new Error('缺少有效版本清单');
    const manifest = manifestSchema.parse(JSON.parse(manifestEntry.getData().toString('utf8')));
    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || manifest.files.length !== entries.length - 1) throw new Error('文件清单不完整或重复');
    for (const file of manifest.files) {
      if (file.path === 'manifest.json' || !validEntryPath(file.path)) throw new Error('文件清单路径无效');
      const entry = zip.getEntry(file.path);
      if (!entry || entry.header.size !== file.size) throw new Error(`文件尺寸校验失败：${file.path}`);
      const data = entry.getData();
      if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`文件哈希校验失败：${file.path}`);
      const target = resolve(staging, file.path);
      if (!target.startsWith(resolve(staging) + sep)) throw new Error('文件路径越界');
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
    }
    checkDatabase(join(staging, DATABASE_NAME), manifest);
    // Upgrade only the already verified staging copy. The live database is untouched on failure.
    const upgraded = new Database(join(staging, DATABASE_NAME));
    try {
      upgraded.pragma('foreign_keys = ON');
      migrate(upgraded);
      // Never let a restored/modified URL acquire an existing system credential by copying a reference.
      upgraded.prepare('UPDATE model_profiles SET credential_ref = NULL, capabilities_json = ?').run(JSON.stringify(unknownCapabilities()));
      if (upgraded.pragma('integrity_check', { simple: true }) !== 'ok' || (upgraded.pragma('foreign_key_check') as unknown[]).length) throw new Error('旧备份升级后校验未通过');
    } finally { upgraded.close(); }
    for (const directory of ['media', 'display', 'thumbnails']) await mkdir(join(staging, directory), { recursive: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_BACKUP', `备份校验未通过，当前数据未修改：${error instanceof z.ZodError ? '备份结构或内容格式无效' : error instanceof Error ? error.message : '无法读取备份'}`);
  }
}

/** Validate first; preserve a downloadable snapshot before swapping. Roll back on any swap/open error. */
export async function restoreBackup(store: DataStore, buffer: Buffer): Promise<{ restored: true; preRestoreBackup: BackupInfo }> {
  const transaction = randomUUID();
  const staging = join(store.dataDir, 'tmp', `restore-${transaction}`);
  const rollback = join(store.dataDir, 'tmp', `rollback-${transaction}`);
  await mkdir(staging, { recursive: true });
  try {
    await validateAndExtract(buffer, staging);
    const preRestoreBackup = await createBackup(store);
    await mkdir(rollback);
    const journal = join(store.dataDir, RESTORE_STATE_NAME);
    await writeFile(journal, JSON.stringify({ transaction }), { flag: 'wx' });
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    store.db.close();
    const names = [DATABASE_NAME, 'media', 'display', 'thumbnails'];
    const movedOld: string[] = [];
    const movedNew: string[] = [];
    try {
      // A cleanly closed SQLite connection has checkpointed and removed WAL/SHM.
      for (const sidecar of [`${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) await rm(join(store.dataDir, sidecar), { force: true });
      for (const name of names) { await rename(join(store.dataDir, name), join(rollback, name)); movedOld.push(name); }
      for (const name of names) { await rename(join(staging, name), join(store.dataDir, name)); movedNew.push(name); }
      store.db = openDatabase(store.dataDir);
      await rm(journal);
    } catch (error) {
      if (store.db.open) store.db.close();
      for (const sidecar of [`${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) await rm(join(store.dataDir, sidecar), { force: true });
      for (const name of movedNew.reverse()) await rm(join(store.dataDir, name), { force: true, recursive: true });
      for (const name of movedOld.reverse()) await rename(join(rollback, name), join(store.dataDir, name));
      store.db = openDatabase(store.dataDir);
      await rm(journal, { force: true });
      throw new AppError(500, 'RESTORE_FAILED', `恢复未完成，已保留原数据及恢复前备份：${error instanceof Error ? error.message : '文件替换失败'}`);
    }
    await rm(rollback, { recursive: true, force: true }).catch(() => undefined);
    return { restored: true, preRestoreBackup };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
