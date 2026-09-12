import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Check, FileText, History, LoaderCircle, Plus, RotateCcw, Save, Search, Square, X } from 'lucide-react';
import {
  aiDraftContentSchema, aiTaskInputSchema, localDate, type AiAdoptResult, type AiDraftChapter, type AiDraftContent,
  type AiDraftItem, type AiDraftList, type AiDraftVersion, type AiParagraph, type AiPhoto, type AiSourceSnapshot,
  type AiTaskDetail, type AiTaskInput, type AiTaskKind, type AiTaskResult, type Metadata, type ModelProfileList,
  type RecordItem, type RecordList, type TaskItem, type YearbookList,
} from '@yearbook/shared';
import { api, errorText, readableDate, readableTime, useResource } from './api';
import { EmptyState, ErrorNotice, Loading, PageHeading, StatusNotice } from './components';
import './ai.css';

const names: Record<AiTaskKind, string> = { title: '建议标题', polish: '整理文字', questions: '补充问题', monthly: '月末小报', chapter: '编写章节', yearbook: '全年编册', agent: '交给编册助理' };
const statuses: Record<TaskItem['status'], string> = { pending: '等待执行', running: '正在进行', completed: '已完成', failed: '未完成', cancelled: '已取消' };
const singleRecord = (kind: AiTaskKind) => ['title', 'polish', 'questions'].includes(kind);
const taskKind = (task: TaskItem) => task.kind === 'ai' ? 'AI 整理' : task.kind === 'yearbook-pdf' ? 'PDF 导出' : task.kind === 'yearbook-html' ? '离线 HTML 导出' : '后台任务';
const resultOf = (task: TaskItem) => (task.result && typeof task.result === 'object' ? task.result : {}) as Partial<AiTaskResult>;
const unique = <T,>(items: T[]) => [...new Set(items)];
const modeText = (mode: string) => mode === 'tools' ? '助理检索与编写' : '程序筛选素材后生成';

