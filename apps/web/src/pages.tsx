import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, Download, FileText, FolderArchive, Image, List, Mail, PencilLine, Plus, RotateCcw, Search, Settings2, Shuffle, Sprout, Trash2, Upload } from 'lucide-react';
import { localDate, reflectionSchema, type AppStats, type BackupInfo, type CalendarData, type Metadata, type RecordItem, type RecordList, type YearbookList } from '@yearbook/shared';
import { api, errorText, fileSize, readableDate, readableTime, useResource } from './api';
import { EmptyState, ErrorNotice, Loading, PageHeading, PhotoViewer, RecordCard, StatusNotice } from './components';
import { ModelsPanel } from './ModelsPanel';
import { AiRecordActions } from './AiEntryPoints';
import { HomeLetterNotice } from './LetterPages';
import { AppearanceSettingsCard } from './Appearance';

export function HomePage() {
  const stats = useResource<AppStats>('/api/stats');
  const recent = useResource<RecordList>('/api/records?limit=4');
  const books = useResource<YearbookList>('/api/yearbooks?limit=500');
  const latestBook = books.data?.items.reduce<(NonNullable<typeof books.data>['items'][number]) | undefined>((latest, book) => !latest || book.updatedAt > latest.updatedAt ? book : latest, undefined);
  const today = localDate();
  const now = new Date();
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return <>
    <div className="home-date"><span>{now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日</span><span>{weekdays[now.getDay()]}</span></div>
    <PageHeading title="今天，想留住什么？" description="一顿家常饭，一次远行，或是普通的一天。" />
    <div className="home-opening">
      <section className="new-note"><div className="new-note-copy"><div className="note-topline"><PencilLine size={20} strokeWidth={1.5} /><span>从这一页开始</span></div><h2>写一点，<br />以后慢慢翻。</h2><p>不必等到有什么大事。<br />一句话，一张照片，都值得留下。</p><Link to="/records/new" className="button primary"><Plus size={18} />记一笔</Link></div><div className="home-keepsake" aria-hidden="true"><div className="keepsake-pages" /><div className="keepsake-book"><span>生活手记</span><strong>{now.getFullYear()}</strong><div className="keepsake-window"><i /><i /></div><small>一年一册</small></div></div><span className="note-folio" aria-hidden="true">{today.replaceAll('-', ' / ')}</span></section>
      <div className="home-side"><section className="memory-invitation"><Shuffle size={24} strokeWidth={1.5} /><h2>翻一段旧记忆</h2><p>{stats.data?.records ? '让一个记过的日子，重新来到眼前。' : '写下第一条记录后，就能在这里偶遇过去。'}</p><Link to="/memories" className="text-link">打开记忆盲盒<ArrowRight size={20} /></Link></section><section className="book-invitation"><div className="section-title"><h2>我的年册</h2><BookOpen size={20} strokeWidth={1.5} /></div><p>{latestBook ? latestBook.title || `${latestBook.year} 年的日子` : '把散落的日子，慢慢收成一本。'}</p><Link to={latestBook ? `/yearbooks/${latestBook.id}/edit` : '/yearbooks'} className="text-link">{latestBook ? '继续编辑年册' : '开始手动编册'}<ArrowRight size={20} /></Link><small>手动编册、离线导出，也可请助理整理草稿</small></section></div>
    </div>
    <HomeLetterNotice />
    <section className="recent-section"><div className="section-title"><h2>最近记下的日子</h2><Link to="/records" className="text-link">全部记录<ArrowRight size={16} /></Link></div><ErrorNotice message={recent.error} retry={recent.reload} />{recent.loading ? <Loading /> : recent.data?.items.length ? <div className="home-records">{recent.data.items.map(record => <RecordCard key={record.id} record={record} compact />)}</div> : !recent.error && <div className="home-empty"><span className="empty-stroke" aria-hidden="true" /><p>这里还空着，留给你的日子。</p><Link to="/records/new" className="text-link">写下第一笔<ArrowRight size={16} /></Link></div>}</section>
    <div className="home-bottom"><p>{stats.data ? <>已留下 <strong>{stats.data.records}</strong> 条记录、<strong>{stats.data.photos}</strong> 张照片</> : '生活素材保存在这台电脑里'}</p><Link to="/settings" className="text-link"><FolderArchive size={16} />备份这段时光</Link></div><ErrorNotice message={stats.error} retry={stats.reload} />
  </>;
}

function CalendarView() {
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const [selected, setSelected] = useState('');
  const calendar = useResource<CalendarData>(`/api/calendar?month=${month}`);
  const [items, setItems] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setSelected(''); setItems([]);
    (async () => {
      const found: RecordItem[] = [];
      let total = 0;
      do {
        const result = await api<RecordList>(`/api/records?year=${month.slice(0, 4)}&month=${Number(month.slice(5))}&limit=500&offset=${found.length}`, { signal: controller.signal });
        found.push(...result.items); total = result.total;
        if (!result.items.length) break;
      } while (found.length < total && !controller.signal.aborted);
      if (!controller.signal.aborted) setItems(found);
    })().catch(e => { if (!controller.signal.aborted) setError(errorText(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [month, revision]);
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  const offset = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const counts = new Map(calendar.data?.days.map(day => [day.date, day.count]) || []);
  const visible = selected ? items.filter(item => item.occurredOn === selected) : items;
  function changeMonth(by: number) { const date = new Date(year, monthNumber - 1 + by, 1); setMonth(localDate(date).slice(0, 7)); }
  return <><div className="calendar-toolbar"><div className="month-controls"><button className="icon-button" aria-label="上个月" onClick={() => changeMonth(-1)}><ChevronLeft size={20} /></button><label className="sr-only" htmlFor="calendar-month">查看月份</label><input id="calendar-month" type="month" min="0001-01" max="9999-12" value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value); }} /><button className="icon-button" aria-label="下个月" onClick={() => changeMonth(1)}><ChevronRight size={20} /></button></div><button className="text-button" onClick={() => setMonth(localDate().slice(0, 7))}>回到本月</button></div>
    <ErrorNotice message={calendar.error || error} retry={() => { calendar.reload(); setRevision(v => v + 1); }} />
    <div className="calendar" role="group" aria-label={`${year}年${monthNumber}月日历`}><div className="calendar-week">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-days">{Array.from({ length: offset }, (_, i) => <span className="calendar-gap" key={`gap${i}`} />)}{Array.from({ length: days }, (_, i) => { const date = `${month}-${String(i + 1).padStart(2, '0')}`; const count = counts.get(date) || 0; return <button key={date} className={`calendar-day ${count ? 'has-records' : ''} ${selected === date ? 'selected' : ''} ${date === localDate() ? 'today' : ''}`} aria-pressed={selected === date} aria-label={`${readableDate(date)}，${count}条记录`} onClick={() => setSelected(current => current === date ? '' : date)}><span>{i + 1}</span>{count > 0 && <span className="day-count">{count}<span className="day-count-label"> 条记录</span></span>}</button>; })}</div></div>
    <div className="section-title calendar-results-title"><h2>{selected ? readableDate(selected) : `${monthNumber} 月的日子`}</h2>{selected && <button className="text-button" onClick={() => setSelected('')}>查看整月</button>}</div>
    {loading ? <Loading /> : visible.length ? <div className="record-list">{visible.map(item => <RecordCard key={item.id} record={item} />)}</div> : <EmptyState title={selected ? '这一天还没有记录' : '这个月还没有记录'} description="可以现在补记，也可以翻到别的月份看看。" action={<Link className="button secondary" to={`/records/new?date=${selected || `${month}-01`}`}>补记这段日子<Plus size={16} /></Link>} />}
    {!!calendar.data?.undated && <p className="helper">还有 {calendar.data.undated} 条记录等待补上发生日期，可在时间轴中找到。</p>}
  </>;
}

export function RecordsPage({ firstOnly = false, deleted = false }: { firstOnly?: boolean; deleted?: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const meta = useResource<Metadata>('/api/meta');
  const view = searchParams.get('view') === 'calendar' && !firstOnly && !deleted ? 'calendar' : 'timeline';
  const [restoreError, setRestoreError] = useState('');
  const [restoring, setRestoring] = useState('');
  const [restored, setRestored] = useState('');
  const query = new URLSearchParams(searchParams); query.delete('view'); query.set('limit', '30');
  if (firstOnly) query.set('first', 'true');
  if (deleted) query.set('deleted', 'true');
  const records = useResource<RecordList>(view === 'timeline' ? `/api/records?${query}` : null);
  useEffect(() => { setSearch(searchParams.get('q') || ''); }, [searchParams]);
  function filter(key: string, value: string) { const next = new URLSearchParams(searchParams); value ? next.set(key, value) : next.delete(key); next.delete('offset'); setSearchParams(next); }
  function submit(event: FormEvent) { event.preventDefault(); filter('q', search.trim()); }
  async function restore(id: string) { setRestoring(id); setRestoreError(''); setRestored(''); try { await api(`/api/records/${id}/restore`, { method: 'POST' }); setRestored('记录已恢复，可在时间轴中找到。'); records.reload(); } catch (e) { setRestoreError(errorText(e)); } finally { setRestoring(''); } }
  const offset = Number(searchParams.get('offset') || 0);
  const title = deleted ? '回收站' : firstOnly ? '生活第一次' : '翻翻日子';
  const description = deleted ? '移到这里的记录仍然保存着，随时可以恢复。' : firstOnly ? '那些由你亲自标记的第一次，单独留在这一页。' : '沿着时间回看，也可以找一个人、一件事。';
  return <><PageHeading title={title} description={description}>{!deleted && <Link to={`/records/new${firstOnly ? '?first=true' : ''}`} className="button primary"><Plus size={20} />{firstOnly ? '记个第一次' : '记一笔'}</Link>}</PageHeading>
    {!firstOnly && !deleted && <div className="view-tabs" aria-label="浏览方式"><button className={view === 'timeline' ? 'active' : ''} aria-pressed={view === 'timeline'} onClick={() => filter('view', '')}><List size={20} />时间轴</button><button className={view === 'calendar' ? 'active' : ''} aria-pressed={view === 'calendar'} onClick={() => filter('view', 'calendar')}><CalendarDays size={20} />日历</button></div>}
    {view === 'calendar' ? <CalendarView /> : <><form className="filter-bar" onSubmit={submit}><div className="search-field"><label htmlFor="record-search" className="sr-only">搜索记录</label><Search size={20} /><input id="record-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索文字、照片说明…" /><button type="submit" className="button secondary">搜索</button></div><div className="filter-fields"><label>年份<select value={searchParams.get('year') || ''} onChange={e => filter('year', e.target.value)}><option value="">全部年份</option>{meta.data?.years.map(year => <option key={year} value={year}>{year}年</option>)}</select></label><label>月份<select value={searchParams.get('month') || ''} onChange={e => filter('month', e.target.value)}><option value="">全部月份</option>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}月</option>)}</select></label><label>人物<select value={searchParams.get('person') || ''} onChange={e => filter('person', e.target.value)}><option value="">所有人物</option>{meta.data?.people.map(person => <option key={person} value={person}>{person}</option>)}</select></label><label>标签<select value={searchParams.get('tag') || ''} onChange={e => filter('tag', e.target.value)}><option value="">所有标签</option>{meta.data?.tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>{[...searchParams.keys()].some(key => key !== 'view') && <button type="button" className="text-button clear-filters" onClick={() => { setSearchParams({}); setSearch(''); }}>清除筛选</button>}</div></form>
      <ErrorNotice message={records.error} retry={records.reload} /><ErrorNotice message={restoreError} />{restored && <StatusNotice>{restored}</StatusNotice>}
      {records.loading ? <Loading /> : records.data?.items.length ? <><div className="results-label" role="status">{deleted ? '回收站中有' : '找到'} {records.data.total} 条记录</div><div className="record-list">{records.data.items.map(record => <div className="record-list-item" key={record.id}><RecordCard record={record} />{deleted && <div className="restore-action"><button className="button secondary" disabled={!!restoring} onClick={() => void restore(record.id)}><RotateCcw size={16} />{restoring === record.id ? '正在恢复…' : '恢复记录'}</button><span>移入时间：{readableTime(record.deletedAt!)}</span></div>}</div>)}</div>{records.data.total > 30 && <nav className="pagination" aria-label="记录分页"><button className="button secondary" disabled={!offset} onClick={() => { const next = new URLSearchParams(searchParams); next.set('offset', String(Math.max(0, offset - 30))); setSearchParams(next); }}><ChevronLeft size={16} />上一页</button><span>{Math.floor(offset / 30) + 1} / {Math.ceil(records.data.total / 30)}</span><button className="button secondary" disabled={offset + 30 >= records.data.total} onClick={() => { const next = new URLSearchParams(searchParams); next.set('offset', String(offset + 30)); setSearchParams(next); }}>下一页<ChevronRight size={16} /></button></nav>}</> : !records.error && <EmptyState title={deleted ? '回收站是空的' : firstOnly ? '还没有标记过第一次' : searchParams.size ? '还没找到相符的日子' : '从一条记录开始'} description={deleted ? '删除记录时，会先移到这里。' : firstOnly ? '编辑记录时勾选“这是生活中的第一次”，就会出现在这里。' : searchParams.size ? '换一个关键词，或清除筛选再看看。' : '照片或一句话都可以，日期也可以之后再补。'} action={deleted ? <Link to="/records" className="text-link">返回时间轴<ArrowRight size={16} /></Link> : <Link to={`/records/new${firstOnly ? '?first=true' : ''}`} className="button secondary"><Plus size={16} />写下第一笔</Link>} />}
    </>}
  </>;
}

