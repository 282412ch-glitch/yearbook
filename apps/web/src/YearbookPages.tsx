import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FileDown,
  LoaderCircle,
  Plus,
  Printer,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type {
  RecordItem,
  RecordList,
  TaskItem,
  YearbookBlockInput,
  YearbookChapterInput,
  YearbookInput,
  YearbookItem,
  YearbookList,
  YearbookTemplate,
  YearbookVersion,
} from '@yearbook/shared';
import { yearbookInputSchema } from '@yearbook/shared';
import { api, errorText, readableDate, readableTime, useResource } from './api';
import { EmptyState, ErrorNotice, Loading, PageHeading, StatusNotice } from './components';

type Draft = YearbookInput;

const chapterKinds: { value: YearbookChapterInput['kind']; label: string }[] = [
  { value: 'opening', label: '年度开篇' },
  { value: 'month', label: '月份章节' },
  { value: 'firsts', label: '生活第一次' },
  { value: 'photos', label: '年度照片选集' },
  { value: 'letter', label: '写给明年的自己' },
  { value: 'custom', label: '自定义章节' },
];

const blockKinds: { value: YearbookBlockInput['type']; label: string }[] = [
  { value: 'paragraph', label: '段落' },
  { value: 'quote', label: '原话' },
  { value: 'image', label: '照片' },
  { value: 'record', label: '记录卡片' },
];

const dateYear = () => new Date().getFullYear();

function defaultChapters(year: number): YearbookChapterInput[] {
  return [
    { kind: 'cover', title: `${year} · 一年一册`, body: '', blocks: [], sourceRecordIds: [] },
    { kind: 'opening', title: `${year} 年，写在开头`, body: '', blocks: [], sourceRecordIds: [] },
    ...Array.from({ length: 12 }, (_, index) => ({ kind: 'month' as const, title: `${index + 1} 月`, body: '', blocks: [], sourceRecordIds: [] })),
    { kind: 'firsts', title: '生活第一次', body: '', blocks: [], sourceRecordIds: [] },
    { kind: 'photos', title: '这一年的照片', body: '', blocks: [], sourceRecordIds: [] },
    { kind: 'letter', title: '写给明年的自己', body: '', blocks: [], sourceRecordIds: [] },
  ];
}

function emptyDraft(year = dateYear()): Draft {
  return { year, title: `${year} 年册`, template: 'photo', coverMediaId: null, introBody: '', chapters: defaultChapters(year) };
}

function toDraft(book: YearbookItem): Draft {
  return {
    year: book.year,
    title: book.title,
    template: book.template,
    coverMediaId: book.coverMediaId,
    introBody: book.introBody,
    chapters: book.chapters.map(chapter => ({
      id: chapter.id,
      kind: chapter.kind,
      title: chapter.title,
      body: chapter.body,
      blocks: chapter.blocks.map(block => ({
        id: block.id,
        type: block.type,
        body: block.body,
        mediaId: block.mediaId,
        recordId: block.recordId,
        caption: block.caption,
      })),
      sourceRecordIds: [...chapter.sourceRecordIds],
    })),
  };
}

function templateLabel(template: YearbookTemplate) {
  return template === 'photo' ? '照片为主' : '文字为主';
}

function chapterLabel(kind: YearbookChapterInput['kind']) {
  return chapterKinds.find(item => item.value === kind)?.label ?? '自定义章节';
}

function useYearRecords(year: number) {
  const resource = useResource<RecordList>(`/api/records?year=${year}&limit=500`);
  return resource;
}

function recordMedia(records: RecordItem[]) {
  const media = records.flatMap(record => record.media);
  return Array.from(new Map(media.map(item => [item.id, item])).values());
}