function Usage({ usage }: { usage: AiTaskDetail['usage'] }) {
  return <p className="helper">{usage ? <>服务返回的实际用量：{usage.inputTokens != null && `输入 ${usage.inputTokens} Token`}{usage.outputTokens != null && ` · 输出 ${usage.outputTokens} Token`}{usage.totalTokens != null && ` · 合计 ${usage.totalTokens} Token`}。未提供费用信息。</> : '服务尚未提供可靠用量，不估算 Token 或费用。'}</p>;
}
function TaskDetails({ task }: { task: TaskItem }) {
  const detail = useResource<AiTaskDetail>(task.kind === 'ai' ? `/api/ai/tasks/${task.id}` : null);
  useEffect(() => { if (task.kind === 'ai') detail.reload(); }, [task.updatedAt, task.kind, detail.reload]);
  if (task.kind !== 'ai') return null;
  return <div className="ai-task-details"><ErrorNotice message={detail.error} retry={detail.reload} />{!detail.data && detail.loading ? <Loading label="正在读取已保存的阶段…" /> : detail.data && <>
    <p>{names[detail.data.request.kind]} · {modeText(detail.data.mode)}</p>
    {detail.data.request.instruction && <p className="helper">整理要求：{detail.data.request.instruction}</p>}
    <p className="helper">已保存 {detail.data.stages.length} 个阶段 · 本次执行已调用工具 {task.toolCalls} 次 · 最多 {detail.data.request.maxToolCalls} 次 · 时长上限 {Math.round(task.maxDurationMs / 60000 * 10) / 10} 分钟</p>
    {detail.data.stages.length > 0 && <ul className="ai-stage-list">{detail.data.stages.map(stage => <li key={stage.key}><Check size={16} /><span>{stage.label}</span><details><summary>查看阶段文字</summary><div className="ai-stage-copy">{[...stage.content.highlights, ...stage.content.paragraphs, ...stage.content.chapters.flatMap(chapter => chapter.paragraphs)].map((paragraph, i) => <p key={i}>{paragraph.text}</p>)}</div></details></li>)}</ul>}
    <Usage usage={detail.data.usage} />
    {detail.data.warnings.map((warning, i) => <p className="helper" key={i}>{warning}</p>)}
  </>}</div>;
}
function TaskCard({ task, reload, highlighted }: { task: TaskItem; reload: () => void; highlighted?: boolean }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [expanded, setExpanded] = useState(false);
  async function action(kind: 'cancel' | 'retry') {
    setBusy(true); setError('');
    try { await api(`/api/tasks/${task.id}/${kind}`, { method: 'POST' }); reload(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  const result = resultOf(task);
  return <article className={`ai-task-card ${highlighted ? 'highlighted' : ''}`} id={`task-${task.id}`} aria-label={`${taskKind(task)}，${statuses[task.status]}`}>
    <div className="ai-task-head"><div><span className={`ai-status ${task.status}`}>{task.status === 'running' && <LoaderCircle size={15} className="spin" />}{statuses[task.status]}</span><h2>{taskKind(task)}</h2><time className="helper" dateTime={task.createdAt}>{readableTime(task.createdAt)}</time></div><div className="inline-actions">
      {['pending', 'running'].includes(task.status) && <button className="button secondary" disabled={busy} onClick={() => void action('cancel')}><Square size={15} />取消任务</button>}
      {['failed', 'cancelled'].includes(task.status) && <button className="button secondary" disabled={busy} onClick={() => void action('retry')}><RotateCcw size={16} />继续 / 重试</button>}
      {task.status === 'completed' && result.draftId && <Link className="button primary" to={`/ai/drafts/${result.draftId}`}>查看草稿<ArrowRight size={16} /></Link>}
      {task.status === 'completed' && task.yearbookId && task.kind.startsWith('yearbook-') && <a className="button primary" href={`/api/yearbooks/${task.yearbookId}/export/${task.kind === 'yearbook-pdf' ? 'pdf' : 'html'}?taskId=${task.id}`}>下载{task.kind === 'yearbook-pdf' ? ' PDF' : ' HTML ZIP'}</a>}
    </div></div>
    <div className="ai-task-progress"><progress max={100} value={task.progress} aria-label="任务进度" /><span>{task.progress}%</span></div>
    <p className="helper" role={task.status === 'running' ? 'status' : undefined}>{task.message || '本地服务正在安排任务。'}</p>
    <ErrorNotice message={task.errorMessage || error} />
    {task.kind === 'ai' && <><button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起阶段与用量' : '查看阶段与用量'}</button>{expanded && <TaskDetails task={task} />}</>}
  </article>;
}

export function TasksPage() {
  const [params] = useSearchParams(); const highlighted = params.get('task');
  const [items, setItems] = useState<TaskItem[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [revision, setRevision] = useState(0); const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<{ items: TaskItem[] }>('/api/tasks?limit=100', { signal: controller.signal });
        if (!controller.signal.aborted) { setItems(result.items); setError(''); }
      } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void refresh(), 2000); } }
    }
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const visible = items.filter(task => !status || task.status === status).sort((a, b) => a.id === highlighted ? -1 : b.id === highlighted ? 1 : 0);
  return <><PageHeading title="正在整理的事" description="任务和已完成阶段保存在本机。关闭程序后未完成的任务，可以在下次打开时继续。"><Link className="button secondary" to="/ai"><Plus size={18} />新建整理任务</Link></PageHeading>
    <div className="ai-filter-row"><label>任务状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="text-button" onClick={() => setRevision(value => value + 1)}>刷新任务</button><span className="helper">展示最近 100 项任务</span></div>
    <ErrorNotice message={error} retry={() => setRevision(value => value + 1)} />
    {loading ? <Loading label="正在读取任务…" /> : visible.length ? <div className="ai-task-list">{visible.map(task => <TaskCard key={task.id} task={task} highlighted={task.id === highlighted} reload={() => setRevision(value => value + 1)} />)}</div> : <EmptyState title={status ? '暂时没有这个状态的任务' : '这里还没有任务'} description="导出年册、整理文字或生成小报后，可以在这里查看进度。" action={<Link to="/yearbooks" className="button secondary">去看看年册<BookOpen size={17} /></Link>} />}
  </>;
}

function DraftCard({ item }: { item: AiDraftItem }) {
  const firstPhoto = item.content.photos[0] ?? item.content.chapters.flatMap(chapter => chapter.photos)[0];
  return <article className="ai-draft-card">{firstPhoto && <Link to={`/ai/drafts/${item.id}`} tabIndex={-1} aria-hidden="true"><img className="ai-draft-thumb" src={`/api/media/${firstPhoto.mediaId}/thumbnail`} alt="" loading="lazy" /></Link>}<div className="ai-draft-card-copy"><p className="ai-folio">{names[item.kind]} · 第 {item.versionNo} 版{item.status === 'adopted' ? ' · 已采用' : ''}</p><h2><Link to={`/ai/drafts/${item.id}`}>{item.content.title}</Link></h2><p>{item.content.highlights[0]?.text ?? item.content.paragraphs[0]?.text ?? item.content.chapters.find(chapter => chapter.paragraphs.length)?.paragraphs[0]?.text ?? '打开草稿，慢慢编辑。'}</p><div className="ai-draft-card-bottom"><span className="helper">{item.sourceRecordIds.length} 条来源 · {readableTime(item.createdAt)}</span><Link className="text-link" to={`/ai/drafts/${item.id}`}>翻开这一稿<ArrowRight size={16} /></Link></div></div></article>;
}

