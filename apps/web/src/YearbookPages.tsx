import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { appendYearbookPhotos, moveYearbookItem, parseYearbookDraft, withYearbookDraftIds } from './yearbook-ordering';
import { YearbookReader } from './YearbookReader';
import './yearbook.css';

type Draft = YearbookInput;

const chapterKinds: { value: YearbookChapterInput['kind']; label: string }[] = [
  { value: 'cover', label: '封面附页' },
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
  return withYearbookDraftIds({ year, title: `${year} 年册`, template: 'photo', coverMediaId: null, introBody: '', chapters: defaultChapters(year) });
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

function useYearRecords(year: number) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ year: number; data: RecordList | null; loading: boolean; error: string }>({ year, data: null, loading: true, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ year, data: null, loading: true, error: '' });
    void (async () => {
      try {
        const items: RecordItem[] = [];
        let total = 0;
        do {
          const page = await api<RecordList>(`/api/records?year=${year}&limit=500&offset=${items.length}`, { signal: controller.signal });
          total = page.total;
          items.push(...page.items);
          if (!page.items.length) break;
        } while (items.length < total);
        if (!controller.signal.aborted) setState({ year, data: { items: Array.from(new Map(items.map(item => [item.id, item])).values()), total }, loading: false, error: '' });
      } catch (reason) {
        if (!controller.signal.aborted) setState({ year, data: null, loading: false, error: errorText(reason) });
      }
    })();
    return () => controller.abort();
  }, [year, revision]);
  return { ...(state.year === year ? state : { data: null, loading: true, error: '' }), reload: () => setRevision(value => value + 1) };
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
        <Link to={`/yearbooks/${book.id}/preview`} className={`yearbook-card-stage template-${book.template}`} tabIndex={-1} aria-hidden="true"><span className="yearbook-card-jacket"><span className="book-jacket-label">生活的年度存档</span><span className="book-jacket-year">{book.year}</span><span className="book-jacket-title">{book.title || `${book.year} 年册`}</span>{book.coverMediaId ? <img src={`/api/media/${book.coverMediaId}/thumbnail`} alt="" loading="lazy" /> : <span className="book-jacket-rule" />}<span className="book-jacket-imprint">一年一册</span></span></Link>
        <div className="yearbook-card-content"><div className="yearbook-card-meta"><span>{book.year} 年</span><span>{templateLabel(book.template)}</span><span>更新于 {readableTime(book.updatedAt)}</span></div><h2>{book.title || `${book.year} 年册`}</h2><p>{book.chapters.length ? `${book.chapters.length} 个章节` : '还没有章节，打开后开始编辑。'}</p><div className="inline-actions"><Link to={`/yearbooks/${book.id}/edit`} className="button secondary"><BookOpen size={16} />继续编辑</Link><Link to={`/yearbooks/${book.id}/preview`} className="text-link"><ExternalLink size={16} />预览</Link><button type="button" className="text-button danger-text" disabled={busy === book.id} onClick={() => void remove(book)}><Trash2 size={16} />移入回收站</button></div></div>
      </article>)}
    </div> : !books.error && <EmptyState title="还没有年册" description="从一个年份开始，选几条想留下的记录，慢慢做成一本。" action={<Link to="/yearbooks/new" className="button primary"><Plus size={18} />新建第一本</Link>} />}
  </>;
}

export function YearbookEditorPage() {
  const { id } = useParams();
  return <YearbookEditor key={id || 'new'} id={id} />;
}

