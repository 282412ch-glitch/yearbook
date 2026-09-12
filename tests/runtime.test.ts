import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestWorkspace, type TestWorkspace } from './helpers.js';

type ServiceState = { pid: number; url: string; instanceId: string; token: string };
type RuntimeModule = {
  hash(value: string): string;
  isLocalUrl(value: unknown): boolean;
  health(url: unknown): Promise<{ app: string; status: string; pid: number; instanceId: string } | null>;
  stopService(state: Pick<ServiceState, 'pid' | 'url' | 'token'>): Promise<boolean>;
  waitForService(file: string, expectedId: string, child: { pid: number; exitCode: number | null }, timeout?: number): Promise<Omit<ServiceState, 'token'>>;
};
// Native .mjs files are shipped directly to Node, rather than included in the TypeScript build.
const runtime = await import(new URL('../scripts/runtime.mjs', import.meta.url).href) as RuntimeModule;

describe('本地启动器的服务身份与停止保护', () => {
  let workspace: TestWorkspace;
  let app: FastifyInstance;
  let state: ServiceState;
  const httpServers: Server[] = [];
  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const token = randomBytes(32).toString('hex');
    vi.stubEnv('YEARBOOK_INSTANCE_TOKEN', token);
    app = await workspace.open();
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    state = { pid: process.pid, url, token, instanceId: runtime.hash(token) };
  });
  afterEach(async () => {
    for (const server of httpServers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await workspace.dispose();
    vi.unstubAllEnvs();
  });

  it('只接受明确的本地 HTTP 服务地址，并以令牌哈希匹配真实健康接口', async () => {
    expect(runtime.isLocalUrl(state.url)).toBe(true);
    for (const url of ['https://127.0.0.1:4317', 'http://example.com:4317', 'http://127.0.0.1:4317/path', 'http://127.0.0.1:4317/?q=1', 'http://token@127.0.0.1:4317', 'http://127.0.0.1:4317/#fragment', 'not-a-url', null]) {
      expect(runtime.isLocalUrl(url), String(url)).toBe(false);
    }
    expect(runtime.hash(state.token)).toBe(createHash('sha256').update(state.token).digest('hex'));
    expect(await runtime.health(state.url)).toMatchObject({ app: 'yearbook', status: 'ok', pid: process.pid, instanceId: state.instanceId });
    expect(await runtime.health('https://example.com:4317')).toBeNull();
  });

  it('PID 或令牌不匹配时拒绝停止，原服务仍能读取和保存记录', async () => {
    await expect(runtime.stopService({ ...state, pid: state.pid + 1 })).rejects.toThrow('不属于本启动器');
    await expect(runtime.stopService({ ...state, token: 'not-the-owner' })).rejects.toThrow('不属于本启动器');
    expect(await runtime.health(state.url)).not.toBeNull();
    const response = await fetch(new URL('/api/records', state.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '其他启动器无权停止我。' }) });
    expect(response.status).toBe(201);
    const saved = await response.json() as { id: string; body: string };
    const read = await fetch(new URL(`/api/records/${saved.id}`, state.url));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ body: saved.body });
  });

  it('同端口上的无关服务不接收停止请求', async () => {
    const requests: string[] = [];
    const other = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ app: 'another-local-app', status: 'ok', pid: state.pid, instanceId: state.instanceId }));
    });
    httpServers.push(other);
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    const address = other.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP');
    expect(await runtime.stopService({ ...state, url: `http://127.0.0.1:${address.port}` })).toBe(false);
    expect(requests).toEqual(['GET /api/health']);
    expect(other.listening).toBe(true);
  });

  it('只有本次实例身份完整匹配才确认就绪，子进程退出时明确失败', async () => {
    const file = join(workspace.root, '启动 状态.json');
    await writeFile(file, JSON.stringify({ pid: state.pid, url: state.url, instanceId: state.instanceId }));
    expect(await runtime.waitForService(file, state.instanceId, { pid: state.pid, exitCode: null }, 500)).toEqual({ pid: state.pid, url: state.url, instanceId: state.instanceId });
    await expect(runtime.waitForService(file, 'wrong-instance', { pid: state.pid, exitCode: null }, 10)).rejects.toThrow('未在');
    await expect(runtime.waitForService(file, state.instanceId, { pid: state.pid, exitCode: 1 }, 100)).rejects.toThrow('提前退出');
  });

  it('匹配的启动器通过认证接口停止本实例，重复停止不影响其他进程', async () => {
    expect(await runtime.stopService(state)).toBe(true);
    expect(await runtime.health(state.url)).toBeNull();
    expect(await runtime.stopService(state)).toBe(false);
  });
});