async function downloadBlob(path: string, filename: string, onState: (message: string) => void) {
  const response = await fetch(path);
  if (!response.ok) {
    let message = `导出失败（${response.status}）`;
    try { const json = await response.json() as { error?: { message?: string } }; message = json.error?.message || message; } catch { /* response may be a binary error */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  onState('导出文件已下载。');
}

async function exportYearbook(id: string, format: 'html' | 'pdf', filename: string, onState: (message: string) => void) {
  let task = await api<TaskItem>(`/api/yearbooks/${id}/export`, {
    method: 'POST',
    body: JSON.stringify({ format, idempotencyKey: `web-${format}-${crypto.randomUUID()}` }),
  });
  onState(task.message || '已加入导出队列。');
  while (task.status === 'pending' || task.status === 'running') {
    await new Promise(resolve => window.setTimeout(resolve, 450));
    task = await api<TaskItem>(`/api/tasks/${task.id}`);
    onState(`${task.message || '正在导出…'}${Number.isFinite(task.progress) ? ` ${task.progress}%` : ''}`);
  }
  if (task.status === 'cancelled') throw new Error('导出任务已取消。');
  if (task.status === 'failed') throw new Error(task.errorMessage || '导出失败，请重试。');
  await downloadBlob(`/api/yearbooks/${id}/export/${format}?taskId=${encodeURIComponent(task.id)}`, filename, onState);
}

export function YearbookListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const year = searchParams.get('year') ?? '';
  const books = useResource<YearbookList>(`/api/yearbooks${year ? `?year=${encodeURIComponent(year)}` : ''}`);
  const records = useResource<RecordList>('/api/records?limit=500');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const years = useMemo(() => {
    const values = new Set<number>([dateYear()]);
    records.data?.items.forEach(item => { if (item.occurredOn) values.add(Number(item.occurredOn.slice(0, 4))); });
    books.data?.items.forEach(item => values.add(item.year));
    return Array.from(values).filter(Number.isInteger).sort((a, b) => b - a);
  }, [books.data, records.data]);

  async function remove(book: YearbookItem) {
    if (!window.confirm(`要把“${book.title || `${book.year} 年册`}”移入回收站吗？`)) return;
    setBusy(book.id); setError(''); setMessage('');
    try { await api(`/api/yearbooks/${book.id}`, { method: 'DELETE' }); setMessage('年册已移入回收站。'); books.reload(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(''); }
  }

  return <>
    <PageHeading title="我的年册" description="把散落的日子，慢慢收成一本。">
      <Link to="/yearbooks/new" className="button primary"><Plus size={20} />新建年册</Link>
      <Link to="/ai?kind=yearbook" className="button secondary">请助理编册</Link>
    </PageHeading>
    <div className="yearbook-toolbar">
      <label htmlFor="yearbook-year">查看年份
        <select id="yearbook-year" value={year} onChange={event => { const value = event.target.value; const next = new URLSearchParams(searchParams); value ? next.set('year', value) : next.delete('year'); setSearchParams(next); }}>
          <option value="">全部年份</option>
          {years.map(value => <option value={value} key={value}>{value} 年</option>)}
        </select>
      </label>
      <p className="helper">每一年可以保存多本草稿，手动编辑的内容会保留在本机。</p>
    </div>
    <ErrorNotice message={books.error || error} retry={() => { books.reload(); setError(''); }} />
    {message && <StatusNotice>{message}</StatusNotice>}
    {books.loading ? <Loading label="正在读取年册…" /> : books.data?.items.length ? <div className="yearbook-list">
      {books.data.items.map(book => <article className="yearbook-card" key={book.id}>
        <div className={`yearbook-card-mark template-${book.template}`} aria-hidden="true"><BookOpen size={34} strokeWidth={1.25} /><span>{book.year}</span></div>
        <div className="yearbook-card-content"><div className="yearbook-card-meta"><span>{book.year} 年</span><span>{templateLabel(book.template)}</span><span>更新于 {readableTime(book.updatedAt)}</span></div><h2>{book.title || `${book.year} 年册`}</h2><p>{book.chapters.length ? `${book.chapters.length} 个章节` : '还没有章节，打开后开始编辑。'}</p><div className="inline-actions"><Link to={`/yearbooks/${book.id}/edit`} className="button secondary"><BookOpen size={16} />继续编辑</Link><Link to={`/yearbooks/${book.id}/preview`} className="text-link"><ExternalLink size={16} />预览</Link><button type="button" className="text-button danger-text" disabled={busy === book.id} onClick={() => void remove(book)}><Trash2 size={16} />移入回收站</button></div></div>
      </article>)}
    </div> : !books.error && <EmptyState title="还没有年册" description="从一个年份开始，选几条想留下的记录，慢慢做成一本。" action={<Link to="/yearbooks/new" className="button primary"><Plus size={18} />新建第一本</Link>} />}
  </>;
}

export function YearbookEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useResource<YearbookItem>(id ? `/api/yearbooks/${id}` : null);
  const versions = useResource<YearbookVersion[]>(id ? `/api/yearbooks/${id}/versions` : null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [loaded, setLoaded] = useState(!id);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const storageKey = `yearbook:yearbook-draft:${id || 'new'}`;

  useEffect(() => {
    if (!id) {
      const cached = localStorage.getItem(storageKey);
      if (cached) { try { setDraft(yearbookInputSchema.parse(JSON.parse(cached))); } catch { localStorage.removeItem(storageKey); } }
      setLoaded(true);
    }
  }, [id, storageKey]);
  useEffect(() => {
    if (!existing.data) return;
    const cached = localStorage.getItem(storageKey);
    if (cached) {
      try {
        setDraft(yearbookInputSchema.parse(JSON.parse(cached)));
        setDirty(true);
        setMessage('已恢复上次未提交的编辑内容，保存后会写入年册。');
      } catch {
        localStorage.removeItem(storageKey);
        setDraft(toDraft(existing.data));
      }
    } else setDraft(toDraft(existing.data));
    setLoaded(true);
  }, [existing.data, storageKey]);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => { if (dirty) localStorage.setItem(storageKey, JSON.stringify(draft)); }, 200);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, loaded, storageKey]);
  const recordsResource = useYearRecords(draft.year);
  useEffect(() => { if (recordsResource.data) setRecords(recordsResource.data.items); }, [recordsResource.data]);
  const media = useMemo(() => recordMedia(records), [records]);

  function updateDraft(patch: Partial<Draft>) { setDraft(current => ({ ...current, ...patch })); setDirty(true); setMessage(''); }
  function updateChapter(index: number, patch: Partial<YearbookChapterInput>) {
    updateDraft({ chapters: draft.chapters.map((chapter, item) => item === index ? { ...chapter, ...patch } : chapter) });
  }
  function moveChapter(index: number, by: number) {
    const target = index + by; if (target < 0 || target >= draft.chapters.length) return;
    const chapters = [...draft.chapters]; [chapters[index], chapters[target]] = [chapters[target], chapters[index]]; updateDraft({ chapters });
  }
  function addChapter() { updateDraft({ chapters: [...draft.chapters, { kind: 'custom', title: '新的章节', body: '', blocks: [], sourceRecordIds: [] }] }); }
  function removeChapter(index: number) { if (!window.confirm('删除这个章节？章节里的内容会从年册编辑稿中移除。')) return; updateDraft({ chapters: draft.chapters.filter((_, item) => item !== index) }); }
  function updateBlock(chapterIndex: number, blockIndex: number, patch: Partial<YearbookBlockInput>) {
    const chapter = draft.chapters[chapterIndex]; if (!chapter) return;
    updateChapter(chapterIndex, { blocks: chapter.blocks.map((block, item) => item === blockIndex ? { ...block, ...patch } : block) });
  }
  function addBlock(chapterIndex: number, type: YearbookBlockInput['type']) {
    const chapter = draft.chapters[chapterIndex]; if (!chapter) return;
    const block: YearbookBlockInput = { type, body: '', mediaId: null, recordId: null, caption: '' };
    updateChapter(chapterIndex, { blocks: [...chapter.blocks, block] });
  }
  function removeBlock(chapterIndex: number, blockIndex: number) {
    const chapter = draft.chapters[chapterIndex]; if (!chapter) return;
    updateChapter(chapterIndex, { blocks: chapter.blocks.filter((_, item) => item !== blockIndex) });
  }
  function toggleSource(chapterIndex: number, recordId: string) {
    const chapter = draft.chapters[chapterIndex]; if (!chapter) return;
    const selected = new Set(chapter.sourceRecordIds); selected.has(recordId) ? selected.delete(recordId) : selected.add(recordId);
    updateChapter(chapterIndex, { sourceRecordIds: Array.from(selected) });
  }

  async function save(event?: FormEvent) {
    event?.preventDefault(); setBusy('save'); setError(''); setMessage('');
    const parsed = yearbookInputSchema.safeParse(draft);
    if (!parsed.success) { setBusy(''); setError(parsed.error.issues[0]?.message || '请检查年册内容'); return; }
    try {
      const result = await api<YearbookItem>(id ? `/api/yearbooks/${id}` : '/api/yearbooks', { method: id ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) });
      localStorage.removeItem(storageKey); setDirty(false); setMessage('年册已保存。');
      if (!id) navigate(`/yearbooks/${result.id}/edit`, { replace: true, state: { saved: true } });
      else { existing.setData(result); versions.reload(); }
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(''); }
  }
  async function exportBook(kind: 'html' | 'pdf') {
    if (!id) { setError('请先保存年册，再导出文件。'); return; }
    setBusy(kind); setError(''); setMessage('');
    try { await exportYearbook(id, kind, `${draft.title || `${draft.year} 年册`}.${kind === 'html' ? 'zip' : 'pdf'}`, value => setMessage(value)); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(''); }
  }
  async function applyVersion(version: YearbookVersion) {
    if (!id) return;
    if (dirty && !window.confirm('当前有未保存的修改。采用这个版本会替换编辑区内容，是否继续？')) return;
    setBusy('version'); setError(''); setMessage('');
    try {
      const result = await api<YearbookItem>(`/api/yearbooks/${id}/versions/${version.id}/apply`, { method: 'POST' });
      setDraft(toDraft(result)); setDirty(false); localStorage.removeItem(storageKey); setMessage(`已采用第 ${version.versionNo} 个版本，原版本仍保留在历史中。`); existing.setData(result); versions.reload();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(''); }
  }

  if (existing.loading || !loaded) return <Loading label="正在打开年册编辑器…" />;
  if (existing.error) return <ErrorNotice message={existing.error} retry={existing.reload} />;
  return <>
    <Link to="/yearbooks" className="back-link"><ArrowLeft size={16} />我的年册</Link>
    <PageHeading title={id ? '继续编辑年册' : '新建年册'} description="章节、文字和照片都可以反复调整，保存后随时回来继续。">
      <div className="inline-actions"><Link to={id ? `/yearbooks/${id}/preview` : '#'} className={`button secondary ${!id ? 'disabled-link' : ''}`} onClick={event => { if (!id) event.preventDefault(); }}><ExternalLink size={16} />预览</Link><button type="button" className="button secondary" disabled={busy === 'html' || !id} onClick={() => void exportBook('html')}><Download size={16} />{busy === 'html' ? '导出中…' : '离线 HTML'}</button><button type="button" className="button secondary" disabled={busy === 'pdf' || !id} onClick={() => void exportBook('pdf')}><FileDown size={16} />{busy === 'pdf' ? '导出中…' : 'PDF'}</button></div>
    </PageHeading>
    {error && <ErrorNotice message={error} />}{message && <StatusNotice>{message}</StatusNotice>}
    {id && <div className="inline-actions"><Link className="text-link" to={`/ai?kind=yearbook&year=${draft.year}&yearbookId=${id}`} aria-disabled={dirty} onClick={event => { if (dirty) { event.preventDefault(); setError('请先保存当前修改，再请助理生成独立草稿。'); } }}>生成全年 AI 草稿</Link><Link className="text-link" to={`/ai?kind=agent&year=${draft.year}&yearbookId=${id}`} aria-disabled={dirty} onClick={event => { if (dirty) { event.preventDefault(); setError('请先保存当前修改，再请助理整理章节。'); } }}>用一句话整理章节</Link><Link className="text-link" to="/tasks">查看生成任务</Link></div>}
    <form className="yearbook-editor" onSubmit={save}>
      <section className="yearbook-editor-settings" aria-labelledby="yearbook-settings-title"><div className="section-title"><h2 id="yearbook-settings-title">年册信息</h2><BookOpen size={20} strokeWidth={1.5} /></div><div className="yearbook-fields"><label>年份<input type="number" min={1} max={9999} value={draft.year} onChange={event => updateDraft({ year: Number(event.target.value) || dateYear() })} /></label><label>年册标题<input maxLength={300} value={draft.title} placeholder={`${draft.year} 年册`} onChange={event => updateDraft({ title: event.target.value })} /></label></div><fieldset className="template-choice"><legend>基础模板</legend><label className={draft.template === 'photo' ? 'selected' : ''}><input type="radio" name="template" value="photo" checked={draft.template === 'photo'} onChange={() => updateDraft({ template: 'photo' })} /><span><strong>照片为主</strong><small>让照片承担更多版面，文字短一些。</small></span></label><label className={draft.template === 'text' ? 'selected' : ''}><input type="radio" name="template" value="text" checked={draft.template === 'text'} onChange={() => updateDraft({ template: 'text' })} /><span><strong>文字为主</strong><small>给长段落和原话更多空间。</small></span></label></fieldset><label>年度开篇<textarea rows={5} maxLength={100000} value={draft.introBody} placeholder="这一年，你想先写下什么？" onChange={event => updateDraft({ introBody: event.target.value })} /></label><label>封面照片<select value={draft.coverMediaId || ''} onChange={event => updateDraft({ coverMediaId: event.target.value || null })}><option value="">暂不选择</option>{media.map(item => <option key={item.id} value={item.id}>{item.filename}</option>)}</select></label><p className="helper">照片来自所选年份的记录。封面也可以稍后更换。</p></section>
      <section className="yearbook-chapters" aria-labelledby="chapter-title"><div className="section-title"><div><h2 id="chapter-title">章节 <span className="muted-count">{draft.chapters.length}</span></h2><p className="helper">按自己的顺序整理，空月份可以删除。</p></div><button type="button" className="button secondary" onClick={addChapter}><Plus size={18} />添加章节</button></div>{draft.chapters.length ? draft.chapters.map((chapter, index) => <ChapterEditor key={chapter.id || `new-${index}`} chapter={chapter} index={index} total={draft.chapters.length} records={records} media={media} onChange={patch => updateChapter(index, patch)} onMove={by => moveChapter(index, by)} onRemove={() => removeChapter(index)} onAddBlock={type => addBlock(index, type)} onUpdateBlock={(blockIndex, patch) => updateBlock(index, blockIndex, patch)} onRemoveBlock={blockIndex => removeBlock(index, blockIndex)} onToggleSource={recordId => toggleSource(index, recordId)} />) : <EmptyState title="还没有章节" description="添加一个章节，开始组织这一年的素材。" action={<button type="button" className="button secondary" onClick={addChapter}><Plus size={16} />添加第一章</button>} />}</section>
      <div className="yearbook-save-bar"><span className="save-status">{busy === 'save' ? <><LoaderCircle size={18} className="spin" />正在保存…</> : dirty ? '有未保存的修改' : <><Check size={18} />已保存</>}</span><div className="inline-actions"><Link to="/yearbooks" className="button secondary">取消</Link><button className="button primary" disabled={busy === 'save'}><Save size={18} />{busy === 'save' ? '保存中…' : '保存年册'}</button></div></div>
    </form>
    {id && <section className="yearbook-versions" aria-labelledby="versions-title"><div className="section-title"><div><h2 id="versions-title">编辑版本</h2><p className="helper">每次保存都会留下一个快照。AI 生成的新草稿也会单独出现在这里。</p></div><span className="muted-count">{versions.data?.length ?? 0} 个版本</span></div>{versions.error && <ErrorNotice message={versions.error} retry={versions.reload} />}{versions.loading ? <Loading label="正在读取版本历史…" /> : versions.data?.length ? <ol className="version-list">{versions.data.map(version => <li key={version.id}><div><strong>第 {version.versionNo} 个版本 · {version.source === 'ai' ? 'AI 草稿' : '手动保存'}</strong><span>{version.label || (version.source === 'ai' ? 'AI 草稿' : '手动保存')} · {readableTime(version.createdAt)}</span></div><button type="button" className="button secondary" disabled={busy === 'version'} onClick={() => void applyVersion(version)}><Check size={16} />采用此版本</button></li>)}</ol> : !versions.error && <p className="helper">保存一次后，这里会显示版本快照。</p>}</section>}
  </>;
}

