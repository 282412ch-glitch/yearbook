/** Shared by the saved preview, offline HTML and PDF. Reader-only zoom is
 * scoped to screen media; every print starts from the same A4 composition. */
export const yearbookCss = `
:root {
  color-scheme: only light;
  --paper: #eef3ed;
  --surface: #fdfefb;
  --ink: #2c4437;
  --muted: #647668;
  --rule: #d5dfd2;
  --accent: #52715a;
  --soft: #e7eee1;
  --serif: YearbookSerif, "Songti SC", serif;
  --sans: YearbookSans, "Microsoft YaHei", sans-serif;
  --reader-stage: #dfe8e1;
}
* { box-sizing: border-box; }
html { background: var(--reader-stage); color: var(--ink); scrollbar-width: thin; scrollbar-color: #9dae9d var(--reader-stage); }
body { margin: 0; font-family: var(--sans); font-size: 15px; line-height: 1.95; }
a { color: var(--accent); text-underline-offset: 3px; overflow-wrap: anywhere; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
h1, h2, h3, p, figure, blockquote, ol, ul { margin: 0; }
h1, h2, h3 { font-weight: 400; font-family: var(--serif); line-height: 1.55; overflow-wrap: anywhere; text-wrap: balance; }
h1 { font-size: 36px; }
h2 { font-size: 30px; }
h3 { font-size: 23px; }
.page { width: min(794px, calc(100% - 40px)); margin: 24px auto; }
.cover, .contents, .chapter { position: relative; padding: 55px 58px; margin-bottom: 24px; background: var(--surface); border: 1px solid #d0dccd; box-shadow: 0 8px 25px #2339230d; scroll-margin-top: 24px; }
.cover { min-height: 1000px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 35px; padding: 43px 48px 38px; background: linear-gradient(140deg, #f7faf2, #eef3e7); text-align: center; }
.cover::before { content: ''; position: absolute; inset: 15px; border: 1px solid #a5b59a66; pointer-events: none; }
.cover-topline, .cover-bottom { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 20px; color: var(--muted); font-size: 10px; letter-spacing: .12em; line-height: 1.8; }
.cover-topline > span:first-child { font-family: var(--serif); letter-spacing: .28em; }
.cover-heading { width: 100%; margin: 8px 0; }
.cover-year { font-family: var(--serif); font-size: 114px; font-weight: 400; line-height: 1.25; letter-spacing: .025em; color: #4f6e54; font-variant-numeric: lining-nums; }
.cover h1 { max-width: 17em; margin: 22px auto 0; font-size: 32px; line-height: 1.65; letter-spacing: .02em; }
.cover-photo { margin: 0; width: 100%; }
.cover-photo img { display: block; width: auto; height: auto; max-width: 100%; max-height: 405px; object-fit: contain; margin: 0 auto; }
.imprint { font-family: var(--serif); font-size: 10px; letter-spacing: .12em; }
.cover-bottom > span { font-size: 9px; letter-spacing: .03em; }
.cover-window { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; width: 66%; height: 250px; max-height: 27%; border: 1px solid #a4b398; padding: 7px; background: #e9efdf; }
.cover-window i { display: block; background: linear-gradient(145deg, #d3ddc6, #a3b599); }
.cover-window i:nth-child(2) { background: linear-gradient(25deg, #b5c5a6, #e3e9d7); }
.cover-window i:nth-child(3) { background: linear-gradient(135deg, #b3c19e, #819a7a); }
.cover-window i:nth-child(4) { background: linear-gradient(155deg, #a8ba9c, #6f8b71); }
.long-title .cover-year { font-size: 76px; }
.long-title h1 { font-size: 22px; line-height: 1.65; margin-top: 16px; }
.long-title .cover-photo img { max-height: 240px; }
.long-title .cover-window { height: 160px; }
.contents { padding-block: 50px; }
.contents-heading { display: flex; align-items: end; justify-content: space-between; gap: 18px; padding-bottom: 24px; border-bottom: 1px solid var(--rule); margin-bottom: 14px; }
.book-eyebrow { font-size: 10px; color: var(--muted); letter-spacing: .15em; margin-bottom: 12px; }
.contents-heading h2 { font-size: 30px; }
.contents-heading > span { font-size: 11px; color: var(--muted); white-space: nowrap; padding-bottom: 4px; }
.contents ol { list-style: none; padding: 0; }
.contents li { border-bottom: 1px solid var(--rule); break-inside: avoid; }
.contents a { display: flex; align-items: baseline; gap: 22px; padding: 17px 0; text-decoration: none; color: var(--ink); font-family: var(--serif); font-size: 17px; }
.contents a:hover { color: var(--accent); }
.contents-number { min-width: 24px; font: 11px var(--sans); color: var(--accent); font-variant-numeric: tabular-nums; }
.contents-note { margin-top: 30px; font-family: var(--serif); font-size: 12px; color: var(--muted); }
.chapter { min-height: 340px; }
.chapter-heading { margin-bottom: 32px; }
.chapter-heading::after { content: ''; display: block; width: 36px; height: 2px; background: var(--accent); margin-top: 25px; }
.chapter-kicker { display: flex; align-items: center; justify-content: space-between; gap: 20px; color: var(--accent); font-family: var(--sans); font-size: 10px; letter-spacing: .1em; margin-bottom: 17px; }
.chapter-number { font-family: var(--serif); font-size: 34px; line-height: 1; letter-spacing: 0; color: #8da184; }
.prose { max-width: 42em; margin-inline: auto; overflow-wrap: anywhere; line-break: strict; word-break: normal; }
.prose p { white-space: pre-wrap; orphans: 3; widows: 3; }
.prose p + p { margin-top: 1.05em; }
.chapter-body { margin-bottom: 25px; }
.paragraph-block { margin: 22px auto; }
.record { margin: 34px 0; }
.record-heading { margin-bottom: 18px; }
.record-date { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; letter-spacing: .08em; margin-bottom: 6px; }
.record-body { margin: 22px auto; }
.photo { margin: 28px auto; text-align: center; width: 100%; break-inside: avoid; page-break-inside: avoid; }
.photo img { display: block; width: auto; height: auto; max-width: 100%; max-height: 620px; object-fit: contain; margin: 0 auto; }
.photo figcaption { max-width: 48em; margin: 12px auto 0; font-family: var(--sans); font-size: 11px; color: var(--muted); line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; orphans: 3; widows: 3; }
.long-caption { break-inside: auto; page-break-inside: auto; }
.long-caption img { max-height: 330px; break-after: avoid; }
.long-caption figcaption { break-before: avoid; }
blockquote { margin: 28px auto; padding: 20px 25px; border-left: 2px solid #89a07c; background: #eef3e9; font-family: var(--serif); font-size: 18px; line-height: 2; color: #496443; }
.sources { font-family: var(--sans); font-size: 10px; color: var(--muted); padding-top: 16px; margin-top: 30px; border-top: 1px solid var(--rule); }
.sources > p { margin-bottom: 8px; letter-spacing: .05em; }
.sources ul { padding-left: 1.4em; }
.sources li { overflow-wrap: anywhere; }
.sources a { color: var(--muted); text-decoration-color: var(--rule); }
.block-source { font: 10px/1.8 var(--sans); color: var(--muted); margin: 7px 0 22px; }
.source-record { margin: 22px 0; }
.source-record h3 { font-size: 17px; }
.source-details summary { font-size: 11px; color: var(--accent); cursor: pointer; margin-bottom: 15px; }
.template-text .chapter { padding-inline: 68px; }
.template-text .prose { font-family: var(--serif); font-size: 17px; line-height: 2.1; }
.template-text .cover-photo img { max-height: 320px; }
.template-text .photo { max-width: 560px; }
.template-text .photo img { max-height: 400px; }
.template-text .record { margin: 28px 0; }
.template-text .record-heading { margin-bottom: 12px; }
.template-photo .photo + .record-body { margin-top: 25px; }
@media screen {
  html[data-reader-size='fixed'] .page { width: 794px; max-width: none; zoom: var(--reader-zoom, 1); }
  /* Viewport math fits immediately, including in background tabs where resize
     observers can be delayed. The reader's numeric zoom remains the fallback. */
  @supports (zoom: calc(1px / 1px)) {
    html[data-reader-size='fixed'][data-reader-fit='true'] .page { zoom: min(1, calc(max(1px, 100vw - 40px) / 794px)); }
  }
}
@page {
  size: A4;
  margin: 16mm 18mm 18mm;
  @bottom-left { content: '一年一册'; font-family: YearbookSans, sans-serif; font-size: 7pt; color: #7c8c7d; letter-spacing: 1pt; }
  @bottom-right { content: counter(page); font-family: YearbookSans, sans-serif; font-size: 8pt; color: #637862; }
}
@page :first { @bottom-left { content: none; } @bottom-right { content: none; } }
@media print {
  html, body { background: #fff; color: var(--ink); }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 10.5pt; line-height: 1.95; }
  .page, html[data-reader-size='fixed'] .page { width: 100%; max-width: none; margin: 0; padding: 0; background: #fff; min-height: 0; zoom: 1; }
  .cover, .contents, .chapter { box-shadow: none; border: 0; border-radius: 0; margin: 0; }
  .cover { min-height: 258mm; padding: 10mm 9mm 9mm; gap: 7mm; break-after: page; page-break-after: always; }
  .cover::before { inset: 3mm; border-color: #a5b59a80; }
  .cover-topline, .cover-bottom { font-size: 7pt; gap: 5mm; }
  .cover-bottom > span { font-size: 6.5pt; }
  .cover-heading { margin: 2mm 0; }
  .cover-year { font-size: 81pt; line-height: 1.15; }
  .cover h1 { font-size: 24pt; line-height: 1.6; margin-top: 5mm; max-width: 100%; }
  .cover-photo img { max-height: 117mm; max-width: 100%; }
  .template-text .cover-photo img { max-height: 98mm; }
  .imprint { font-size: 7pt; }
  .cover-window { width: 68%; height: 63mm; max-height: none; padding: 2mm; gap: .7mm; }
  .long-title .cover-year { font-size: 48pt; }
  .long-title h1 { font-size: 15pt; line-height: 1.55; margin-top: 4mm; }
  .long-title .cover-photo img, .template-text .long-title .cover-photo img { max-height: 62mm; }
  .long-title .cover-window { height: 40mm; }
  .contents { padding: 10mm 5mm; break-after: page; page-break-after: always; }
  .contents-heading { padding-bottom: 7mm; margin-bottom: 3mm; }
  .contents-heading h2 { font-size: 23pt; }
  .contents-heading > span { font-size: 8pt; }
  .book-eyebrow { font-size: 7pt; margin-bottom: 3mm; }
  .contents ol { column-count: 2; column-gap: 10mm; }
  .contents a { padding: 4mm 0; font-size: 11pt; gap: 4mm; line-height: 1.8; }
  .contents-number { font-size: 8pt; min-width: 5mm; }
  .contents-note { margin-top: 8mm; font-size: 8.5pt; }
  .chapter, .template-text .chapter { padding: 6mm 0 0; min-height: 0; break-inside: auto; background: #fff; }
  .opening, .kind-opening, .kind-month, .kind-photos { break-before: page; page-break-before: always; }
  .chapter-heading { margin-bottom: 8mm; break-inside: avoid; break-after: avoid; page-break-after: avoid; }
  .chapter-kicker { font-size: 7.5pt; margin-bottom: 5mm; }
  .chapter-number { font-size: 28pt; }
  .chapter-heading::after { width: 9mm; height: .5mm; margin-top: 6mm; }
  h2 { font-size: 23pt; }
  h3 { font-size: 14pt; }
  .record { margin: 7mm 0; break-inside: auto; page-break-inside: auto; }
  .record-heading { margin-bottom: 4mm; break-inside: avoid; break-after: avoid; page-break-after: avoid; }
  .record-date { font-size: 8pt; margin-bottom: 1mm; }
  .prose { max-width: 151mm; margin-inline: auto; }
  .template-text .prose { max-width: 146mm; font-size: 11pt; line-height: 2; }
  .template-text .chapter-heading, .template-text .record-heading { max-width: 146mm; margin-inline: auto; }
  .chapter-body { margin-bottom: 6mm; }
  .record-body, .paragraph-block { margin-block: 5mm; }
  .photo { margin: 6mm auto; }
  .photo img, .photo.portrait img { max-height: 155mm; max-width: 100%; object-fit: contain; }
  .photo figcaption { font-size: 8.5pt; margin-top: 2.5mm; line-height: 1.7; }
  .template-text .photo { max-width: 142mm; margin-block: 5mm; }
  .template-text .photo img { max-height: 100mm; }
  .template-text .kind-photos .photo img { max-height: 72mm; }
  .long-caption img, .template-text .long-caption img { max-height: 78mm; }
  .sources { font-size: 8pt; margin-top: 6mm; padding-top: 3mm; break-inside: auto; }
  .sources > p { break-after: avoid; margin-bottom: 1.5mm; }
  .sources li { break-inside: avoid; }
  .sources a, .block-source a { color: var(--muted); text-decoration: none; }
  .block-source { font-size: 8pt; }
  blockquote { margin: 6mm auto; padding: 4mm 6mm; font-size: 12pt; break-inside: auto; }
  .source-record .record-heading { break-after: auto; }
  .source-record .source-details { display: none; }
  .source-record h3 { font-size: 11pt; }
  .keep-photo-lead > .chapter-body { break-inside: avoid; break-after: avoid; page-break-after: avoid; }
  .chapter:last-child { padding-bottom: 0; }
  .chapter:last-child > :last-child { margin-bottom: 0; }
  .cover:last-child { break-after: auto; page-break-after: auto; }
}
@media screen and (max-width: 640px) {
  html:not([data-reader-size='fixed']) .page { width: calc(100% - 24px); margin: 12px auto; }
  html:not([data-reader-size='fixed']) :is(.cover, .contents, .chapter) { padding: 28px; margin-bottom: 12px; }
  html:not([data-reader-size='fixed']) .cover { min-height: 690px; gap: 25px; }
  html:not([data-reader-size='fixed']) .cover-year { font-size: 76px; }
  html:not([data-reader-size='fixed']) .cover h1 { font-size: 25px; }
  html:not([data-reader-size='fixed']) .long-title h1 { font-size: 18px; }
  html:not([data-reader-size='fixed']) .cover-photo img { max-height: 290px; }
  html:not([data-reader-size='fixed']) .cover-window { height: 180px; width: 85%; }
  html:not([data-reader-size='fixed']) .cover-bottom { flex-direction: column; gap: 8px; }
  html:not([data-reader-size='fixed']) .cover-topline { font-size: 8px; }
  html:not([data-reader-size='fixed']) .contents-heading h2 { font-size: 25px; }
  html:not([data-reader-size='fixed']) .contents a { font-size: 15px; }
  html:not([data-reader-size='fixed']) h2 { font-size: 25px; }
  html:not([data-reader-size='fixed']) .prose { font-size: 15px; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;