export function ReportsPage() {
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const query = `year=${Number(month.slice(0, 4))}&month=${Number(month.slice(5, 7))}`;
  const reports = useResource<AiDraftList>(`/api/ai/drafts?kind=monthly&${query}&limit=100`);
  const sources = useResource<RecordList>(`/api/records?${query}&limit=1`);
  return <><PageHeading title="月末，留一张小报" description="把这个月记过的几件事、几张照片，收在一起。文字可以继续改，每段都能回到原始记录。"><Link className="text-link" to="/tasks">查看整理进度<ArrowRight size={16} /></Link></PageHeading>
    <div className="ai-report-masthead"><label>翻到哪一月<input type="month" min="0001-01" max="9999-12" value={month} onChange={event => { if (/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setMonth(event.target.value); }} /></label><div><span className="ai-folio">{Number(month.slice(0, 4))} 年 / {Number(month.slice(5))} 月</span><p className="helper">{sources.data ? `这个月有 ${sources.data.total} 条生活记录。` : '正在看看这个月的素材…'}</p></div><Link className="button primary" to={`/ai?kind=monthly&${query}`}><FileText size={18} />整理这一月</Link></div>
    <ErrorNotice message={reports.error || sources.error} retry={() => { reports.reload(); sources.reload(); }} />
    {reports.loading ? <Loading label="正在翻开月报…" /> : reports.data?.items.length ? <div className="ai-draft-list">{reports.data.items.map(item => <DraftCard key={item.id} item={item} />)}</div> : <EmptyState title="这个月的小报还空着" description={sources.data?.total ? '已有素材可以整理。每次生成都会留下新草稿，之前改过的文字仍可找回。' : '先留下几条生活记录，再来整理。只有一件事或一张照片，也可以开始。'} action={<Link className="button secondary" to={`/records/new?date=${month}-01`}><Plus size={17} />补记这个月</Link>} />}
  </>;
}

function useScopeRecords(year: string, month: string, explicitIds: string[]) {
  const [records, setRecords] = useState<RecordItem[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const idsKey = explicitIds.join(',');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setRecords([]);
    void (async () => {
      if (idsKey) {
        const values: RecordItem[] = [];
        for (const id of unique(idsKey.split(','))) values.push(await api<RecordItem>(`/api/records/${id}`, { signal: controller.signal }));
        if (!controller.signal.aborted) setRecords(values.filter(record => !record.deletedAt));
      } else {
        const values: RecordItem[] = []; let total = 0;
        do {
          const result = await api<RecordList>(`/api/records?year=${Number(year)}${month ? `&month=${Number(month)}` : ''}&limit=500&offset=${values.length}`, { signal: controller.signal });
          total = result.total; values.push(...result.items);
          if (!result.items.length) break;
        } while (values.length < total && values.length < 2000 && !controller.signal.aborted);
        if (total > 2000) throw new Error('这个范围超过 2000 条记录，请按月份或在记录页选择更小范围。');
        if (!controller.signal.aborted) setRecords(values);
      }
    })().catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [year, month, idsKey, revision]);
  return { records, loading, error, reload: () => setRevision(value => value + 1) };
}

export function AiComposePage() {
  const [params] = useSearchParams(); const navigate = useNavigate();
  const rawKind = params.get('kind') as AiTaskKind | null;
  const [kind, setKind] = useState<AiTaskKind>(rawKind && rawKind in names ? rawKind : 'agent');
  const [year, setYear] = useState(params.get('year') || String(new Date().getFullYear()));
  const [month, setMonth] = useState(params.get('month') || (rawKind === 'monthly' ? String(new Date().getMonth() + 1) : ''));
  const [explicitIds, setExplicitIds] = useState(() => unique((params.get('recordIds') || params.get('recordId') || '').split(',').filter(id => /^[\da-f-]{36}$/i.test(id))));
  const [profileId, setProfileId] = useState(''); const [instruction, setInstruction] = useState(''); const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]); const [useImages, setUseImages] = useState(false); const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(10); const [toolLimit, setToolLimit] = useState(16);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submission = useRef<{ signature: string; key: string } | null>(null);
  const profiles = useResource<ModelProfileList>('/api/model-profiles'); const metadata = useResource<Metadata>('/api/meta');
  const sources = useScopeRecords(year, kind === 'monthly' ? month : '', explicitIds);
  const savedYearbookId = params.get('yearbookId');
  const linkedBook = useResource<YearbookList>(savedYearbookId ? '/api/yearbooks?limit=500' : null);
  useEffect(() => { if (profiles.data && !profileId) setProfileId(profiles.data.activeId || profiles.data.items[0]?.id || ''); }, [profiles.data, profileId]);
  useEffect(() => { if (!sources.loading) { const ids = sources.records.filter(record => explicitIds.length || record.includeInYearbook).map(record => record.id); setSelected(singleRecord(kind) ? ids.slice(0, 1) : ids); setPhotoIds([]); } }, [sources.records, sources.loading, explicitIds.length, kind]);
  const selectedRecords = sources.records.filter(record => selected.includes(record.id));
  const visible = sources.records.filter(record => !query.trim() || [record.title, record.body, ...record.people, ...record.tags].join(' ').includes(query.trim()));
  const photos = selectedRecords.flatMap(record => record.media).filter((photo, index, all) => all.findIndex(other => other.id === photo.id) === index);
  const profile = profiles.data?.items.find(profile => profile.id === profileId);
  const years = unique([Number(year), new Date().getFullYear(), ...(metadata.data?.years ?? [])]).sort((a, b) => b - a);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!profileId) { setError('请先保存并选择一套模型配置。密钥在设置页填写。'); return; }
    const raw = { kind, profileId, recordIds: selected, year: singleRecord(kind) ? undefined : Number(year), month: kind === 'monthly' ? Number(month) : undefined,
      instruction, yearbookId: savedYearbookId || undefined, useImages, selectedMediaIds: photoIds.filter(id => photos.some(photo => photo.id === id)), maxDurationMs: minutes * 60000, maxToolCalls: toolLimit };
    const parsed = aiTaskInputSchema.safeParse(raw);
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    if (!selected.length) { setError('请至少选择一条已保存的记录。'); return; }
    const signature = JSON.stringify(parsed.data);
    if (submission.current?.signature !== signature) submission.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const task = await api<TaskItem>('/api/ai/tasks', { method: 'POST', body: JSON.stringify({ ...parsed.data, idempotencyKey: submission.current.key }) });
      navigate(`/tasks?task=${task.id}`);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <><PageHeading title="让素材，慢慢成册" description="先选好这次可以使用的记录，再说说想怎么整理。生成内容会保存为独立草稿，等你过目。"><Link className="text-link" to="/tasks">任务与进度<ArrowRight size={16} /></Link></PageHeading>
    <ErrorNotice message={profiles.error || metadata.error} retry={() => { profiles.reload(); metadata.reload(); }} />
    {profiles.data && !profiles.data.items.length && <div className="notice"><span>还没有模型配置。记录、回顾和手动编册照常可用；要使用整理助理，请先在设置页配置服务。</span><Link className="text-link" to="/settings#models">配置模型<ArrowRight size={16} /></Link></div>}
    <form onSubmit={event => void submit(event)} className="ai-compose-form"><div className="ai-compose-layout"><section className="ai-scope-panel" aria-labelledby="ai-scope-heading"><h2 id="ai-scope-heading">本次使用的素材</h2><p className="helper">只有选中的记录可以被读取。未来信件不会进入此列表。</p>
      <div className="ai-form-row"><label>年份<select value={year} disabled={explicitIds.length > 0} onChange={event => setYear(event.target.value)}>{years.map(value => <option key={value} value={value}>{value} 年</option>)}</select></label>{kind === 'monthly' && <label>月份<select value={month} onChange={event => setMonth(event.target.value)}><option value="">选择月份</option>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1} 月</option>)}</select></label>}</div>
      {explicitIds.length > 0 && <p className="helper">已从原记录指定素材。<button className="text-button" type="button" onClick={() => setExplicitIds([])}>重新按年份选择</button></p>}
      <label className="ai-search"><span><Search size={15} />在当前素材中查找</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="关键词、人物、标签" /></label>
      <div className="ai-selection-toolbar"><span className="helper">已选 {selected.length} / {sources.records.length} 条{singleRecord(kind) ? ' · 此功能选一条' : ''}</span>{!singleRecord(kind) && <><button className="text-button" type="button" onClick={() => setSelected(unique([...selected, ...visible.map(record => record.id)]))}>全选当前筛选</button><button className="text-button" type="button" onClick={() => setSelected([])}>清空选择</button></>}</div>
      <ErrorNotice message={sources.error} retry={sources.reload} />
      {sources.loading ? <Loading label="正在读取这个范围的记录…" /> : visible.length ? <div className="ai-source-list">{visible.map(record => <label key={record.id} className={`ai-source-choice ${selected.includes(record.id) ? 'selected' : ''}`}><input type={singleRecord(kind) ? 'radio' : 'checkbox'} name="ai-record" checked={selected.includes(record.id)} onChange={event => setSelected(singleRecord(kind) ? [record.id] : event.target.checked ? [...selected, record.id] : selected.filter(id => id !== record.id))} /><span><strong>{record.title || record.body.slice(0, 35) || '照片里的日子'}</strong><small>{readableDate(record.occurredOn)}{record.people.length ? ` · ${record.people.join('、')}` : ''}{record.isFirst ? ' · 生活第一次' : ''}</small></span>{record.media[0] && <img src={record.media[0].thumbnailUrl} alt="" loading="lazy" />}</label>)}</div> : <p className="ai-inline-empty">{query ? '没有匹配的记录，换个关键词看看。' : '这个范围还没有素材，可以先补记，或换一个年份。'}</p>}
    </section><section className="ai-request-panel" aria-labelledby="ai-request-heading"><h2 id="ai-request-heading">想怎样整理</h2><label>整理方式<select value={kind} onChange={event => { const next = event.target.value as AiTaskKind; setKind(next); if (next === 'monthly' && !month) setMonth(String(new Date().getMonth() + 1)); }}>{Object.entries(names).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>模型配置<select value={profileId} onChange={event => setProfileId(event.target.value)} disabled={profiles.loading || !profiles.data?.items.length}><option value="">选择一套配置</option>{profiles.data?.items.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>
      {profile && <p className="helper">{profile.protocol === 'responses' ? 'Responses' : 'Chat Completions'} · {kind === 'agent' && profile.capabilities.tools.status === 'supported' ? '已验证工具调用，将由助理检索素材。' : '程序先筛选素材，再交给模型生成。'}</p>}
      <label>补充整理要求{kind === 'agent' ? '（必填）' : '（选填）'}<textarea rows={6} value={instruction} maxLength={5000} onChange={event => setInstruction(event.target.value)} placeholder="把与家人有关的记录整理成一个章节，文字朴素一点，多保留原话。" required={kind === 'agent'} /></label>
      <p className="helper">保留原意，未知的人名、日期和地点留待补充；“生活第一次”以你的标记为准。</p>
      {savedYearbookId && <p className="helper">准备给《{linkedBook.data?.items.find(book => book.id === savedYearbookId)?.title || '选中的年册'}》整理。生成后仍需明确采用。</p>}
      <details className="ai-advanced"><summary>照片与执行范围</summary><label className="ai-check-label"><input type="checkbox" checked={useImages} onChange={event => setUseImages(event.target.checked)} />将下方勾选的照片交给模型理解</label><p className="helper">未勾选时只使用你写的图注。图片能力需在设置页单独验证；每次请求最多发送 6 张缩略图。</p>
        {useImages && <>{profile?.capabilities.vision.status !== 'supported' && <p className="helper">当前配置尚未验证图片能力，本次仍使用图注。</p>}{photos.length ? <div className="ai-select-photos">{photos.map(photo => <label key={photo.id}><img src={photo.thumbnailUrl} alt={photo.caption || photo.filename} loading="lazy" /><span><input type="checkbox" checked={photoIds.includes(photo.id)} onChange={event => setPhotoIds(event.target.checked ? [...photoIds, photo.id] : photoIds.filter(id => id !== photo.id))} />{photo.caption || photo.filename}</span></label>)}</div> : <p className="helper">当前选中的记录没有照片。</p>}</>}
        <div className="ai-form-row"><label>最长执行（分钟）<input type="number" value={minutes} min={1} max={30} onChange={event => setMinutes(Number(event.target.value))} /></label><label>最多工具调用<input type="number" value={toolLimit} min={1} max={40} onChange={event => setToolLimit(Number(event.target.value))} /></label></div>
      </details><ErrorNotice message={error} /><button className="button primary ai-submit" disabled={busy || sources.loading || !selected.length || !profileId} type="submit">{busy ? <><LoaderCircle size={18} className="spin" />正在创建任务…</> : <><FileText size={18} />{kind === 'questions' ? '生成补充问题' : '生成独立草稿'}</>}</button><p className="helper">生成过程可在任务页取消；重试会复用已经完成的阶段。</p>
    </section></div></form>
  </>;
}

function SourceLinks({ ids, snapshots }: { ids: string[]; snapshots: AiSourceSnapshot[] }) {
  return <div className="ai-source-links"><span>来源</span>{ids.map((id, i) => { const source = snapshots.find(record => record.id === id); return <Link key={id} to={`/records/${id}`}>{source?.title || (source?.occurredOn ? readableDate(source.occurredOn, true) : `记录 ${i + 1}`)}</Link>; })}</div>;
}
function ParagraphEditor({ items, onChange, snapshots, label }: { items: AiParagraph[]; onChange: (items: AiParagraph[]) => void; snapshots: AiSourceSnapshot[]; label: string }) {
  return <div className="ai-paragraphs">{items.map((paragraph, i) => <div className="ai-paragraph" key={i}><label>{label} {i + 1}<textarea rows={Math.min(12, Math.max(3, Math.ceil(paragraph.text.length / 50)))} value={paragraph.text} maxLength={30000} onChange={event => onChange(items.map((item, index) => index === i ? { ...item, text: event.target.value } : item))} /></label><div className="ai-paragraph-bottom"><SourceLinks ids={paragraph.sourceRecordIds} snapshots={snapshots} /><button className="icon-button" type="button" aria-label={`移除${label}${i + 1}`} onClick={() => onChange(items.filter((_item, index) => index !== i))}><X size={16} /></button></div></div>)}</div>;
}
function PhotoEditor({ photos, onChange, snapshots }: { photos: AiPhoto[]; onChange: (photos: AiPhoto[]) => void; snapshots: AiSourceSnapshot[] }) {
  function move(i: number, by: number) { const copy = [...photos]; [copy[i], copy[i + by]] = [copy[i + by], copy[i]]; onChange(copy); }
  return <div className="ai-photo-grid">{photos.map((photo, i) => <figure key={`${photo.mediaId}-${i}`}><a href={`/api/media/${photo.mediaId}/display`} target="_blank" rel="noreferrer"><img src={`/api/media/${photo.mediaId}/thumbnail`} alt={photo.caption || '草稿选出的照片'} loading="lazy" /></a><figcaption><label>照片说明<textarea rows={2} value={photo.caption} maxLength={2000} onChange={event => onChange(photos.map((item, index) => index === i ? { ...item, caption: event.target.value } : item))} /></label><SourceLinks ids={photo.sourceRecordIds} snapshots={snapshots} /><div className="ai-photo-tools"><button className="icon-button" type="button" disabled={i === 0} aria-label={`将照片 ${i + 1} 前移`} onClick={() => move(i, -1)}><ArrowUp size={16} /></button><button className="icon-button" type="button" disabled={i === photos.length - 1} aria-label={`将照片 ${i + 1} 后移`} onClick={() => move(i, 1)}><ArrowDown size={16} /></button><button className="icon-button" type="button" aria-label={`从草稿移除照片 ${i + 1}`} onClick={() => onChange(photos.filter((_photo, index) => index !== i))}><X size={16} /></button></div></figcaption></figure>)}</div>;
}
function DraftEditor({ initial }: { initial: AiDraftItem }) {
  const navigate = useNavigate(); const [draft, setDraft] = useState(initial); const [content, setContent] = useState(initial.content);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [target, setTarget] = useState(''); const [showVersions, setShowVersions] = useState(false);
  const versions = useResource<AiDraftVersion[]>(showVersions ? `/api/ai/drafts/${draft.id}/versions` : null);
  const books = useResource<YearbookList>(singleRecord(draft.kind) ? null : '/api/yearbooks?limit=500');
  const key = `yearbook:ai-edit:${draft.id}`;
  const [recoverable, setRecoverable] = useState<AiDraftContent | null>(() => { try { const parsed = aiDraftContentSchema.safeParse(JSON.parse(localStorage.getItem(key) || 'null')); return parsed.success ? parsed.data : null; } catch { return null; } });
  const latest = useRef(content); latest.current = content; const latestDirty = useRef(dirty); latestDirty.current = dirty;
  const [draftState, setDraftState] = useState('');
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => { try { localStorage.setItem(key, JSON.stringify(content)); setDraftState('未提交的修改已保留在此浏览器。'); } catch { setDraftState('浏览器无法保留修改，请及时保存。'); } }, 250);
    return () => clearTimeout(timer);
  }, [content, dirty, key]);
  useEffect(() => {
    function saveBeforeClose(event: BeforeUnloadEvent) { if (latestDirty.current) { try { localStorage.setItem(key, JSON.stringify(latest.current)); } catch { /* The native prompt still lets the user stay. */ } event.preventDefault(); } }
    window.addEventListener('beforeunload', saveBeforeClose); return () => {
      window.removeEventListener('beforeunload', saveBeforeClose);
      if (latestDirty.current) try { localStorage.setItem(key, JSON.stringify(latest.current)); } catch { /* The page already showed the local storage limitation. */ }
    };
  }, [key]);
  function change(next: AiDraftContent) { setContent(next); setDirty(true); setMessage(''); }
  function chapterChange(index: number, next: AiDraftChapter) { change({ ...content, chapters: content.chapters.map((chapter, i) => i === index ? next : chapter) }); }
  async function save() {
    const parsed = aiDraftContentSchema.safeParse(content);
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    setBusy('save'); setError(''); setMessage('');
    try {
      const updated = await api<AiDraftItem>(`/api/ai/drafts/${draft.id}`, { method: 'PUT', body: JSON.stringify({ content: parsed.data }) });
      setDraft(updated); setContent(updated.content); setDirty(false); latestDirty.current = false; setRecoverable(null); setDraftState('');
      try { localStorage.removeItem(key); } catch { /* Saving to SQLite is already complete. */ }
      setMessage('草稿已保存。最初生成的版本和之前的手动版本都已保留。'); versions.reload();
    } catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function adopt() {
    setBusy('adopt'); setError(''); setMessage('');
    try {
      const adopted = await api<AiAdoptResult>(`/api/ai/drafts/${draft.id}/adopt`, { method: 'POST', body: JSON.stringify({ yearbookId: target || null }) });
      setDraft(adopted.draft); setMessage(adopted.message);
      if (adopted.recordProposal && adopted.recordId) navigate(`/records/${adopted.recordId}/edit?aiDraft=${draft.id}`, { state: { aiProposal: adopted.recordProposal, aiDraftId: draft.id } });
      else if (adopted.yearbookId) navigate(`/yearbooks/${adopted.yearbookId}/edit`);
    } catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function regenerate() {
    setBusy('regenerate'); setError(''); setMessage('');
    try {
      const detail = await api<AiTaskDetail>(`/api/ai/tasks/${draft.taskId}`);
      const task = await api<TaskItem>('/api/ai/tasks', { method: 'POST', body: JSON.stringify({ ...detail.request, recordIds: draft.scopeRecordIds, idempotencyKey: crypto.randomUUID() }) });
      navigate(`/tasks?task=${task.id}`);
    } catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  return <><Link className="back-link" to={draft.kind === 'monthly' ? '/reports' : '/tasks'}><ArrowLeft size={16} />{draft.kind === 'monthly' ? '返回月末小报' : '返回任务列表'}</Link><PageHeading title={names[draft.kind]} description={`第 ${draft.versionNo} 版 · ${modeText(draft.mode)} · 由 ${draft.sourceRecordIds.length} 条生活记录整理`}><button className="button secondary" type="button" disabled={!!busy || dirty} onClick={() => void regenerate()}><RotateCcw size={17} />重新生成新版本</button></PageHeading>
    {recoverable && <div className="notice"><span>这里有上次未保存的修改。</span><button className="text-button" onClick={() => { change(recoverable); setRecoverable(null); }}>恢复未保存编辑</button><button className="text-button" onClick={() => { setRecoverable(null); try { localStorage.removeItem(key); } catch { /* Optional local copy. */ } }}>使用当前保存稿</button></div>}
    {draft.warnings.length > 0 && <div className="ai-draft-notes">{draft.warnings.map((warning, i) => <p className="helper" key={i}>{warning}</p>)}</div>}
    <div className="ai-draft-layout"><article className="ai-draft-paper"><div className="ai-paper-topline"><span>{draft.year ? `${draft.year} 年${draft.month ? ` · ${draft.month} 月` : ''}` : '生活素材'}</span><span>{draft.status === 'adopted' ? '已采用的草稿' : '等待你过目'}</span></div><label className="ai-title-label">草稿标题<input value={content.title} maxLength={300} onChange={event => change({ ...content, title: event.target.value })} /></label>
      {!!content.highlights.length && <section className="ai-paper-section"><h2>值得记住的事</h2><ParagraphEditor label="这件事" items={content.highlights} snapshots={draft.sourceSnapshots} onChange={highlights => change({ ...content, highlights })} /></section>}
      {!!content.paragraphs.length && <section className="ai-paper-section"><h2>{draft.kind === 'monthly' ? '回望这个月' : '留下这些文字'}</h2><ParagraphEditor label="段落" items={content.paragraphs} snapshots={draft.sourceSnapshots} onChange={paragraphs => change({ ...content, paragraphs })} /></section>}
      {!!content.questions.length && <section className="ai-paper-section"><h2>可以慢慢想的问题</h2><p className="helper">愿意回答时再写，没有回答也不影响保存。</p>{content.questions.map((question, i) => <label key={i} className="ai-question">问题 {i + 1}<textarea rows={3} value={question} maxLength={1000} onChange={event => change({ ...content, questions: content.questions.map((text, index) => index === i ? event.target.value : text) })} /></label>)}<SourceLinks ids={draft.sourceRecordIds} snapshots={draft.sourceSnapshots} /></section>}
      {!!content.photos.length && <section className="ai-paper-section"><h2>照片里的日子</h2><PhotoEditor photos={content.photos} snapshots={draft.sourceSnapshots} onChange={photos => change({ ...content, photos })} /></section>}
      {content.chapters.map((chapter, index) => <section className="ai-paper-section" key={index}><label>章节标题<input value={chapter.title} maxLength={300} onChange={event => chapterChange(index, { ...chapter, title: event.target.value })} /></label>{!chapter.paragraphs.length && !chapter.photos.length && <p className="helper">这一页留给你，采用到年册后可以继续写。</p>}<ParagraphEditor label="段落" items={chapter.paragraphs} snapshots={draft.sourceSnapshots} onChange={paragraphs => chapterChange(index, { ...chapter, paragraphs })} /><PhotoEditor photos={chapter.photos} snapshots={draft.sourceSnapshots} onChange={photos => chapterChange(index, { ...chapter, photos })} /><button className="text-button" type="button" onClick={() => change({ ...content, chapters: content.chapters.filter((_item, i) => i !== index) })}>移除这一章节</button></section>)}
    </article><aside className="ai-review-panel"><section><h2>把这一稿留好</h2><p className="helper">先看看文字是否合意，再保存。每段下方的“来源”可以打开原始记录。</p><button className="button primary ai-submit" disabled={!!busy || !dirty} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存草稿修改</button>{dirty && <p className="helper">{draftState || '有未保存的修改。'}保存后可以采用或重新生成。</p>}<ErrorNotice message={error} />{message && <StatusNotice>{message}</StatusNotice>}</section>
      <section><h2>{singleRecord(draft.kind) ? '回到生活记录' : '把草稿放进年册'}</h2>{draft.kind === 'questions' ? <><p className="helper">补充问题不会自动写入记录，可以按自己的意愿补记。</p><Link className="button secondary" to={`/records/${draft.scopeRecordIds[0]}`}>打开原记录<ArrowRight size={16} /></Link></> : draft.status === 'adopted' && draft.adoptedYearbookId ? <><p className="helper">这份草稿已经采用。此处继续保存的草稿修改独立保留；年册中的文字请到年册编辑页修改。</p><Link className="button secondary" to={`/yearbooks/${draft.adoptedYearbookId}/edit`}>继续编辑年册<BookOpen size={16} /></Link></> : <>
        {singleRecord(draft.kind) ? <p className="helper">将建议放入记录编辑页，由你确认保存。原始文字的快照保留在下方。</p> : <><label>采用到<select value={target} onChange={event => setTarget(event.target.value)}><option value="">新建一本年册</option>{books.data?.items.map(book => <option key={book.id} value={book.id}>{book.year} · {book.title || '未命名年册'}</option>)}</select></label><ErrorNotice message={books.error} retry={books.reload} /><p className="helper">{draft.kind === 'yearbook' ? '采用整册草稿会替换选中年册的当前内容，采用前的编辑稿会另存为版本。' : '采用后追加为章节，年册中已有的章节会保留。'}</p></>}
        <button className="button secondary ai-submit" disabled={!!busy || dirty || (!singleRecord(draft.kind) && books.loading)} onClick={() => void adopt()}>{busy === 'adopt' && <LoaderCircle className="spin" size={17} />}{singleRecord(draft.kind) ? '放入记录编辑页' : draft.kind === 'yearbook' ? '采用整册草稿' : '采用为年册章节'}<ArrowRight size={17} /></button>
      </>}</section>
      <section><button className="text-button" onClick={() => setShowVersions(value => !value)} aria-expanded={showVersions}><History size={17} />{showVersions ? '收起历史版本' : '查看历史版本'}</button>{showVersions && <><ErrorNotice message={versions.error} retry={versions.reload} />{versions.loading && !versions.data ? <Loading label="正在读取版本…" /> : versions.data?.map(version => <details className="ai-version" key={version.id}><summary>{version.source === 'generated' ? '最初生成稿' : `手动保存 · ${version.revision - 1}`}<small>{readableTime(version.createdAt)}</small></summary><p className="helper">{version.content.title}</p><div className="ai-version-preview">{[...version.content.paragraphs, ...version.content.highlights, ...version.content.chapters.flatMap(chapter => chapter.paragraphs)].map((paragraph, i) => <p key={i}>{paragraph.text}</p>)}</div><button className="text-button" disabled={!!busy} onClick={() => { change(version.content); setMessage('历史版本已放入编辑区，确认后点击“保存草稿修改”。'); }}>将此版本放入编辑区</button></details>)}</>}</section>
    </aside></div>
    <section className="ai-source-archive"><h2>生成时的原始素材</h2><p className="helper">这是生成任务开始时保留的文字快照。日后修改原记录，也能在这里找到当时的原话。</p>{draft.sourceSnapshots.map(source => <details key={source.id}><summary>{source.title || source.body.slice(0, 32) || '照片记录'}<span>{readableDate(source.occurredOn)}</span></summary><div className="ai-original-copy"><p>{source.body || '这条记录仅有照片。'}</p>{source.reflections.map((reflection, i) => <p key={i}>现在回头看：{reflection.body}</p>)}{source.media.map(media => <p key={media.id}>照片说明：{media.caption || '暂未填写'}</p>)}<Link className="text-link" to={`/records/${source.id}`}>查看现在的原记录<ArrowRight size={15} /></Link></div></details>)}</section>
  </>;
}
export function AiDraftPage() {
  const { id } = useParams(); const draft = useResource<AiDraftItem>(id ? `/api/ai/drafts/${id}` : null);
  if (draft.loading) return <Loading label="正在翻开这份草稿…" />;
  if (draft.error) return <ErrorNotice message={draft.error} retry={draft.reload} />;
  return draft.data ? <DraftEditor key={draft.data.id} initial={draft.data} /> : <EmptyState title="没有找到这份草稿" description="可以回到任务列表，看看已经完成的整理。" action={<Link className="button secondary" to="/tasks">查看任务</Link>} />;
}
