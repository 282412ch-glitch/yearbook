import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpRight, Check, ImagePlus, LoaderCircle, MapPin, Sprout, Users, X } from 'lucide-react';
import type { MediaItem, RecordItem, RecordMedia } from '@yearbook/shared';
import { api, errorText, readableDate } from './api';

export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="heading-actions">{children}</div>}</header>;
}
export function Loading({ label = '正在翻开记录…' }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle size={20} className="spin" /><span>{label}</span></div>;
}
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  if (!message) return null;
  return <div className="notice error" role="alert"><AlertCircle size={20} /><span>{message}</span>{retry && <button type="button" className="text-button" onClick={retry}>重试</button>}</div>;
}
export function StatusNotice({ children }: { children: ReactNode }) {
  return <div className="notice success" role="status"><Check size={20} /><span>{children}</span></div>;
}
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-glyph" aria-hidden="true"><Sprout size={32} strokeWidth={1.4} /></span><h2>{title}</h2><p>{description}</p>{action}</div>;
}

export function RecordCard({ record, compact = false }: { record: RecordItem; compact?: boolean }) {
  const cover = record.media[0];
  return <article className={`record-card ${compact ? 'compact' : ''}`}>
    {cover && <Link className="record-cover" to={`/records/${record.id}`} tabIndex={-1} aria-hidden="true"><img src={cover.thumbnailUrl} alt="" loading="lazy" width={cover.width} height={cover.height} />{record.media.length > 1 && <span className="photo-count">{record.media.length} 张</span>}</Link>}
    <div className="record-card-text"><div className="record-date"><time dateTime={record.occurredOn || undefined}>{readableDate(record.occurredOn)}</time>{record.isFirst && <span className="first-mark"><Sprout size={16} />第一次</span>}</div><h2><Link to={`/records/${record.id}`}>{record.title || (record.body ? record.body.slice(0, 30) : '照片里的这一天')}</Link></h2>{record.body && <p className="record-excerpt">{record.body}</p>}<div className="record-meta">{record.location && <span><MapPin size={16} />{record.location}</span>}{record.people.length > 0 && <span><Users size={16} />{record.people.join('、')}</span>}{record.tags.map(tag => <Link key={tag} to={`/records?tag=${encodeURIComponent(tag)}`} className="tag">#{tag}</Link>)}</div></div>
  </article>;
}

export function PhotoViewer({ photos, initial, onClose }: { photos: RecordMedia[]; initial: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(initial);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  const photo = photos[index];
  if (!photo) return null;
  return <dialog ref={ref} className="photo-dialog" onCancel={onClose} onClick={event => { if (event.target === ref.current) onClose(); }} aria-label="照片预览">
    <div className="photo-toolbar"><span>{index + 1} / {photos.length}</span><a href={photo.originalUrl} target="_blank" rel="noreferrer" className="text-link">查看原图<ArrowUpRight size={16} /></a><button className="icon-button" aria-label="关闭照片" onClick={onClose}><X size={20} /></button></div>
    <img src={photo.displayUrl} alt={photo.caption || photo.filename} width={photo.width} height={photo.height} /><div className="photo-footer"><button className="button secondary" disabled={index === 0} onClick={() => setIndex(i => i - 1)}>上一张</button><p>{photo.caption || photo.filename}</p><button className="button secondary" disabled={index === photos.length - 1} onClick={() => setIndex(i => i + 1)}>下一张</button></div>
  </dialog>;
}

export function PhotoImporter({ photos, onChange, onSuggestedDate, onBusyChange }: { photos: RecordMedia[]; onChange: (photos: RecordMedia[]) => void; onSuggestedDate?: (date: string) => void; onBusyChange?: (busy: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(photos); latest.current = photos;
  const [pending, setPending] = useState<{ id: string; name: string; url: string }[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [viewer, setViewer] = useState<number | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function importFiles(files: File[]) {
    if (!files.length) return;
    setError(''); setMessage('');
    if (files.length + latest.current.length > 100) { setError('每条记录最多添加 100 张照片。请分批记录。'); return; }
    const previews = files.map(file => ({ id: crypto.randomUUID(), name: file.name, url: URL.createObjectURL(file) }));
    setPending(previews); onBusyChange?.(true);
    const requestController = new AbortController(); controller.current = requestController;
    const body = new FormData(); files.forEach(file => body.append('files', file));
    try {
      const result = await api<{ items: MediaItem[]; duplicates: number }>('/api/media', { method: 'POST', body, signal: requestController.signal });
      const ids = new Set(latest.current.map(item => item.id));
      const additions = result.items.filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true; }).map(item => ({ ...item, caption: '' }));
      onChange([...latest.current, ...additions]);
      setMessage(`已导入 ${additions.length} 张照片${result.duplicates ? `，${result.duplicates} 个重复文件已复用` : ''}。保存记录后即可在时间轴中找到。`);
    } catch (error) { setError(requestController.signal.aborted ? '已取消导入，可以重新选择照片。' : errorText(error)); }
    finally { previews.forEach(item => URL.revokeObjectURL(item.url)); setPending([]); onBusyChange?.(false); if (input.current) input.current.value = ''; }
  }
  function reorder(index: number, by: number) {
    const next = [...photos]; const target = index + by;
    if (target < 0 || target >= photos.length) return;
    [next[index], next[target]] = [next[target], next[index]]; onChange(next);
  }
  return <div className="photo-importer">
    <div className="photo-import-header"><div><h2>照片 <span className="muted-count">{photos.length || ''}</span></h2><p className="helper">原图会复制到本机资料库。可以补说明、调整顺序。</p></div><label className={`button secondary file-label ${pending.length ? 'disabled' : ''}`}><ImagePlus size={20} />添加照片<input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/tiff,image/gif" multiple disabled={pending.length > 0} onChange={e => void importFiles(Array.from(e.target.files || []))} aria-label="添加照片" /></label></div>
    {!photos.length && !pending.length && <button type="button" className="upload-empty" onClick={() => input.current?.click()}><ImagePlus size={32} strokeWidth={1.4} /><span>选一张照片，也可以一次选好几张</span><small>JPEG、PNG、WebP、AVIF、TIFF、GIF</small></button>}
    {pending.length > 0 && <><div className="pending-photos">{pending.map(item => <figure key={item.id}><img src={item.url} alt={`正在导入：${item.name}`} /><figcaption>{item.name}</figcaption></figure>)}</div><div className="inline-status" role="status"><LoaderCircle size={20} className="spin" />正在复制原图并生成缩略图…<button type="button" className="text-button" onClick={() => controller.current?.abort()}>取消导入</button></div></>}
    <ErrorNotice message={error} />{message && <p className="helper success-text" role="status">{message}</p>}
    <div className="photo-edit-grid">{photos.map((photo, index) => <div className="photo-edit-item" key={photo.id}><button type="button" className="photo-preview-button" onClick={() => setViewer(index)} aria-label={`预览第 ${index + 1} 张照片`}><img src={photo.thumbnailUrl} alt={photo.caption || photo.filename} width={photo.width} height={photo.height} /></button><div className="photo-item-tools"><span className="photo-order">{String(index + 1).padStart(2, '0')}</span><button type="button" className="icon-button" aria-label={`将第 ${index + 1} 张照片前移`} disabled={index === 0} onClick={() => reorder(index, -1)}><ArrowUp size={16} /></button><button type="button" className="icon-button" aria-label={`将第 ${index + 1} 张照片后移`} disabled={index === photos.length - 1} onClick={() => reorder(index, 1)}><ArrowDown size={16} /></button><button type="button" className="icon-button" aria-label={`移除第 ${index + 1} 张照片`} onClick={() => onChange(photos.filter(item => item.id !== photo.id))}><X size={16} /></button></div><label className="photo-caption-label">照片说明<input value={photo.caption} maxLength={1000} placeholder="当时的场景，或照片里的人" onChange={event => onChange(photos.map(item => item.id === photo.id ? { ...item, caption: event.target.value } : item))} /></label>{photo.suggestedDate && onSuggestedDate && <button type="button" className="date-suggestion" onClick={() => onSuggestedDate(photo.suggestedDate!)}>照片时间：{readableDate(photo.suggestedDate)} · 用作日期</button>}</div>)}</div>
    {viewer !== null && <PhotoViewer photos={photos} initial={viewer} onClose={() => setViewer(null)} />}
  </div>;
}
