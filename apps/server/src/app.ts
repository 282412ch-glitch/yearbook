import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { idSchema, recordInputSchema, reflectionSchema, yearbookInputSchema, type RecordQuery, type AppStats, type MediaItem } from '@yearbook/shared';
import { DataStore } from './db.js';
import { AppError } from './errors.js';
import { addReflection, calendar, deleteRecord, getRecord, listRecords, memories, metadata, saveRecord } from './records.js';
import { importMedia, MAX_PHOTO_BYTES, readMedia } from './media.js';
import { createBackup, listBackups, MAX_BACKUP_BYTES, restoreBackup } from './backups.js';
import { applyYearbookVersion, createYearbookVersion, deleteYearbook, getYearbook, getYearbookVersion, listYearbookVersions, listYearbooks, renderYearbookHtml, saveYearbook } from './yearbooks.js';
import { cancelTask, getTask, listTasks, retryTask, recoverInterruptedTasks } from './tasks.js';
import { cancelExport, pauseExports, readExport, requestExport, resumeExports, retryExport } from './exports.js';
import { ModelService } from './models/service.js';
import { CredentialVault } from './models/credentials.js';
import { registerModelRoutes } from './models/routes.js';
import { AiRunner } from './ai/runner.js';
import { registerAiRoutes } from './ai/routes.js';
import { assertLetterMediaAccessible, registerLetterRoutes } from './letters.js';