function YearbookEditor({ id }: { id?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const arrival = location.state as { yearbookMessage?: string; yearbookError?: string } | null;
  const existing = useResource<YearbookItem>(id ? `/api/yearbooks/${id}` : null);
  const versions = useResource<YearbookVersion[]>(id ? `/api/yearbooks/${id}/versions` : null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);
  const initialized = useRef(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(arrival?.yearbookError || '');
  const [message, setMessage] = useState(arrival?.yearbookMessage || '');
  const [cacheWarning, setCacheWarning] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [orderNotice, setOrderNotice] = useState({ text: '', revision: 0 });
  const [expansion, setExpansion] = useState({ expanded: true, revision: 0 });
  const storageKey = `yearbook:yearbook-draft:${id || 'new'}`;
  const recordsResource = useYearRecords(draft.year);
  const records = recordsResource.data?.items ?? [];
  const media = useMemo(() => recordMedia(records), [recordsResource.data]);
  const needsSave = dirty || !id;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function replaceDraft(next: Draft, changed: boolean) {
    draftRef.current = next;
    dirtyRef.current = changed;
    setDraft(next);
    setDirty(changed);
  }

  useEffect(() => {
    if (initialized.current || (id && !existing.data)) return;
    initialized.current = true;
    const fallback = existing.data ? toDraft(existing.data) : draftRef.current;
    let restored = fallback;
    let changed = false;
    try {
      const cached = localStorage.getItem(storageKey);
      if (cached) {
        try {
          restored = parseYearbookDraft(JSON.parse(cached));
          changed = true;
          setMessage('已恢复上次未保存的编辑，照片选择和排序也已保留。保存后会写入年册。');
        } catch {
          setCacheWarning('上次的临时草稿暂时无法读取，当前显示已保存的内容；原草稿缓存仍保留在此浏览器中。');
        }
      }
    } catch {
      setCacheWarning('此浏览器暂时不能保存临时草稿，请使用“保存年册”保留修改。');
    }
    replaceDraft(restored, changed);
    setSavedAt(existing.data?.updatedAt || '');
    setLoaded(true);
  }, [existing.data, id, storageKey]);

  useEffect(() => {
    if (!loaded || !dirty) return;
    const timer = window.setTimeout(() => {
      if (!dirtyRef.current) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(draftRef.current));
        setCacheWarning('');
      } catch {
        setCacheWarning('临时草稿未能保存在此浏览器中。请先“保存年册”，再离开编辑页。');
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, loaded, storageKey]);

  useEffect(() => {
    const cacheLatest = () => {
      if (!initialized.current || !dirtyRef.current) return;
      try { localStorage.setItem(storageKey, JSON.stringify(draftRef.current)); } catch { /* The editor already exposes the cache warning. */ }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      cacheLatest();
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('pagehide', cacheLatest);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      cacheLatest();
      window.removeEventListener('pagehide', cacheLatest);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [storageKey]);

  function announce(text: string) { setOrderNotice(current => ({ text, revision: current.revision + 1 })); }
  function updateDraft(patch: Partial<Draft>) {
    if (busyRef.current) return;
    replaceDraft({ ...draftRef.current, ...patch }, true);
    setMessage('');
  }
  function updateChapter(index: number, patch: Partial<YearbookChapterInput>) {
    updateDraft({ chapters: draftRef.current.chapters.map((chapter, item) => item === index ? { ...chapter, ...patch } : chapter) });
  }
  function moveChapter(index: number, by: number) {
    const current = draftRef.current.chapters;
    const chapters = moveYearbookItem(current, index, index + by);
    if (chapters === current) { announce(by < 0 ? '已经是第一章。' : '已经是最后一章。'); return; }
    updateDraft({ chapters });
    announce(`“${current[index].title || '未命名章节'}”已移到第 ${index + by + 1} 章，共 ${chapters.length} 章。保存后会保留这个顺序。`);
  }
  function addChapter() {
    const current = draftRef.current.chapters;
    if (current.length >= 100) { setError('一本年册最多保留 100 个章节。'); return; }
    updateDraft({ chapters: [...current, { id: crypto.randomUUID(), kind: 'custom', title: '新的章节', body: '', blocks: [], sourceRecordIds: [] }] });
    announce(`已添加第 ${current.length + 1} 章。`);
  }
  function removeChapter(index: number) {
    if (!window.confirm('删除这个章节？章节里的内容会从年册编辑稿中移除，已保存的版本仍保留。')) return;
    updateDraft({ chapters: draftRef.current.chapters.filter((_, item) => item !== index) });
    announce('章节已从编辑稿移除，保存后生效。');
  }
  function updateBlock(chapterIndex: number, blockIndex: number, patch: Partial<YearbookBlockInput>) {
    const chapter = draftRef.current.chapters[chapterIndex];
    if (!chapter) return;
    updateChapter(chapterIndex, { blocks: chapter.blocks.map((block, item) => item === blockIndex ? { ...block, ...patch } : block) });
  }
  function addBlock(chapterIndex: number, type: YearbookBlockInput['type']) {
    const chapter = draftRef.current.chapters[chapterIndex];
    if (!chapter) return;
    if (chapter.blocks.length >= 1000) { setError('每章最多保留 1000 个内容块，请新建章节继续添加。'); return; }
    const block: YearbookBlockInput = { id: crypto.randomUUID(), type, body: '', mediaId: null, recordId: null, caption: '' };
    updateChapter(chapterIndex, { blocks: [...chapter.blocks, block] });
    announce(`已在“${chapter.title || '未命名章节'}”末尾添加${blockKinds.find(kind => kind.value === type)?.label}。`);
  }
  function moveBlock(chapterIndex: number, blockIndex: number, by: number) {
    const chapter = draftRef.current.chapters[chapterIndex];
    if (!chapter) return;
    const blocks = moveYearbookItem(chapter.blocks, blockIndex, blockIndex + by);
    if (blocks === chapter.blocks) { announce(by < 0 ? '已经是本章第一个内容块。' : '已经是本章最后一个内容块。'); return; }
    updateChapter(chapterIndex, { blocks });
    const label = chapter.blocks[blockIndex].type === 'image' ? '照片' : '内容块';
    announce(`“${chapter.title || '未命名章节'}”中的${label}已移到第 ${blockIndex + by + 1} 位，共 ${blocks.length} 个内容块。保存后会保留这个顺序。`);
  }
  function removeBlock(chapterIndex: number, blockIndex: number) {
    const chapter = draftRef.current.chapters[chapterIndex];
    if (!chapter) return;
    updateChapter(chapterIndex, { blocks: chapter.blocks.filter((_, item) => item !== blockIndex) });
    announce('内容块已移除，本章的来源记录仍保留。');
  }
  function toggleSource(chapterIndex: number, recordId: string) {
    const chapter = draftRef.current.chapters[chapterIndex];
    if (!chapter) return;
    const selected = new Set(chapter.sourceRecordIds);
    if (!selected.has(recordId) && selected.size >= 1000) { setError('每章最多关联 1000 条来源记录，请另建章节。'); return; }
    selected.has(recordId) ? selected.delete(recordId) : selected.add(recordId);
    updateChapter(chapterIndex, { sourceRecordIds: Array.from(selected) });
  }
  function addPhotos(chapterIndex: number, mediaIds: string[]) {
    const chapter = draftRef.current.chapters[chapterIndex];
    if (!chapter || busyRef.current) return false;
    try {
      const next = appendYearbookPhotos(chapter, mediaIds.flatMap(mediaId => {
        const photo = media.find(item => item.id === mediaId);
        return photo ? [{ mediaId, caption: photo.caption, sourceRecordIds: records.filter(record => record.media.some(item => item.id === mediaId)).map(record => record.id) }] : [];
      }));
      if (next === chapter) return false;
      updateChapter(chapterIndex, next);
      announce(`已按勾选顺序加入 ${next.blocks.length - chapter.blocks.length} 张照片。下方可以修改说明，用上移、下移调整顺序。`);
      return true;
    } catch (reason) { setError(errorText(reason)); return false; }
  }
  function commitSaved(result: YearbookItem) {
    replaceDraft(toDraft(result), false);
    setSavedAt(result.updatedAt);
    try { localStorage.removeItem(storageKey); setCacheWarning(''); }
    catch { setCacheWarning('年册已保存，但此浏览器未能清除旧的临时草稿。下次打开时请核对内容。'); }
    if (id) { existing.setData(result); versions.reload(); }
  }

  async function perform(action: 'save' | 'preview' | 'html' | 'pdf', event?: FormEvent) {
    event?.preventDefault();
    if (busyRef.current) return;
    const shouldSave = action === 'save' || dirtyRef.current || !id;
    const parsed = shouldSave ? yearbookInputSchema.safeParse(draftRef.current) : null;
    if (parsed && !parsed.success) {
      const issue = parsed.error.issues[0];
      const chapterIndex = issue?.path[0] === 'chapters' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
      const blockIndex = issue?.path[2] === 'blocks' && typeof issue.path[3] === 'number' ? issue.path[3] : null;
      const where = chapterIndex === null ? '' : `第 ${chapterIndex + 1} 章${blockIndex === null ? '' : `、内容块 ${blockIndex + 1}`}：`;
      setError(where + (issue?.path[0] === 'year' ? '年份应为 1 到 9999 的整数。' : issue?.message || '请检查年册内容。'));
      if (chapterIndex !== null) {
        setExpansion(current => ({ expanded: true, revision: current.revision + 1 }));
        const chapter = draftRef.current.chapters[chapterIndex];
        const targetId = blockIndex === null ? `yearbook-chapter-${chapter?.id}` : `yearbook-block-${chapter?.blocks[blockIndex]?.id}`;
        window.requestAnimationFrame(() => document.getElementById(targetId)?.focus());
      }
      return;
    }
    busyRef.current = true;
    setBusy(action); setError(''); setMessage('');
    let created: YearbookItem | null = null;
    let openedPreview = false;
    let finalMessage = '';
    let finalError = '';
    try {
      let saved = existing.data;
      if (parsed?.success) {
        saved = await api<YearbookItem>(id ? `/api/yearbooks/${id}` : '/api/yearbooks', { method: id ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) });
        commitSaved(saved);
        if (!id) created = saved;
      }
      if (!saved) throw new Error('年册尚未保存，请重试。');
      if (action === 'preview') {
        openedPreview = true;
        if (mounted.current) navigate(`/yearbooks/${saved.id}/preview`);
      } else if (action === 'html' || action === 'pdf') {
        await exportYearbook(saved.id, action, `${saved.title || `${saved.year} 年册`}.${action === 'html' ? 'zip' : 'pdf'}`, value => { finalMessage = value; setMessage(value); });
      } else {
        finalMessage = '年册已保存，章节、照片顺序和模板设置都已保留。';
        setMessage(finalMessage);
      }
    } catch (reason) { finalError = errorText(reason); setError(finalError); }
    finally {
      busyRef.current = false;
      setBusy('');
      if (created && !openedPreview && mounted.current) navigate(`/yearbooks/${created.id}/edit`, { replace: true, state: { yearbookMessage: finalMessage, yearbookError: finalError } });
    }
  }

  async function applyVersion(version: YearbookVersion) {
    if (!id || busyRef.current) return;
    if (dirtyRef.current && !window.confirm('当前有未保存的修改。采用这个版本会替换编辑区内容，已经保存的版本仍保留，是否继续？')) return;
    busyRef.current = true;
    setBusy('version'); setError(''); setMessage('');
    try {
      const result = await api<YearbookItem>(`/api/yearbooks/${id}/versions/${version.id}/apply`, { method: 'POST' });
      commitSaved(result);
      setMessage(`已采用第 ${version.versionNo} 个版本，原版本仍保留在历史中。`);
    } catch (reason) { setError(errorText(reason)); }
    finally { busyRef.current = false; setBusy(''); }
  }

  if (existing.error) return <ErrorNotice message={existing.error} retry={existing.reload} />;
  if (existing.loading || !loaded) return <Loading label="正在打开年册编辑器…" />;
  return <>
    <Link to="/yearbooks" className="back-link"><ArrowLeft size={16} />我的年册</Link>
    <PageHeading title={id ? '继续编辑年册' : '新建年册'} description="章节、文字和照片都可以反复调整，保存后随时回来继续。">
      <div className="inline-actions yearbook-output-actions">
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => void perform('preview')}><ExternalLink size={16} />{busy === 'preview' ? '正在打开…' : needsSave ? '保存并预览' : '预览'}</button>
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => void perform('html')}><Download size={16} />{busy === 'html' ? '导出中…' : needsSave ? '保存并导出 HTML' : '离线 HTML'}</button>
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => void perform('pdf')}><FileDown size={16} />{busy === 'pdf' ? '导出中…' : needsSave ? '保存并导出 PDF' : 'PDF'}</button>
      </div>
    </PageHeading>
    {error && <ErrorNotice message={error} />}
    {message && <StatusNotice>{message}</StatusNotice>}
    {cacheWarning && <div className="notice" role="status">{cacheWarning}</div>}
    {id && <div className="inline-actions yearbook-ai-actions">
      <Link className="text-link" to={`/ai?kind=yearbook&year=${draft.year}&yearbookId=${id}`} aria-disabled={dirty || !!busy} onClick={event => { if (dirty || busy) { event.preventDefault(); setError('请先保存当前修改，再请助理生成独立草稿。'); } }}>生成全年 AI 草稿</Link>
      <Link className="text-link" to={`/ai?kind=agent&year=${draft.year}&yearbookId=${id}`} aria-disabled={dirty || !!busy} onClick={event => { if (dirty || busy) { event.preventDefault(); setError('请先保存当前修改，再请助理整理章节。'); } }}>用一句话整理章节</Link>
      <Link className="text-link" to="/tasks">查看生成任务</Link>
    </div>}
    <form className="yearbook-editor" onSubmit={event => void perform('save', event)} aria-busy={!!busy}>
      <div className="yearbook-save-bar">
        <div><span className="save-status" role="status" aria-live="polite">{busy ? <><LoaderCircle size={18} className="spin" />{busy === 'html' || busy === 'pdf' ? '正在准备导出…' : busy === 'version' ? '正在采用版本…' : '正在保存…'}</> : dirty ? '有未保存的修改' : !id ? '这本年册尚未保存' : <><Check size={18} />已保存{savedAt ? ` · ${readableTime(savedAt)}` : ''}</>}</span>
          <p className="helper">{needsSave ? '预览或导出时，会先保存当前修改。' : '当前预览和导出会使用这份已保存的内容。'}</p></div>
        <button className="button primary" disabled={!!busy}><Save size={18} />{busy === 'save' ? '保存中…' : '保存年册'}</button>
      </div>
      <fieldset className="yearbook-editable" disabled={!!busy}>
        <legend className="sr-only">年册内容</legend>
        <section className="yearbook-editor-settings" aria-labelledby="yearbook-settings-title">
          <div className="section-title"><h2 id="yearbook-settings-title">年册信息</h2><BookOpen size={20} strokeWidth={1.5} /></div>
          <div className="yearbook-fields">
            <label>年份<input type="number" min={1} max={9999} value={draft.year} onChange={event => updateDraft({ year: Number(event.target.value) || dateYear() })} /></label>
            <label>年册标题<input maxLength={300} value={draft.title} placeholder={`${draft.year} 年册`} onChange={event => updateDraft({ title: event.target.value })} /></label>
          </div>
          <fieldset className="template-choice"><legend>基础模板</legend>
            <label className={draft.template === 'photo' ? 'selected' : ''}><input type="radio" name="template" value="photo" checked={draft.template === 'photo'} onChange={() => updateDraft({ template: 'photo' })} /><span><strong>照片为主</strong><small>照片铺开，文字与照片交错阅读。</small></span></label>
            <label className={draft.template === 'text' ? 'selected' : ''}><input type="radio" name="template" value="text" checked={draft.template === 'text'} onChange={() => updateDraft({ template: 'text' })} /><span><strong>文字为主</strong><small>收窄行宽，给长段落和原话更多空间。</small></span></label>
          </fieldset>
          <label>年度开篇<textarea rows={5} maxLength={100000} value={draft.introBody} placeholder="这一年，你想先写下什么？" onChange={event => updateDraft({ introBody: event.target.value })} /></label>
          <label>封面照片<select value={draft.coverMediaId || ''} onChange={event => updateDraft({ coverMediaId: event.target.value || null })}>
            <option value="">暂不选择</option>
            {draft.coverMediaId && !media.some(item => item.id === draft.coverMediaId) && <option value={draft.coverMediaId}>当前封面照片（已保留）</option>}
            {media.map(item => <option key={item.id} value={item.id}>{item.caption || item.filename}</option>)}
          </select></label>
          {draft.coverMediaId && media.find(item => item.id === draft.coverMediaId) && <img className="yearbook-cover-thumbnail" src={media.find(item => item.id === draft.coverMediaId)!.thumbnailUrl} alt="当前封面照片" />}
          <p className="helper">照片来自所选年份的记录。更换年份会刷新可选素材，已关联的内容仍保留。</p>
          {recordsResource.loading ? <p className="helper" role="status">正在读取 {draft.year} 年的记录和照片…</p> : recordsResource.error ? <ErrorNotice message={recordsResource.error} retry={recordsResource.reload} /> : !media.length && <p className="helper">这个年份还没有可选照片，可以先写文字，再从<Link className="text-link" to="/records/new">新记录</Link>添加照片。</p>}
        </section>
        <section className="yearbook-chapters" aria-labelledby="chapter-title">
          <div className="section-title"><div><h2 id="chapter-title">章节 <span className="muted-count">{draft.chapters.length}</span></h2><p className="helper">用上移、下移调整阅读顺序，空月份可以删除。</p></div>
            <div className="inline-actions"><button type="button" className="text-button" disabled={!draft.chapters.length} onClick={() => setExpansion(current => ({ expanded: false, revision: current.revision + 1 }))}>全部收起</button><button type="button" className="text-button" disabled={!draft.chapters.length} onClick={() => setExpansion(current => ({ expanded: true, revision: current.revision + 1 }))}>全部展开</button><button type="button" className="button secondary" disabled={draft.chapters.length >= 100} onClick={addChapter}><Plus size={18} />添加章节</button></div>
          </div>
          <div className="yearbook-order-feedback" role="status" aria-live="polite" aria-atomic="true"><span key={orderNotice.revision}>{orderNotice.text || '章节和内容块均按从上到下的顺序阅读。'}</span></div>
          {draft.chapters.length ? draft.chapters.map((chapter, index) => <ChapterEditor key={chapter.id} chapter={chapter} index={index} total={draft.chapters.length} records={records} media={media} mediaLoading={recordsResource.loading} mediaError={recordsResource.error} expansion={expansion} onChange={patch => updateChapter(index, patch)} onMove={by => moveChapter(index, by)} onRemove={() => removeChapter(index)} onAddBlock={type => addBlock(index, type)} onUpdateBlock={(blockIndex, patch) => updateBlock(index, blockIndex, patch)} onMoveBlock={(blockIndex, by) => moveBlock(index, blockIndex, by)} onRemoveBlock={blockIndex => removeBlock(index, blockIndex)} onToggleSource={recordId => toggleSource(index, recordId)} onAddPhotos={mediaIds => addPhotos(index, mediaIds)} />) : <EmptyState title="还没有章节" description="可以先保存封面，也可以添加一章，开始组织这一年的素材。" action={<button type="button" className="button secondary" onClick={addChapter}><Plus size={16} />添加第一章</button>} />}
        </section>
      </fieldset>
    </form>
    {id && <section className="yearbook-versions" aria-labelledby="versions-title">
      <div className="section-title"><div><h2 id="versions-title">编辑版本</h2><p className="helper">每次保存都会留下一个快照。AI 生成的新草稿也会单独出现在这里。</p></div><span className="muted-count">{versions.data?.length ?? 0} 个版本</span></div>
      {versions.error && <ErrorNotice message={versions.error} retry={versions.reload} />}
      {versions.loading ? <Loading label="正在读取版本历史…" /> : versions.data?.length ? <ol className="version-list">{versions.data.map(version => <li key={version.id}><div><strong>第 {version.versionNo} 个版本 · {version.source === 'ai' ? 'AI 草稿' : '手动保存'}</strong><span>{version.label || (version.source === 'ai' ? 'AI 草稿' : '手动保存')} · {readableTime(version.createdAt)}</span></div><button type="button" className="button secondary" disabled={!!busy} onClick={() => void applyVersion(version)}><Check size={16} />采用此版本</button></li>)}</ol> : !versions.error && <p className="helper">保存一次后，这里会显示版本快照。</p>}
    </section>}
  </>;
}

type ChapterEditorProps = {
  chapter: YearbookChapterInput;
  index: number;
  total: number;
  records: RecordItem[];
  media: RecordItem['media'];
  mediaLoading: boolean;
  mediaError: string;
  expansion: { expanded: boolean; revision: number };
  onChange: (patch: Partial<YearbookChapterInput>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
  onAddBlock: (type: YearbookBlockInput['type']) => void;
  onUpdateBlock: (index: number, patch: Partial<YearbookBlockInput>) => void;
  onMoveBlock: (index: number, by: number) => void;
  onRemoveBlock: (index: number) => void;
  onToggleSource: (recordId: string) => void;
  onAddPhotos: (mediaIds: string[]) => boolean;
};

function ChapterEditor({ chapter, index, total, records, media, mediaLoading, mediaError, expansion, onChange, onMove, onRemove, onAddBlock, onUpdateBlock, onMoveBlock, onRemoveBlock, onToggleSource, onAddPhotos }: ChapterEditorProps) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const orderId = useId();
  useEffect(() => { setExpanded(expansion.expanded); }, [expansion]);
  const unavailableSources = chapter.sourceRecordIds.filter(id => !records.some(record => record.id === id));
  const photoCount = chapter.blocks.filter(block => block.type === 'image').length;
  return <article className={`chapter-editor ${expanded ? 'expanded' : 'collapsed'}`} id={`yearbook-chapter-${chapter.id}`} data-chapter-id={chapter.id} tabIndex={-1} aria-label={`第 ${index + 1} 章：${chapter.title || '未命名章节'}`}>
    <header className="chapter-editor-heading">
      <div className="chapter-number" id={orderId}><span className="sr-only">第 </span>{String(index + 1).padStart(2, '0')}<small><span className="sr-only"> 章，共 </span> / {total}<span className="sr-only"> 章</span></small></div>
      <div className="chapter-heading-fields">
        <select value={chapter.kind} aria-label={`第 ${index + 1} 章类型`} onChange={event => onChange({ kind: event.target.value as YearbookChapterInput['kind'] })}>{chapterKinds.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select>
        <input value={chapter.title} maxLength={300} aria-label={`第 ${index + 1} 章标题`} placeholder="章节标题" onChange={event => onChange({ title: event.target.value })} />
      </div>
      <div className="chapter-tools" role="group" aria-label={`第 ${index + 1} 章操作`}>
        <button type="button" className="icon-button" aria-label={`上移章节 ${index + 1}`} aria-describedby={orderId} aria-disabled={index === 0} title={index === 0 ? '已经是第一章' : '上移一章'} onClick={() => onMove(-1)}><ArrowUp size={16} /></button>
        <button type="button" className="icon-button" aria-label={`下移章节 ${index + 1}`} aria-describedby={orderId} aria-disabled={index === total - 1} title={index === total - 1 ? '已经是最后一章' : '下移一章'} onClick={() => onMove(1)}><ArrowDown size={16} /></button>
        <button type="button" className="icon-button" aria-label={expanded ? '收起章节' : '展开章节'} aria-expanded={expanded} aria-controls={contentId} title={expanded ? '收起章节' : '展开章节'} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
        <button type="button" className="icon-button danger-text" aria-label="删除章节" title={`删除第 ${index + 1} 章`} onClick={onRemove}><Trash2 size={16} /></button>
      </div>
    </header>
    <div className="chapter-editor-body" id={contentId} hidden={!expanded}>
      {chapter.kind === 'cover' && <p className="helper">封面标题和照片在“年册信息”设置。这里可以写封面附页；完全空白时不会重复显示。</p>}
      <label>章节正文<textarea rows={5} maxLength={100000} value={chapter.body} placeholder="写下这一章想留下的内容。" onChange={event => onChange({ body: event.target.value })} /></label>
      <div className="source-picker">
        <div className="section-title"><div><h3>来源记录</h3><p className="helper">勾选本章引用的原始记录，方便日后回查。</p></div><span className="muted-count">{chapter.sourceRecordIds.length} 条</span></div>
        {records.length ? <div className="source-record-list">{records.map(record => <label key={record.id} className="check-label"><input type="checkbox" checked={chapter.sourceRecordIds.includes(record.id)} onChange={() => onToggleSource(record.id)} /><span><strong>{record.title || record.body.slice(0, 40) || '照片里的这一天'}</strong><small>{readableDate(record.occurredOn)}{record.people.length ? ` · ${record.people.join('、')}` : ''}</small></span></label>)}</div> : <p className="helper">{mediaLoading ? '正在读取这个年份的素材…' : mediaError ? '素材暂时未能读取，已有关联仍保留。可在年册信息处重试。' : '这个年份还没有记录，可以先保存章节，之后再补素材。'}</p>}
        {!mediaLoading && unavailableSources.length > 0 && <p className="helper">另有 {unavailableSources.length} 条已关联的来源不在当前列表中，关联仍保留。</p>}
      </div>
      {chapter.kind === 'photos' && <PhotoCollectionPicker chapter={chapter} media={media} loading={mediaLoading} error={mediaError} onAdd={onAddPhotos} />}
      <div className="block-editor">
        <div className="section-title"><div><h3>{chapter.kind === 'photos' ? '选集顺序与说明' : '内容块'} <span className="muted-count">{chapter.blocks.length}{chapter.kind === 'photos' ? ` 个内容块 · ${photoCount} 张照片` : ' 个'}</span></h3><p className="helper">{chapter.kind === 'photos' ? '照片按下方顺序阅读，说明会跟随照片一起移动，也可以穿插文字。' : '文字、原话、照片和记录卡片可以混排，用上移、下移调整顺序。'}</p></div>
          <div className="block-add-actions">{blockKinds.map(kind => <button type="button" className="text-button" key={kind.value} disabled={chapter.blocks.length >= 1000} onClick={() => onAddBlock(kind.value)}><Plus size={15} />{kind.label}</button>)}</div>
        </div>
        {chapter.blocks.length ? chapter.blocks.map((block, blockIndex) => <BlockEditor key={block.id} block={block} index={blockIndex} total={chapter.blocks.length} records={records} media={media} collection={chapter.kind === 'photos'} photoIndex={chapter.blocks.slice(0, blockIndex + 1).filter(item => item.type === 'image').length} photoCount={photoCount} onChange={patch => onUpdateBlock(blockIndex, patch)} onMove={by => onMoveBlock(blockIndex, by)} onRemove={() => onRemoveBlock(blockIndex)} />) : <p className="block-empty">{chapter.kind === 'photos' ? '还没有选入照片。勾选上方照片后，点击“添加选中照片”。' : '还没有内容块。可以直接填写章节正文，或添加一段文字。'}</p>}
      </div>
    </div>
  </article>;
}

function PhotoCollectionPicker({ chapter, media, loading, error, onAdd }: { chapter: YearbookChapterInput; media: RecordItem['media']; loading: boolean; error: string; onAdd: (ids: string[]) => boolean }) {
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const included = new Set(chapter.blocks.filter(block => block.type === 'image').map(block => block.mediaId));
  const selected = pendingIds.filter(id => !included.has(id) && media.some(photo => photo.id === id));
  const tooMany = selected.length + chapter.blocks.length > 1000;
  function toggle(id: string) { setPendingIds(selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]); }
  return <section className="yearbook-photo-picker" aria-label="选择年度照片">
    <div className="section-title"><div><h3>挑选年度照片</h3><p className="helper">按勾选顺序加入选集，原记录的照片说明和来源会一并保留。</p></div><span className="muted-count">{media.length} 张可选</span></div>
    {loading ? <p className="helper">正在读取照片…</p> : error ? <p className="helper">照片暂时未能读取，可在年册信息处重试。</p> : media.length ? <>
      <div className="yearbook-photo-grid">
        {media.map(photo => {
          const added = included.has(photo.id);
          const selectionIndex = selected.indexOf(photo.id);
          return <label className={`yearbook-photo-option${added ? ' included' : selectionIndex >= 0 ? ' selected' : ''}`} key={photo.id}>
            <img src={photo.thumbnailUrl} alt="" loading="lazy" />
            <span className="yearbook-photo-option-label"><input type="checkbox" checked={added || selectionIndex >= 0} disabled={added} aria-label={`加入选集：${photo.caption || photo.filename}`} onChange={() => toggle(photo.id)} /><span title={photo.caption || photo.filename}>{photo.caption || photo.filename}</span></span>
            <small>{added ? '已在选集' : selectionIndex >= 0 ? `待加入 · 第 ${selectionIndex + 1} 张` : `${photo.width} × ${photo.height}`}</small>
          </label>;
        })}
      </div>
      <div className="yearbook-photo-picker-actions"><span className={tooMany ? 'field-error' : 'helper'} role="status">{tooMany ? '超过每章 1000 个内容块，请减少选片数量。' : selected.length ? `待加入 ${selected.length} 张` : '勾选照片后添加，已选入的照片可在下方调整。'}</span><button type="button" className="button secondary" disabled={!selected.length || tooMany} onClick={() => { if (onAdd(selected)) setPendingIds([]); }}><Plus size={16} />添加选中照片{selected.length ? `（${selected.length}）` : ''}</button></div>
    </> : <div className="yearbook-photo-empty"><p>这个年份还没有照片。</p><p className="helper">先保存年册，再从一条新记录添加照片，回来即可挑选。</p><Link to="/records/new" className="text-link"><Plus size={16} />新建带照片的记录</Link></div>}
  </section>;
}

function BlockEditor({ block, index, total, records, media, collection, photoIndex, photoCount, onChange, onMove, onRemove }: { block: YearbookBlockInput; index: number; total: number; records: RecordItem[]; media: RecordItem['media']; collection: boolean; photoIndex: number; photoCount: number; onChange: (patch: Partial<YearbookBlockInput>) => void; onMove: (by: number) => void; onRemove: () => void }) {
  const orderId = useId();
  const photo = block.mediaId ? media.find(item => item.id === block.mediaId) : undefined;
  return <article className={`block-editor-item block-${block.type}`} id={`yearbook-block-${block.id}`} data-block-id={block.id} tabIndex={-1} aria-label={`内容块 ${index + 1}：${blockKinds.find(kind => kind.value === block.type)?.label}`}>
    <div className="block-editor-top">
      <span className="block-index" id={orderId}><span className="sr-only">内容块 </span>{String(index + 1).padStart(2, '0')} / {total}</span>
      <select value={block.type} aria-label={`内容块 ${index + 1} 类型`} onChange={event => onChange({ type: event.target.value as YearbookBlockInput['type'] })}>{blockKinds.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select>
      <div className="block-tools" role="group" aria-label={`内容块 ${index + 1} 操作`}>
        <button type="button" className="icon-button" aria-label={`上移内容块 ${index + 1}`} aria-describedby={orderId} aria-disabled={index === 0} title={index === 0 ? '已经是本章第一个内容块' : '上移一个位置'} onClick={() => onMove(-1)}><ArrowUp size={16} /></button>
        <button type="button" className="icon-button" aria-label={`下移内容块 ${index + 1}`} aria-describedby={orderId} aria-disabled={index === total - 1} title={index === total - 1 ? '已经是本章最后一个内容块' : '下移一个位置'} onClick={() => onMove(1)}><ArrowDown size={16} /></button>
        <button type="button" className="icon-button danger-text" aria-label={`删除内容块 ${index + 1}`} title="移除这个内容块" onClick={onRemove}><X size={16} /></button>
      </div>
    </div>
    {(block.type === 'paragraph' || block.type === 'quote') && <label>{block.type === 'quote' ? '原话' : '段落文字'}<textarea rows={4} maxLength={100000} value={block.body} onChange={event => onChange({ body: event.target.value })} /></label>}
    {block.type === 'image' && <>
      {collection && <p className="helper">选集照片 {photoIndex} / {photoCount}</p>}
      <div className={`yearbook-image-editor${photo ? ' has-photo' : ''}`}>
        {photo && <img className="yearbook-block-thumbnail" src={photo.thumbnailUrl} alt={block.caption || photo.filename} loading="lazy" />}
        <div className="block-media-fields"><label>选择照片<select value={block.mediaId || ''} aria-invalid={!block.mediaId} onChange={event => onChange({ mediaId: event.target.value || null })}>
          <option value="">请选择照片</option>
          {block.mediaId && !photo && <option value={block.mediaId}>当前照片（已保留）</option>}
          {media.map(item => <option value={item.id} key={item.id}>{item.caption || item.filename}</option>)}
        </select></label><label>照片说明<input maxLength={2000} value={block.caption} placeholder="照片里的场景" onChange={event => onChange({ caption: event.target.value })} /></label></div>
      </div>
      {!block.mediaId && <p className="helper">请选择一张照片后再保存，未完成的选择和说明会保留在临时草稿中。</p>}
      {block.mediaId && !photo && <p className="helper">这张照片不在当前年份的素材列表中，照片编号与说明仍保留。</p>}
    </>}
    {block.type === 'record' && <><label>关联记录<select value={block.recordId || ''} aria-invalid={!block.recordId} onChange={event => onChange({ recordId: event.target.value || null })}>
      <option value="">请选择记录</option>
      {block.recordId && !records.some(record => record.id === block.recordId) && <option value={block.recordId}>当前关联记录（已保留）</option>}
      {records.map(record => <option value={record.id} key={record.id}>{record.title || record.body.slice(0, 40) || readableDate(record.occurredOn)}</option>)}
    </select></label>{!block.recordId && <p className="helper">选择一条原始记录后即可保存。</p>}</>}
  </article>;
}

export function YearbookPreviewPage() {
  const { id } = useParams();
  return <YearbookPreview key={id} id={id} />;
}

function YearbookPreview({ id }: { id?: string }) {
  const book = useResource<YearbookItem>(id ? `/api/yearbooks/${id}` : null);
  const frame = useRef<HTMLIFrameElement>(null);
  const exportBusy = useRef(false);
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewPhase, setPreviewPhase] = useState<'checking' | 'loading' | 'ready' | 'failed'>('checking');
  const [previewUrl, setPreviewUrl] = useState('');
  const [revision, setRevision] = useState(0);
  const [hasLocalDraft] = useState(() => {
    try { return !!localStorage.getItem(`yearbook:yearbook-draft:${id}`); } catch { return false; }
  });
  const route = id ? `/api/yearbooks/${id}/preview` : '';

  useEffect(() => {
    if (!book.data || !id) return;
    const controller = new AbortController();
    const url = `${route}?saved=${encodeURIComponent(book.data.updatedAt)}&view=${revision}`;
    setPreviewPhase('checking'); setPreviewError(''); setPreviewUrl('');
    const timer = window.setTimeout(() => controller.abort(), 120_000);
    void (async () => {
      try {
        // HEAD detects HTTP failures before showing an iframe. The iframe then
        // loads the same renderer with its route-specific document CSP.
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`年册排版暂时无法生成（${response.status}），请重试。`);
        if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('预览服务返回了无法阅读的内容，请重试。');
        if (!controller.signal.aborted) { setPreviewUrl(url); setPreviewPhase('loading'); }
      } catch (reason) {
        if (controller.signal.aborted) return;
        setPreviewError(reason instanceof TypeError ? '无法连接本地服务，请确认《一年一册》仍在运行后重试。' : errorText(reason)); setPreviewPhase('failed');
      } finally { window.clearTimeout(timer); }
    })();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [book.data?.updatedAt, id, revision, route]);

  useEffect(() => {
    if (previewPhase !== 'checking' && previewPhase !== 'loading') return;
    const timer = window.setTimeout(() => {
      setPreviewError('准备预览的时间较长，请检查本地服务后重新载入。');
      setPreviewPhase('failed');
    }, 120_000);
    return () => window.clearTimeout(timer);
  }, [previewPhase, revision]);

  function onFrameLoad() {
    try {
      const document = frame.current?.contentDocument;
      if (!document || document.contentType !== 'text/html' || !document.querySelector('main')) throw new Error('年册排版未能载入，请重新生成预览。');
      setPreviewError(''); setPreviewPhase('ready');
    } catch (reason) { setPreviewError(errorText(reason)); setPreviewPhase('failed'); }
  }

  async function printPreview() {
    if (previewPhase !== 'ready') return;
    try {
      const target = frame.current;
      if (!target?.contentWindow || !target.contentDocument) throw new Error('请等年册预览载入后再打印。');
      await target.contentDocument.fonts.ready;
      target.contentWindow.focus();
      target.contentWindow.print();
    } catch (reason) { setError(errorText(reason) + ' 也可以单独打开排版后打印。'); }
  }

  async function exportBook(kind: 'html' | 'pdf') {
    if (!id || !book.data || exportBusy.current) return;
    exportBusy.current = true;
    setExporting(kind); setError(''); setMessage('');
    try { await exportYearbook(id, kind, `${book.data.title || `${book.data.year} 年册`}.${kind === 'html' ? 'zip' : 'pdf'}`, value => setMessage(value)); }
    catch (reason) { setError(errorText(reason)); }
    finally { exportBusy.current = false; setExporting(''); }
  }

  if (book.error) return <ErrorNotice message={book.error} retry={book.reload} />;
  if (book.loading) return <Loading label="正在读取年册…" />;
  if (!book.data) return null;
  return <>
    <Link to={`/yearbooks/${id}/edit`} className="back-link"><ArrowLeft size={16} />返回编辑</Link>
    <PageHeading title={book.data.title || `${book.data.year} 年册`} description={`${book.data.year} · ${templateLabel(book.data.template)}`}>
      <div className="inline-actions yearbook-output-actions">
        <button type="button" className="button secondary" disabled={previewPhase !== 'ready'} onClick={() => void printPreview()}><Printer size={17} />打印年册</button>
        <button type="button" className="button secondary" disabled={!!exporting || previewPhase !== 'ready'} onClick={() => void exportBook('html')}><Download size={17} />{exporting === 'html' ? '导出中…' : '离线 HTML'}</button>
        <button type="button" className="button primary" disabled={!!exporting || previewPhase !== 'ready'} onClick={() => void exportBook('pdf')}><FileDown size={17} />{exporting === 'pdf' ? '导出中…' : 'PDF 导出'}</button>
      </div>
    </PageHeading>
    {error && <ErrorNotice message={error} />}
    {message && <StatusNotice>{message}</StatusNotice>}
    {hasLocalDraft && <div className="notice" role="status"><span>还有未保存的编辑，当前显示的是上次保存的年册。</span><Link className="text-link" to={`/yearbooks/${id}/edit`}>返回编辑，保存并预览</Link></div>}
    <div className="yearbook-preview-note section-title"><p className="helper">保存于 {readableTime(book.data.updatedAt)}。预览与导出使用相同排版，打印时会自动分页。</p><a className="text-link" href={route} target="_blank" rel="noreferrer"><ExternalLink size={16} />单独打开排版</a></div>
    {!book.data.chapters.length && <p className="helper yearbook-preview-note">这本年册目前只有封面，可以返回编辑添加章节。</p>}
    <YearbookReader frame={frame} src={previewUrl} title={book.data.title || `${book.data.year} 年册`} phase={previewPhase} error={previewError} onRetry={() => setRevision(value => value + 1)} onLoad={onFrameLoad} onError={() => { setPreviewError('预览连接中断，请重新载入。'); setPreviewPhase('failed'); }} />
  </>;
}
