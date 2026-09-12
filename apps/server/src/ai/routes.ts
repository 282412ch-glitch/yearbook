import type { FastifyInstance } from 'fastify';
import { aiAdoptSchema, aiDraftUpdateSchema, aiTaskInputSchema } from '@yearbook/shared';
import type { DataStore } from '../db.js';
import { adoptAiDraft, editAiDraft, getAiDraft, getAiTaskDetail, listAiDrafts, listAiDraftVersions } from './store.js';
import type { AiRunner } from './runner.js';

export function registerAiRoutes(app: FastifyInstance, store: DataStore, runner: AiRunner) {
  app.post('/api/ai/tasks', async (request, reply) => reply.code(202).send(await runner.create(aiTaskInputSchema.parse(request.body))));
  app.get<{ Params: { id: string } }>('/api/ai/tasks/:id', async request => store.write(() => getAiTaskDetail(store, request.params.id)));
  app.get('/api/ai/drafts', async request => store.write(() => listAiDrafts(store, request.query)));
  app.get<{ Params: { id: string } }>('/api/ai/drafts/:id', async request => store.write(() => getAiDraft(store, request.params.id)));
  app.put<{ Params: { id: string } }>('/api/ai/drafts/:id', async request => {
    const input = aiDraftUpdateSchema.parse(request.body);
    return store.write(() => editAiDraft(store, request.params.id, input.content));
  });
  app.get<{ Params: { id: string } }>('/api/ai/drafts/:id/versions', async request => store.write(() => listAiDraftVersions(store, request.params.id)));
  app.post<{ Params: { id: string } }>('/api/ai/drafts/:id/adopt', async request => {
    const input = aiAdoptSchema.parse(request.body ?? {});
    return store.write(() => adoptAiDraft(store, request.params.id, input.yearbookId));
  });
}
