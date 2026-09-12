import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { modelProfileInputSchema, normalizeModelUrl, type CredentialStatus, type ModelCapability, type ModelProfile, type ModelProfileInput, type ModelProfileList } from '@yearbook/shared';
import { api, errorText, readableTime, useResource } from './api';
import { ErrorNotice, Loading, StatusNotice } from './components';
import './models.css';

const capabilities: { key: ModelCapability; name: string }[] = [{ key: 'text', name: '文本生成' }, { key: 'vision', name: '图片理解' }, { key: 'tools', name: '工具调用' }, { key: 'streaming', name: '流式输出' }];
const states = { unknown: '尚未验证', supported: '已验证', unsupported: '未支持', error: '验证失败' };
const fresh = (): ModelProfileInput => ({ name: '', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: '', timeoutMs: 60000, maxOutputTokens: 4096, streamEnabled: false, credentialMode: 'none', apiKey: '', clearKey: false });
function editInput(profile: ModelProfile): ModelProfileInput {
  return { name: profile.name, protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model, timeoutMs: profile.timeoutMs, maxOutputTokens: profile.maxOutputTokens,
    streamEnabled: profile.streamEnabled, credentialMode: profile.credentialMode, apiKey: '', clearKey: false };
}

export function ModelsPanel() {
  const profiles = useResource<ModelProfileList>('/api/model-profiles');
  const credentials = useResource<CredentialStatus>('/api/model-profiles/credential-status');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<ModelProfileInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [modelNames, setModelNames] = useState<string[]>([]);
  const testRequest = useRef<AbortController | null>(null);
  useEffect(() => () => testRequest.current?.abort(), []);
  const chosen = profiles.data?.items.find(item => item.id === selectedId) ?? profiles.data?.items.find(item => item.isActive) ?? profiles.data?.items[0];
  let preview = ''; let addressError = '';
  if (form) { try { preview = normalizeModelUrl(form.baseUrl, form.protocol).endpointUrl; } catch (e) { addressError = errorText(e); } }
  function begin(profile?: ModelProfile) {
    setEditingId(profile?.id ?? null); setForm(profile ? editInput(profile) : { ...fresh(), credentialMode: credentials.data?.defaultMode ?? 'session' }); setModelNames([]); setError(''); setMessage('');
    if (profile) setSelectedId(profile.id);
  }
  function update<K extends keyof ModelProfileInput>(field: K, value: ModelProfileInput[K]) { setForm(current => current ? { ...current, [field]: value } : null); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!form || busy) return;
    const valid = modelProfileInputSchema.safeParse(form);
    if (!valid.success) { setError(valid.error.issues[0]?.message || '请检查配置'); return; }
    setBusy('save'); setError(''); setMessage('');
    try {
      const saved = await api<ModelProfile>(editingId ? `/api/model-profiles/${editingId}` : '/api/model-profiles', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(valid.data) });
      setSelectedId(saved.id); setForm(null); setEditingId(null); profiles.reload();
      setMessage('配置已保存。请分别验证需要的能力；保存配置不会发送生活记录。');
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  async function activate(profile: ModelProfile) {
    setBusy(`active-${profile.id}`); setError(''); setMessage('');
    try { await api(`/api/model-profiles/${profile.id}/activate`, { method: 'POST' }); profiles.reload(); setSelectedId(profile.id); setMessage(`已切换到“${profile.name}”。新任务会使用这套配置。`); }
    catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  async function remove(id: string) {
    setBusy('delete'); setError('');
    try { await api(`/api/model-profiles/${id}`, { method: 'DELETE' }); setDeleteId(null); setForm(null); setSelectedId(null); profiles.reload(); setMessage('模型配置已删除。已有记录和草稿仍然保留。'); }
    catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  async function test(profile: ModelProfile, capability: ModelCapability) {
    setBusy(`test-${capability}`); setError(''); setMessage('');
    const controller = new AbortController(); testRequest.current = controller;
    try {
      const result = await api<{ profile: ModelProfile; result: ModelProfile['capabilities']['text'] }>(`/api/model-profiles/${profile.id}/test`, { method: 'POST', body: JSON.stringify({ capability }), signal: controller.signal }, profile.timeoutMs * 2 + 15000);
      profiles.reload();
      if (result.result.status === 'supported') setMessage(`${capabilities.find(item => item.key === capability)?.name}验证通过：${result.result.message}`);
      else setError(result.result.message);
    } catch (e) { if (controller.signal.aborted) setMessage('验证已取消，原有能力结果保留。'); else setError(errorText(e)); } finally { testRequest.current = null; setBusy(''); }
  }
  async function fetchModels() {
    if (!editingId) return;
    setBusy('models'); setError('');
    try { const result = await api<{ models: string[] }>(`/api/model-profiles/${editingId}/models`); setModelNames(result.models); setMessage(result.models.length ? '已获取模型列表，也可以继续手动填写。' : '服务返回了空列表，请手动填写模型名。'); }
    catch (e) { setError(`${errorText(e)} 仍然可以手动填写模型名称。`); } finally { setBusy(''); }
  }
  return <section className="settings-section model-settings" id="models" aria-labelledby="models-heading">
    <div className="section-title"><div><h2 id="models-heading">模型与 AI 助理</h2><p className="helper">选择你使用的兼容模型服务。每次整理前都能决定素材范围。</p></div><button className="button secondary" disabled={!!busy} onClick={() => begin()}><Plus size={17} />添加模型配置</button></div>
    <p className="helper">支持 Responses 和 Chat Completions 两种兼容协议。自定义地址需要支持所选协议；模型名可以手动填写。验证仅发送测试文字、颜色图或测试工具，不发送生活记录。</p>
    <ErrorNotice message={profiles.error || credentials.error} retry={() => { profiles.reload(); credentials.reload(); }} />
    <ErrorNotice message={error} />{message && <StatusNotice>{message}</StatusNotice>}
    {busy.startsWith('test-') && <div className="inline-actions"><span className="helper" role="status">正在验证所选能力，请稍候。</span><button className="text-button" onClick={() => testRequest.current?.abort()}>取消验证</button></div>}
    {profiles.loading ? <Loading label="正在读取模型配置…" /> : profiles.data?.items.length ? <ul className="model-profile-list">{profiles.data.items.map(profile => <li key={profile.id} className={chosen?.id === profile.id ? 'selected' : ''}>
      <button className="model-select" onClick={() => { setSelectedId(profile.id); setForm(null); setDeleteId(null); }} disabled={!!busy}><Server size={19} /><span><strong>{profile.name}</strong><small>{profile.model} · {profile.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</small></span>{profile.isActive && <span className="model-active"><Check size={14} />正在使用</span>}</button>
      <div className="inline-actions">{!profile.isActive && <button className="text-button" onClick={() => void activate(profile)} disabled={!!busy}>启用</button>}<button className="icon-button" aria-label={`编辑模型配置 ${profile.name}`} onClick={() => begin(profile)} disabled={!!busy}><Pencil size={17} /></button><button className="icon-button danger-text" aria-label={`删除模型配置 ${profile.name}`} onClick={() => setDeleteId(profile.id)} disabled={!!busy}><Trash2 size={17} /></button></div>
      {deleteId === profile.id && <div className="model-delete"><p>删除“{profile.name}”及其密钥引用？已有 AI 草稿会保留。</p><button className="button secondary" disabled={!!busy} onClick={() => void remove(profile.id)}>确认删除配置</button><button className="text-button" disabled={!!busy} onClick={() => setDeleteId(null)}>取消</button></div>}
    </li>)}</ul> : <p className="model-empty">还没有配置模型。记录、回顾、手动编册和导出都可以直接使用。</p>}
    {form && <form className="model-form" onSubmit={save} noValidate>
      <h3>{editingId ? '编辑模型配置' : '新的模型配置'}</h3><div className="model-fields">
        <label>配置名称<input value={form.name} autoFocus maxLength={100} onChange={e => update('name', e.target.value)} placeholder="例如：本机模型" /></label>
        <label>API 协议<select value={form.protocol} onChange={e => update('protocol', e.target.value as ModelProfileInput['protocol'])}><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option></select></label>
        <label className="model-wide">Base URL<input value={form.baseUrl} autoComplete="off" spellCheck={false} maxLength={2000} placeholder="http://localhost:1234/v1" onChange={e => update('baseUrl', e.target.value)} /></label>
        <div className="model-wide endpoint-preview"><span>最终请求地址</span><code>{preview || addressError}</code><small>直接粘贴完整接口地址也可以。请按服务说明填写 /v1 或其他前缀；已有前缀会保留，不会自动重复添加。</small></div>
        <label className="model-wide">模型名称<input value={form.model} list="yearbook-model-names" autoComplete="off" maxLength={200} placeholder="填写服务提供的精确模型名" onChange={e => update('model', e.target.value)} /><datalist id="yearbook-model-names">{modelNames.map(name => <option key={name} value={name} />)}</datalist></label>
        {editingId && <div className="model-wide inline-actions"><button className="button secondary" type="button" onClick={() => void fetchModels()} disabled={!!busy}>获取已保存配置的模型列表</button><span className="helper">列表获取失败不影响手动填写；地址修改需先保存。</span></div>}
        <label>请求超时（秒）<input type="number" min={1} max={600} value={form.timeoutMs / 1000} onChange={e => update('timeoutMs', Number(e.target.value) * 1000)} /></label>
        <label>输出长度上限（token）<input type="number" min={64} max={131072} value={form.maxOutputTokens} onChange={e => update('maxOutputTokens', Number(e.target.value))} /></label>
        <label className="model-wide">密钥保存方式<select value={form.credentialMode} onChange={e => update('credentialMode', e.target.value as ModelProfileInput['credentialMode'])}><option value="none">不使用密钥（服务无需 Key）</option><option value="windows" disabled={credentials.data?.windowsAvailable === false}>Windows 系统凭据</option><option value="session">仅本次会话（服务关闭后失效）</option></select></label>
        <p className="helper model-wide">{credentials.data?.message || '正在检查系统凭据…'}</p>
        {form.credentialMode !== 'none' && <><label className="model-wide">API Key<input type="password" value={form.apiKey ?? ''} autoComplete="new-password" spellCheck={false} maxLength={2500} onChange={e => update('apiKey', e.target.value)} placeholder={editingId ? '留空表示保留已有密钥' : '仅发送到本机服务保存'} /></label>{editingId && <label className="check-label model-wide"><input type="checkbox" checked={form.clearKey} onChange={e => update('clearKey', e.target.checked)} />清除已有密钥</label>}</>}
        <label className="check-label model-wide"><input type="checkbox" checked={form.streamEnabled} onChange={e => update('streamEnabled', e.target.checked)} />启用流式输出（保存后单独验证）</label>
      </div>
      <div className="inline-actions"><button type="submit" className="button primary" disabled={!!busy}>{busy === 'save' ? '正在保存…' : '保存模型配置'}</button><button type="button" className="text-button" disabled={!!busy} onClick={() => { setForm(null); setEditingId(null); }}>取消编辑</button></div>
    </form>}
    {chosen && !form && <div className="model-capabilities">
      <div className="section-title"><h3>{chosen.name} · 能力验证</h3><span className="helper">{chosen.credentialMode === 'none' ? '无需密钥' : chosen.keyPresent ? chosen.credentialMode === 'windows' ? '密钥在 Windows 系统凭据中' : '密钥仅在本次服务会话中' : '密钥未提供或会话已结束'}</span></div>
      <p className="endpoint-text">{chosen.endpointUrl}</p>
      <p className="helper">各项验证均使用已保存配置的{chosen.streamEnabled ? '流式' : '普通'}请求方式；每项能力分别记录，文本成功不会自动标记其他能力。</p>
      <ul>{capabilities.map(({ key, name }) => { const capability = chosen.capabilities[key]; return <li key={key}>
        <div><strong>{name}</strong><span className={`capability-state ${capability.status}`}>{states[capability.status]}</span><p className="helper">{capability.message}{capability.checkedAt ? ` · ${readableTime(capability.checkedAt)}` : ''}</p></div>
        <button className="button secondary" disabled={!!busy || key === 'streaming' && !chosen.streamEnabled} onClick={() => void test(chosen, key)}>{busy === `test-${key}` ? '正在验证…' : `验证${name}`}</button>
      </li>; })}</ul>
      {!chosen.streamEnabled && <p className="helper">流式输出尚未启用。需要时可编辑配置，启用后再单独验证。</p>}
      <div className="inline-actions"><Link to="/ai" className="text-link">用选定素材整理草稿</Link><Link to="/tasks" className="text-link">查看后台任务</Link></div>
    </div>}
  </section>;
}
