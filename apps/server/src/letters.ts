import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { idSchema, letterInputSchema, letterQuerySchema, localDate, type LetterDetail, type LetterEnvelope, type LetterList, type LetterSummary } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';
import { presentMedia, type MediaRow } from './records.js';

export type LetterRow = {
  id: string; title: string; body: string; unlock_on: string | null; created_at: string; updated_at: string;
  sealed_at: string | null; read_at: string | null; deleted_at: string | null; photo_count?: number;
};

// A complete uploaded file proves the user has this photo independently of the sealed letter.
// Keep this short-lived grant on the current connection: restore/restart cannot carry it over.
const reimportGrants = new WeakMap<DataStore['db'], Map<string, number>>();
const REIMPORT_GRANT_MS = 30 * 60 * 1000;
export function authorizeLetterPhotoReimport(store: DataStore, id: string) {
  let grants = reimportGrants.get(store.db);
  if (!grants) { grants = new Map(); reimportGrants.set(store.db, grants); }
  const now = Date.now();
  for (const [mediaId, expiresAt] of grants) if (expiresAt <= now) grants.delete(mediaId);
  grants.set(id, now + REIMPORT_GRANT_MS);
}
function hasReimportGrant(store: DataStore, id: string) {
  const grants = reimportGrants.get(store.db);
  const expiresAt = grants?.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) { grants!.delete(id); return false; }
  return true;
}
function revokeLetterPhotoGrants(store: DataStore, letterId: string) {
  const grants = reimportGrants.get(store.db);
  if (!grants) return;
  for (const row of store.db.prepare('SELECT media_id FROM future_letter_media WHERE letter_id = ?').all(letterId) as { media_id: string }[]) grants.delete(row.media_id);
}

function rowFor(store: DataStore, rawId: string): LetterRow {
  const id = idSchema.parse(rawId);
  const row = store.db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM future_letter_media m WHERE m.letter_id = l.id) AS photo_count
    FROM future_letters l WHERE l.id = ?`).get(id) as LetterRow | undefined;
  if (!row) throw new AppError(404, 'NOT_FOUND', '这封信不存在');
  return row;
}

function envelope(row: LetterRow, today: string): LetterEnvelope {
  const canRead = row.sealed_at === null || (row.unlock_on !== null && row.unlock_on <= today);
  const status = row.sealed_at === null ? 'draft' : !canRead ? 'sealed' : row.read_at ? 'read' : 'due';
  return { id: row.id, title: row.title, unlockOn: row.unlock_on, createdAt: row.created_at, updatedAt: row.updated_at,
    sealedAt: row.sealed_at, readAt: row.read_at, deletedAt: row.deleted_at, status, photoCount: row.photo_count ?? 0, canRead };
}

/** Access time decides whether a sealed envelope is due; no timer has to run while the app is closed. */
export function getLetter(store: DataStore, rawId: string, now = new Date()): LetterDetail {
  const row = rowFor(store, rawId);
  const item = envelope(row, localDate(now));
  if (!item.canRead) return item;
  const photos = store.db.prepare(`SELECT m.*, lm.caption FROM future_letter_media lm JOIN media m ON m.id = lm.media_id
    WHERE lm.letter_id = ? ORDER BY lm.position`).all(row.id) as (MediaRow & { caption: string })[];
  return { ...item, body: row.body, media: photos.map(photo => ({ ...presentMedia(photo), caption: photo.caption })) };
}

export function listLetters(store: DataStore, raw: unknown = {}, now = new Date()): LetterList {
  const query = letterQuerySchema.parse(raw);
  const today = localDate(now);
  const values: (string | number)[] = [];
  const clauses = [`l.deleted_at IS ${query.deleted === 'true' ? 'NOT ' : ''}NULL`];
  if (query.status === 'draft') clauses.push('l.sealed_at IS NULL');
  if (query.status === 'sealed') { clauses.push('l.sealed_at IS NOT NULL AND l.unlock_on > ?'); values.push(today); }
  if (query.status === 'due' || query.status === 'read') {
    clauses.push(`l.sealed_at IS NOT NULL AND l.unlock_on <= ? AND l.read_at IS ${query.status === 'read' ? 'NOT ' : ''}NULL`);
    values.push(today);
  }
  const where = clauses.join(' AND ');
  const total = (store.db.prepare(`SELECT COUNT(*) AS n FROM future_letters l WHERE ${where}`).get(...values) as { n: number }).n;
  // The list only selects envelope fields; body and photo descriptions never enter a list response.
  const rows = store.db.prepare(`SELECT l.id,l.title,l.unlock_on,l.created_at,l.updated_at,l.sealed_at,l.read_at,l.deleted_at,
    (SELECT COUNT(*) FROM future_letter_media m WHERE m.letter_id = l.id) AS photo_count
    FROM future_letters l WHERE ${where} ORDER BY l.updated_at DESC, l.id LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset) as LetterRow[];
  return { total, today, items: rows.map(row => envelope(row, today)) };
}

