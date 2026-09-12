import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Save, Sprout } from 'lucide-react';
import { isLocalDate, localDate, recordInputSchema, type AiDraftItem, type RecordInput, type RecordItem, type RecordMedia } from '@yearbook/shared';
import { api, errorText, useResource } from './api';
import { ErrorNotice, Loading, PageHeading, PhotoImporter, StatusNotice } from './components';

type Draft = Omit<RecordInput, 'media' | 'people' | 'tags'> & { peopleText: string; tagsText: string; media: RecordMedia[] };
type StoredDraft = { version: 1; savedAt: string; value: Draft };

function splitNames(value: string) { return [...new Set(value.split(/[,，、;；\n]/).map(name => name.trim()).filter(Boolean))]; }
function toInput(draft: Draft): RecordInput {
  const { peopleText, tagsText, ...rest } = draft;
  return { ...rest, people: splitNames(peopleText), tags: splitNames(tagsText), media: draft.media.map(({ id, caption }) => ({ id, caption })) };
}
function fromRecord(record: RecordItem): Draft {
  return { title: record.title, body: record.body, occurredOn: record.occurredOn, peopleText: record.people.join('，'), tagsText: record.tags.join('，'), location: record.location, isFirst: record.isFirst, includeInYearbook: record.includeInYearbook, media: record.media };
}
function readDraft(key: string): StoredDraft | null {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null') as StoredDraft | null;
    if (!stored || stored.version !== 1 || !stored.value || !Array.isArray(stored.value.media) || typeof stored.value.peopleText !== 'string' || typeof stored.value.tagsText !== 'string') return null;
    const input = toInput(stored.value);
    // An unfinished draft may still be empty; validate all other fields with one temporary title.
    if (!recordInputSchema.safeParse({ ...input, title: input.title || '未完成草稿' }).success) return null;
    if (stored.value.media.some(photo => typeof photo.thumbnailUrl !== 'string' || !photo.thumbnailUrl.startsWith('/api/media/'))) return null;
    return stored;
  } catch { return null; }
}

export function RecordEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const record = useResource<RecordItem>(id ? `/api/records/${id}` : null);
  const draftId = params.get('aiDraft');
  const aiDraft = useResource<AiDraftItem>(id && draftId ? `/api/ai/drafts/${encodeURIComponent(draftId)}` : null);
  if (id && record.loading) return <Loading label="正在打开这条记录…" />;
  if (record.error) return <ErrorNotice message={record.error} retry={record.reload} />;
  if (draftId && aiDraft.loading) return <Loading label="正在读取待采用的 AI 建议…" />;
  if (draftId && aiDraft.error) return <ErrorNotice message={aiDraft.error} retry={aiDraft.reload} />;
  if (id && !record.data) return null;
  if (record.data?.deletedAt) return <><PageHeading title="这条记录在回收站中" description="先恢复记录，再继续编辑。" /><Link to={`/records/${id}`} className="button secondary">查看并恢复记录</Link></>;
  const date = params.get('date');
  const initial: Draft = record.data ? fromRecord(record.data) : { title: '', body: '', occurredOn: date && isLocalDate(date) ? date : localDate(), peopleText: '', tagsText: '', location: '', isFirst: params.get('first') === 'true', includeInYearbook: true, media: [] };
  if (aiDraft.data) {
    if (aiDraft.data.scopeRecordIds.length !== 1 || aiDraft.data.scopeRecordIds[0] !== id || !['title', 'polish'].includes(aiDraft.data.kind)) return <ErrorNotice message="这份草稿不适用于此条记录，请返回草稿页检查来源。" />;
    if (aiDraft.data.kind === 'title') initial.title = aiDraft.data.content.title;
    if (aiDraft.data.kind === 'polish') initial.body = aiDraft.data.content.paragraphs.map(paragraph => paragraph.text).join('\n\n');
  }
  return <>{draftId && <StatusNotice>已预填 AI 建议，请检查后保存。生成时的原文快照保留在<Link className="text-link" to={`/ai/drafts/${draftId}`}>草稿来源</Link>中。</StatusNotice>}<RecordEditor key={`${id || 'new'}-${draftId || ''}`} id={id} initial={initial} /></>;
}

