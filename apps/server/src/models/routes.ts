import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { modelCapabilitySchema, modelProfileInputSchema, modelProtocolSchema, normalizeModelUrl } from '@yearbook/shared';
import type { ModelService } from './service.js';

export function registerModelRoutes(app: FastifyInstance, service: ModelService) {
  app.get('/api/model-profiles', () => service.list());
  app.get('/api/model-profiles/credential-status', () => service.vault.status());
  app.post('/api/model-profiles/normalize', request => {
    const body = z.object({ baseUrl: z.string().max(2000), protocol: modelProtocolSchema }).strict().parse(request.body);
    // Use the same validated field in the UI, on save, and at the protocol boundary.
    const parsed = modelProfileInputSchema.parse({ ...body, name: '地址预览', model: 'preview' });
    return normalizeModelUrl(parsed.baseUrl, parsed.protocol);
  });
  app.post('/api/model-profiles', async (request, reply) => reply.code(201).send(await service.save(modelProfileInputSchema.parse(request.body))));
  app.get<{ Params: { id: string } }>('/api/model-profiles/:id', request => service.getProfile(request.params.id));
  app.put<{ Params: { id: string } }>('/api/model-profiles/:id', request => service.save(modelProfileInputSchema.parse(request.body), request.params.id));
  app.delete<{ Params: { id: string } }>('/api/model-profiles/:id', request => service.remove(request.params.id));
  app.post<{ Params: { id: string } }>('/api/model-profiles/:id/activate', request => service.activate(request.params.id));
  app.get<{ Params: { id: string } }>('/api/model-profiles/:id/models', request => service.models(request.params.id));
  app.post<{ Params: { id: string } }>('/api/model-profiles/:id/test', async (request, reply) => {
    const body = z.object({ capability: modelCapabilitySchema }).strict().parse(request.body);
    const controller = new AbortController();
    const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on('close', cancel);
    try { return await service.test(request.params.id, body.capability, controller.signal); }
    finally { reply.raw.off('close', cancel); }
  });
}