export function instanceId(token: string | undefined) { return token ? createHash('sha256').update(token).digest('hex') : null; }
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export async function createApp(options: { dataDir: string; webDist?: string; credentialVault?: CredentialVault }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 120_000 });
  const store = new DataStore(options.dataDir);
  recoverInterruptedTasks(store);
  const models = new ModelService(store, options.credentialVault);
  const ai = new AiRunner(store, models);
  await ai.recover();
  let restoring = false;
  let restoreEpoch = 0;
  const requestEpochs = new WeakMap<FastifyRequest, number>();
  const isMutation = (request: FastifyRequest) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  function requireCurrentLibrary(request: FastifyRequest) {
    if (restoring) throw new AppError(503, 'RESTORE_IN_PROGRESS', '正在恢复资料，请稍后再进行写入操作');
    if (requestEpochs.get(request) !== restoreEpoch) throw new AppError(409, 'LIBRARY_RESTORED', '请求期间资料库已恢复，请刷新页面，检查当前资料后再操作');
  }
  app.addHook('preClose', async () => { await ai.shutdown(); await models.shutdown(); await pauseExports(store); });
  app.addHook('onClose', async () => { await store.close(); });
  app.addHook('onRequest', async (request, reply) => {
    requestEpochs.set(request, restoreEpoch);
    if (isMutation(request)) requireCurrentLibrary(request);
    let host: URL;
    try { host = new URL(`http://${request.headers.host ?? ''}`); }
    catch { throw new AppError(403, 'HOST_FORBIDDEN', '本应用只允许从本机地址访问'); }
    if (!loopback.has(host.hostname) || host.username || host.password || host.pathname !== '/') throw new AppError(403, 'HOST_FORBIDDEN', '本应用只允许从本机地址访问');
    const origin = request.headers.origin;
    if (origin) {
      let parsed: URL;
      try { parsed = new URL(origin); } catch { throw new AppError(403, 'ORIGIN_FORBIDDEN', '请求来源不被允许，请从本应用页面操作'); }
      const sameOrigin = parsed.origin === host.origin;
      const development = process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:' && loopback.has(parsed.hostname) && ['5173', '5174'].includes(parsed.port);
      if (!sameOrigin && !development) throw new AppError(403, 'ORIGIN_FORBIDDEN', '请求来源不被允许，请从本应用页面操作');
      reply.header('Access-Control-Allow-Origin', parsed.origin).header('Vary', 'Origin');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site' && request.method !== 'GET' && request.method !== 'HEAD') throw new AppError(403, 'CROSS_SITE_FORBIDDEN', '请从本应用页面执行此操作');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  // JSON bodies may finish arriving after a complete restore cycle.
  app.addHook('preHandler', async request => { if (isMutation(request)) requireCurrentLibrary(request); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? '输入格式不正确', details: error.flatten() } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const known = error as { code?: string; statusCode?: number; message?: string };
    if (known.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: { code: 'FILE_TOO_LARGE', message: '文件超过导入大小上限：照片每张 25 MB，备份 ZIP 512 MB' } });
    if (known.code === 'FST_FILES_LIMIT') return reply.code(400).send({ error: { code: 'TOO_MANY_FILES', message: '一次最多导入 100 张照片，恢复时只选择一个备份' } });
    if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500) return reply.code(known.statusCode).send({ error: { code: 'INVALID_REQUEST', message: '请求格式不正确，请检查输入或文件后重试' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '操作未完成，请重试。若仍失败，请检查数据目录的访问权限和可用空间' } });
  });
  await app.register(multipart, { limits: { fileSize: MAX_BACKUP_BYTES, files: 100, fields: 0, parts: 100 } });
  app.options('/api/*', async (_request, reply) => reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type,Authorization').code(204).send());
  registerModelRoutes(app, models);
  registerAiRoutes(app, store, ai);
  registerLetterRoutes(app, store, requireCurrentLibrary);
  app.get('/api/health', async () => ({ app: 'yearbook', version: '0.1.0', status: 'ok', pid: process.pid, instanceId: instanceId(process.env.YEARBOOK_INSTANCE_TOKEN) }));
  app.get('/api/stats', async () => store.write(async (): Promise<AppStats> => {
    const count = (sql: string) => (store.db.prepare(sql).get() as { count: number }).count;
    return { records: count('SELECT COUNT(*) AS count FROM records WHERE deleted_at IS NULL'), photos: count('SELECT COUNT(DISTINCT rm.media_id) AS count FROM record_media rm JOIN records r ON r.id = rm.record_id WHERE r.deleted_at IS NULL'), firsts: count('SELECT COUNT(*) AS count FROM records WHERE deleted_at IS NULL AND is_first = 1'), years: metadata(store).years, lastBackupAt: (await listBackups(store))[0]?.createdAt ?? null, dataDir: store.dataDir };
  }));
  app.get('/api/meta', async () => store.write(() => metadata(store)));
  app.get<{ Querystring: RecordQuery }>('/api/records', async request => store.write(() => listRecords(store, request.query)));
  app.post('/api/records', async (request, reply) => { const input = recordInputSchema.parse(request.body); const record = await store.write(() => saveRecord(store, input)); return reply.code(201).send(record); });
  app.get<{ Params: { id: string } }>('/api/records/:id', async request => store.write(() => getRecord(store, request.params.id)));
  app.put<{ Params: { id: string } }>('/api/records/:id', async request => { const input = recordInputSchema.parse(request.body); return store.write(() => saveRecord(store, input, request.params.id)); });
  app.delete<{ Params: { id: string } }>('/api/records/:id', async request => store.write(() => deleteRecord(store, request.params.id)));
  app.post<{ Params: { id: string } }>('/api/records/:id/restore', async request => store.write(() => deleteRecord(store, request.params.id, true)));
  app.post<{ Params: { id: string } }>('/api/records/:id/reflections', async request => { const input = reflectionSchema.parse(request.body); return store.write(() => addReflection(store, request.params.id, input.body)); });
  app.get<{ Querystring: { month: string } }>('/api/calendar', async request => store.write(() => calendar(store, request.query.month)));
  app.get<{ Querystring: { exclude?: string; count?: string } }>('/api/memories', async request => store.write(() => memories(store, request.query)));
  app.post('/api/media', async (request, reply) => store.write(async () => {
    if (!request.isMultipart()) throw new AppError(400, 'MULTIPART_REQUIRED', '请选择要导入的照片');
    const items: MediaItem[] = [];
    let duplicates = 0;
    for await (const part of request.files({ limits: { fileSize: MAX_PHOTO_BYTES, files: 100, fields: 0 } })) {
      if (part.fieldname !== 'files') throw new AppError(400, 'INVALID_FIELD', '照片文件字段应为 files');
      const result = await importMedia(store, await part.toBuffer(), part.filename);
      if (result.duplicate) duplicates++;
      if (!items.some(item => item.id === result.item.id)) items.push(result.item);
    }
    if (!items.length) throw new AppError(400, 'NO_PHOTOS', '请至少选择一张照片');
    return reply.code(201).send({ items, duplicates });
  }));
  app.get<{ Params: { id: string; kind: string } }>('/api/media/:id/:kind', async (request, reply) => {
    const id = idSchema.parse(request.params.id);
    const kind = z.enum(['original', 'display', 'thumbnail']).parse(request.params.kind);
    const media = await store.write(() => { assertLetterMediaAccessible(store, id); return readMedia(store, id, kind); });
    return reply.type(media.mime).header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.filename).replace(/'/g, '%27')}`).send(media.buffer);
  });
  app.get('/api/backups', async () => store.write(async () => ({ items: await listBackups(store) })));
  app.post('/api/backups', async (_request, reply) => { const backup = await store.write(() => createBackup(store)); return reply.code(201).send(backup); });
  app.get<{ Params: { id: string } }>('/api/backups/:id/download', async (request, reply) => {
    const id = idSchema.parse(request.params.id);
    const result = await store.write(async () => {
      const item = (await listBackups(store)).find(backup => backup.id === id);
      if (!item) throw new AppError(404, 'NOT_FOUND', '这个备份不存在');
      return { item, buffer: await readFile(join(store.dataDir, 'backups', item.filename)) };
    });
    return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${result.item.filename}"`).send(result.buffer);
  });
  app.post('/api/backups/restore', async request => {
    if (!request.isMultipart()) throw new AppError(400, 'MULTIPART_REQUIRED', '请选择备份 ZIP 文件');
    const part = await request.file({ limits: { fileSize: MAX_BACKUP_BYTES, files: 1, fields: 0 } });
    if (!part || part.fieldname !== 'file') throw new AppError(400, 'INVALID_FIELD', '请选择一个备份 ZIP 文件');
    const buffer = await part.toBuffer();
    requireCurrentLibrary(request);
    restoring = true;
    restoreEpoch++;
    try {
      await ai.pause();
      await models.pause();
      await pauseExports(store);
      const result = await store.write(() => restoreBackup(store, buffer));
      models.vault.clearSession();
      await store.write(() => recoverInterruptedTasks(store));
      await ai.recover();
      return result;
    } finally { models.resume(); ai.resume(); resumeExports(store); restoring = false; }
  });
  app.get<{ Querystring: { year?: string; deleted?: string; limit?: string; offset?: string } }>('/api/yearbooks', async request => store.write(() => listYearbooks(store, request.query)));
  app.post('/api/yearbooks', async (request, reply) => { yearbookInputSchema.parse(request.body); return reply.code(201).send(await store.write(() => saveYearbook(store, request.body))); });
  app.get<{ Params: { id: string } }>('/api/yearbooks/:id', async request => store.write(() => getYearbook(store, request.params.id)));
  app.put<{ Params: { id: string } }>('/api/yearbooks/:id', async request => { const input = yearbookInputSchema.parse(request.body); return store.write(() => saveYearbook(store, input, request.params.id)); });
  app.delete<{ Params: { id: string } }>('/api/yearbooks/:id', async request => store.write(() => deleteYearbook(store, request.params.id)));
  app.post<{ Params: { id: string } }>('/api/yearbooks/:id/restore', async request => store.write(() => deleteYearbook(store, request.params.id, true)));
  app.get<{ Params: { id: string } }>('/api/yearbooks/:id/versions', async request => store.write(() => listYearbookVersions(store, request.params.id)));
  app.post<{ Params: { id: string }; Body: { snapshot: unknown; source?: 'manual' | 'ai'; label?: string } }>('/api/yearbooks/:id/versions', async (request, reply) => {
    const body = z.object({ snapshot: yearbookInputSchema, source: z.enum(['manual', 'ai']).default('ai'), label: z.string().trim().max(300).optional() }).strict().parse(request.body);
    return reply.code(201).send(await store.write(() => createYearbookVersion(store, request.params.id, body.snapshot, body.source, body.label)));
  });
  app.get<{ Params: { id: string; versionId: string } }>('/api/yearbooks/:id/versions/:versionId', async request => store.write(() => getYearbookVersion(store, request.params.id, request.params.versionId)));
  app.post<{ Params: { id: string; versionId: string } }>('/api/yearbooks/:id/versions/:versionId/apply', async request => store.write(() => applyYearbookVersion(store, request.params.id, request.params.versionId)));
  app.get<{ Params: { id: string } }>('/api/yearbooks/:id/preview', async (request, reply) => reply
    .header('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
    .type('text/html; charset=utf-8').send(await store.write(() => renderYearbookHtml(store, request.params.id))));
  app.post<{ Params: { id: string }; Body: { format?: string; idempotencyKey?: string } }>('/api/yearbooks/:id/export', async (request, reply) => {
    const body = z.object({ format: z.enum(['html', 'pdf']).default('html'), idempotencyKey: z.string().trim().max(200).optional() }).strict().parse(request.body ?? {});
    const format = body.format;
    const task = await store.write(() => { getYearbook(store, request.params.id); return requestExport(store, request.params.id, format, body.idempotencyKey); });
    return reply.code(202).send(task);
  });
  app.post<{ Params: { id: string; format: string }; Body: { idempotencyKey?: string } }>('/api/yearbooks/:id/export/:format', async (request, reply) => {
    const format = z.enum(['html', 'pdf']).parse(request.params.format);
    const body = z.object({ idempotencyKey: z.string().trim().max(200).optional() }).strict().parse(request.body ?? {});
    const task = await store.write(() => { getYearbook(store, request.params.id); return requestExport(store, request.params.id, format, body.idempotencyKey); });
    return reply.code(202).send(task);
  });
  app.get<{ Params: { id: string; format: string }; Querystring: { taskId?: string } }>('/api/yearbooks/:id/export/:format', async (request, reply) => {
    const format = z.enum(['html', 'pdf']).parse(request.params.format);
    const task = request.query.taskId ? await store.write(() => getTask(store, request.query.taskId!)) : await store.write(() => requestExport(store, request.params.id, format));
    if (task.yearbookId !== request.params.id || task.kind !== `yearbook-${format}`) throw new AppError(403, 'EXPORT_TASK_MISMATCH', '导出任务与年册不匹配');
    if (task.status === 'completed') { const result = await store.write(() => readExport(store, task.id)); return reply.type(result.mime).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`).send(result.buffer); }
    return reply.code(202).send(task);
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async request => store.write(() => getTask(store, request.params.id)));
  app.get<{ Querystring: { status?: string; yearbookId?: string; limit?: string; offset?: string } }>('/api/tasks', async request => store.write(() => listTasks(store, request.query)));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async request => {
    const task = await store.write(() => getTask(store, request.params.id));
    requireCurrentLibrary(request);
    return task.kind === 'ai' ? ai.cancel(task.id) : cancelExport(store, task.id);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', async request => {
    const current = await store.write(() => getTask(store, request.params.id));
    requireCurrentLibrary(request);
    if (current.kind === 'ai') return ai.retry(current.id);
    return retryExport(store, current.id);
  });
  app.post('/api/system/shutdown', async (request, reply) => {
    const token = process.env.YEARBOOK_INSTANCE_TOKEN;
    const supplied = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token || !supplied || Buffer.byteLength(token) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(token), Buffer.from(supplied))) throw new AppError(403, 'INSTANCE_TOKEN_REQUIRED', '只能由启动本应用的启动器停止服务');
    reply.send({ stopping: true });
    setTimeout(() => { void app.close(); }, 50).unref();
  });
  if (options.webDist && existsSync(join(options.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: resolve(options.webDist), prefix: '/', wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '找不到这个页面或接口' } });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '找不到这个接口。网页尚未构建时，请运行 npm run dev 或先执行 npm run build' } }));
  }
  return app;
}
