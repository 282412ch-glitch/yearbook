import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskItem, TaskKind, TaskStatus } from '@yearbook/shared';
import { idSchema } from '@yearbook/shared';
import type { DataStore } from './db.js';
import { AppError } from './errors.js';

type TaskRow = {
  id: string; kind: string; yearbook_id: string | null; status: TaskStatus; progress: number; message: string;
  result_json: string | null; output_path: string | null; error_message: string | null; max_duration_ms: number;
  tool_calls: number; cancel_requested: number; attempts: number; idempotency_key: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; updated_at: string; deleted_at: string | null;
};

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function presentTask(row: TaskRow): TaskItem {
  return {
    id: row.id, kind: row.kind as TaskKind, yearbookId: row.yearbook_id, status: row.status,
    progress: row.progress, message: row.message, result: parseJson(row.result_json), outputPath: row.output_path,
    errorMessage: row.error_message, maxDurationMs: row.max_duration_ms, toolCalls: row.tool_calls, cancelRequested: !!row.cancel_requested,
    attempts: row.attempts, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
  };
}

export type CreateTaskInput = {
  kind: TaskKind;
  yearbookId?: string | null;
  maxDurationMs?: number;
  idempotencyKey?: string | null;
};

export function createTask(store: DataStore, input: CreateTaskInput): TaskItem {
  const kind = z.string().trim().min(1).max(100).parse(input.kind);
  const yearbookId = input.yearbookId == null ? null : idSchema.parse(input.yearbookId);
  const maxDurationMs = z.number().int().min(1000).max(30 * 60 * 1000).default(120000).parse(input.maxDurationMs);
  const idempotencyKey = input.idempotencyKey == null ? null : z.string().trim().min(1).max(200).parse(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = store.db.prepare('SELECT * FROM tasks WHERE kind = ? AND idempotency_key = ?').get(kind, idempotencyKey) as TaskRow | undefined;
    if (existing) return presentTask(existing);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO tasks
    (id, kind, yearbook_id, status, progress, message, result_json, output_path, error_message,
     max_duration_ms, tool_calls, cancel_requested, attempts, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, '', NULL, NULL, NULL, ?, 0, 0, 0, ?, ?, ?)`)
    .run(id, kind, yearbookId, maxDurationMs, idempotencyKey, now, now);
  return getTask(store, id);
}

export function getTask(store: DataStore, rawId: string): TaskItem {
  const id = idSchema.parse(rawId);
  const row = store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new AppError(404, 'NOT_FOUND', '这个任务不存在');
  return presentTask(row);
}

export function listTasks(store: DataStore, raw: { status?: string; yearbookId?: string; deleted?: string; limit?: string; offset?: string } = {}) {
  const query = z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
    deleted: z.enum(['true', 'false']).default('false'),
    yearbookId: idSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  }).parse(raw);
  const clauses = [query.deleted === 'true' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const values: (string | number)[] = [];
  if (query.status) { clauses.push('status = ?'); values.push(query.status); }
  if (query.yearbookId) { clauses.push('yearbook_id = ?'); values.push(query.yearbookId); }
  const where = ` WHERE ${clauses.join(' AND ')}`;
  const total = (store.db.prepare(`SELECT COUNT(*) AS count FROM tasks${where}`).get(...values) as { count: number }).count;
  const order = query.deleted === 'true' ? 'deleted_at DESC, created_at DESC, id DESC' : 'created_at DESC, id DESC';
  const rows = store.db.prepare(`SELECT * FROM tasks${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset) as TaskRow[];
  return { total, items: rows.map(presentTask) };
}

export function updateTask(store: DataStore, rawId: string, patch: {
  status?: TaskStatus; progress?: number; message?: string; result?: unknown; outputPath?: string | null;
  errorMessage?: string | null; toolCalls?: number; cancelRequested?: boolean; attempts?: number;
}) {
  const id = idSchema.parse(rawId);
  const current = store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!current) throw new AppError(404, 'NOT_FOUND', '这个任务不存在');
  const status = patch.status ?? current.status;
  const progress = patch.progress == null ? current.progress : z.number().int().min(0).max(100).parse(patch.progress);
  const message = patch.message == null ? current.message : z.string().max(1000).parse(patch.message);
  const outputPath = patch.outputPath === undefined ? current.output_path : patch.outputPath;
  const errorMessage = patch.errorMessage === undefined ? current.error_message : patch.errorMessage;
  const toolCalls = patch.toolCalls == null ? current.tool_calls : z.number().int().min(0).max(10000).parse(patch.toolCalls);
  const cancelRequested = patch.cancelRequested == null ? current.cancel_requested : Number(patch.cancelRequested);
  const attempts = patch.attempts == null ? current.attempts : z.number().int().min(0).max(10000).parse(patch.attempts);
  const resultJson = patch.result === undefined ? current.result_json : JSON.stringify(patch.result);
  const now = new Date().toISOString();
  const started = status === 'running' && !current.started_at ? now : current.started_at;
  const finished = ['completed', 'failed', 'cancelled'].includes(status) ? (current.finished_at ?? now) : null;
  store.db.prepare(`UPDATE tasks SET status = ?, progress = ?, message = ?, result_json = ?, output_path = ?, error_message = ?,
    tool_calls = ?, cancel_requested = ?, attempts = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
    .run(status, progress, message, resultJson, outputPath, errorMessage, toolCalls, cancelRequested, attempts, started, finished, now, id);
  return getTask(store, id);
}

export function cancelTask(store: DataStore, rawId: string) {
  const task = getTask(store, rawId);
  if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
  return updateTask(store, task.id, { status: 'cancelled', progress: task.progress, message: '任务已取消', cancelRequested: true });
}

/** Stop queued/running work before hiding it; the caller also aborts its runtime. */
export function trashTask(store: DataStore, rawId: string) {
  return store.db.transaction(() => {
    const task = getTask(store, rawId);
    if (task.deletedAt) return task;
    cancelTask(store, task.id);
    const now = new Date().toISOString();
    // Release the request key so a new submission cannot reuse a trashed task.
    store.db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ?, idempotency_key = NULL WHERE id = ?').run(now, now, task.id);
    return getTask(store, task.id);
  })();
}

export function restoreTask(store: DataStore, rawId: string) {
  const task = getTask(store, rawId);
  if (!task.deletedAt) return task;
  store.db.prepare('UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), task.id);
  return getTask(store, task.id);
}

export function retryTask(store: DataStore, rawId: string) {
  const task = getTask(store, rawId);
  if (task.deletedAt) throw new AppError(409, 'TASK_IN_TRASH', '任务已移入回收站，请先恢复再重试');
  if (!['failed', 'cancelled'].includes(task.status)) throw new AppError(409, 'TASK_NOT_RETRYABLE', '只有失败或已取消的任务可以重试');
  const now = new Date().toISOString();
  store.db.prepare(`UPDATE tasks SET status = 'pending', progress = 0, message = '等待重试', result_json = NULL,
    output_path = NULL, error_message = NULL, cancel_requested = 0, updated_at = ?, finished_at = NULL WHERE id = ?`).run(now, task.id);
  return getTask(store, task.id);
}

export function startTask(store: DataStore, rawId: string, message = '正在准备') {
  const task = getTask(store, rawId);
  if (task.deletedAt) throw new AppError(409, 'TASK_IN_TRASH', '任务已移入回收站，请先恢复再重试');
  if (task.status === 'cancelled') throw new AppError(409, 'TASK_CANCELLED', '任务已取消');
  if (task.status === 'completed') return task;
  return updateTask(store, task.id, { status: 'running', progress: Math.max(1, task.progress), message, attempts: task.attempts + 1 });
}

export function finishTask(store: DataStore, rawId: string, result: unknown, outputPath: string | null, message = '已完成') {
  const current = getTask(store, rawId);
  if (current.deletedAt || current.status === 'cancelled' || current.cancelRequested) return current;
  return updateTask(store, rawId, { status: 'completed', progress: 100, message, result, outputPath, errorMessage: null });
}

export function failTask(store: DataStore, rawId: string, errorMessage: string) {
  const current = getTask(store, rawId);
  if (current.deletedAt || current.status === 'cancelled' || current.cancelRequested) return current;
  return updateTask(store, rawId, { status: 'failed', message: '任务失败', errorMessage: errorMessage.slice(0, 2000) });
}

/** A process can stop while an export is running; make that visible after restart. */
export function recoverInterruptedTasks(store: DataStore) {
  const now = new Date().toISOString();
  store.db.prepare(`UPDATE tasks SET status = 'failed', message = '应用重启，任务未完成', error_message = '应用关闭时任务尚未完成，可重试', finished_at = ?, updated_at = ? WHERE deleted_at IS NULL AND status IN ('pending', 'running')`).run(now, now);
}
