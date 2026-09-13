import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CheckCircle2, ImagePlus, Monitor, Moon, Palette, RotateCcw, Save, SlidersHorizontal, Sun, Trash2, X } from 'lucide-react';
import { defaultAppearance, prepareWallpaper, readAppearance, readWallpaper, saveAppearance, type AppearanceMode, type AppearancePreferences, type Wallpaper, type WallpaperTone } from './appearance-store';

type AppearanceState = { preferences: AppearancePreferences; wallpaper: Wallpaper | null };
type AppearanceContextValue = {
  current: AppearanceState;
  theme: 'light' | 'dark';
  open: () => void;
};
const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('AppearanceProvider is missing');
  return value;
}

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const next = URL.createObjectURL(blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState<AppearanceState>(() => ({ preferences: readAppearance(), wallpaper: null }));
  const [draft, setDraft] = useState(saved);
  const [opened, setOpened] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const current = opened ? draft : saved;
  const theme = current.preferences.mode === 'system' ? (systemDark ? 'dark' : 'light') : current.preferences.mode;
  const wallpaperUrl = useObjectUrl(current.wallpaper?.blob);

  useEffect(() => {
    let active = true;
    const preferences = readAppearance();
    void (async () => {
      try {
        const wallpaper = preferences.wallpaperId ? await readWallpaper(preferences.wallpaperId) : null;
        if (active) {
          setSaved({ preferences, wallpaper }); setDraft({ preferences, wallpaper });
          if (preferences.wallpaperId && !wallpaper) setLoadError('上次的壁纸已不在浏览器中，可以重新选择图片。');
        }
      } catch { if (active) setLoadError('暂时无法读取已保存的壁纸，可以重新选择图片。'); }
      finally { if (active) setReady(true); }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.frosted = String(current.preferences.enabled);
    root.dataset.wallpaperTone = current.preferences.tone;
    root.style.setProperty('--glass-density', String(current.preferences.density / 100));
    root.style.setProperty('--glass-blur', `${current.preferences.blur}px`);
    root.style.setProperty('--glass-saturation', `${current.preferences.saturation}%`);
    root.style.setProperty('--wallpaper-dim', String(current.preferences.dim / 100));
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17251f' : '#edf2ee');
  }, [current.preferences, theme]);

  function open() { if (ready) { setDraft(saved); setOpened(true); } }
  async function save() {
    await saveAppearance(draft.preferences, draft.wallpaper, saved.preferences.wallpaperId);
    setSaved(draft); setLoadError('');
  }

  return <AppearanceContext.Provider value={{ current, theme, open }}>
    <div className="app-backdrop" aria-hidden="true"><div className="window-landscape" />{wallpaperUrl && <div className="wallpaper-photo" style={{ backgroundImage: `url("${wallpaperUrl}")` }} />}<div className="wallpaper-shade" /></div>
    {children}
    {opened && <AppearanceDialog current={draft} saved={saved} wallpaperUrl={wallpaperUrl} loadError={loadError} onChange={setDraft} onSave={save} onClose={() => setOpened(false)} />}
  </AppearanceContext.Provider>;
}

const modes: { value: AppearanceMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor },
];
const tones: { value: WallpaperTone; label: string }[] = [{ value: 'mist', label: '雾青' }, { value: 'sky', label: '远山蓝' }, { value: 'sand', label: '麦穗' }];
const sliders = [
  { key: 'density', label: '玻璃浓度', min: 35, max: 100, unit: '%', hint: '通透', end: '清晰' },
  { key: 'blur', label: '背景模糊', min: 0, max: 48, unit: 'px', hint: '清楚', end: '朦胧' },
  { key: 'saturation', label: '色彩饱和度', min: 0, max: 200, unit: '%', hint: '素雅', end: '鲜明' },
  { key: 'dim', label: '壁纸暗度', min: 0, max: 80, unit: '%', hint: '明亮', end: '低光' },
] as const;

function AppearanceDialog({ current, saved, wallpaperUrl, loadError, onChange, onSave, onClose }: {
  current: AppearanceState; saved: AppearanceState; wallpaperUrl: string; loadError: string;
  onChange: (state: AppearanceState) => void; onSave: () => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const preferences = current.preferences;
  const dirty = JSON.stringify(preferences) !== JSON.stringify(saved.preferences);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { mounted.current = false; dialog.current?.close(); document.body.style.overflow = overflow; };
  }, []);
  function change(patch: Partial<AppearancePreferences>) {
    setMessage(''); onChange({ ...current, preferences: { ...preferences, ...patch } });
  }
  async function upload(file: File | undefined) {
    if (!file || operation.current) return;
    operation.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const wallpaper = await prepareWallpaper(file);
      if (mounted.current) onChange({ wallpaper, preferences: { ...preferences, enabled: true, wallpaperId: wallpaper.id, wallpaperName: wallpaper.name } });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '图片未能读取，请重试。'); }
    finally { operation.current = false; if (mounted.current) { setBusy(false); if (input.current) input.current.value = ''; } }
  }
  async function save() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try { await onSave(); if (mounted.current) setMessage('外观已保存，下次打开会自动恢复。'); }
    catch (reason) { if (mounted.current) setError(reason instanceof DOMException && reason.name === 'QuotaExceededError' ? '浏览器空间不足，请换一张较小的壁纸后保存。' : '外观未能保存，请检查浏览器是否允许本地存储后重试。'); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="appearance-dialog" aria-labelledby="appearance-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onClick={event => { if (event.target === dialog.current && !busy) onClose(); }}>
    <div className="appearance-heading"><div><span className="appearance-eyebrow"><SlidersHorizontal size={14} />让这里更像你</span><h2 id="appearance-title">窗景与外观</h2></div><button className="icon-button" autoFocus aria-label="关闭外观设置" disabled={busy} onClick={onClose}><X size={21} /></button></div>
    <p className="appearance-description">调整时即时预览，喜欢了再保存。</p>
    <fieldset className="appearance-fields" disabled={busy}>
      <legend className="sr-only">外观设置</legend>
      <div className="appearance-section"><h3>显示模式</h3><div className="appearance-modes" role="group" aria-label="显示模式">{modes.map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={preferences.mode === value} onClick={() => change({ mode: value })}><Icon size={18} /><span>{label}</span></button>)}</div></div>
      <div className="appearance-section"><div className="frosted-toggle-row"><div><h3 id="frosted-label">毛玻璃窗景</h3><p>让壁纸的颜色轻轻透进来。</p></div><button type="button" role="switch" className="appearance-switch" aria-labelledby="frosted-label" aria-checked={preferences.enabled} onClick={() => change({ enabled: !preferences.enabled })}><span /></button></div></div>
      <div className={`appearance-frost-controls${preferences.enabled ? '' : ' is-off'}`}>
        <fieldset disabled={!preferences.enabled || busy} className="appearance-fields">
          <legend className="sr-only">壁纸和玻璃效果</legend>
          <div className="wallpaper-picker-heading"><h3>窗外的风景</h3>{current.wallpaper && <button type="button" className="text-button danger-text" onClick={() => { onChange({ wallpaper: null, preferences: { ...preferences, wallpaperId: null, wallpaperName: '' } }); setMessage(''); }}><Trash2 size={14} />移除壁纸</button>}</div>
          <div className={`wallpaper-dropzone${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (preferences.enabled && !busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (preferences.enabled && !busy) void upload(event.dataTransfer.files[0]); }}>
            {wallpaperUrl ? <img src={wallpaperUrl} alt="当前壁纸预览" className="wallpaper-thumbnail" /> : <div className="wallpaper-placeholder window-landscape"><div className="wallpaper-mini-window"><i /><span /><span /></div></div>}
            <label className="wallpaper-upload"><ImagePlus size={18} /><span>{busy ? '正在处理…' : current.wallpaper ? '更换壁纸' : '选择图片，或拖到这里'}</span><input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="选择壁纸" onChange={event => void upload(event.target.files?.[0])} /></label>
          </div>
          <p className="wallpaper-file-name">{current.wallpaper?.name || 'JPEG / PNG / WebP / GIF · 图片只保存在此浏览器'}</p>
          <div className="wallpaper-tones" role="group" aria-label="内置窗景">{tones.map(tone => <button type="button" key={tone.value} className={`wallpaper-tone tone-${tone.value}`} aria-pressed={!current.wallpaper && preferences.tone === tone.value} onClick={() => { onChange({ wallpaper: null, preferences: { ...preferences, tone: tone.value, wallpaperId: null, wallpaperName: '' } }); setMessage(''); }}><span>{!current.wallpaper && preferences.tone === tone.value && <Check size={12} />}</span>{tone.label}</button>)}</div>
          <div className="appearance-sliders">{sliders.map(slider => <label className="appearance-slider" key={slider.key}><span>{slider.label}<output>{preferences[slider.key]}<small>{slider.unit}</small></output></span><input type="range" min={slider.min} max={slider.max} step="1" value={preferences[slider.key]} aria-label={slider.label} aria-valuetext={`${preferences[slider.key]} ${slider.unit}`} onChange={event => change({ [slider.key]: Number(event.target.value) })} /><span className="slider-endpoints"><small>{slider.hint}</small><small>{slider.end}</small></span></label>)}</div>
        </fieldset>
      </div>
      <button type="button" className="text-button appearance-reset" onClick={() => { onChange({ preferences: { ...defaultAppearance }, wallpaper: null }); setMessage(''); }}><RotateCcw size={14} />恢复默认外观</button>
    </fieldset>
    {(error || loadError) && <p className="appearance-error" role="alert">{error || loadError}</p>}
    {message && <p className="appearance-message" role="status"><CheckCircle2 size={16} />{message}</p>}
    <footer className="appearance-footer"><span className={`appearance-save-state${dirty ? ' is-dirty' : ''}`}><i />{dirty ? '预览中 · 尚未保存' : '已保存'}</span><div><button type="button" className="text-button" disabled={!dirty || busy} onClick={() => { onChange(saved); setError(''); setMessage(''); }}>撤销更改</button><button type="button" className="button primary" disabled={!dirty || busy} onClick={() => void save()}><Save size={16} />{busy ? '处理中…' : '保存外观'}</button></div></footer>
  </dialog>;
}

export function AppearanceSettingsCard() {
  const { current, open } = useAppearance();
  const mode = modes.find(mode => mode.value === current.preferences.mode)?.label;
  return <section className="settings-section appearance-settings-card" id="appearance"><div className="appearance-settings-icon"><Palette size={26} strokeWidth={1.4} /></div><div><h2>窗景与外观</h2><p className="helper">{mode} · {current.preferences.enabled ? '毛玻璃已开启' : '纯色阅读'}{current.wallpaper ? ' · 自选壁纸' : ''}</p><p>选一张喜欢的壁纸，调一调窗里的光。</p></div><button type="button" className="button secondary" onClick={open}><SlidersHorizontal size={17} />调整外观</button></section>;
}