export function letterSummary(store: DataStore, now = new Date()): LetterSummary {
  const due = listLetters(store, { status: 'due', limit: 50 }, now);
  const totalDrafts = (store.db.prepare('SELECT COUNT(*) AS n FROM future_letters WHERE deleted_at IS NULL AND sealed_at IS NULL').get() as { n: number }).n;
  const sealedCount = (store.db.prepare('SELECT COUNT(*) AS n FROM future_letters WHERE deleted_at IS NULL AND sealed_at IS NOT NULL AND unlock_on > ?').get(due.today) as { n: number }).n;
  return { today: due.today, dueUnread: due.total, totalDrafts, sealedCount, due: due.items };
}

/** An exclusive future-letter photo must not be opened or re-attached using a remembered media ID. */
export function assertLetterMediaAccessible(store: DataStore, id: string, today = localDate()) {
  // The legacy-backup validator also uses record/yearbook helpers against versions 1–4.
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'future_letters'").get()) return;
  const locked = store.db.prepare(`SELECT 1 FROM future_letter_media lm JOIN future_letters l ON l.id = lm.letter_id
    WHERE lm.media_id = ? AND l.sealed_at IS NOT NULL AND l.unlock_on > ? LIMIT 1`).get(id, today);
  if (!locked) return;
  if (hasReimportGrant(store, id)) return;
  const visibleQueries = [
    'SELECT 1 FROM record_media rm JOIN records r ON r.id = rm.record_id WHERE rm.media_id = ? AND r.deleted_at IS NULL LIMIT 1',
    'SELECT 1 FROM yearbooks WHERE cover_media_id = ? AND deleted_at IS NULL LIMIT 1',
    `SELECT 1 FROM yearbook_blocks b JOIN yearbook_chapters c ON c.id = b.chapter_id JOIN yearbooks y ON y.id = c.yearbook_id
      WHERE b.media_id = ? AND y.deleted_at IS NULL LIMIT 1`,
    `SELECT 1 FROM record_media rm JOIN yearbook_blocks b ON b.record_id = rm.record_id JOIN yearbook_chapters c ON c.id = b.chapter_id
      JOIN yearbooks y ON y.id = c.yearbook_id WHERE rm.media_id = ? AND y.deleted_at IS NULL LIMIT 1`,
    `SELECT 1 FROM yearbook_versions v JOIN yearbooks y ON y.id = v.yearbook_id, json_tree(v.snapshot_json) j
      WHERE j.key IN ('mediaId', 'coverMediaId') AND j.atom = ? AND y.deleted_at IS NULL LIMIT 1`,
    'SELECT 1 FROM ai_draft_media WHERE media_id = ? LIMIT 1',
    `SELECT 1 FROM ai_draft_versions v, json_tree(v.content_json) j WHERE j.key = 'mediaId' AND j.atom = ? LIMIT 1`,
    `SELECT 1 FROM ai_drafts d JOIN ai_task_inputs t ON t.task_id = d.task_id,
      json_each(t.source_snapshots_json) r, json_each(r.value, '$.media') m WHERE json_extract(m.value, '$.id') = ? LIMIT 1`,
    `SELECT 1 FROM ai_task_stages s, json_tree(s.content_json) j WHERE j.key = 'mediaId' AND j.atom = ? LIMIT 1`,
  ];
  if (visibleQueries.some(sql => store.db.prepare(sql).get(id))) return;
  const otherLetter = store.db.prepare(`SELECT 1 FROM future_letter_media lm JOIN future_letters l ON l.id = lm.letter_id
    WHERE lm.media_id = ? AND l.deleted_at IS NULL AND (l.sealed_at IS NULL OR l.unlock_on <= ?) LIMIT 1`).get(id, today);
  if (otherLetter) return;
  throw new AppError(403, 'LETTER_MEDIA_SEALED', '这张照片属于尚未到期的封存信件。如需用于别处，请重新导入你持有的原文件');
}

