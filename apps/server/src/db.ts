import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const DATABASE_NAME = 'yearbook.sqlite3';
export const RESTORE_STATE_NAME = 'restore-state.json';
export const MIGRATIONS = [
  { version: 1, filename: '001_core.sql' },
  { version: 2, filename: '002_yearbooks.sql' },
  { version: 3, filename: '003_models.sql' },
  { version: 4, filename: '004_ai.sql' },
].map(migration => {
  const sql = readFileSync(new URL(`../migrations/${migration.filename}`, import.meta.url), 'utf8');
  return { ...migration, sql, checksum: createHash('sha256').update(sql).digest('hex') };
});

export function migrate(db: Database.Database, throughVersion = MIGRATIONS.at(-1)!.version) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, filename TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
  if (applied.some((item, index) => item.version !== MIGRATIONS[index]?.version || item.version > throughVersion)) throw new Error('数据库迁移记录不连续或版本高于此应用');
  for (const item of applied) {
    const expected = MIGRATIONS.find(m => m.version === item.version);
    if (!expected || expected.checksum !== item.checksum) throw new Error(`数据库迁移 ${item.version} 与此应用不兼容，请保留数据并使用匹配的应用版本`);
  }
  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version > throughVersion) continue;
      if (applied.some(m => m.version === migration.version)) continue;
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, filename, checksum, applied_at) VALUES (?, ?, ?, ?)').run(migration.version, migration.filename, migration.checksum, new Date().toISOString());
    }
  })();
}

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, DATABASE_NAME));
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** A process interruption during restore conservatively rolls back at the next start. */
function recoverInterruptedRestore(dataDir: string) {
  const journal = join(dataDir, RESTORE_STATE_NAME);
  if (!existsSync(journal)) return;
  let transaction: string;
  try {
    const state = JSON.parse(readFileSync(journal, 'utf8')) as { transaction?: string };
    if (!state.transaction || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.transaction)) throw new Error('无效事务编号');
    transaction = state.transaction;
  } catch { throw new Error('恢复状态文件无法读取。原数据与恢复前备份已保留，请勿删除数据目录'); }
  const rollback = join(dataDir, 'tmp', `rollback-${transaction}`);
  // Only discard a replacement database's WAL. An unmoved original may still need its WAL.
  if (existsSync(join(rollback, DATABASE_NAME))) {
    for (const suffix of ['-wal', '-shm']) rmSync(join(dataDir, DATABASE_NAME + suffix), { force: true });
  }
  for (const name of [DATABASE_NAME, 'media', 'display', 'thumbnails']) {
    const original = join(rollback, name);
    if (!existsSync(original)) continue;
    const current = join(dataDir, name);
    rmSync(current, { recursive: true, force: true });
    renameSync(original, current);
  }
  rmSync(journal);
  rmSync(rollback, { recursive: true, force: true });
}

function lockDataDirectory(dataDir: string): () => void {
  const file = join(dataDir, '.instance-lock');
  const owner = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, owner, createdAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, contents, { flag: 'wx' });
      return () => {
        try { if (readFileSync(file, 'utf8') === contents) rmSync(file); } catch { /* Never remove another instance's lock. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: string;
      let pid: number;
      try {
        existing = readFileSync(file, 'utf8');
        pid = JSON.parse(existing).pid;
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid');
      } catch { throw new Error('数据目录实例锁无法读取。请确认本应用已停止后保留数据并检查 .instance-lock 文件'); }
      let alive = true;
      try { process.kill(pid, 0); } catch (check) { if ((check as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error(`此数据目录已由进程 ${pid} 使用，请打开已运行的应用或先停止它`);
      // Only discard an unchanged lock owned by a process confirmed to have exited.
      try { if (readFileSync(file, 'utf8') === existing) rmSync(file); } catch { /* Another opener may have removed the stale lock. */ }
    }
  }
  throw new Error('无法取得数据目录实例锁，请确认没有其他应用实例正在启动');
}

/** Writes and snapshot/restore operations are serialized across their async phases. */
export class DataStore {
  db: Database.Database;
  readonly dataDir: string;
  private releaseLock: () => void;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.releaseLock = lockDataDirectory(this.dataDir);
    try {
      recoverInterruptedRestore(this.dataDir);
      for (const directory of ['media', 'display', 'thumbnails', 'backups', 'exports', 'tmp']) mkdirSync(join(this.dataDir, directory), { recursive: true });
      this.db = openDatabase(this.dataDir);
    } catch (error) { this.releaseLock(); throw error; }
  }
  write<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async close() { await this.tail; try { if (this.db.open) this.db.close(); } finally { this.releaseLock(); } }
}
