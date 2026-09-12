import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CalendarDays, Check, LockKeyhole, Mail, MailOpen, PencilLine, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { isLocalDate, letterInputSchema, localDate, type LetterDetail, type LetterEnvelope, type LetterInput, type LetterList, type LetterSummary, type RecordMedia } from '@yearbook/shared';
import { api, errorText, readableDate, readableTime, useResource } from './api';
import { EmptyState, ErrorNotice, Loading, PageHeading, PhotoImporter, PhotoViewer, StatusNotice } from './components';
import './letters.css';

const letterStatus = { draft: '还在写', sealed: '已封存', due: '可以拆阅', read: '已读过' };
type LetterDraft = Omit<LetterInput, 'media'> & { media: RecordMedia[] };
type BrowserDraft = { version: 1; savedAt: string; value: LetterDraft };

function inputFromDraft(value: LetterDraft): LetterInput {
  return { title: value.title, body: value.body, unlockOn: value.unlockOn, media: value.media.map(({ id, caption }) => ({ id, caption })) };
}
function readBrowserDraft(key: string): BrowserDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as BrowserDraft | null;
    if (!value || value.version !== 1 || !value.value || !Array.isArray(value.value.media)) return null;
    if (!letterInputSchema.safeParse(inputFromDraft(value.value)).success) return null;
    if (value.value.media.some(photo => typeof photo.thumbnailUrl !== 'string' || !photo.thumbnailUrl.startsWith('/api/media/'))) return null;
    return value;
  } catch { return null; }
}
function removeBrowserDraft(key: string) { try { localStorage.removeItem(key); } catch { /* Storage may be disabled; the saved library is unaffected. */ } }
function defaultUnlockDate() {
  const now = new Date();
  return localDate(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));
}

export function HomeLetterNotice() {
  const summary = useResource<LetterSummary>('/api/letters/summary');
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') summary.reload(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [summary.reload]);
  if (summary.error) return <ErrorNotice message={summary.error} retry={summary.reload} />;
  if (!summary.data?.dueUnread) return null;
  return <aside className="letter-home-notice" aria-label="到期的未来信"><MailOpen size={26} strokeWidth={1.5} /><div><h2>过去的你，留了 {summary.data.dueUnread} 封信</h2><p>已到约定的日期，找个安静的时候拆开吧。</p></div><Link className="button secondary" to="/letters?status=due">去拆信<ArrowRight size={16} /></Link></aside>;
}

