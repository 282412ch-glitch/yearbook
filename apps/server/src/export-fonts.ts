import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';

type FontFace = { family: string; file: string; range: string; ranges: [number, number][] };
type FontCatalog = { faces: FontFace[]; licenses: string };
let catalog: Promise<FontCatalog> | undefined;
const fontData = new Map<string, Promise<string>>();

function ranges(value: string): [number, number][] {
  return value.split(',').map(part => {
    const [first, last = first] = part.trim().replace(/^U\+/i, '').split('-');
    return [parseInt(first.replaceAll('?', '0'), 16), parseInt(last.replaceAll('?', 'F'), 16)];
  });
}

/** Fontsource's published, licensed WOFF2 shards ship with npm ci, never from a CDN. */
async function loadCatalog(): Promise<FontCatalog> {
  const fonts = [
    { name: 'noto-sans-sc', family: 'YearbookSans', label: 'Noto Sans SC' },
    { name: 'noto-serif-sc', family: 'YearbookSerif', label: 'Noto Serif SC' },
  ];
  const faces: FontFace[] = [];
  const licenses: string[] = [];
  for (const font of fonts) {
    const cssPath = fileURLToPath(import.meta.resolve(`@fontsource/${font.name}/400.css`));
    const [css, license] = await Promise.all([
      readFile(cssPath, 'utf8'), readFile(join(dirname(cssPath), 'LICENSE'), 'utf8'),
    ]);
    for (const block of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
      const file = /url\(\.\/files\/([a-z0-9-]+\.woff2)\)/i.exec(block[1])?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(block[1])?.[1];
      if (file && range) faces.push({ family: font.family, file: join(dirname(cssPath), 'files', file), range, ranges: ranges(range) });
    }
    licenses.push(`${font.label}\n${license.trim()}`);
  }
  if (!faces.length) throw new Error('empty font catalog');
  return { faces, licenses: licenses.join('\n\n\n') + '\n' };
}

/** Include every shard needed by this document, including uncommon names present in Noto. */
export async function embeddedExportFonts(text: string) {
  try {
    const fonts = await (catalog ??= loadCatalog().catch(error => { catalog = undefined; throw error; }));
    const points = [...new Set([...text].map(character => character.codePointAt(0)!))];
    const selected = fonts.faces.filter(face => points.some(point => face.ranges.some(([first, last]) => point >= first && point <= last)));
    const declarations = await Promise.all(selected.map(async face => {
      let data = fontData.get(face.file);
      if (!data) {
        data = readFile(face.file).then(buffer => {
          if (buffer.subarray(0, 4).toString() !== 'wOF2') throw new Error('invalid font');
          return buffer.toString('base64');
        }).catch(error => { fontData.delete(face.file); throw error; });
        fontData.set(face.file, data);
      }
      return `@font-face{font-family:${face.family};font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${await data}) format('woff2');unicode-range:${face.range}}`;
    }));
    return { css: declarations.join('\n'), licenses: fonts.licenses, faceCount: selected.length };
  } catch {
    throw new AppError(500, 'EXPORT_FONT_MISSING', '导出所需的中文字体无法读取，请在项目目录执行 npm ci 后重试');
  }
}

export async function exportFontLicenses() {
  try { return (await (catalog ??= loadCatalog().catch(error => { catalog = undefined; throw error; }))).licenses; }
  catch { throw new AppError(500, 'EXPORT_FONT_MISSING', '导出字体许可无法读取，请在项目目录执行 npm ci 后重试'); }
}
