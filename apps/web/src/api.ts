import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from '@yearbook/shared';

export async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = init.signal;
  const abort = () => controller.abort();
  if (external?.aborted) abort();
  external?.addEventListener('abort', abort, { once: true });
  try {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers, signal: controller.signal });
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error('本地服务返回了无法读取的内容，请重试。'); }
    if (!response.ok) throw new Error((data as ApiError)?.error?.message || `请求未完成（${response.status}），请重试。`);
    return data as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (external?.aborted) throw error;
      throw new Error('等待本地服务超时。请检查服务是否仍在运行，然后重试。');
    }
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请启动《一年一册》后重试。');
    throw error;
  } finally { clearTimeout(timer); external?.removeEventListener('abort', abort); }
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';

export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const current = useRef(path);
  current.current = path;
  useEffect(() => {
    if (!path) { setLoading(false); setData(null); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    api<T>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted && current.current === path) setData(value);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, revision]);
  const reload = useCallback(() => setRevision(n => n + 1), []);
  return { data, loading, error, reload, setData };
}

export function readableDate(date: string | null, short = false) {
  if (!date) return '日期待补';
  const [y, m, d] = date.split('-');
  return short ? `${Number(m)}月${Number(d)}日` : `${y}年${Number(m)}月${Number(d)}日`;
}
export function readableTime(date: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}
export function fileSize(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
