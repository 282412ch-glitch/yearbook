import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const runtimeDir = resolve(root, '.runtime');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function checkNode() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14 || (minor === 14 && patch < 1)) throw new Error(`需要 Node.js 24 LTS（24.14.1 或更高的 24.x），当前为 ${process.versions.node}`);
}
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
export function isLocalUrl(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password; } catch { return false; }
}
export async function health(url) {
  if (!isLocalUrl(url)) return null;
  try {
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const value = await response.json();
    return value.app === 'yearbook' && value.status === 'ok' ? value : null;
  } catch { return null; }
}
export async function waitForService(runtimeFile, expectedId, child, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`本地服务提前退出（${child.exitCode}），请查看启动日志`);
    const state = await readJson(runtimeFile);
    if (state?.pid === child.pid && state.instanceId === expectedId) {
      const current = await health(state.url);
      if (current?.pid === child.pid && current.instanceId === expectedId) return state;
    }
    await delay(150);
  }
  throw new Error('本地服务未在 25 秒内就绪，请检查启动日志、数据目录或端口');
}
export async function stopService(state) {
  const current = await health(state?.url);
  if (!current) return false;
  if (current.pid !== state.pid || current.instanceId !== hash(state.token ?? '')) throw new Error('此地址的服务不属于本启动器，已保留该进程');
  const response = await fetch(new URL('/api/system/shutdown', state.url), {
    method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('服务拒绝停止请求，未终止任何其他进程');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await health(state.url))) return true;
    await delay(150);
  }
  throw new Error('服务仍在收尾，请稍后再次停止；不会强制结束其他进程');
}
