import { Link } from 'react-router-dom';
import type { AiDraftList } from '@yearbook/shared';
import { useResource } from './api';
import { ErrorNotice } from './components';

export function AiRecordActions({ recordId }: { recordId: string }) {
  const drafts = useResource<AiDraftList>(`/api/ai/drafts?recordId=${recordId}&limit=5`);
  return <section className="settings-section">
    <div className="section-title"><h2>请助理帮着整理</h2><span className="helper">按需使用，建议先存为独立草稿。</span></div>
    <div className="inline-actions"><Link className="button secondary" to={`/ai?kind=title&recordId=${recordId}`}>建议标题</Link><Link className="button secondary" to={`/ai?kind=polish&recordId=${recordId}`}>整理文字</Link><Link className="button secondary" to={`/ai?kind=questions&recordId=${recordId}`}>补充问题</Link></div>
    <ErrorNotice message={drafts.error} retry={drafts.reload} />
    {!!drafts.data?.items.length && <div className="inline-actions" aria-label="这条记录的 AI 草稿">{drafts.data.items.map(draft => <Link className="text-link" key={draft.id} to={`/ai/drafts/${draft.id}`}>{draft.content.title} · 草稿 {draft.versionNo}</Link>)}</div>}
  </section>;
}
