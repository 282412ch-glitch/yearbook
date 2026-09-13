export type AppearanceMode = 'light' | 'dark' | 'system';
export type WallpaperTone = 'mist' | 'sky' | 'sand';

export type AppearancePreferences = {
  mode: AppearanceMode;
  enabled: boolean;
  density: number;
  blur: number;
  saturation: number;
  dim: number;
  tone: WallpaperTone;
  wallpaperId: string | null;
  wallpaperName: string;
};

export type Wallpaper = { id: string; name: string; blob: Blob };
export const appearanceKey = 'yearbook:appearance:v1';
export const defaultAppearance: AppearancePreferences = {
  mode: 'system', enabled: true, density: 78, blur: 24, saturation: 115,
  dim: 10, tone: 'mist', wallpaperId: null, wallpaperName: '',
};

export function normalizeAppearance(value: unknown): AppearancePreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const number = (key: 'density' | 'blur' | 'saturation' | 'dim', min: number, max: number) => {
    const value = input[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : defaultAppearance[key];
  };
  return {
    mode: input.mode === 'light' || input.mode === 'dark' ? input.mode : 'system',
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    density: number('density', 35, 100), blur: number('blur', 0, 48),
    saturation: number('saturation', 0, 200), dim: number('dim', 0, 80),
    tone: input.tone === 'sky' || input.tone === 'sand' ? input.tone : 'mist',
    wallpaperId: typeof input.wallpaperId === 'string' && /^[a-f0-9-]{36}$/i.test(input.wallpaperId) ? input.wallpaperId : null,
    wallpaperName: typeof input.wallpaperName === 'string' ? input.wallpaperName.slice(0, 255) : '',
  };
}

export function readAppearance(): AppearancePreferences {
  try { return normalizeAppearance(JSON.parse(localStorage.getItem(appearanceKey) || 'null')); }
  catch { return { ...defaultAppearance }; }
}

async function wallpaperStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yearbook-appearance', 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore('wallpapers');
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('请关闭其他年册标签页，再保存外观。')); };
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('wallpapers', mode);
      const request = run(transaction.objectStore('wallpapers'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || request.error || new Error('壁纸未能保存。'));
      transaction.onerror = () => reject(transaction.error || request.error);
    });
  } finally { database.close(); }
}

export async function readWallpaper(id: string): Promise<Wallpaper | null> {
  const stored = await wallpaperStore('readonly', store => store.get(id));
  return stored?.blob instanceof Blob ? { id, name: typeof stored.name === 'string' ? stored.name : '我的壁纸', blob: stored.blob } : null;
}

/** Commit the small manifest only after its image exists. A failed save keeps the previous appearance readable. */
export async function saveAppearance(preferences: AppearancePreferences, wallpaper: Wallpaper | null, previousId: string | null): Promise<void> {
  const added = wallpaper && wallpaper.id !== previousId ? wallpaper : null;
  if (added) await wallpaperStore('readwrite', store => store.put({ name: added.name, blob: added.blob }, added.id));
  try { localStorage.setItem(appearanceKey, JSON.stringify(preferences)); }
  catch (error) {
    if (added) await wallpaperStore('readwrite', store => store.delete(added.id)).catch(() => {});
    throw error;
  }
  if (previousId && previousId !== preferences.wallpaperId) {
    // The new preference is already committed. Reclaiming an unused image is best effort.
    await wallpaperStore('readwrite', store => store.delete(previousId)).catch(() => {});
  }
}

export async function prepareWallpaper(file: File): Promise<Wallpaper> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = String.fromCharCode(...bytes);
  const supported = (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || signature.startsWith('\u0089PNG\r\n\u001a\n')
    || signature.startsWith('GIF87a') || signature.startsWith('GIF89a')
    || (signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP');
  if (!supported) throw new Error('请选择 JPEG、PNG、WebP 或 GIF 图片。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('empty image');
  } catch { throw new Error('这张图片无法读取，请重新选择一张。'); }
  finally { URL.revokeObjectURL(url); }
  return { id: crypto.randomUUID(), name: file.name, blob: file };
}
