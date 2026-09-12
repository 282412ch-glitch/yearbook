import { randomUUID } from 'node:crypto';
import type { RecordInput, RecordItem, RecordList, RecordQuery, MediaItem, Metadata, CalendarData } from '@yearbook/shared';
import { idSchema } from '@yearbook/shared';
import { z } from 'zod';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';

export type MediaRow = { id: string; hash: string; extension: string; filename: string; mime: string; size: number; width: number; height: number; suggested_date: string | null; created_at: string };
export function presentMedia(row: MediaRow): MediaItem {
  return { id: row.id, filename: row.filename, mime: row.mime, size: row.size, width: row.width, height: row.height, suggestedDate: row.suggested_date, createdAt: row.created_at, originalUrl: `/api/media/${row.id}/original`, displayUrl: `/api/media/${row.id}/display`, thumbnailUrl: `/api/media/${row.id}/thumbnail` };
}
type RecordRow = { id: string; title: string; body: string; occurred_on: string | null; location: string; is_first: number; include_in_yearbook: number; created_at: string; updated_at: string; deleted_at: string | null };

export function getRecord(store: DataStore, rawId: string): RecordItem {
  const id = idSchema.parse(rawId);
  const row = store.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
  if (!row) throw new AppError(404, 'NOT_FOUND', '这条记录不存在');
  const media = (store.db.prepare('SELECT m.*, rm.caption FROM media m JOIN record_media rm ON rm.media_id = m.id WHERE rm.record_id = ? ORDER BY rm.position').all(id) as (MediaRow & { caption: string })[]).map(m => ({ ...presentMedia(m), caption: m.caption }));
  const people = (store.db.prepare('SELECT p.name FROM people p JOIN record_people rp ON p.id = rp.person_id WHERE rp.record_id = ? ORDER BY p.name').all(id) as { name: string }[]).map(p => p.name);
  const tags = (store.db.prepare('SELECT t.name FROM tags t JOIN record_tags rt ON t.id = rt.tag_id WHERE rt.record_id = ? ORDER BY t.name').all(id) as { name: string }[]).map(t => t.name);
  const reflections = (store.db.prepare('SELECT id, body, created_at FROM reflections WHERE record_id = ? ORDER BY created_at, rowid').all(id) as { id: string; body: string; created_at: string }[]).map(r => ({ id: r.id, body: r.body, createdAt: r.created_at }));
  return { id: row.id, title: row.title, body: row.body, occurredOn: row.occurred_on, location: row.location, isFirst: !!row.is_first, includeInYearbook: !!row.include_in_yearbook, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, people, tags, media, reflections };
}