export function LettersPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const deleted = params.get('deleted') === 'true';
  const status = ['draft', 'sealed', 'due', 'read'].includes(params.get('status') || '') ? params.get('status')! : 'all';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const query = new URLSearchParams({ status, limit: '24', offset: String(offset) });
  if (deleted) query.set('deleted', 'true');
  const letters = useResource<LetterList>(`/api/letters?${query}`);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState((location.state as { message?: string } | null)?.message || '');
  function filter(value: string) { setParams(value === 'deleted' ? { deleted: 'true' } : value === 'all' ? {} : { status: value }); setMessage(''); }
  async function restore(id: string) {
    setBusy(id); setError('');
    try { await api(`/api/letters/${id}/restore`, { method: 'POST' }); setMessage('信件已恢复，原来的查看日期和照片都保留。'); letters.reload(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  const emptyTitles = { all: '留一封信，给以后某一天', draft: '没有写到一半的信', sealed: '没有等待拆阅的信', due: '还没有到期未读的信', read: '还没有拆阅过的信' };
  return <><PageHeading title={deleted ? '信件回收站' : '给未来的信'} description={deleted ? '误删的信还在这里。恢复后仍遵守原来的查看日期。' : '把此刻想说的话，留到约定的那一天。'}><Link className="button primary" to="/letters/new"><Plus size={18} />写一封信</Link></PageHeading>
    <div className="letter-how-it-works"><Mail size={22} strokeWidth={1.5} /><p>先存草稿，写好再封存。到期后会在首页提醒；程序关闭期间无需保持运行，下次启动或访问时检查日期。</p></div>
    <div className="letter-filters" role="group" aria-label="筛选信件">{([['all', '全部'], ['draft', '草稿'], ['sealed', '等待拆阅'], ['due', '到期未读'], ['read', '已读'], ['deleted', '回收站']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={value === 'deleted' ? deleted : !deleted && status === value} onClick={() => filter(value)}>{label}</button>)}</div>
    <ErrorNotice message={letters.error || error} retry={letters.error ? letters.reload : undefined} />{message && <StatusNotice>{message}</StatusNotice>}
    {letters.loading ? <Loading label="正在整理信件…" /> : letters.data?.items.length ? <><div className="letter-list">{letters.data.items.map(letter => <article className={`letter-card status-${letter.status}`} key={letter.id}>
      <div className="letter-envelope-mark" aria-hidden="true">{letter.status === 'read' ? <MailOpen size={30} strokeWidth={1.3} /> : letter.status === 'draft' ? <PencilLine size={28} strokeWidth={1.3} /> : <Mail size={30} strokeWidth={1.3} />}</div>
      <div className="letter-card-content"><div className="letter-card-meta"><span className="letter-status">{letterStatus[letter.status]}</span><span>{letter.photoCount ? `附 ${letter.photoCount} 张照片` : '一封文字信'}</span></div><h2><Link to={letter.status === 'draft' && !deleted ? `/letters/${letter.id}/edit` : `/letters/${letter.id}`}>{letter.title || '给以后的自己'}</Link></h2><p>{letter.unlockOn ? `${readableDate(letter.unlockOn)} 拆阅` : '查看日期待定'}</p><small>{letter.sealedAt ? `封存于 ${readableTime(letter.sealedAt)}` : `上次写到 ${readableTime(letter.updatedAt)}`}</small></div>
      <div className="letter-card-action">{deleted ? <button className="button secondary" disabled={!!busy} onClick={() => void restore(letter.id)}><RotateCcw size={16} />{busy === letter.id ? '正在恢复…' : '恢复信件'}</button> : <Link className={letter.status === 'due' ? 'button primary' : 'text-link'} to={letter.status === 'draft' ? `/letters/${letter.id}/edit` : `/letters/${letter.id}`}>{letter.status === 'draft' ? '接着写' : letter.status === 'due' ? '去拆信' : letter.status === 'read' ? '再读一遍' : '查看信封'}<ArrowRight size={16} /></Link>}</div>
    </article>)}</div><div className="letter-pagination"><span>共 {letters.data.total} 封信</span>{letters.data.total > 24 && <div className="inline-actions"><button className="button secondary" disabled={!offset} onClick={() => { const next = new URLSearchParams(params); next.set('offset', String(Math.max(0, offset - 24))); setParams(next); }}>上一页</button><button className="button secondary" disabled={offset + 24 >= letters.data.total} onClick={() => { const next = new URLSearchParams(params); next.set('offset', String(offset + 24)); setParams(next); }}>下一页</button></div>}</div></> : !letters.error && <EmptyState title={deleted ? '信件回收站是空的' : emptyTitles[status as keyof typeof emptyTitles]} description={deleted ? '移入回收站的信件可以在这里恢复。' : status === 'due' ? '信件到了约定日期会出现在这里。不用一直开着程序等候。' : '可以从一句话开始，也可以附上此刻的一张照片。'} action={<Link className="button secondary" to={deleted ? '/letters' : '/letters/new'}>{deleted ? '返回信件' : '写一封信'}<ArrowRight size={16} /></Link>} />}
  </>;
}

export function LetterEditorPage() {
  const { id } = useParams();
  const letter = useResource<LetterDetail>(id ? `/api/letters/${id}` : null);
  if (id && letter.loading) return <Loading label="正在打开信件草稿…" />;
  if (letter.error) return <ErrorNotice message={letter.error} retry={letter.reload} />;
  if (id && !letter.data) return null;
  if (letter.data && (letter.data.status !== 'draft' || letter.data.deletedAt)) return <><PageHeading title={letter.data.deletedAt ? '这封信在回收站中' : '这封信已经封存'} description={letter.data.deletedAt ? '恢复后才能继续操作。' : '封存后不能修改文字、照片或查看日期。'} /><Link className="button secondary" to={`/letters/${id}`}>返回信封<ArrowRight size={16} /></Link></>;
  const initial: LetterDraft = letter.data ? { title: letter.data.title, body: letter.data.body || '', unlockOn: letter.data.unlockOn, media: letter.data.media || [] } : { title: '', body: '', unlockOn: defaultUnlockDate(), media: [] };
  return <LetterEditor key={id || 'new'} id={id} initial={initial} />;
}

function SealConfirmation({ date, busy, onConfirm, onCancel }: { date: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="letter-confirm-dialog" aria-labelledby="seal-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}><LockKeyhole size={28} strokeWidth={1.5} /><h2 id="seal-title">把这封信留到 {readableDate(date)}</h2><p>本次文字和照片会先保存，再封存。封存后不能修改，也不能提前拆阅。</p><p className="helper">到了约定日期，下次打开《一年一册》时就能看到提醒。</p><div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>再检查一下</button><button type="button" className="button primary" disabled={busy} onClick={onConfirm}>{busy ? '正在封存…' : '确认封存'}</button></div></dialog>;
}

function LetterEditor({ id, initial }: { id?: string; initial: LetterDraft }) {
  const navigate = useNavigate();
  const location = useLocation();
  const key = `yearbook:letter-draft:${id || 'new'}`;
  const [draft, setDraft] = useState(initial);
  const [recoverable, setRecoverable] = useState(() => readBrowserDraft(key));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState((location.state as { error?: string } | null)?.error || '');
  const [status, setStatus] = useState((location.state as { saved?: boolean } | null)?.saved ? '草稿已保存，可以继续写。' : id ? '草稿已保存在本机' : '还没有保存信件');
  const suppress = useRef(false);
  const current = useRef({ draft, dirty }); current.current = { draft, dirty };
  const stableId = useRef(id);
  function cacheDraft() {
    if (suppress.current || !current.current.dirty) return;
    localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), value: current.current.draft }));
  }
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => { try { cacheDraft(); setStatus('未提交的文字和照片已保留在此浏览器'); } catch { setStatus('浏览器无法保留草稿，请及时保存'); } }, 250);
    return () => clearTimeout(timer);
  }, [draft, dirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (current.current.dirty && !suppress.current) { try { cacheDraft(); } catch { /* The native warning still allows saving. */ } event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('beforeunload', beforeUnload); try { cacheDraft(); } catch { /* Saved letters remain in SQLite. */ } };
  }, [key]);
  function update<K extends keyof LetterDraft>(field: K, value: LetterDraft[K]) {
    if (saving) return;
    suppress.current = false; setDraft(previous => ({ ...previous, [field]: value })); setDirty(true); setError(''); setStatus('正在保留未提交草稿…');
  }
  function validateSeal() {
    if (!draft.unlockOn || !isLocalDate(draft.unlockOn)) { setError('请先选择有效的查看日期，再封存这封信。'); document.getElementById('letter-unlockOn')?.focus(); return; }
    if (draft.unlockOn < localDate()) { setError('查看日期不能早于今天，请选择今天或未来的一天。'); document.getElementById('letter-unlockOn')?.focus(); return; }
    if (!draft.body.trim() && !draft.media.length) { setError('写下一句话，或添加一张照片，再封存。'); document.getElementById('letter-body')?.focus(); return; }
    setError(''); setConfirming(true);
  }
  async function save(seal = false) {
    if (saving || uploading) return;
    const parsed = letterInputSchema.safeParse(inputFromDraft(draft));
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || '请检查信件内容'); return; }
    setSaving(true); setError('');
    let saved: LetterDetail | undefined;
    try {
      const target = stableId.current;
      saved = await api<LetterDetail>(target ? `/api/letters/${target}` : '/api/letters', { method: target ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) });
      stableId.current = saved.id;
      if (seal) {
        await api<LetterDetail>(`/api/letters/${saved.id}/seal`, { method: 'POST', body: '{}' });
        suppress.current = true; current.current.dirty = false; setDirty(false); removeBrowserDraft(key); removeBrowserDraft(`yearbook:letter-draft:${saved.id}`);
        navigate(`/letters/${saved.id}`, { replace: true, state: { sealed: true } });
      } else {
        suppress.current = true; current.current.dirty = false; setDirty(false); removeBrowserDraft(key); setRecoverable(null); setStatus('草稿已保存，可以继续写。');
        if (!id) navigate(`/letters/${saved.id}/edit`, { replace: true, state: { saved: true } });
      }
    } catch (e) {
      const message = `${seal && saved ? '草稿已保存，封存尚未完成。' : ''}${errorText(e)}`;
      setError(message); setConfirming(false);
      if (saved && !id) { suppress.current = true; current.current.dirty = false; removeBrowserDraft(key); navigate(`/letters/${saved.id}/edit`, { replace: true, state: { error: message } }); }
    } finally { setSaving(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void save(); }
  return <><Link className="back-link" to="/letters"><ArrowLeft size={16} />返回信件</Link><PageHeading title={id ? '继续写这封信' : '写一封信'} description="把现在的话写下来，让以后的自己慢慢读。" />
    {recoverable && <div className="draft-recovery" role="status"><div><strong>这里有一份未提交的信件草稿</strong><p>恢复后可以继续写；封存前请再检查正文、照片和查看日期。</p></div><div className="inline-actions"><button className="button secondary" onClick={() => { suppress.current = false; setDraft(recoverable.value); setDirty(true); setRecoverable(null); setStatus('已恢复未提交草稿，请检查后保存'); }}>恢复草稿</button><button className="text-button" onClick={() => { removeBrowserDraft(key); setRecoverable(null); }}>放弃草稿</button></div></div>}
    <form className="letter-editor" onSubmit={submit} noValidate><fieldset disabled={saving} className="letter-editor-fields"><div className="letter-writing-sheet"><div className="letter-sheet-heading"><span>给以后的自己</span><Mail size={26} strokeWidth={1.2} /></div><label htmlFor="letter-title">信件标题 <span className="helper">选填，会写在信封上</span></label><input className="title-input" id="letter-title" value={draft.title} maxLength={200} placeholder="例如：等到明年秋天再读" onChange={e => update('title', e.target.value)} /><label htmlFor="letter-body">信的正文</label><textarea className="writing-area" id="letter-body" rows={12} value={draft.body} maxLength={100000} placeholder="读到这封信的时候，你正在过怎样的日子？" onChange={e => update('body', e.target.value)} /><div className="body-helper"><span className="helper">不用一次写完，先存草稿也很好。</span><span>{draft.body.length.toLocaleString('zh-CN')} 字</span></div><PhotoImporter photos={draft.media} onChange={photos => update('media', photos)} onBusyChange={setUploading} context="letter" /></div>
      <aside className="letter-editor-aside"><CalendarDays size={26} strokeWidth={1.4} /><h2>约定一个日子</h2><label htmlFor="letter-unlockOn">查看日期<input id="letter-unlockOn" type="date" min={localDate()} max="9999-12-31" value={draft.unlockOn || ''} onChange={e => update('unlockOn', e.target.value || null)} aria-describedby="letter-date-help" /></label><p id="letter-date-help" className="helper">草稿可以随时修改。封存后，要等到这一天才能拆阅。</p><div className="letter-process-note"><LockKeyhole size={18} /><p>信件单独保存，不会出现在时间轴、记忆盲盒或 AI 整理素材中。</p></div><p className="helper">到期提醒会在下次启动或访问时出现。关闭程序期间不需要保持后台运行。</p></aside></fieldset>
      <div className="editor-save-bar"><div className="save-status" role="status"><Check size={16} /><span>{status}</span></div><div className="inline-actions"><Link className="text-link" to="/letters">稍后再写</Link><button type="submit" className="button secondary" disabled={saving || uploading}><Save size={18} />{saving && !confirming ? '正在保存…' : '保存草稿'}</button><button type="button" className="button primary" disabled={saving || uploading} onClick={validateSeal}><LockKeyhole size={18} />{uploading ? '照片导入中…' : '封存这封信'}</button></div><ErrorNotice message={error} /></div>
    </form>{confirming && draft.unlockOn && <SealConfirmation date={draft.unlockOn} busy={saving} onConfirm={() => void save(true)} onCancel={() => setConfirming(false)} />}
  </>;
}