function RecordEditor({ id, initial }: { id?: string; initial: Draft }) {
  const navigate = useNavigate();
  const key = `yearbook:record-draft:${id || 'new'}`;
  const [recoverable, setRecoverable] = useState(() => readDraft(key));
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [draftState, setDraftState] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const suppress = useRef(false);
  const latest = useRef(draft); latest.current = draft;
  const latestDirty = useRef(dirty); latestDirty.current = dirty;

  function persist() {
    if (suppress.current || !latestDirty.current) return;
    try { localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), value: latest.current })); setDraftState('未提交草稿已保留在此浏览器'); }
    catch { setDraftState('浏览器无法保留草稿，请及时保存记录'); }
  }
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(persist, 250);
    return () => clearTimeout(timer);
  }, [draft, dirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latestDirty.current && !suppress.current) {
        try { localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), value: latest.current })); } catch { /* The browser warning still offers a chance to save. */ }
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('beforeunload', beforeUnload); if (latestDirty.current && !suppress.current) { try { localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), value: latest.current })); } catch { /* Keep the saved record untouched. */ } } };
  }, [key]);
  function update<K extends keyof Draft>(field: K, value: Draft[K]) { setDraft(current => ({ ...current, [field]: value })); setDirty(true); setDraftState('正在保留草稿…'); setError(''); setFieldErrors(current => ({ ...current, [field]: '' })); }
  function recover() { if (recoverable) { setDraft(recoverable.value); setDirty(true); setRecoverable(null); setDraftState('已恢复未提交草稿，请检查后保存'); } }
  function discardRecovery() { localStorage.removeItem(key); setRecoverable(null); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (saving || uploading) return;
    setError(''); setFieldErrors({});
    const result = recordInputSchema.safeParse(toInput(draft));
    if (!result.success) {
      const errors: Record<string, string> = {};
      result.error.issues.forEach(issue => { errors[String(issue.path[0])] = issue.message; });
      setFieldErrors(errors); setError(result.error.issues[0].message);
      document.getElementById(`record-${result.error.issues[0].path[0]}`)?.focus(); return;
    }
    setSaving(true);
    try {
      const saved = await api<RecordItem>(id ? `/api/records/${id}` : '/api/records', { method: id ? 'PUT' : 'POST', body: JSON.stringify(result.data) });
      suppress.current = true; setDirty(false); localStorage.removeItem(key);
      navigate(`/records/${saved.id}`, { replace: true, state: { saved: true } });
    } catch (e) { setError(errorText(e)); persist(); } finally { setSaving(false); }
  }
  return <><Link className="back-link" to={id ? `/records/${id}` : '/'}><ArrowLeft size={16} />{id ? '返回记录' : '回到首页'}</Link><PageHeading title={id ? '再添几笔' : '记一笔'} description="不用写得完整。先留下，之后还能慢慢补。" />
    {recoverable && <div className="draft-recovery" role="status"><div><strong>这里有一份未提交的草稿</strong><p>关闭页面前的文字和已导入照片已保留，可以接着写。</p></div><div className="inline-actions"><button type="button" className="button secondary" onClick={recover}>恢复草稿</button><button type="button" className="text-button" onClick={discardRecovery}>放弃草稿</button></div></div>}
    <form className="record-editor" onSubmit={save} noValidate>
      <div className="editor-main"><div className="editor-title-field"><label htmlFor="record-title">标题 <span>选填</span></label><input id="record-title" className="title-input" placeholder="给这一天起个名字" value={draft.title} maxLength={200} onChange={e => update('title', e.target.value)} aria-invalid={!!fieldErrors.title} aria-describedby="title-error" /><span className="field-error" id="title-error">{fieldErrors.title}</span></div><div className="editor-body-field"><label htmlFor="record-body">正文</label><textarea id="record-body" className="writing-area" placeholder="今天发生了什么？一句话也可以。" rows={9} value={draft.body} maxLength={100000} onChange={e => update('body', e.target.value)} aria-invalid={!!fieldErrors.body} aria-describedby="body-help" /><div className="body-helper"><span className={fieldErrors.body ? 'field-error' : 'helper'} id="body-help">{fieldErrors.body || '只放照片，也能保存。'}</span><span>{draft.body.length.toLocaleString('zh-CN')} 字</span></div></div><PhotoImporter photos={draft.media} onChange={photos => update('media', photos)} onSuggestedDate={date => update('occurredOn', date)} onBusyChange={setUploading} /></div>
      <aside className="editor-aside"><section><h2>这一天的线索</h2><label htmlFor="record-occurredOn">事情发生的日期<input id="record-occurredOn" type="date" min="0001-01-01" max="9999-12-31" value={draft.occurredOn || ''} onChange={e => update('occurredOn', e.target.value || null)} aria-invalid={!!fieldErrors.occurredOn} aria-describedby="date-help" /></label><p className="helper" id="date-help">{fieldErrors.occurredOn || '可补记往年，也可以留空后补。录入时间会另行保存。'}</p><label htmlFor="record-people">一起的人<input id="record-people" placeholder="例如：妈妈，小林" value={draft.peopleText} onChange={e => update('peopleText', e.target.value)} /></label><p className="helper">多个人名用逗号分隔。</p><label htmlFor="record-location">地点<input id="record-location" placeholder="例如：老家的厨房" value={draft.location} maxLength={300} onChange={e => update('location', e.target.value)} /></label><label htmlFor="record-tags">标签<input id="record-tags" placeholder="例如：家人，旅行" value={draft.tagsText} onChange={e => update('tagsText', e.target.value)} /></label><p className="helper">用逗号分隔，之后更容易找到。</p></section><section className="record-options"><h2>为这一页做个记号</h2><label className="check-label"><input type="checkbox" checked={draft.isFirst} onChange={e => update('isFirst', e.target.checked)} /><span><span className="inline-label"><Sprout size={16} />这是生活中的第一次</span><small>由你决定，单独收藏在“生活第一次”。</small></span></label><label className="check-label"><input type="checkbox" checked={draft.includeInYearbook} onChange={e => update('includeInYearbook', e.target.checked)} /><span>默认纳入年册<small>编册时仍然可以调整。</small></span></label></section></aside>
      <div className="editor-save-bar"><div className="save-status" role="status">{draftState && <><Check size={16} /><span>{draftState}</span></>}</div><div className="inline-actions"><Link className="text-link" to={id ? `/records/${id}` : '/records'}>稍后再写</Link><button type="submit" className="button primary" disabled={saving || uploading}><Save size={20} />{saving ? '正在保存…' : uploading ? '照片导入中…' : '保存记录'}</button></div><ErrorNotice message={error} /></div>
    </form>
  </>;
}