export function saveRecord(store: DataStore, input: RecordInput, existingId?: string): RecordItem {
  const id = existingId ? idSchema.parse(existingId) : randomUUID();
  if (existingId && getRecord(store, id).deletedAt) throw new AppError(409, 'RECORD_DELETED', '请先恢复这条记录，再继续编辑');
  for (const media of input.media) if (!store.db.prepare('SELECT id FROM media WHERE id = ?').get(media.id)) throw new AppError(400, 'MEDIA_NOT_FOUND', '所选照片不存在，请重新导入');
  const now = new Date().toISOString();
  store.db.transaction(() => {
    if (existingId) store.db.prepare('UPDATE records SET title = ?, body = ?, occurred_on = ?, location = ?, is_first = ?, include_in_yearbook = ?, updated_at = ? WHERE id = ?').run(input.title, input.body, input.occurredOn, input.location, Number(input.isFirst), Number(input.includeInYearbook), now, id);
    else store.db.prepare('INSERT INTO records (id, title, body, occurred_on, location, is_first, include_in_yearbook, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.title, input.body, input.occurredOn, input.location, Number(input.isFirst), Number(input.includeInYearbook), now, now);
    store.db.prepare('DELETE FROM record_media WHERE record_id = ?').run(id);
    input.media.forEach((m, position) => store.db.prepare('INSERT INTO record_media (record_id, media_id, position, caption) VALUES (?, ?, ?, ?)').run(id, m.id, position, m.caption));
    for (const kind of ['people', 'tags'] as const) {
      const field = kind === 'people' ? 'person_id' : 'tag_id';
      store.db.prepare(`DELETE FROM record_${kind} WHERE record_id = ?`).run(id);
      for (const name of input[kind]) {
        store.db.prepare(`INSERT OR IGNORE INTO ${kind}(id, name) VALUES (?, ?)`).run(randomUUID(), name);
        const entity = store.db.prepare(`SELECT id FROM ${kind} WHERE name = ?`).get(name) as { id: string };
        store.db.prepare(`INSERT INTO record_${kind}(record_id, ${field}) VALUES (?, ?)`).run(id, entity.id);
      }
    }
  })();
  return getRecord(store, id);
}

const querySchema = z.object({
  q: z.string().max(500).optional(), year: z.coerce.number().int().min(1).max(9999).optional(), month: z.coerce.number().int().min(1).max(12).optional(),
  person: z.string().max(80).optional(), tag: z.string().max(80).optional(), first: z.enum(['true', 'false']).optional(), deleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});
function filters(raw: RecordQuery) {
  const query = querySchema.parse(raw);
  const clauses = [query.deleted === 'true' ? 'r.deleted_at IS NOT NULL' : 'r.deleted_at IS NULL'];
  const values: (string | number)[] = [];
  if (query.year) { clauses.push('substr(r.occurred_on, 1, 4) = ?'); values.push(String(query.year).padStart(4, '0')); }
  if (query.month) { clauses.push('substr(r.occurred_on, 6, 2) = ?'); values.push(String(query.month).padStart(2, '0')); }
  if (query.first === 'true') clauses.push('r.is_first = 1');
  if (query.person) { clauses.push('EXISTS (SELECT 1 FROM record_people rp JOIN people p ON p.id = rp.person_id WHERE rp.record_id = r.id AND p.name = ?)'); values.push(query.person); }
  if (query.tag) { clauses.push('EXISTS (SELECT 1 FROM record_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.record_id = r.id AND t.name = ?)'); values.push(query.tag); }
  if (query.q?.trim()) {
    const word = query.q.trim().replace(/[\\%_]/g, '\\$&');
    clauses.push(`(r.title LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\' OR r.location LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM record_people rp JOIN people p ON p.id = rp.person_id WHERE rp.record_id = r.id AND p.name LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM record_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.record_id = r.id AND t.name LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM record_media rm WHERE rm.record_id = r.id AND rm.caption LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM reflections f WHERE f.record_id = r.id AND f.body LIKE ? ESCAPE '\\'))`);
    values.push(...Array(7).fill(`%${word}%`));
  }
  return { query, where: clauses.join(' AND '), values };
}

export function listRecords(store: DataStore, raw: RecordQuery): RecordList {
  const { query, where, values } = filters(raw);
  const total = (store.db.prepare(`SELECT COUNT(*) AS count FROM records r WHERE ${where}`).get(...values) as { count: number }).count;
  const ids = store.db.prepare(`SELECT r.id FROM records r WHERE ${where} ORDER BY r.occurred_on IS NULL, r.occurred_on DESC, r.created_at DESC, r.id LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset) as { id: string }[];
  return { total, items: ids.map(row => getRecord(store, row.id)) };
}

export function deleteRecord(store: DataStore, id: string, restore = false) {
  getRecord(store, id);
  const now = new Date().toISOString();
  store.db.prepare('UPDATE records SET deleted_at = ?, updated_at = ? WHERE id = ?').run(restore ? null : now, now, id);
  return getRecord(store, id);
}

export function addReflection(store: DataStore, id: string, body: string) {
  if (getRecord(store, id).deletedAt) throw new AppError(409, 'RECORD_DELETED', '请先恢复这条记录');
  const now = new Date().toISOString();
  store.db.transaction(() => {
    store.db.prepare('INSERT INTO reflections (id, record_id, body, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), id, body, now);
    store.db.prepare('UPDATE records SET updated_at = ? WHERE id = ?').run(now, id);
  })();
  return getRecord(store, id);
}

export function metadata(store: DataStore): Metadata {
  const people = (store.db.prepare('SELECT DISTINCT p.name FROM people p JOIN record_people rp ON rp.person_id = p.id JOIN records r ON r.id = rp.record_id WHERE r.deleted_at IS NULL ORDER BY p.name').all() as { name: string }[]).map(p => p.name);
  const tags = (store.db.prepare('SELECT DISTINCT t.name FROM tags t JOIN record_tags rt ON rt.tag_id = t.id JOIN records r ON r.id = rt.record_id WHERE r.deleted_at IS NULL ORDER BY t.name').all() as { name: string }[]).map(t => t.name);
  const years = (store.db.prepare('SELECT DISTINCT CAST(substr(occurred_on, 1, 4) AS INTEGER) AS year FROM records WHERE deleted_at IS NULL AND occurred_on IS NOT NULL ORDER BY year DESC').all() as { year: number }[]).map(r => r.year);
  return { people, tags, years };
}

export function calendar(store: DataStore, rawMonth: unknown): CalendarData {
  const month = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, '请选择有效年月').parse(rawMonth);
  const days = store.db.prepare('SELECT occurred_on AS date, COUNT(*) AS count FROM records WHERE deleted_at IS NULL AND substr(occurred_on, 1, 7) = ? GROUP BY occurred_on ORDER BY occurred_on').all(month) as { date: string; count: number }[];
  const undated = (store.db.prepare('SELECT COUNT(*) AS count FROM records WHERE deleted_at IS NULL AND occurred_on IS NULL').get() as { count: number }).count;
  return { month, days, undated };
}

export function memories(store: DataStore, raw: { exclude?: string; count?: string }) {
  const { exclude, count } = z.object({ exclude: z.string().max(40000).default(''), count: z.coerce.number().int().min(1).max(6).default(1) }).parse(raw);
  const excluded = new Set(exclude.split(',').filter(Boolean).map(id => idSchema.parse(id)));
  const rows = store.db.prepare('SELECT r.id, h.shown_at FROM records r LEFT JOIN memory_history h ON h.record_id = r.id WHERE r.deleted_at IS NULL ORDER BY h.shown_at IS NOT NULL, h.shown_at, random()').all() as { id: string; shown_at: string | null }[];
  const preferred = rows.filter(r => !excluded.has(r.id));
  const items = [...preferred, ...rows.filter(r => excluded.has(r.id))].slice(0, count).map(row => getRecord(store, row.id));
  const now = new Date().toISOString();
  store.db.transaction(() => items.forEach(item => store.db.prepare('INSERT INTO memory_history (record_id, shown_at) VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET shown_at = excluded.shown_at').run(item.id, now)))();
  return { items };
}