function Envelope({ letter, onRead, busy }: { letter: LetterEnvelope; onRead: () => void; busy: boolean }) {
  return <section className={`sealed-letter status-${letter.status}`}><span className="sealed-letter-icon">{letter.status === 'due' ? <MailOpen size={48} strokeWidth={1.1} /> : <Mail size={48} strokeWidth={1.1} />}</span><p className="letter-recipient">给以后的自己</p><h1>{letter.title || '一封留给未来的信'}</h1><p className="sealed-letter-date">{letter.unlockOn ? `${readableDate(letter.unlockOn)} 拆阅` : '查看日期待定'}</p><p>{letter.photoCount ? `信里附了 ${letter.photoCount} 张照片。` : ''}{letter.status === 'sealed' ? '还没到约定的日子，先把它留在这里。' : letter.status === 'due' ? '已到约定的日子，可以拆开了。' : '这封信还在写，可以继续补充。'}</p>{letter.status === 'due' && !letter.deletedAt && <button type="button" className="button primary" disabled={busy} onClick={onRead}><MailOpen size={20} />{busy ? '正在拆阅…' : '拆开这封信'}</button>}{letter.status === 'draft' && !letter.deletedAt && <Link className="button primary" to={`/letters/${letter.id}/edit`}><PencilLine size={18} />继续写这封信</Link>}<span className="sealed-letter-footnote">{letter.sealedAt ? `封存于 ${readableTime(letter.sealedAt)}` : `最后修改于 ${readableTime(letter.updatedAt)}`}</span></section>;
}