export function saveLetter(store: DataStore, raw: unknown, existingId?: string, now = new Date()): LetterDetail {
  const input = letterInputSchema.parse(raw);
  const id = existingId ? idSchema.parse(existingId) : randomUUID();
  if (existingId) {
    const row = rowFor(store, id);
    if (row.deleted_at) throw new AppError(409, 'LETTER_DELETED', '请先恢复这封信，再继续编辑');
    if (row.sealed_at) throw new AppError(409, 'LETTER_SEALED', '信件封存后不能修改正文、照片或查看日期');
  }
  for (const photo of input.media) {
    if (!store.db.prepare('SELECT 1 FROM media WHERE id = ?').get(photo.id)) throw new AppError(400, 'MEDIA_NOT_FOUND', '所选照片不存在，请重新导入');
    assertLetterMediaAccessible(store, photo.id, localDate(now));
  }
  const stamp = now.toISOString();
  store.db.transaction(() => {
    if (existingId) store.db.prepare('UPDATE future_letters SET title = ?, body = ?, unlock_on = ?, updated_at = ? WHERE id = ?').run(input.title, input.body, input.unlockOn, stamp, id);
    else store.db.prepare('INSERT INTO future_letters(id,title,body,unlock_on,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, input.title, input.body, input.unlockOn, stamp, stamp);
    store.db.prepare('DELETE FROM future_letter_media WHERE letter_id = ?').run(id);
    input.media.forEach((photo, position) => store.db.prepare('INSERT INTO future_letter_media(letter_id,media_id,position,caption) VALUES (?,?,?,?)').run(id, photo.id, position, photo.caption));
  })();
  return getLetter(store, id, now);
}

export function sealLetter(store: DataStore, rawId: string, now = new Date()): LetterDetail {
  const row = rowFor(store, rawId);
  if (row.deleted_at) throw new AppError(409, 'LETTER_DELETED', '请先恢复这封信');
  if (row.sealed_at) { revokeLetterPhotoGrants(store, row.id); return getLetter(store, row.id, now); }
  if (!row.unlock_on || row.unlock_on < localDate(now)) throw new AppError(400, 'LETTER_UNLOCK_DATE', '封存前请选择今天或未来的查看日期');
  if (!row.body.trim() && !row.photo_count) throw new AppError(400, 'LETTER_EMPTY', '写下信的正文，或附上一张照片后再封存');
  const stamp = now.toISOString();
  store.db.prepare('UPDATE future_letters SET sealed_at = ?, updated_at = ? WHERE id = ? AND sealed_at IS NULL').run(stamp, stamp, row.id);
  revokeLetterPhotoGrants(store, row.id);
  return getLetter(store, row.id, now);
}

/** Explicit opening is idempotent; previews and due checks never mark a letter as read. */
export function readLetter(store: DataStore, rawId: string, now = new Date()): LetterDetail {
  const row = rowFor(store, rawId);
  if (row.deleted_at) throw new AppError(409, 'LETTER_DELETED', '请先恢复这封信，再拆阅');
  if (!row.sealed_at) throw new AppError(409, 'LETTER_NOT_SEALED', '这封信仍是草稿，请先完成并封存');
  if (!row.unlock_on || row.unlock_on > localDate(now)) throw new AppError(403, 'LETTER_NOT_DUE', '还没有到这封信的查看日期');
  if (!row.read_at) {
    const stamp = now.toISOString();
    store.db.prepare('UPDATE future_letters SET read_at = ?, updated_at = ? WHERE id = ? AND read_at IS NULL').run(stamp, stamp, row.id);
  }
  return getLetter(store, row.id, now);
}

export function deleteLetter(store: DataStore, rawId: string, restore = false, now = new Date()): LetterEnvelope {
  const row = rowFor(store, rawId);
  if (restore ? row.deleted_at !== null : row.deleted_at === null) {
    const stamp = now.toISOString();
    store.db.prepare('UPDATE future_letters SET deleted_at = ?, updated_at = ? WHERE id = ?').run(restore ? null : stamp, stamp, row.id);
  }
  return envelope(rowFor(store, row.id), localDate(now));
}

export function registerLetterRoutes(app: FastifyInstance, store: DataStore, requireCurrentLibrary: (request: FastifyRequest) => void) {
  const mutation = <T>(request: FastifyRequest, action: () => T) => store.write(() => { requireCurrentLibrary(request); return action(); });
  app.get('/api/letters/summary', async () => store.write(() => letterSummary(store)));
  app.get('/api/letters', async request => store.write(() => listLetters(store, request.query)));
  app.get<{ Params: { id: string } }>('/api/letters/:id', async request => store.write(() => getLetter(store, request.params.id)));
  app.post('/api/letters', async (request, reply) => {
    const input = letterInputSchema.parse(request.body);
    return reply.code(201).send(await mutation(request, () => saveLetter(store, input)));
  });
  app.put<{ Params: { id: string } }>('/api/letters/:id', async request => {
    const input = letterInputSchema.parse(request.body);
    return mutation(request, () => saveLetter(store, input, request.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/letters/:id/seal', async request => {
    z.object({}).strict().parse(request.body ?? {});
    return mutation(request, () => sealLetter(store, request.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/letters/:id/read', async request => {
    z.object({}).strict().parse(request.body ?? {});
    return mutation(request, () => readLetter(store, request.params.id));
  });
  app.delete<{ Params: { id: string } }>('/api/letters/:id', async request => mutation(request, () => deleteLetter(store, request.params.id)));
  app.post<{ Params: { id: string } }>('/api/letters/:id/restore', async request => {
    z.object({}).strict().parse(request.body ?? {});
    return mutation(request, () => deleteLetter(store, request.params.id, true));
  });
}
