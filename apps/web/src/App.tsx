import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { BookOpen, CalendarDays, FileText, House, ListChecks, Mail, Menu, Palette, Plus, Settings2, Shuffle, Sprout, X } from 'lucide-react';
import { HomePage, MemoriesPage, NotFoundPage, RecordDetailPage, RecordsPage, SettingsPage } from './pages';
import { RecordEditorPage } from './RecordEditor';
import { YearbookEditorPage, YearbookListPage, YearbookPreviewPage } from './YearbookPages';
import { AiComposePage, AiDraftPage, ReportsPage, TasksPage } from './AiPages';
import { LetterDetailPage, LetterEditorPage, LettersPage } from './LetterPages';
import { useAppearance } from './Appearance';

const navigation = [
  { to: '/', label: '首页', icon: House, end: true },
  { to: '/records', label: '翻翻日子', icon: CalendarDays },
  { to: '/memories', label: '记忆盲盒', icon: Shuffle },
  { to: '/firsts', label: '生活第一次', icon: Sprout },
  { to: '/yearbooks', label: '我的年册', icon: BookOpen },
  { to: '/reports', label: '月末小报', icon: FileText },
  { to: '/letters', label: '给未来的信', icon: Mail },
  { to: '/tasks', label: '任务与生成进度', icon: ListChecks },
];

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const appearance = useAppearance();
  const activePage = navigation.find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to))?.label || (location.pathname.startsWith('/settings') ? '设置与备份' : '我的时光');
  useEffect(() => { setMenuOpen(false); const anchor = location.hash ? document.getElementById(location.hash.slice(1)) : null; if (anchor) anchor.scrollIntoView(); else window.scrollTo({ top: 0 }); }, [location.pathname, location.hash]);
  return <div className="app-shell"><a className="skip-link" href="#main-content">跳到正文</a><header className="mobile-header"><Link to="/" className="brand"><img src="/brand-mark.png" alt="" width={32} height={36} /><span>一年一册</span></Link><button className="icon-button" aria-label={menuOpen ? '收起导航' : '打开导航'} aria-expanded={menuOpen} aria-controls="main-navigation" onClick={() => setMenuOpen(value => !value)}>{menuOpen ? <X size={24} /> : <Menu size={24} />}</button></header>
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}><Link to="/" className="brand desktop-brand"><img src="/brand-mark.png" alt="" width={32} height={38} /><div><span>一年一册</span><small>日子有迹可循</small></div></Link><Link to="/records/new" className="sidebar-compose button primary"><Plus size={18} />记下今天</Link><p className="nav-caption">我的时光</p><nav id="main-navigation" className="main-nav" aria-label="主要导航">{navigation.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><Icon size={19} strokeWidth={1.6} /><span>{label}</span></NavLink>)}</nav><div className="sidebar-bottom"><button type="button" className="nav-link appearance-shortcut" onClick={appearance.open}><Palette size={19} strokeWidth={1.6} />窗景与外观</button><NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><Settings2 size={19} strokeWidth={1.6} />设置与备份</NavLink><div className="sidebar-note"><span className="local-indicator" />在这台电脑里，好好保存。</div></div></aside>
    <div className="main-shell"><header className="workspace-bar"><div><BookOpen size={16} strokeWidth={1.5} /><span>生活手记</span><i>/</i><strong>{activePage}</strong></div><button type="button" className="workspace-appearance" onClick={appearance.open}><Palette size={16} /><span>外观</span></button></header><main id="main-content" tabIndex={-1}><Routes><Route path="/" element={<HomePage />} /><Route path="/records" element={<RecordsPage />} /><Route path="/records/new" element={<RecordEditorPage />} /><Route path="/records/:id" element={<RecordDetailPage />} /><Route path="/records/:id/edit" element={<RecordEditorPage />} /><Route path="/firsts" element={<RecordsPage firstOnly />} /><Route path="/memories" element={<MemoriesPage />} /><Route path="/trash" element={<RecordsPage deleted />} /><Route path="/settings" element={<SettingsPage />} /><Route path="/yearbooks" element={<YearbookListPage />} /><Route path="/yearbooks/new" element={<YearbookEditorPage />} /><Route path="/yearbooks/:id/edit" element={<YearbookEditorPage />} /><Route path="/yearbooks/:id/preview" element={<YearbookPreviewPage />} /><Route path="/reports" element={<ReportsPage />} /><Route path="/ai" element={<AiComposePage />} /><Route path="/ai/drafts/:id" element={<AiDraftPage />} /><Route path="/letters" element={<LettersPage />} /><Route path="/letters/new" element={<LetterEditorPage />} /><Route path="/letters/:id" element={<LetterDetailPage />} /><Route path="/letters/:id/edit" element={<LetterEditorPage />} /><Route path="/tasks" element={<TasksPage />} /><Route path="*" element={<NotFoundPage />} /></Routes></main><footer className="app-footer"><span>一年一册</span><span>记下平常，留给以后。</span><Link to="/settings">本机保存与备份</Link></footer></div>
  </div>;
}
