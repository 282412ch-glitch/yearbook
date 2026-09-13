import { useEffect, useRef, useState, type RefObject } from 'react';
import { BookOpen, List, Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { ErrorNotice, Loading } from './components';
import { useAppearance } from './Appearance';

type Section = { id: string; title: string; kind: 'cover' | 'contents' | 'chapter' };
type ReaderPhase = 'checking' | 'loading' | 'ready' | 'failed';
const zoomLevels = [50, 75, 100, 125, 150];
const fitScale = (width: number) => Math.min(1, Math.max(1, width - 40) / 794);

export function YearbookReader({ frame, src, title, phase, error, onRetry, onLoad, onError }: {
  frame: RefObject<HTMLIFrameElement | null>; src: string; title: string; phase: ReaderPhase;
  error: string; onRetry: () => void; onLoad: () => void; onError: () => void;
}) {
  const { theme } = useAppearance();
  const [outlineOpen, setOutlineOpen] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  const [focused, setFocused] = useState(false);
  const [zoom, setZoom] = useState('fit');
  const [sections, setSections] = useState<Section[]>([]);
  const [active, setActive] = useState('cover');
  const [progress, setProgress] = useState(0);
  const focusButton = useRef<HTMLButtonElement>(null);
  const ready = phase === 'ready';

  useEffect(() => {
    if (!ready) { setSections([]); setProgress(0); return; }
    const document = frame.current?.contentDocument;
    const targetWindow = frame.current?.contentWindow;
    if (!document || !targetWindow) return;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.cover[id], .contents[id], .chapter[id]'));
    setSections(nodes.map(node => ({
      id: node.id,
      title: node.classList.contains('cover') ? '封面' : node.classList.contains('contents') ? '目录' : node.querySelector('h2')?.textContent || '章节',
      kind: node.classList.contains('cover') ? 'cover' : node.classList.contains('contents') ? 'contents' : 'chapter',
    })));
    let pending = 0;
    function update() {
      pending = 0;
      const scrolling = document!.scrollingElement;
      if (!scrolling) return;
      const available = scrolling.scrollHeight - scrolling.clientHeight;
      setProgress(available > 0 ? Math.min(100, Math.round(scrolling.scrollTop / available * 100)) : 100);
      const current = nodes.findLast(node => node.getBoundingClientRect().top <= 120);
      setActive(current?.id || nodes[0]?.id || 'cover');
    }
    const requestUpdate = () => { if (!pending) pending = window.requestAnimationFrame(update); };
    targetWindow.addEventListener('scroll', requestUpdate, { passive: true });
    targetWindow.addEventListener('resize', requestUpdate);
    const observer = new ResizeObserver(requestUpdate);
    observer.observe(document.body);
    update();
    return () => { observer.disconnect(); targetWindow.removeEventListener('scroll', requestUpdate); targetWindow.removeEventListener('resize', requestUpdate); window.cancelAnimationFrame(pending); };
  }, [ready, src, frame]);

  useEffect(() => {
    if (!ready || !frame.current) return;
    const element = frame.current;
    const root = element.contentDocument?.documentElement;
    if (!root) return;
    root.dataset.readerSize = 'fixed';
    root.dataset.readerFit = String(zoom === 'fit');
    root.style.setProperty('--reader-stage', theme === 'dark' ? '#25392e' : '#dfe8e1');
    function resize() {
      const scale = zoom === 'fit' ? fitScale(element.clientWidth) : Number(zoom) / 100;
      root!.style.setProperty('--reader-zoom', String(scale));
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready, src, zoom, theme, frame]);

  useEffect(() => {
    if (!focused) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.dataset.readerFocus = 'true';
    function exit(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); setFocused(false); focusButton.current?.focus(); }
    }
    const innerWindow = frame.current?.contentWindow;
    window.addEventListener('keydown', exit);
    innerWindow?.addEventListener('keydown', exit);
    return () => {
      document.body.style.overflow = overflow; delete document.body.dataset.readerFocus;
      window.removeEventListener('keydown', exit); innerWindow?.removeEventListener('keydown', exit);
    };
  }, [focused, ready, frame]);

  function scrollTo(id: string) {
    const target = frame.current?.contentDocument?.getElementById(id);
    const innerWindow = frame.current?.contentWindow;
    if (target && innerWindow) innerWindow.scrollTo({ top: target.getBoundingClientRect().top + innerWindow.scrollY - 24, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    setActive(id);
  }
  function changeZoom(direction: -1 | 1) {
    const current = zoom === 'fit' ? fitScale(frame.current?.clientWidth ?? 834) * 100 : Number(zoom);
    const next = direction === 1 ? zoomLevels.find(value => value > current + 1) : zoomLevels.findLast(value => value < current - 1);
    if (next) setZoom(String(next));
  }
  return <section className={`yearbook-preview-shell reader-shell${focused ? ' is-focused' : ''}`} aria-label="年册排版预览" aria-busy={phase === 'checking' || phase === 'loading'}>
    <header className="reader-toolbar">
      <div className="reader-toolbar-start"><button type="button" className="icon-button" aria-label={outlineOpen ? '收起年册目录' : '展开年册目录'} aria-expanded={outlineOpen} aria-controls="reader-outline" onClick={() => setOutlineOpen(value => !value)}><List size={18} /></button><span><BookOpen size={15} />阅读预览</span></div>
      <div className="reader-zoom" role="group" aria-label="预览缩放"><button type="button" className="icon-button" aria-label="缩小预览" disabled={!ready || zoom === '50'} onClick={() => changeZoom(-1)}><Minus size={16} /></button><label className="sr-only" htmlFor="reader-zoom">预览比例</label><select id="reader-zoom" value={zoom} disabled={!ready} onChange={event => setZoom(event.target.value)}><option value="fit">适合宽度</option>{zoomLevels.map(value => <option key={value} value={value}>{value}%</option>)}</select><button type="button" className="icon-button" aria-label="放大预览" disabled={!ready || zoom === '150'} onClick={() => changeZoom(1)}><Plus size={16} /></button></div>
      <div className="reader-toolbar-end"><button type="button" className="icon-button reader-reload" aria-label="重新载入预览" onClick={onRetry} disabled={phase === 'checking' || phase === 'loading'}><RotateCcw size={15} /></button><button type="button" className="reader-focus-button" ref={focusButton} aria-label={focused ? '退出专注' : '专注阅读'} aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}<span>{focused ? '退出专注' : '专注阅读'}</span></button></div>
    </header>
    <div className={`reader-layout${outlineOpen ? ' has-outline' : ''}`}>
      <aside className="reader-outline" id="reader-outline" hidden={!outlineOpen}><div className="reader-outline-heading"><span>这本年册</span><small>{sections.filter(section => section.kind === 'chapter').length} 个章节</small></div><nav aria-label="年册章节">{sections.map((section, index) => <button key={section.id} type="button" className={active === section.id ? 'is-active' : ''} aria-current={active === section.id ? 'location' : undefined} onClick={() => scrollTo(section.id)}><span className="reader-section-number">{section.kind === 'chapter' ? String(sections.slice(0, index + 1).filter(item => item.kind === 'chapter').length).padStart(2, '0') : section.kind === 'cover' ? <BookOpen size={13} /> : <List size={13} />}</span><span>{section.title}</span></button>)}</nav>{!ready && <p className="helper">载入后显示章节</p>}</aside>
      <div className="reader-canvas">
        {(phase === 'checking' || phase === 'loading') && <Loading label="正在准备排版与照片…" />}
        {error && <ErrorNotice message={error} retry={onRetry} />}
        {src && <iframe ref={frame} key={src} className={`yearbook-preview-frame${ready ? '' : ' is-loading'}`} title={`${title}排版预览`} src={src} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer" onLoad={onLoad} onError={onError} />}
      </div>
    </div>
    <footer className="reader-status"><span>{ready ? sections.find(section => section.id === active)?.title || '封面' : phase === 'failed' ? '预览未能载入' : '正在排版…'}</span><div><progress aria-label="年册阅读进度" max={100} value={progress} /><span>{progress}%</span></div><small>按 A4 排版 · 导出时自动分页</small></footer>
  </section>;
}