export function RecordDetailPage() {
  const { id } = useParams();
  const record = useResource<RecordItem>(`/api/records/${id}`);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [viewer, setViewer] = useState<number | null>(null);
  const location = useLocation();
  useEffect(() => { if (location.state?.saved) setSuccess('记录已保存。'); }, [location.state]);
  async function appendReflection(event: FormEvent) {
    event.preventDefault(); setError(''); setSuccess('');
    const input = reflectionSchema.safeParse({ body });
    if (!input.success) { setError(input.error.issues[0].message); return; }
    setBusy(true);
    try { const result = await api<RecordItem>(`/api/records/${id}/reflections`, { method: 'POST', body: JSON.stringify(input.data) }); record.setData(result); setBody(''); setSuccess('这段回顾已保存，原来的记录还在。'); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function remove(restore = false) {
    setError(''); setSuccess(''); setBusy(true);
    try { const result = await api<RecordItem>(`/api/records/${id}${restore ? '/restore' : ''}`, { method: restore ? 'POST' : 'DELETE' }); record.setData(result); setSuccess(restore ? '记录已恢复。' : '已移入回收站。可以在这里恢复记录。'); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (record.loading) return <Loading />;
  if (record.error) return <ErrorNotice message={record.error} retry={record.reload} />;
  const item = record.data; if (!item) return null;
  return <><Link to={item.deletedAt ? '/trash' : '/records'} className="back-link"><ArrowLeft size={16} />{item.deletedAt ? '回收站' : '全部记录'}</Link><header className="detail-heading"><div className="record-date"><time dateTime={item.occurredOn || undefined}>{readableDate(item.occurredOn)}</time>{item.isFirst && <span className="first-mark"><Sprout size={16} />生活第一次</span>}</div><h1>{item.title || '记下的这一天'}</h1><div className="detail-actions">{item.deletedAt ? <button className="button secondary" onClick={() => void remove(true)} disabled={busy}><RotateCcw size={16} />恢复记录</button> : <Link to={`/records/${id}/edit`} className="button secondary"><PencilLine size={16} />编辑记录</Link>}<span className="helper">{item.includeInYearbook ? '默认纳入年册' : '不默认纳入年册'}</span></div></header>
    {success && <StatusNotice>{success}</StatusNotice>}<ErrorNotice message={error} />{item.deletedAt && <p className="notice">这条记录已移入回收站，不会出现在回顾和盲盒中。</p>}
    <article className="detail-content">{item.body && <div className="reading-body">{item.body}</div>}{item.media.length > 0 && <div className={`detail-photos ${item.media.length === 1 ? 'single' : ''}`}>{item.media.map((photo, index) => <figure key={photo.id}><button className="photo-preview-button" onClick={() => setViewer(index)} aria-label={`查看第 ${index + 1} 张照片`}><img src={photo.displayUrl} alt={photo.caption || photo.filename} width={photo.width} height={photo.height} loading={index > 0 ? 'lazy' : 'eager'} /></button>{photo.caption && <figcaption>{photo.caption}</figcaption>}</figure>)}</div>}<div className="detail-attributes">{item.people.length > 0 && <p><span>一起的人</span>{item.people.join('、')}</p>}{item.location && <p><span>地点</span>{item.location}</p>}{item.tags.length > 0 && <p><span>标签</span>{item.tags.map(tag => <Link key={tag} to={`/records?tag=${encodeURIComponent(tag)}`} className="tag">#{tag}</Link>)}</p>}</div></article>
    <section className="reflections" id="reflections"><div className="section-title"><h2>现在回头看</h2><span className="helper">给当时的自己添一句话</span></div>{item.reflections.map(reflection => <article className="reflection" key={reflection.id}><time dateTime={reflection.createdAt}>{readableTime(reflection.createdAt)}</time><p>{reflection.body}</p></article>)}{!item.deletedAt && <form onSubmit={appendReflection} className="reflection-form"><label className="sr-only" htmlFor="reflection-body">现在回头看</label><textarea id="reflection-body" rows={3} value={body} onChange={e => setBody(e.target.value)} maxLength={20000} placeholder="过了一段时间，再看这一天，有什么想说的？" /><button type="submit" className="button secondary" disabled={busy}>{busy ? '正在保存…' : '保存这段回顾'}</button></form>}</section>
    {!item.deletedAt && <AiRecordActions recordId={item.id} />}
    <footer className="record-provenance"><div><p>录入于 {readableTime(item.createdAt)}</p><p>最近修改 {readableTime(item.updatedAt)}</p></div>{!item.deletedAt && <button className="text-button danger-text" disabled={busy} onClick={() => void remove()}><Trash2 size={16} />移入回收站</button>}</footer>{viewer !== null && <PhotoViewer photos={item.media} initial={viewer} onClose={() => setViewer(null)} />}
  </>;
}

export function MemoriesPage() {
  const [items, setItems] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [count, setCount] = useState('1');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const history = useRef<string[]>([]);
  const request = useRef<AbortController | null>(null);
  async function draw() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); setBody(''); setSuccess('');
    try { const result = await api<{ items: RecordItem[] }>(`/api/memories?count=${count}&exclude=${history.current.slice(-30).join(',')}`, { signal: controller.signal }); setItems(result.items); history.current = [...history.current, ...result.items.map(item => item.id)]; }
    catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => { void draw(); return () => request.current?.abort(); }, []);
  async function saveReflection(event: FormEvent) {
    event.preventDefault(); if (!items[0]) return;
    const valid = reflectionSchema.safeParse({ body });
    if (!valid.success) { setError(valid.error.issues[0].message); return; }
    setSaving(true); setError('');
    try { await api(`/api/records/${items[0].id}/reflections`, { method: 'POST', body: JSON.stringify(valid.data) }); setSuccess('回顾已追加到这条记录。'); setBody(''); } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
  }
  return <><PageHeading title="记忆盲盒" description="不挑日子，让旧时光自己翻到这一页。"><div className="memory-controls"><label className="sr-only" htmlFor="memory-count">每次抽取条数</label><select id="memory-count" value={count} onChange={e => setCount(e.target.value)}><option value="1">一条记忆</option><option value="3">三条记忆</option></select><button className="button primary" onClick={() => void draw()} disabled={loading || saving}><Shuffle size={20} />{loading ? '正在翻找…' : '换一批'}</button></div></PageHeading><ErrorNotice message={error} retry={() => void draw()} />{loading ? <Loading label="正在旧日子里翻找…" /> : items.length ? <><div className="memory-results">{items.map(item => <section className="memory-entry" key={item.id}><div className="record-date">{readableDate(item.occurredOn)}</div><h2>{item.title || '照片里的这一天'}</h2>{item.body && <p className="reading-body">{item.body}</p>}{item.media[0] && <Link to={`/records/${item.id}`} className="memory-photo"><img src={item.media[0].displayUrl} alt={item.media[0].caption || item.media[0].filename} width={item.media[0].width} height={item.media[0].height} /></Link>}<Link to={`/records/${item.id}`} className="text-link">打开原记录<ArrowUpRight size={16} /></Link></section>)}</div>{items.length === 1 && <form onSubmit={saveReflection} className="reflection-form memory-reflection"><label htmlFor="memory-reflection">现在回头看</label><textarea id="memory-reflection" rows={3} value={body} maxLength={20000} onChange={e => setBody(e.target.value)} placeholder="给这段旧记忆，补上一句今天的话。" /><button className="button secondary" disabled={saving || loading}>{saving ? '正在保存…' : '保存这段回顾'}</button>{success && <StatusNotice>{success}</StatusNotice>}</form>}<p className="helper memory-note">素材少时也可以慢慢翻。记录有限时，旧记忆可能再次出现。</p></> : !error && <EmptyState title="盲盒里还没有记忆" description="先记下一句话或一张照片，过些时候再来翻翻。" action={<Link to="/records/new" className="button primary"><Plus size={16} />记一笔</Link>} />}</>;
}

export function SettingsPage() {
  const stats = useResource<AppStats>('/api/stats');
  const backups = useResource<{ items: BackupInfo[] }>('/api/backups');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  async function createBackup() { setBusy('backup'); setError(''); setMessage(''); try { await api<BackupInfo>('/api/backups', { method: 'POST' }); setMessage('备份已保存。建议再下载一份，存到其他磁盘。'); backups.reload(); stats.reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } }
  async function restore(event: FormEvent) {
    event.preventDefault(); if (!file || !confirmed) return;
    setBusy('restore'); setError(''); setMessage('');
    try { const body = new FormData(); body.append('file', file); const result = await api<{ restored: true; preRestoreBackup: BackupInfo }>('/api/backups/restore', { method: 'POST', body }); setMessage(`恢复完成。原有数据已另存为恢复前备份：${result.preRestoreBackup.filename}。模型配置需要重新填写密钥并验证能力；无需密钥的服务可直接重新验证。`); setFile(null); setConfirmed(false); setLibraryRevision(value => value + 1); if (fileInput.current) fileInput.current.value = ''; backups.reload(); stats.reload(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  return <><PageHeading title="设置与备份" description="生活素材保存在本机。定期备份，让这些日子留得更久。" /><ErrorNotice message={stats.error || backups.error} retry={() => { stats.reload(); backups.reload(); }} /><ErrorNotice message={error} />{message && <StatusNotice>{message}</StatusNotice>}
    <AppearanceSettingsCard />
    <section className="settings-section"><div className="section-title"><h2>本机资料库</h2><span className="local-badge"><span />仅本机</span></div>{stats.loading ? <Loading label="正在读取资料库…" /> : stats.data && <dl className="data-facts"><div><dt>保存位置</dt><dd className="path-text">{stats.data.dataDir}</dd></div><div><dt>记录与照片</dt><dd>{stats.data.records} 条记录 · {stats.data.photos} 张照片</dd></div><div><dt>最近备份</dt><dd>{stats.data.lastBackupAt ? readableTime(stats.data.lastBackupAt) : '还没有创建备份'}</dd></div></dl>}</section>
    <section className="settings-section"><div className="section-title"><div><h2>创建备份</h2><p className="helper">包含记录、原图和资料关联。不包含密钥、缓存或旧备份。</p></div><button className="button primary" disabled={!!busy} onClick={() => void createBackup()}><FolderArchive size={20} />{busy === 'backup' ? '正在备份…' : '创建备份'}</button></div>{busy === 'backup' && <Loading label="正在制作完整备份，请保持窗口打开…" />}{backups.loading ? <Loading label="正在读取备份列表…" /> : backups.data?.items.length ? <ul className="backup-list">{backups.data.items.map(backup => <li key={backup.id}><FolderArchive size={20} /><div><strong>{readableTime(backup.createdAt)}</strong><span className="backup-filename">{backup.filename}</span></div><span>{fileSize(backup.size)}</span><a className="button secondary" href={`/api/backups/${backup.id}/download`} download><Download size={16} />下载</a></li>)}</ul> : <p className="helper">创建第一份备份后，它会出现在这里。</p>}</section>
    <section className="settings-section"><h2>从备份恢复</h2><p>选择《一年一册》导出的 ZIP 文件。恢复前会先校验文件，并自动备份现在的资料；恢复失败时保留原数据。</p><form className="restore-form" onSubmit={restore}><label className="button secondary file-label"><Upload size={20} />选择备份文件<input type="file" accept=".zip,application/zip" ref={fileInput} disabled={!!busy} onChange={e => { setFile(e.target.files?.[0] || null); setConfirmed(false); setError(''); }} aria-label="选择备份文件" /></label>{file && <><p className="selected-file">{file.name} · {fileSize(file.size)}</p><label className="check-label"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={e => setConfirmed(e.target.checked)} />我了解恢复会将当前资料库替换为这份备份</label><div className="inline-actions"><button className="button primary" disabled={!confirmed || !!busy}>{busy === 'restore' ? '正在恢复…' : '恢复这份备份'}</button><button type="button" className="text-button" disabled={!!busy} onClick={() => { setFile(null); setConfirmed(false); if (fileInput.current) fileInput.current.value = ''; }}>取消选择</button></div></>}{busy === 'restore' && <Loading label="正在校验并恢复，请保持窗口打开…" />}</form></section>
    <ModelsPanel key={libraryRevision} />
    <section className="settings-section"><div className="section-title"><h2>误删的记录</h2><button className="button secondary" onClick={() => navigate('/trash')}><Trash2 size={16} />打开回收站</button></div><p className="helper">记录移入回收站后仍然保留，照片不会因删除一个关联而丢失。</p></section>
  </>;
}

export function NotFoundPage() { return <EmptyState title="这一页还没写下" description="找不到这个页面，可以回到首页继续。" action={<Link to="/" className="button primary">回到首页<ArrowRight size={16} /></Link>} />; }