function ChapterEditor({ chapter, index, total, records, media, onChange, onMove, onRemove, onAddBlock, onUpdateBlock, onRemoveBlock, onToggleSource }: { chapter: YearbookChapterInput; index: number; total: number; records: RecordItem[]; media: RecordItem['media']; onChange: (patch: Partial<YearbookChapterInput>) => void; onMove: (by: number) => void; onRemove: () => void; onAddBlock: (type: YearbookBlockInput['type']) => void; onUpdateBlock: (index: number, patch: Partial<YearbookBlockInput>) => void; onRemoveBlock: (index: number) => void; onToggleSource: (recordId: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  return <article className={`chapter-editor ${expanded ? 'expanded' : 'collapsed'}`}><header className="chapter-editor-heading"><div className="chapter-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div><div className="chapter-heading-fields"><select value={chapter.kind} aria-label={`第 ${index + 1} 章类型`} onChange={event => onChange({ kind: event.target.value as YearbookChapterInput['kind'] })}>{chapterKinds.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select><input value={chapter.title} maxLength={300} aria-label={`第 ${index + 1} 章标题`} placeholder="章节标题" onChange={event => onChange({ title: event.target.value })} /></div><div className="chapter-tools"><button type="button" className="icon-button" aria-label="上移章节" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={16} /></button><button type="button" className="icon-button" aria-label="下移章节" disabled={index === total - 1} onClick={() => onMove(1)}><ArrowDown size={16} /></button><button type="button" className="icon-button" aria-label={expanded ? '收起章节' : '展开章节'} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button><button type="button" className="icon-button danger-text" aria-label="删除章节" onClick={onRemove}><Trash2 size={16} /></button></div></header>{expanded && <div className="chapter-editor-body"><label>章节正文<textarea rows={5} maxLength={100000} value={chapter.body} placeholder="写下这一章想留下的内容。" onChange={event => onChange({ body: event.target.value })} /></label><div className="source-picker"><div className="section-title"><div><h3>来源记录</h3><p className="helper">勾选本章引用的原始记录，方便日后回查。</p></div><span className="muted-count">{chapter.sourceRecordIds.length} 条</span></div>{records.length ? <div className="source-record-list">{records.map(record => <label key={record.id} className="check-label"><input type="checkbox" checked={chapter.sourceRecordIds.includes(record.id)} onChange={() => onToggleSource(record.id)} /><span><strong>{record.title || record.body.slice(0, 40) || '照片里的这一天'}</strong><small>{readableDate(record.occurredOn)}{record.people.length ? ` · ${record.people.join('、')}` : ''}</small></span></label>)}</div> : <p className="helper">这个年份还没有记录，可以先保存章节，之后再补素材。</p>}</div><div className="block-editor"><div className="section-title"><div><h3>内容块</h3><p className="helper">文字、原话、照片和记录卡片可以混排。</p></div><div className="block-add-actions">{blockKinds.map(kind => <button type="button" className="text-button" key={kind.value} onClick={() => onAddBlock(kind.value)}><Plus size={15} />{kind.label}</button>)}</div></div>{chapter.blocks.length ? chapter.blocks.map((block, blockIndex) => <BlockEditor key={block.id || `block-${blockIndex}`} block={block} index={blockIndex} records={records} media={media} onChange={patch => onUpdateBlock(blockIndex, patch)} onRemove={() => onRemoveBlock(blockIndex)} />) : <p className="block-empty">还没有内容块。你可以直接填写章节正文，或添加一段文字。</p>}</div></div>}</article>;
}

function BlockEditor({ block, index, records, media, onChange, onRemove }: { block: YearbookBlockInput; index: number; records: RecordItem[]; media: RecordItem['media']; onChange: (patch: Partial<YearbookBlockInput>) => void; onRemove: () => void }) {
  return <div className={`block-editor-item block-${block.type}`}><div className="block-editor-top"><span className="block-index">{String(index + 1).padStart(2, '0')}</span><select value={block.type} aria-label={`内容块 ${index + 1} 类型`} onChange={event => onChange({ type: event.target.value as YearbookBlockInput['type'], mediaId: null, recordId: null })}>{blockKinds.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select><button type="button" className="icon-button danger-text" aria-label={`删除内容块 ${index + 1}`} onClick={onRemove}><X size={16} /></button></div>{(block.type === 'paragraph' || block.type === 'quote') && <label>{block.type === 'quote' ? '原话' : '段落文字'}<textarea rows={4} maxLength={100000} value={block.body} onChange={event => onChange({ body: event.target.value })} /></label>}{block.type === 'image' && <div className="block-media-fields"><label>选择照片<select value={block.mediaId || ''} onChange={event => onChange({ mediaId: event.target.value || null })}><option value="">请选择</option>{media.map(item => <option value={item.id} key={item.id}>{item.filename}</option>)}</select></label><label>照片说明<input maxLength={2000} value={block.caption} placeholder="照片里的场景" onChange={event => onChange({ caption: event.target.value })} /></label></div>}{block.type === 'record' && <label>关联记录<select value={block.recordId || ''} onChange={event => onChange({ recordId: event.target.value || null })}><option value="">请选择</option>{records.map(record => <option value={record.id} key={record.id}>{record.title || record.body.slice(0, 40) || readableDate(record.occurredOn)}</option>)}</select></label>}</div>;
}

export function YearbookPreviewPage() {
  const { id } = useParams();
  const book = useResource<YearbookItem>(id ? `/api/yearbooks/${id}` : null);
  const records = useResource<RecordList>(book.data ? `/api/records?year=${book.data.year}&limit=500` : null);
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const media = useMemo(() => recordMedia(records.data?.items ?? []), [records.data]);
  const mediaById = useMemo(() => new Map(media.map(item => [item.id, item])), [media]);
  const recordById = useMemo(() => new Map((records.data?.items ?? []).map(item => [item.id, item])), [records.data]);
  async function exportBook(kind: 'html' | 'pdf') {
    if (!id || !book.data) return;
    setExporting(kind); setError(''); setMessage('');
    try { await exportYearbook(id, kind, `${book.data.title || `${book.data.year} 年册`}.${kind === 'html' ? 'zip' : 'pdf'}`, value => setMessage(value)); }
    catch (reason) { setError(errorText(reason)); }
    finally { setExporting(''); }
  }
  if (book.loading) return <Loading label="正在生成预览…" />;
  if (book.error) return <ErrorNotice message={book.error} retry={book.reload} />;
  if (!book.data) return null;
  return <>
    <Link to={`/yearbooks/${id}/edit`} className="back-link"><ArrowLeft size={16} />返回编辑</Link>
    <PageHeading title={book.data.title || `${book.data.year} 年册`} description={`${book.data.year} · ${templateLabel(book.data.template)}`}>
      <div className="inline-actions"><button type="button" className="button secondary" onClick={() => window.print()}><Printer size={17} />打印预览</button><button type="button" className="button secondary" disabled={!!exporting} onClick={() => void exportBook('html')}><Download size={17} />{exporting === 'html' ? '导出中…' : '离线 HTML'}</button><button type="button" className="button primary" disabled={!!exporting} onClick={() => void exportBook('pdf')}><FileDown size={17} />{exporting === 'pdf' ? '导出中…' : 'PDF 导出'}</button></div>
    </PageHeading>
    {error && <ErrorNotice message={error} />}{message && <StatusNotice>{message}</StatusNotice>}
    <article className={`yearbook-preview template-${book.data.template}`}><section className="preview-cover">{book.data.coverMediaId && mediaById.get(book.data.coverMediaId) && <img src={mediaById.get(book.data.coverMediaId)!.displayUrl} alt="封面照片" /> }<p className="preview-year">{book.data.year}</p><h1>{book.data.title || `${book.data.year} 年册`}</h1>{book.data.introBody && <p className="preview-intro">{book.data.introBody}</p>}</section>{book.data.chapters.filter(chapter => chapter.kind !== 'cover').map((chapter, chapterIndex) => <section className="preview-chapter" key={chapter.id}><div className="preview-chapter-kicker">{String(chapterIndex + 1).padStart(2, '0')} · {chapterLabel(chapter.kind)}</div><h2>{chapter.title || '未命名章节'}</h2>{chapter.body && <div className="preview-body">{chapter.body}</div>}{chapter.blocks.map(block => <PreviewBlock block={block} key={block.id} mediaById={mediaById} recordById={recordById} />)}{chapter.sourceRecordIds.length > 0 && <p className="preview-sources">来源记录 {chapter.sourceRecordIds.length} 条，可在编辑页回查。</p>}</section>)}</article>
  </>;
}

function PreviewBlock({ block, mediaById, recordById }: { block: YearbookItem['chapters'][number]['blocks'][number]; mediaById: Map<string, RecordItem['media'][number]>; recordById: Map<string, RecordItem> }) {
  if (block.type === 'image') { const photo = block.mediaId ? mediaById.get(block.mediaId) : undefined; return photo ? <figure className="preview-image"><img src={photo.displayUrl} alt={block.caption || photo.filename} /><figcaption>{block.caption || photo.filename}</figcaption></figure> : null; }
  if (block.type === 'record') { const record = block.recordId ? recordById.get(block.recordId) : undefined; return record ? <article className="preview-record"><time>{readableDate(record.occurredOn)}</time><h3>{record.title || '记下的这一天'}</h3>{record.body && <p>{record.body}</p>}{record.media[0] && <img src={record.media[0].thumbnailUrl} alt="" />}</article> : null; }
  if (!block.body) return null;
  return block.type === 'quote' ? <blockquote className="preview-quote">{block.body}</blockquote> : <p className="preview-paragraph">{block.body}</p>;
}