export function LetterDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const letter = useResource<LetterDetail>(id ? `/api/letters/${id}` : null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [viewer, setViewer] = useState<number | null>(null);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') letter.reload(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [letter.reload]);
  async function action(kind: 'read' | 'delete' | 'restore') {
    if (!id || busy) return;
    setBusy(kind); setError('');
    try {
      const result = await api<LetterDetail>(`/api/letters/${id}${kind === 'delete' ? '' : `/${kind}`}`, { method: kind === 'delete' ? 'DELETE' : 'POST' });
      if (kind === 'delete') navigate('/letters?deleted=true', { replace: true, state: { message: '信件已移入回收站，仍可恢复。' } });
      else if (kind === 'read') letter.setData(result);
      else letter.reload();
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  if (letter.loading) return <Loading label="正在取出这封信…" />;
  if (letter.error || !letter.data) return <ErrorNotice message={letter.error || '找不到这封信'} retry={letter.reload} />;
  const item = letter.data;
  return <><div className="letter-detail-tools"><Link className="back-link" to={item.deletedAt ? '/letters?deleted=true' : '/letters'}><ArrowLeft size={16} />返回信件</Link>{item.deletedAt ? <button className="button secondary" disabled={!!busy} onClick={() => void action('restore')}><RotateCcw size={16} />{busy === 'restore' ? '正在恢复…' : '恢复信件'}</button> : <button className="text-button" disabled={!!busy} onClick={() => void action('delete')}><Trash2 size={16} />移入信件回收站</button>}</div>
    {(location.state as { sealed?: boolean } | null)?.sealed && !item.deletedAt && <StatusNotice>信件已封存。到期后，下次打开应用时会在首页提醒。</StatusNotice>}{item.deletedAt && <div className="notice" role="status">这封信在回收站中。恢复后仍按原来的日期开放。</div>}<ErrorNotice message={error} />
    {item.status === 'read' && !item.deletedAt ? <article className="letter-reading-sheet"><div className="letter-sheet-heading"><span>来自 {readableDate(localDate(new Date(item.sealedAt || item.createdAt)))} 的自己</span><MailOpen size={26} strokeWidth={1.2} /></div><h1>{item.title || '给以后的自己'}</h1><p className="letter-reading-meta">约定 {readableDate(item.unlockOn)} 拆阅{item.readAt ? ` · 第一次读于 ${readableTime(item.readAt)}` : ''}</p><div className="letter-prose">{item.body}</div>{!!item.media?.length && <section className="letter-photos" aria-label="信中的照片">{item.media.map((photo, index) => <figure key={photo.id}><button type="button" className="photo-preview-button" aria-label={`查看信中第 ${index + 1} 张照片`} onClick={() => setViewer(index)}><img src={photo.displayUrl} alt={photo.caption || photo.filename} width={photo.width} height={photo.height} /></button>{photo.caption && <figcaption>{photo.caption}</figcaption>}</figure>)}</section>}<p className="letter-signoff">读完了，也可以以后再来。</p></article> : <Envelope letter={item} busy={!!busy} onRead={() => void action('read')} />}
    {viewer !== null && item.media && <PhotoViewer photos={item.media} initial={viewer} onClose={() => setViewer(null)} />}
  </>;
}
